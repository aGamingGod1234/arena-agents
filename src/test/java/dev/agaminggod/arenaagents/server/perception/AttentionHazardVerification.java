package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/** Verifies that urgent hazards stay factual attention, not body-authored tactics. */
public final class AttentionHazardVerification {
	private AttentionHazardVerification() {
	}

	public static int verify() {
		JsonObject before = observation("mine");
		JsonObject after = before.deepCopy();
		JsonObject player = after.getAsJsonObject("player");
		player.addProperty("health", 18.0D);
		player.addProperty("onFire", true);
		player.addProperty("air", 40);
		player.addProperty("suffocating", true);
		player.addProperty("fallDistance", 8.0D);
		JsonObject attacker = new JsonObject();
		attacker.addProperty("uuid", "00000000-0000-0000-0000-000000000001");
		attacker.addProperty("type", "minecraft:zombie");
		player.add("lastAttacker", attacker);

		AttentionFactDelta active = AttentionFactDelta.between(before, after, 7L, 123L);
		assertTrue(active.attention(), "hazard changes gain urgent attention during a brain-authored action");
		for (String fact : new String[] {
				"player.health", "player.onFire", "player.air", "player.suffocating",
				"player.fallDistance", "player.lastAttacker"
		}) {
			assertTrue(active.changedFacts().contains(fact), fact + " remains a factual attention delta");
		}
		assertFalse(active.changedFacts().stream().anyMatch(AttentionHazardVerification::isTacticalLabel),
				"hazard attention does not invent a tactical label");

		JsonObject lavaBefore = observation("idle");
		JsonObject lavaAfter = lavaBefore.deepCopy();
		lavaAfter.getAsJsonArray("blocks").add(block("minecraft:lava"));
		AttentionFactDelta lava = AttentionFactDelta.between(lavaBefore, lavaAfter, 8L, 124L);
		assertTrue(lava.attention(), "observed lava remains a factual attention delta");
		assertTrue(lava.changedFacts().contains("blocks.0,64,0"), "lava is delivered as an observed block fact");
		assertFalse(lava.changedFacts().stream().anyMatch(AttentionHazardVerification::isTacticalLabel),
				"lava attention does not choose flee, jump, or another movement");
		return 11 + verifyRawAirSampling() + verifyHalfAirWarning() + verifySubmergedHandoff() + verifyApproachingDrop();
	}

