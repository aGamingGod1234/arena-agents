package dev.agaminggod.arenaagents.server.runtime;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;
import net.minecraft.world.phys.shapes.VoxelShape;

/**
 * Vanilla's mining rule: a player mines a block when the crosshair ray meets its outline first within reach, partly
 * hidden or not, and a player may turn to any such point. Block rays use outline shapes; entity rays follow the caller
 * crosshair or projectile shape. Both ignore fluids and validate the selected point; moving entities still require the live crosshair check.
 */
final class BreakSightline {
	/** Face samples: the face center first, then points 0.15 in from each edge. */
	private static final double[] FACE_STEPS = {0.5D, 0.15D, 0.85D};

	private BreakSightline() {
	}

	/**
	 * Where to aim so the crosshair meets the target first within reach: its center when that ray is clear, else the
	 * clear outline samples, then ray-validated exposed face regions and their reach boundary, else null.
	 */
	static Vec3 visiblePoint(BlockGetter level, CollisionContext context, Vec3 eye, BlockPos target, double reach) {
		return visiblePoint(level, context, eye, target, reach, null, null);
	}

	/** A retry excludes the missed aim and validates candidates after Minecraft's player-angle conversion. */
	static Vec3 visiblePoint(BlockGetter level, CollisionContext context, Vec3 eye, BlockPos target, double reach, Vec3 missed) {
		return visiblePoint(level, context, eye, target, reach, missed, null);
	}

	static Vec3 visiblePoint(BlockGetter level, CollisionContext context, Vec3 eye, BlockPos target, double reach,
			Vec3 missed, Direction requiredFace) {
		Vec3 center = Vec3.atCenterOf(target);
		if (requiredFace == null && usablePoint(level, context, eye, center, target, reach, missed, requiredFace)) return center;
		VoxelShape shape = level.getBlockState(target).getShape(level, target, context);
		if (shape.isEmpty()) return null;
		Vec3 toCenter = center.subtract(eye).normalize();
		List<Vec3> points = new ArrayList<>();
		for (AABB local : shape.toAabbs()) {
			AABB box = local.move(target);
			for (Direction face : Direction.values()) {
				if (requiredFace != null && face != requiredFace) continue;
				Direction.Axis axis = face.getAxis();
				boolean positive = face.getAxisDirection() == Direction.AxisDirection.POSITIVE;
				double plane = positive ? box.max(axis) : box.min(axis);
				// Only faces turned toward the eye can be the first surface a ray meets.
				if (positive ? eye.get(axis) <= plane : eye.get(axis) >= plane) continue;
				Vec3 nearest = unproject(project(new Vec3(
						Math.max(box.minX, Math.min(box.maxX, eye.x)), Math.max(box.minY, Math.min(box.maxY, eye.y)),
						Math.max(box.minZ, Math.min(box.maxZ, eye.z))), axis), axis, plane);
				if ((axis == Direction.Axis.X || eye.x > box.minX && eye.x < box.maxX)
						&& (axis == Direction.Axis.Y || eye.y > box.minY && eye.y < box.maxY)
						&& (axis == Direction.Axis.Z || eye.z > box.minZ && eye.z < box.maxZ)
						&& usablePoint(level, context, eye, nearest, target, reach, missed, requiredFace)) return nearest;
				for (double u : FACE_STEPS) {
					for (double v : FACE_STEPS) points.add(facePoint(box, axis, plane, u, v));
				}
			}
		}
		points.sort(Comparator.comparingDouble(point -> -point.subtract(eye).normalize().dot(toCenter)));
		for (Vec3 point : points) {
			if (usablePoint(level, context, eye, point, target, reach, missed, requiredFace)) return point;
		}
		for (AABB local : shape.toAabbs()) {
			AABB box = local.move(target);
			for (Direction face : Direction.values()) {
				if (requiredFace != null && face != requiredFace) continue;
				Direction.Axis axis = face.getAxis();
				boolean positive = face.getAxisDirection() == Direction.AxisDirection.POSITIVE;
				double plane = positive ? box.max(axis) : box.min(axis);
				if (positive ? eye.get(axis) <= plane : eye.get(axis) >= plane) continue;
				Vec3 point = outlineRegion(level, context, eye, target, reach, box, axis, plane, missed, requiredFace);
				if (point != null) return point;
			}
		}
		return null;
	}

