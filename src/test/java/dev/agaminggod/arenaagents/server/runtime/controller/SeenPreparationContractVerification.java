package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import java.util.HashMap;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.Vec3;

/** Executes the same acquired geometry and preparation paths fight, flee and navigation use. */
public final class SeenPreparationContractVerification {
	private static int assertions;

	public static int verify() {
		assertions = 0;
		verifyDynamicGeometry();
		verifyUnknownPreparation();
		return assertions;
	}

	private static void verifyDynamicGeometry() {
		World world = new World();
		BlockPos moving = new BlockPos(2, 64, 0);
		world.states.put(moving, Blocks.MOVING_PISTON.defaultBlockState());
		world.visible = moving;
		SeenTerrain.Memory<BlockState> memory = new SeenTerrain.Memory<>();
		SeenTerrain.Reader<BlockState> reader = new SeenTerrain.Reader<>(memory, world, 0L, null);
		ObservedTerrain view = new ObservedTerrain(ObservedTerrain.known(reader, world, false, 0, false), null);
		GridPosition position = new GridPosition(2, 64, 0);
		check(view.cellAt(position) == WalkabilityView.Cell.UNLOADED,
				"fight and flee cannot infer moving-piston clearance from a hidden block entity");
		check(world.entityReads == 0, "fight and flee geometry never queries the live block entity");
		check(SeenHazardTerrain.over(reader, world).at(2, 64, 0) == HazardExits.Cell.UNKNOWN,
				"hazard preparation cannot certify moving-piston clearance from hidden data");
		check(world.entityReads == 0, "hazard geometry never queries the live block entity");
		world.visible = null;
		SeenTerrain.Reader<BlockState> recalled = new SeenTerrain.Reader<>(memory, world, 20L, null);
		check(SeenHazardTerrain.over(recalled, world, true).recalled(2, 64, 0) == HazardExits.Cell.UNKNOWN,
				"remembered geometry does not query current hidden block entities");
		check(world.entityReads == 0, "opaque and recalled geometry never reaches live entity state");
		check(CombatMoveText.headroom(reader, world, position) == 0,
				"combat diagnostics cannot claim headroom from hidden moving-piston geometry");
		check(world.entityReads == 0, "combat diagnostic headroom never queries hidden entities");
		AcquiredGeometry geometry = new AcquiredGeometry(world, p -> p.equals(moving) ? null : Blocks.STONE.defaultBlockState());
		check(geometry.shape(Blocks.STONE.defaultBlockState(), moving) != null,
				"an independent static vanilla shape needs no hidden dependency");
		MinecraftNavigationWorld navigation = new MinecraftNavigationWorld(world, recalled);
		check(navigation.cellAt(position) == WalkabilityView.Cell.UNLOADED,
				"move_to keeps the same unknown dynamic geometry rule");
	}

	private static void verifyUnknownPreparation() {
		GridPosition start = new GridPosition(0, 64, 0);
		Vec3 destination = new Vec3(3.5D, 64D, 0.5D);
		for (BlockState hidden : new BlockState[] { Blocks.STONE.defaultBlockState(), Blocks.AIR.defaultBlockState(),
				Blocks.LAVA.defaultBlockState() }) {
			World world = new World();
			world.states.put(new BlockPos(0, 63, 0), Blocks.STONE.defaultBlockState());
			world.states.put(new BlockPos(3, 63, 0), hidden);
			world.touchStart = true;
			MinecraftNavigationWorld view = new MinecraftNavigationWorld(world,
					new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), world, 0L, null));
			ServerNavigationController.Preparation preparation = new ServerNavigationController.Preparation(start, destination, 0.2D, null);
			check(preparation.advance(view, p -> view.supportHeight(p, p.x() + 0.5D, p.z() + 0.5D), () -> true),
					"real navigation preparation completes over acquired states");
			check(start.equals(preparation.start) && preparation.goals.isEmpty() && preparation.unknownGoal
					&& !preparation.destinationHasNoSupport,
					"hidden floor, gap and lava cannot change acquired goals or prove a support refusal");
		}
	}

	private static final class World implements BlockGetter, SeenTerrain.Source<BlockState> {
		final Map<BlockPos, BlockState> states = new HashMap<>();
		BlockPos visible;
		boolean touchStart;
		int entityReads;
		@Override public BlockEntity getBlockEntity(BlockPos p) { entityReads++; return null; }
		@Override public BlockState getBlockState(BlockPos p) { return states.getOrDefault(p, Blocks.AIR.defaultBlockState()); }
		@Override public FluidState getFluidState(BlockPos p) { return getBlockState(p).getFluidState(); }
		@Override public int getHeight() { return 384; }
		@Override public int getMinY() { return -64; }
		@Override public BlockState live(int x, int y, int z) { return getBlockState(new BlockPos(x, y, z)); }
		@Override public boolean sees(int x, int y, int z) { return visible != null && visible.equals(new BlockPos(x, y, z)); }
		@Override public boolean touches(int x, int y, int z) { return touchStart && x == 0 && z == 0 && y >= 63 && y <= 65; }
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
