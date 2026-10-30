package dev.agaminggod.arenaagents.server.perception;

import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongArrayList;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.IdentityHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.function.LongPredicate;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerEntityEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/**
 * The one definition of "seen terrain" for every server-side judgement made on the player's behalf (fight and flee
 * steering and reachability, hazard exits, navigation): a cell is known as it is now while the eye sees it (view cone and line of
 * sight, lava opaque: {@link ObservationVisibility.Frame#seesCell}) or the body touches it (the cells the body is in
 * and, on the ground, the cells right under the foot surface). A cell perceived recently and hidden now reads as it was
 * when last perceived, never as it is now: for 10 s after it was last seen, for 30 s after the body last stood on or
 * in it. Anything else is unknown. The memory belongs to one body in one dimension: a new body (respawn) or another
 * dimension starts empty, and a body leaving the world is forgotten.
 *
 * <p>Cost: {@link #of} hands every consumer in a tick the same {@link Reader} for that eye pose, so a cell is classified
 * and ray-tested at most once per tick and pose. A cell whose remembered value equals its current value is answered
 * without a sight ray (seen or hidden, the answer is that value); once a second (on one tick of the second per
 * observer) such a cell is checked again so its last-seen tick follows actual sightings. Cells not seen from an unchanged pose stay unknown without a new ray for up
 * to a second. Expired cells are dropped once a second.
 */
public final class SeenTerrain {
	/** How long a seen cell is remembered once out of sight (10 s). */
	public static final long MEMORY_TICKS = 200L;
	/**
	 * How long a cell the body stood on or in is remembered after leaving it (30 s). The body bore its weight, so it is
	 * surer than a glance, and stepping back along the way just walked (a fight's backstep, a retreat) is the commonest
	 * use: a melee exchange easily outlasts 10 s. It still reads as it was, so a change made out of sight stays unseen.
	 */
	public static final long WALKED_MEMORY_TICKS = 600L;
	/** A pose held this long re-tests cells it could not see; a remembered cell is re-checked this often. */
	static final long RECHECK_TICKS = 20L;
	private static final Object UNKNOWN = new Object();
	// Server thread only. A value holds its body (the reader's sight source), so an entry is removed as soon as the
	// body leaves the world (respawn, dimension change, logout) and nothing keeps a departed body alive.
	private static final Map<ServerPlayer, PlayerMemory> PLAYERS = new IdentityHashMap<>();
	private static long sweptAt;
	private static boolean registered;

	private SeenTerrain() {
	}

	/** Forgets a body when it leaves its world (respawn, dimension change, logout) and everything on server stop. */
	public static synchronized void register() {
		if (registered) return;
		ServerEntityEvents.ENTITY_UNLOAD.register((entity, level) -> {
			if (entity instanceof ServerPlayer player) forget(player);
		});
		ServerLifecycleEvents.SERVER_STOPPING.register(server -> { PLAYERS.clear(); CloudDanger.clear(); });
		registered = true;
	}

	/**
	 * What this body knows of a cell right now (seen or remembered), or null when unknown, without any sight ray or
	 * memory change: for read-only audits that must not alter what the body perceives. Server thread only.
	 */
	public static BlockState remembered(ServerPlayer player, int x, int y, int z) {
		PlayerMemory state = PLAYERS.get(player);
		if (state == null || state.level != player.level()) return null;
		return state.memory.peek(BlockPos.asLong(x, y, z), player.level().getGameTime());
	}

	/** Drops everything this body knew. */
	public static void forget(ServerPlayer player) {
		PLAYERS.remove(player);
		CloudDanger.forget(player);
	}

	/** What one read needs from the world: the current value and whether the player perceives the cell now. */
	public interface Source<V> {
		/** The cell's current value, or null when it cannot be known at all (unloaded, outside the world). */
		V live(int x, int y, int z);

		/** Whether the eye sees the cell now. Called only when the answer can change what is known. */
		boolean sees(int x, int y, int z);

		/** Action-time evidence must not reuse an earlier visibility frame after the world changes. */
		default boolean seesNow(int x, int y, int z) {
			return sees(x, y, z);
		}

