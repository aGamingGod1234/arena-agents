package dev.agaminggod.arenaagents.server.runtime.reflex;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * One agent's reflex rules and their firing state, advanced once per server tick. Pure: the engine supplies each rule's
 * condition truth and the running action's status, and applies the returned decision to the body.
 * <ul>
 * <li>A trigger fires once on a rising edge of its condition (latched briefly while a higher rule holds the body).</li>
 * <li>A stance fires while its condition holds and releases when it stops holding.</li>
 * <li>Only one rule fires at a time; a higher priority rule that becomes ready preempts a lower one.</li>
 * <li>Every firing is bounded by the rule's maxMs, followed by its cooldown (debounce).</li>
 * <li>Loop protection: four firings in a row without progress, or more than forty in a minute, disable the rule.
 * A stance that hits maxS while the body loses health is not making progress either, and wakes the model at once; a
 * stance held for three maxS spans in a row without its condition clearing wakes the model once (it may need to flee
 * instead of holding).</li>
 * <li>Rules expire after ttlMs, when an until condition holds, or after maxFirings.</li>
 * </ul>
 */
public final class ReflexScheduler {
	public static final long TICKS_PER_SECOND = 20L;
	/** A trigger edge that cannot fire at once (cooldown, a higher rule firing) stays pending this long. */
	public static final long PENDING_TICKS = 20L;
	public static final int MAX_FAILURES_IN_A_ROW = 4;
	public static final int MAX_FIRINGS_PER_MINUTE = 40;
	public static final int MAX_EVENTS = 16;
	/** Consecutive maxS spans a stance may hold, its condition never clearing, before the model is told. */
	public static final int HELD_SPANS_BEFORE_WAKE = 3;

	public enum ActionStatus { RUNNING, DONE, FAILED }

	public enum Outcome {
		DONE, TIMEOUT, FAILED, PREEMPTED, YIELDED, DISABLED, EXPIRED, REMOVED;

		public String wire() {
			return name().toLowerCase(java.util.Locale.ROOT);
		}
	}

	public record Event(long sequence, String ruleId, Outcome outcome, long durationTicks, String detail, boolean wake) {
	}

	public record Firing(String ruleId, long startTick, long maxTicks) {
	}

	/** What changed this tick: a firing that ended (with its outcome) and/or a rule that starts firing now. */
	public record Decision(Firing ended, Outcome endOutcome, String started) {
		static final Decision NONE = new Decision(null, null, null);

		public boolean changed() {
			return ended != null || started != null;
		}
	}

	/** One rule's sensed state for this tick. */
	public record Sense(boolean truth, boolean until) {
		public static final Sense FALSE = new Sense(false, false);
	}

	public record RuleStatus(String id, ReflexSpec.Kind kind, String state, int fired, long expiresInTicks, String disabledReason) {
	}

	private static final class State {
		final ReflexSpec.Rule rule;
		final long installedTick;
		boolean lastTruth;
		long pendingUntil = -1L;
		long cooldownUntil;
		boolean suppressed;
		/** A trigger whose firing a model command took over; it may fire again once that command is over. */
		boolean yieldedTrigger;
		int fired;
		int failuresInARow;
		String lastFailure;
		String disabledReason;
		int heldSpans;
		/** First tick of the current false run of the condition (for a held action's release grace). */
		long falseSince = Long.MIN_VALUE;
		/** The rule could not fire while the body had to do something first (breathe): fire once that is over. */
		boolean heldBack;
		/** Tick of the condition's latest rising edge (triggers). */
		long edgeTick = Long.MIN_VALUE;
		final Deque<Long> recentFirings = new ArrayDeque<>();

		State(ReflexSpec.Rule rule, long installedTick) {
			this.rule = rule;
			this.installedTick = installedTick;
		}

		long expiresAt() {
			return installedTick + Math.max(1L, rule.ttlMs() / 50L);
		}
	}

	private final Map<String, State> states = new LinkedHashMap<>();
	private final Deque<Event> events = new ArrayDeque<>();
	private Firing current;
	private long nextSequence = 1L;
	private long lastTick;
	/** Rules that must not hold the body this step, with why (see {@link #step}). */
	private Map<String, String> heldNow = Map.of();
	/** Whether the running firing has cost health (set each step by the engine). */
	private boolean harmed;
	/** Whether the running firing has met its goal and only holds on (set each step by the engine; see {@link #settled}). */
	private boolean settledHold;

