package dev.agaminggod.arenaagents.server.runtime.reflex;

import com.google.gson.JsonParser;
import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import dev.agaminggod.arenaagents.server.runtime.controller.SafeStep;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The reflex body where live runs lost it (d18 DeepSeek games): an escape with no straight heading backs along known
 * ground, a melee rule stops to breathe and says so, and a rule armed without its item is told at once.
 */
public final class ReflexBodyVerification {
	private static final ReflexScheduler.ActionStatus RUNNING = ReflexScheduler.ActionStatus.RUNNING;
	private static int assertions;

	private ReflexBodyVerification() {
	}

	public static int verify() {
		assertions = 0;
		escapeBacksAlongTheTunnel();
		escapeNeverBacksPastTheThreat();
		meleeYieldsToBreath();
		heldTriggerFiresOnceReleased();
		breathThreshold();
		armedWithoutItem();
		return assertions;
	}

	/**
	 * A tunnel that bends: the body faces the threat down the east leg, every straight heading away is a wall, and the
	 * way it came (north, then west) is the escape.
	 */
	private static void escapeBacksAlongTheTunnel() {
		Set<GridPosition> tunnel = new java.util.HashSet<>();
		for (int x = 0; x <= 6; x++) tunnel.add(new GridPosition(x, 64, 0));
		for (int z = -6; z <= 0; z++) tunnel.add(new GridPosition(0, 64, z));
		for (int x = -6; x <= 0; x++) tunnel.add(new GridPosition(x, 64, -6));
		WalkabilityView world = cell -> {
			if (cell.y() == 63) return WalkabilityView.Cell.SAFE_SUPPORT;
			if (cell.y() == 64 || cell.y() == 65) return tunnel.contains(new GridPosition(cell.x(), 64, cell.z())) ? WalkabilityView.Cell.CLEAR : WalkabilityView.Cell.BLOCKED;
			return WalkabilityView.Cell.BLOCKED;
		};
		GridPosition feet = new GridPosition(1, 64, 0);
		// The zombie is in the east leg, 3 blocks east of the body.
		List<GridPosition> path = SafeStep.awayPath(world, feet, 4.5D, 0.5D, ReflexActions.MAX_PATH_STEPS, 1_500, ReflexActions.PATH_MIN_GAIN, cell -> false);
		check(path != null && !path.isEmpty(), "a bent tunnel has a way back along known ground");
		GridPosition end = path.getLast();
		check(Math.hypot(end.x() + 0.5D - 4.5D, end.z() + 0.5D - 0.5D) >= Math.hypot(1.5D - 4.5D, 0.0D) + ReflexActions.PATH_MIN_GAIN,
				"the way back ends well away from the threat: " + end);
		check(path.getFirst().equals(new GridPosition(0, 64, 0)), "the first step goes back the way the body came");
		for (GridPosition step : path) check(tunnel.contains(step), "every step is a known walkable cell: " + step);
		// A refused cell (a harmful cloud) is never on the way.
		List<GridPosition> around = SafeStep.awayPath(world, feet, 4.5D, 0.5D, ReflexActions.MAX_PATH_STEPS, 1_500, ReflexActions.PATH_MIN_GAIN,
				cell -> cell.equals(new GridPosition(0, 64, -3)));
		check(around == null || around.stream().noneMatch(cell -> cell.z() <= -3), "a refused cell blocks the way past it");
		// Unknown cells are never walked: the same tunnel unseen beyond the bend leaves only the short leg.
		WalkabilityView unseen = cell -> cell.z() < -1 ? WalkabilityView.Cell.UNLOADED : world.cellAt(cell);
		List<GridPosition> shortWay = SafeStep.awayPath(unseen, feet, 4.5D, 0.5D, ReflexActions.MAX_PATH_STEPS, 1_500, ReflexActions.PATH_MIN_GAIN, cell -> false);
		check(shortWay == null || shortWay.stream().allMatch(cell -> cell.z() >= -1), "unseen cells never carry the escape");
	}

