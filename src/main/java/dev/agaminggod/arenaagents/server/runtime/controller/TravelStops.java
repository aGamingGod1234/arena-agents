package dev.agaminggod.arenaagents.server.runtime.controller;

import java.util.Set;

/**
 * Which hostiles and which damage end a travel_to trip and hand it back to the model. A player on a night trip does not
 * stop for every mob that comes into view or for a berry-bush scratch: a mob that is not after them, or that falls
 * behind while they sprint on, is passed; a small knock from a bush, a cactus or a short drop is shrugged off. The trip
 * still stops for anything up close, for a mob targeting the body and closing in, for a ranged mob targeting it (it
 * hits from where it stands), and for every hit from a mob, burning, drowning or anything else.
 */
public final class TravelStops {
	private TravelStops() {
	}

	/** A hostile this close always stops the trip (blocks). */
	public static final double CLOSE = 6.0D;
	/** How much nearer a targeting mob must get between two samples (a quarter second apart) to count as closing in. */
	public static final double CLOSING_STEP = 0.25D;
	/** Most environmental damage one hit may do and still be shrugged off. */
	public static final float MINOR_HIT = 2.0F;
	/** Most environmental damage shrugged off over one trip. */
	public static final float MINOR_TOTAL = 4.0F;
	/** Damage kinds a passing body takes from the terrain itself, with no attacker. */
	static final Set<String> MINOR_SOURCES = Set.of("sweetBerryBush", "cactus", "fall");
	/** Mobs that hurt from range: once targeting, they are a reason to stop wherever they are. */
	static final Set<String> RANGED = Set.of("minecraft:skeleton", "minecraft:stray", "minecraft:bogged", "minecraft:pillager",
			"minecraft:blaze", "minecraft:ghast", "minecraft:witch", "minecraft:shulker", "minecraft:breeze", "minecraft:evoker",
			"minecraft:illusioner", "minecraft:drowned", "minecraft:piglin");

	/**
	 * Whether a hostile in range stops the trip now. {@code known} was in view when the trip began; {@code previous} is
	 * its distance at the last sample (null on its first).
	 */
	public static boolean stopsFor(boolean known, double distance, Double previous, boolean targeting, String typeId) {
		if (distance <= CLOSE) return true;
		if (known || !targeting) return false;
		if (RANGED.contains(typeId)) return true;
		return previous != null && previous - distance >= CLOSING_STEP;
	}

	/**
	 * Whether this hit is shrugged off: terrain damage with no attacker ({@code msgId} a bush, cactus or fall), at most
	 * {@link #MINOR_HIT}, within {@link #MINOR_TOTAL} for the trip, and leaving health above {@code minHealth}.
	 */
	public static boolean shrugsOff(String msgId, boolean fromEntity, float lost, float shruggedSoFar, float health, float minHealth) {
		return !fromEntity && msgId != null && MINOR_SOURCES.contains(msgId) && lost <= MINOR_HIT
				&& shruggedSoFar + lost <= MINOR_TOTAL && health > minHealth;
	}
}
