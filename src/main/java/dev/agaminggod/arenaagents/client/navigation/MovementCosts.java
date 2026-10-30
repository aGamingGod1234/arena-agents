package dev.agaminggod.arenaagents.client.navigation;

/** Vanilla 26.1 grounded travel estimates, separate from route exposure penalties. */
public final class MovementCosts {
	private static final double GROUND_DRAG = 0.6D * 0.91D;
	public static final double WALK_BLOCKS_PER_SECOND = 20.0D * 0.098D / (1.0D - GROUND_DRAG);

	private MovementCosts() { }

	/** Block speed factors damp retained velocity after movement, not the distance of the current tick. */
	public static double groundSpeedMultiplier(double blockSpeedFactor, int soulSpeedLevel) {
		double attributeMultiplier = soulSpeedLevel <= 0 ? 1.0D
				: 1.0D + (0.0405D + 0.0105D * (soulSpeedLevel - 1)) / 0.1D;
		return attributeMultiplier * (1.0D - GROUND_DRAG) / (1.0D - GROUND_DRAG * blockSpeedFactor);
	}

	/** Cobwebs reset retained velocity each tick as well as multiplying this tick's movement. */
	public static double cobwebSpeedMultiplier(boolean weaving) {
		return (weaving ? 0.5D : 0.25D) * (1.0D - GROUND_DRAG);
	}

	public static double seconds(double distance, double speedMultiplier, boolean sprint) {
		return distance / (WALK_BLOCKS_PER_SECOND * speedMultiplier * (sprint ? 1.3D : 1.0D));
	}

	public static long stallTimeout(long ordinaryTimeoutMs, double speedMultiplier) {
		return (long) Math.ceil(ordinaryTimeoutMs / Math.min(1.0D, speedMultiplier));
	}
}