		/** Whether the body touches the cell (stands in or on it): known without looking. */
		default boolean touches(int x, int y, int z) {
			return false;
		}
	}

	/** A point in one memory's history of acquired facts (see {@link Memory#changedSince}). */
	public record Stamp(Memory<?> memory, long version) {
	}

	/**
	 * Remembered cells of one observer: the value as last perceived, the tick it was last perceived and the tick it is
	 * forgotten. Also a log of the cells whose known value was acquired or changed, so a judgement built on what was
	 * known can tell whether that knowledge has moved on since.
	 */
	public static final class Memory<V> {
		private record Entry<V>(V value, long tick, long until) {
		}

		private final Long2ObjectOpenHashMap<Entry<V>> cells = new Long2ObjectOpenHashMap<>();
		private final LongArrayList changes = new LongArrayList();
		private final LongArrayList changeTicks = new LongArrayList();
		private long changesBase;
		private boolean pruned;
		private long prunedAt;
		// The tick of each second on which this observer re-checks unchanged cells: one sight frame a second, not one
		// a tick, and observers spread over the second.
		private final int recheckPhase = Math.floorMod(System.identityHashCode(this), (int) RECHECK_TICKS);

		public int size() {
			return cells.size();
		}

		/** Facts acquired so far: compare with {@link #changedSince}. */
		public Stamp stamp() {
			return new Stamp(this, changesBase + changes.size());
		}

		/**
		 * Whether a cell whose fact was acquired or changed after {@code stamp} passes {@code differs} (a cell the caller
		 * read, now known otherwise). A stamp from another memory, or older than the log keeps, counts as changed.
		 */
		public boolean changedSince(Stamp stamp, LongPredicate differs) {
			if (stamp.memory() != this || stamp.version() < changesBase) return true;
			for (int index = (int) (stamp.version() - changesBase); index < changes.size(); index++) {
				if (differs.test(changes.getLong(index))) return true;
			}
			return false;
		}

		private static boolean expired(Entry<?> entry, long tick) {
			return tick > entry.until() || tick < entry.tick();
		}

		private Entry<V> fresh(long key, long tick) {
			Entry<V> entry = cells.get(key);
			if (entry == null) return null;
			if (expired(entry, tick)) {
				cells.remove(key);
				return null;
			}
			return entry;
		}

		/** The remembered value without touching the memory (expired entries stay until the next prune). */
		V peek(long key, long tick) {
			Entry<V> entry = cells.get(key);
			return entry == null || expired(entry, tick) ? null : entry.value();
		}

		/** Records that the cell was perceived as {@code value} at {@code tick}, kept for {@code lifetime} ticks. */
		void learn(long key, V value, long tick, long lifetime) {
			Entry<V> old = fresh(key, tick);
			boolean same = old != null && old.value().equals(value);
			long until = same ? Math.max(old.until(), tick + lifetime) : tick + lifetime;
			cells.put(key, new Entry<>(value, tick, until));
			if (same) return;
			changes.add(key);
			changeTicks.add(tick);
		}

		/** Drops expired cells and old log entries, at most once a second. */
		void prune(long tick) {
			if (pruned && tick >= prunedAt && tick - prunedAt < RECHECK_TICKS) return;
			pruned = true;
			prunedAt = tick;
			cells.values().removeIf(entry -> expired(entry, tick));
			int old = 0;
			while (old < changeTicks.size() && (tick - changeTicks.getLong(old) > WALKED_MEMORY_TICKS || tick < changeTicks.getLong(old))) old++;
			if (old == 0) return;
			changes.removeElements(0, old);
			changeTicks.removeElements(0, old);
			changesBase += old;
		}
	}

	/**
	 * Reads cells as one observer knows them at one tick: {@link #known} gives the value or null when unknown. Values
	 * read are cached, so every consumer this tick agrees and pays once.
	 */
	public static final class Reader<V> {
		private final Memory<V> memory;
		private final Source<V> source;
		private final long tick;
		private final LongOpenHashSet hidden;
		private final Long2ObjectOpenHashMap<Object> read = new Long2ObjectOpenHashMap<>();
		private final LongOpenHashSet seenNow = new LongOpenHashSet();
		private final LongOpenHashSet eyeSeen = new LongOpenHashSet();

