package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import dev.agaminggod.arenaagents.client.navigation.TraversalType;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.entity.BlockEntity;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import net.minecraft.core.BlockPos;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.Registries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.item.enchantment.Enchantments;
import net.minecraft.world.item.enchantment.EnchantmentHelper;
import net.minecraft.world.item.enchantment.ItemEnchantments;
import dev.agaminggod.arenaagents.client.navigation.MovementCosts;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.FluidTags;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.Shapes;
import net.minecraft.world.phys.shapes.BooleanOp;
import net.minecraft.world.phys.shapes.VoxelShape;

import it.unimi.dsi.fastutil.longs.Long2DoubleOpenHashMap;
import it.unimi.dsi.fastutil.longs.Long2IntOpenHashMap;
import java.util.HashMap;
import java.util.Map;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import net.minecraft.util.Mth;

/**
 * Acquired terrain used by navigation: unknown cells stay unknown, and remembered cells keep their last seen value.
 */
public final class MinecraftNavigationWorld implements WalkabilityView {
	private static final double[] FOOTPRINT_SAMPLES = {0.2D, 0.5D, 0.8D};
	private static final Direction[] HORIZONTAL_DIRECTIONS = {Direction.WEST, Direction.EAST, Direction.NORTH, Direction.SOUTH};

	private final BlockGetter level;
	private SeenTerrain.Reader<BlockState> seen;
	private Integer movementLevel;
	private SeenTerrain.Stamp stamp;
	private long knownUntil = Long.MAX_VALUE;
	private final Long2ObjectOpenHashMap<BlockState> states = new Long2ObjectOpenHashMap<>();
	private boolean geometryUnknown;
	private boolean geometryConsulted;
	private boolean refreshCached;
	private final LongOpenHashSet refreshed = new LongOpenHashSet();
	private final LongOpenHashSet shapeDependencies = new LongOpenHashSet();
	private final BlockGetter geometry = new BlockGetter() {
		@Override public BlockEntity getBlockEntity(BlockPos position) {
			geometryConsulted = true;
			geometryUnknown = true;
			unknownRead = true;
			return null;
		}
		@Override public BlockState getBlockState(BlockPos position) {
			geometryConsulted = true;
			BlockState state = stateAt(position);
			if (state == null) geometryUnknown = true;
			return state == null ? Blocks.AIR.defaultBlockState() : state;
		}
		@Override public FluidState getFluidState(BlockPos position) { return getBlockState(position).getFluidState(); }
		@Override public int getHeight() { return level.getHeight(); }
		@Override public int getMinY() { return level.getMinY(); }
	};
	private Set<GridPosition> portalEntries = Set.of();
	private final ItemEnchantments bootsEnchantments;
	private final int soulSpeedLevel;
	private final boolean weaving;
	private final boolean magmaProtected;
	private final boolean frostWalker;
	private final double maxJumpRise;
	private boolean blockedMagma;
	// Asked for every search edge: primitive maps keyed by packed position, no boxing.
	private final Long2DoubleOpenHashMap movementSpeeds = new Long2DoubleOpenHashMap();
	private final Long2IntOpenHashMap exposureCosts = new Long2IntOpenHashMap();
	private static final class CellSample {
		Cell cell;
		long frame;
		CellSample(Cell cell, long frame) { this.cell = cell; this.frame = frame; }
	}
	private long frame;
	private final Map<GridPosition, CellSample> cells = new HashMap<>();
	private final Map<GridPosition, Boolean> shallowWater = new HashMap<>();
	private boolean unknownRead;
	private long cacheHits;
	private long cacheMisses;

	public MinecraftNavigationWorld(ServerLevel level, ServerPlayer player) {
		this(level, SeenTerrain.of(player), player);
	}

	MinecraftNavigationWorld(BlockGetter level, SeenTerrain.Reader<BlockState> seen) {
		this(level, seen, null);
	}

	private MinecraftNavigationWorld(BlockGetter level, SeenTerrain.Reader<BlockState> seen, ServerPlayer player) {
		this.level = Objects.requireNonNull(level, "level must not be null");
		this.seen = Objects.requireNonNull(seen, "seen must not be null");
		stamp = seen.stamp();
		bootsEnchantments = player == null ? ItemEnchantments.EMPTY
				: player.getItemBySlot(EquipmentSlot.FEET).getOrDefault(DataComponents.ENCHANTMENTS, ItemEnchantments.EMPTY);
		soulSpeedLevel = player == null ? 0 : soulSpeedLevel(player);
		weaving = player != null && player.hasEffect(MobEffects.WEAVING);
		var frostEnchantment = player == null ? null : player.level().registryAccess().lookupOrThrow(Registries.ENCHANTMENT)
				.get(Enchantments.FROST_WALKER).orElse(null);
		frostWalker = frostEnchantment != null
				&& EnchantmentHelper.getItemEnchantmentLevel(frostEnchantment, player.getItemBySlot(EquipmentSlot.FEET)) > 0;
		magmaProtected = player != null && (player.hasEffect(MobEffects.FIRE_RESISTANCE) || frostWalker);
		// Jump Boost raises the reachable rise; leave boosted bodies to the grid rule rather than guess their apex.
		maxJumpRise = player != null && player.hasEffect(MobEffects.JUMP_BOOST) ? Double.POSITIVE_INFINITY : UNBOOSTED_JUMP_RISE;
		movementSpeeds.defaultReturnValue(Double.NaN);
		exposureCosts.defaultReturnValue(-1);
	}

	boolean blockedMagma() { return blockedMagma; }

	/** Magma is safe footing for this body: Fire Resistance or Frost Walker boots. */
	static boolean magmaProtected(ServerPlayer player) {
		if (player.hasEffect(MobEffects.FIRE_RESISTANCE)) return true;
		var frost = player.level().registryAccess().lookupOrThrow(Registries.ENCHANTMENT).get(Enchantments.FROST_WALKER).orElse(null);
		return frost != null && EnchantmentHelper.getItemEnchantmentLevel(frost, player.getItemBySlot(EquipmentSlot.FEET)) > 0;
	}

	/** Soul Speed level of this body's boots. */
	static int soulSpeedLevel(ServerPlayer player) {
		var soulSpeed = player.level().registryAccess().lookupOrThrow(Registries.ENCHANTMENT).get(Enchantments.SOUL_SPEED).orElse(null);
		return soulSpeed == null ? 0 : EnchantmentHelper.getItemEnchantmentLevel(soulSpeed, player.getItemBySlot(EquipmentSlot.FEET));
	}

	boolean matchesMovement(ServerPlayer player) {
		return bootsEnchantments.equals(player.getItemBySlot(EquipmentSlot.FEET)
				.getOrDefault(DataComponents.ENCHANTMENTS, ItemEnchantments.EMPTY))
				&& weaving == player.hasEffect(MobEffects.WEAVING)
				&& magmaProtected == (player.hasEffect(MobEffects.FIRE_RESISTANCE) || frostWalker)
				// The jump limit is captured at construction; gaining or losing Jump Boost changes which rises are jumps.
				&& (maxJumpRise == Double.POSITIVE_INFINITY) == player.hasEffect(MobEffects.JUMP_BOOST);
	}

	@Override
	public boolean allowsShortFrontiers() { return true; }

	@Override
	public double movementSpeedMultiplier(GridPosition position) {
		long key = BlockPos.asLong(position.x(), position.y(), position.z());
		double speed = movementSpeeds.get(key);
		if (!Double.isNaN(speed)) return speed;
		speed = cellAt(position) == Cell.UNLOADED ? 1.0D
				: movementSpeed(stateAt(position.x(), position.y(), position.z()), stateAt(position.x(), position.y() + 1, position.z()),
						stateAt(position.x(), position.y() - 1, position.z()), soulSpeedLevel, weaving);
		movementSpeeds.put(key, speed);
		return speed;
	}