	/**
	 * Installs a complete rule set. A rule whose definition is unchanged keeps its state (cooldown, counters, edges);
	 * a changed or new rule starts fresh, and a firing whose rule changed or disappeared ends as REMOVED.
	 */
	public Decision replace(List<ReflexSpec.Rule> rules, long now) {
		Objects.requireNonNull(rules, "rules must not be null");
		if (rules.size() > ReflexSpec.MAX_RULES) throw new IllegalArgumentException("too many reflex rules");
		lastTick = Math.max(lastTick, now);
		Map<String, State> next = new LinkedHashMap<>();
		for (ReflexSpec.Rule rule : rules) {
			State previous = states.get(rule.id());
			next.put(rule.id(), previous != null && previous.rule.equals(rule) ? previous : new State(rule, now));
		}
		Decision decision = Decision.NONE;
		if (current != null) {
			State kept = next.get(current.ruleId());
			if (kept == null || kept != states.get(current.ruleId())) {
				decision = new Decision(current, Outcome.REMOVED, null);
				recordEnd(states.get(current.ruleId()), Outcome.REMOVED, now, "");
				current = null;
			}
		}
		states.clear();
		states.putAll(next);
		return decision;
	}

	public boolean isEmpty() {
		return states.isEmpty();
	}

	public List<ReflexSpec.Rule> rules() {
		return states.values().stream().map(state -> state.rule).toList();
	}

	public ReflexSpec.Rule rule(String id) {
		State state = states.get(id);
		return state == null ? null : state.rule;
	}

	public Firing current() {
		return current;
	}

	/** Rules whose conditions are worth sensing this tick (disabled rules are not). */
	public List<ReflexSpec.Rule> activeRules() {
		return states.values().stream().filter(state -> state.disabledReason == null).map(state -> state.rule).toList();
	}

	/**
	 * Advances one tick. {@code status} and {@code detail} describe the running firing's action (ignored when nothing
	 * fires); {@code holdsWhileTrue} marks actions such as a raised shield that end when their condition clears even
	 * for a trigger.
	 */
	public Decision step(long now, Map<String, Sense> senses, ActionStatus status, String detail, boolean holdsWhileTrue) {
		return step(now, senses, status, detail, holdsWhileTrue, false);
	}

	/** As above; {@code harmed} says the running firing has cost the body health. */
	public Decision step(long now, Map<String, Sense> senses, ActionStatus status, String detail, boolean holdsWhileTrue, boolean harmed) {
		return step(now, senses, status, detail, holdsWhileTrue, harmed, 0L);
	}

	/**
	 * As above; a held action ends only after its condition has been false for {@code releaseGraceTicks} (a shield stays
	 * up through the rest of a volley instead of dropping between shots).
	 */
	public Decision step(long now, Map<String, Sense> senses, ActionStatus status, String detail, boolean holdsWhileTrue, boolean harmed,
			long releaseGraceTicks) {
		return step(now, senses, status, detail, holdsWhileTrue, harmed, releaseGraceTicks, Map.of());
	}

