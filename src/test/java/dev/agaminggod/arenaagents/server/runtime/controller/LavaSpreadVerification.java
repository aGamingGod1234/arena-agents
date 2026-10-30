package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.PathNode;
import dev.agaminggod.arenaagents.client.navigation.TraversalType;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import dev.agaminggod.arenaagents.server.perception.LavaSpread;
import dev.agaminggod.arenaagents.server.runtime.reflex.ReflexSpec;
import it.unimi.dsi.fastutil.longs.LongArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.state.BlockState;

/**
 * d22-nether2 and d22-lava2: Nether lava reached an idle or just-arrived body within 1-2 s of coming into view. The spread
 * prediction must place a flow where vanilla sends it (down first, then sideways losing the drop-off), name when and from
 * where, and stop at unknown cells; navigation must refuse a route into the cell a flow fills next, and a flow's settled
 * edge must not count as a flow coming at a cell.
 */
public final class LavaSpreadVerification {
	private static int assertions;
	private static final BlockState AIR = Blocks.AIR.defaultBlockState();
	private static final BlockState RACK = Blocks.NETHERRACK.defaultBlockState();
	private static final BlockState SOURCE = Blocks.LAVA.defaultBlockState();

	private LavaSpreadVerification() {
	}

	public static int verify() {
		assertions = 0;
		verifyTunnelFlow();
		verifySlopeFallIntoPit();
		verifySlopePreference();
		verifyUnknownHoldsFlow();
		verifySettledEdge();
		verifyRouteRefusal();
		verifyFlowCondition();
		return assertions;
	}

	private static BlockState flowing(int level) {
		return Blocks.LAVA.defaultBlockState().setValue(LiquidBlock.LEVEL, level);
	}

	/** Solid netherrack except the cells set; unknown (null) where {@code unknown} says. */
	private static final class World {
		final Map<Long, BlockState> blocks = new HashMap<>();
		java.util.function.Predicate<BlockPos> unknown = pos -> false;

		void set(int x, int y, int z, BlockState state) {
			blocks.put(BlockPos.asLong(x, y, z), state);
		}

		BlockState at(int x, int y, int z) {
			if (unknown.test(new BlockPos(x, y, z))) return null;
			return blocks.getOrDefault(BlockPos.asLong(x, y, z), RACK);
		}

		LavaSpread.Prediction predict(int dropOff, double stepSeconds, int maxSteps, BlockPos... seeds) {
			LongArrayList keys = new LongArrayList();
			for (BlockPos seed : seeds) keys.add(seed.asLong());
			return LavaSpread.predict(this::at, keys, dropOff, dropOff == 1 ? 4 : 2, stepSeconds, maxSteps);
		}
	}

	/** d22-nether2: a 1x2 tunnel dug north into a hidden lava source; the flow runs down the tunnel a cell per 0.5 s. */
	private static void verifyTunnelFlow() {
		World world = new World();
		for (int z = 1; z <= 10; z++) {
			world.set(0, 69, z, AIR);
			world.set(0, 70, z, AIR);
		}
		world.set(0, 69, 0, SOURCE);
		LavaSpread.Prediction nether = world.predict(1, 0.5D, 12, new BlockPos(0, 69, 0));
		check(nether.secondsUntil(0, 69, 1) == 0.5D, "the opened cell beside the source fills after one Nether delay");
		check(nether.secondsUntil(0, 69, 2) == 1.0D, "the next tunnel cell fills a delay later");
		check(nether.secondsUntil(0, 69, 7) == 3.5D, "Nether lava runs seven cells along a floor");
		check(nether.secondsUntil(0, 69, 8) == Double.POSITIVE_INFINITY, "the eighth cell is past the flow's reach");
		check(nether.secondsUntil(0, 70, 3) == Double.POSITIVE_INFINITY, "lava does not rise into the head cells");
		LavaSpread.Arrival body = nether.standing(0, 69, 2);
		check(body != null && body.seconds() == 1.0D && body.from().equals(new BlockPos(0, 69, 0)) && body.via().equals(new BlockPos(0, 69, 1)),
				"a body two cells down the tunnel hears when, from which lava, and through which cell: " + body);
		check(body.describe().equals("lava from 0,69,0 reaches 0,69,2 in about 1.0 s"), body.describe());
		LavaSpread.Prediction overworld = world.predict(2, 1.5D, 4, new BlockPos(0, 69, 0));
		check(overworld.secondsUntil(0, 69, 1) == 1.5D && overworld.secondsUntil(0, 69, 3) == 4.5D,
				"Overworld lava spreads every 1.5 s");
		check(overworld.secondsUntil(0, 69, 4) == Double.POSITIVE_INFINITY, "Overworld lava runs three cells along a floor");
	}