	static double movementSpeed(BlockState feet, BlockState head, BlockState support, int soulSpeedLevel, boolean weaving) {
		if (feet == null || head == null || support == null) return 1.0D;
		if (feet.is(Blocks.WATER) || feet.is(Blocks.BUBBLE_COLUMN)) return 1.0D;
		if (feet.is(Blocks.COBWEB) || head.is(Blocks.COBWEB)) return MovementCosts.cobwebSpeedMultiplier(weaving);
		int soulBoost = (soulSpeedGround(feet) || soulSpeedGround(support)) ? soulSpeedLevel : 0;
		double factor = feet.getBlock().getSpeedFactor();
		if (factor == 1.0D) factor = support.getBlock().getSpeedFactor();
		if (soulBoost > 0) factor = 1.0D;
		return MovementCosts.groundSpeedMultiplier(factor, soulBoost);
	}

	private static boolean soulSpeedGround(BlockState state) {
		return state.is(Blocks.SOUL_SAND) || state.is(Blocks.SOUL_SOIL) || state.is(BlockTags.SOUL_SPEED_BLOCKS);
	}

	/** Limit a commanded deck pickup without altering acquired block facts. */
	MinecraftNavigationWorld onLevel(int y) {
		movementLevel = y;
		return this;
	}

	@Override
	public boolean canJumpFrom(GridPosition position) {
		if (movementLevel != null) return false;
		BlockState feet = stateAt(position.x(), position.y(), position.z());
		BlockState head = stateAt(position.x(), position.y() + 1, position.z());
		BlockState support = stateAt(position.x(), position.y() - 1, position.z());
		return feet != null && head != null && support != null && canJump(feet, head, support);
	}

	/** A vanilla jump without Jump Boost lifts the feet about 1.2522 blocks: a slab onto a full block (1.5) is out of reach. */
	static final double UNBOOSTED_JUMP_RISE = 1.2522D;

	@Override
	public boolean requiresJump(GridPosition from, GridPosition to) {
		return nearFaceHeight(from, to) - footprintHeight(from, true) > 0.6D;
	}

	@Override
	public boolean canJumpUp(GridPosition from, GridPosition to) {
		if (!canJumpFrom(from)) return false;
		// The body jumps from the highest point it can stand on and must clear the landing cell's near face, the row of
		// footprint samples it crosses first: a stair whose low tread faces the approach is reachable, then a normal
		// step-up; one whose tall half faces it is not, whatever its far tread. Cell centres alone get both wrong.
		double takeoff = footprintHeight(from, true);
		if (!jumpRiseFeasible(takeoff, nearFaceHeight(from, to), maxJumpRise)) return false;
		Boolean swept = sweptJump(from, to);
		if (swept != null) return swept;
		return !diagonalCornerBlocked(from, to, takeoff);
	}

	@Override
	public boolean canJumpGap(GridPosition from, GridPosition to) {
		// Endpoint clearance alone misses a ceiling above the empty trench: the jump hits it and falls.
		return canJumpFrom(from) && Boolean.TRUE.equals(sweptJump(from, to));
	}

	/**
	 * Approaches a jump is tried with, cheapest to find first: steering at the landing centre at a walk-to-sprint 0.25
	 * blocks per tick, holding the heading at a slow 0.1, then the other pairing of each. (In the first review sweep the
	 * first two covered every reachable jump; the other two are kept for shapes outside it.)
	 */
	private static final double[] JUMP_SPEEDS = {0.25D, 0.1D, 0.1D, 0.25D};
	private static final boolean[] JUMP_HOLDS_HEADING = {false, true, false, true};
	private static final int JUMP_TICKS = 45;
	private static final byte JUMP_UNDECIDED = 0, JUMP_REACHES = 1, JUMP_BLOCKED = 2;
	private record JumpPair(GridPosition from, GridPosition to) { }
	private final Map<JumpPair, Byte> sweptJumps = new HashMap<>();

	/**
	 * Whether the 0.6 by 1.8 body can complete this jump against the acquired collision shapes: it jumps from the middle
	 * of the takeoff cell, rises and falls as vanilla does (0.42 up; a floor or ceiling hit stops vertical motion; then
	 * 0.08 gravity and 0.98 drag every tick) while it moves toward the landing cell, collides axis by axis like
	 * Entity.collide with shapes read for the body's current height (scaffolding is solid only from above), and steps up
	 * to 0.6 on the ground (a low stair tread, then the upper one). Tried steering at the landing centre and holding the jump's heading, from
	 * a slow approach to a sprint; any that ends standing in the landing cell admits the jump. Null (keep the grid rule)
	 * when Jump Boost changes the arc, any cell the body could touch is unknown, or it holds powder snow (whose collision
	 * depends on boots and falling the planner does not model). Cached per cell pair for the frame.
	 */
	private Boolean sweptJump(GridPosition from, GridPosition to) {
		if (!Double.isFinite(maxJumpRise)) return null;
		JumpPair key = new JumpPair(from, to);
		Byte cached = sweptJumps.get(key);
		if (cached == null) {
			cached = simulateJump(from, to);
			sweptJumps.put(key, cached);
		}
		return cached == JUMP_UNDECIDED ? null : cached == JUMP_REACHES;
	}

	private byte simulateJump(GridPosition from, GridPosition to) {
		byte open = openJump(from, to);
		if (open != JUMP_BLOCKED) return open;
		int minX = Math.min(from.x(), to.x()) - 1, maxX = Math.max(from.x(), to.x()) + 1;
		int minZ = Math.min(from.z(), to.z()) - 1, maxZ = Math.max(from.z(), to.z()) + 1;
		int minY = from.y() - 1, maxY = to.y() + 2;
		java.util.List<VoxelShape> found = new java.util.ArrayList<>();
		java.util.List<BodyShaped> contextual = new java.util.ArrayList<>();
		for (int x = minX; x <= maxX; x++) {
			for (int y = minY; y <= maxY; y++) {
				for (int z = minZ; z <= maxZ; z++) {
					if (level.isOutsideBuildHeight(y)) continue;
					BlockPos position = new BlockPos(x, y, z);
					BlockState state = stateAt(position);
					VoxelShape shape = state == null ? null : shapeAt(state, position);
					if (shape == null || state.getBlock() instanceof net.minecraft.world.level.block.PowderSnowBlock) return JUMP_UNDECIDED;
					if (bodyDependent(state, position)) contextual.add(new BodyShaped(state, position));
					else if (!shape.isEmpty()) found.add(shape.move(x, y, z));
				}
			}
		}
		double feet = supportHeight(from, from.x() + 0.5D, from.z() + 0.5D);
		double landing = supportHeight(to, to.x() + 0.5D, to.z() + 0.5D);
		if (!Double.isFinite(landing)) landing = footprintHeight(to, false);
		if (!Double.isFinite(feet) || !Double.isFinite(landing)) return JUMP_UNDECIDED;
		Obstacles fixed = new Obstacles(found);
		// A body that does not fit where it stands cannot start this jump.
		AABB start = new AABB(from.x() + 0.2D, feet, from.z() + 0.2D, from.x() + 0.8D, feet + 1.8D, from.z() + 0.8D);
		for (int index = 0; index < found.size(); index++) {
			if (fixed.bounds[index].intersects(start) && Shapes.joinIsNotEmpty(Shapes.create(start), found.get(index), BooleanOp.AND)) return JUMP_BLOCKED;
		}
		java.util.function.Function<AABB, Obstacles> shapes = contextual.isEmpty() ? body -> fixed : body -> {
			// Scaffolding and similar shapes depend on where the body is: read them for this tick's body, as vanilla does.
			java.util.List<VoxelShape> now = new java.util.ArrayList<>(found);
			BodyContext context = new BodyContext(body.minY);
			for (BodyShaped cell : contextual) {
				VoxelShape shape = cell.state().getCollisionShape(geometry, cell.position(), context);
				if (!shape.isEmpty()) now.add(shape.move(cell.position().getX(), cell.position().getY(), cell.position().getZ()));
			}
			return new Obstacles(now);
		};
		for (int index = 0; index < JUMP_SPEEDS.length; index++) {
			if (jumpReaches(shapes, from, to, feet, landing, JUMP_SPEEDS[index], JUMP_HOLDS_HEADING[index])) return JUMP_REACHES;
		}
		return JUMP_BLOCKED;
	}

