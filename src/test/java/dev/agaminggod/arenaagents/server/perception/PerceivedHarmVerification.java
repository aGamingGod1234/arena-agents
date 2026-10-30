package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.agent.AgentId;
import java.lang.reflect.Field;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.Difficulty;

/** Real HUD-rate history and survival regression assertions, without guessing damage mechanics. */
public final class PerceivedHarmVerification {
	private PerceivedHarmVerification() { }
	public static int verify() {
		int passed = 0;
		List<String> sources = List.of("on_fire", "lava", "drown", "in_wall", "fall", "starve", "magic", "wither", "freeze", "fell_out_of_world", "hot_floor");
		for (int i = 0; i < sources.size(); i++) {
			var cues = new PerceivedHarm.Cues(i == 0, i == 1, i == 2, i == 3, i == 4, i == 5,
					i == 6, i == 7, i == 8, i == 9, i == 10 ? "hot_floor" : null);
			String source = PerceivedHarm.currentSource(cues);
			check(source.equals("minecraft:" + sources.get(i)), "current perceived harm retains damage type " + sources.get(i)); passed++;
			var harm = new PerceivedHarm.Snapshot(source, true, null, null);
			boolean safe = SurvivalPerception.safe(harm, new ThreatPerception.Snapshot(List.of(), Set.of(), -1, null));
			var healthy = SurvivalPerception.evaluate(20, 20, i == 5 ? 0 : 20, null, true, safe, new SurvivalPerception.Latch(), 0);
			JsonObject facts = SurvivalPerception.toJson(healthy);
			check(i == 5 ? healthy.safe() && !healthy.canHealNow() : facts != null && !facts.get("safe").getAsBoolean() && !facts.get("canHealNow").getAsBoolean(), "full-health " + source + " respects the safe-to-eat starvation exception"); passed++;
			var low = SurvivalPerception.evaluate(8, 20, i == 5 ? 0 : 10, null, true, safe, new SurvivalPerception.Latch(), 0);
			check(low.signals().contains(SurvivalPerception.LOW_HEALTH_NO_FOOD), "environmental harm counts as threatened " + source); passed++;
		}
		check("minecraft:in_fire".equals(PerceivedHarm.currentSource(new PerceivedHarm.Cues(true, false, false, false, false, false, false, false, false, false, "fire"))),
				"burning while standing in a fire block reports the fire block, not only the burn"); passed++;
		check("minecraft:on_fire".equals(PerceivedHarm.currentSource(new PerceivedHarm.Cues(true, false, false, false, false, false, false, false, false, false, null))),
				"burning after leaving the fire block reports the burn"); passed++;
		String explosion = PerceivedHarm.recentSource("minecraft:explosion", 50, 51);
		JsonObject blast = PerceivedHarm.toJson(new PerceivedHarm.Snapshot(explosion, false, null, "left"));
		check(!blast.has("ongoing") && blast.get("direction").getAsString().equals("left"), "a recent blast remains perceived but is not an ongoing explosion"); passed++;
		check(!blast.has("hpLossPerSecond"), "unknown damage rate is absent rather than zero"); passed++;
		check(PerceivedHarm.recentSource("minecraft:explosion", 50, 91) == null, "past blast expires after rolling two-second window"); passed++;
		check(PerceivedHarm.recentSource("mod:unknown_damage", 50, 51).equals("mod:unknown_damage"), "any received damage type is preserved without a hardcoded damage allowlist"); passed++;
		check(PerceivedHarm.recentSource("minecraft:generic", 50, 49) == null, "clock rollback cannot preserve a future damage source"); passed++;
		check(PerceivedHarm.currentSource(new PerceivedHarm.Cues(false, false, false, false, false, false, false, false, false, false, null)) == null, "quiet player has no harm object"); passed++;
		check(PerceivedHarm.visibleHp(19.01F, 3.01F) == 24, "visible HP includes independently rounded absorption half hearts"); passed++;
		var history = new PerceivedHarm.History();
		history.sample(0, 24);
		history.sample(19, 20);
		check(history.rate(19, 20) == null, "rate waits for a full second of observed HUD span"); passed++;
		history.sample(20, 20);
		check(history.rate(20, 20) == 4.0D, "rate uses actual observed elapsed ticks and HP including absorption"); passed++;
		history.sample(30, 16);
		history.sample(40, 22);
		check(history.rate(40, 22) == 1.0D, "regeneration offsets losses: net window loss, not sum of every damage edge"); passed++;
		history.sample(60, 24);
		check(history.rate(60, 24) == 0.0D, "old loss expires and healing cannot report negative damage"); passed++;
		history.sample(101, 18);
		check(history.rate(101, 18) == null, "a sampling gap beyond the window resets unknown history"); passed++;
		history.sample(1, 10);
		check(history.rate(1, 10) == null, "time rollback clears prior-body rate evidence"); passed++;
		var large = new PerceivedHarm.History(); large.sample(0, 80); large.sample(20, 1);
		check(large.rate(20, 1) == 79.0D, "observed loss rate has no guessed mechanic or artificial cap"); passed++;
		var sparse = new PerceivedHarm.History(); sparse.sample(0, 20); sparse.sample(23, 16);
		check(sparse.rate(23, 16) == 3.5D, "rate rounds to a tenth over the actual sparse sample span"); passed++;
		var latch = new SurvivalPerception.Latch();
		var bread = new SurvivalPerception.Food(0, "minecraft:bread", 5, 6, false);
		SurvivalPerception.evaluate(10, 20, 10, bread, false, true, latch, 0);
		var newlyUnsafe = SurvivalPerception.evaluate(10, 20, 10, bread, true, false, latch, 1);
		check(!newlyUnsafe.signals().contains(SurvivalPerception.HEAL_OPPORTUNITY) && !newlyUnsafe.canHealNow(), "held healing signal cannot override a newly perceived harm"); passed++;
		return passed + verifyStarvation() + verifyMissingEntityData() + verifyFreezingOptions() + verifyEvaporatingWater();
	}
	public static int verifyStarvation() {
		int passed = 0;
		var starvation = new PerceivedHarm.Snapshot("minecraft:starve", true, 0.0D, null);
		var quiet = new ThreatPerception.Snapshot(List.of(), Set.of(), -1, null);
		var bread = new SurvivalPerception.Food(0, "minecraft:bread", 5, 6, false);
		for (Difficulty difficulty : List.of(Difficulty.EASY, Difficulty.NORMAL, Difficulty.HARD)) {
			// Easy can stop damaging at 10 HP; Normal can stop at 1 HP, and Hard continues there.
			double health = difficulty == Difficulty.EASY ? 10 : 1;
			boolean safe = SurvivalPerception.safe(starvation, quiet);
			var fed = SurvivalPerception.evaluate(health, 20, 0, bread, true, safe, new SurvivalPerception.Latch(), 0);
			check(fed.safe() && fed.canEat() && fed.canHealNow() && fed.signals().contains(SurvivalPerception.HEAL_OPPORTUNITY),
					"starvation with carried bread permits eating/healing at the " + difficulty + " damage floor"); passed++;
			var hungry = SurvivalPerception.evaluate(health, 20, 0, null, true, safe, new SurvivalPerception.Latch(), 0);
			check(hungry.signals().contains(SurvivalPerception.LOW_HEALTH_NO_FOOD) && !hungry.canHealNow(),
					"starvation without food stays threatened and urgent on " + difficulty); passed++;
		}
		var reproduced = SurvivalPerception.evaluate(9, 20, 0, bread, true, SurvivalPerception.safe(starvation, quiet), new SurvivalPerception.Latch(), 0);
		check(reproduced.canHealNow() && reproduced.signals().contains(SurvivalPerception.HEAL_OPPORTUNITY), "9 HP review reproduction raises a healing opportunity"); passed++;
		JsonObject facts = PerceivedHarm.toJson(starvation);
		check(facts.get("source").getAsString().equals("minecraft:starve") && facts.get("hpLossPerSecond").getAsDouble() == 0.0D
				&& facts.getAsJsonArray("options").get(0).getAsString().equals("food"), "permitting eating preserves visible starvation facts even at a zero-rate damage floor"); passed++;
		var nearby = new ThreatPerception.Entry("fixture", "minecraft:zombie", 5, 0, true, false, true, List.of(ThreatPerception.TARGETING));
		var threats = new ThreatPerception.Snapshot(List.of(nearby), Set.of(), -1, null);
		var unsafe = SurvivalPerception.evaluate(9, 20, 0, bread, true, SurvivalPerception.safe(starvation, threats), new SurvivalPerception.Latch(), 0);
		check(!unsafe.safe() && !unsafe.canHealNow() && !unsafe.signals().contains(SurvivalPerception.HEAL_OPPORTUNITY), "starvation exception cannot suppress a nearby targeting mob"); passed++;
		var fire = new PerceivedHarm.Snapshot("minecraft:on_fire", true, null, null);
		check(!SurvivalPerception.safe(fire, quiet), "non-starvation environmental harm continues to block a safe healing opportunity"); passed++;
		return passed;
	}

