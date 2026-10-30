package dev.agaminggod.arenaagents.server.runtime.reflex;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.agent.AgentId;
import dev.agaminggod.arenaagents.server.CodexAgentManager;
import dev.agaminggod.arenaagents.server.perception.ObservationVisibility;
import dev.agaminggod.arenaagents.protocol.ActionType;
import dev.agaminggod.arenaagents.server.pov.AgentControlReservations;
import dev.agaminggod.arenaagents.server.runtime.ServerActionRequest;
import dev.agaminggod.arenaagents.server.runtime.ServerActionResult;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputRuntime;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputState;
import dev.agaminggod.arenaagents.server.runtime.input.InputLease;
import dev.agaminggod.arenaagents.server.runtime.input.InputOwner;
import dev.agaminggod.arenaagents.server.runtime.input.LeasedServerInputController;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.WeakHashMap;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Runs each agent's model-authored reflex rules every server tick, before actions tick. A firing takes the body through
 * a REFLEX input lease above every action; the agent's running action is paused (not ticked, its input lease kept
 * alive) and resumes when the firing ends, so the program waiting on it continues. Rules come only from the model via
 * the coordinator; nothing here invents one.
 */
public final class ReflexEngine {
	public static final int INPUT_PRIORITY = 400;
	/** Health a firing may lose before it counts as not making progress. */
	static final float HARM_HEALTH = 2.0F;
	/** Agents whose shield stance is held by their own fight this tick (the fight shields between its swings). */
	private static final Set<UUID> FIGHT_SHIELDS = ConcurrentHashMap.newKeySet();
	private static final Logger LOGGER = LoggerFactory.getLogger(ReflexEngine.class);
	private static final Map<MinecraftServer, ReflexEngine> ENGINES = new WeakHashMap<>();

	private final CodexAgentManager manager;
	private final Map<AgentId, AgentReflexes> agents = new LinkedHashMap<>();
	private final Set<AgentId> changed = new LinkedHashSet<>();
	private java.util.function.Predicate<AgentId> actionProbe = ignored -> false;

	private static final class AgentReflexes {
		final ReflexScheduler scheduler = new ReflexScheduler();
		final ReflexSensors.Memory memory = new ReflexSensors.Memory();
		long revision;
		ReflexActions.Behaviour behaviour;
		String detail = "";
		float startHealth;
		InputLease lease;
		LeasedServerInputController controller;
		Map<String, Entity> focus = Map.of();
		Map<String, Vec3> points = Map.of();
		/** What the running firing started on, kept while its condition no longer names it (a turned-to mob). */
		Entity firingFocus;
		Vec3 firingPoint;
		String error;
		final CommandFollower command = new CommandFollower();
		/** The body was falling at the last tick (read on the bridge thread when a command asks for the body). */
		boolean falling;
	}

	/** The agent's own action, as the executor sees it. */
	public interface Body {
		Body NONE = new Body() {
			@Override public ServerActionRequest active(AgentId agentId) { return null; }
			@Override public ServerActionResult last(AgentId agentId) { return null; }
		};

		ServerActionRequest active(AgentId agentId);

		ServerActionResult last(AgentId agentId);
	}

	/** Whether the agent's shield stance is riding on its running fight this tick (read by the fight controller). */
	public static boolean fightHoldsShield(ServerPlayer player) {
		return player != null && FIGHT_SHIELDS.contains(player.getUUID());
	}

	public ReflexEngine(CodexAgentManager manager) {
		this.manager = Objects.requireNonNull(manager, "manager must not be null");
	}

	/** How the engine learns whether an agent has an action running (the {@code stop} action waits for it to end). */
	public synchronized void actionProbe(java.util.function.Predicate<AgentId> probe) {
		actionProbe = Objects.requireNonNull(probe, "probe must not be null");
	}

	public static synchronized ReflexEngine of(MinecraftServer server, CodexAgentManager manager) {
		return ENGINES.computeIfAbsent(Objects.requireNonNull(server, "server must not be null"), ignored -> new ReflexEngine(manager));
	}

	public static synchronized Optional<ReflexEngine> existing(MinecraftServer server) {
		return server == null ? Optional.empty() : Optional.ofNullable(ENGINES.get(server));
	}