	private record BodyShaped(BlockState state, BlockPos position) { }

	/** Whether a block's collision depends on where the body is, as scaffolding's does (solid only from above). */
	private boolean bodyDependent(BlockState state, BlockPos position) {
		VoxelShape above = state.getCollisionShape(geometry, position, new BodyContext(Double.POSITIVE_INFINITY));
		VoxelShape below = state.getCollisionShape(geometry, position, new BodyContext(Double.NEGATIVE_INFINITY));
		return Shapes.joinIsNotEmpty(above, below, BooleanOp.NOT_SAME);
	}

	/** The collision context of a standing player body whose feet are at {@code bottom}, not sneaking. */
	private record BodyContext(double bottom) implements net.minecraft.world.phys.shapes.CollisionContext {
		@Override public boolean isDescending() { return false; }
		@Override public boolean isAbove(VoxelShape shape, BlockPos position, boolean canAscend) {
			return bottom > position.getY() + shape.max(Direction.Axis.Y) - (double) 1.0E-5F;
		}
		@Override public boolean isHoldingItem(net.minecraft.world.item.Item item) { return false; }
		@Override public boolean alwaysCollideWithFluid() { return false; }
		@Override public boolean canStandOnFluid(FluidState above, FluidState fluid) { return false; }
		@Override public VoxelShape getCollisionShape(BlockState state, net.minecraft.world.level.CollisionGetter getter, BlockPos position) {
			return state.getCollisionShape(getter, position, this);
		}
	}

	/**
	 * The common jump needs no trajectory: takeoff and landing blocks each with one flat top over the whole cell (a full
	 * block or slab), no side support above the takeoff feet on a diagonal, and nothing with collision anywhere else the
	 * body can be, from the takeoff feet cell up to the head at the top of the jump (three cells above it). The rise was already checked, so the body
	 * clears the landing's top and lands on it. JUMP_BLOCKED here means only "simulate"; undecided when a cell is unknown.
	 */
	private byte openJump(GridPosition from, GridPosition to) {
		if (Math.abs(to.x() - from.x()) > 1 || Math.abs(to.z() - from.z()) > 1) return JUMP_BLOCKED;
		int stepX = Integer.signum(to.x() - from.x()), stepZ = Integer.signum(to.z() - from.z());
		double feet = flatTop(new BlockPos(from.x(), from.y() - 1, from.z()));
		double landing = flatTop(new BlockPos(to.x(), to.y() - 1, to.z()));
		if (Double.isNaN(feet) || Double.isNaN(landing)) return JUMP_UNDECIDED;
		if (feet < 0.0D || landing < 0.0D) return JUMP_BLOCKED;
		for (int dx = Math.min(0, stepX); dx <= Math.max(0, stepX); dx++) {
			for (int dz = Math.min(0, stepZ); dz <= Math.max(0, stepZ); dz++) {
				boolean takeoff = dx == 0 && dz == 0, target = dx == stepX && dz == stepZ;
				int x = from.x() + dx, z = from.z() + dz;
				if (!takeoff && !target) {
					// A side cell of a diagonal: its support must stay under the takeoff feet.
					BlockPos below = new BlockPos(x, from.y() - 1, z);
					BlockState state = stateAt(below);
					VoxelShape shape = state == null ? null : shapeAt(state, below);
					if (shape == null) return JUMP_UNDECIDED;
					if (!shape.isEmpty() && below.getY() + shape.max(Direction.Axis.Y) > feet + 1.0E-7D) return JUMP_BLOCKED;
				}
				// The head at the top of a jump from a full block reaches 0.05 into the fourth cell up.
				for (int y = from.y(); y <= from.y() + 3; y++) {
					if (target && y == to.y() - 1) continue;
					BlockPos position = new BlockPos(x, y, z);
					BlockState state = stateAt(position);
					VoxelShape shape = state == null ? null : shapeAt(state, position);
					if (shape == null || state.getBlock() instanceof net.minecraft.world.level.block.PowderSnowBlock) return JUMP_UNDECIDED;
					if (!shape.isEmpty() || bodyDependent(state, position)) return JUMP_BLOCKED;
				}
			}
		}
		return JUMP_REACHES;
	}

	/** World height of a block's single flat top covering its whole cell; -1 for any other shape, NaN when unknown. */
	private double flatTop(BlockPos position) {
		BlockState state = stateAt(position);
		VoxelShape shape = state == null ? null : shapeAt(state, position);
		if (shape == null) return Double.NaN;
		java.util.List<AABB> boxes = shape.toAabbs();
		if (boxes.size() != 1) return -1.0D;
		AABB box = boxes.getFirst();
		return box.minX == 0.0D && box.minZ == 0.0D && box.maxX == 1.0D && box.maxZ == 1.0D ? position.getY() + box.maxY : -1.0D;
	}

	/** One jump trajectory; true when the body ends standing in the landing cell at or above its landing height. */
	static boolean jumpReaches(java.util.function.Function<AABB, Obstacles> shapesFor, GridPosition from, GridPosition to, double feet, double landing,
			double speed, boolean holdHeading) {
		AABB body = new AABB(from.x() + 0.2D, feet, from.z() + 0.2D, from.x() + 0.8D, feet + 1.8D, from.z() + 0.8D);
		double targetX = to.x() + 0.5D, targetZ = to.z() + 0.5D;
		Vec3 heading = new Vec3(to.x() - from.x(), 0.0D, to.z() - from.z()).normalize().scale(speed);
		double margin = holdHeading ? 0.499999D : 0.2D;
		double velocityY = (double) 0.42F;
		// The jump starts from the ground, so the first tick may step up like any grounded move.
		boolean grounded = true;
		boolean reached = false;
		int still = 0;
		for (int tick = 0; tick < JUMP_TICKS; tick++) {
			Vec3 centre = body.getCenter();
			if (Math.abs(centre.x - targetX) <= margin + 1.0E-7D && Math.abs(centre.z - targetZ) <= margin + 1.0E-7D
					&& body.minY >= landing - 1.0E-7D) reached = true;
			// Standing in the landing cell, the jump is done.
			if (reached && grounded && tick > 0) return body.minY >= landing - 1.0E-7D;
			Vec3 horizontal;
			if (reached) {
				horizontal = Vec3.ZERO;
			} else if (holdHeading) {
				horizontal = heading;
			} else {
				Vec3 toward = new Vec3(targetX - centre.x, 0.0D, targetZ - centre.z);
				double distance = toward.horizontalDistance();
				horizontal = distance == 0.0D ? Vec3.ZERO : toward.scale(Math.min(speed, distance) / distance);
			}
			Vec3 desired = new Vec3(horizontal.x, velocityY, horizontal.z);
			Obstacles shapes = shapesFor.apply(body);
			Vec3 moved = collide(desired, body, shapes);
			boolean landed = velocityY < 0.0D && moved.y != velocityY;
			if ((landed || grounded) && moved.horizontalDistanceSqr() < desired.horizontalDistanceSqr()) {
				AABB base = landed ? body.move(0.0D, moved.y, 0.0D) : body;
				Vec3 stepped = stepUp(desired, base, shapes, (float) moved.y, landed, moved);
				if (stepped != null) moved = stepped.subtract(0.0D, body.minY - base.minY, 0.0D);
			}
			// Held on the ground with no horizontal progress, the body repeats the same two ticks forever.
			still = !reached && moved.horizontalDistanceSqr() == 0.0D ? still + 1 : 0;
			if (still >= 3 && (landed || grounded)) return false;
			body = body.move(moved);
			// Entity.move: any vertical collision (floor or ceiling, including a step up) stops vertical motion; then
			// LivingEntity applies gravity and drag every tick.
			boolean vertical = moved.y != velocityY;
			grounded = vertical && velocityY < 0.0D;
			velocityY = ((vertical ? 0.0D : velocityY) - 0.08D) * (double) 0.98F;
		}
		return reached && grounded && body.minY >= landing - 1.0E-7D;
	}