	/** A dead end behind the body with the mob in the only way out: no path, so the escape reports its barriers as before. */
	private static void escapeNeverBacksPastTheThreat() {
		WalkabilityView corridor = cell -> {
			if (cell.y() == 63) return WalkabilityView.Cell.SAFE_SUPPORT;
			boolean open = cell.z() == 0 && cell.x() >= 0 && cell.x() <= 10;
			return (cell.y() == 64 || cell.y() == 65) && open ? WalkabilityView.Cell.CLEAR : WalkabilityView.Cell.BLOCKED;
		};
		// Body at the dead end (x=0), the mob two blocks along the only way out.
		List<GridPosition> path = SafeStep.awayPath(corridor, new GridPosition(0, 64, 0), 2.5D, 0.5D, ReflexActions.MAX_PATH_STEPS, 1_500,
				ReflexActions.PATH_MIN_GAIN, cell -> false);
		check(path == null, "no escape runs back past the mob");
	}

	/** A melee firing under water with the air short ends as YIELDED with the reason, and a held rule does not start. */
	private static void meleeYieldsToBreath() {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(rules("""
				[{"id":"melee","priority":8,"when":{"type":"hostile_near","within":3},"do":{"type":"attack"}},
				 {"id":"air","priority":5,"when":{"type":"air_below","bubbles":4},"do":{"type":"swim_up"}}]"""), 0L);
		Map<String, ReflexScheduler.Sense> melee = senses(Map.of("melee", true, "air", false));
		check("melee".equals(scheduler.step(1L, melee, RUNNING, "", false).started()), "the melee rule fires on a drowned in reach");
		String why = ReflexSensors.breathShort(90, 300, 3.0D);
		check(why != null, "4.5 s of air against a 3 s swim is short");
		ReflexScheduler.Decision yielded = scheduler.step(2L, senses(Map.of("melee", true, "air", true)), RUNNING, "facing minecraft:drowned", false, false, 0L,
				Map.of("melee", why));
		check(yielded.ended() != null && yielded.endOutcome() == ReflexScheduler.Outcome.YIELDED, "the melee firing yields to breathing");
		check("air".equals(yielded.started()), "the air rule takes the body the same tick");
		ReflexScheduler.Event event = scheduler.events().stream().filter(e -> e.ruleId().equals("melee")).reduce((a, b) -> b).orElseThrow();
		check(event.outcome() == ReflexScheduler.Outcome.YIELDED && event.detail().contains("air low") && event.detail().contains("breathing first"),
				"the yield says why: " + event.detail());
		// Not a failure: four yields in a row do not disable the rule.
		ReflexScheduler again = new ReflexScheduler();
		again.replace(rules("[{\"id\":\"melee\",\"kind\":\"stance\",\"when\":{\"type\":\"hostile_near\",\"within\":3},\"do\":{\"type\":\"attack\"}}]"), 0L);
		long tick = 1L;
		for (int round = 0; round < 6; round++) {
			again.step(tick++, senses(Map.of("melee", true)), RUNNING, "", false);
			again.step(tick++, senses(Map.of("melee", true)), RUNNING, "", false, false, 0L, Map.of("melee", why));
			again.step(tick++, senses(Map.of("melee", true)), RUNNING, "", false);
		}
		check(again.statuses(tick).getFirst().disabledReason() == null, "yielding to breathe never counts against the rule");
	}

	/** A trigger whose edge rose while the body had to breathe fires once the air is back, and is reported once while held. */
	private static void heldTriggerFiresOnceReleased() {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(rules("[{\"id\":\"melee\",\"when\":{\"type\":\"hostile_near\",\"within\":3},\"do\":{\"type\":\"attack\"}}]"), 0L);
		Map<String, String> held = Map.of("melee", "air low (2 of 10 bubbles, 1.0 s swim to air): breathing first");
		for (long tick = 1L; tick <= 60L; tick++) {
			check(scheduler.step(tick, senses(Map.of("melee", true)), RUNNING, "", false, false, 0L, held).started() == null, "held back while short of air");
		}
		long reports = scheduler.events().stream().filter(e -> e.detail().startsWith("held back: air low")).count();
		check(reports == 1L, "held back is reported once per hold, not every tick (" + reports + ")");
		check("melee".equals(scheduler.step(61L, senses(Map.of("melee", true)), RUNNING, "", false).started()),
				"the trigger fires once the body has air again, its edge long past the pending window");
	}

