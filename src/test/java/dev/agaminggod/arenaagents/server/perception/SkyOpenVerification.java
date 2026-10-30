package dev.agaminggod.arenaagents.server.perception;

import java.util.HashMap;
import java.util.Map;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

/** Verifies the sky-above fact for roofs, leaves, glass, water and cave mouths. */
public final class SkyOpenVerification {
	private SkyOpenVerification() {
	}

	/** MOTION_BLOCKING_NO_LEAVES as 26.1 coded it; 26.3 reads the same rule from block tags. */
	private static final java.util.function.Predicate<net.minecraft.world.level.block.state.BlockState> COVER = state ->
			(ServerObservationCollector.blocksMotion(state) || !state.getFluidState().isEmpty())
					&& !(state.getBlock() instanceof net.minecraft.world.level.block.LeavesBlock);

	public static int verify() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		int passed = 0;
		// The heightmap the collector reads: leaves never raise it, glass and water do. 26.3 builds it from the
		// blocks_motion tags (unbound in this bootstrap-only check), so the 26.1 rule it encodes is checked directly.
		assertEquals(false, COVER.test(Blocks.OAK_LEAVES.defaultBlockState()), "leaves are not cover in the heightmap"); passed++;
		assertEquals(true, COVER.test(Blocks.GLASS.defaultBlockState()), "glass is cover in the heightmap"); passed++;
		assertEquals(true, COVER.test(Blocks.WATER.defaultBlockState()), "water raises the heightmap"); passed++;

		// Head at y=65 on open grass: the heightmap top is the free block above the ground.
		assertEquals(true, open(65, Map.of(63, Blocks.GRASS_BLOCK.defaultBlockState())), "open field"); passed++;
		// A plank roof two blocks over the head.
		assertEquals(false, open(65, Map.of(63, Blocks.GRASS_BLOCK.defaultBlockState(), 67, Blocks.OAK_PLANKS.defaultBlockState())), "house roof"); passed++;
		// A glass roof is still a roof.
		assertEquals(false, open(65, Map.of(67, Blocks.GLASS.defaultBlockState())), "glass roof"); passed++;
		// Under a tree canopy the heightmap ignores the leaves, so the column reads open.
		assertEquals(true, open(65, Map.of(63, Blocks.GRASS_BLOCK.defaultBlockState(), 68, Blocks.OAK_LEAVES.defaultBlockState(), 69, Blocks.OAK_LEAVES.defaultBlockState())), "tree canopy"); passed++;
		// Swimming or standing on a lake bed: the water column above is looked through.
		assertEquals(true, open(60, Map.of(59, Blocks.SAND.defaultBlockState(), 60, Blocks.WATER.defaultBlockState(), 61, Blocks.WATER.defaultBlockState(), 62, Blocks.WATER.defaultBlockState())), "under water"); passed++;
		// An underwater cave: rock between the head and the sea.
		assertEquals(false, open(50, Map.of(55, Blocks.STONE.defaultBlockState(), 56, Blocks.WATER.defaultBlockState(), 57, Blocks.WATER.defaultBlockState())), "underwater cave"); passed++;
		// A cave mouth: just inside, an overhang covers the head although sky light reaches it from the side.
		assertEquals(false, open(65, Map.of(63, Blocks.STONE.defaultBlockState(), 66, Blocks.STONE.defaultBlockState(), 67, Blocks.STONE.defaultBlockState())), "inside a cave mouth"); passed++;
		// One step out of it, the column above the head is clear.
		assertEquals(true, open(65, Map.of(63, Blocks.STONE.defaultBlockState())), "outside a cave mouth"); passed++;
		// A head inside a solid block (suffocating) is covered.
		assertEquals(false, open(65, Map.of(65, Blocks.STONE.defaultBlockState())), "head in a block"); passed++;
		return passed;
	}

	/** Builds the column's heightmap top as the game does, then asks the collector's rule. */
	private static boolean open(int headY, Map<Integer, BlockState> blocks) {
		Map<Integer, BlockState> column = new HashMap<>(blocks);
		int coverTop = Integer.MIN_VALUE;
		for (Map.Entry<Integer, BlockState> entry : column.entrySet()) {
			if (COVER.test(entry.getValue())) coverTop = Math.max(coverTop, entry.getKey() + 1);
		}
		if (coverTop == Integer.MIN_VALUE) coverTop = -64;
		return ServerObservationCollector.skyOpen(headY, coverTop, y -> column.getOrDefault(y, Blocks.AIR.defaultBlockState()));
	}

	public static void main(String[] args) {
		System.out.println("PASS: " + verify() + " sky above assertions");
	}

	private static void assertEquals(Object expected, Object actual, String label) {
		if (!expected.equals(actual)) {
			throw new AssertionError(label + ": expected <" + expected + "> but was <" + actual + ">");
		}
	}
}