	/** Collision shapes near a jump with their bounds, boxes and Y coordinates read once. */
	static final class Obstacles {
		final java.util.List<VoxelShape> shapes;
		final AABB[] bounds;
		final java.util.List<java.util.List<AABB>> boxes = new java.util.ArrayList<>();
		final double[][] yCoords;

		Obstacles(java.util.List<VoxelShape> shapes) {
			this.shapes = shapes;
			bounds = new AABB[shapes.size()];
			yCoords = new double[shapes.size()][];
			for (int index = 0; index < shapes.size(); index++) {
				bounds[index] = shapes.get(index).bounds();
				boxes.add(shapes.get(index).toAabbs());
				yCoords[index] = shapes.get(index).getCoords(Direction.Axis.Y).toDoubleArray();
			}
		}
	}

	/**
	 * Entity.collideWithShapes: each axis in vanilla's step order against the shapes. Like vanilla's collision query, only
	 * shapes whose bounds meet the box swept by the whole move are consulted (others cannot change any axis).
	 */
	static Vec3 collide(Vec3 movement, AABB box, Obstacles shapes) {
		AABB swept = box.expandTowards(movement).inflate(1.0E-6D);
		java.util.List<VoxelShape> near = new java.util.ArrayList<>(4);
		for (int index = 0; index < shapes.shapes.size(); index++) if (shapes.bounds[index].intersects(swept)) near.add(shapes.shapes.get(index));
		if (near.isEmpty()) return movement;
		Vec3 result = Vec3.ZERO;
		for (Direction.Axis axis : Direction.axisStepOrder(movement)) {
			double distance = movement.get(axis);
			if (distance == 0.0D) continue;
			result = result.with(axis, Shapes.collide(axis, box.move(result), near, distance));
		}
		return result;
	}

	/**
	 * Entity's step-up on the ground: among the shapes the move sweeps, try each top up to 0.6 above the feet (vanilla's
	 * candidate heights, lowest first) and keep the first that goes farther than the plain move; null when none does.
	 */
	private static Vec3 stepUp(Vec3 desired, AABB base, Obstacles shapes, float movedY, boolean landed, Vec3 moved) {
		AABB swept = base.expandTowards(desired.x, 0.6F, desired.z);
		if (!landed) swept = swept.expandTowards(0.0D, -(double) 1.0E-5F, 0.0D);
		java.util.List<VoxelShape> near = new java.util.ArrayList<>();
		java.util.List<double[]> nearTops = new java.util.ArrayList<>();
		for (int index = 0; index < shapes.shapes.size(); index++) {
			if (!shapes.bounds[index].intersects(swept)) continue;
			for (AABB box : shapes.boxes.get(index)) {
				if (box.intersects(swept)) {
					near.add(shapes.shapes.get(index));
					nearTops.add(shapes.yCoords[index]);
					break;
				}
			}
		}
		it.unimi.dsi.fastutil.floats.FloatArraySet heights = new it.unimi.dsi.fastutil.floats.FloatArraySet(4);
		for (double[] tops : nearTops) {
			for (double y : tops) {
				float height = (float) (y - base.minY);
				if (height < 0.0F || height == movedY) continue;
				if (height > 0.6F) break;
				heights.add(height);
			}
		}
		float[] candidates = heights.toFloatArray();
		it.unimi.dsi.fastutil.floats.FloatArrays.unstableSort(candidates);
		Obstacles stepShapes = new Obstacles(near);
		for (float height : candidates) {
			Vec3 candidate = collide(new Vec3(desired.x, height, desired.z), base, stepShapes);
			if (candidate.horizontalDistanceSqr() > moved.horizontalDistanceSqr()) return candidate;
		}
		return null;
	}

	/** How far into each side cell, from the shared corner, a 0.6-wide body cutting a diagonal corner reaches. */
	private static final double CORNER_SWEEP = 0.28D;

	/**
	 * A diagonal jump passes the corner shared by the two side cells. It is planned only when at least one side column
	 * is open for the whole body: its foot-level block stays under what the jump clears where the body sweeps, and the
	 * body- and head-height cells above have no collision. Otherwise vanilla collision can stop the body at the corner
	 * (blocks, slabs, posts, overhangs); the planner then takes the cardinal steps instead.
	 */
	private boolean diagonalCornerBlocked(GridPosition from, GridPosition to, double takeoff) {
		int stepX = Integer.signum(to.x() - from.x());
		int stepZ = Integer.signum(to.z() - from.z());
		if (stepX == 0 || stepZ == 0 || !Double.isFinite(takeoff) || !Double.isFinite(maxJumpRise)) return false;
		double cornerX = from.x() + (stepX > 0 ? 1.0D : 0.0D);
		double cornerZ = from.z() + (stepZ > 0 ? 1.0D : 0.0D);
		double clearance = takeoff + maxJumpRise + 1.0E-6D;
		return !sideOpen(new GridPosition(from.x() + stepX, to.y(), from.z()), cornerX + stepX * CORNER_SWEEP, cornerZ - stepZ * CORNER_SWEEP, clearance)
				&& !sideOpen(new GridPosition(from.x(), to.y(), from.z() + stepZ), cornerX - stepX * CORNER_SWEEP, cornerZ + stepZ * CORNER_SWEEP, clearance);
	}

	private boolean sideOpen(GridPosition side, double worldX, double worldZ, double clearance) {
		if (sideAbove(side, worldX, worldZ, clearance)) return false;
		for (int dy = 0; dy <= 1; dy++) {
			BlockPos body = new BlockPos(side.x(), side.y() + dy, side.z());
			BlockState state = stateAt(body);
			if (state == null) return false;
			VoxelShape shape = shapeAt(state, body);
			if (shape == null || !shape.isEmpty()) return false;
		}
		return true;
	}

	private boolean sideAbove(GridPosition side, double worldX, double worldZ, double clearance) {
		double height = supportHeight(side, worldX, worldZ);
		return Double.isFinite(height) && height > clearance;
	}

