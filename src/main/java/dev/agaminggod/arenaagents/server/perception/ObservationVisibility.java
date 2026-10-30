package dev.agaminggod.arenaagents.server.perception;

import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.RenderShape;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.material.Fluids;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

/** Human-equivalent visual gating for structured server observations. */
public final class ObservationVisibility {
	private static final double TOUCH_AWARENESS_DISTANCE_SQUARED = 4.0D;
	private static final double MINIMUM_VIEW_DOT = 0.25D;
	private static final double[] CELL_SAMPLE_HEIGHTS = {0.98D, 0.15D};

	private ObservationVisibility() {
	}

	public static boolean canSeeEntity(ServerPlayer observer, Entity entity) {
		Objects.requireNonNull(observer, "observer must not be null");
		Objects.requireNonNull(entity, "entity must not be null");
		return frame(observer.level(), observer).canSeeEntity(entity);
	}

	public static boolean canSeeBlock(ServerLevel level, ServerPlayer observer, BlockPos position) {
		Objects.requireNonNull(level, "level must not be null");
		Objects.requireNonNull(observer, "observer must not be null");
		Objects.requireNonNull(position, "position must not be null");
		return frame(level, observer).canSeeBlock(position);
	}

	/** Reuses observer geometry and block visibility within one observation collection. */
	public static Frame frame(ServerLevel level, ServerPlayer observer) {
		return new Frame(level, observer);
	}

	static boolean isWithinViewCone(Vec3 eye, Vec3 view, Vec3 target) {
		Objects.requireNonNull(eye, "eye must not be null");
		Objects.requireNonNull(view, "view must not be null");
		Objects.requireNonNull(target, "target must not be null");
		return isWithinNormalizedViewCone(
				eye,
				view.lengthSqr() == 0.0D ? Vec3.ZERO : view.normalize(),
				target
		);
	}

	private static boolean isWithinNormalizedViewCone(Vec3 eye, Vec3 normalizedView, Vec3 target) {
		if (target.subtract(eye).lengthSqr() <= TOUCH_AWARENESS_DISTANCE_SQUARED) return true;
		return isInFrontOfEye(eye, normalizedView, target);
	}

	/** The view cone alone, with no allowance for nearby cells behind the eye. */
	static boolean isInFrontOfEye(Vec3 eye, Vec3 normalizedView, Vec3 target) {
		Vec3 offset = target.subtract(eye);
		if (offset.lengthSqr() == 0.0D || normalizedView.lengthSqr() == 0.0D) return false;
		return offset.normalize().dot(normalizedView) >= MINIMUM_VIEW_DOT;
	}

	public static final class Frame {
		private final ServerLevel level;
		private final ServerPlayer observer;
		private final Vec3 eye;
		private final Vec3 normalizedView;
		private final Map<Long, Boolean> visibleBlocks = new HashMap<>();
		private final Map<Long, Boolean> seenCells = new HashMap<>();

		private Frame(ServerLevel level, ServerPlayer observer) {
			this.level = Objects.requireNonNull(level, "level must not be null");
			this.observer = Objects.requireNonNull(observer, "observer must not be null");
			this.eye = observer.getEyePosition();
			Vec3 view = observer.getViewVector(1.0F);
			this.normalizedView = view.lengthSqr() == 0.0D ? Vec3.ZERO : view.normalize();
		}

		public boolean isEntityWithinView(Entity entity) {
			Objects.requireNonNull(entity, "entity must not be null");
			if (entity instanceof net.minecraft.world.entity.boss.enderdragon.EnderDragon dragon && anyPart(dragon, this::isEntityWithinView)) return true;
			return !entity.isInvisibleTo(observer)
					&& isWithinNormalizedViewCone(eye, normalizedView, entity.getBoundingBox().getCenter());
		}

		/**
		 * The dragon's visible body is its parts: its root box centre sits inside them, and inside the fountain when it
		 * perches, so a player looking at its head from beside the fountain still sees the dragon.
		 */
		private static boolean anyPart(net.minecraft.world.entity.boss.enderdragon.EnderDragon dragon, java.util.function.Predicate<Entity> test) {
			var parts = dragon.getSubEntities();
			if (parts != null) for (var part : parts) if (part != null && test.test(part)) return true;
			return false;
		}