	/**
	 * d22-lava2: a lava fall on a Nether slope ran down onto the body, and the pit beside it that leave_lava jumped into
	 * was where the flow went next. Falling lava goes down first; landed, it spreads sideways, and drops into any pit.
	 */
	private static void verifySlopeFallIntoPit() {
		World world = new World();
		// Open air over a floor at y 63 for x 0..4; a pit at x 3 down to y 60; falling lava at 0,66,0 over open 0,65..64,0.
		for (int x = 0; x <= 4; x++) for (int y = 64; y <= 67; y++) world.set(x, y, 0, AIR);
		for (int y = 60; y <= 63; y++) world.set(3, y, 0, AIR);
		world.set(0, 66, 0, flowing(8));
		LavaSpread.Prediction flow = world.predict(1, 0.5D, 12, new BlockPos(0, 66, 0));
		check(flow.secondsUntil(0, 65, 0) == 0.5D && flow.secondsUntil(0, 64, 0) == 1.0D, "falling lava drops a cell per delay");
		check(flow.secondsUntil(1, 65, 0) == Double.POSITIVE_INFINITY, "falling lava over open air does not spread sideways");
		check(flow.secondsUntil(1, 64, 0) == 1.5D, "landed, it spreads along the floor");
		check(flow.secondsUntil(3, 64, 0) == 2.5D && flow.secondsUntil(3, 60, 0) == 4.5D, "and falls into a pit beside it");
		check(flow.standing(3, 60, 0) != null, "a pit beside a flow is no way out of it");
		check(flow.standing(4, 64, 0) == null || flow.standing(4, 64, 0).seconds() >= 3.0D, "past the pit the flow arrives late or not at all");
	}

	/** d22-lava2's lingering fact: settled lava beside an open cell spreads only toward the nearest drop, as vanilla does. */
	private static void verifySlopePreference() {
		World world = new World();
		// A floor at y 63 with open cells x -3..3 at y 64; a hole at 2,63,0. A source at 0,64,0 spreads toward the hole only.
		for (int x = -3; x <= 3; x++) world.set(x, 64, 0, AIR);
		world.set(2, 63, 0, AIR);
		world.set(0, 64, 0, SOURCE);
		LavaSpread.Prediction flow = world.predict(1, 0.5D, 12, new BlockPos(0, 64, 0));
		check(flow.secondsUntil(1, 64, 0) == 0.5D, "the side toward the nearest drop is taken");
		check(flow.secondsUntil(-1, 64, 0) == Double.POSITIVE_INFINITY, "the side away from it is not");
		check(flow.secondsUntil(2, 63, 0) == 1.5D, "and the flow pours into the drop");
		LongArrayList seed = new LongArrayList();
		seed.add(new BlockPos(0, 64, 0).asLong());
		LavaSpread.Prediction wide = LavaSpread.predict(world::at, seed, 1, 0, 0.5D, 12);
		check(wide.secondsUntil(-1, 64, 0) == 0.5D, "the wider reach for exits counts every open side: the flow turns once the drop fills");
	}

	private static void verifyUnknownHoldsFlow() {
		World world = new World();
		for (int z = 1; z <= 6; z++) world.set(0, 64, z, AIR);
		world.set(0, 64, 0, SOURCE);
		world.unknown = pos -> pos.getZ() >= 3;
		LavaSpread.Prediction flow = world.predict(1, 0.5D, 12, new BlockPos(0, 64, 0));
		check(flow.secondsUntil(0, 64, 2) == 1.0D, "known open cells are predicted");
		check(flow.secondsUntil(0, 64, 3) == Double.POSITIVE_INFINITY, "an unknown cell holds the flow: only what the player knows is predicted");
		World none = new World();
		check(none.predict(1, 0.5D, 12, new BlockPos(5, 5, 5)).isEmpty(), "a seed that is not known lava predicts nothing");
	}