		/** {@code hidden}: cells this pose already failed to see (shared while the pose holds), or a new set. */
		public Reader(Memory<V> memory, Source<V> source, long tick, LongOpenHashSet hidden) {
			this.memory = Objects.requireNonNull(memory, "memory must not be null");
			this.source = Objects.requireNonNull(source, "source must not be null");
			this.tick = tick;
			this.hidden = hidden == null ? new LongOpenHashSet() : hidden;
			memory.prune(tick);
		}

		public long tick() {
			return tick;
		}

		/**
		 * Acquires the cells along a requested inspection ray, including its target. Each cell still passes the shared
		 * sight/contact gate; traversing a line never grants knowledge of hidden cells. Action time only.
		 */
		public void acquireSightline(Vec3 eye, Vec3 target) {
			net.minecraft.world.level.BlockGetter.traverseBlocks(eye, target, this, (reader, cell) -> {
				reader.known(cell.getX(), cell.getY(), cell.getZ());
				return null;
			}, reader -> null);
		}

		/** The facts known so far, for {@link #changedSince}. */
		public Stamp stamp() {
			return memory.stamp();
		}

		/** {@link Memory#changedSince} on this observer's memory (true when the memory was reset since). */
		public boolean changedSince(Stamp stamp, LongPredicate differs) {
			return memory.changedSince(stamp, differs);
		}

		/** The cell as the observer knows it: seen or touched now, else as remembered, else null (unknown). */
		@SuppressWarnings("unchecked")
		public V known(int x, int y, int z) {
			long key = BlockPos.asLong(x, y, z);
			Object cached = read.get(key);
			if (cached != null) return cached == UNKNOWN ? null : (V) cached;
			V value = resolve(key, x, y, z);
			read.put(key, value == null ? UNKNOWN : value);
			return value;
		}

		/**
		 * Whether a fact about the cell is remembered now, without reading the world or casting a ray. A caller that
		 * only needs "is it known as X" can skip {@link #known} for a cell that is neither remembered nor X now.
		 */
		public boolean remembers(int x, int y, int z) {
			return memory.fresh(BlockPos.asLong(x, y, z), tick) != null;
		}

		/** Remembered positions and values only, with no world read or sight ray, for recalling distant landings. */
		public long[] rememberedPositions() {
			return memory.cells.keySet().toLongArray();
		}

		public V recalled(int x, int y, int z) {
			Memory.Entry<V> entry = memory.fresh(BlockPos.asLong(x, y, z), tick);
			return entry == null ? null : entry.value();
		}

		public int recalledAge(int x, int y, int z) {
			Memory.Entry<V> entry = memory.fresh(BlockPos.asLong(x, y, z), tick);
			return entry == null ? 0 : (int) Math.max(0L, (tick - entry.tick() + 19L) / 20L);
		}

		public boolean touches(int x, int y, int z) {
			return source.touches(x, y, z);
		}

		private V resolve(long key, int x, int y, int z) {
			Memory.Entry<V> remembered = memory.fresh(key, tick);
			V live = source.live(x, y, z);
			if (live == null) return remembered == null ? null : remembered.value();
			if (remembered != null && remembered.value().equals(live)) {
				// Seen or hidden, the answer is the same value: no ray, except a once-a-second check that keeps the
				// last-seen tick on the last actual sighting.
				if (tick - remembered.tick() >= RECHECK_TICKS && Math.floorMod(tick, RECHECK_TICKS) == memory.recheckPhase) {
					perceive(key, x, y, z, live);
				}
				return live;
			}
			return perceive(key, x, y, z, live) ? live : remembered == null ? null : remembered.value();
		}