	/** Drop measurements update authored conditions without forcing model attention. */
	private static int verifyApproachingDrop() {
		var still = new ServerObservationCollector.RawPlayerState(20, 20, 5, false, false, 300, false, true, 0.0D, null, 0L, java.util.Set.of(), 0, null);
		var approaching = new ServerObservationCollector.RawPlayerState(20, 20, 5, false, false, 300, false, true, 0.0D, null, 0L, java.util.Set.of(), 0, "4");
		var deeper = new ServerObservationCollector.RawPlayerState(20, 20, 5, false, false, 300, false, true, 0.0D, null, 0L, java.util.Set.of(), 0, "9");
		assertTrue(approaching.dropAheadChanged(still), "an edge coming up ahead is sampled now, not at the heartbeat");
		assertFalse(approaching.requiresForcedAttention(still, false), "but it is never forced attention");
		assertFalse(approaching.dropAheadChanged(approaching), "the same approach is not sampled again");
		assertTrue(still.dropAheadChanged(approaching) && !still.requiresForcedAttention(approaching, false),
				"turning away from the edge is sampled too (an order can rearm), never forced");
		assertTrue(deeper.dropAheadChanged(approaching), "a new depth is sampled for conditions that read it");
		JsonObject near = new JsonObject();
		near.addProperty("drop", 9);
		near.addProperty("at", 1);
		JsonObject far = near.deepCopy();
		far.addProperty("at", 3);
		assertFalse(DropAhead.geometryKey(near).equals(DropAhead.geometryKey(far)), "distance changes update authored thresholds");
		var farState = new ServerObservationCollector.RawPlayerState(20, 20, 5, false, false, 300, false, true, 0.0D, null, 0L, java.util.Set.of(), 0, DropAhead.geometryKey(far));
		var nearState = new ServerObservationCollector.RawPlayerState(20, 20, 5, false, false, 300, false, true, 0.0D, null, 0L, java.util.Set.of(), 0, DropAhead.geometryKey(near));
		assertTrue(nearState.dropAheadChanged(farState), "at 3 to at 1 requests an immediate raw sample before the heartbeat");
		assertFalse(nearState.requiresForcedAttention(farState, false), "distance sampling never forces model attention");
		assertFalse(nearState.dropAheadChanged(nearState), "unchanged distance does not repeat the sample");
		JsonObject nearWater = near.deepCopy();
		nearWater.addProperty("into", "water");
		assertFalse(DropAhead.geometryKey(near).equals(DropAhead.geometryKey(nearWater)), "a different landing is new geometry");
		assertTrue(DropAhead.geometryKey(null) == null, "no drop ahead has no key");

		JsonObject before = observation("control");
		JsonObject after = before.deepCopy();
		JsonObject drop = new JsonObject();
		drop.addProperty("drop", 9);
		drop.addProperty("at", 2);
		after.getAsJsonObject("player").add("dropAhead", drop);
		assertTrue(AttentionFactDelta.between(before, after, 9L, 125L).changedFacts().contains("player.dropAhead"),
				"the seen drop ahead is a factual attention delta");
		JsonObject closer = after.deepCopy();
		closer.getAsJsonObject("player").getAsJsonObject("dropAhead").addProperty("at", 1);
		assertFalse(AttentionFactDelta.between(after, closer, 10L, 126L).changedFacts().contains("player.dropAhead"),
				"walking on toward the same edge stays one fact");
		JsonObject navigating = observation("move_to");
		JsonObject navigatingAhead = navigating.deepCopy();
		navigatingAhead.getAsJsonObject("player").add("dropAhead", drop.deepCopy());
		assertFalse(AttentionFactDelta.between(navigating, navigatingAhead, 11L, 127L).changedFacts().contains("player.dropAhead"),
				"a navigator-planned path keeps its own footing and raises no edge fact");
		JsonObject water = before.deepCopy();
		JsonObject waterDrop = drop.deepCopy();
		waterDrop.addProperty("into", "water");
		water.getAsJsonObject("player").add("dropAhead", waterDrop);
		assertFalse(AttentionFactDelta.between(before, water, 12L, 128L).changedFacts().contains("player.dropAhead"),
				"a known water landing cancels fall damage, so it raises no survival edge");
		JsonObject unknown = before.deepCopy();
		JsonObject unknownDrop = new JsonObject();
		unknownDrop.addProperty("drop", 1);
		unknownDrop.addProperty("atLeast", true);
		unknownDrop.addProperty("at", 3);
		unknown.getAsJsonObject("player").add("dropAhead", unknownDrop);
		assertTrue(AttentionFactDelta.between(before, unknown, 13L, 129L).changedFacts().contains("player.dropAhead"),
				"an edge whose bottom is not known stays a possible harm");
		assertTrue(AttentionFactDelta.between(water, after, 14L, 130L).changedFacts().contains("player.dropAhead"),
				"turning from a water landing toward a hurtful edge is a new edge");
		JsonObject lavaDrop = drop.deepCopy();
		lavaDrop.addProperty("into", "lava");
		assertTrue(DropAhead.hurtful(lavaDrop), "a lava landing stays hurtful");
		return 18;
	}

	private static int verifyRawAirSampling() {
		var before = rawState(299, 20, true, 0, 0);
		var after = rawState(298, 20, true, 0, 0);
		assertFalse(before.equals(after), "safe air still changes the raw sample");
		assertFalse(after.requiresForcedAttention(before, false), "safe air alone does not force attention");
		assertFalse(before.requiresForcedAttention(after, false), "safe air recovery does not force attention");
		assertTrue(after.requiresForcedAttention(before, true), "inventory/menu/component freshness still forces delivery");
		assertTrue(rawState(60, 20, true, 0, 0).requiresForcedAttention(rawState(61, 20, true, 0, 0), false),
				"crossing the air hazard threshold remains forced");
		assertTrue(rawState(59, 20, true, 0, 0).requiresForcedAttention(rawState(60, 20, true, 0, 0), false),
				"each new critical air second remains forced");
		assertFalse(rawState(58, 20, true, 0, 0).requiresForcedAttention(rawState(59, 20, true, 0, 0), false),
				"per-tick critical air inside one air second is not forced");
		assertTrue(rawState(298, 19, true, 0, 0).requiresForcedAttention(before, false), "damage plus safe air remains forced");
		assertTrue(rawState(298, 20, true, 6, 0).requiresForcedAttention(before, false), "hazardous falling remains forced");
		assertTrue(rawState(298, 20, true, 0, 1).requiresForcedAttention(before, false), "perception events remain forced");
		var marginSample = rawState(239, 20, false, 0, 0);
		var beforeMargin = rawState(240, 20, false, 0, 0);
		assertTrue(marginSample.airSampleChanged(beforeMargin), "each air second refreshes acquired surface geometry");
		assertFalse(marginSample.requiresForcedAttention(beforeMargin, false), "routine breath samples do not force a model wake");
		return 12 + verifyRoutineStateWaitsForHeartbeat();
	}

