package dev.agaminggod.arenaagents.server.runtime.reflex;

import com.google.gson.JsonParser;
import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import dev.agaminggod.arenaagents.protocol.ActionType;
import dev.agaminggod.arenaagents.server.runtime.controller.SafeStep;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The reflex body where the d19 Sol iron games lost it: a held shield stance dropped between its spans, a flee ran
 * behind a raised shield at blocking speed, and an escape knocked into the air on a dug staircase found no heading.
 */
public final class ReflexShieldVerification {
	private static final ReflexScheduler.ActionStatus RUNNING = ReflexScheduler.ActionStatus.RUNNING;
	private static int assertions;

	private ReflexShieldVerification() {
	}

	public static int verify() {
		assertions = 0;
		stanceHeldAcrossSpans();
		fleeTakesTheShield();
		idleShieldYieldsBeforeFiring();
		newCommandWinsOverOldBailout();
		shieldTakesCounter();
		escapeFromTheStaircaseAirborne();
		return assertions;
	}

	/** A stance whose maxS span ends while its condition holds fires again in the same tick: the shield never drops. */
	private static void stanceHeldAcrossSpans() {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(rules("[{\"id\":\"guard\",\"kind\":\"stance\",\"priority\":6,\"when\":{\"type\":\"hostile_near\",\"within\":8},\"do\":{\"type\":\"shield\"},\"maxMs\":1000}]"), 0L);
		Map<String, ReflexScheduler.Sense> near = senses(Map.of("guard", true));
		check("guard".equals(scheduler.step(1L, near, RUNNING, "", true).started()), "the stance fires on a zombie near");
		ReflexScheduler.Decision span = ReflexScheduler.Decision.NONE;
		long tick = 2L;
		for (; tick <= 40L && span.ended() == null; tick++) span = scheduler.step(tick, near, RUNNING, "blocked 2 hit(s)", true);
		check(span.endOutcome() == ReflexScheduler.Outcome.TIMEOUT, "the span ends at maxS and is reported");
		check("guard".equals(span.started()), "the stance is held on in the same tick, so the engine hands the raised shield over");
		// Once the zombie is gone the stance releases and waits its cooldown, as before.
		ReflexScheduler.Decision clear = ReflexScheduler.Decision.NONE;
		for (long t = tick; t <= tick + 30L && clear.ended() == null; t++) clear = scheduler.step(t, senses(Map.of("guard", false)), RUNNING, "", true, false, 0L);
		check(clear.endOutcome() == ReflexScheduler.Outcome.DONE && clear.started() == null, "a cleared condition ends the stance");
	}

	/** A flee command takes the body from a held shield (a player sprints away with it lowered); walking keeps it up. */
	private static void fleeTakesTheShield() {
		check(!CommandFollower.movesUnderHold(ActionType.FLEE_FROM), "flee_from is not a walk behind the shield");
		check(CommandFollower.movesUnderHold(ActionType.NAVIGATE_TO) && CommandFollower.movesUnderHold(ActionType.FIGHT_TARGET),
				"navigating and fighting keep the shield");
		CommandFollower follower = new CommandFollower();
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(rules("[{\"id\":\"guard\",\"kind\":\"stance\",\"when\":{\"type\":\"hostile_near\",\"within\":8},\"do\":{\"type\":\"shield\"}}]"), 0L);
		scheduler.step(1L, senses(Map.of("guard", true)), RUNNING, "", true);
		check(!follower.requestYield(true, 2L), "a held shield waits to see the command");
		CommandFollower.Result result = follower.observe(scheduler, true, "flee-1", ActionType.FLEE_FROM, null, null, 3L);
		check(result.yieldNow(), "the flee starts and the shield yields to it");
	}

	private static void idleShieldYieldsBeforeFiring() {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(rules("[{\"id\":\"guard\",\"kind\":\"stance\",\"when\":{\"type\":\"hostile_near\",\"within\":8},\"do\":{\"type\":\"shield\"}}]"), 0L);
		CommandFollower follower = new CommandFollower();
		check(follower.requestYield(false, 1L), "a command arriving before the first firing yields immediately");
		scheduler.yield(1L);
		check(scheduler.anySuppressed(), "an armed idle shield yields even with no firing to end");
		follower.yielded(1L);
		follower.observe(scheduler, false, "eat-1", ActionType.USE_ITEM, null, null, 2L);
		check(scheduler.step(2L, senses(Map.of("guard", true)), RUNNING, "", true).started() == null,
				"the shield cannot pause the model's eating command");
		scheduler.step(3L, senses(Map.of("guard", false)), RUNNING, "", true);
		follower.observe(scheduler, false, "eat-1", ActionType.USE_ITEM, null, null, 4L);
		check(scheduler.step(4L, senses(Map.of("guard", true)), RUNNING, "", true).started() == null,
				"a new hostile sight during eating still leaves the command in control");
		follower.observe(scheduler, false, null, null, "eat-1", "ACTION_COMPLETED", 5L);
		follower.observe(scheduler, false, null, null, "eat-1", "ACTION_COMPLETED", 15L);
		check("guard".equals(scheduler.step(15L, senses(Map.of("guard", true)), RUNNING, "", true).started()),
				"the idle shield resumes after the command finishes");
		check(CommandFollower.movesUnderHold(ActionType.PICK_UP_ITEM) && CommandFollower.movesUnderHold(ActionType.SELECT_ITEM),
				"walking to a drop and changing the main-hand slot compose with an offhand shield");
	}

