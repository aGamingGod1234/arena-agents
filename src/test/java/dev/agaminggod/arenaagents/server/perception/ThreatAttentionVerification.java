package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Verifies threat signals: latched debounce, one attention edge per new signal, and forced delivery. */
public final class ThreatAttentionVerification {
	private static final String ZOMBIE = "00000000-0000-0000-0000-00000000000a";
	private static final String CREEPER = "00000000-0000-0000-0000-00000000000b";
	private static int assertions;

	private ThreatAttentionVerification() {
	}

	public static int verify() {
		assertions = 0;
		verifyLatch();
		verifyAttentionFacts();
		verifyForcedDelivery();
		verifyHeardThreats();
		verifySignalRules();
		verifyTrend();
		verifyCreeperTimeline();
		verifyAimingRules();
		verifySignalVocabulary();
		verifyVisibility();
		verifyThreatSelection();
		// A blaze box 70..71.8 behind a fence that stops lines below 71.0: its top half shows, so the shot is clear.
		net.minecraft.world.phys.AABB blaze = new net.minecraft.world.phys.AABB(4.7, 70, -0.3, 5.3, 71.8, 0.3);
		net.minecraft.world.phys.Vec3 blazeEye = new net.minecraft.world.phys.Vec3(5, 71.5, 0);
		check(ThreatPerception.shotLine(blaze, blazeEye, aim -> aim.y < 71.0 ? "minecraft:nether_brick_fence" : "clear").equals("clear"),
				"a mob whose top shows over a fence has a clear shot");
		check(ThreatPerception.shotLine(blaze, blazeEye, aim -> "minecraft:nether_bricks").equals("minecraft:nether_bricks"),
				"a mob hidden at every aim point names the block on the line to its middle");
		check(ThreatPerception.shotLine(blaze, blazeEye, aim -> "clear").equals("clear"), "an open line is clear");
		return assertions;
	}

	/**
	 * The coordinator rejects any signal outside its schema, so every value signals() and rawSignals() can produce must be
	 * listed in SIGNALS (the list the coordinator contract test reads), and every listed value must be reachable.
	 * Play-test (2026-10-10): a literal "ranged_aiming" missing from the schema dropped the bridge 29 times in one fight.
	 */
	private static void verifySignalVocabulary() {
		Set<String> threatSeen = new java.util.HashSet<>();
		for (int bits = 0; bits < 256; bits++) {
			for (double distance : new double[] {2.0D, 4.0D, 10.0D, 18.0D}) {
				for (double eta : new double[] {Double.NaN, 1.0D, 5.0D}) {
					threatSeen.addAll(ThreatPerception.signals((bits & 1) != 0, (bits & 2) != 0, (bits & 4) != 0, (bits & 8) != 0,
							(bits & 16) != 0, (bits & 32) != 0, distance, (bits & 64) != 0, eta, (bits & 128) != 0));
				}
			}
		}
		check(ThreatPerception.SIGNALS.containsAll(threatSeen), "every emitted threat signal is in SIGNALS: " + threatSeen);
		check(threatSeen.containsAll(ThreatPerception.SIGNALS), "every threat signal in SIGNALS is reachable: " + threatSeen);
		check(Set.copyOf(ThreatPerception.SIGNALS).size() == ThreatPerception.SIGNALS.size(), "threat SIGNALS has no duplicates");

		Set<String> survivalSeen = new java.util.HashSet<>();
		SurvivalPerception.Food steak = new SurvivalPerception.Food(0, "minecraft:cooked_beef", 8, 12.8F, false);
		for (int bits = 0; bits < 8; bits++) {
			for (double health : new double[] {4.0D, 12.0D, 20.0D}) {
				survivalSeen.addAll(SurvivalPerception.rawSignalsAtHunger(health, 20.0D, 10, (bits & 1) != 0 ? steak : null,
						(bits & 2) != 0, (bits & 4) != 0));
			}
		}
		check(SurvivalPerception.SIGNALS.containsAll(survivalSeen), "every emitted survival signal is in SIGNALS: " + survivalSeen);
		check(survivalSeen.containsAll(SurvivalPerception.SIGNALS), "every survival signal in SIGNALS is reachable: " + survivalSeen);
	}

