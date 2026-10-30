package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import it.unimi.dsi.fastutil.longs.LongArrayList;
import java.util.Map;
import java.util.WeakHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Hazard facts (exits, lava beside a mining target) read terrain through the definition fight and flee share,
 * {@link SeenTerrain}: seen now (view cone and line of sight; lava is opaque) or touched, else remembered as it was when
 * last perceived (with its age), else unknown. One memory per body and world, reclaimed on expiry and on leaving.
 */
public final class SeenHazardTerrain {
	// Geometry changes invalidate this list; ages and expiry are still checked on every recall. Values retain no body.
	private static final Map<SeenTerrain.Memory<?>, Landings> REMEMBERED_LANDINGS = new WeakHashMap<>();
	private record Landings(long version, long[] positions) {
	}

	private SeenHazardTerrain() {
	}

	/** Cells as this player knows them, through the reader every consumer shares this tick. */
	static HazardExits.Cells of(ServerPlayer player) {
		return over(SeenTerrain.of(player), player.level(), player.isEyeInFluid(FluidTags.LAVA));
	}

	/** Hazard classes of the cells {@code seen} knows; {@code level} shapes a known block (its collision box). */
	static HazardExits.Cells over(SeenTerrain.Reader<BlockState> seen, BlockGetter level) {
		return over(seen, level, false);
	}

	static HazardExits.Cells over(SeenTerrain.Reader<BlockState> seen, BlockGetter level, boolean eyeInLava) {
		BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
		AcquiredGeometry geometry = new AcquiredGeometry(level, position -> eyeInLava && !seen.touches(position.getX(), position.getY(), position.getZ())
				? seen.recalled(position.getX(), position.getY(), position.getZ()) : seen.known(position.getX(), position.getY(), position.getZ()));
		AcquiredGeometry recalledGeometry = new AcquiredGeometry(level, position -> seen.recalled(position.getX(), position.getY(), position.getZ()));
		return new HazardExits.Cells() {
			@Override
			public HazardExits.Cell at(int x, int y, int z) {
				// Opaque lava permits no new sight: only current body contact and saved facts can answer.
				BlockState state = eyeInLava && !seen.touches(x, y, z) ? seen.recalled(x, y, z) : seen.known(x, y, z);
				return state == null ? HazardExits.Cell.UNKNOWN : classify(geometry, cursor.set(x, y, z), state);
			}

			/** Seen or not, a cell neither remembered nor now of that kind cannot be known as it, so no sight ray is cast. */
			@Override
			public boolean is(int x, int y, int z, HazardExits.Cell expected) {
				if (eyeInLava) return at(x, y, z) == expected;
				if (!seen.remembers(x, y, z)) {
					// State-only exclusions save sight rays; geometry must never consult hidden neighbours.
					BlockState candidate = level.getBlockState(cursor.set(x, y, z));
					HazardExits.Cell hazard = HazardExits.hazard(candidate);
					if (hazard != null && hazard != expected || hazard == null
							&& (expected == HazardExits.Cell.LAVA || expected == HazardExits.Cell.FIRE || expected == HazardExits.Cell.HOT)
							|| candidate.isAir() && expected != HazardExits.Cell.OPEN) return false;
				}
				return at(x, y, z) == expected;
			}

			@Override
			public int secondsSinceSeen(int x, int y, int z) {
				return eyeInLava && !seen.touches(x, y, z) ? seen.recalledAge(x, y, z) : seen.secondsSinceSeen(x, y, z);
			}

			@Override
			public long[] rememberedPositions() {
				SeenTerrain.Stamp stamp = seen.stamp();
				Landings cached = REMEMBERED_LANDINGS.get(stamp.memory());
				if (cached != null && cached.version() == stamp.version()) return cached.positions();
				LongArrayList positions = new LongArrayList();
				for (long key : seen.rememberedPositions()) {
					int x = BlockPos.getX(key), y = BlockPos.getY(key), z = BlockPos.getZ(key);
					if (recalled(x, y, z) == HazardExits.Cell.OPEN && recalled(x, y - 1, z) == HazardExits.Cell.SOLID
							&& recalled(x, y + 1, z) == HazardExits.Cell.OPEN) positions.add(key);
				}
				long[] result = positions.toLongArray();
				REMEMBERED_LANDINGS.put(stamp.memory(), new Landings(stamp.version(), result));
				return result;
			}

			@Override
			public HazardExits.Cell recalled(int x, int y, int z) {
				BlockState state = seen.recalled(x, y, z);
				return state == null ? HazardExits.Cell.UNKNOWN : classify(recalledGeometry, cursor.set(x, y, z), state);
			}

			@Override
			public int recalledAge(int x, int y, int z) {
				return seen.recalledAge(x, y, z);
			}
		};
	}
	private static HazardExits.Cell classify(AcquiredGeometry geometry, BlockPos position, BlockState state) {
		HazardExits.Cell hazard = HazardExits.hazard(state);
		if (hazard != null) return hazard;
		var shape = geometry.shape(state, position);
		return shape == null ? HazardExits.Cell.UNKNOWN : shape.isEmpty() ? HazardExits.Cell.OPEN : HazardExits.Cell.SOLID;
	}
}