	private static void newCommandWinsOverOldBailout() {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(rules("[{\"id\":\"guard\",\"kind\":\"stance\",\"when\":{\"type\":\"hostile_near\",\"within\":8},\"do\":{\"type\":\"shield\"}}]"), 0L);
		CommandFollower follower = new CommandFollower();
		follower.observe(scheduler, false, "fight-1", ActionType.FIGHT_TARGET, null, null, 1L);
		scheduler.yield(2L);
		follower.yielded(2L);
		var result = follower.observe(scheduler, false, "eat-1", ActionType.USE_ITEM, "fight-1", "LOW_HEALTH_BAILOUT", 3L);
		check(!result.handedOff(), "a new model command takes precedence over the previous fight's bailout");
		check(scheduler.step(3L, senses(Map.of("guard", true)), RUNNING, "", true).started() == null,
				"the old bailout cannot rearm a shield over the new eating command");
	}

	/** counter is an option of shield; without it the shield only guards. */
	private static void shieldTakesCounter() {
		List<ReflexSpec.Rule> parsed = rules("[{\"id\":\"guard\",\"kind\":\"stance\",\"when\":{\"type\":\"hostile_near\",\"within\":4},\"do\":{\"type\":\"shield\",\"counter\":true}}]");
		check(parsed.getFirst().action().flag("counter"), "shield accepts counter:true");
		check(!rules("[{\"id\":\"g\",\"when\":{\"type\":\"hostile_near\",\"within\":4},\"do\":{\"type\":\"shield\"}}]").getFirst().action().flag("counter"),
				"counter is off unless asked");
		check(ReflexActions.RECOVERY_TICKS - ReflexActions.COUNTER_WINDOW_TICKS >= 10L,
				"a counter starts only early in a melee mob's 20-tick cooldown");
	}

	/**
	 * A 3-high staircase dug down to the east, the zombie up the stairs to the west, and the body knocked into the air
	 * above a step: from the cell the body will land in the stairs down are the way out; from the cell above its
	 * footing (the old feet cell) every heading met the step's ceiling.
	 */
	private static void escapeFromTheStaircaseAirborne() {
		WalkabilityView stairs = cell -> {
			if (cell.z() != 0 || cell.x() < -4 || cell.x() > 8) return WalkabilityView.Cell.BLOCKED;
			int floor = 70 - cell.x();
			if (cell.y() == floor) return WalkabilityView.Cell.SAFE_SUPPORT;
			return cell.y() > floor && cell.y() <= floor + 3 ? WalkabilityView.Cell.CLEAR : WalkabilityView.Cell.BLOCKED;
		};
		GridPosition aloft = new GridPosition(2, 70, 0);
		GridPosition landing = SafeStep.standing(stairs, aloft, false);
		check(landing.equals(new GridPosition(2, 69, 0)), "an airborne body stands where it will land: " + landing);
		check(SafeStep.standing(stairs, aloft, true).equals(aloft), "on the ground the feet cell is kept");
		check(SafeStep.awayPath(stairs, aloft, -1.5D, 0.5D, ReflexActions.MAX_PATH_STEPS, 1_500, ReflexActions.PATH_MIN_GAIN, cell -> false) == null,
				"from the cell above the footing there is no way down the stairs (the d19-iron-b failure)");
		List<GridPosition> down = SafeStep.awayPath(stairs, landing, -1.5D, 0.5D, ReflexActions.MAX_PATH_STEPS, 1_500, ReflexActions.PATH_MIN_GAIN, cell -> false);
		check(down != null && down.getLast().x() >= 4, "from the landing cell the escape runs down the stairs: " + down);
	}

	private static Map<String, ReflexScheduler.Sense> senses(Map<String, Boolean> truths) {
		Map<String, ReflexScheduler.Sense> senses = new HashMap<>();
		truths.forEach((id, truth) -> senses.put(id, new ReflexScheduler.Sense(truth, false)));
		return senses;
	}

	private static List<ReflexSpec.Rule> rules(String json) {
		return ReflexSpec.parseRules(JsonParser.parseString(json).getAsJsonArray());
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError("ReflexShieldVerification: " + message);
		assertions++;
	}
}