	public static int verifyMissingEntityData() {
		try {
			Field singleton = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
			singleton.setAccessible(true);
			var unsafe = (sun.misc.Unsafe) singleton.get(null);
			ServerPlayer player = (ServerPlayer) unsafe.allocateInstance(ServerPlayer.class);
			player.setId(1024); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			var harm = new PerceivedHarm();
			var id = new AgentId(UUID.randomUUID());
			check(player.getEntityData() == null && harm.sample(id, player) == null, "uninitialized contract player has no perceptible harm without entity data");
			check(harm.sample(id, player, null) == null, "contact sampling also tolerates absent entity data without fabricating a harm source");
			return 2;
		} catch (ReflectiveOperationException exception) {
			throw new AssertionError("missing-data fixture could not be allocated", exception);
		}
	}

	public static int verifyEvaporatingWater() {
		check(PerceivedHarm.options("minecraft:on_fire").contains("water_or_rain"), "water stays a fire remedy where vanilla keeps placed water");
		var nether = PerceivedHarm.toJson(new PerceivedHarm.Snapshot("minecraft:on_fire", true, 1.0, null, true));
		check(!nether.getAsJsonArray("options").toString().contains("water") && nether.get("waterEvaporates").getAsBoolean(),
				"where placed water evaporates, fire options omit water and say why");
		check(PerceivedHarm.options("minecraft:fall", true).equals(List.of("known_landing", "slow_falling")), "a water landing is not offered where water evaporates");
		check(!PerceivedHarm.toJson(new PerceivedHarm.Snapshot("minecraft:starve", true, 1.0, null, true)).has("waterEvaporates"), "unrelated harm omits the evaporation fact");
		return 4;
	}

	public static int verifyFreezingOptions() {
		check(PerceivedHarm.options("minecraft:freeze").equals(List.of("leave_powder_snow", "leather")), "freezing remedies describe vanilla powder-snow exposure and leather, without invented warmth mechanics");
		return 1;
	}

	private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