		public boolean hasLineOfSight(Entity entity) {
			Objects.requireNonNull(entity, "entity must not be null");
			if (entity instanceof net.minecraft.world.entity.boss.enderdragon.EnderDragon dragon && anyPart(dragon, this::hasLineOfSight)) return true;
			CollisionContext context = CollisionContext.of(observer);
			return EntityHitboxSight.point(eye, entity.getBoundingBox(), point -> {
				Vec3 hit = EntityHitboxSight.intersection(eye, point, entity.getBoundingBox());
				return hit != null && hasLoadedSightPath(eye, hit, level::hasChunkAt)
						&& EntityHitboxSight.clear(level, context, eye, hit, ClipContext.Block.VISUAL)
						&& !lavaBetween(level, eye, hit, null);
			}) != null;
		}

		public boolean canSeeEntity(Entity entity) {
			return isEntityWithinView(entity) && hasLineOfSight(entity);
		}

		/** Visual details have no nearby touch-awareness exception, including behind the viewer. */
		public boolean canSeeAppearance(Entity entity) {
			return !entity.isInvisibleTo(observer)
					&& observer.distanceToSqr(entity) <= 128.0D * 128.0D
					&& (isInFrontOfEye(eye, normalizedView, entity.getBoundingBox().getCenter())
							|| entity instanceof net.minecraft.world.entity.boss.enderdragon.EnderDragon dragon
									&& anyPart(dragon, part -> isInFrontOfEye(eye, normalizedView, part.getBoundingBox().getCenter())))
					&& hasLineOfSight(entity);
		}

		public boolean canSeeBlock(BlockPos position) {
			Objects.requireNonNull(position, "position must not be null");
			return isBlockWithinView(position) && hasLineOfSight(position);
		}

		public boolean isBlockWithinView(BlockPos position) {
			return isWithinNormalizedViewCone(
					eye, normalizedView, Vec3.atCenterOf(Objects.requireNonNull(position, "position must not be null")));
		}

		public boolean hasLineOfSight(BlockPos position) {
			Objects.requireNonNull(position, "position must not be null");
			return memoizedBlockVisibility(visibleBlocks, position, this::traceBlock);
		}

		private boolean traceBlock(BlockPos position) {
			if (!hasLoadedSightPath(eye, Vec3.atCenterOf(position), level::hasChunkAt)) return false;
			return ObservationVisibility.traceBlock(level, CollisionContext.of(observer), eye, position);
		}

		/** Whether other lava stands between this eye and the cell's centre (lava is opaque). */
		public boolean lavaHides(BlockPos position) {
			Objects.requireNonNull(position, "position must not be null");
			return lavaBetween(level, eye, Vec3.atCenterOf(position), position);
		}

		/** {@link ObservationVisibility#seesCell} from this eye; open air counts, lava hides what is behind it. */
		public boolean seesCell(BlockPos position) {
			Objects.requireNonNull(position, "position must not be null");
			return memoizedBlockVisibility(seenCells, position, cell -> hasLoadedSightPath(eye, Vec3.atCenterOf(cell), level::hasChunkAt)
					&& ObservationVisibility.seesCell(level, CollisionContext.of(observer), eye, normalizedView, cell));
		}
	}

	/**
	 * Whether the eye sees this cell, whatever it holds (open air included): in the view cone, with no block and no lava
	 * in between. Unlike block rows there is no touch allowance: being close says nothing about the empty cells and
	 * landings behind the eye. Lava is opaque. For blocks, also test the actual view ray and shared hitbox sight
	 * samples across their shape, including lower edges. Air still needs evidence of the opening's depth.
	 */
	static boolean seesCell(BlockGetter level, CollisionContext context, Vec3 eye, Vec3 normalizedView, BlockPos position) {
		Vec3 center = Vec3.atCenterOf(position);
		if (isInFrontOfEye(eye, normalizedView, center) && seesPoint(level, context, eye, position, center)) return true;
		// A nearby opening can be in view at its lower interior while its centre is above the view cone. Checking
		// only the centre and top left jump headroom unknown even beside a plainly visible one-block bank.
		for (double dy : CELL_SAMPLE_HEIGHTS) {
			for (double dx = 0.15D; dx < 1.0D; dx += 0.7D) {
				for (double dz = 0.15D; dz < 1.0D; dz += 0.7D) {
					Vec3 sample = new Vec3(position.getX() + dx, position.getY() + dy, position.getZ() + dz);
					if (isInFrontOfEye(eye, normalizedView, sample) && seesPoint(level, context, eye, position, sample)) return true;
				}
			}
		}
		BlockState state = level.getBlockState(position);
		// A glimpse at an empty cell's near boundary does not establish the depth of that opening.
		if (state.isAir()) return false;
		for (AABB local : state.getShape(level, position, context).toAabbs()) {
			AABB box = local.move(position);
			Vec3 viewHit = EntityHitboxSight.intersection(eye, eye.add(normalizedView.scale(eye.distanceTo(box.getCenter()) + 2D)), box);
			if (viewHit != null && isInFrontOfEye(eye, normalizedView, viewHit)
					&& seesPoint(level, context, eye, position, viewHit)) return true;
			if (EntityHitboxSight.point(eye, box, point -> isInFrontOfEye(eye, normalizedView, point)
					&& seesPoint(level, context, eye, position, point)) != null) return true;
		}
		return false;
	}