	/**
	 * As above; {@code heldBack} names rules that must not hold the body this tick, with why (a melee rule while the body
	 * is short of air: a player stops fighting to breathe). A held-back firing ends as YIELDED with that reason, neither
	 * progress nor failure; a held-back rule does not start, and a trigger whose condition still holds fires once it is
	 * released. A rule held back before it fired is reported once per hold.
	 */
	public Decision step(long now, Map<String, Sense> senses, ActionStatus status, String detail, boolean holdsWhileTrue, boolean harmed,
			long releaseGraceTicks, Map<String, String> heldBack) {
		Objects.requireNonNull(senses, "senses must not be null");
		heldNow = Objects.requireNonNull(heldBack, "heldBack must not be null");
		this.harmed = current != null && harmed;
		lastTick = Math.max(lastTick, now);
		Firing ended = null;
		Outcome endOutcome = null;
		// Expiry first: a rule past its time or situation is gone even mid-firing.
		for (State state : List.copyOf(states.values())) {
			Sense sense = senses.getOrDefault(state.rule.id(), Sense.FALSE);
			boolean exhausted = state.rule.maxFirings() > 0 && state.fired >= state.rule.maxFirings()
					&& (current == null || !current.ruleId().equals(state.rule.id()));
			String why = now >= state.expiresAt() ? "ttl reached" : sense.until() ? "until condition holds" : exhausted ? "maxFirings reached" : null;
			if (why == null) continue;
			if (current != null && current.ruleId().equals(state.rule.id())) {
				ended = current;
				endOutcome = Outcome.EXPIRED;
				current = null;
			}
			states.remove(state.rule.id());
			addEvent(state.rule.id(), Outcome.EXPIRED, ended != null && ended.ruleId().equals(state.rule.id()) ? now - ended.startTick() : 0L, why, false);
		}
		for (State state : states.values()) {
			if (state.disabledReason != null) continue;
			boolean truth = senses.getOrDefault(state.rule.id(), Sense.FALSE).truth();
			if (state.rule.kind() == ReflexSpec.Kind.TRIGGER && truth && !state.lastTruth) {
				state.pendingUntil = now + PENDING_TICKS;
				state.edgeTick = now;
			}
			if (!truth) {
				state.suppressed = false;
				state.yieldedTrigger = false;
				state.heldSpans = 0;
				if (state.lastTruth || state.falseSince == Long.MIN_VALUE) state.falseSince = now;
			} else {
				state.falseSince = Long.MIN_VALUE;
			}
			state.lastTruth = truth;
			String held = heldBack.get(state.rule.id());
			boolean firing = current != null && current.ruleId().equals(state.rule.id());
			boolean waiting = state.rule.kind() == ReflexSpec.Kind.TRIGGER ? state.pendingUntil >= now : truth && !state.suppressed;
			if (held != null && truth && !state.heldBack && waiting && !firing && now >= state.cooldownUntil) {
				state.heldBack = true;
				addEvent(state.rule.id(), Outcome.YIELDED, 0L, "held back: " + held, false);
			} else if (held == null && state.heldBack) {
				state.heldBack = false;
				if (truth && state.rule.kind() == ReflexSpec.Kind.TRIGGER) state.pendingUntil = Math.max(now, state.cooldownUntil) + PENDING_TICKS;
			}
			if (!truth) state.heldBack = false;
		}
		if (current != null) {
			State state = states.get(current.ruleId());
			Outcome outcome = null;
			String reason = detail == null ? "" : detail;
			String held = heldBack.get(current.ruleId());
			if (held != null && status == ActionStatus.RUNNING) {
				outcome = Outcome.YIELDED;
				reason = (reason.isEmpty() ? "" : reason + "; ") + held;
				state.heldBack = state.lastTruth;
			} else if (status == ActionStatus.FAILED) outcome = Outcome.FAILED;
			else if (status == ActionStatus.DONE) outcome = Outcome.DONE;
			else if ((state.rule.kind() == ReflexSpec.Kind.STANCE || holdsWhileTrue) && !state.lastTruth
					&& (!holdsWhileTrue || now - state.falseSince >= releaseGraceTicks)) outcome = Outcome.DONE;
			else if (now - current.startTick() >= current.maxTicks()) outcome = Outcome.TIMEOUT;
			else {
				// A firing that only holds on after its goal (decision 13: a burn running out) yields to any ready rule.
				State challenger = best(now, settledHold ? Integer.MIN_VALUE : state.rule.priority());
				if (challenger != null) {
					outcome = Outcome.PREEMPTED;
					reason = "by " + challenger.rule.id();
				}
			}
			if (outcome != null) {
				ended = current;
				endOutcome = outcome;
				current = null;
				recordEnd(state, outcome, now, reason);
				rearmSwallowedEdges(ended, now);
			}
		}
		String started = null;
		if (current == null) {
			State next = best(now, Integer.MIN_VALUE);
			if (next != null) {
				current = new Firing(next.rule.id(), now, Math.max(1L, next.rule.maxMs() / 50L));
				next.fired++;
				next.pendingUntil = -1L;
				next.recentFirings.addLast(now);
				while (!next.recentFirings.isEmpty() && next.recentFirings.peekFirst() <= now - 60L * TICKS_PER_SECOND) next.recentFirings.removeFirst();
				started = next.rule.id();
			}
		}
		return ended == null && started == null ? Decision.NONE : new Decision(ended, endOutcome, started);
	}

