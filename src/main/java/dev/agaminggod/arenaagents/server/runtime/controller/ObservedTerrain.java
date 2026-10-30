package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.function.LongPredicate;
import java.util.function.Predicate;
import java.util.function.ToIntFunction;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Terrain as the player knows it ({@link SeenTerrain}: seen now, touched, or remembered from the last 10 s as it looked
 * then), for fight and flee. A cell nobody knows reads as unknown ({@link Cell#UNLOADED}, which every rule refuses), so
 * hidden ramps, floors and drops never shape a route or a refusal. One view keeps the value each cell first read as,
 * so a check that spans ticks judges one consistent picture. A read that puts an unknown cell beside a known open one
 * (air, water, a ladder) marks where a route could continue out of sight: a search that ran into one cannot claim the
 * target is unreachable. A view made for a check also notes the facts known when it began, so the check can tell
 * whether what the player knows of the cells it read has changed since (never whether the hidden world has).
 * Traversal follows navigation's rules ({@link MinecraftNavigationWorld}: no jump from honey or cobweb, slow ground,
 * lava beside a cell, fire a gap jump clears, magma safe for a protected body) read from the known block states; a
 * rule that needs a cell nobody knows keeps the plain default, never the hidden value.
 */
final class ObservedTerrain implements WalkabilityView {
	private static final int[][] FACES = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};

	/** What the player knows of one cell now: its navigation class, or null when unknown. */
	@FunctionalInterface
	interface Known {
		Cell cellAt(GridPosition position);

		/** The known block state, or null when unknown or when this source only knows classes. */
		default BlockState state(GridPosition position) {
			return null;
		}

		/** The body's Soul Speed level and Weaving, which change how fast it crosses ground. */
		default int soulSpeedLevel() {
			return 0;
		}

		default boolean weaving() {
			return false;
		}
	}

	/** The observer's acquired facts: where they stand now, and which cells got one since a stamp. */
	interface Facts {
		SeenTerrain.Stamp now();

		boolean changedSince(SeenTerrain.Stamp stamp, LongPredicate differs);
	}

	private Known known;
	private Integer movementLevel;
	private final Map<GridPosition, Cell> read = new HashMap<>();
	private final Map<GridPosition, BlockState> states = new HashMap<>();
	private final Map<GridPosition, Boolean> jumps = new HashMap<>();
	private final Map<GridPosition, Double> speeds = new HashMap<>();
	private final Map<GridPosition, Integer> exposures = new HashMap<>();
	private final Map<GridPosition, Boolean> flows = new HashMap<>();
	private final Facts facts;
	private SeenTerrain.Stamp stamp;
	private boolean stale;
	private ToIntFunction<GridPosition> contactCost;
	private boolean openUnknown;
	private int unknownReads;

	ObservedTerrain(Known known, Facts facts) {
		this.known = Objects.requireNonNull(known, "known must not be null");
		this.facts = facts;
		this.stamp = facts == null ? null : facts.now();
	}

	/** This player's knowledge of the terrain from this tick's eyes and memory, for this tick's steering. */
	static ObservedTerrain of(ServerPlayer player) {
		return new ObservedTerrain(known(player), null);
	}

	/** Restrict standing destinations to this deck without changing any acquired terrain facts. */
	ObservedTerrain onLevel(int y) {
		movementLevel = y;
		return this;
	}

	@Override
	public boolean isStandable(GridPosition position) {
		return (movementLevel == null || position.y() == movementLevel) && WalkabilityView.super.isStandable(position);
	}

	@Override
	public dev.agaminggod.arenaagents.client.navigation.TraversalType traversalAt(GridPosition position) {
		if (movementLevel != null) return isStandable(position) ? dev.agaminggod.arenaagents.client.navigation.TraversalType.WALK : null;
		return WalkabilityView.super.traversalAt(position);
	}

	/** As {@link #of}, also noting the facts known now so a later {@link #unchanged} can tell an answer is stale. */
	static ObservedTerrain forCheck(ServerPlayer player) {
		return new ObservedTerrain(known(player), new Facts() {
			@Override
			public SeenTerrain.Stamp now() {
				return SeenTerrain.of(player).stamp();
			}

			@Override
			public boolean changedSince(SeenTerrain.Stamp stamp, LongPredicate differs) {
				return SeenTerrain.of(player).changedSince(stamp, differs);
			}
		});
	}

	/** Extra cost from visible contact hazards, frozen by the caller for this check; terrain knowledge stays unchanged. */
	ObservedTerrain withContactCost(ToIntFunction<GridPosition> cost) {
		contactCost = cost;
		return this;
	}

	/** A view for a pure check over {@code memory}. */
	static ObservedTerrain forCheck(Known known, SeenTerrain.Memory<?> memory) {
		return new ObservedTerrain(known, new Facts() {
			@Override
			public SeenTerrain.Stamp now() {
				return memory.stamp();
			}

			@Override
			public boolean changedSince(SeenTerrain.Stamp stamp, LongPredicate differs) {
				return memory.changedSince(stamp, differs);
			}
		});
	}

	/**
	 * A view over a plain terrain model for pure checks: {@code sight} says which cells the eye sees at {@code tick};
	 * {@code memory} carries what earlier views saw (pass the same one to model a later look).
	 */
	static ObservedTerrain over(WalkabilityView world, SeenTerrain.Memory<Cell> memory, long tick, Predicate<GridPosition> sight) {
		return new ObservedTerrain(known(reader(world, memory, tick, sight)), null);
	}

	/** A reader over a plain terrain model whose eye sees {@code sight} at {@code tick}. */
	static SeenTerrain.Reader<Cell> reader(WalkabilityView world, SeenTerrain.Memory<Cell> memory, long tick, Predicate<GridPosition> sight) {
		return new SeenTerrain.Reader<>(memory, new SeenTerrain.Source<>() {
			@Override
			public Cell live(int x, int y, int z) {
				Cell cell = world.cellAt(new GridPosition(x, y, z));
				return cell == Cell.UNLOADED ? null : cell;
			}

			@Override
			public boolean sees(int x, int y, int z) {
				return sight.test(new GridPosition(x, y, z));
			}
		}, tick, null);
	}

	/** Cells as {@code reader} knows them. */
	static Known known(SeenTerrain.Reader<Cell> reader) {
		return position -> reader.known(position.x(), position.y(), position.z());
	}

	/** {@link #over(WalkabilityView, SeenTerrain.Memory, long, Predicate)} with nothing remembered. */
	static ObservedTerrain over(WalkabilityView world, Predicate<GridPosition> sight) {
		return over(world, new SeenTerrain.Memory<>(), 0L, sight);
	}

	/** Navigation classes and block states of the cells this player knows this tick, for this body. */
	static Known known(ServerPlayer player) {
		return known(SeenTerrain.of(player), player.level(), MinecraftNavigationWorld.magmaProtected(player),
				MinecraftNavigationWorld.soulSpeedLevel(player), player.hasEffect(MobEffects.WEAVING));
	}

	/** Cells as {@code seen} knows them, for a body with this magma protection, Soul Speed and Weaving. */
	static Known known(SeenTerrain.Reader<BlockState> seen, BlockGetter level, boolean magmaProtected, int soulSpeed, boolean weaving) {
		AcquiredGeometry geometry = new AcquiredGeometry(level, position -> seen.known(position.getX(), position.getY(), position.getZ()));
		return new Known() {
			@Override
			public Cell cellAt(GridPosition position) {
				BlockState state = state(position);
				if (state == null) return null;
				BlockPos block = new BlockPos(position.x(), position.y(), position.z());
				var shape = geometry.shape(state, block);
				if (shape == null) return null;
				boolean standingWater = state.is(Blocks.WATER) && oneBlockDeep(seen, geometry, position);
				return MinecraftNavigationWorld.classifyCell(state, shape, standingWater, magmaProtected);
			}

			@Override
			public BlockState state(GridPosition position) {
				return seen.known(position.x(), position.y(), position.z());
			}

			@Override
			public int soulSpeedLevel() {
				return soulSpeed;
			}

			@Override
			public boolean weaving() {
				return weaving;
			}
		};
	}

	/** Water one block deep on known support with known open air above (the planner walks through it). */
	private static boolean oneBlockDeep(SeenTerrain.Reader<BlockState> seen, AcquiredGeometry geometry, GridPosition position) {
		BlockState above = seen.known(position.x(), position.y() + 1, position.z());
		BlockState support = seen.known(position.x(), position.y() - 1, position.z());
		if (above == null || support == null || !above.getFluidState().isEmpty()) return false;
		BlockPos abovePosition = new BlockPos(position.x(), position.y() + 1, position.z());
		BlockPos supportPosition = abovePosition.below(2);
		var aboveShape = geometry.shape(above, abovePosition);
		var supportShape = geometry.shape(support, supportPosition);
		if (aboveShape == null || supportShape == null || !aboveShape.isEmpty() || support.getFluidState().is(FluidTags.WATER)) return false;
		return MinecraftNavigationWorld.classifyCell(support, supportShape, false)
				== Cell.SAFE_SUPPORT;
	}

	/**
	 * Reads later cells through {@code now} (a check spanning ticks looks through the current tick's eyes); cells
	 * already read keep the value they read as.
	 */
	void rebind(Known now) {
		known = Objects.requireNonNull(now, "now must not be null");
	}

	/** Exact acquired states used by melee rays, including unknowns and neighbour-dependent fence shapes. */
	BlockState stateAt(GridPosition position) {
		if (!states.containsKey(position)) states.put(position, known.state(position));
		return states.get(position);
	}

	@Override
	public Cell cellAt(GridPosition position) {
		Cell cell = read.get(position);
		if (cell == null) {
			Cell value = known.cellAt(position);
			cell = value == null ? Cell.UNLOADED : value;
			read.put(position, cell);
			if (!openUnknown) openUnknown = borders(position, cell);
		}
		if (cell == Cell.UNLOADED) unknownReads++;
		return cell;
	}

	@Override
	public boolean canJumpFrom(GridPosition position) {
		if (movementLevel != null) return false;
		return jumps.computeIfAbsent(position, key -> {
			BlockState feet = known.state(key);
			BlockState head = known.state(key.above());
			BlockState support = known.state(key.below());
			return feet == null || head == null || support == null || MinecraftNavigationWorld.canJump(feet, head, support);
		});
	}

	@Override
	public double movementSpeedMultiplier(GridPosition position) {
		return speeds.computeIfAbsent(position, key -> {
			if (cellAt(key) == Cell.UNLOADED) return 1.0D;
			BlockState feet = known.state(key);
			BlockState head = known.state(key.above());
			BlockState support = known.state(key.below());
			if (feet == null || head == null || support == null) return 1.0D;
			return MinecraftNavigationWorld.movementSpeed(feet, head, support, known.soulSpeedLevel(), known.weaving());
		});
	}

	@Override
	public boolean teleportsOnContact(GridPosition position) {
		BlockState state = stateAt(position);
		return state != null && (state.is(Blocks.END_PORTAL) || state.is(Blocks.END_GATEWAY));
	}

	@Override
	public int exposureCost(GridPosition position) {
		MinecraftNavigationWorld.StateRead read = (x, y, z) -> known.state(new GridPosition(x, y, z));
		return (contactCost == null || cellAt(position) == Cell.UNLOADED ? 0 : contactCost.applyAsInt(position))
				+ exposures.computeIfAbsent(position, key -> lavaFlowsInto(key) ? MinecraftNavigationWorld.LAVA_FLOW_COST
				: MinecraftNavigationWorld.lavaExposure(read, key.x(), key.y(), key.z()) ? MinecraftNavigationWorld.LAVA_BESIDE_COST
				: MinecraftNavigationWorld.fireBeside(read, key.x(), key.y(), key.z()) ? MinecraftNavigationWorld.FIRE_BESIDE_COST : 0);
	}

	@Override
	public boolean lavaFlowsInto(GridPosition position) {
		return flows.computeIfAbsent(position, key -> MinecraftNavigationWorld.lavaContact(
				(x, y, z) -> known.state(new GridPosition(x, y, z)), key.x(), key.y(), key.z()));
	}

	@Override
	public boolean lavaFillsNext(GridPosition position) {
		return MinecraftNavigationWorld.lavaFills((x, y, z) -> known.state(new GridPosition(x, y, z)), position.x(), position.y(), position.z());
	}

	/** True when this new read puts an unknown cell face to face with a known open one (among cells read so far). */
	private boolean borders(GridPosition position, Cell cell) {
		boolean unknown = cell == Cell.UNLOADED;
		if (!unknown && !open(cell)) return false;
		for (int[] face : FACES) {
			Cell neighbour = read.get(position.offset(face[0], face[1], face[2]));
			if (neighbour == null) continue;
			if (unknown ? open(neighbour) : neighbour == Cell.UNLOADED) return true;
		}
		return false;
	}

	private static boolean open(Cell cell) {
		return cell == Cell.CLEAR || cell == Cell.WATER || cell == Cell.CLIMBABLE;
	}

	/** Whether a read so far found an unknown cell beside known open space: where a route could continue unseen. */
	boolean openUnknown() {
		return openUnknown;
	}

	/** Reads that answered "unknown" so far, repeats included: a rule that read one could not decide on known facts. */
	int unknownReads() {
		return unknownReads;
	}

	/**
	 * Before a check reads on (after {@link #rebind}): notes whether the player learned something new, since the last
	 * {@link #endSlice}, about a cell this view read: seen or touched since, it now reads otherwise (newly seen, or seen
	 * changed). Only facts acquired in between are compared, not every cell read; changes nobody perceived never count.
	 */
	void beginSlice() {
		if (facts == null || stale) return;
		stale = facts.changedSince(stamp, key -> {
			GridPosition position = new GridPosition(BlockPos.getX(key), BlockPos.getY(key), BlockPos.getZ(key));
			Cell before = read.get(position);
			if (states.containsKey(position) && !Objects.equals(states.get(position), known.state(position))) return true;
			if (before == null) return false;
			Cell now = known.cellAt(position);
			return (now == null ? Cell.UNLOADED : now) != before;
		});
	}

	/** After a check's reads: the facts its own reads acquired are what it read, not news. */
	void endSlice() {
		if (facts != null) stamp = facts.now();
	}

	/**
	 * False once {@link #beginSlice} found the player had learned something new about a cell this view read: an answer
	 * built on these reads should be checked again.
	 */
	boolean unchanged() {
		return !stale;
	}
}
