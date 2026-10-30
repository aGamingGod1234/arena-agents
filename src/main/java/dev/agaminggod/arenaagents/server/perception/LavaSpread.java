package dev.agaminggod.arenaagents.server.perception;

import it.unimi.dsi.fastutil.longs.Long2IntOpenHashMap;
import it.unimi.dsi.fastutil.longs.Long2LongOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongArrayList;
import java.util.ArrayDeque;
import java.util.Map;
import java.util.WeakHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FlowingFluid;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.material.Fluids;
import net.minecraft.world.phys.AABB;

/**
 * Where seen lava flows next and when, by vanilla's spread rules over the cells the player knows: a lava cell falls into
 * an open cell below it, and one that cannot fall spreads to the open cells beside it nearest a drop, losing the
 * dimension's drop-off (1 in the Nether, 2 elsewhere) each cell, one cell per spread delay (0.5 s in the Nether, 1.5 s
 * elsewhere). Unknown cells hold the flow: only what the player knows is predicted.
 * d22-nether2 (a tunnel dug into a hidden lava pocket) and d22-lava2 (a lava fall running down a slope onto an idle body)
 * both gave a player seconds of warning that this turns into a fact, a reflex condition and the escape's exit choice.
 */
public final class LavaSpread {
	/** How far ahead the prediction looks. */
	public static final double HORIZON_SECONDS = 6.0D;
	/** Horizontal reach of the lava considered around the body (the Nether's 7-cell flow plus a cell). */
	static final int RADIUS = 8;
	static final int BELOW = 3;
	static final int ABOVE = 10;

	/** A known block state, or null when the cell is unknown. */
	@FunctionalInterface
	public interface Read {
		BlockState at(int x, int y, int z);
	}

	/**
	 * Seen lava reaching a cell: the reached cell, the lava cell it spreads from, the cell it enters from (lava now or
	 * next to flow; where a block placed stops it) and about when.
	 */
	public record Arrival(BlockPos cell, BlockPos from, BlockPos via, double seconds) {
		public String describe() {
			return String.format(java.util.Locale.ROOT, "lava from %d,%d,%d reaches %d,%d,%d in about %.1f s",
					from.getX(), from.getY(), from.getZ(), cell.getX(), cell.getY(), cell.getZ(), seconds);
		}
	}

	/** Cells the seen lava reaches within the horizon, each with its spread steps and the lava cell it came from. */
	public static final class Prediction {
		static final Prediction NONE = new Prediction(new Long2IntOpenHashMap(), new Long2LongOpenHashMap(), new Long2LongOpenHashMap(), 0.5D);
		private final Long2IntOpenHashMap steps;
		private final Long2LongOpenHashMap origin;
		private final Long2LongOpenHashMap parent;
		private final double stepSeconds;

		Prediction(Long2IntOpenHashMap steps, Long2LongOpenHashMap origin, Long2LongOpenHashMap parent, double stepSeconds) {
			this.steps = steps;
			this.origin = origin;
			this.parent = parent;
			this.stepSeconds = stepSeconds;
		}

		public boolean isEmpty() {
			return steps.isEmpty();
		}

		/** Seconds until the flow reaches this open cell, or {@code Double.POSITIVE_INFINITY} when it does not. */
		public double secondsUntil(int x, int y, int z) {
			long key = BlockPos.asLong(x, y, z);
			return steps.containsKey(key) ? steps.get(key) * stepSeconds : Double.POSITIVE_INFINITY;
		}

		/** The earliest arrival at any cell a standing body there overlaps (feet and head), or null. */
		public Arrival standing(int x, int y, int z) {
			Arrival feet = at(x, y, z), head = at(x, y + 1, z);
			if (feet == null) return head;
			return head == null || feet.seconds() <= head.seconds() ? feet : head;
		}

		/** The earliest arrival at any cell the box overlaps, or null. */
		public Arrival box(AABB box) {
			Arrival best = null;
			// The edges shrink by a hair: a body standing flush against a cell boundary does not overlap the next cell.
			for (int x = Mth.floor(box.minX + 1.0E-4D); x <= Mth.floor(box.maxX - 1.0E-4D); x++) {
				for (int y = Mth.floor(box.minY + 1.0E-4D); y <= Mth.floor(box.maxY - 1.0E-4D); y++) {
					for (int z = Mth.floor(box.minZ + 1.0E-4D); z <= Mth.floor(box.maxZ - 1.0E-4D); z++) {
						Arrival arrival = at(x, y, z);
						if (arrival != null && (best == null || arrival.seconds() < best.seconds())) best = arrival;
					}
				}
			}
			return best;
		}

		private Arrival at(int x, int y, int z) {
			long key = BlockPos.asLong(x, y, z);
			if (!steps.containsKey(key)) return null;
			return new Arrival(new BlockPos(x, y, z), BlockPos.of(origin.get(key)), BlockPos.of(parent.get(key)), steps.get(key) * stepSeconds);
		}
	}

