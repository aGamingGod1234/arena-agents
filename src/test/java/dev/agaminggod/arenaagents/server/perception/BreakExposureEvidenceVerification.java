package dev.agaminggod.arenaagents.server.perception;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.shapes.CollisionContext;

public final class BreakExposureEvidenceVerification {
	private static final BlockPos REMOVED = new BlockPos(2, 64, 0);
	private static final BlockPos NEIGHBOUR = REMOVED.east();
	private static final Vec3 EYE = new Vec3(0.5D, 64.5D, 0.5D);
	private static final Vec3 EAST = new Vec3(1.0D, 0.0D, 0.0D);

	private BreakExposureEvidenceVerification() {
	}

	public static void main(String[] args) {
		net.minecraft.server.Bootstrap.bootStrap();
		System.out.println("Break exposure verification assertions=" + verify());
	}

	public static int verify() {
		Fixture world = new Fixture();
		world.reset();
		var success = capture(world);
		world.states.remove(REMOVED);
		var facts = success.afterRemoval(true);
		check(facts.size() == 1, "successful removal proves one unchanged neighbour");
		check(facts.getFirst().blockId().equals("minecraft:diamond_ore"), "only the visible neighbour ID is emitted");
		check(facts.getFirst().face().equals("west"), "the exact shared face is named");
		check(facts.getFirst().position().x() == 3 && facts.getFirst().position().z() == 0, "the directly adjacent position is emitted");

		world.reset();
		var failed = capture(world);
		check(failed.afterRemoval(false).isEmpty(), "failed removeBlock gives no exposure evidence");
		check(failed.afterRemoval(true).isEmpty(), "a true return without a mutation gives no evidence");
		world.states.remove(REMOVED);
		check(failed.afterRemoval(false).isEmpty(), "an independent disappearance after failure is still unexplained");

		world.reset();
		world.states.remove(NEIGHBOUR);
		var placed = capture(world);
		world.states.put(NEIGHBOUR, Blocks.CHEST.defaultBlockState());
		world.states.remove(REMOVED);
		check(placed.afterRemoval(true).isEmpty(), "a neighbour placed independently during removal is a discovery");

		world.reset();
		var changed = capture(world);
		world.states.put(NEIGHBOUR, Blocks.EMERALD_ORE.defaultBlockState());
		world.states.remove(REMOVED);
		check(changed.afterRemoval(true).isEmpty(), "a changed neighbour cannot be attributed to the break");

		world.reset();
		world.states.put(REMOVED.east().south(), Blocks.GOLD_ORE.defaultBlockState());
		var diagonal = capture(world);
		world.states.remove(REMOVED);
		check(diagonal.afterRemoval(true).size() == 1, "a diagonal block has no face shared with the removed block");

		world.reset();
		world.states.put(REMOVED.west(), Blocks.IRON_ORE.defaultBlockState());
		var alreadyVisible = capture(world);
		world.states.remove(REMOVED);
		check(alreadyVisible.afterRemoval(true).isEmpty(), "an already visible neighbour and the block behind it are not newly exposed");

		world.reset();
		world.states.put(new BlockPos(1, 64, 0), Blocks.LAVA.defaultBlockState());
		var lava = capture(world);
		world.states.remove(REMOVED);
		check(lava.afterRemoval(true).isEmpty(), "opaque lava blocks before and after visual evidence");

		world.reset();
		world.states.put(REMOVED, Blocks.GLASS.defaultBlockState());
		var transparent = capture(world);
		world.states.remove(REMOVED);
		check(transparent.afterRemoval(true).isEmpty(), "a transparent removed block cannot prove visual occlusion");

		world.reset();
		world.states.put(NEIGHBOUR, Blocks.BARRIER.defaultBlockState());
		var invisible = capture(world);
		world.states.remove(REMOVED);
		check(invisible.afterRemoval(true).isEmpty(), "an invisible neighbour ID never leaves the server");

		world.reset();
		var behind = BreakExposureEvidence.capture(world, CollisionContext.empty(), EYE, EAST.scale(-1), REMOVED, position -> true);
		world.states.remove(REMOVED);
		check(behind.afterRemoval(true).isEmpty(), "being nearby behind the eye is not visual evidence");

		world.reset();
		var unloaded = BreakExposureEvidence.capture(world, CollisionContext.empty(), EYE, EAST, REMOVED, position -> position.getX() < 3);
		world.states.remove(REMOVED);
		check(unloaded.afterRemoval(true).isEmpty(), "an unloaded neighbour is never inspected or emitted");

		world.reset();
		var blockedAfter = capture(world);
		world.states.remove(REMOVED);
		world.states.put(new BlockPos(1, 64, 0), Blocks.STONE.defaultBlockState());
		check(blockedAfter.afterRemoval(true).isEmpty(), "another blocker after removal leaves the face unseen");

		world.reset();
		world.states.put(REMOVED.south(), Blocks.EMERALD_ORE.defaultBlockState());
		var simultaneous = capture(world);
		world.states.remove(REMOVED);
		var simultaneousFacts = simultaneous.afterRemoval(true);
		check(simultaneousFacts.size() == 2, "two confirmed faces exposed simultaneously are retained");
		check(simultaneousFacts.stream().map(fact -> fact.face()).sorted().toList().equals(List.of("north", "west")),
				"simultaneous evidence names each neighbour's shared face");
		check(world.rays.get() <= 60, "at most thirty before and thirty after rays per break");
		return 20;
	}

	private static BreakExposureEvidence.Snapshot capture(Fixture world) {
		return BreakExposureEvidence.capture(world, CollisionContext.empty(), EYE, EAST, REMOVED, position -> true);
	}

	private static void check(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
	}

	private static final class Fixture implements BlockGetter {
		private final Map<BlockPos, BlockState> states = new HashMap<>();
		private final AtomicInteger rays = new AtomicInteger();

		void reset() {
			states.clear();
			rays.set(0);
			states.put(REMOVED, Blocks.STONE.defaultBlockState());
			states.put(NEIGHBOUR, Blocks.DIAMOND_ORE.defaultBlockState());
		}

		@Override public BlockEntity getBlockEntity(BlockPos position) { return null; }
		@Override public BlockState getBlockState(BlockPos position) { return states.getOrDefault(position, Blocks.AIR.defaultBlockState()); }
		@Override public FluidState getFluidState(BlockPos position) { return getBlockState(position).getFluidState(); }
		@Override public int getHeight() { return 384; }
		@Override public int getMinY() { return -64; }
		@Override public BlockHitResult clip(ClipContext context) {
			rays.incrementAndGet();
			return BlockGetter.super.clip(context);
		}
	}
}