		/** Touch or sight now: remembers the live value from this tick. */
		private boolean perceive(long key, int x, int y, int z, V live) {
			if (source.touches(x, y, z)) {
				memory.learn(key, live, tick, WALKED_MEMORY_TICKS);
			} else if (eye(key, x, y, z)) {
				memory.learn(key, live, tick, MEMORY_TICKS);
			} else {
				return false;
			}
			seenNow.add(key);
			return true;
		}

		private boolean eye(long key, int x, int y, int z) {
			if (eyeSeen.contains(key)) return true;
			if (hidden.contains(key)) return false;
			if (source.sees(x, y, z)) {
				eyeSeen.add(key);
				return true;
			}
			hidden.add(key);
			return false;
		}

		/** Whether the eye sees (or the body touches) the cell now, as opposed to remembering it. */
		public boolean seesNow(int x, int y, int z) {
			long key = BlockPos.asLong(x, y, z);
			refreshEye(key, x, y, z);
			V live = source.live(x, y, z);
			if (live == null || !perceive(key, x, y, z, live)) return false;
			read.put(key, live);
			return true;
		}

		/**
		 * Whether the eye itself sees the cell now (body contact excluded): for wording that says "seen". Remembers the
		 * cell when it does.
		 */
		public boolean eyeSeesNow(int x, int y, int z) {
			long key = BlockPos.asLong(x, y, z);
			refreshEye(key, x, y, z);
			V live = source.live(x, y, z);
			if (live == null || !eye(key, x, y, z)) return false;
			memory.learn(key, live, tick, MEMORY_TICKS);
			seenNow.add(key);
			read.put(key, live);
			return true;
		}

		/** Current sight replaces both positive and negative cached evidence, even at an unchanged pose/tick. */
		private void refreshEye(long key, int x, int y, int z) {
			seenNow.remove(key);
			if (source.seesNow(x, y, z)) {
				hidden.remove(key);
				eyeSeen.add(key);
			} else {
				eyeSeen.remove(key);
				hidden.add(key);
			}
		}

		/** Last tick this acquired fact remains known, without reading the world or casting a sight ray. */
		public long rememberedUntil(int x, int y, int z) {
			Memory.Entry<V> entry = memory.fresh(BlockPos.asLong(x, y, z), tick);
			return entry == null ? Long.MIN_VALUE : entry.until();
		}

		/** 0 for a cell seen now or unknown; otherwise whole seconds (at least 1) since the remembered cell was perceived. */
		public int secondsSinceSeen(int x, int y, int z) {
			if (seesNow(x, y, z)) return 0;
			Memory.Entry<V> remembered = memory.fresh(BlockPos.asLong(x, y, z), tick);
			return remembered == null ? 0 : (int) Math.max(1L, (tick - remembered.tick() + 19L) / 20L);
		}
	}

	/** The cells one body touches: its own cells and, on the ground, those right under the foot surface. */
	record Contact(int minX, int minY, int minZ, int maxX, int maxY, int maxZ) {
		private static final double EDGE = 1.0E-4D;

		static Contact of(AABB box, boolean onGround) {
			// Under the foot surface, not a whole cell below it: on a bottom slab (feet at y + 0.5) that is the slab.
			int minY = onGround ? Mth.floor(box.minY - EDGE) : Mth.floor(box.minY + EDGE);
			return new Contact(Mth.floor(box.minX + EDGE), minY, Mth.floor(box.minZ + EDGE),
					Mth.floor(box.maxX - EDGE), Mth.floor(box.maxY - EDGE), Mth.floor(box.maxZ - EDGE));
		}

		boolean contains(int x, int y, int z) {
			return x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ;
		}
	}

	private static final class PlayerMemory {
		final ServerLevel level;
		final Memory<BlockState> memory = new Memory<>();
		Reader<BlockState> reader;
		Vec3 eye;
		float yaw;
		float pitch;
		long poseSince;
		LongOpenHashSet hidden;
		Contact felt;
		long feltAt;

		PlayerMemory(ServerLevel level) {
			this.level = level;
		}
	}