	/**
	 * A fluid cell has no outline, so the crosshair passes through it; what a player aims at is its visible surface.
	 * Propose surface or inside aims; only the supplied vanilla raycast decides whether the requested cell and face
	 * are hit. Sources are checked through flowing fluid with the caller's source-only ray.
	 */
	static Vec3 visibleFluidPoint(BlockGetter level, Vec3 eye, BlockPos target, double reach, Direction face,
			java.util.function.Function<Vec3, BlockHitResult> raycast) {
		VoxelShape shape = level.getFluidState(target).getShape(level, target);
		if (shape.isEmpty() || face == null) return null;
		AABB box = shape.bounds().move(target);
		if (shape.toAabbs().stream().anyMatch(local -> local.move(target).contains(eye))) {
			// The inside sample depends on the full ray length, so a short segment can select the wrong source.
			Vec3 point = eye.add(-face.getStepX() * 0.25D, -face.getStepY() * 0.25D, -face.getStepZ() * 0.25D);
			BlockHitResult hit = raycast.apply(point);
			return hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(target) && hit.getDirection() == face ? point : null;
		}
		Direction.Axis axis = face.getAxis();
		boolean positive = face.getAxisDirection() == Direction.AxisDirection.POSITIVE;
		double plane = positive ? box.max(axis) : box.min(axis);
		if (positive ? eye.get(axis) <= plane : eye.get(axis) >= plane) return null;
		for (double u : FACE_STEPS) {
			for (double v : FACE_STEPS) {
				Vec3 point = facePoint(box, axis, plane, u, v);
				Vec3 delta = point.subtract(eye);
				double length = delta.length();
				if (length < 1.0E-6D) continue;
				BlockHitResult hit = raycast.apply(point);
				if (hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(target) && hit.getDirection() == face
						&& eye.distanceTo(hit.getLocation()) <= reach) return point;
			}
		}
		return null;
	}

	/** Sources are aimed through flowing fluid; a flowing cell is aimed as the first fluid surface of any kind. */
	static ClipContext.Fluid fluidRay(BlockGetter level, BlockPos target) {
		return level.getFluidState(target).isSource() ? ClipContext.Fluid.SOURCE_ONLY : ClipContext.Fluid.ANY;
	}

	/** The block the line from the eye to the target's center meets first, when that is not the target. */
	static BlockHitResult blocker(BlockGetter level, CollisionContext context, Vec3 eye, BlockPos target) {
		BlockHitResult hit = level.clip(new ClipContext(
				eye, Vec3.atCenterOf(target), ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, context));
		return hit.getType() == HitResult.Type.BLOCK && !hit.getBlockPos().equals(target) ? hit : null;
	}

	/** Only replaceable vegetation or flowers that break instantly may be cleared as part of the requested mining ray. */
	static BlockHitResult plantToClear(BlockGetter level, CollisionContext context, Vec3 eye, BlockPos target, double reach) {
		BlockHitResult hit = blocker(level, context, eye, target);
		if (hit == null || eye.distanceTo(hit.getLocation()) > reach) return null;
		BlockPos at = hit.getBlockPos();
		BlockState state = level.getBlockState(at);
		return clearablePlant(level, at, state) ? hit : null;
	}

	static boolean clearablePlant(BlockGetter level, BlockPos at, BlockState state) {
		return state.getBlock() instanceof net.minecraft.world.level.block.VegetationBlock
				&& (state.canBeReplaced() || state.getBlock() instanceof net.minecraft.world.level.block.FlowerBlock
					|| state.getBlock() instanceof net.minecraft.world.level.block.TallFlowerBlock)
				&& state.getDestroySpeed(level, at) == 0.0F
				&& state.getCollisionShape(level, at).isEmpty() && state.getFluidState().isEmpty();
	}

