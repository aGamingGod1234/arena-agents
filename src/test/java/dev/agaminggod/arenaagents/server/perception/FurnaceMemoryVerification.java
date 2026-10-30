package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonObject;
import java.util.UUID;
import net.minecraft.core.BlockPos;

public final class FurnaceMemoryVerification {
	private static final FurnaceMemory.Stack EMPTY = new FurnaceMemory.Stack("minecraft:air", 0);
	private static int checks;
	public static int verify() {
		checks = 0;
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		for (var item : java.util.List.of(net.minecraft.world.item.Items.COAL, net.minecraft.world.item.Items.CHARCOAL,
				net.minecraft.world.item.Items.BLAZE_ROD, net.minecraft.world.item.Items.LAVA_BUCKET, net.minecraft.world.item.Items.STICK)) {
			int burn = vanillaFuelTicks(item);
			check(burn > 0, "vanilla fuel table recognizes " + item);
			var sample = batch(64, 1, 0, burn);
			check(sample.readyCount() == Math.min(64, burn / 200), "partial batch uses vanilla burn duration for " + item);
			check(sample.partialReadyInMs() == null == (burn < 200), "short fuel cannot promise one finished item");
		}
		int coalTicks = vanillaFuelTicks(net.minecraft.world.item.Items.COAL);
		check(batch(8, 1, 0, coalTicks).readyInMs() == 80_000L, "eight items take eighty seconds");
		var halfCooked = new FurnaceMemory.Sample(new FurnaceMemory.Stack("minecraft:raw_iron", 8), EMPTY, EMPTY, 1550, 50, 200, 0);
		check(halfCooked.readyInMs() == 77_500L, "consumed fuel and current cooking progress count toward ready estimate");
		var memory = new FurnaceMemory(); UUID player = UUID.randomUUID(); BlockPos pos = new BlockPos(1, 64, -2);
		memory.remember(player, "minecraft:overworld", pos, batch(8, 1, 0, coalTicks), true, 1000);
		var absent = (FurnaceMemory.Source) (dimension, position) -> new FurnaceMemory.Probe(false, null);
		JsonObject before = observation(memory.sample(player, absent, 200_000));
		var row = before.getAsJsonArray("furnaces").get(0).getAsJsonObject();
		check(row.get("state").getAsString().equals("estimate"), "unloaded state is explicitly estimated");
		check(row.get("estimatedReadyAtEpochMs").getAsLong() == 81_000, "unloaded memory preserves the dated estimate");
		check(row.getAsJsonObject("input").get("count").getAsInt() == 8, "elapsed wall time does not invent cooked output");
		check(FurnaceMemory.readyFacts(before).isEmpty(), "an elapsed estimate cannot wake the agent");
		check(memory.sample(UUID.randomUUID(), absent, 200_000).isEmpty(), "another player gets no furnace knowledge");
		var ready = (FurnaceMemory.Source) (dimension, position) -> new FurnaceMemory.Probe(true, batch(0, 0, 8, 0));
		JsonObject after = observation(memory.sample(player, ready, 201_000));
		check(after.getAsJsonArray("furnaces").get(0).getAsJsonObject().get("message").getAsString().contains("8 minecraft:iron_ingot ready"), "completion tells the model count and location");
		check(AttentionSignalPolicy.changedFacts(before, after).stream().anyMatch(fact -> fact.equals("furnaces")), "confirmed completion requests attention");
		JsonObject again = observation(memory.sample(player, ready, 202_000));
		check(AttentionSignalPolicy.changedFacts(after, again).isEmpty(), "ready is one edge, not repeated heartbeat wakes");
		check(!AttentionSignalPolicy.changedFacts(before, again).isEmpty(), "a failed publication can retry the same completion");
		check(AttentionSignalPolicy.changedFacts(again, observation(memory.sample(player, absent, 203_000))).isEmpty(), "unloading after completion cannot invent a second completion");
		memory.remember(player, "minecraft:overworld", pos, batch(8, 1, 0, coalTicks), true, 204_000);
		JsonObject reloaded = observation(memory.sample(player, ready, 205_000));
		check(!FurnaceMemory.readyFacts(after).equals(FurnaceMemory.readyFacts(reloaded)), "another model-authored load gets a new completion identity");
		memory.remember(player, "minecraft:the_nether", pos, batch(8, 1, 0, coalTicks), true, 206_000);
		check(memory.sample(player, absent, 207_000).size() == 2, "dimensions keep separate furnace memories");
		var missing = memory.sample(player, (dimension, position) -> new FurnaceMemory.Probe(true, null), 208_000);
		check(missing.isEmpty(), "destroyed loaded furnaces are evicted immediately");
		for (int i = 0; i < 300; i++) memory.remember(player, "minecraft:overworld", new BlockPos(i, 64, 0), batch(8, 1, 0, coalTicks), true, i);
		int[] probes = {0};
		var bounded = memory.sample(player, (dimension, position) -> { probes[0]++; return absent.read(dimension, position); }, 1000);
		check(bounded.size() == 8 && probes[0] == 8, "300 used furnaces retain and probe only eight entries");
		check(bounded.get(0).getAsJsonObject().get("x").getAsInt() == 299, "most recently used furnace is sampled first");
		check(memory.sample(player, absent, 1_000_000).isEmpty(), "unloaded memories expire");
		memory.remember(player, "minecraft:overworld", pos, batch(0, 0, 0, 0), false, 0);
		check(memory.sample(player, (d, p) -> new FurnaceMemory.Probe(true, batch(0, 0, 0, 0)), FurnaceMemory.IDLE_TTL_MS).isEmpty(), "collected loaded memories expire");
		var partial = batch(9, 1, 0, coalTicks);
		check(partial.readyInMs() == null && partial.readyCount() == 8 && partial.partialReadyInMs() == 80_000, "insufficient fuel still estimates the eight items it can finish");
		var blockedBatch = batch(8, 1, 63, coalTicks);
		check(blockedBatch.readyCount() == 1 && blockedBatch.partialReadyInMs() == 10_000, "output capacity limits partial estimate without hiding the recipe");
		memory.remember(player, "minecraft:overworld", pos, partial, true, 0);
		var partialRow = memory.sample(player, absent, 1).get(0).getAsJsonObject();
		check(partialRow.get("estimatedReadyCount").getAsInt() == 8 && partialRow.get("estimate").getAsString().contains("out of fuel"), "wire row names partial count and limiting cause");
		var noFuel = (FurnaceMemory.Source) (d, p) -> new FurnaceMemory.Probe(true, batch(1, 0, 8, 0));
		var stalled = observation(memory.sample(player, noFuel, 2));
		check(stalled.getAsJsonArray("furnaces").get(0).getAsJsonObject().get("message").getAsString().contains("stalled: no fuel"), "confirmed fuel stall names cause");
		check(!FurnaceMemory.readyFacts(stalled).isEmpty(), "confirmed stall requests attention");
		check(AttentionSignalPolicy.changedFacts(stalled, observation(memory.sample(player, noFuel, 3))).isEmpty(), "unchanged stall does not repeat attention");
		var fullOutput = observation(memory.sample(player, (d, p) -> new FurnaceMemory.Probe(true, batch(1, 1, 64, coalTicks)), 4));
		check(!AttentionSignalPolicy.changedFacts(stalled, fullOutput).isEmpty(), "a different confirmed stall has a new identity");
		check(fullOutput.getAsJsonArray("furnaces").get(0).getAsJsonObject().get("message").getAsString().contains("output full"), "blocked output names its cause");
		var replacement = new FurnaceMemory();
		replacement.remember(player, "minecraft:overworld", pos, batch(8, 1, 0, coalTicks), true, 0);
		check(!FurnaceMemory.readyFacts(after).equals(FurnaceMemory.readyFacts(observation(replacement.sample(player, ready, 1)))), "new executor cannot reuse old event identities");
		return checks;
	}
	/** Vanilla burn ticks; 26.3 resolves them from datapack number providers, which a bootstrap-only check has not loaded. */
	private static int vanillaFuelTicks(net.minecraft.world.item.Item item) {
		if (item == net.minecraft.world.item.Items.COAL || item == net.minecraft.world.item.Items.CHARCOAL) return 1600;
		if (item == net.minecraft.world.item.Items.BLAZE_ROD) return 2400;
		if (item == net.minecraft.world.item.Items.LAVA_BUCKET) return 20000;
		if (item == net.minecraft.world.item.Items.STICK) return 100;
		return 0;
	}

	private static FurnaceMemory.Sample batch(int input, int fuel, int output, int fuelTicks) {
		return new FurnaceMemory.Sample(new FurnaceMemory.Stack("minecraft:raw_iron", input), new FurnaceMemory.Stack("minecraft:coal", fuel),
				new FurnaceMemory.Stack("minecraft:iron_ingot", output), 0, 0, 200, fuelTicks);
	}
	private static JsonObject observation(com.google.gson.JsonArray rows) { var result = new JsonObject(); result.add("furnaces", rows); return result; }
	private static void check(boolean valid, String message) { checks++; if (!valid) throw new AssertionError(message); }
}
