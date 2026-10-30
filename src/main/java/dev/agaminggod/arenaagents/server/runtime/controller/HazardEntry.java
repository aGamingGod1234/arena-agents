package dev.agaminggod.arenaagents.server.runtime.controller;

import net.minecraft.server.level.ServerPlayer;

/**
 * The one hazard stop rule for every model action (the executor's actions, fight and flee): stop when the body newly
 * enters damaging lava or touches a fire block ({@link HazardExits#contact}). Burning alone (a blaze, a flaming arrow)
 * is a body fact, not terrain the action walked into, so it never stops anything. Contact present when the action
 * started is the model's informed choice and only sets the baseline. A fire-immune body (Fire Resistance, creative)
 * counts as touching nothing, so lava that becomes damaging again (the effect runs out) stops it like a new entry.
 */
public final class HazardEntry {
	public static final String IN_LAVA = "IN_LAVA";
	public static final String ON_FIRE = "ON_FIRE";

	private boolean started;
	private boolean lava;
	private boolean fire;

	/** One tick for this body; IN_LAVA or ON_FIRE on the tick it newly enters damaging lava or fire, otherwise null. */
	public String observe(ServerPlayer player) {
		return observe(HazardExits.fireResistant(player) ? null : HazardExits.contact(player));
	}

	/** One tick, given the damaging contact (null when none or the body is immune). */
	String observe(HazardExits.Contact contact) {
		boolean inLava = contact == HazardExits.Contact.LAVA;
		boolean inFire = contact == HazardExits.Contact.FIRE;
		String code = null;
		if (started) {
			if (inLava && !lava) code = IN_LAVA;
			else if (inFire && !fire) code = ON_FIRE;
		}
		started = true;
		lava = inLava;
		fire = inFire;
		return code;
	}
}