	private LavaSpread() {
	}

	/** A cell the flow can enter: known, holding no fluid, and replaceable by lava (air, fire, plants). */
	static boolean open(BlockState state) {
		return state != null && state.getFluidState().isEmpty() && (state.isAir() || state.canBeReplaced(Fluids.LAVA));
	}

	static boolean lava(BlockState state) {
		return state != null && state.getFluidState().getType().isSame(Fluids.LAVA);
	}

	private static boolean falling(FluidState fluid) {
		return !fluid.isSource() && fluid.hasProperty(FlowingFluid.FALLING) && fluid.getValue(FlowingFluid.FALLING);
	}

	/**
	 * The spread from the given lava cells (packed positions whose known state is lava) for at most {@code maxSteps}
	 * spread delays of {@code stepSeconds} each, as vanilla's FlowingFluid spreads: lava over an open cell falls into it
	 * and spreads no further; lava that cannot fall spreads, losing {@code dropOff}, only toward the sides nearest a drop
	 * within {@code slopeFind} cells (all open sides when none is that near, or when {@code slopeFind} is 0). Breadth
	 * first by delay; a cell is entered again only with more lava.
	 */
	public static Prediction predict(Read read, LongArrayList seeds, int dropOff, int slopeFind, double stepSeconds, int maxSteps) {
		Long2IntOpenHashMap steps = new Long2IntOpenHashMap();
		Long2LongOpenHashMap origin = new Long2LongOpenHashMap();
		Long2LongOpenHashMap parent = new Long2LongOpenHashMap();
		Long2IntOpenHashMap amounts = new Long2IntOpenHashMap();
		// Each entry: packed position, amount (8 falling or source), step, origin.
		ArrayDeque<long[]> queue = new ArrayDeque<>();
		for (int i = 0; i < seeds.size(); i++) {
			long key = seeds.getLong(i);
			BlockState state = read.at(BlockPos.getX(key), BlockPos.getY(key), BlockPos.getZ(key));
			if (!lava(state)) continue;
			FluidState fluid = state.getFluidState();
			int amount = falling(fluid) ? 8 : fluid.getAmount();
			amounts.put(key, Math.max(amounts.get(key), amount));
			queue.add(new long[] {key, amount, 0, key});
		}
		while (!queue.isEmpty()) {
			long[] entry = queue.poll();
			long key = entry[0];
			int amount = (int) entry[1], step = (int) entry[2];
			if (step >= maxSteps) continue;
			int x = BlockPos.getX(key), y = BlockPos.getY(key), z = BlockPos.getZ(key);
			if (open(read.at(x, y - 1, z))) {
				enter(queue, steps, origin, parent, amounts, BlockPos.asLong(x, y - 1, z), 8, step + 1, entry[3], key);
				continue;
			}
			// Lava resting on lava below that is not a source goes nowhere sideways (vanilla's "water hole").
			BlockState below = read.at(x, y - 1, z);
			BlockState here = read.at(x, y, z);
			boolean source = here != null && here.getFluidState().isSource() && lava(here);
			if (lava(below) && !source) continue;
			int side = amount - dropOff;
			if (side <= 0) continue;
			int best = Integer.MAX_VALUE;
			int[] distances = new int[4];
			for (int d = 0; d < 4; d++) {
				int nx = x + SIDES[d][0], nz = z + SIDES[d][1];
				if (!open(read.at(nx, y, nz))) {
					distances[d] = Integer.MAX_VALUE;
					continue;
				}
				// slopeFind 0: every open side (the wider reach: holes fill and the flow turns, so an exit stays clear of all).
				distances[d] = slopeFind <= 0 || open(read.at(nx, y - 1, nz)) ? 0 : slopeDistance(read, nx, y, nz, 1, opposite(d), slopeFind);
				best = Math.min(best, distances[d]);
			}
			for (int d = 0; d < 4; d++) {
				if (distances[d] != best || best == Integer.MAX_VALUE) continue;
				enter(queue, steps, origin, parent, amounts, BlockPos.asLong(x + SIDES[d][0], y, z + SIDES[d][1]), side, step + 1, entry[3], key);
			}
		}
		return new Prediction(steps, origin, parent, stepSeconds);
	}

	private static final int[][] SIDES = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
	/** No drop within the slope-find distance: every open side is as near as any other. */
	private static final int NO_DROP = 1000;

	private static int opposite(int d) {
		return d ^ 1;
	}