	/**
	 * Installs the agent's complete rule set (validated first, so a bad set never replaces a good one). {@code yield}
	 * ends the current firing because a direct model command takes the body.
	 */
	public synchronized void update(AgentId agentId, long revision, JsonArray rules, boolean yield) {
		Objects.requireNonNull(agentId, "agentId must not be null");
		List<ReflexSpec.Rule> parsed = ReflexSpec.parseRules(rules);
		AgentReflexes agent = agents.computeIfAbsent(agentId, ignored -> new AgentReflexes());
		long now = now();
		agent.revision = revision;
		// A held shield composes with a command that only moves; that is decided once the command has started.
		if (yield && !clutching(agent) && agent.command.requestYield(holdsMoving(agent), now)) yieldNow(agentId, agent, now);
		end(agentId, agent, agent.scheduler.replace(parsed, now));
		changed.add(agentId);
	}

	/** As {@link #update}, but an invalid set is recorded on the agent's status instead of thrown. */
	public synchronized void updateOrReport(AgentId agentId, long revision, JsonArray rules, boolean yield) {
		try {
			update(agentId, revision, rules, yield);
			AgentReflexes agent = agents.get(agentId);
			if (agent != null) agent.error = null;
		} catch (ReflexSpec.InvalidRuleException invalid) {
			AgentReflexes agent = agents.computeIfAbsent(agentId, ignored -> new AgentReflexes());
			agent.error = invalid.getMessage();
			changed.add(agentId);
		}
	}

	/** Coordinator gone: its rules go with it (a reconnecting coordinator re-sends what it still holds). */
	public synchronized void clearAll() {
		for (Map.Entry<AgentId, AgentReflexes> entry : agents.entrySet()) {
			endBehaviour(entry.getKey(), entry.getValue());
			release(entry.getKey(), entry.getValue(), false);
		}
		agents.clear();
	}

	public synchronized void forget(AgentId agentId) {
		AgentReflexes agent = agents.remove(agentId);
		if (agent != null) {
			endBehaviour(agentId, agent);
			release(agentId, agent, false);
		}
	}

	private void endBehaviour(AgentId agentId, AgentReflexes agent) {
		if (agent.behaviour == null) return;
		ServerPlayer player = manager.findAgentPlayer(agentId).orElse(null);
		if (player != null) agent.behaviour.end(player);
	}

	/** Agents whose status changed since the last call (a firing started or ended, rules replaced). */
	public synchronized Set<AgentId> takeChanged() {
		Set<AgentId> result = Set.copyOf(changed);
		changed.clear();
		return result;
	}

	private void yieldNow(AgentId agentId, AgentReflexes agent, long now) {
		ReflexScheduler.Decision decision = agent.scheduler.yield(now);
		if (decision.ended() != null) end(agentId, agent, decision);
		if (agent.scheduler.anySuppressed()) agent.command.yielded(now);
	}

	/**
	 * A fall clutch under way: the firing places a block or water below and the body is still falling. A player's hands
	 * finish the clutch before taking up a new plan; the model's command waits paused, as any action under a firing
	 * does, and starts once the body has landed (2026-10-23 End: three bodies thrown off towers died after a command sent
	 * mid-fall ended the water-bucket firing in the air).
	 */
	private static boolean clutching(AgentReflexes agent) {
		ReflexScheduler.Firing firing = agent.scheduler.current();
		if (firing == null || agent.behaviour == null || !agent.falling) return false;
		ReflexSpec.Rule rule = agent.scheduler.rule(firing.ruleId());
		return rule != null && "place".equals(rule.action().type()) && "below".equals(rule.action().text("where"));
	}

	private static boolean holdsMoving(AgentReflexes agent) {
		return agent.scheduler.current() != null && agent.behaviour != null && agent.behaviour.passesMovement();
	}

	public synchronized Set<AgentId> tick() {
		return tick(Body.NONE);
	}

