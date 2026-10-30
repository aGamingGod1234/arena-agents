package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.server.runtime.controller.SwimPlanning;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LiquidBlock;

public final class WaterAirFactsVerification {
	private WaterAirFactsVerification() { }
	public static int verify() {
		SwimPlanning.ColumnView lake = (x, y, z) -> y >= 64 ? SwimPlanning.Cell.OPEN : SwimPlanning.Cell.WATER;
		JsonObject facts = facts(lake, 60, 220, -0.04);
		check(facts.get("airSecondsLeft").getAsDouble() == 11, "220 ticks give 11 seconds");
		check(facts.get("waterMotion").getAsString().equals("sinking"), "downward velocity reports sinking");
		check(facts.get("waterAbove").getAsString().equals("open_water"), "unblocked surface above");
		JsonObject target = facts.getAsJsonObject("breathable");
		check(target.get("y").getAsDouble() == 63.75 && target.get("x").getAsDouble() == 0.5, "target is a feet position with eyes in air");
		check(target.get("distance").getAsInt() == 4 && target.get("seconds").getAsDouble() == 2, "four swim cells take an estimated two seconds");
		check(target.get("direction").getAsString().equals("up"), "open surface is above");
		check(WaterAirFacts.urgent(facts), "eleven seconds leave less than fifteen seconds to decide after the swim");
		check(facts(lake, 60, -20, 0).get("airSecondsLeft").getAsDouble() == 0, "negative drowning ticks clamp at zero");
		SwimPlanning.ColumnView overhang = (x, y, z) -> y >= 65 ? SwimPlanning.Cell.OPEN
				: y == 64 ? x < 2 ? SwimPlanning.Cell.SOLID : SwimPlanning.Cell.OPEN : SwimPlanning.Cell.WATER;
		facts = facts(overhang, 60, 160, 0.04);
		check(facts.get("waterAbove").getAsString().equals("blocked"), "ceiling blocks this column");
		check(facts.get("waterMotion").getAsString().equals("rising"), "positive velocity reports rising");
		target = facts.getAsJsonObject("breathable");
		check(target.get("x").getAsDouble() == 2.5 && target.get("distance").getAsInt() == 6, "reachable opening goes around the overhang");
		check(!WaterAirFacts.urgent(facts(overhang, 60, 360, 0)), "at the exact travel time plus fifteen seconds there is room");
		check(WaterAirFacts.urgent(facts(overhang, 60, 359, 0)), "warning edge uses travel time plus fifteen seconds");
		SwimPlanning.ColumnView sealed = (x, y, z) -> y >= 62 ? SwimPlanning.Cell.SOLID : SwimPlanning.Cell.WATER;
		check(facts(sealed, 60, 120, 0).get("breathable").isJsonNull(), "sealed cave reports no breathable target");
		SwimPlanning.ColumnView pocket = (x, y, z) -> x == 1 && z == 0 && y >= 60 && y <= 61 ? SwimPlanning.Cell.OPEN
				: y >= 61 ? SwimPlanning.Cell.SOLID : SwimPlanning.Cell.WATER;
		target = facts(pocket, 60, 90, 0).getAsJsonObject("breathable");
		check(target.get("x").getAsDouble() == 1.5 && target.get("y").getAsDouble() == 59.75
				&& target.get("direction").getAsString().equals("east"), "adjacent air pocket is breathable without rising");
		SwimPlanning.ColumnView wall = (x, y, z) -> x == 0 && z == 0 && y <= 60 ? SwimPlanning.Cell.WATER
				: x == 2 && y >= 60 ? SwimPlanning.Cell.OPEN : SwimPlanning.Cell.SOLID;
		check(SwimPlanning.nearestSurface(wall, 0, 60, 0) == null, "nearby air behind a wall is unreachable");
		SwimPlanning.ColumnView floor = (x, y, z) -> y < 60 ? SwimPlanning.Cell.OPEN : y == 60 ? SwimPlanning.Cell.WATER : SwimPlanning.Cell.SOLID;
		check(SwimPlanning.nearestSurface(floor, 0, 60, 0) == null, "downward footing is never an air exit");
		SwimPlanning.ColumnView unknown = (x, y, z) -> y <= 60 ? SwimPlanning.Cell.WATER : SwimPlanning.Cell.UNKNOWN;
		check(facts(unknown, 60, 220, 0).get("waterAbove").getAsString().equals("unknown")
				&& SwimPlanning.nearestSurface(unknown, 0, 60, 0) == null, "unseen geometry never becomes a surface");
		SwimPlanning.ColumnView noHeadroom = (x, y, z) -> y == 61 ? SwimPlanning.Cell.OPEN : y > 61 ? SwimPlanning.Cell.SOLID : SwimPlanning.Cell.WATER;
		check(SwimPlanning.nearestSurface(noHeadroom, 0, 60, 0).breathOnly(), "one-high pocket lets the eyes breathe without standing headroom");
		check(facts(noHeadroom, 60, 220, 0).getAsJsonObject("breathable").get("kind").getAsString().equals("breath_only"),
				"low pockets are labelled breath only");
		var flowing = Blocks.WATER.defaultBlockState().setValue(LiquidBlock.LEVEL, 5);
		SwimPlanning.ColumnView flow = (x, y, z) -> WaterAirFacts.cell(y >= 64 ? Blocks.AIR.defaultBlockState() : flowing, false);
		check(facts(flow, 60, 220, -0.1).get("breathable").equals(facts(lake, 60, 220, -0.1).get("breathable")),
				"real flowing water searches to the same surface as source water");
		JsonObject before = new JsonObject(); before.addProperty("ready", true);
		before.add("player", facts(lake, 52, 300, 0)); before.getAsJsonObject("player").addProperty("underWater", false);
		JsonObject after = before.deepCopy(); after.add("player", facts(lake, 52, 219, -0.04));
		check(AttentionSignalPolicy.changedFacts(before, after).contains("player.air"), "deep water warns above half-air before travel margin runs out");
		check(!AttentionSignalPolicy.changedFacts(after, after).contains("player.air"), "unchanged danger does not repeatedly wake");
		JsonObject late = after.deepCopy(); late.add("player", facts(lake, 52, 60, 0));
		check(AttentionSignalPolicy.changedFacts(after, late).contains("player.air"), "three-second edge re-alerts after the earlier drowning warning");
		check(!AttentionSignalPolicy.changedFacts(late, late).contains("player.air"), "critical warning is not spammed on unchanged frames");
		var dragDown = Blocks.BUBBLE_COLUMN.defaultBlockState().setValue(net.minecraft.world.level.block.BubbleColumnBlock.DRAG_DOWN, true);
		var dragUp = dragDown.setValue(net.minecraft.world.level.block.BubbleColumnBlock.DRAG_DOWN, false);
		check(WaterAirFacts.cell(dragDown, false) == SwimPlanning.Cell.SINKING_WATER, "magma column is sinking water");
		check(WaterAirFacts.cell(dragUp, false) == SwimPlanning.Cell.RISING_WATER, "soul sand column is a rising aid");
		SwimPlanning.ColumnView magma = (x, y, z) -> x != 0 || z != 0 ? SwimPlanning.Cell.SOLID
				: y >= 64 ? SwimPlanning.Cell.OPEN : WaterAirFacts.cell(dragDown, false);
		check(SwimPlanning.nearestSurface(magma, 0, 60, 0) == null, "magma column is never a breathable route");
		check(facts(magma, 60, 200, 0.1).get("waterMotion").getAsString().equals("sinking"), "magma drag reports sinking even before velocity catches up");
		SwimPlanning.ColumnView soul = (x, y, z) -> x != 0 || z != 0 ? SwimPlanning.Cell.SOLID
				: y >= 64 ? SwimPlanning.Cell.OPEN : WaterAirFacts.cell(dragUp, false);
		check(SwimPlanning.nearestSurface(soul, 0, 60, 0).distance() == 4, "rising column leads to breathable air");
		check(facts(soul, 60, 200, -0.1).get("waterMotion").getAsString().equals("rising"), "soul sand reports rising aid");
		return 33 + verifySearchBudget();
	}