	/**
	 * Highest support over the landing samples nearest the takeoff cell: the near row on a cardinal step, the near corner
	 * on a diagonal (the body lands on a low tread that corner reaches, then steps up; vanilla collision agrees).
	 */
	private double nearFaceHeight(GridPosition from, GridPosition to) {
		int stepX = Integer.signum(to.x() - from.x());
		int stepZ = Integer.signum(to.z() - from.z());
		if (stepX == 0 && stepZ == 0) return footprintHeight(to, false);
		double nearX = stepX > 0 ? FOOTPRINT_SAMPLES[0] : FOOTPRINT_SAMPLES[FOOTPRINT_SAMPLES.length - 1];
		double nearZ = stepZ > 0 ? FOOTPRINT_SAMPLES[0] : FOOTPRINT_SAMPLES[FOOTPRINT_SAMPLES.length - 1];
		double result = Double.NaN;
		for (double dx : FOOTPRINT_SAMPLES) {
			for (double dz : FOOTPRINT_SAMPLES) {
				boolean near = stepX != 0 && stepZ != 0 ? dx == nearX && dz == nearZ
						: (stepX != 0 && dx == nearX) || (stepZ != 0 && dz == nearZ);
				if (!near) continue;
				double height = supportHeight(to, to.x() + dx, to.z() + dz);
				if (Double.isFinite(height)) result = Double.isNaN(result) ? height : Math.max(result, height);
			}
		}
		return result;
	}

	/** Highest (or lowest) support height over sample points of the cell footprint; NaN when none is known. */
	private double footprintHeight(GridPosition position, boolean highest) {
		double result = Double.NaN;
		for (double dx : FOOTPRINT_SAMPLES) {
			for (double dz : FOOTPRINT_SAMPLES) {
				double height = supportHeight(position, position.x() + dx, position.z() + dz);
				if (!Double.isFinite(height)) continue;
				result = Double.isNaN(result) ? height : highest ? Math.max(result, height) : Math.min(result, height);
			}
		}
		return result;
	}

	/** Unknown heights keep the grid decision; known heights must rise no more than the body can jump. */
	static boolean jumpRiseFeasible(double takeoff, double landing, double maxRise) {
		if (!Double.isFinite(takeoff) || !Double.isFinite(landing)) return true;
		return landing - takeoff <= maxRise + 1.0E-6D;
	}

	static boolean canJump(BlockState feet, BlockState head, BlockState support) {
		return !feet.is(Blocks.COBWEB) && !head.is(Blocks.COBWEB)
				&& feet.getBlock().getJumpFactor() >= 1.0F && support.getBlock().getJumpFactor() >= 1.0F;
	}

	// No gap jump over fire: vanilla fire burns any body whose box touches its cell (its inside shape is the whole
	// cube), and a sprint jump across a one-block gap is still below the cell's top when the box first overlaps it
	// (feet clear the top only on the third airborne tick, about a block on). Two Nether runs on 2026-10-23 burned
	// that way (w-desk-ngold-c, navigate_to ON_FIRE).

	@Override
	public int exposureCost(GridPosition position) {
		long key = BlockPos.asLong(position.x(), position.y(), position.z());
		int cost = exposureCosts.get(key);
		if (cost >= 0) return cost;
		StateRead read = (x, y, z) -> level.isOutsideBuildHeight(y) ? null : stateAt(x, y, z);
		cost = lavaFlowsInto(position) ? LAVA_FLOW_COST : lavaBeside(position) ? LAVA_BESIDE_COST
				: fireBeside(read, position.x(), position.y(), position.z()) ? FIRE_BESIDE_COST : 0;
		exposureCosts.put(key, cost);
		return cost;
	}

	/** A route cell lava is spreading into (see {@link #lavaContact}): about twenty blocks of detour before a player would. */
	static final int LAVA_FLOW_COST = 200;
	static final int LAVA_BESIDE_COST = 12;
	/**
	 * A cell with seen fire beside its feet or head, or magma beside its support, sideways or diagonally: up to about
	 * thirty blocks of detour keep a cell between the body and the burn where there is any room, since turning at a
	 * corner, momentum and a drop's landing carry the box a few tenths off the line (the w-desk-ngold-c burns walked
	 * past fire one cell over; travel smoke runs on 2026-10-24 slid onto magma after a drop and caught fire turning a
	 * corner beside it at a cost of 6).
	 */
	static final int FIRE_BESIDE_COST = 30;

	static boolean fireBeside(StateRead read, int x, int y, int z) {
		for (int dx = -1; dx <= 1; dx++) {
			for (int dz = -1; dz <= 1; dz++) {
				if (dx == 0 && dz == 0) continue;
				for (int dy = -1; dy <= 1; dy++) {
					BlockState state = read.at(x + dx, y + dy, z + dz);
					if (state == null) continue;
					if (dy >= 0 && (state.is(Blocks.FIRE) || state.is(Blocks.SOUL_FIRE))) return true;
					if (dy == -1 && state.is(Blocks.MAGMA_BLOCK)) return true;
				}
			}
		}
		return false;
	}

	/** Seen lava beside the feet or head of this cell, or above the head: the open cell is where that lava flows next. */
	@Override
	public boolean lavaFlowsInto(GridPosition position) {
		return lavaContact((x, y, z) -> level.isOutsideBuildHeight(y) ? null : stateAt(x, y, z), position.x(), position.y(), position.z());
	}

	@Override
	public boolean lavaFillsNext(GridPosition position) {
		return lavaFills((x, y, z) -> level.isOutsideBuildHeight(y) ? null : stateAt(x, y, z), position.x(), position.y(), position.z());
	}

	/** Lava an acquired cell exposes the body to (see {@link #lavaExposure}). Reads blocks only: no neighbour is classified. */
	private boolean lavaBeside(GridPosition position) {
		return lavaExposure((x, y, z) -> level.isOutsideBuildHeight(y) ? null : stateAt(x, y, z), position.x(), position.y(), position.z());
	}

	/** One acquired block state, or null when unknown. */
	@FunctionalInterface
	interface StateRead {
		BlockState at(int x, int y, int z);
	}

	/**
	 * Lava a body standing with its feet in this cell can touch without choosing to: beside the support, feet or head
	 * (a jump or a push), one step down beside an open support (a misstep), or directly above the head, where any lava
	 * flows down into the open head cell and a jump or pillar puts the head in it (d14-iron-e: a pit under a lava fall).
	 */
	static boolean lavaExposure(StateRead read, int x, int y, int z) {
		if (isLava(read.at(x, y + 2, z))) return true;
		for (Direction direction : HORIZONTAL_DIRECTIONS) {
			int nx = x + direction.getStepX();
			int nz = z + direction.getStepZ();
			for (int dy = -1; dy <= 1; dy++) if (isLava(read.at(nx, y + dy, nz))) return true;
			BlockState step = read.at(nx, y - 1, nz);
			if (step != null && step.isAir() && isLava(read.at(nx, y - 2, nz))) return true;
		}
		return false;
	}

	/**
	 * Lava that spreads into an open cell with its feet here: lava keeps flowing sideways over a floor and down into any
	 * open cell, so lava level with the feet or head beside the cell, or straight above the head, reaches the body there
	 * (d22-lava: a flow coming down a Nether slope met the route two cells ahead and the walk carried on into it).
	 */
	static boolean lavaContact(StateRead read, int x, int y, int z) {
		// Lava already in the cell (a body standing in it) is in the flow too: its way out may cross cells the flow reaches.
		if (isLava(read.at(x, y, z)) || isLava(read.at(x, y + 1, z)) || isLava(read.at(x, y + 2, z))) return true;
		for (Direction direction : HORIZONTAL_DIRECTIONS) {
			int nx = x + direction.getStepX();
			int nz = z + direction.getStepZ();
			if (isLava(read.at(nx, y, nz)) || isLava(read.at(nx, y + 1, nz))) return true;
		}
		return false;
	}