	private static void verifyVisibility() {
		ThreatPerception.Snapshot snapshot = new ThreatPerception.Snapshot(List.of(
				new ThreatPerception.Entry(ZOMBIE, "minecraft:magma_cube", 2.4D, 0.0D, false, false, true,
						List.of("imminent"), 1.0D, Map.of(), 0.0D, ThreatPerception.Trend.NONE, Double.NaN, Double.NaN, null, true),
				new ThreatPerception.Entry(CREEPER, "minecraft:magma_cube", 2.4D, 0.0D, false, false, false,
						List.of("imminent"), 1.0D, Map.of(), 0.0D, ThreatPerception.Trend.NONE, Double.NaN, 1.0D, null)), Set.of(), -1, null);
		JsonArray rows = ThreatPerception.toJson(snapshot).getAsJsonArray("entries");
		JsonObject hidden = rows.get(0).getAsJsonObject();
		JsonObject visible = rows.get(1).getAsJsonObject();
		check(!hidden.get("visible").getAsBoolean() && !hidden.has("dy"), "latched signals and mob sight do not establish current player visibility or reveal height");
		check(visible.get("visible").getAsBoolean() && visible.get("dy").getAsDouble() == 1.0D, "eye-acquired height accompanies current visibility even without mob sight");
		check(hidden.get("targetable").getAsBoolean() && visible.get("targetable").getAsBoolean(), "a sensed target can be actionable outside the view cone without exposing height");
		check(hidden.getAsJsonArray("signals").equals(visible.getAsJsonArray("signals")), "visibility does not rewrite threat signals");
		JsonObject before = observation();
		JsonObject after = observation();
		JsonObject row = entry(ZOMBIE, "minecraft:magma_cube", "imminent");
		row.addProperty("visible", false);
		before.add("threats", threats(row));
		row = row.deepCopy(); row.addProperty("visible", true); row.addProperty("dy", 1.0D);
		after.add("threats", threats(row));
		check(!AttentionFactDelta.between(before, after, 1L, 1L).attention(), "visibility flicker does not become a repeated urgent threat edge");
	}