	/** A target-line obstruction is reportable only when the current eye ray actually hits that same block. */
	static BlockHitResult visibleBlocker(BlockGetter level, CollisionContext context, Vec3 eye, BlockPos target, HitResult currentRay) {
		if (!(currentRay instanceof BlockHitResult current) || current.getType() != HitResult.Type.BLOCK) return null;
		BlockHitResult obstruction = blocker(level, context, eye, target);
		return obstruction != null && obstruction.getBlockPos().equals(current.getBlockPos()) ? current : null;
	}

	/**
	 * The standing cell nearest {@code feet} (other than the current one) whose eye sees part of the target within
	 * reach, judged only on {@code seen}: a floor with a sturdy top and open feet and head cells, all known, and a
	 * clear ray through known cells. Unknown cells are neither standable nor see-through. Null when none.
	 */
	static BlockPos standingSpot(SeenWorld seen, Vec3 feet, BlockPos target, double reach, double eyeHeight) {
		// Unknown cells obstruct rays, but cannot supply an invented target outline.
		if (seen.knownState(target) == null) return null;
		BlockPos here = BlockPos.containing(feet);
		int radius = (int) Math.ceil(reach);
		AABB targetBox = new AABB(target);
		List<BlockPos> spots = new ArrayList<>();
		for (int dx = -radius; dx <= radius; dx++) {
			for (int dy = -radius - 1; dy <= radius; dy++) {
				for (int dz = -radius; dz <= radius; dz++) {
					BlockPos spot = target.offset(dx, dy, dz);
					if (spot.equals(here)) continue;
					Vec3 eye = new Vec3(spot.getX() + 0.5D, spot.getY() + eyeHeight, spot.getZ() + 0.5D);
					if (targetBox.distanceToSqr(eye) <= reach * reach) spots.add(spot);
				}
			}
		}
		spots.sort(Comparator.comparingDouble(spot -> Vec3.atBottomCenterOf(spot).distanceToSqr(feet)));
		CollisionContext context = CollisionContext.empty();
		for (BlockPos spot : spots) {
			if (!standable(seen, spot, target)) continue;
			Vec3 eye = new Vec3(spot.getX() + 0.5D, spot.getY() + eyeHeight, spot.getZ() + 0.5D);
			if (visiblePoint(seen, context, eye, target, reach) != null) return spot;
		}
		return null;
	}

	private static boolean standable(SeenWorld seen, BlockPos feet, BlockPos target) {
		BlockPos head = feet.above();
		BlockPos floor = feet.below();
		if (feet.equals(target) || head.equals(target) || floor.equals(target)) return false;
		BlockState floorState = seen.knownState(floor);
		if (floorState == null || !floorState.isFaceSturdy(seen, floor, Direction.UP)) return false;
		BlockState feetState = seen.knownState(feet);
		if (feetState == null || !open(seen, feet, feetState)) return false;
		BlockState headState = seen.knownState(head);
		return headState != null && open(seen, head, headState);
	}

	private static boolean open(BlockGetter level, BlockPos position, BlockState state) {
		return state.getCollisionShape(level, position).isEmpty() && state.getFluidState().isEmpty();
	}

	private static boolean meets(BlockGetter level, CollisionContext context, Vec3 eye, Vec3 point, BlockPos target, double reach, Direction requiredFace) {
		Vec3 delta = point.subtract(eye);
		double length = delta.length();
		if (length < 1.0E-6D) return false;
		// A hair past the point, so a ray aimed at a face point crosses that face.
		Vec3 end = eye.add(delta.scale((length + 0.01D) / length));
		BlockHitResult hit = level.clip(new ClipContext(eye, end, ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, context));
		return hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(target)
				&& eye.distanceTo(hit.getLocation()) <= reach && (requiredFace == null || hit.getDirection() == requiredFace);
	}

	private static boolean playerAimMeets(BlockGetter level, CollisionContext context, Vec3 eye, Vec3 point, BlockPos target, double reach, Direction requiredFace) {
		Vec3 delta = point.subtract(eye);
		float yaw = (float) Math.toDegrees(Math.atan2(-delta.x, delta.z));
		float pitch = (float) -Math.toDegrees(Math.atan2(delta.y, Math.sqrt(delta.x * delta.x + delta.z * delta.z)));
		BlockHitResult hit = level.clip(new ClipContext(eye, eye.add(Vec3.directionFromRotation(pitch, yaw).scale(reach)),
				ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, context));
		return hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(target) && eye.distanceTo(hit.getLocation()) <= reach && (requiredFace == null || hit.getDirection() == requiredFace);
	}