	/** Advances every agent's rules one tick; returns the agents whose action is paused under a firing this tick. */
	public synchronized Set<AgentId> tick(Body body) {
		FIGHT_SHIELDS.clear();
		if (agents.isEmpty()) return Set.of();
		long now = now();
		Set<AgentId> paused = new LinkedHashSet<>();
		for (Map.Entry<AgentId, AgentReflexes> entry : agents.entrySet()) {
			AgentId agentId = entry.getKey();
			AgentReflexes agent = entry.getValue();
			if (agent.scheduler.isEmpty()) continue;
			try {
				if (tickAgent(agentId, agent, now, body)) paused.add(agentId);
			} catch (RuntimeException failure) {
				LOGGER.error("Reflex tick failed for {}", agentId, failure);
				end(agentId, agent, agent.scheduler.interrupt(now, "reflex error"));
			}
		}
		return paused;
	}

	/** Follows the agent's own command (see {@link CommandFollower}). */
	private void followCommand(AgentId agentId, AgentReflexes agent, ServerActionRequest active, Body body, long now) {
		ServerActionResult last = body.last(agentId);
		CommandFollower.Result result = agent.command.observe(agent.scheduler, holdsMoving(agent), active == null ? null : active.actionId(),
				CommandFollower.movesUnderHold(active) ? active.type() : null, last == null ? null : last.actionId(), last == null ? null : last.reasonCode(), now);
		if (result.handedOff()) changed.add(agentId);
		if (result.yieldNow()) yieldNow(agentId, agent, now);
	}

	/** The agent's paused action is a fight (melee, bow volley or count fight) that handles fire footing itself. */
	static boolean pausedFight(ServerActionRequest active) {
		if (active == null) return false;
		var type = active.type();
		return type == dev.agaminggod.arenaagents.protocol.ActionType.FIGHT_TARGET || type == dev.agaminggod.arenaagents.protocol.ActionType.FIGHT_UNTIL
				|| type == dev.agaminggod.arenaagents.protocol.ActionType.USE_RANGED;
	}

	private static boolean passesThrough(AgentReflexes agent, ServerActionRequest active) {
		return agent.behaviour != null && agent.behaviour.passesMovement() && active != null && CommandFollower.movesUnderHold(active);
	}