	/**
	 * Only edges AttentionSignalPolicy raises as a fact force an observation; everything else rides the idle heartbeat.
	 * Each case also checks the policy side, so the two cannot drift apart.
	 */
	private static int verifyRoutineStateWaitsForHeartbeat() {
		var rest = raw(20, 20, 5, false, false, 300, false, true, 0.0D, null, 0L);
		assertFalse(raw(20, 20, 5, false, false, 300, false, false, 0.0D, null, 0L).requiresForcedAttention(rest, false),
				"leaving the ground is not a fact");
		assertFalse(rest.requiresForcedAttention(raw(20, 20, 5, false, false, 300, false, false, 0.0D, null, 0L), false),
				"landing is not a fact");
		assertFalse(raw(20, 20, 5, false, false, 300, false, true, 3.5D, null, 0L).requiresForcedAttention(rest, false),
				"falling below the damaging distance is not a fact");
		assertFalse(raw(20, 20, 5, false, false, 300, false, true, 0.0D, null, 0L).requiresForcedAttention(
				raw(20, 20, 5, false, false, 300, false, true, 9.0D, null, 0L), false), "a fall ending is not a fact");
		assertTrue(raw(20, 20, 5, false, false, 300, false, false, 6.0D, null, 0L).requiresForcedAttention(rest, false),
				"reaching the damaging fall distance is a fact");
		assertFalse(raw(20, 20, 5, false, false, 300, false, false, 8.0D, null, 0L).requiresForcedAttention(
				raw(20, 20, 5, false, false, 300, false, false, 7.0D, null, 0L), false), "falling further is not a new fact");
		assertFalse(raw(20, 20, 3, false, false, 300, false, true, 0.0D, null, 0L).requiresForcedAttention(rest, false),
				"saturation drifting is not a fact");
		assertFalse(raw(20, 19, 5, false, false, 300, false, true, 0.0D, null, 0L).requiresForcedAttention(rest, false),
				"hunger above the warning level is not a fact");
		assertTrue(raw(20, 6, 5, false, false, 300, false, true, 0.0D, null, 0L).requiresForcedAttention(
				raw(20, 7, 5, false, false, 300, false, true, 0.0D, null, 0L), false), "food reaching the warning level is a fact");
		assertFalse(raw(20, 5, 5, false, false, 300, false, true, 0.0D, null, 0L).requiresForcedAttention(
				raw(20, 6, 5, false, false, 300, false, true, 0.0D, null, 0L), false), "food falling further is not a new fact");
		assertFalse(raw(20, 20, 5, false, true, 300, false, true, 0.0D, null, 0L).requiresForcedAttention(rest, false),
				"entering water is not a fact");
		var wounded = raw(18, 20, 5, false, false, 300, false, true, 0.0D, null, 0L);
		assertFalse(raw(20, 20, 5, false, false, 300, false, true, 0.0D, null, 0L).requiresForcedAttention(wounded, false),
				"regeneration is not a fact");
		assertTrue(wounded.requiresForcedAttention(rest, false), "a health drop is a fact");
		assertTrue(raw(20, 20, 5, true, false, 300, false, true, 0.0D, null, 0L).requiresForcedAttention(rest, false),
				"catching fire is a fact");
		assertFalse(rest.requiresForcedAttention(raw(20, 20, 5, true, false, 300, false, true, 0.0D, null, 0L), false),
				"burning out is not a fact");
		assertTrue(raw(20, 20, 5, false, false, 300, true, true, 0.0D, null, 0L).requiresForcedAttention(rest, false),
				"suffocating is a fact");
		assertTrue(raw(20, 20, 5, false, false, 300, false, true, 0.0D, java.util.UUID.randomUUID(), 0L)
				.requiresForcedAttention(rest, false), "a new attacker is a fact");

		JsonObject before = observation("idle");
		JsonObject after = before.deepCopy();
		after.getAsJsonObject("player").addProperty("onGround", false);
		after.getAsJsonObject("player").addProperty("saturation", 1.0D);
		after.getAsJsonObject("player").addProperty("fallDistance", 3.5D);
		assertFalse(AttentionSignalPolicy.changedFacts(before, after).stream().anyMatch(fact -> fact.startsWith("player.")),
				"the policy raises none of the routine changes the heartbeat carries");
		after.getAsJsonObject("player").addProperty("fallDistance", 4.0D);
		assertTrue(AttentionSignalPolicy.changedFacts(before, after).contains("player.fallDistance"), "and raises the fall that matters");
		assertTrue(FallDanger.damage(3.99D, 3, 1) == 0, "26.1 floors fall power below four blocks");
		assertTrue(FallDanger.damage(4.0D, 3, 1) == 1, "first damaging vanilla fall");
		assertTrue(FallDanger.damage(5.0D, 5, 1) == 0, "safe fall attribute includes jump effects");
		assertTrue(FallDanger.damage(14.0D, 3, 0) == 0, "zero damage multiplier prevents fall wake");
		after.getAsJsonObject("player").addProperty("fallDamage", 0);
		assertFalse(AttentionSignalPolicy.changedFacts(before, after).contains("player.fallDistance"), "slow falling snapshot suppresses fall attention");
		return 24 + verifyThreatSignalsForceNow();
	}