	/**
	 * Lava that vanilla's spread puts into this open cell next: lava already in it or pouring over the head, lava beside
	 * the feet or head that can still spread sideways ({@link #spreadsSideways}), or lava at head height beside over an
	 * open cell with a floor (it lands beside the feet and spreads in). Navigation refuses to enter such a cell
	 * (d22-nether2); {@link #lavaContact} stays the wider rule for costs and replans.
	 */
	static boolean lavaFills(StateRead read, int x, int y, int z) {
		if (isLava(read.at(x, y, z)) || isLava(read.at(x, y + 1, z)) || isLava(read.at(x, y + 2, z))) return true;
		for (Direction direction : HORIZONTAL_DIRECTIONS) {
			int nx = x + direction.getStepX();
			int nz = z + direction.getStepZ();
			if (spreadsSideways(read, nx, y, nz) || spreadsSideways(read, nx, y + 1, nz)) return true;
			if (isLava(read.at(nx, y + 1, nz)) && openToLava(read.at(nx, y, nz)) && !openToLava(read.at(nx, y - 1, nz))
					&& read.at(nx, y - 1, nz) != null && !isLava(read.at(nx, y - 1, nz))) return true;
		}
		return false;
	}

	/** An open cell lava can enter: known, holding no fluid, and replaceable by lava. */
	private static boolean openToLava(BlockState state) {
		return state != null && state.getFluidState().isEmpty() && (state.isAir() || state.canBeReplaced(net.minecraft.world.level.material.Fluids.LAVA));
	}

	/**
	 * Lava here that can still spread to the cells beside it, as vanilla's FlowingFluid spreads: lava over an open cell
	 * falls into it instead (a source too), lava resting on lava spreads only as a source, and flowing lava needs more
	 * than the last level (amount 1 spreads nowhere). A flow's settled edge beside a path is not a flow coming at it.
	 */
	static boolean spreadsSideways(StateRead read, int x, int y, int z) {
		BlockState state = read.at(x, y, z);
		if (!isLava(state)) return false;
		var fluid = state.getFluidState();
		BlockState below = read.at(x, y - 1, z);
		if (openToLava(below)) return false;
		if (fluid.isSource()) return true;
		if (isLava(below)) return false;
		boolean falling = fluid.hasProperty(net.minecraft.world.level.material.FlowingFluid.FALLING) && fluid.getValue(net.minecraft.world.level.material.FlowingFluid.FALLING);
		return falling || fluid.getAmount() > 1;
	}

	private static boolean isLava(BlockState state) {
		if (state == null) return false;
		// The fluid type, not its tag: tags are unbound outside a loaded world.
		return state.getFluidState().getType().isSame(net.minecraft.world.level.material.Fluids.LAVA);
	}

	/** Only acquired facts and their expiry invalidate a retained search, never hidden world mutations. */
	boolean isCurrent(SeenTerrain.Reader<BlockState> now) {
		if (now.tick() > knownUntil) return false;
		if (seen != now) {
			// Memory changes are recorded on acquisition. Refresh consulted facts before trusting an unchanged log.
			for (var entry : states.long2ObjectEntrySet()) {
				long key = entry.getLongKey();
				if (!Objects.equals(entry.getValue(), now.known(BlockPos.getX(key), BlockPos.getY(key), BlockPos.getZ(key)))) return false;
			}
		}
		boolean changed = now.changedSince(stamp, key -> states.containsKey(key)
				&& !Objects.equals(states.get(key), now.known(BlockPos.getX(key), BlockPos.getY(key), BlockPos.getZ(key))));
		if (changed) return false;
		seen = now;
		stamp = now.stamp();
		return true;
	}

	boolean uses(SeenTerrain.Reader<BlockState> reader) { return seen == reader; }

	/** Reuse steering storage, but read through this tick's shared knowledge. Retained searches keep their snapshot. */
	void nextFrame(SeenTerrain.Reader<BlockState> reader) {
		seen = reader;
		stamp = reader.stamp();
		knownUntil = Long.MAX_VALUE;
		refreshCached = true;
		frame++;
		refreshed.clear();
		shallowWater.clear();
		sweptJumps.clear();
		movementSpeeds.clear();
		exposureCosts.clear();
		unknownRead = false;
		blockedMagma = false;
	}
	boolean hasUnknown() { return unknownRead; }

	boolean belongsTo(ServerLevel candidate) { return level == candidate; }

	BlockState stateAt(BlockPos position) { return stateAt(position.getX(), position.getY(), position.getZ()); }

	@Override
	public boolean teleportsOnContact(GridPosition position) {
		BlockState state = stateAt(position.x(), position.y(), position.z());
		return state != null && (state.is(Blocks.END_PORTAL) || state.is(Blocks.END_GATEWAY));
	}

	@Override
	public Set<GridPosition> portalEntries() { return portalEntries; }

	/** Allows stepping into these portal cells (see {@link WalkabilityView#portalEntries}). */
	void allowPortalEntries(Set<GridPosition> cells) { portalEntries = Set.copyOf(cells); }

	/** Most portal blocks one move can target: a 3x3 End pool, or the 21x21 inside of the largest Nether frame. */
	static final int MAX_PORTAL_CELLS = 441;

	/**
	 * The seen portal a move to {@code destination} targets, as the cells a player steps into: the End portal (or
	 * Nether portal) block at the destination cell or under it, and the blocks of the same portal joined to it. Of a
	 * Nether portal only cells the body stands in count (its lowest row); every cell of an End pool takes the body on
	 * contact. Empty when the destination is no portal.
	 */
	Set<GridPosition> targetedPortal(Vec3 destination) {
		GridPosition cell = new GridPosition(Mth.floor(destination.x), Mth.floor(destination.y), Mth.floor(destination.z));
		Block block = null;
		GridPosition start = null;
		for (GridPosition candidate : new GridPosition[]{cell, cell.below()}) {
			BlockState state = stateAt(candidate.x(), candidate.y(), candidate.z());
			if (state != null && (state.is(Blocks.END_PORTAL) || state.is(Blocks.NETHER_PORTAL))) {
				block = state.getBlock();
				start = candidate;
				break;
			}
		}
		if (start == null) return Set.of();
		Set<GridPosition> portal = new java.util.LinkedHashSet<>();
		java.util.ArrayDeque<GridPosition> open = new java.util.ArrayDeque<>(List.of(start));
		while (!open.isEmpty() && portal.size() < MAX_PORTAL_CELLS) {
			GridPosition next = open.poll();
			BlockState state = stateAt(next.x(), next.y(), next.z());
			if (state == null || !state.is(block) || !portal.add(next)) continue;
			for (Direction direction : Direction.values()) open.add(next.offset(direction.getStepX(), direction.getStepY(), direction.getStepZ()));
		}
		if (block == Blocks.NETHER_PORTAL) portal.removeIf(position -> !isStandable(position));
		return Set.copyOf(portal);
	}

	private BlockState stateAt(int x, int y, int z) {
		long key = BlockPos.asLong(x, y, z);
		boolean retained = states.containsKey(key);
		if (retained && (!refreshCached || refreshed.contains(key))) return states.get(key);
		BlockState state = seen.known(x, y, z);
		if (retained && state != states.get(key)) {
			cells.remove(new GridPosition(x, y, z));
			shapeDependencies.remove(key);
			sweptJumps.clear();
		}
		if (refreshCached) refreshed.add(key);
		states.put(key, state);
		if (state == null) unknownRead = true;
		else knownUntil = Math.min(knownUntil, seen.rememberedUntil(x, y, z));
		return state;
	}

	@FunctionalInterface
	interface RevisionReader {
		long read(BlockPos center, int radius);
	}

	static final class SampledRevisions {
		private final RevisionReader reader;
		private final Map<Long, Long> revisions = new HashMap<>();

		SampledRevisions(RevisionReader reader) {
			this.reader = Objects.requireNonNull(reader);
		}

		void sample(int x, int z) {
			long key = ((long) (x >> 4) << 32) | ((z >> 4) & 0xffffffffL);
			revisions.computeIfAbsent(key, ignored -> read(key));
		}