	private static boolean usablePoint(BlockGetter level, CollisionContext context, Vec3 eye, Vec3 point,
			BlockPos target, double reach, Vec3 missed, Direction requiredFace) {
		return meets(level, context, eye, point, target, reach, requiredFace) && (missed == null
				|| point.distanceToSqr(missed) > 1.0E-12D && playerAimMeets(level, context, eye, point, target, reach, requiredFace));
	}

	private static Vec3 facePoint(AABB box, Direction.Axis axis, double plane, double u, double v) {
		return switch (axis) {
			case X -> new Vec3(plane, lerp(box.minY, box.maxY, u), lerp(box.minZ, box.maxZ, v));
			case Y -> new Vec3(lerp(box.minX, box.maxX, u), plane, lerp(box.minZ, box.maxZ, v));
			case Z -> new Vec3(lerp(box.minX, box.maxX, u), lerp(box.minY, box.maxY, v), plane);
		};
	}

	/**
	 * Fixed samples are a fast success test, not a visibility proof. Subtract the outline shadows of the blocks a
	 * candidate ray actually hits from this face. Each remaining convex region supplies an interior point within the
	 * reach circle, so thin exposed strips and small reach intersections are still tested by vanilla's ray.
	 */
	private static Vec3 outlineRegion(BlockGetter level, CollisionContext context, Vec3 eye, BlockPos target,
			double reach, AABB box, Direction.Axis axis, double plane, Vec3 missed, Direction requiredFace) {
		List<List<Point>> regions = new ArrayList<>();
		regions.add(List.of(project(facePoint(box, axis, plane, 0, 0), axis),
				project(facePoint(box, axis, plane, 1, 0), axis), project(facePoint(box, axis, plane, 1, 1), axis),
				project(facePoint(box, axis, plane, 0, 1), axis)));
		Point projectedEye = project(eye, axis);
		while (!regions.isEmpty()) {
			List<Point> region = regions.removeLast();
			Point nearest = closest(region, projectedEye);
			Vec3 point = unproject(nearest, axis, plane);
			if (eye.distanceToSqr(point) > reach * reach) continue;
			Point middle = new Point(region.stream().mapToDouble(Point::u).average().orElseThrow(),
					region.stream().mapToDouble(Point::v).average().orElseThrow());
			Vec3 interior = unproject(middle, axis, plane);
			if (eye.distanceToSqr(interior) <= reach * reach) {
				point = interior;
			} else {
				// Halfway along the reachable segment toward the interior: a boundary-only aim can hit a neighbour
				// after the actual player view rounds yaw and pitch to floats.
				Vec3 toward = interior.subtract(point), offset = point.subtract(eye);
				double a = toward.lengthSqr(), b = 2.0D * offset.dot(toward), c = offset.lengthSqr() - reach * reach;
				double boundary = a == 0.0D ? 0.0D : (-b + Math.sqrt(Math.max(0.0D, b * b - 4.0D * a * c))) / (2.0D * a);
				point = unproject(nearest.toward(middle, Math.max(0.0D, Math.min(1.0D, boundary)) * 0.5D), axis, plane);
			}
			Vec3 delta = point.subtract(eye);
			BlockHitResult hit = level.clip(new ClipContext(eye, point.add(delta.normalize().scale(0.01D)),
					ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, context));
			if (hit.getType() != HitResult.Type.BLOCK) continue;
			if (hit.getBlockPos().equals(target)) {
				if (requiredFace != null && hit.getDirection() != requiredFace) continue;
				if (eye.distanceTo(hit.getLocation()) <= reach
						&& (missed == null || usablePoint(level, context, eye, point, target, reach, missed, requiredFace))) return point;
				if (missed == null) continue;
				// A second interior aim can survive the sine-table rounding that missed a thin region's first aim.
				for (Point vertex : region) {
					Vec3 alternate = unproject(vertex.toward(middle, 0.5D), axis, plane);
					if (usablePoint(level, context, eye, alternate, target, reach, missed, requiredFace)) return alternate;
				}
				for (double fraction : new double[]{0.25D, 0.75D}) {
					Vec3 alternate = point.lerp(unproject(nearest, axis, plane), fraction);
					if (usablePoint(level, context, eye, alternate, target, reach, missed, requiredFace)) return alternate;
				}
				continue;
			}
			List<List<Point>> remaining = new ArrayList<>();
			remaining.add(region);
			BlockPos obstruction = hit.getBlockPos();
			for (AABB local : level.getBlockState(obstruction).getShape(level, obstruction, context).toAabbs()) {
				List<Point> shadow = shadow(local.move(obstruction), eye, axis, plane);
				if (shadow.size() < 3) continue;
				List<List<Point>> outside = new ArrayList<>();
				for (List<Point> piece : remaining) outside.addAll(subtract(piece, shadow));
				remaining = outside;
			}
			// Numerical boundary hits must not retry an unchanged polygon indefinitely.
			double area = remaining.stream().mapToDouble(BreakSightline::area).sum();
			if (area < area(region)) regions.addAll(remaining);
		}
		return null;
	}