	private boolean tickAgent(AgentId agentId, AgentReflexes agent, long now, Body body) {
		ServerPlayer player = manager.findAgentPlayer(agentId).orElse(null);
		if (player == null || !player.isAlive() || player.isSpectator()) {
			end(agentId, agent, agent.scheduler.interrupt(now, "body unavailable"));
			return false;
		}
		if (manager.server() != null && AgentControlReservations.isReserved(manager.server(), agentId)) {
			end(agentId, agent, agent.scheduler.interrupt(now, "operator control"));
			return false;
		}
		agent.memory.observe(player, now);
		agent.falling = !player.onGround() && !player.isInWater() && player.getDeltaMovement().y < -0.1D;
		agent.memory.actionActive(actionProbe.test(agentId));
		ServerActionRequest active = body.active(agentId);
		followCommand(agentId, agent, active, body, now);
		ObservationVisibility.Frame frame = ObservationVisibility.frame(player.level(), player);
		Map<String, ReflexScheduler.Sense> senses = new HashMap<>();
		Map<String, Entity> focus = new HashMap<>();
		Map<String, Vec3> points = new HashMap<>();
		for (ReflexSpec.Rule rule : agent.scheduler.activeRules()) {
			boolean truth = true;
			Entity found = null;
			Vec3 point = null;
			for (ReflexSpec.Condition condition : rule.when()) {
				ReflexSensors.Reading reading = ReflexSensors.sense(player, condition, frame, agent.memory, now);
				if (!reading.truth()) {
					truth = false;
					break;
				}
				if (found == null && reading.focus() != null) found = reading.focus();
				if (point == null && reading.point() != null) point = reading.point();
			}
			boolean until = !rule.until().isEmpty();
			for (ReflexSpec.Condition condition : rule.until()) {
				if (!until) break;
				until = ReflexSensors.sense(player, condition, frame, agent.memory, now).truth();
			}
			if ("brace".equals(rule.action().type())) {
				// A brace rule never fires: while its condition holds, the brink guard walks a shove back in any stance
				// (not only a commanded one), so a hit near an edge during control keys, a program or a firing is undone too.
				if (truth) dev.agaminggod.arenaagents.server.runtime.controller.BrinkGuard.braceArmed(player);
				senses.put(rule.id(), new ReflexScheduler.Sense(false, until));
				continue;
			}
			senses.put(rule.id(), new ReflexScheduler.Sense(truth, until));
			if (truth && found != null) focus.put(rule.id(), found);
			if (truth && point != null) points.put(rule.id(), point);
		}
		agent.focus = focus;
		agent.points = points;
		ReflexScheduler.ActionStatus status = ReflexScheduler.ActionStatus.RUNNING;
		ReflexScheduler.Firing firing = agent.scheduler.current();
		if (firing != null && agent.behaviour != null) {
			ReflexSpec.Rule rule = agent.scheduler.rule(firing.ruleId());
			ReflexActions.Step step = agent.behaviour.tick(context(agentId, player, agent, firing.ruleId(), rule, active), state -> apply(agentId, agent, player, state));
			status = step.status();
			// A firing that only holds on after reaching its goal (out of lava, burn running out) ends done at its maxS.
			status = ReflexScheduler.settledStatus(status, agent.behaviour.settled(), now - firing.startTick(), firing.maxTicks());
			if (status == ReflexScheduler.ActionStatus.RUNNING && agent.behaviour.yieldsToFight() && pausedFight(active)) status = ReflexScheduler.ActionStatus.DONE;
			agent.detail = withHealth(step.detail(), agent.startHealth - player.getHealth());
		}
		// A firing that has cost 2+ health is not making progress, whatever its action reports.
		boolean harmed = firing != null && agent.startHealth - player.getHealth() >= HARM_HEALTH;
		agent.scheduler.settled(firing != null && agent.behaviour != null && agent.behaviour.settled());
		ReflexScheduler.Decision decision = agent.scheduler.step(now, senses, status, agent.detail,
				agent.behaviour != null && agent.behaviour.holdsWhileTrue(), harmed,
				agent.behaviour == null ? 0L : agent.behaviour.releaseGraceTicks(), heldBack(player, agent));
		// Handing the body straight to the next firing keeps the lease: releasing it would drop a raised shield for a
		// tick and restart its 5-tick raise, the window a trigger exists to cover.
		end(agentId, agent, decision, decision.started() != null);
		if (decision.started() != null) {
			ReflexSpec.Rule rule = agent.scheduler.rule(decision.started());
			agent.behaviour = ReflexActions.create(rule.action());
			agent.startHealth = player.getHealth();
			agent.firingFocus = agent.focus.get(rule.id());
			agent.firingPoint = agent.points.get(rule.id());
			ReflexActions.Step step = agent.behaviour.tick(context(agentId, player, agent, rule.id(), rule, active), state -> apply(agentId, agent, player, state));
			agent.detail = step.detail();
			changed.add(agentId);
		}
		if (agent.scheduler.current() == null) return false;
		boolean passes = passesThrough(agent, active);
		if (passes && fightShield(player, active) && agent.behaviour.defersToFight()) {
			// The fight raises the shield itself between swings; a reflex lease over it would block every swing.
			FIGHT_SHIELDS.add(player.getUUID());
			release(agentId, agent, false);
		}
		if (agent.controller != null) agent.controller.renew(agentId);
		else AgentInputRuntime.controller(player).renew(agentId);
		return !passes;
	}

	/**
	 * Rules that must not hold the body now, with why: a melee rule while the eyes are under water and the air left is
	 * short of the swim to air plus a margin. A player stops fighting to breathe (live run d18-iron-a: an attack rule held
	 * the body still at the bottom for 3 s with no hit in reach while the air went from 7 to 4 bubbles).
	 */
	private static Map<String, String> heldBack(ServerPlayer player, AgentReflexes agent) {
		Map<String, String> held = null;
		String breath = null;
		for (ReflexSpec.Rule rule : agent.scheduler.activeRules()) {
			if (!ReflexActions.yieldsToBreath(rule.action())) continue;
			if (breath == null) {
				breath = ReflexSensors.breathShort(player);
				if (breath == null) return Map.of();
			}
			if (held == null) held = new HashMap<>();
			held.put(rule.id(), breath);
		}
		return held == null ? Map.of() : held;
	}

