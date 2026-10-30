package dev.agaminggod.arenaagents.server.runtime;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

/**
 * d41 review 3: cast_obsidian judges the frame and standing spots from what the body has seen (F4: a wall-hidden frame
 * cell is unknown, never read live), and barter_until reports only piglin anger a player sees (F5).
 */
public final class PerceptionGateVerification {
	private static int assertions;

	private PerceptionGateVerification() {
	}

	public static void main(String[] args) {
		System.out.println("PerceptionGateVerification: " + verify() + " assertions passed");
	}

	public static int verify() {
		assertions = 0;
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		verifyHiddenFrameCell();
		verifyStandingSpotsFromSeenTerrain();
		verifyHiddenCellBaseline();
		verifyRememberedWaterNowLavaBehindWall();
		verifySeenLavaPoolStillWorks();
		verifyPiglinAnger();
		return assertions;
	}

	private static void verifyHiddenFrameCell() {
		ServerCastObsidianController cast = new ServerCastObsidianController(new BlockPos(0, 64, 0), "x", true, 1, 60_000L, 0L, (p, at) -> true);
		List<BlockPos> cells = cast.frameCells();
		check(cells.size() == 10, "ten frame cells");
		// The live world: nine cells cast, one (the right column's middle) holds netherrack behind a wall.
		BlockPos hidden = cells.get(5);
		Map<BlockPos, BlockState> live = new HashMap<>();
		for (BlockPos c : cells) live.put(c, Blocks.OBSIDIAN.defaultBlockState());
		live.put(hidden, Blocks.NETHERRACK.defaultBlockState());
		// What the body knows: every cell but the hidden one.
		Map<BlockPos, BlockState> seen = new HashMap<>(live);
		seen.remove(hidden);
		ServerCastObsidianController.FrameRead read = ServerCastObsidianController.readFrame(cells, Set.of(), seen::get);
		check(!read.complete(), "a frame with an unseen cell is not complete");
		check(read.unknown().equals(List.of(hidden)) && read.missing().isEmpty(), "the hidden cell is reported unknown, not as its live block");
		check(hidden.equals(read.next()), "the hidden cell is the next to observe (look first)");
		check(read.done() == 9, "nine cells seen cast");
		// Hidden but live obsidian: still unknown; completeness never comes from the live world.
		live.put(hidden, Blocks.OBSIDIAN.defaultBlockState());
		check(!ServerCastObsidianController.readFrame(cells, Set.of(), seen::get).complete(), "a hidden cell that is obsidian live is still unknown");
		seen.put(hidden, Blocks.OBSIDIAN.defaultBlockState());
		check(ServerCastObsidianController.readFrame(cells, Set.of(), seen::get).complete(), "complete once every cell is seen cast");
		seen.put(hidden, Blocks.NETHERRACK.defaultBlockState());
		ServerCastObsidianController.FrameRead blocked = ServerCastObsidianController.readFrame(cells, Set.of(), seen::get);
		check(blocked.missing().equals(List.of(hidden)) && hidden.equals(blocked.next()), "a seen blocked cell is missing and next");
		check(ServerCastObsidianController.readFrame(cells, Set.of(hidden), seen::get).next() == null, "a refused seen cell is not retried");

		BlockPos lava = new BlockPos(5, 64, 5);
		Map<BlockPos, BlockState> water = new HashMap<>();
		water.put(lava.east(), Blocks.WATER.defaultBlockState());
		check(ServerCastObsidianController.cooledKnown(water::get, lava), "seen water beside the cell cools it");
		check(!ServerCastObsidianController.cooledKnown(new HashMap<BlockPos, BlockState>()::get, lava), "unseen water does not count");
	}

	private static void verifyStandingSpotsFromSeenTerrain() {
		BlockPos at = new BlockPos(3, 64, 3);
		Map<BlockPos, BlockState> seen = new HashMap<>();
		seen.put(at.below(), Blocks.NETHERRACK.defaultBlockState());
		seen.put(at, Blocks.AIR.defaultBlockState());
		seen.put(at.above(), Blocks.AIR.defaultBlockState());
		check(ServerCastObsidianController.standable(seen::get, EmptyBlockGetter.INSTANCE, at), "seen floor and seen open cells stand");
		Map<BlockPos, BlockState> noFloor = new HashMap<>(seen);
		noFloor.remove(at.below());
		check(!ServerCastObsidianController.standable(noFloor::get, EmptyBlockGetter.INSTANCE, at), "a floor hidden behind a wall is not a standing spot");
		Map<BlockPos, BlockState> noHead = new HashMap<>(seen);
		noHead.remove(at.above());
		check(!ServerCastObsidianController.standable(noHead::get, EmptyBlockGetter.INSTANCE, at), "an unseen head cell is not a standing spot");
		seen.put(at.north(), Blocks.LAVA.defaultBlockState());
		check(!ServerCastObsidianController.standable(seen::get, EmptyBlockGetter.INSTANCE, at), "seen lava beside the spot rules it out");
	}