		boolean isCurrent() {
			for (Map.Entry<Long, Long> entry : revisions.entrySet()) {
				if (read(entry.getKey()) != entry.getValue()) return false;
			}
			return true;
		}

		private long read(long key) {
			BlockPos center = new BlockPos(((int) (key >> 32) << 4) + 8, 0, ((int) key << 4) + 8);
			// Include neighboring blocks whose moving collision can enter a sampled chunk.
			return reader.read(center, 9);
		}
	}

	@Override
	public TraversalType traversalAt(GridPosition position) {
		if (movementLevel != null) return isStandable(position) ? TraversalType.WALK : null;
		TraversalType normal = WalkabilityView.super.traversalAt(position);
		if (normal != null) return normal;
		if (cellAt(position) != Cell.CLEAR || cellAt(position.below()) != Cell.SAFE_SUPPORT
				|| cellAt(position.above()) == Cell.UNLOADED || cellAt(position.above()) == Cell.HAZARD
				|| cellAt(position.above()) == Cell.WATER) return null;
		BlockPos head = new BlockPos(position.x(), position.y() + 1, position.z());
		BlockState state = stateAt(head);
		VoxelShape shape = state == null ? null : shapeAt(state, head);
		return shape != null && crouchClearance(shape) ? TraversalType.CROUCH : null;
	}

	static boolean crouchClearance(VoxelShape headCollision) {
		for (AABB box : headCollision.toAabbs()) {
			if (box.maxX > 0.2D && box.minX < 0.8D && box.maxZ > 0.2D && box.minZ < 0.8D
					&& box.maxY > 0.0D && box.minY < 0.5D) return false;
		}
		return true;
	}

	Direction climbDirection(GridPosition position) {
		BlockPos block = new BlockPos(position.x(), position.y(), position.z());
		if (cellAt(position) != Cell.CLIMBABLE) return null;
		BlockState state = stateAt(block);
		if (state.hasProperty(BlockStateProperties.HORIZONTAL_FACING)) {
			return state.getValue(BlockStateProperties.HORIZONTAL_FACING).getOpposite();
		}
		for (Direction direction : HORIZONTAL_DIRECTIONS) {
			GridPosition adjacent = position.offset(direction.getStepX(), 0, direction.getStepZ());
			if (cellAt(adjacent) == Cell.SAFE_SUPPORT) return direction;
		}
		return null;
	}

	@Override
	public Cell cellAt(GridPosition position) {
		Objects.requireNonNull(position, "position must not be null");
		CellSample cached = cells.get(position);
		if (cached != null) {
			if (cached.frame == frame || level.isOutsideBuildHeight(position.y())) {
				cacheHits++;
				return cached.cell;
			}
			long key = BlockPos.asLong(position.x(), position.y(), position.z());
			BlockState previous = states.get(key);
			BlockState current = stateAt(position.x(), position.y(), position.z());
			// Static dry shapes depend only on their acquired state. Fluid and neighbour-dependent shapes are rechecked.
			if (previous == current && (current == null || current.getFluidState().isEmpty() && !shapeDependencies.contains(key))) {
				cached.frame = frame;
				cacheHits++;
				return cached.cell;
			}
		}
		cacheMisses++;
		if (level.isOutsideBuildHeight(position.y())) {
			cacheCell(position, Cell.UNLOADED, cached);
			shallowWater.put(position, false);
			return Cell.UNLOADED;
		}
		BlockPos blockPosition = new BlockPos(position.x(), position.y(), position.z());
		BlockState state = stateAt(blockPosition);
		if (state == null) {
			cacheCell(position, Cell.UNLOADED, cached);
			return Cell.UNLOADED;
		}
		VoxelShape collision = shapeAt(state, blockPosition);
		if (collision == null) {
			cacheCell(position, Cell.UNLOADED, cached);
			return Cell.UNLOADED;
		}
		boolean standingWater = state.is(Blocks.WATER) && isOneBlockDeepWater(blockPosition);
		Cell cell = classifyCell(state, collision, standingWater, magmaProtected);
		cacheCell(position, cell, cached);
		shallowWater.put(position, standingWater);
		return cell;
	}

	private void cacheCell(GridPosition position, Cell cell, CellSample sample) {
		if (sample == null) sample = new CellSample(cell, frame);
		else { sample.cell = cell; sample.frame = frame; }
		cells.put(position, sample);
	}

	@Override
	public boolean isStandable(GridPosition position) {
		if (movementLevel != null && position.y() != movementLevel) return false;
		if (!isBodyClear(position) || !isBodyClear(position.above())) return false;
		GridPosition support = position.below();
		Cell cell = cellAt(support);
		if (cell == Cell.HAZARD && stateAt(new BlockPos(support.x(), support.y(), support.z())).is(Blocks.MAGMA_BLOCK)) {
			blockedMagma = true;
		}
		return cell == Cell.SAFE_SUPPORT;
	}

	boolean isShallowWater(GridPosition position) {
		Objects.requireNonNull(position, "position must not be null");
		cellAt(position);
		return shallowWater.getOrDefault(position, false);
	}

	CacheMetrics cacheMetrics() {
		return new CacheMetrics(cacheHits, cacheMisses, cells.size());
	}

	record CacheMetrics(long hits, long misses, int cachedCells) { }

	/** A steering point inside this cell, with the whole player footprint supported and body clear. */
	Vec3 inwardStandingTarget(GridPosition position, Vec3 requested, AABB playerBox) {
		double halfX = playerBox.getXsize() / 2.0D;
		double halfZ = playerBox.getZsize() / 2.0D;
		if (halfX >= 0.5D || halfZ >= 0.5D) return null;
		double x = inwardCoordinate(position.x(), requested.x, halfX);
		double z = inwardCoordinate(position.z(), requested.z, halfZ);
		double y = supportHeight(position, x, z);
		if (!Double.isFinite(y)) return null;
		BlockPos below = new BlockPos(position.x(), position.y() - 1, position.z());
		BlockState supportState = stateAt(below);
		if (supportState == null) return null;
		VoxelShape support = shapeAt(supportState, below);
		if (support == null) return null;
		AABB footprint = new AABB(x - halfX - position.x(), 0.0D, z - halfZ - position.z(),
				x + halfX - position.x(), 1.0D, z + halfZ - position.z());
		if (!supportsFootprintAt(support, footprint, y - below.getY())) return null;
		AABB standingBox = new AABB(x - halfX, y, z - halfZ, x + halfX, y + playerBox.getYsize(), z + halfZ);
		return knownClear(standingBox) ? new Vec3(x, y, z) : null;
	}

	/** Some vanilla shapes query neighbours. An unknown dependency cannot prove clearance or support. */
	private VoxelShape shapeAt(BlockState state, BlockPos position) {
		geometryUnknown = false;
		geometryConsulted = false;
		VoxelShape shape = state.getCollisionShape(geometry, position);
		if (geometryConsulted) shapeDependencies.add(position.asLong());
		return geometryUnknown ? null : shape;
	}

	/** Check every cell the proposed body occupies using acquired collision shapes. */
	private boolean knownClear(AABB box) {
		for (int x = (int) Math.floor(box.minX); x <= (int) Math.floor(box.maxX - 1.0E-7D); x++) {
			for (int y = (int) Math.floor(box.minY); y <= (int) Math.floor(box.maxY - 1.0E-7D); y++) {
				for (int z = (int) Math.floor(box.minZ); z <= (int) Math.floor(box.maxZ - 1.0E-7D); z++) {
					BlockPos position = new BlockPos(x, y, z);
					BlockState state = stateAt(position);
					VoxelShape shape = state == null ? null : shapeAt(state, position);
					if (shape == null || Shapes.joinIsNotEmpty(Shapes.create(box),
							shape.move(x, y, z), BooleanOp.AND)) return false;
				}
			}
		}
		return true;
	}