	/**
	 * A trigger whose condition rose while another firing held the body, and still holds when that firing ends, fires
	 * now: its edge is not lost to the pending window (live End death 2026-10-20: a fireball dodge held the body for
	 * 2.5 s while the breath-cloud trigger rose, and the cloud rule never fired while the body stood in the cloud's path).
	 */
	private void rearmSwallowedEdges(Firing ended, long now) {
		for (State other : states.values()) {
			if (other.rule.kind() != ReflexSpec.Kind.TRIGGER || other.disabledReason != null || !other.lastTruth) continue;
			if (other.rule.id().equals(ended.ruleId()) || other.edgeTick < ended.startTick() || other.pendingUntil >= now) continue;
			other.pendingUntil = now + PENDING_TICKS;
		}
	}

	/**
	 * Marks the running firing as settled for the next {@link #step}: its goal is met and it only holds on (out of lava,
	 * the burn running out), so any ready rule the model armed may take the body, whatever its priority.
	 */
	public void settled(boolean settled) {
		settledHold = settled;
	}

	/** A firing that only holds on after its goal ends done at its maxS: no timeout strike, no timeout wake. */
	public static ActionStatus settledStatus(ActionStatus status, boolean settled, long elapsedTicks, long maxTicks) {
		return status == ActionStatus.RUNNING && settled && elapsedTicks >= maxTicks ? ActionStatus.DONE : status;
	}

	/** A direct model command took the body: end the firing; a stance waits until its condition clears once or {@link #resume}. */
	public Decision yield(long now) {
		suppressIdleShields();
		if (current == null) return Decision.NONE;
		Firing ended = current;
		State state = states.get(ended.ruleId());
		current = null;
		recordEnd(state, Outcome.YIELDED, now, "model command");
		if (state.rule.kind() == ReflexSpec.Kind.STANCE) state.suppressed = true;
		else state.yieldedTrigger = true;
		return new Decision(ended, Outcome.YIELDED, null);
	}

	/** A shield stance guards idle time; it cannot seize a model command in the gap before its first firing. */
	void suppressIdleShields() {
		for (State state : states.values()) {
			if (state.rule.kind() == ReflexSpec.Kind.STANCE && "shield".equals(state.rule.action().type())) state.suppressed = true;
		}
	}

	/**
	 * The model's command that took the body is over: yielded stances may fire again while their condition holds, and so
	 * may a trigger whose own firing that command took over (its condition never cleared, so no new edge would come: live
	 * drownings 2026-10-20, where short jump commands yielded the air rule and the body sank between turns). With
	 * {@code rearmTriggers} (the command bailed out: low health, fire, lava) any trigger whose condition holds now fires as
	 * if it had just become true, so the model's own rule takes the body instead of it standing still until the next turn.
	 */
	public void resume(long now, boolean rearmTriggers) {
		lastTick = Math.max(lastTick, now);
		for (State state : states.values()) {
			boolean rearm = (rearmTriggers || state.yieldedTrigger) && state.rule.kind() == ReflexSpec.Kind.TRIGGER && state.lastTruth
					&& state.disabledReason == null && (current == null || !current.ruleId().equals(state.rule.id()));
			state.suppressed = false;
			state.yieldedTrigger = false;
			if (rearm) state.pendingUntil = Math.max(now, state.cooldownUntil) + PENDING_TICKS;
		}
	}

	/** Whether a yielded rule is waiting for its condition to clear or the model's command to end. */
	public boolean anySuppressed() {
		for (State state : states.values()) if (state.suppressed || state.yieldedTrigger) return true;
		return false;
	}

	/** The body is gone (death, removal): end any firing without counting it against the rule. */
	public Decision interrupt(long now, String why) {
		if (current == null) return Decision.NONE;
		Firing ended = current;
		current = null;
		addEvent(ended.ruleId(), Outcome.YIELDED, now - ended.startTick(), why, false);
		State state = states.get(ended.ruleId());
		if (state != null) state.cooldownUntil = now + Math.max(1L, state.rule.cooldownMs() / 50L);
		return new Decision(ended, Outcome.YIELDED, null);
	}

	private State best(long now, int abovePriority) {
		State best = null;
		for (State state : states.values()) {
			if (state.rule.priority() <= abovePriority || !ready(state, now)) continue;
			if (best == null || state.rule.priority() > best.rule.priority()) best = state;
		}
		return best;
	}