	/** A flow's last level (amount 1) spreads nowhere, and flowing lava over an open cell falls instead of spreading. */
	private static void verifySettledEdge() {
		Map<Long, BlockState> blocks = new HashMap<>();
		MinecraftNavigationWorld.StateRead read = (x, y, z) -> blocks.getOrDefault(BlockPos.asLong(x, y, z), y < 64 ? RACK : AIR);
		blocks.put(BlockPos.asLong(1, 64, 0), flowing(7));
		check(!MinecraftNavigationWorld.lavaFills(read, 0, 64, 0), "the last level of a flow beside the cell does not flow into it");
		blocks.put(BlockPos.asLong(1, 64, 0), flowing(2));
		check(MinecraftNavigationWorld.lavaFills(read, 0, 64, 0), "a flow with lava to spare beside the cell flows into it");
		blocks.put(BlockPos.asLong(1, 63, 0), AIR);
		check(!MinecraftNavigationWorld.lavaFills(read, 0, 64, 0), "flowing lava over an open cell falls rather than spreading sideways");
		blocks.put(BlockPos.asLong(1, 64, 0), SOURCE);
		check(!MinecraftNavigationWorld.lavaFills(read, 0, 64, 0), "a source over an open cell falls into it, as vanilla lava does");
		blocks.put(BlockPos.asLong(1, 63, 0), RACK);
		check(MinecraftNavigationWorld.lavaFills(read, 0, 64, 0), "a source on a floor spreads beside it");
		blocks.clear();
		blocks.put(BlockPos.asLong(1, 65, 0), SOURCE);
		check(MinecraftNavigationWorld.lavaFills(read, 0, 64, 0), "lava at head height beside a floored cell lands beside the feet and flows in");
		blocks.put(BlockPos.asLong(1, 63, 0), AIR);
		check(!MinecraftNavigationWorld.lavaFills(read, 0, 64, 0), "a lava fall beside the cell with no floor under it falls away");
		check(MinecraftNavigationWorld.lavaContact(read, 0, 64, 0), "routes still cost the wider contact: any lava beside the feet or head");
	}

	/** Flat floor; lava cells flow into the cells beside their feet or head (lavaFillsNext defaults to this). */
	private static final class Floor implements WalkabilityView {
		final java.util.Set<GridPosition> lava = new java.util.HashSet<>();

		@Override
		public Cell cellAt(GridPosition p) {
			if (lava.contains(p)) return Cell.HAZARD;
			if (p.y() == 63) return Cell.SAFE_SUPPORT;
			return p.y() >= 64 ? Cell.CLEAR : Cell.BLOCKED;
		}

		@Override
		public boolean lavaFlowsInto(GridPosition p) {
			if (lava.contains(p)) return true;
			for (int[] d : new int[][] {{1, 0}, {-1, 0}, {0, 1}, {0, -1}}) if (lava.contains(p.offset(d[0], 0, d[1]))) return true;
			return false;
		}
	}

	/** d22-nether2: the one-cell move into the tunnel cell beside freshly opened lava is refused before moving. */
	private static void verifyRouteRefusal() {
		Floor world = new Floor();
		List<PathNode> route = List.of(new PathNode(new GridPosition(0, 64, 2), TraversalType.WALK), new PathNode(new GridPosition(0, 64, 1), TraversalType.WALK));
		check(ServerNavigationController.lavaFlowEntry(world, route) == null, "a route clear of lava is accepted");
		world.lava.add(new GridPosition(0, 64, 0));
		check(new GridPosition(0, 64, 1).equals(ServerNavigationController.lavaFlowEntry(world, route)),
				"a route entering the cell beside lava names that cell");
		List<PathNode> out = List.of(new PathNode(new GridPosition(0, 64, 1), TraversalType.WALK), new PathNode(new GridPosition(0, 64, 2), TraversalType.WALK),
				new PathNode(new GridPosition(0, 64, 3), TraversalType.WALK));
		check(ServerNavigationController.lavaFlowEntry(world, out) == null, "a body already in the flow's way may walk out through such cells");
	}

	private static void verifyFlowCondition() {
		check(ReflexSpec.conditionTypes().contains("lava_flowing"), "lava_flowing is a reflex condition");
		check(dev.agaminggod.arenaagents.server.watch.Diagnosis.primitiveExists("lava", java.util.Set.of("lava_flowing")),
				"lava_flowing alone counts as a condition covering a lava episode");
	}

	private static void check(boolean passed, String label) {
		assertions++;
		if (!passed) throw new AssertionError(label);
	}
}
