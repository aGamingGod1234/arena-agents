package dev.agaminggod.arenaagents.server.runtime;

import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;
import net.minecraft.world.phys.shapes.VoxelShape;

/** Visible vanilla clicks into one model-authored destination. */
final class BlockPlacementGeometry {
	private BlockPlacementGeometry() { }

	enum Cause {
		NO_SUPPORT, SUPPORT_FACE_HIDDEN, SUPPORT_NOT_OBSERVED, DESTINATION_OCCUPIED,
		BODY_IN_DESTINATION, OUT_OF_REACH, PLACEMENT_CONTEXT_MISMATCH, PLACEMENT_STATE_MISMATCH
	}

	static BlockHitResult candidate(BlockGetter world, CollisionContext context, Vec3 eye, double reach,
			BlockPos destination, Direction face, Predicate<BlockHitResult> landsAtDestination) {
		BlockPos support = ServerActionExecutor.placementSupport(destination, face);
		Vec3 point = TargetSightline.block(world, context, eye, support, reach, face);
		if (point != null) {
			BlockHitResult hit = new BlockHitResult(point, face, support, false);
			if (landsAtDestination.test(hit)) return hit;
		}
		// Grass, litter and thin snow have outlines that can hide the neighbour. A real player clicks
		// the replaceable destination itself; vanilla decides whether this particular item replaces it.
		BlockState state = world.getBlockState(destination);
		if (!state.isAir() && state.canBeReplaced()) {
			point = TargetSightline.block(world, context, eye, destination, reach, face);
			if (point != null) {
				BlockHitResult hit = new BlockHitResult(point, face, destination, false);
				if (landsAtDestination.test(hit)) return hit;
			}
		}
		return null;
	}

	/**
	 * Why a player at {@code eye} cannot click the requested support face, in the terms a player sees: the face is
	 * turned away (with the plane the eye must pass), beyond reach, or the first block the line to it meets. The
	 * support's outline is used only when it is seen ({@code supportShape} non-null); otherwise the cell bounds are,
	 * so an unseen support is never revealed.
	 */
	static String requestedFaceView(BlockGetter world, CollisionContext context, Vec3 eye, double reach,
			BlockPos destination, Direction face, VoxelShape supportShape) {
		BlockPos support = ServerActionExecutor.placementSupport(destination, face);
		AABB box = supportShape != null && !supportShape.isEmpty() ? supportShape.bounds().move(support) : new AABB(support);
		Direction.Axis axis = face.getAxis();
		boolean positive = face.getAxisDirection() == Direction.AxisDirection.POSITIVE;
		double plane = positive ? box.max(axis) : box.min(axis);
		String name = "the " + face.getSerializedName() + " face of " + cell(support);
		String axisName = axis.getName();
		if (positive ? eye.get(axis) <= plane : eye.get(axis) >= plane) {
			return name + " faces away from your eye: it lies at " + axisName + "=" + number(plane) + " and your eye "
					+ axisName + "=" + number(eye.get(axis)) + " must be " + side(face) + " " + axisName + "=" + number(plane) + " to see it";
		}
		Vec3 nearest = new Vec3(
				axis == Direction.Axis.X ? plane : Math.max(box.minX, Math.min(box.maxX, eye.x)),
				axis == Direction.Axis.Y ? plane : Math.max(box.minY, Math.min(box.maxY, eye.y)),
				axis == Direction.Axis.Z ? plane : Math.max(box.minZ, Math.min(box.maxZ, eye.z)));
		double distance = eye.distanceTo(nearest);
		if (distance > reach) {
			return name + " is out of reach: its nearest point is " + number(distance) + " from your eye, reach " + number(reach);
		}
		Vec3 center = new Vec3(
				axis == Direction.Axis.X ? plane : (box.minX + box.maxX) / 2.0D,
				axis == Direction.Axis.Y ? plane : (box.minY + box.maxY) / 2.0D,
				axis == Direction.Axis.Z ? plane : (box.minZ + box.maxZ) / 2.0D);
		Vec3 delta = center.subtract(eye);
		BlockHitResult hit = world.clip(new ClipContext(eye, center.add(delta.normalize().scale(0.01D)),
				ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, context));
		if (hit.getType() == HitResult.Type.BLOCK && !hit.getBlockPos().equals(support)) {
			// The first block on the line of sight is what the eye sees, so naming it reveals nothing hidden.
			return "the line from your eye to " + name + " first meets "
					+ BuiltInRegistries.BLOCK.getKey(world.getBlockState(hit.getBlockPos()).getBlock()) + " at " + cell(hit.getBlockPos())
					+ (hit.isInside() ? " (your eye is inside it)" : "");
		}
		return name + " is turned toward your eye and in reach (" + number(distance) + ")"
				+ (supportShape == null ? "; look at it to observe the support" : "");
	}

	private static String side(Direction face) {
		return switch (face) {
			case UP -> "above";
			case DOWN -> "below";
			default -> face.getSerializedName() + " of";
		};
	}

	private static String number(double value) {
		return String.format(java.util.Locale.ROOT, "%.2f", value);
	}

	private static String cell(BlockPos position) {
		return position.getX() + "," + position.getY() + "," + position.getZ();
	}

	static boolean equivalent(BlockState requested, BlockState alternate) {
		return requested != null && alternate != null && requested.getBlock() == alternate.getBlock()
				&& DesiredBlockState.stableProperties(requested).equals(DesiredBlockState.stableProperties(alternate));
	}
}
