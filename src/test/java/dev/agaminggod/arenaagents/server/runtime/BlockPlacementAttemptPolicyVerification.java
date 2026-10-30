package dev.agaminggod.arenaagents.server.runtime;

import java.util.Set;
import net.minecraft.core.Direction;

public final class BlockPlacementAttemptPolicyVerification {
	private BlockPlacementAttemptPolicyVerification() {
	}

	/** Placement outcome rules and the supports clicked with secondary use. */
	private static void verifyVanillaClickableSupports() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		var level = net.minecraft.world.level.EmptyBlockGetter.INSTANCE;
		var origin = net.minecraft.core.BlockPos.ZERO;
		// Which supports a click places against depends on the held item; PlacementPerceptionAgreementVerification
		// checks placement and the observed placeable faces against each other for snow, grass, slabs, fences and tables.
		var air = net.minecraft.world.level.block.Blocks.AIR.defaultBlockState();
		var stone = net.minecraft.world.level.block.Blocks.COBBLESTONE.defaultBlockState();
		var dirt = net.minecraft.world.level.block.Blocks.DIRT.defaultBlockState();
		var wanted = new DesiredBlockState("minecraft:cobblestone", java.util.Map.of());
		assertTrue(ServerActionExecutor.placedByClick(true, air, stone, wanted),
				"a consumed click that turned air into the requested block is this action's placement, whatever pickups happen");
		assertFalse(ServerActionExecutor.placedByClick(false, air, stone, wanted), "an unconsumed click placed nothing");
		assertFalse(ServerActionExecutor.placedByClick(true, stone, stone, wanted), "an unchanged destination is not this click's placement");
		assertFalse(ServerActionExecutor.placedByClick(true, air, dirt, wanted), "a different resulting block is not the requested placement");
		for (var block : new net.minecraft.world.level.block.Block[] {net.minecraft.world.level.block.Blocks.CHEST,
				net.minecraft.world.level.block.Blocks.OAK_DOOR, net.minecraft.world.level.block.Blocks.LEVER,
				net.minecraft.world.level.block.Blocks.CRAFTING_TABLE, net.minecraft.world.level.block.Blocks.FURNACE}) {
			assertTrue(ServerActionExecutor.interactiveSupport(block.defaultBlockState()),
					block + " is sneak-clicked to place against it, so the click does not open or toggle it");
		}
		assertFalse(ServerActionExecutor.interactiveSupport(net.minecraft.world.level.block.Blocks.STONE.defaultBlockState()),
				"plain blocks are clicked normally");
		var slab = net.minecraft.world.level.block.Blocks.OAK_SLAB.defaultBlockState();
		assertFalse(slab.isFaceSturdy(level, origin, Direction.UP),
				"control: a bottom slab top is not sturdy, which the old guard wrongly required");
	}

	public static int verify() {
		verifyVanillaClickableSupports();
		assertTrue(BlockPlacementAttemptPolicy.shouldAttempt(0L, 0), "first click is immediate");
		assertFalse(BlockPlacementAttemptPolicy.shouldAttempt(249L, 1), "retry waits for its interval");
		assertTrue(BlockPlacementAttemptPolicy.shouldAttempt(250L, 1), "retry starts at its interval");
		assertFalse(BlockPlacementAttemptPolicy.shouldAttempt(10_000L, 8), "retry count is bounded");
		assertFalse(BlockPlacementAttemptPolicy.isExhausted(7), "seventh attempt still permits one final click");
		assertTrue(BlockPlacementAttemptPolicy.isExhausted(8), "eighth attempt exhausts the click budget");
		assertEquals(Direction.NORTH, BlockPlacementAttemptPolicy.chooseFace(
				Direction.NORTH, Set.of(Direction.NORTH, Direction.UP)::contains),
				"requested usable face is retained");
		assertEquals(null, BlockPlacementAttemptPolicy.chooseFace(
				Direction.NORTH, Set.of(Direction.UP, Direction.SOUTH)::contains),
				"unusable requested face is rejected instead of substituted");
		assertEquals(null, BlockPlacementAttemptPolicy.chooseFace(Direction.NORTH, direction -> false),
				"missing support is reported explicitly");
		assertEquals(
				java.util.List.of(Direction.UP, Direction.NORTH),
				BlockPlacementAttemptPolicy.supportedFaces(Set.of(Direction.NORTH, Direction.UP)::contains),
				"supported placement faces use a stable model-facing order"
		);
		assertEquals(java.util.List.of(), BlockPlacementAttemptPolicy.supportedFaces(direction -> false),
				"unsupported blocks expose no placeable faces");
		assertEquals(3, BlockPlacementAttemptPolicy.countedAttempts(3, 0), "temporary refusals keep the whole retry budget");
		assertEquals(3, BlockPlacementAttemptPolicy.countedAttempts(3, 1), "one final refusal still earns a repeat");
		assertEquals(8, BlockPlacementAttemptPolicy.countedAttempts(2, BlockPlacementAttemptPolicy.FINAL_REFUSAL_LIMIT),
				"repeated final refusals spend the budget");
		assertTrue(BlockPlacementAttemptPolicy.isExhausted(BlockPlacementAttemptPolicy.countedAttempts(2, 2)),
				"two final refusals end the placement after 2 clicks, not 8");
		assertFalse(BlockPlacementAttemptPolicy.shouldAttempt(10_000L, BlockPlacementAttemptPolicy.countedAttempts(2, 2)),
				"no click is issued once refusals are final");
		assertTrue(BlockPlacementAttemptPolicy.shouldAttempt(250L, BlockPlacementAttemptPolicy.countedAttempts(1, 1)),
				"the repeat after a first final refusal is still sent");
		long failMs = (BlockPlacementAttemptPolicy.FINAL_REFUSAL_LIMIT - 1) * BlockPlacementAttemptPolicy.RETRY_INTERVAL_MS;
		assertEquals(250L, failMs, "a final refusal now fails 250 ms after the first click (was 1750 ms)");
		return 17;
	}

	private static void assertEquals(Object expected, Object actual, String label) {
		if (!java.util.Objects.equals(expected, actual)) {
			throw new AssertionError(label + ": expected <" + expected + "> but was <" + actual + ">");
		}
	}

	private static void assertTrue(boolean value, String label) {
		if (!value) throw new AssertionError(label);
	}

	private static void assertFalse(boolean value, String label) {
		if (value) throw new AssertionError(label);
	}
}
