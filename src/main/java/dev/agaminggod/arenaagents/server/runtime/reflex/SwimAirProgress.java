package dev.agaminggod.arenaagents.server.runtime.reflex;

import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.Vec3;

/** Route distance, rather than endpoint distance, proves progress around a flooded ceiling. */
final class SwimAirProgress {
	private BlockPos destination;
	private double best = Double.POSITIVE_INFINITY;
	private int bestTick;

	static double remaining(Vec3 eye, List<BlockPos> path) {
		if (path.size() < 2) return 0.0D;
		double left = eye.distanceTo(Vec3.atCenterOf(path.get(1)));
		for (int i = 2; i < path.size(); i++) left += Math.sqrt(path.get(i - 1).distSqr(path.get(i)));
		return left;
	}

	boolean stalled(BlockPos target, double left, int tick) {
		if (!target.equals(destination)) {
			destination = target;
			best = Double.POSITIVE_INFINITY;
			bestTick = tick;
		}
		if (left < best - 0.25D) { best = left; bestTick = tick; }
		return tick - bestTick >= 40;
	}
}
