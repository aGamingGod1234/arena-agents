package dev.agaminggod.arenaagents.server.perception;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

/** Uses the production terrain sight rays, rather than granting the planner an all-visible map. */
public final class SnowSightVerification {
	private SnowSightVerification() { }

	public static SeenTerrain.Reader<BlockState> reader(BlockGetter level, Vec3 feet, Vec3 view) {
		Vec3 eye = feet.add(0, 1.62D, 0);
		return new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), new SeenTerrain.Source<>() {
			@Override public BlockState live(int x, int y, int z) { return level.getBlockState(new BlockPos(x, y, z)); }
			@Override public boolean sees(int x, int y, int z) {
				return ObservationVisibility.seesCell(level, CollisionContext.empty(), eye, view.normalize(), new BlockPos(x, y, z));
			}
			@Override public boolean touches(int x, int y, int z) {
				return x == (int) Math.floor(feet.x) && z == (int) Math.floor(feet.z)
						&& y >= (int) Math.floor(feet.y - 1.0E-4D) && y <= (int) Math.floor(feet.y + 1.8D);
			}
		}, 1L, null);
	}
}