	/** The same exposed-region solver for an observed entity box, using the caller's vanilla ray shape. */
	static Vec3 visibleEntityPoint(BlockGetter level, CollisionContext context, Vec3 eye, AABB box, double reach, ClipContext.Block shape) {
		var clear = (java.util.function.Predicate<Vec3>) point -> entityPointUsable(level, context, eye, box, point, reach, shape);
		Vec3 quick = dev.agaminggod.arenaagents.server.perception.EntityHitboxSight.point(eye, box, clear);
		if (quick != null) return quick;
		// AABB.clip excludes a ray endpoint exactly on its face. Aim just inside the same real box, as the cheap
		// hitbox samples do, so the first front-surface intersection lies strictly before the endpoint.
		double inset = Math.min(1.0E-4D, Math.min(box.getXsize(), Math.min(box.getYsize(), box.getZsize())) / 4.0D);
		AABB surface = box.deflate(inset);
		for (Direction face : Direction.values()) {
			Direction.Axis axis = face.getAxis();
			double plane = face.getAxisDirection() == Direction.AxisDirection.POSITIVE ? surface.max(axis) : surface.min(axis);
			if (face.getAxisDirection() == Direction.AxisDirection.POSITIVE ? eye.get(axis) <= plane : eye.get(axis) >= plane) continue;
			List<List<Point>> regions = new ArrayList<>();
			regions.add(List.of(project(facePoint(surface, axis, plane, 0, 0), axis), project(facePoint(surface, axis, plane, 1, 0), axis),
					project(facePoint(surface, axis, plane, 1, 1), axis), project(facePoint(surface, axis, plane, 0, 1), axis)));
			while (!regions.isEmpty()) {
				List<Point> region = regions.removeLast();
				Point nearest = closest(region, project(eye, axis));
				Vec3 boundary = unproject(nearest, axis, plane);
				if (eye.distanceToSqr(boundary) > reach * reach) continue;
				Point middle = new Point(region.stream().mapToDouble(Point::u).average().orElseThrow(),
						region.stream().mapToDouble(Point::v).average().orElseThrow());
				Vec3 point = unproject(middle, axis, plane);
				if (eye.distanceToSqr(point) > reach * reach) {
					Vec3 toward = point.subtract(boundary), offset = boundary.subtract(eye);
					double a = toward.lengthSqr(), b = 2 * offset.dot(toward), c = offset.lengthSqr() - reach * reach;
					double fraction = a == 0 ? 0 : (-b + Math.sqrt(Math.max(0, b * b - 4 * a * c))) / (2 * a);
					point = boundary.lerp(point, Math.clamp(fraction, 0, 1) * .5D);
				}
				if (clear.test(point)) return point;
				Vec3 hitPoint = dev.agaminggod.arenaagents.server.perception.EntityHitboxSight.intersection(eye, point, box);
				if (hitPoint == null) continue;
				BlockHitResult hit = level.clip(new ClipContext(eye, hitPoint, shape, ClipContext.Fluid.NONE, context));
				if (hit.getType() == HitResult.Type.MISS) {
					// Angle rounding can miss one interior point; try other points of this same exposed region.
					for (Point vertex : region) {
						Vec3 alternate = unproject(vertex.toward(middle, .5D), axis, plane);
						if (clear.test(alternate)) return alternate;
					}
					continue;
				}
				List<List<Point>> remaining = new ArrayList<>();
				remaining.add(region);
				BlockPos obstruction = hit.getBlockPos();
				for (AABB local : shape.get(level.getBlockState(obstruction), level, obstruction, context).toAabbs()) {
					List<Point> shadow = shadow(local.move(obstruction), eye, axis, plane);
					if (shadow.size() < 3) continue;
					List<List<Point>> outside = new ArrayList<>();
					for (List<Point> piece : remaining) outside.addAll(subtract(piece, shadow));
					remaining = outside;
				}
				if (remaining.stream().mapToDouble(BreakSightline::area).sum() < area(region)) regions.addAll(remaining);
			}
		}
		return null;
	}

