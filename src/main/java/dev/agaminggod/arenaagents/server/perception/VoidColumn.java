package dev.agaminggod.arenaagents.server.perception;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.Level;

/**
 * Whether a column is empty from a height down past the world's bottom: the void a player sees over an End island
 * edge (nothing below, not even a far floor). Dimensions with a bedrock floor never have one. Footing facts otherwise
 * stop at the first unseen cell and say "at least N blocks", which reads like a survivable drop.
 */
public final class VoidColumn {
	private VoidColumn() {
	}

	/** True when every cell from {@code fromY} down to the world's lowest cell at (x, z) is air with no fluid. */
	public static boolean below(Level level, int x, int fromY, int z) {
		int bottom = level.getMinY();
		if (fromY < bottom) return true;
		if (!level.hasChunkAt(new BlockPos(x, fromY, z))) return false;
		BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
		for (int y = fromY; y >= bottom; y--) {
			var state = level.getBlockState(cursor.set(x, y, z));
			if (!state.isAir() || !state.getFluidState().isEmpty()) return false;
		}
		return true;
	}
}