	private static void breathThreshold() {
		check(ReflexSensors.breathShort(300, 300, 3.0D) == null, "full air does not stop a fight");
		check(ReflexSensors.breathShort(130, 300, 3.0D) == null, "6.5 s of air covers a 3 s swim and the margin");
		check(ReflexSensors.breathShort(110, 300, 3.0D) != null, "5.5 s of air does not");
		check(ReflexSensors.breathShort(110, 300, 1.0D) == null, "a short swim leaves the fight on longer");
		check(ReflexSensors.breathShort(0, 300, 0.0D).contains("0 of 10 bubbles"), "the reason counts bubbles as the HUD shows them");
	}

	/** The arm-time fact for a rule whose action needs an item the body does not hold. */
	private static void armedWithoutItem() {
		List<ReflexSpec.Rule> parsed = rules("""
				[{"id":"clutch","when":{"type":"falling","blocks":5},"do":{"type":"place","item":"water_bucket","where":"below"}},
				 {"id":"guard","kind":"stance","when":{"type":"hostile_near","within":6},"do":{"type":"shield"}},
				 {"id":"snack","when":{"type":"hunger_below","value":8},"do":{"type":"eat"}},
				 {"id":"cover","when":{"type":"exposed","within":20},"do":{"type":"place_block"}},
				 {"id":"swap","when":{"type":"stack_used_up","item":"torch"},"do":{"type":"select","item":"torch"}},
				 {"id":"fight","when":{"type":"hostile_near","within":3},"do":{"type":"attack"}}]""");
		Map<Integer, ReflexActions.Held> slots = new HashMap<>();
		java.util.function.IntFunction<ReflexActions.Held> inventory = index -> slots.getOrDefault(index, ReflexActions.Held.EMPTY);
		ReflexActions.Held none = ReflexActions.Held.EMPTY;
		check("no minecraft:water_bucket in hotbar or offhand".equals(ReflexActions.lacks(parsed.get(0).action(), inventory, 0, none)),
				"a clutch with no bucket says so, in the words it would fail with");
		check("no shield in either hand".equals(ReflexActions.lacks(parsed.get(1).action(), inventory, 0, none)), "no shield held");
		check("no food in hotbar or offhand".equals(ReflexActions.lacks(parsed.get(2).action(), inventory, 0, none)), "no food");
		check("no full block in hotbar".equals(ReflexActions.lacks(parsed.get(3).action(), inventory, 0, none)), "no cover block");
		check("no minecraft:torch in inventory".equals(ReflexActions.lacks(parsed.get(4).action(), inventory, 0, none)), "no torches");
		check(ReflexActions.lacks(parsed.get(5).action(), inventory, 0, none) == null, "a punch needs nothing");
		slots.put(4, held("minecraft:water_bucket"));
		slots.put(0, held("minecraft:shield"));
		slots.put(7, new ReflexActions.Held("minecraft:bread", true, false));
		slots.put(8, new ReflexActions.Held("minecraft:cobblestone", false, true));
		slots.put(20, held("minecraft:torch"));
		for (int index = 0; index < 5; index++) {
			check(ReflexActions.lacks(parsed.get(index).action(), inventory, 0, none) == null, "held items clear " + parsed.get(index).id());
		}
		check("no shield in either hand".equals(ReflexActions.lacks(parsed.get(1).action(), inventory, 3, none)),
				"a shield in the hotbar but not in hand is not raised by the stance");
		check(ReflexActions.lacks(parsed.get(1).action(), inventory, 3, held("minecraft:shield")) == null, "an offhand shield is held");
		check(ReflexActions.lacks(parsed.get(0).action(), index -> index == 4 ? none : inventory.apply(index), 0, held("minecraft:water_bucket")) == null,
				"a bucket in the offhand serves the clutch");
		slots.put(4, held("minecraft:bucket"));
		check(ReflexActions.lacks(parsed.get(0).action(), inventory, 0, none) != null, "an emptied bucket is a lost clutch");
		slots.put(20, none);
		slots.put(30, held("minecraft:torch"));
		check(ReflexActions.lacks(parsed.get(4).action(), inventory, 0, none) == null, "select reaches the main inventory");
		slots.put(9, held("minecraft:water_bucket"));
		check(ReflexActions.lacks(parsed.get(0).action(), inventory, 0, none) != null, "a bucket in the main inventory is not in reach of a clutch");
	}

	private static ReflexActions.Held held(String id) {
		return new ReflexActions.Held(id, false, false);
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
		if (!condition) throw new AssertionError("ReflexBodyVerification: " + message);
		assertions++;
	}
}