	private static boolean seesPoint(BlockGetter level, CollisionContext context, Vec3 eye, BlockPos position, Vec3 target) {
		BlockHitResult hit = level.clip(new ClipContext(eye, target, ClipContext.Block.VISUAL, ClipContext.Fluid.NONE, context) {
			@Override public net.minecraft.world.phys.shapes.VoxelShape getBlockShape(BlockState state, BlockGetter world, BlockPos cell) {
				// Terrain footing includes the backing surface of a zero-collision snow dusting. Ignore only the
				// target's own coating, never intervening snow, leaves, thicker cover or an opaque block.
				if (cell.getX() == position.getX() && cell.getZ() == position.getZ() && cell.getY() == position.getY() + 1
						&& state.is(Blocks.SNOW) && state.getValue(BlockStateProperties.LAYERS) == 1) {
					return net.minecraft.world.phys.shapes.Shapes.empty();
				}
				return super.getBlockShape(state, world, cell);
			}
		});
		if (hit.getType() != HitResult.Type.MISS && !hit.getBlockPos().equals(position)) return false;
		return !lavaBetween(level, eye, target, position);
	}

	/** Whether the segment passes through lava in any cell but the target's own. */
	public static boolean lavaBetween(BlockGetter level, Vec3 from, Vec3 to, BlockPos target) {
		return BlockGetter.traverseBlocks(from, to, level, (getter, cell) -> {
			if (cell.equals(target)) return null;
			FluidState fluid = getter.getFluidState(cell);
			if (!Fluids.LAVA.isSame(fluid.getType()) || fluid.getShape(getter, cell).clip(from, to, cell) == null) return null;
			return Boolean.TRUE;
		}, getter -> Boolean.FALSE);
	}

	static boolean hasLoadedSightPath(Vec3 origin, Vec3 target, Predicate<BlockPos> loaded) {
		Vec3 delta = target.subtract(origin);
		double distance = delta.length();
		Vec3 direction = delta.normalize();
		Vec3 endpoint = ServerObservationCollector.loadedSightEndpoint(origin, direction, distance, loaded);
		return origin.add(direction.scale(distance)).equals(endpoint);
	}

	static boolean traceBlock(BlockGetter level, CollisionContext context, Vec3 eye, BlockPos position) {
		BlockHitResult hit = level.clip(new ClipContext(
				eye, Vec3.atCenterOf(position), ClipContext.Block.VISUAL, ClipContext.Fluid.NONE, context));
		// Fluids and partial visual shapes can leave a clear ray without a block hit.
		if (hit.getType() != HitResult.Type.MISS) return hit.getBlockPos().equals(position);
		BlockState state = level.getBlockState(position);
		return !state.isAir()
				&& (state.getRenderShape() != RenderShape.INVISIBLE || !state.getFluidState().isEmpty()
						// End portal surfaces are drawn by block-entity renderers, despite an invisible block model.
						|| state.is(Blocks.END_PORTAL) || state.is(Blocks.END_GATEWAY));
	}

	static boolean memoizedBlockVisibility(
			Map<Long, Boolean> visibleBlocks,
			BlockPos position,
			Predicate<BlockPos> trace
	) {
		Objects.requireNonNull(visibleBlocks, "visibleBlocks must not be null");
		Objects.requireNonNull(position, "position must not be null");
		Objects.requireNonNull(trace, "trace must not be null");
		long key = position.asLong();
		Boolean cached = visibleBlocks.get(key);
		if (cached != null || visibleBlocks.containsKey(key)) return Boolean.TRUE.equals(cached);
		boolean visible = trace.test(position);
		visibleBlocks.put(key, visible);
		return visible;
	}
}