	/** MUST 3: the obsidian baseline is what the body knows at the start; a cell it never saw as anything else is not made. */
	private static void verifyHiddenCellBaseline() {
		BlockState obsidian = Blocks.OBSIDIAN.defaultBlockState();
		BlockState lava = Blocks.LAVA.defaultBlockState();
		BlockPos hidden = new BlockPos(3, 64, 0), seenOld = new BlockPos(1, 64, 0), pool = new BlockPos(2, 63, 0);
		Set<BlockPos> open = new java.util.HashSet<>(), made = new java.util.HashSet<>();
		List<BlockPos> cells = List.of(hidden, seenOld, pool);
		// Start: the hidden cell is obsidian live but unseen; the seen cell is old obsidian; the pool cell is seen lava.
		Map<BlockPos, BlockState> known = new HashMap<>(Map.of(seenOld, obsidian, pool, lava));
		ServerCastObsidianController.trackObsidian(cells, known::get, open, made);
		check(!open.contains(hidden) && !made.contains(hidden), "an unseen cell is neither open nor made at the start");
		check(!open.contains(seenOld), "seen obsidian at the start is the baseline");
		// Later: the body sees the hidden cell (obsidian all along) and the pool cell cast.
		known.put(hidden, obsidian);
		known.put(pool, obsidian);
		ServerCastObsidianController.trackObsidian(cells, known::get, open, made);
		check(made.equals(Set.of(pool)), "only the cell seen as lava, then obsidian, counts as made: " + made);
		// Memory of the made cell lapses: it stays counted until seen otherwise.
		known.remove(pool);
		ServerCastObsidianController.trackObsidian(cells, known::get, open, made);
		check(made.contains(pool), "a made cell no longer in view stays made");
		known.put(pool, Blocks.AIR.defaultBlockState());
		ServerCastObsidianController.trackObsidian(cells, known::get, open, made);
		check(made.isEmpty(), "a made cell seen broken no longer counts");
	}

	/** MUST 3: remembered water that turned to lava behind a wall is not a seen lava source; remembered lava is. */
	private static void verifyRememberedWaterNowLavaBehindWall() {
		BlockPos behindWall = new BlockPos(5, 63, 0), flowing = new BlockPos(6, 63, 0), goneLava = new BlockPos(7, 63, 0);
		List<BlockPos> cells = List.of(behindWall, flowing, goneLava);
		Map<BlockPos, BlockState> live = Map.of(behindWall, Blocks.LAVA.defaultBlockState(),
				flowing, Blocks.LAVA.defaultBlockState().setValue(net.minecraft.world.level.block.LiquidBlock.LEVEL, 3),
				goneLava, Blocks.STONE.defaultBlockState());
		// Remembered (the wall hides all three now): water, flowing lava, and a lava source that has since gone.
		Map<BlockPos, BlockState> remembered = Map.of(behindWall, Blocks.WATER.defaultBlockState(),
				flowing, Blocks.LAVA.defaultBlockState().setValue(net.minecraft.world.level.block.LiquidBlock.LEVEL, 3),
				goneLava, Blocks.LAVA.defaultBlockState());
		List<BlockPos> found = ServerCastObsidianController.knownLavaSources(cells,
				ServerCastObsidianController.lavaView(remembered::get, live::get, remembered::get));
		check(!found.contains(behindWall), "remembered water now lava behind a wall is not a seen lava source");
		check(!found.contains(flowing), "remembered flowing lava is not a source");
		check(found.equals(List.of(goneLava)), "remembered source lava counts even if it changed unseen: " + found);
		check(ServerCastObsidianController.knownLavaSources(cells, at -> null).isEmpty(), "unknown cells are not lava sources");
	}

	/** A seen 4-source pool is found, and pouring over it counts the four cast cells. */
	private static void verifySeenLavaPoolStillWorks() {
		List<BlockPos> pool = List.of(new BlockPos(0, 63, 0), new BlockPos(1, 63, 0), new BlockPos(0, 63, 1), new BlockPos(1, 63, 1));
		Map<BlockPos, BlockState> seen = new HashMap<>();
		for (BlockPos c : pool) seen.put(c, Blocks.LAVA.defaultBlockState());
		List<BlockPos> found = ServerCastObsidianController.knownLavaSources(pool, ServerCastObsidianController.lavaView(at -> null, seen::get, seen::get));
		check(found.equals(pool), "every seen lava source in the pool is found: " + found);
		Set<BlockPos> open = new java.util.HashSet<>(found), made = new java.util.HashSet<>();
		for (BlockPos c : pool) seen.put(c, Blocks.OBSIDIAN.defaultBlockState());
		ServerCastObsidianController.trackObsidian(pool, seen::get, open, made);
		check(made.size() == 4, "the four seen-cast cells count as new obsidian: " + made.size());
	}

	private static void verifyPiglinAnger() {
		check(!ServerBarterController.perceivedAngry(false, true), "a piglin behind a wall going for the body is not reported");
		check(ServerBarterController.perceivedAngry(true, true), "a seen piglin going for the body stops the barter");
		check(!ServerBarterController.perceivedAngry(true, false), "a seen calm piglin is not angry (its ANGRY_AT memory is never read)");
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