	/** Vanilla's getSlopeDistance: steps over open cells from here to one with an open cell below, or NO_DROP. */
	private static int slopeDistance(Read read, int x, int y, int z, int depth, int from, int slopeFind) {
		int best = NO_DROP;
		for (int d = 0; d < 4; d++) {
			if (d == from) continue;
			int nx = x + SIDES[d][0], nz = z + SIDES[d][1];
			if (!open(read.at(nx, y, nz))) continue;
			if (open(read.at(nx, y - 1, nz))) return depth;
			if (depth < slopeFind) best = Math.min(best, slopeDistance(read, nx, y, nz, depth + 1, opposite(d), slopeFind));
		}
		return best;
	}

	private static void enter(ArrayDeque<long[]> queue, Long2IntOpenHashMap steps, Long2LongOpenHashMap origin, Long2LongOpenHashMap parent,
			Long2IntOpenHashMap amounts, long key, int amount, int step, long from, long previous) {
		if (amounts.get(key) >= amount) return;
		amounts.put(key, amount);
		if (!steps.containsKey(key)) {
			steps.put(key, step);
			origin.put(key, from);
			parent.put(key, previous);
		}
		queue.add(new long[] {key, amount, step, from});
	}

	private static final Map<ServerPlayer, Object[]> CACHE = new WeakHashMap<>();

	/**
	 * The prediction for this player's known lava around the body this tick (cached per tick), as vanilla spreads it now.
	 * Lava cells are found in the world but kept only when the player knows them as lava (seen, touched or remembered):
	 * {@link SeenTerrain}. Cells with no open cell below or beside are skipped first, so a still lake costs nothing.
	 */
	public static Prediction of(ServerPlayer player) {
		return cached(player, false);
	}

	/**
	 * The wider reach for choosing a way out: every open side, not only the one nearest a drop. Vanilla re-picks its
	 * sides as the drops below a flow fill, so a cell the present spread misses is not safe for long (d23 replay of
	 * d22-lava2: an exit upslope beside the flow filled 3.5 s after the body reached it).
	 */
	public static Prediction reach(ServerPlayer player) {
		return cached(player, true);
	}

	private static synchronized Prediction cached(ServerPlayer player, boolean wide) {
		long tick = player.level().getGameTime();
		Object[] cached = CACHE.get(player);
		int slot = wide ? 3 : 2;
		if (cached != null && (long) cached[0] == tick && cached[1] == player.level() && cached[slot] != null) return (Prediction) cached[slot];
		if (cached == null || (long) cached[0] != tick || cached[1] != player.level()) {
			cached = new Object[] {tick, player.level(), null, null};
			CACHE.put(player, cached);
		}
		Prediction prediction = compute(player, wide);
		cached[slot] = prediction;
		return prediction;
	}

	private static Prediction compute(ServerPlayer player, boolean wide) {
		var level = player.level();
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		BlockPos feet = player.blockPosition();
		BlockPos.MutableBlockPos at = new BlockPos.MutableBlockPos();
		LongArrayList seeds = new LongArrayList();
		for (int dy = -BELOW; dy <= ABOVE; dy++) {
			int y = feet.getY() + dy;
			if (level.isOutsideBuildHeight(y)) continue;
			for (int dx = -RADIUS; dx <= RADIUS; dx++) {
				for (int dz = -RADIUS; dz <= RADIUS; dz++) {
					int x = feet.getX() + dx, z = feet.getZ() + dz;
					if (!level.getFluidState(at.set(x, y, z)).getType().isSame(Fluids.LAVA)) continue;
					if (!spreadable(level, x, y, z, at)) continue;
					if (lava(seen.known(x, y, z))) seeds.add(BlockPos.asLong(x, y, z));
				}
			}
		}
		if (seeds.isEmpty()) return Prediction.NONE;
		int delay = Fluids.LAVA.getTickDelay(level);
		double stepSeconds = delay / 20.0D;
		int maxSteps = Math.max(1, (int) Math.ceil(HORIZON_SECONDS / stepSeconds));
		// Vanilla gives the fast-lava dimension (the Nether: 10-tick delay) a drop-off of 1 and a slope search of 4 cells,
		// everywhere else 2 and 2; those getters are not public, the delay is.
		boolean fast = delay <= 10;
		return predict(seen::known, seeds, fast ? 1 : 2, wide ? 0 : fast ? 4 : 2, stepSeconds, maxSteps);
	}

	/** Some cell below or beside holds no fluid and lets lava in (world state: only a filter before the known read). */
	private static boolean spreadable(net.minecraft.world.level.Level level, int x, int y, int z, BlockPos.MutableBlockPos at) {
		if (open(level.getBlockState(at.set(x, y - 1, z)))) return true;
		for (int[] d : new int[][] {{1, 0}, {-1, 0}, {0, 1}, {0, -1}}) if (open(level.getBlockState(at.set(x + d[0], y, z + d[1])))) return true;
		return false;
	}

	/** The earliest known-lava arrival at the body's cells within the horizon, or null. */
	public static Arrival towardBody(ServerPlayer player) {
		return of(player).box(player.getBoundingBox());
	}
}