	private static boolean entityPointUsable(BlockGetter level, CollisionContext context, Vec3 eye, AABB box, Vec3 point, double reach, ClipContext.Block shape) {
		Vec3 hit = dev.agaminggod.arenaagents.server.perception.EntityHitboxSight.intersection(eye, point, box);
		if (hit == null || eye.distanceToSqr(hit) > reach * reach
				|| !dev.agaminggod.arenaagents.server.perception.EntityHitboxSight.clear(level, context, eye, hit, shape)) return false;
		Vec3 delta = point.subtract(eye);
		float yaw = (float) Math.toDegrees(Math.atan2(-delta.x, delta.z));
		float pitch = (float) -Math.toDegrees(Math.atan2(delta.y, Math.hypot(delta.x, delta.z)));
		Vec3 roundedEnd = eye.add(Vec3.directionFromRotation(pitch, yaw).scale(reach));
		return dev.agaminggod.arenaagents.server.perception.EntityHitboxSight.clear(level, context, eye,
				dev.agaminggod.arenaagents.server.perception.EntityHitboxSight.intersection(eye, roundedEnd, box), shape);
	}

	private record Point(double u, double v) {
		double distanceSqr(Point other) {
			return (u - other.u) * (u - other.u) + (v - other.v) * (v - other.v);
		}

		Point toward(Point other, double fraction) {
			return new Point(lerp(u, other.u, fraction), lerp(v, other.v, fraction));
		}
	}

	private static Point project(Vec3 point, Direction.Axis axis) {
		return switch (axis) {
			case X -> new Point(point.y, point.z);
			case Y -> new Point(point.x, point.z);
			case Z -> new Point(point.x, point.y);
		};
	}

	private static Vec3 unproject(Point point, Direction.Axis axis, double plane) {
		return switch (axis) {
			case X -> new Vec3(plane, point.u, point.v);
			case Y -> new Vec3(point.u, plane, point.v);
			case Z -> new Vec3(point.u, point.v, plane);
		};
	}

	private static double side(Point from, Point to, Point point) {
		return (to.u - from.u) * (point.v - from.v) - (to.v - from.v) * (point.u - from.u);
	}

	private static double area(List<Point> polygon) {
		double twice = 0.0D;
		Point origin = polygon.getFirst();
		for (int i = 1; i + 1 < polygon.size(); i++) {
			twice += side(origin, polygon.get(i), polygon.get(i + 1));
		}
		return Math.abs(twice) * 0.5D;
	}

	private static Point closest(List<Point> polygon, Point eye) {
		boolean inside = true;
		Point nearest = polygon.getFirst();
		for (int i = 0; i < polygon.size(); i++) {
			Point a = polygon.get(i), b = polygon.get((i + 1) % polygon.size());
			inside &= side(a, b, eye) >= 0.0D;
			double length = a.distanceSqr(b);
			double fraction = length == 0.0D ? 0.0D : ((eye.u - a.u) * (b.u - a.u) + (eye.v - a.v) * (b.v - a.v)) / length;
			Point point = a.toward(b, Math.max(0.0D, Math.min(1.0D, fraction)));
			if (point.distanceSqr(eye) < nearest.distanceSqr(eye)) nearest = point;
		}
		return inside ? eye : nearest;
	}