	/** The swept swimming body may cross known water or air, including ordinary upward player movement.
	 * The sweep uses the real hitbox: a side margin rejected a body already pressed against a one-wide shaft wall,
	 * and both Oct 17 long-run drownings stopped surfacing 1-3 blocks below air on that check. A diagonal that clips
	 * a corner still counts when an axis-aligned leg pair is clear, because collision slides the body along it.
	 */
	boolean knownSwimLine(Vec3 from, Vec3 to, AABB body) {
		if (knownSweep(from, to, body)) return true;
		Vec3 across = new Vec3(to.x, from.y, to.z), vertical = new Vec3(from.x, to.y, from.z);
		return knownSweep(from, across, body) && knownSweep(across, to, body.move(across.subtract(from)))
				|| knownSweep(from, vertical, body) && knownSweep(vertical, to, body.move(vertical.subtract(from)));
	}

	private boolean knownSweep(Vec3 from, Vec3 to, AABB body) {
		int samples = Math.max(1, (int) Math.ceil(from.distanceTo(to) / 0.25D));
		for (int index = 0; index <= samples; index++) {
			Vec3 at = from.lerp(to, index / (double) samples);
			if (!knownClear(body.move(at.subtract(from)))) return false;
		}
		return true;
	}

	static double inwardCoordinate(int cell, double requested, double halfWidth) {
		double nearest = Math.max(cell + halfWidth, Math.min(cell + 1.0D - halfWidth, requested));
		// Stay inside the safe cell, away from its exact edge, without changing arrival tolerance.
		return (cell + 0.5D + nearest) / 2.0D;
	}

	static boolean supportsFootprintAt(VoxelShape support, AABB footprint, double height) {
		VoxelShape surface = Shapes.empty();
		for (AABB box : support.toAabbs()) {
			if (box.maxY == height) surface = Shapes.or(surface,
					Shapes.box(box.minX, 0.0D, box.minZ, box.maxX, 1.0D, box.maxZ));
		}
		return !Shapes.joinIsNotEmpty(Shapes.create(footprint), surface, BooleanOp.ONLY_FIRST);
	}

	double supportHeight(GridPosition feetPosition, double worldX, double worldZ) {
		Objects.requireNonNull(feetPosition, "feetPosition must not be null");
		BlockPos supportPosition = new BlockPos(
				feetPosition.x(),
				feetPosition.y() - 1,
				feetPosition.z()
		);
		if (level.isOutsideBuildHeight(supportPosition.getY())) {
			return Double.NaN;
		}
		double localX = worldX - supportPosition.getX();
		double localZ = worldZ - supportPosition.getZ();
		BlockState support = stateAt(supportPosition);
		if (support == null) return Double.NaN;
		VoxelShape shape = shapeAt(support, supportPosition);
		if (shape == null) return Double.NaN;
		double collisionHeight = collisionHeightAt(
				shape,
				localX,
				localZ
		);
		return Double.isFinite(collisionHeight)
				? supportPosition.getY() + collisionHeight
				: Double.NaN;
	}

	static double collisionHeightAt(VoxelShape collision, double localX, double localZ) {
		Objects.requireNonNull(collision, "collision must not be null");
		if (!Double.isFinite(localX) || !Double.isFinite(localZ)
				|| localX < 0.0D || localX >= 1.0D
				|| localZ < 0.0D || localZ >= 1.0D) {
			return Double.NaN;
		}
		double height = Double.NaN;
		for (AABB box : collision.toAabbs()) {
			if (localX < box.minX || localX > box.maxX
					|| localZ < box.minZ || localZ > box.maxZ) continue;
			height = Double.isNaN(height) ? box.maxY : Math.max(height, box.maxY);
		}
		return height;
	}

	static Cell classifyCell(BlockState state, VoxelShape collision, boolean standingWater, boolean magmaProtected) {
		return magmaProtected && state.is(Blocks.MAGMA_BLOCK) ? Cell.SAFE_SUPPORT : classifyCell(state, collision, standingWater);
	}

	static Cell classifyCell(BlockState state, VoxelShape collision, boolean standingWater) {
		Objects.requireNonNull(state, "state must not be null");
		Objects.requireNonNull(collision, "collision must not be null");
		if (isIntrinsicHazard(state)) return Cell.HAZARD;
		if (!state.getFluidState().isEmpty()) {
			if (!state.is(Blocks.WATER) && !state.getFluidState().is(FluidTags.WATER)
					&& !state.getFluidState().getType().isSame(net.minecraft.world.level.material.Fluids.WATER)) return Cell.HAZARD;
			// A waterlogged solid (slab, stairs, fence, chest) keeps the dry block's collision role; water is no hazard.
			if (collision.isEmpty()) return standingWater ? Cell.CLEAR : Cell.WATER;
		}
		if (state.is(BlockTags.CLIMBABLE)) return Cell.CLIMBABLE;
		if (isOpenDoor(state)) return Cell.CLEAR;
		if (collision.isEmpty()) return Cell.CLEAR;
		if (Block.isShapeFullBlock(collision) || supportsPlayerFootprint(collision)) return Cell.SAFE_SUPPORT;
		return Cell.BLOCKED;
	}

	private boolean isOneBlockDeepWater(BlockPos position) {
		if (level.isOutsideBuildHeight(position.getY()) || level.isOutsideBuildHeight(position.getY() - 1)) return false;
		BlockState water = stateAt(position);
		VoxelShape waterShape = water == null ? null : shapeAt(water, position);
		if (waterShape == null || !water.getFluidState().is(FluidTags.WATER) || !waterShape.isEmpty()) return false;
		BlockPos abovePosition = position.above();
		BlockState above = stateAt(abovePosition);
		VoxelShape aboveShape = above == null ? null : shapeAt(above, abovePosition);
		if (aboveShape == null || !above.getFluidState().isEmpty() || !aboveShape.isEmpty()) return false;
		BlockPos supportPosition = position.below();
		BlockState support = stateAt(supportPosition);
		VoxelShape supportShape = support == null ? null : shapeAt(support, supportPosition);
		return supportShape != null && classifyCell(support, supportShape, false) == Cell.SAFE_SUPPORT;
	}

	private static boolean supportsPlayerFootprint(VoxelShape collision) {
		java.util.List<AABB> boxes = collision.toAabbs();
		for (double x : FOOTPRINT_SAMPLES) {
			for (double z : FOOTPRINT_SAMPLES) {
				double height = 0.0D;
				for (AABB box : boxes) {
					if (x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ) height = Math.max(height, box.maxY);
				}
				if (height <= 0.0D || height > 1.0D) return false;
			}
		}
		return true;
	}

	private static boolean isOpenDoor(BlockState state) {
		String path = BuiltInRegistries.BLOCK.getKey(state.getBlock()).getPath();
		return path.endsWith("_door")
				&& !path.endsWith("_trapdoor")
				&& state.hasProperty(BlockStateProperties.OPEN)
				&& state.getValue(BlockStateProperties.OPEN);
	}

	private static boolean isIntrinsicHazard(BlockState state) {
		return state.is(Blocks.FIRE)
				|| state.is(Blocks.SOUL_FIRE)
				|| state.is(Blocks.CACTUS)
				|| state.is(Blocks.MAGMA_BLOCK)
				|| state.is(Blocks.CAMPFIRE)
				|| state.is(Blocks.SOUL_CAMPFIRE)
				|| state.is(Blocks.SWEET_BERRY_BUSH)
				|| state.is(Blocks.WITHER_ROSE)
				|| state.is(Blocks.POWDER_SNOW);
	}
}