	private boolean ready(State state, long now) {
		if (state.disabledReason != null || now < state.cooldownUntil || state.heldBack || heldNow.containsKey(state.rule.id())) return false;
		if (current != null && current.ruleId().equals(state.rule.id())) return false;
		if (state.rule.maxFirings() > 0 && state.fired >= state.rule.maxFirings()) return false;
		return state.rule.kind() == ReflexSpec.Kind.TRIGGER ? state.pendingUntil >= now : state.lastTruth && !state.suppressed;
	}

	private void recordEnd(State state, Outcome outcome, long now, String detail) {
		if (state == null) return;
		Firing firing = current != null && current.ruleId().equals(state.rule.id()) ? current : null;
		long started = firing != null ? firing.startTick() : state.recentFirings.isEmpty() ? now : state.recentFirings.peekLast();
		long duration = Math.max(0L, now - started);
		boolean stance = state.rule.kind() == ReflexSpec.Kind.STANCE;
		// A stance whose span ends while its condition holds is held on in the same tick: the firing is reported and
		// counted, but the body keeps the stance (live run d19-iron-a: every 10 s span dropped a raised shield for the
		// cooldown plus its 5-tick raise, and a zombie in reach hit for 3 each time).
		state.cooldownUntil = stance && outcome == Outcome.TIMEOUT && state.lastTruth ? now : now + Math.max(1L, state.rule.cooldownMs() / 50L);
		boolean harmedHold = stance && outcome == Outcome.TIMEOUT && harmed;
		boolean failure = outcome == Outcome.FAILED || outcome == Outcome.TIMEOUT && !stance || harmedHold;
		boolean progress = !failure && (outcome == Outcome.DONE || outcome == Outcome.TIMEOUT && stance);
		boolean wake = state.rule.wake() && outcome != Outcome.PREEMPTED || harmedHold;
		if (stance && outcome == Outcome.TIMEOUT && ++state.heldSpans == HELD_SPANS_BEFORE_WAKE) {
			wake = true;
			detail = (detail == null || detail.isEmpty() ? "" : detail + "; ") + "held " + (duration * HELD_SPANS_BEFORE_WAKE / TICKS_PER_SECOND)
					+ " s and the condition has not cleared";
		}
		if (failure) {
			state.failuresInARow++;
			state.lastFailure = detail;
		} else if (progress) {
			state.failuresInARow = 0;
		}
		addEvent(state.rule.id(), outcome, duration, detail, wake);
		String disabled = null;
		if (state.failuresInARow >= MAX_FAILURES_IN_A_ROW) {
			disabled = "fired " + state.failuresInARow + "x in a row without progress"
					+ (state.lastFailure == null || state.lastFailure.isEmpty() ? "" : "; last: " + state.lastFailure);
		} else if (state.recentFirings.size() > MAX_FIRINGS_PER_MINUTE) {
			disabled = "fired " + state.recentFirings.size() + "x within 60 s";
		}
		if (disabled != null) {
			state.disabledReason = disabled;
			addEvent(state.rule.id(), Outcome.DISABLED, 0L, disabled, true);
		}
	}

	private void addEvent(String ruleId, Outcome outcome, long durationTicks, String detail, boolean wake) {
		String bounded = detail == null ? "" : detail.length() > 160 ? detail.substring(0, 160) : detail;
		events.addLast(new Event(nextSequence++, ruleId, outcome, durationTicks, bounded, wake));
		while (events.size() > MAX_EVENTS) events.removeFirst();
	}

	public List<Event> events() {
		return List.copyOf(events);
	}

	public long lastSequence() {
		return nextSequence - 1L;
	}

	public List<RuleStatus> statuses(long now) {
		List<RuleStatus> rows = new ArrayList<>(states.size());
		for (State state : states.values()) {
			String label = state.disabledReason != null ? "disabled"
					: current != null && current.ruleId().equals(state.rule.id()) ? "firing"
					: now < state.cooldownUntil ? "cooldown"
					: state.suppressed || state.yieldedTrigger ? "yielded" : "armed";
			rows.add(new RuleStatus(state.rule.id(), state.rule.kind(), label, state.fired, Math.max(0L, state.expiresAt() - now), state.disabledReason));
		}
		return List.copyOf(rows);
	}

	/** Ids whose condition must still be sensed (all non-disabled rules), for engines that cache per-type sampling. */
	public Set<String> ids() {
		return Set.copyOf(states.keySet());
	}
}