	/** A creeper explodes 1.5 s after it starts swelling: every threat signal that rises goes out the same tick. */
	private static int verifyThreatSignalsForceNow() {
		var rest = raw(20, 20, 5, false, false, 300, false, true, 0.0D, null, 0L);
		var calm = rawWithSignals(java.util.Set.of("mob:targeting"));
		for (String signal : java.util.List.of("targeting", "swelling", "creeper_close", "imminent", "ranged_sight", "attacked")) {
			if (!signal.equals("targeting")) {
				assertTrue(rawWithSignals(java.util.Set.of("mob:targeting", "mob:" + signal)).requiresForcedAttention(calm, false),
						signal + " rising on a threat that already has signals goes out now");
			}
			assertTrue(rawWithSignals(java.util.Set.of("mob:" + signal)).requiresForcedAttention(rest, false),
					signal + " rising on a threat that had none goes out now");
		}
		assertFalse(rest.requiresForcedAttention(calm, false), "a signal expiring is only a quiet refresh");
		return 12;
	}

	private static ServerObservationCollector.RawPlayerState rawWithSignals(java.util.Set<String> signals) {
		return new ServerObservationCollector.RawPlayerState(20, 20, 5, false, false, 300, false, true, 0.0D, null, 0L, signals);
	}

	private static ServerObservationCollector.RawPlayerState raw(double health, int food, double saturation, boolean onFire,
			boolean inWater, int air, boolean suffocating, boolean onGround, double fallDistance, java.util.UUID attacker,
			long perceptionSequence) {
		return new ServerObservationCollector.RawPlayerState(health, food, saturation, onFire, inWater, air, suffocating,
				onGround, fallDistance, attacker, perceptionSequence);
	}

	/** Drowning attention must leave time to decide: it fires at half air (7.5 s), once per dive. */
	private static int verifyHalfAirWarning() {
		JsonObject before = observation("idle");
		before.getAsJsonObject("player").addProperty("air", 151);
		JsonObject after = before.deepCopy();
		after.getAsJsonObject("player").addProperty("air", 150);
		assertTrue(AttentionFactDelta.between(before, after, 9L, 125L).changedFacts().contains("player.air"),
				"crossing half air raises the drowning attention");
		JsonObject deeper = after.deepCopy();
		deeper.getAsJsonObject("player").addProperty("air", 120);
		assertFalse(AttentionFactDelta.between(after, deeper, 10L, 126L).changedFacts().contains("player.air"),
				"air draining further inside the same band does not re-raise it (debounced)");
		assertTrue(rawState(150, 20, true, 0, 0).requiresForcedAttention(rawState(151, 20, true, 0, 0), false),
				"the half-air crossing is delivered at once, not with the next routine sample");
		assertFalse(rawState(140, 20, true, 0, 0).requiresForcedAttention(rawState(141, 20, true, 0, 0), false),
				"air draining inside the warning band alone is not forced");
		return 4;
	}