	private static boolean fightShield(ServerPlayer player, ServerActionRequest active) {
		return active != null && (active.type() == ActionType.FIGHT_TARGET || active.type() == ActionType.FIGHT_UNTIL)
				&& player.getOffhandItem().getItem() instanceof net.minecraft.world.item.ShieldItem;
	}

	private ReflexActions.Context context(AgentId agentId, ServerPlayer player, AgentReflexes agent, String ruleId, ReflexSpec.Rule rule, ServerActionRequest active) {
		Entity focus = agent.focus.get(ruleId);
		Vec3 point = agent.points.get(ruleId);
		if (focus != null) agent.firingFocus = focus;
		if (point != null) agent.firingPoint = point;
		// While the condition no longer names it (the body turned to face the mob), the firing keeps what it started on.
		if (focus == null && agent.firingFocus != null && agent.firingFocus.isAlive()) focus = agent.firingFocus;
		if (point == null) point = agent.firingPoint;
		boolean passes = passesThrough(agent, active);
		AgentInputState below = null;
		if (passes) {
			LeasedServerInputController controller = agent.controller != null ? agent.controller : AgentInputRuntime.controller(player);
			below = controller.stateBelow(agentId, INPUT_PRIORITY).orElse(null);
		}
		return new ReflexActions.Context(player, focus, rule != null && rule.kind() == ReflexSpec.Kind.STANCE, agent.memory, point,
				below, passes && fightShield(player, active));
	}

	private static String withHealth(String detail, float lost) {
		String base = detail == null ? "" : detail;
		return lost >= 0.5F ? base + (base.isEmpty() ? "" : "; ") + String.format(Locale.ROOT, "lost %.1f health", lost) : base;
	}

	private void apply(AgentId agentId, AgentReflexes agent, ServerPlayer player, AgentInputState state) {
		if (agent.controller == null) agent.controller = AgentInputRuntime.controller(player);
		if (agent.lease == null) agent.lease = agent.controller.acquire(agentId, InputOwner.REFLEX, INPUT_PRIORITY);
		try {
			agent.controller.apply(agent.lease, state);
		} catch (LeasedServerInputController.StaleInputLeaseException cleared) {
			// A lifecycle clear revoked every lease; take a fresh one for the rest of this firing.
			agent.lease = agent.controller.acquire(agentId, InputOwner.REFLEX, INPUT_PRIORITY);
			agent.controller.apply(agent.lease, state);
		}
	}

	private void end(AgentId agentId, AgentReflexes agent, ReflexScheduler.Decision decision) {
		end(agentId, agent, decision, false);
	}

	private void end(AgentId agentId, AgentReflexes agent, ReflexScheduler.Decision decision, boolean handOver) {
		if (decision.ended() == null) return;
		changed.add(agentId);
		endBehaviour(agentId, agent);
		boolean keep = agent.behaviour != null && agent.behaviour.keepsSelection();
		if (!handOver) release(agentId, agent, keep);
		else if (keep) rebase(agentId, agent);
		agent.behaviour = null;
		agent.firingFocus = null;
		agent.firingPoint = null;
		agent.detail = "";
	}

	/** Carries a kept hotbar choice into the paused leases while the reflex lease passes to the next firing. */
	private void rebase(AgentId agentId, AgentReflexes agent) {
		if (agent.lease == null || agent.controller == null) return;
		ServerPlayer player = manager.findAgentPlayer(agentId).orElse(null);
		if (player == null) return;
		try {
			agent.controller.rebase(agent.lease, player.getYRot(), player.getXRot(), player.getInventory().getSelectedSlot());
		} catch (LeasedServerInputController.StaleInputLeaseException ignored) {
			// Already revoked by a lifecycle clear.
		}
	}

	private void release(AgentId agentId, AgentReflexes agent, boolean keepSelection) {
		if (agent.lease == null || agent.controller == null) return;
		try {
			ServerPlayer player = manager.findAgentPlayer(agentId).orElse(null);
			if (player != null) {
				agent.controller.rebase(agent.lease, player.getYRot(), player.getXRot(),
						keepSelection ? player.getInventory().getSelectedSlot() : -1);
			}
			agent.controller.release(agent.lease);
		} catch (LeasedServerInputController.StaleInputLeaseException ignored) {
			// Already revoked by a lifecycle clear.
		}
		agent.lease = null;
	}

