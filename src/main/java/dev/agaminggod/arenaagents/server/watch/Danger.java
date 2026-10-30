package dev.agaminggod.arenaagents.server.watch;

/**
 * One real danger the truth scan found around an agent this tick. {@code key} merges readings from the same source into
 * one episode (an entity's UUID, a projectile's shooter, or the hazard kind for terrain and body state). {@code block}
 * is the hazard cell (null for entities), {@code distance} the gap to it in blocks (0 in contact), {@code etaS} the
 * estimated seconds until it can harm the agent (0 = harming now).
 */
public record Danger(String key, String kind, String sourceType, String entityId, int[] block, double etaS, double distance) {
	public Danger {
		if (key == null || kind == null || sourceType == null) throw new IllegalArgumentException("key, kind and sourceType are required");
		etaS = Double.isFinite(etaS) ? Math.max(0.0D, etaS) : Double.POSITIVE_INFINITY;
	}
}
