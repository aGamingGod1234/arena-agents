package dev.agaminggod.arenaagents.server.perception;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

/** Review r1 P1-1 and P1-3 fixtures: what a player sees around lava, and what a lava sound reveals. */
public final class HazardSightVerification {
	private HazardSightVerification() {
	}

	public static int verify() {
		int assertions = 0;
		Map<BlockPos, BlockState> states = new HashMap<>();
		BlockGetter world = new BlockGetter() {
			@Override
			public BlockEntity getBlockEntity(BlockPos position) {
				return null;
			}

			@Override
			public BlockState getBlockState(BlockPos position) {
				return states.getOrDefault(position, Blocks.AIR.defaultBlockState());
			}

			@Override
			public FluidState getFluidState(BlockPos position) {
				return getBlockState(position).getFluidState();
			}

			@Override
			public int getHeight() {
				return 384;
			}

			@Override
			public int getMinY() {
				return -64;
			}
		};
		CollisionContext context = CollisionContext.empty();
		Vec3 eye = new Vec3(0.5D, 66.62D, 0.5D);
		Vec3 east = new Vec3(1.0D, 0.0D, 0.0D);
		BlockPos floor = new BlockPos(3, 64, 0);
		states.put(floor, Blocks.STONE.defaultBlockState());
		check(ObservationVisibility.seesCell(world, context, eye, east, floor), "a floor in view with nothing between is seen");
		assertions++;
		check(ObservationVisibility.seesCell(world, context, eye, east, new BlockPos(2, 66, 0)), "open air in view counts as seen");
		assertions++;
		check(!ObservationVisibility.seesCell(world, context, eye, new Vec3(-1.0D, 0.0D, 0.0D), floor), "a floor behind the eye is not seen");
		assertions++;
		states.put(new BlockPos(1, 66, 0), Blocks.LAVA.defaultBlockState());
		states.put(new BlockPos(1, 65, 0), Blocks.LAVA.defaultBlockState());
		check(!ObservationVisibility.seesCell(world, context, eye, east, floor), "lava hides the floor behind it");
		assertions++;
		BlockPos farLava = new BlockPos(3, 65, 0);
		states.put(farLava, Blocks.LAVA.defaultBlockState());
		check(!ObservationVisibility.seesCell(world, context, eye, east, farLava), "lava hides lava behind it");
		assertions++;
		check(ObservationVisibility.seesCell(world, context, eye, east, new BlockPos(1, 66, 0)), "the near lava surface itself is seen");
		assertions++;
		states.remove(new BlockPos(1, 66, 0));
		states.remove(new BlockPos(1, 65, 0));
		check(ObservationVisibility.seesCell(world, context, eye, east, farLava), "with the near lava gone the far lava is seen");
		assertions++;
		// A one-block pool at the feet: the floor beside it shows its far edge above the lava surface.
		states.put(new BlockPos(0, 65, 0), Blocks.LAVA.defaultBlockState());
		states.put(new BlockPos(1, 64, 0), Blocks.STONE.defaultBlockState());
		check(ObservationVisibility.seesCell(world, context, new Vec3(0.5D, 66.62D, 0.5D), east, new BlockPos(1, 64, 0)),
				"the floor beside a pool is seen past the lava surface");
		assertions++;
		states.remove(new BlockPos(0, 65, 0));
		states.put(new BlockPos(0, 66, 0), Blocks.LAVA.defaultBlockState());
		check(!ObservationVisibility.seesCell(world, context, eye, east, new BlockPos(2, 66, 0)), "an eye inside lava sees no other cell");
		assertions++;

		// Review r2 P1-1: in a lava hole facing east, the stone rim behind the body lies within two metres of the eye. Its
		// landing, feet and head cells are behind the eye, so none of them is seen.
		states.clear();
		states.put(new BlockPos(0, 64, 0), Blocks.LAVA.defaultBlockState());
		states.put(new BlockPos(-1, 64, 0), Blocks.STONE.defaultBlockState());
		Vec3 wading = new Vec3(0.5D, 65.62D, 0.5D);
		check(!ObservationVisibility.seesCell(world, context, wading, east, new BlockPos(-1, 64, 0)), "a rim floor behind the eye is not seen, however close");
		assertions++;
		check(!ObservationVisibility.seesCell(world, context, wading, east, new BlockPos(-1, 65, 0)), "open feet room behind the eye is not seen");
		assertions++;
		check(!ObservationVisibility.seesCell(world, context, wading, east, new BlockPos(-1, 66, 0)), "open head room behind the eye is not seen");
		assertions++;
		check(ObservationVisibility.seesCell(world, context, wading, east, new BlockPos(1, 65, 0)), "the cell in front is still seen");
		assertions++;

		// Only the source at (0,0,0) was heard; a second emitter in the same 4-block ambient group was not.
		HearingPerception.Listener listener = new HearingPerception.Listener(1).at("minecraft:overworld");
		HearingPerception.AmbientSource heard = new HearingPerception.AmbientSource(HearingPerception.LAVA_AMBIENT, 0, 0, 0, 0.005D, 0, 0, 0, 0.3F);
		HearingPerception.AmbientSource silent = new HearingPerception.AmbientSource(HearingPerception.LAVA_AMBIENT, 3, 0, 0, 0.005D, 3, 0, 0, 0.3F);
		listener.scanned(0, 0, 0, 0, 0, List.of(heard, silent));
		listener.record("ambient:" + HearingPerception.LAVA_AMBIENT + "@0,0,0", HearingPerception.LAVA_AMBIENT, null, 0, 0, 0, 0.3D, 3.0D, 10, 1);
		check(!listener.lavaHeardNear(4.5D, 0.5D, 0.5D, 2.5D, 10), "an unheard emitter sharing the group reveals nothing");
		assertions++;
		check(listener.lavaHeardNear(1.5D, 0.5D, 0.5D, 2.5D, 10), "a target beside the heard sound is near heard lava");
		assertions++;
		return assertions;
	}

	private static void check(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
	}
}