	/** One rule as an audit sees it: its state label and the condition types of its {@code when}. */
	public record RuleView(String id, String state, Set<String> when) {
	}

	/** The id of the rule whose firing holds the agent's body now, or null. */
	public synchronized String firingRule(AgentId agentId) {
		AgentReflexes agent = agents.get(agentId);
		ReflexScheduler.Firing firing = agent == null ? null : agent.scheduler.current();
		return firing == null ? null : firing.ruleId();
	}

	/** A read-only copy of an agent's rules, current firing and recent events, for server-side audits. */
	public record View(List<RuleView> rules, ReflexScheduler.Firing current, List<ReflexScheduler.Event> events, long nowTick) {
	}

	public synchronized View view(AgentId agentId) {
		AgentReflexes agent = agents.get(agentId);
		long now = now();
		if (agent == null) return new View(List.of(), null, List.of(), now);
		java.util.ArrayList<RuleView> rows = new java.util.ArrayList<>();
		for (ReflexScheduler.RuleStatus row : agent.scheduler.statuses(now)) {
			ReflexSpec.Rule rule = agent.scheduler.rule(row.id());
			Set<String> when = new LinkedHashSet<>();
			if (rule != null) for (ReflexSpec.Condition condition : rule.when()) if (!condition.negated()) when.add(condition.type());
			rows.add(new RuleView(row.id(), row.state(), Set.copyOf(when)));
		}
		return new View(List.copyOf(rows), agent.scheduler.current(), agent.scheduler.events(), now);
	}

	/** The agent's reflex status for its observation, or null when it has no rules and nothing to report. */
	public synchronized JsonObject status(AgentId agentId) {
		AgentReflexes agent = agents.get(agentId);
		if (agent == null) return null;
		long now = now();
		JsonObject status = new JsonObject();
		status.addProperty("revision", agent.revision);
		ReflexScheduler.Firing firing = agent.scheduler.current();
		if (firing != null) {
			JsonObject current = new JsonObject();
			current.addProperty("id", firing.ruleId());
			current.addProperty("ms", Math.max(0L, now - firing.startTick()) * 50L);
			if (!agent.detail.isEmpty()) current.addProperty("detail", agent.detail);
			status.add("firing", current);
		}
		JsonArray rules = new JsonArray();
		ServerPlayer player = manager.findAgentPlayer(agentId).orElse(null);
		for (ReflexScheduler.RuleStatus row : agent.scheduler.statuses(now)) {
			JsonObject rule = new JsonObject();
			rule.addProperty("id", row.id());
			rule.addProperty("kind", row.kind() == ReflexSpec.Kind.STANCE ? "stance" : "trigger");
			rule.addProperty("state", row.state());
			rule.addProperty("fired", row.fired());
			rule.addProperty("expiresInS", (row.expiresInTicks() + 19L) / 20L);
			if (row.disabledReason() != null) rule.addProperty("disabled", row.disabledReason());
			ReflexSpec.Rule spec = agent.scheduler.rule(row.id());
			String lacks = player == null || spec == null ? null : ReflexActions.lacks(player, spec.action());
			if (lacks != null) rule.addProperty("lacks", lacks);
			rules.add(rule);
		}
		status.add("rules", rules);
		JsonArray events = new JsonArray();
		for (ReflexScheduler.Event event : agent.scheduler.events()) {
			JsonObject row = new JsonObject();
			row.addProperty("seq", event.sequence());
			row.addProperty("id", event.ruleId());
			row.addProperty("outcome", event.outcome().wire());
			row.addProperty("ms", event.durationTicks() * 50L);
			if (!event.detail().isEmpty()) row.addProperty("detail", event.detail());
			if (event.wake()) row.addProperty("wake", true);
			events.add(row);
		}
		status.add("events", events);
		if (agent.error != null) status.addProperty("error", agent.error.length() > 240 ? agent.error.substring(0, 240) : agent.error);
		return status;
	}

	private long now() {
		MinecraftServer server = manager.server();
		return server == null ? 0L : server.getTickCount();
	}
}