	/**
	 * Fight review r2 B2: a flee that ends under water with 0.8 s of air was ordinary attention (only "perception"
	 * changed). An action result handed back submerged at or below the warning air is urgent once, like the air edge.
	 */
	private static int verifySubmergedHandoff() {
		JsonObject before = observation("idle");
		before.getAsJsonObject("player").addProperty("air", 14);
		before.getAsJsonObject("player").addProperty("underWater", true);
		JsonObject after = before.deepCopy();
		after.add("lastResult", result("a1", "SUCCEEDED", "TARGET_GONE"));
		assertTrue(AttentionFactDelta.between(before, after, 9L, 125L).changedFacts().contains("player.air"),
				"a result handed back under water with 0.7 s of air raises the drowning attention");
		JsonObject later = after.deepCopy();
		later.getAsJsonObject("player").addProperty("air", 10);
		assertFalse(AttentionFactDelta.between(after, later, 10L, 126L).changedFacts().contains("player.air"),
				"the same result does not raise it again");
		JsonObject surfaced = before.deepCopy();
		surfaced.getAsJsonObject("player").addProperty("underWater", false);
		JsonObject surfacedAfter = surfaced.deepCopy();
		surfacedAfter.add("lastResult", result("a2", "SUCCEEDED", "TARGET_GONE"));
		assertFalse(AttentionFactDelta.between(surfaced, surfacedAfter, 11L, 127L).changedFacts().contains("player.air"),
				"a result at the surface stays ordinary");
		JsonObject fullAir = before.deepCopy();
		fullAir.getAsJsonObject("player").addProperty("air", 257);
		JsonObject fullAirAfter = fullAir.deepCopy();
		fullAirAfter.add("lastResult", result("a3", "SUCCEEDED", "ESCAPED"));
		assertTrue(AttentionFactDelta.between(fullAir, fullAirAfter, 12L, 128L).changedFacts().contains("player.air"),
				"a result under water with 12.9 s of air re-alerts inside the model's fifteen-second margin");
		return 4;
	}

	private static JsonObject result(String actionId, String state, String reasonCode) {
		JsonObject value = new JsonObject();
		value.addProperty("present", true);
		value.addProperty("actionId", actionId);
		value.addProperty("state", state);
		value.addProperty("reasonCode", reasonCode);
		return value;
	}

	private static ServerObservationCollector.RawPlayerState rawState(int air, double health, boolean onGround,

			double fallDistance, long perceptionSequence) {
		return new ServerObservationCollector.RawPlayerState(health, 20, 5, false, true, air, false,
				onGround, fallDistance, null, perceptionSequence);
	}

	private static JsonObject observation(String actionType) {
		JsonObject value = new JsonObject();
		JsonObject player = new JsonObject();
		player.addProperty("health", 20.0D);
		player.addProperty("onFire", false);
		player.addProperty("air", 300);
		player.addProperty("maxAir", 300);
		player.addProperty("suffocating", false);
		player.addProperty("fallDistance", 0.0D);
		value.add("player", player);
		value.add("blocks", new JsonArray());
		JsonObject currentAction = new JsonObject();
		currentAction.addProperty("active", !"idle".equals(actionType));
		currentAction.addProperty("actionType", actionType);
		value.add("currentAction", currentAction);
		return value;
	}

	private static JsonObject block(String blockId) {
		JsonObject value = new JsonObject();
		value.addProperty("x", 0);
		value.addProperty("y", 64);
		value.addProperty("z", 0);
		value.addProperty("blockId", blockId);
		return value;
	}

	private static boolean isTacticalLabel(String value) {
		String lower = value.toLowerCase(java.util.Locale.ROOT);
		return switch (lower) {
			case "danger", "flee", "escape", "jump", "sprint", "attack", "move", "tactic" -> true;
			default -> false;
		};
	}

	private static void assertTrue(boolean value, String label) {
		if (!value) throw new AssertionError(label);
	}

	private static void assertFalse(boolean value, String label) {
		if (value) throw new AssertionError(label);
	}
}