	/** Perspective projection of the part of an outline box between the eye and the target face. */
	private static List<Point> shadow(AABB box, Vec3 eye, Direction.Axis axis, double plane) {
		double distance = plane - eye.get(axis);
		double low = Math.max(1.0E-8D, Math.min((box.min(axis) - eye.get(axis)) / distance, (box.max(axis) - eye.get(axis)) / distance));
		double high = Math.min(1.0D, Math.max((box.min(axis) - eye.get(axis)) / distance, (box.max(axis) - eye.get(axis)) / distance));
		if (low > high) return List.of();
		Point origin = project(eye, axis);
		List<Point> points = new ArrayList<>();
		for (double depth : new double[]{low, high}) {
			for (double u : new double[]{0, 1}) {
				for (double v : new double[]{0, 1}) {
					Point corner = project(facePoint(box, axis, plane, u, v), axis);
					points.add(new Point(origin.u + (corner.u - origin.u) / depth, origin.v + (corner.v - origin.v) / depth));
				}
			}
		}
		points.sort(Comparator.comparingDouble(Point::u).thenComparingDouble(Point::v));
		List<Point> hull = new ArrayList<>();
		for (Point point : points) {
			while (hull.size() >= 2 && side(hull.get(hull.size() - 2), hull.getLast(), point) <= 0.0D) hull.removeLast();
			hull.add(point);
		}
		int lower = hull.size();
		for (int i = points.size() - 2; i >= 0; i--) {
			Point point = points.get(i);
			while (hull.size() > lower && side(hull.get(hull.size() - 2), hull.getLast(), point) <= 0.0D) hull.removeLast();
			hull.add(point);
		}
		hull.removeLast();
		return hull;
	}

	/** Partition polygon minus a convex shadow into convex pieces. */
	private static List<List<Point>> subtract(List<Point> polygon, List<Point> shadow) {
		List<List<Point>> outside = new ArrayList<>();
		List<Point> inside = polygon;
		for (int i = 0; i < shadow.size() && inside.size() >= 3; i++) {
			Point a = shadow.get(i), b = shadow.get((i + 1) % shadow.size());
			List<Point> piece = clip(inside, a, b, false);
			if (piece.size() >= 3 && area(piece) > 0.0D) outside.add(piece);
			inside = clip(inside, a, b, true);
		}
		return outside;
	}

	private static List<Point> clip(List<Point> polygon, Point a, Point b, boolean inside) {
		List<Point> output = new ArrayList<>();
		Point previous = polygon.getLast();
		double prior = side(a, b, previous) * (inside ? 1.0D : -1.0D);
		for (Point point : polygon) {
			double current = side(a, b, point) * (inside ? 1.0D : -1.0D);
			if ((prior >= 0.0D) != (current >= 0.0D)) output.add(previous.toward(point, prior / (prior - current)));
			if (current >= 0.0D) output.add(point);
			previous = point;
			prior = current;
		}
		return output;
	}

	private static double lerp(double from, double to, double fraction) {
		return from + (to - from) * fraction;
	}

	/**
	 * The world as one player knows it: {@link #knownState} is null for a cell never perceived (or forgotten), and
	 * rays treat such a cell as solid stone, so nothing is judged visible through terrain the player has not seen.
	 */
	abstract static class SeenWorld implements BlockGetter {
		private static final BlockState UNKNOWN = net.minecraft.world.level.block.Blocks.STONE.defaultBlockState();
		private final int minY;
		private final int height;

		SeenWorld(int minY, int height) {
			this.minY = minY;
			this.height = height;
		}

		abstract BlockState knownState(BlockPos position);

		@Override
		public BlockState getBlockState(BlockPos position) {
			BlockState state = knownState(position);
			return state == null ? UNKNOWN : state;
		}

		@Override
		public net.minecraft.world.level.material.FluidState getFluidState(BlockPos position) {
			return getBlockState(position).getFluidState();
		}

		@Override
		public net.minecraft.world.level.block.entity.BlockEntity getBlockEntity(BlockPos position) {
			return null;
		}

		@Override
		public int getHeight() {
			return height;
		}

		@Override
		public int getMinY() {
			return minY;
		}
	}
}