	private static void verifyTrend() {
		// Blocks per tick in, blocks per second out: a creeper walking 0.13 b/t straight at a standing agent.
		check(Math.abs(ThreatPerception.closingSpeed(0.0D, 0.0D, 0.0D, 0.0D, 16.0D, 0.0D, -0.13D, 0.0D) - 2.6D) < 1.0E-9D,
				"closing speed is the approach along the line between them, per second");
		check(ThreatPerception.closingSpeed(0.0D, 0.0D, 0.0D, 0.0D, 16.0D, 0.0D, 0.13D, 0.0D) < 0.0D, "receding is negative");
		check(Math.abs(ThreatPerception.closingSpeed(0.0D, 0.0D, 0.0D, 0.0D, 16.0D, 0.0D, 0.0D, 0.13D)) < 1.0E-9D,
				"circling at a fixed distance is not closing");
		check(Math.abs(ThreatPerception.closingSpeed(0.0D, 0.0D, -0.13D, 0.0D, 16.0D, 0.0D, -0.13D, 0.0D)) < 1.0E-9D,
				"a chaser matching a fleeing agent's speed is not closing");
		check(ThreatPerception.closingSpeed(0.0D, 0.0D, 0.0D, 0.0D, 0.0D, 0.0D, 1.0D, 1.0D) == 0.0D, "a coincident body has no direction");

		ThreatPerception.Trend creeper = ThreatPerception.trend(16.0D, 2.6D, true, false);
		check(creeper.approaching() && creeper.contactRange() == ThreatPerception.CREEPER_CONTACT && creeper.etaSeconds() == 5.0D,
				"a creeper 16 blocks off at 2.6 b/s reaches fuse range (3 blocks) in 5 s");
		check(ThreatPerception.trend(10.0D, 4.0D, false, false).etaSeconds() == 2.0D, "a melee mob reaches 2 blocks of reach");
		check(ThreatPerception.trend(1.5D, 0.0D, false, false).etaSeconds() == 0.0D, "already in reach is an ETA of 0");
		ThreatPerception.Trend pacing = ThreatPerception.trend(8.0D, 0.1D, false, false);
		check(!pacing.approaching() && Double.isNaN(pacing.etaSeconds()), "pacing is not approaching and has no ETA");
		check(Double.isNaN(ThreatPerception.trend(12.0D, 3.0D, false, true).etaSeconds()), "innate ranged mob has no physical contact ETA");

		check(!ThreatPerception.signals(false, true, true, false, false, true, 16.0D, false, 5.0D).contains(ThreatPerception.IMMINENT),
				"5 s out is targeting only");
		check(ThreatPerception.signals(false, true, true, false, false, true, 10.0D, false, 2.9D).equals(List.of("targeting", "imminent")),
				"under 3 s a hunting creeper is imminent, one more edge before it is close");
		check(ThreatPerception.signals(false, false, true, false, false, true, 8.0D, false, 2.0D).contains(ThreatPerception.IMMINENT),
				"a creeper that sees the agent and walks in is imminent even before it targets");
		check(!ThreatPerception.signals(false, false, true, false, false, false, 8.0D, false, 2.0D).contains(ThreatPerception.IMMINENT),
				"one behind a wall that is not hunting is not");
		check(ThreatPerception.signals(false, true, false, false, true, true, 8.0D, false, 1.0D).contains(ThreatPerception.IMMINENT),
				"ranged mobs approaching contact are imminent too");
		check(ThreatPerception.signals(true, false, false, false, false, true, 3.0D, false, 1.0D).isEmpty(),
				"a calm neutral mob walking past is not imminent");
		check(!ThreatPerception.signals(false, true, false, false, false, true, 8.0D, false, Double.NaN).contains(ThreatPerception.IMMINENT),
				"no ETA (not approaching) is never imminent");

		JsonObject before = observation();
		before.add("threats", threats(entry(CREEPER, "minecraft:creeper", "targeting")));
		JsonObject after = observation();
		JsonObject both = entry(CREEPER, "minecraft:creeper", "targeting");
		both.getAsJsonArray("signals").add("imminent");
		after.add("threats", threats(both));
		check(AttentionFactDelta.between(before, after, 1L, 1L).changedFacts().equals(List.of("threats." + CREEPER + ".imminent")),
				"becoming imminent is a new urgent edge for an already reported threat");

		ThreatPerception.Snapshot snapshot = new ThreatPerception.Snapshot(List.of(
				new ThreatPerception.Entry(CREEPER, "minecraft:creeper", 16.0D, 0.0D, true, false, true, List.of("targeting"), 4.3D, Map.of(),
						0.0D, creeper, 145.0D),
				new ThreatPerception.Entry(ZOMBIE, "minecraft:zombie", 6.0D, 0.0D, true, false, true, List.of("targeting"), 30.0D, Map.of(),
						3.0D, pacing, Double.NaN)), Set.of(), -1, null);
		JsonArray rows = ThreatPerception.toJson(snapshot).getAsJsonArray("entries");
		JsonObject first = rows.get(0).getAsJsonObject();
		check(first.get("closingSpeed").getAsDouble() == 2.6D && first.get("approaching").getAsBoolean()
				&& first.get("etaSeconds").getAsDouble() == 5.0D && first.get("contactRisk").getAsDouble() == 145.0D,
				"the wire row carries closing speed, approaching, ETA and the risk at contact");
		JsonObject second = rows.get(1).getAsJsonObject();
		check(!second.get("approaching").getAsBoolean() && !second.has("etaSeconds") && !second.has("contactRisk"),
				"a body that is not approaching has no ETA or contact risk on the wire");
	}