	/** This body's memory in its current world: a new body or another dimension starts empty. */
	private static PlayerMemory state(ServerPlayer player, ServerLevel level, long tick) {
		if (tick - sweptAt >= RECHECK_TICKS || tick < sweptAt) {
			sweptAt = tick;
			// Backstop for a removal no event reported: never keep a body that left the world. A body that has stopped
			// acting is pruned here too, so its expired cells go even though nothing reads them.
			PLAYERS.keySet().removeIf(body -> body != player && body.isRemoved());
			for (PlayerMemory remembered : PLAYERS.values()) remembered.memory.prune(tick);
		}
		PlayerMemory state = PLAYERS.get(player);
		if (state == null || state.level != level) {
			state = new PlayerMemory(level);
			PLAYERS.put(player, state);
		}
		return state;
	}

	/**
	 * Remembers the cells the body touches now, so the ground it walked stays known behind it. Cheap when the body has
	 * not moved to new cells: one comparison, and a refresh once a second. Server thread only.
	 */
	public static void feel(ServerPlayer player) {
		Objects.requireNonNull(player, "player must not be null");
		ServerLevel level = player.level();
		long tick = level.getGameTime();
		PlayerMemory state = state(player, level, tick);
		Contact contact = Contact.of(player.getBoundingBox(), player.onGround());
		if (contact.equals(state.felt) && tick >= state.feltAt && tick - state.feltAt < RECHECK_TICKS) return;
		state.felt = contact;
		state.feltAt = tick;
		state.memory.prune(tick);
		BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
		for (int x = contact.minX(); x <= contact.maxX(); x++) {
			for (int z = contact.minZ(); z <= contact.maxZ(); z++) {
				if (!level.hasChunk(x >> 4, z >> 4)) continue;
				for (int y = contact.minY(); y <= contact.maxY(); y++) {
					if (level.isOutsideBuildHeight(y)) continue;
					state.memory.learn(BlockPos.asLong(x, y, z), level.getBlockState(cursor.set(x, y, z)), tick, WALKED_MEMORY_TICKS);
				}
			}
		}
	}

	/**
	 * This player's terrain knowledge for the current tick: the same reader for every consumer while the world, tick
	 * and eye pose hold. Server thread only.
	 */
	public static Reader<BlockState> of(ServerPlayer player) {
		Objects.requireNonNull(player, "player must not be null");
		ServerLevel level = player.level();
		long tick = level.getGameTime();
		PlayerMemory state = state(player, level, tick);
		Vec3 eye = player.getEyePosition();
		float yaw = player.getYRot();
		float pitch = player.getXRot();
		boolean samePose = eye.equals(state.eye) && yaw == state.yaw && pitch == state.pitch;
		if (samePose && state.reader != null && state.reader.tick() == tick) return state.reader;
		feel(player);
		if (!samePose || state.hidden == null || tick - state.poseSince >= RECHECK_TICKS || tick < state.poseSince) {
			state.hidden = new LongOpenHashSet();
			state.poseSince = tick;
		}
		state.eye = eye;
		state.yaw = yaw;
		state.pitch = pitch;
		state.reader = new Reader<>(state.memory, source(player, level), tick, state.hidden);
		return state.reader;
	}

	private static Source<BlockState> source(ServerPlayer player, ServerLevel level) {
		BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
		Contact contact = Contact.of(player.getBoundingBox(), player.onGround());
		return new Source<>() {
			// Built on the first sight ray: most ticks answer every read from memory.
			private ObservationVisibility.Frame sight;

			@Override
			public BlockState live(int x, int y, int z) {
				if (level.isOutsideBuildHeight(y) || !level.hasChunk(x >> 4, z >> 4)) return null;
				return level.getBlockState(cursor.set(x, y, z));
			}

			@Override
			public boolean sees(int x, int y, int z) {
				if (sight == null) sight = ObservationVisibility.frame(level, player);
				return sight.seesCell(cursor.set(x, y, z));
			}

			@Override
			public boolean seesNow(int x, int y, int z) {
				sight = ObservationVisibility.frame(level, player);
				return sight.seesCell(cursor.set(x, y, z));
			}

			@Override
			public boolean touches(int x, int y, int z) {
				return contact.contains(x, y, z);
			}
		};
	}
}