	private static int verifySearchBudget() {
		int[] reads = {0};
		SwimPlanning.ColumnView deep = (x, y, z) -> { reads[0]++; return y >= 84 ? SwimPlanning.Cell.OPEN : SwimPlanning.Cell.WATER; };
		var cache = new WaterAirFacts.SurfaceCache();
		var cell = new net.minecraft.core.BlockPos(0, 60, 0);
		Object world = new Object();
		var lookup = cache.lookup(deep, cell, 300, 0, world);
		check(lookup.searching() && reads[0] <= SwimPlanning.SURFACE_CELLS_PER_TICK * 2 + 1, "deep search has a fixed per-tick terrain-read bound");
		int previous = reads[0];
		cache.lookup(deep, cell, 300, 0, world);
		check(reads[0] == previous, "observation and navigation reuse the same tick slice");
		int ticks = 0;
		while (lookup.searching()) {
			previous = reads[0];
			lookup = cache.lookup(deep, cell, 300 - ++ticks, ticks, world);
			check(reads[0] - previous <= SwimPlanning.SURFACE_CELLS_PER_TICK * 2 + 1, "resumed slices retain the same bound");
			check(ticks < 30, "visited cells survive air-second boundaries without restarting");
		}
		check(lookup.surface() != null && lookup.surface().distance() == 24, "bounded slices eventually find a deep surface");
		previous = reads[0];
		cache.lookup(deep, cell, 300 - ticks, ticks + 1, world);
		check(reads[0] == previous, "completed result is cached within its cell and air second");
		cache.lookup(deep, cell, 200, ticks + 2, world);
		check(reads[0] > previous, "another air second refreshes acquired geometry");
		previous = reads[0];
		cache.lookup(deep, cell.east(), 200, ticks + 2, world);
		check(reads[0] == previous, "changing cells never grants a second search budget in the same tick");
		cache.lookup(deep, cell.east(), 200, ticks + 3, world);
		check(reads[0] > previous, "new eye cell resumes on the next tick");
		return 7 + ticks * 2;
	}

	private static JsonObject facts(SwimPlanning.ColumnView view, int eyeY, int air, double velocityY) {
		JsonObject player = new JsonObject(); player.addProperty("underWater", true); player.addProperty("air", air);
		WaterAirFacts.add(player, view, 0, eyeY, 0, air, velocityY, true); return player;
	}
	private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
