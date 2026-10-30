package dev.agaminggod.arenaagents.server.perception;

import java.util.HashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

/** Real block-shape rays: a cube's exposed top, full cover, and cover behind its front surface. */
public final class EntityHitboxSightVerification {
	private EntityHitboxSightVerification() { }

	public static int verify() {
		HashMap<BlockPos, BlockState> blocks = new HashMap<>();
		BlockGetter world = new BlockGetter() {
			@Override public BlockEntity getBlockEntity(BlockPos pos) { return null; }
			@Override public BlockState getBlockState(BlockPos pos) { return blocks.getOrDefault(pos, Blocks.AIR.defaultBlockState()); }
			@Override public FluidState getFluidState(BlockPos pos) { return getBlockState(pos).getFluidState(); }
			@Override public int getHeight() { return 384; }
			@Override public int getMinY() { return -64; }
		};
		Vec3 eye = new Vec3(0.5D, 65.62D, 0.5D);
		AABB small = new AABB(2.24D, 65.0D, 0.24D, 2.76D, 65.52D, 0.76D);
		var context = CollisionContext.empty();
		java.util.function.Predicate<Vec3> clear = point -> EntityHitboxSight.clear(world, context, eye,
				EntityHitboxSight.intersection(eye, point, small), ClipContext.Block.COLLIDER);
		check(EntityHitboxSight.point(eye, small, clear).equals(small.getCenter()), "open hitbox keeps centre aim");
		blocks.put(new BlockPos(1, 65, 0), Blocks.STONE_SLAB.defaultBlockState());
		check(!clear.test(small.getCenter()), "the half-block cover blocks the centre ray");
		Vec3 top = EntityHitboxSight.point(eye, small, clear);
		check(top != null && top.y > 65.5D, "a small cube's exposed top remains hittable when its centre is covered");
		check(!EntityHitboxSight.clear(world, context, eye, new Vec3(2.5D, 65.325D, .5D), ClipContext.Block.COLLIDER),
				"eye-to-eye rejects this fixture although vanilla can hit its top");
		check(eye.distanceTo(EntityHitboxSight.intersection(eye, top, small)) < 3.0D, "the exposed top is within survival reach");
		check(EntityHitboxSight.clearRay(world, context, eye, -90.0F, 3.2945F, small, 3.0D),
				"the ordinary control ray reaches the exposed top through the slab");
		check(!EntityHitboxSight.clearRay(world, context, eye, -90.0F, 10.24F, small, 3.0D),
				"the actual centreward ray is blocked even though another hitbox point is visible");
		check(!EntityHitboxSight.clearRay(world, context, eye, -90.0F, 3.2945F, small, 1.0D),
				"a ray stopping before the real box cannot swing");
		blocks.put(new BlockPos(1, 65, 0), Blocks.STONE.defaultBlockState());
		check(!EntityHitboxSight.clearRay(world, context, eye, -90.0F, 3.2945F, small, 3.0D),
				"full cover blocks the settled float ray too");
		check(EntityHitboxSight.point(eye, small, clear) == null, "full cover exposes no candidate and authorizes no swing");
		blocks.clear();
		blocks.put(new BlockPos(3, 65, 0), Blocks.STONE.defaultBlockState());
		AABB partlyEmbedded = new AABB(2.24D, 65.0D, 0.24D, 4.0D, 65.52D, .76D);
		Vec3 hit = EntityHitboxSight.intersection(eye, partlyEmbedded.getCenter(), partlyEmbedded);
		check(EntityHitboxSight.clear(world, context, eye, hit, ClipContext.Block.COLLIDER),
				"a block behind the first real hitbox intersection cannot occlude that front surface");
		check(EntityHitboxSight.intersection(eye, new Vec3(1.0D, 65.62D, .5D), small) == null,
				"a segment stopping short of the hitbox is not an intersection");
		check(!EntityHitboxSight.clear(world, context, eye, null, ClipContext.Block.COLLIDER), "a missing intersection cannot authorize a swing");
		AABB wide = new AABB(3.4D, 65.0D, 0.2D, 4.0D, 66.0D, 8.0D);
		Vec3 reachable = EntityHitboxSight.point(eye, wide, point -> {
			Vec3 surface = EntityHitboxSight.intersection(eye, point, wide);
			return surface != null && eye.distanceToSqr(surface) <= 9.0D;
		});
		check(eye.distanceTo(EntityHitboxSight.intersection(eye, wide.getCenter(), wide)) > 3.0D,
				"a broad box can have its centre ray beyond reach while its near face is reachable");
		check(reachable != null && eye.distanceTo(EntityHitboxSight.intersection(eye, reachable, wide)) <= 3.0D,
				"candidate selection must continue to the reachable face after rejecting an out-of-range ray");
		return 15;
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
