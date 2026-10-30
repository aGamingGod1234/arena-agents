package dev.agaminggod.arenaagents.server.perception;

import dev.agaminggod.arenaagents.server.runtime.ServerActionObservation;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.RenderShape;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

/** Mutation-local evidence. Hidden neighbour states stay here, never in an observation or receipt. */
public final class BreakExposureEvidence {
	private BreakExposureEvidence() {
	}

	public static Snapshot capture(ServerLevel level, ServerPlayer player, BlockPos removed) {
		return capture(level, CollisionContext.of(player), player.getEyePosition(), player.getViewVector(1.0F), removed, level::hasChunkAt);
	}

	static Snapshot capture(BlockGetter level, CollisionContext context, Vec3 eye, Vec3 view, BlockPos removed,
			Predicate<BlockPos> loaded) {
		BlockState before = level.getBlockState(removed);
		// A visual collision ray alone cannot establish occlusion by transparent glass or leaves.
		if (!before.canOcclude()) return new Snapshot(level, context, eye, loaded, removed.immutable(), before, List.of());
		List<Candidate> candidates = new ArrayList<>(6);
		Vec3 normalizedView = view.normalize();
		for (Direction direction : Direction.values()) {
			BlockPos neighbour = removed.relative(direction);
			if (!loaded.test(neighbour)) continue;
			BlockState state = level.getBlockState(neighbour);
			if (state.isAir() || state.getRenderShape() == RenderShape.INVISIBLE) continue;
			List<Vec3> hiddenPoints = new ArrayList<>(5);
			for (Vec3 point : facePoints(neighbour, direction.getOpposite())) {
				if (!ObservationVisibility.isInFrontOfEye(eye, normalizedView, point)
						|| !ObservationVisibility.hasLoadedSightPath(eye, point, loaded)) continue;
				BlockHitResult hit = level.clip(new ClipContext(eye, point, ClipContext.Block.VISUAL, ClipContext.Fluid.NONE, context));
				if (hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(removed)
						&& !ObservationVisibility.lavaBetween(level, eye, hit.getLocation(), removed)) hiddenPoints.add(point);
			}
			if (!hiddenPoints.isEmpty()) candidates.add(new Candidate(neighbour, state, direction.getOpposite(), List.copyOf(hiddenPoints)));
		}
		return new Snapshot(level, context, eye, loaded, removed.immutable(), before, List.copyOf(candidates));
	}

	private static List<Vec3> facePoints(BlockPos position, Direction face) {
		List<Vec3> points = new ArrayList<>(5);
		points.add(facePoint(position, face, 0.5D, 0.5D));
		for (double a : new double[] { 0.2D, 0.8D }) {
			for (double b : new double[] { 0.2D, 0.8D }) points.add(facePoint(position, face, a, b));
		}
		return points;
	}

	private static Vec3 facePoint(BlockPos position, Direction face, double a, double b) {
		double plane = face.getAxisDirection() == Direction.AxisDirection.POSITIVE ? 0.999D : 0.001D;
		return switch (face.getAxis()) {
			case X -> new Vec3(position.getX() + plane, position.getY() + a, position.getZ() + b);
			case Y -> new Vec3(position.getX() + a, position.getY() + plane, position.getZ() + b);
			case Z -> new Vec3(position.getX() + a, position.getY() + b, position.getZ() + plane);
		};
	}

	private record Candidate(BlockPos position, BlockState state, Direction face, List<Vec3> points) {
	}

	public static final class Snapshot {
		private final BlockGetter level;
		private final CollisionContext context;
		private final Vec3 eye;
		private final Predicate<BlockPos> loaded;
		private final BlockPos removed;
		private final BlockState before;
		private final List<Candidate> candidates;

		private Snapshot(BlockGetter level, CollisionContext context, Vec3 eye, Predicate<BlockPos> loaded,
				BlockPos removed, BlockState before, List<Candidate> candidates) {
			this.level = level;
			this.context = context;
			this.eye = eye;
			this.loaded = loaded;
			this.removed = removed;
			this.before = before;
			this.candidates = candidates;
		}

		public List<ServerActionObservation.RevealedBlock> afterRemoval(boolean succeeded) {
			if (!succeeded || level.getBlockState(removed) == before) return List.of();
			List<ServerActionObservation.RevealedBlock> revealed = new ArrayList<>(6);
			for (Candidate candidate : candidates) {
				if (!loaded.test(candidate.position()) || level.getBlockState(candidate.position()) != candidate.state()) continue;
				for (Vec3 point : candidate.points()) {
					if (!ObservationVisibility.hasLoadedSightPath(eye, point, loaded)) continue;
					BlockHitResult hit = level.clip(new ClipContext(eye, point, ClipContext.Block.VISUAL, ClipContext.Fluid.NONE, context));
					if (hit.getType() != HitResult.Type.BLOCK || !hit.getBlockPos().equals(candidate.position())
							|| hit.getDirection() != candidate.face()
							|| ObservationVisibility.lavaBetween(level, eye, hit.getLocation(), candidate.position())) continue;
					revealed.add(new ServerActionObservation.RevealedBlock(
							new ServerActionObservation.Position(candidate.position().getX(), candidate.position().getY(), candidate.position().getZ()),
							BuiltInRegistries.BLOCK.getKey(candidate.state().getBlock()).toString(), candidate.face().getSerializedName()));
					break;
				}
			}
			return List.copyOf(revealed);
		}
	}
}