	private static void verifyAimingRules() {
		check(FallDanger.landingDamage(14, 3, 1, net.minecraft.world.level.block.Blocks.HAY_BLOCK.defaultBlockState(), false, 0) == 2,
				"hay landing reduces fall damage before rounding");
		check(FallDanger.landingDamage(14, 3, 1, net.minecraft.world.level.block.Blocks.BED.red().defaultBlockState(), false, 0) == 5,
				"bed landing halves fall damage before rounding");
		check(FallDanger.landingDamage(14, 3, 1, net.minecraft.world.level.block.Blocks.SLIME_BLOCK.defaultBlockState(), false, 0) == 0,
				"slime landing bounces without damage");
		check(FallDanger.landingDamage(14, 3, 1, net.minecraft.world.level.block.Blocks.SLIME_BLOCK.defaultBlockState(), true, 0) == 11,
				"sneaking suppresses slime bounce");
		check(Math.abs(FallDanger.landingDamage(14, 3, 1, null, false, 12) - 5.72D) < 0.001D,
				"Feather Falling IV protection reduces fall damage by 48 percent");
		check(Math.abs(FallDanger.landingDamage(14, 3, 1, null, false, 20) - 2.2D) < 0.001D,
				"combined Protection and Feather Falling use vanilla capped protection");

		try {
			var field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
			field.setAccessible(true);
			var allocator = (sun.misc.Unsafe) field.get(null);
			var piglin = (WeaponPiglin) allocator.allocateInstance(WeaponPiglin.class);
			piglin.setId(1030); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			piglin.held = fixtureStack(net.minecraft.world.item.Items.GOLDEN_SWORD);
			check(!ThreatPerception.isRanged(piglin), "sword piglin is melee despite crossbow interface");
			piglin.held = fixtureStack(net.minecraft.world.item.Items.CROSSBOW);
			check(ThreatPerception.isRanged(piglin), "crossbow piglin is ranged");
			for (Class<?> type : List.of(net.minecraft.world.entity.monster.Witch.class,
					net.minecraft.world.entity.animal.equine.Llama.class, net.minecraft.world.entity.monster.Ghast.class,
					net.minecraft.world.entity.monster.Blaze.class)) {
				check(ThreatPerception.isRanged((net.minecraft.world.entity.Mob) allocator.allocateInstance(type)),
						"innate ranged classification: " + type.getSimpleName());
			}
		} catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }

		check(ThreatPerception.signals(true, false, false, false, true, true, 5, false, Double.NaN, true).isEmpty(),
				"neutral loaded crossbow holder raises nothing");
		check(!ThreatPerception.signals(false, false, false, false, true, true, 5, false, Double.NaN, true).contains("ranged_aiming"),
				"skeleton drawing on a golem does not aim at the agent");
		check(ThreatPerception.signals(true, true, false, false, true, true, 5, false, Double.NaN, true).contains("ranged_aiming"),
				"targeting crossbow holder visibly aiming raises aiming");
		check(Double.isNaN(ThreatPerception.trend(8, 4, false, true).etaSeconds()),
				"innate ghast and blaze attacks have no melee ETA");
		check(Double.isNaN(ThreatPerception.trend(8, 4, false, true).etaSeconds()),
				"agent movement toward stationary ranged weapon user cannot raise imminent");
		check(Double.isNaN(ThreatPerception.trend(8, 4, false, true).etaSeconds()),
				"crossbow approach has no melee contact ETA");
		var drifting = ThreatPerception.trend(15, ThreatPerception.closingSpeed(0, 0, 0.215, 0, 15, 0, -0.015, 0), false, true);
		check(Double.isNaN(drifting.etaSeconds()) && !ThreatPerception.signals(false, true, false, false, true, true, 15, false, drifting.etaSeconds()).contains("imminent"),
				"walking toward a slowly drifting skeleton never raises imminent");
	}

	/**
	 * Play-test (2026-10-08): a creeper targeting the agent read risk 4 at 16 blocks and the model treated it as minor;
	 * risk only reached 100-200 at about 3 blocks. The risk at contact range shows what was coming from the first edge.
	 */
	private static void verifyCreeperTimeline() {
		double far = RiskModel.score(creeper(16.0D, 0.0D)).risk();
		double five = RiskModel.score(creeper(5.0D, ThreatDamage.explosionDamage(5.0D, ThreatDamage.CREEPER_RADIUS))).risk();
		double contact = RiskModel.score(creeper(ThreatPerception.CREEPER_CONTACT,
				ThreatDamage.explosionDamage(ThreatPerception.CREEPER_CONTACT, ThreatDamage.CREEPER_RADIUS))).risk();
		check(far >= 3.0D && far <= 6.0D, "a hunting creeper 16 blocks off scores about 4 (" + far + ")");
		check(five < 100.0D, "still under 100 at 5 blocks (" + five + ")");
		check(contact >= 100.0D && contact <= 200.0D, "about 145 once it is at fuse range, " + contact + "; that is its contactRisk");
	}

	private static RiskModel.Input creeper(double distance, double hit) {
		return new RiskModel.Input(0.6D, 1.7D, 20.0D, 0.0D, false, 0.25D, 0.13D, distance, hit, false, false, true, false, 0.0D);
	}

	private static void verifyThreatSelection() {
		check(ThreatPerception.scanCandidate(false, true, false),
				"a neutral mob targeting the agent is scanned before it lands a hit");
		check(!ThreatPerception.scanCandidate(false, false, false), "a calm neutral mob is not a threat candidate");
		ThreatSignalLatch latch = new ThreatSignalLatch();
		java.util.Set<String> raw = new java.util.HashSet<>();
		java.util.Set<String> present = new java.util.HashSet<>();
		for (int index = 0; index < 8; index++) {
			raw.add(ThreatSignalLatch.key("old-" + index, ThreatPerception.TARGETING));
			present.add("old-" + index);
			latch.update(raw, present, index);
		}
		raw.add(ThreatSignalLatch.key("new-creeper", ThreatPerception.SWELLING));
		present.add("new-creeper");
		List<String> kept = select(latch, latch.update(raw, present, 100L));
		check(kept.size() == ThreatPerception.MAX_ENTRIES, "selection stays bounded");
		check(kept.getFirst().equals("new-creeper"), "a newly swelling creeper is reported ahead of eight older sightings: " + kept);
		check(!kept.contains("old-7"), "the newest low-urgency sighting yields its row");
		raw.remove(ThreatSignalLatch.key("new-creeper", ThreatPerception.SWELLING));
		raw.add(ThreatSignalLatch.key("new-creeper", ThreatPerception.TARGETING));
		List<String> after = select(latch, latch.update(raw, present, 150L));
		check(after.equals(kept), "a creeper that stops swelling keeps its row through the hold window: " + after);
		check(latch.tracks("new-creeper") && !latch.tracks("never-seen"), "the latch reports which threats it still holds");

		// Review: a permanent peak hid a live swelling creeper behind eight whose swelling had long expired.
		ThreatSignalLatch past = new ThreatSignalLatch();
		java.util.Set<String> pastRaw = new java.util.HashSet<>();
		java.util.Set<String> pastPresent = new java.util.HashSet<>();
		for (int index = 0; index < 8; index++) {
			pastRaw.add(ThreatSignalLatch.key("past-creeper-" + index, ThreatPerception.TARGETING));
			pastRaw.add(ThreatSignalLatch.key("past-creeper-" + index, ThreatPerception.SWELLING));
			pastPresent.add("past-creeper-" + index);
			past.update(pastRaw, pastPresent, index);
		}
		pastRaw.removeIf(key -> ThreatSignalLatch.signal(key).equals(ThreatPerception.SWELLING));
		for (long tick = 8L; tick <= 108L; tick++) past.update(pastRaw, pastPresent, tick);
		pastRaw.add(ThreatSignalLatch.key("live-creeper", ThreatPerception.SWELLING));
		pastPresent.add("live-creeper");
		List<String> live = select(past, past.update(pastRaw, pastPresent, 109L));
		check(live.getFirst().equals("live-creeper"), "a creeper swelling now outranks eight whose swelling expired: " + live);

		// PR #91 review: eight equal-rank attacked threats hid a ninth skeleton that started aiming, so its fact had no row.
		java.util.Map<String, Integer> urgencies = new java.util.HashMap<>();
		java.util.Map<String, Long> seen = new java.util.HashMap<>();
		for (int index = 0; index < 9; index++) {
			urgencies.put("rank-" + index, 2);
			seen.put("rank-" + index, (long) index);
		}
		List<String> stable = ThreatPerception.selectThreatIds(urgencies, seen, java.util.Set.of());
		check(!stable.contains("rank-8"), "without a new signal the oldest eight keep their rows");
		List<String> shown = ThreatPerception.selectThreatIds(urgencies, seen, java.util.Set.of("rank-8"));
		check(shown.contains("rank-8") && !shown.contains("rank-7") && shown.size() == ThreatPerception.MAX_ENTRIES,
				"a threat with an unannounced signal replaces the least urgent announced row: " + shown);
		java.util.Set<String> crowd = new java.util.HashSet<>(urgencies.keySet());
		check(ThreatPerception.selectThreatIds(urgencies, seen, crowd).equals(stable),
				"when every row is also new, rows stay as ranked and the rest wait for the next delivery");
	}

	private static List<String> select(ThreatSignalLatch latch, java.util.Set<String> latched) {
		java.util.Map<String, List<String>> signals = new java.util.HashMap<>();
		java.util.Map<String, Long> firstSeen = new java.util.HashMap<>();
		for (String key : latched) {
			signals.computeIfAbsent(ThreatSignalLatch.threatId(key), ignored -> new java.util.ArrayList<>()).add(ThreatSignalLatch.signal(key));
			firstSeen.merge(ThreatSignalLatch.threatId(key), latch.firstSeen(key), Math::min);
		}
		java.util.Map<String, Integer> urgencies = new java.util.HashMap<>();
		signals.forEach((id, names) -> urgencies.put(id, ThreatPerception.urgency(names)));
		return ThreatPerception.selectThreatIds(urgencies, firstSeen);
	}

	private static void verifyLatch() {
		ThreatSignalLatch latch = new ThreatSignalLatch();
		String swelling = ThreatSignalLatch.key(CREEPER, "swelling");
		Set<String> present = Set.of(CREEPER);
		check(latch.update(Set.of(swelling), present, 0L).contains(swelling), "a raw signal is reported");
		check(latch.update(Set.of(), present, 50L).contains(swelling), "a flickering signal stays latched (no re-fire)");
		check(!latch.update(Set.of(), present, 50L + ThreatSignalLatch.HOLD_TICKS + 1L).contains(swelling),
				"a signal expires after the hold window");
		latch.update(Set.of(swelling), present, 200L);
		check(latch.update(Set.of(), Set.of(), 201L).isEmpty(), "a dead or departed mob drops its signals at once");
		check(ThreatSignalLatch.threatId(swelling).equals(CREEPER) && ThreatSignalLatch.signal(swelling).equals("swelling"),
				"signal keys split back into mob and signal");
	}

	private static void verifyAttentionFacts() {
		JsonObject before = observation();
		JsonObject targeted = observation();
		targeted.add("threats", threats(entry(ZOMBIE, "minecraft:zombie", "targeting")));
		AttentionFactDelta first = AttentionFactDelta.between(before, targeted, 1L, 1L);
		check(first.attention() && first.changedFacts().contains("threats." + ZOMBIE + ".targeting"),
				"a mob starting to target the agent is an attention edge");
		JsonObject moved = targeted.deepCopy();
		moved.getAsJsonObject("threats").getAsJsonArray("entries").get(0).getAsJsonObject().addProperty("distance", 3.0D);
		check(!AttentionFactDelta.between(targeted, moved, 2L, 2L).attention(),
				"the same threat moving closer does not raise another attention edge");
		JsonObject creeper = moved.deepCopy();
		creeper.getAsJsonObject("threats").getAsJsonArray("entries").add(entry(CREEPER, "minecraft:creeper", "swelling"));
		AttentionFactDelta swell = AttentionFactDelta.between(moved, creeper, 3L, 3L);
		check(swell.changedFacts().equals(java.util.List.of("threats." + CREEPER + ".swelling")),
				"a new creeper swell is reported once, alone");
		JsonObject active = observation();
		active.getAsJsonObject("currentAction").addProperty("active", true);
		JsonObject activeTargeted = active.deepCopy();
		activeTargeted.add("threats", threats(entry(ZOMBIE, "minecraft:zombie", "targeting")));
		check(AttentionFactDelta.between(active, activeTargeted, 4L, 4L).attention(),
				"threat edges interrupt a running action too");
	}

	private static void verifyForcedDelivery() {
		var quiet = raw(Set.of());
		var threatened = raw(Set.of(ThreatSignalLatch.key(ZOMBIE, "targeting")));
		check(threatened.requiresForcedAttention(quiet, false), "a new latched signal is delivered on the urgent queue");
		check(!quiet.requiresForcedAttention(threatened, false), "a signal expiring is only a quiet refresh");
	}

	private static void verifyHeardThreats() {
		check(ServerObservationCollector.hearsThreat(true, false, false), "a hostile targeting the agent from behind is heard");
		check(ServerObservationCollector.hearsThreat(false, true, false), "a hidden mob that just hurt the agent (an arrow in the back) is heard");
		check(!ServerObservationCollector.hearsThreat(false, false, false), "an unaware hidden mob stays unobserved");
		check(!ServerObservationCollector.hearsThreat(true, true, true), "a visible hunter is reported by sight, not twice");
	}

	private static void verifySignalRules() {
		check(ThreatPerception.signals(true, false, false, false, true, true, 8.0D).isEmpty(),
				"a calm neutral mob (piglin tolerating gold) raises nothing, even with a crossbow and sight");
		check(ThreatPerception.signals(true, true, false, false, true, true, 8.0D).equals(java.util.List.of("targeting", "ranged_sight")),
				"an angry neutral mob is a threat like any other");
		check(ThreatPerception.signals(false, false, true, false, false, false, 3.0D).isEmpty(),
				"a close creeper behind a wall that is not hunting the agent is not a threat");
		check(ThreatPerception.signals(false, false, true, false, false, true, 3.0D).contains("creeper_close"),
				"a close creeper in sight is");
		check(ThreatPerception.signals(false, true, false, false, false, true, 18.0D).isEmpty(),
				"nothing new is raised beyond 16 blocks");
		ThreatSignalLatch latch = new ThreatSignalLatch();
		String far = ThreatSignalLatch.key(ZOMBIE, "targeting");
		latch.update(Set.of(far), Set.of(ZOMBIE), 0L);
		check(latch.update(Set.of(), Set.of(ZOMBIE), 20L).contains(far),
				"a latched mob pacing between 16 and 20 blocks (still present) keeps its signal");
		String creeper = ThreatSignalLatch.key(CREEPER, "swelling");
		latch.update(Set.of(creeper), Set.of(ZOMBIE, CREEPER), 30L);
		check(latch.firstSeen(far) == 0L && latch.firstSeen(creeper) == 30L,
				"latch age orders reported threats so a distance reshuffle is never a new edge");
	}

	private static ServerObservationCollector.RawPlayerState raw(Set<String> signals) {
		return new ServerObservationCollector.RawPlayerState(20.0D, 20, 5.0D, false, false, 300, false, true, 0.0D,
				null, 0L, signals);
	}

	private static net.minecraft.world.item.ItemStack fixtureStack(net.minecraft.world.item.Item item) throws ReflectiveOperationException {
		var holder = item.builtInRegistryHolder();
		var original = holder.areComponentsBound() ? holder.components() : null;
		try {
			if (original == null) holder.bindComponents(net.minecraft.core.component.DataComponentMap.builder()
					.set(net.minecraft.core.component.DataComponents.MAX_STACK_SIZE, 1).build());
			return new net.minecraft.world.item.ItemStack(item);
		} finally {
			if (original == null) {
				var components = net.minecraft.core.Holder.Reference.class.getDeclaredField("components");
				components.setAccessible(true);
				components.set(holder, null);
			}
		}
	}

	private static final class WeaponPiglin extends net.minecraft.world.entity.monster.piglin.Piglin {
		private net.minecraft.world.item.ItemStack held;
		private WeaponPiglin() { super(net.minecraft.world.entity.EntityTypes.PIGLIN, null); }
		@Override public net.minecraft.world.item.ItemStack getMainHandItem() { return held; }
	}

	private static JsonObject observation() {
		JsonObject value = new JsonObject();
		JsonObject player = new JsonObject();
		player.addProperty("health", 20.0D);
		value.add("player", player);
		JsonObject action = new JsonObject();
		action.addProperty("active", false);
		value.add("currentAction", action);
		return value;
	}

	private static JsonObject threats(JsonObject... entries) {
		JsonObject threats = new JsonObject();
		JsonArray values = new JsonArray();
		for (JsonObject entry : entries) values.add(entry);
		threats.add("entries", values);
		return threats;
	}

	private static JsonObject entry(String uuid, String type, String signal) {
		JsonObject entry = new JsonObject();
		entry.addProperty("uuid", uuid);
		entry.addProperty("type", type);
		entry.addProperty("distance", 6.0D);
		JsonArray signals = new JsonArray();
		signals.add(signal);
		entry.add("signals", signals);
		return entry;
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
