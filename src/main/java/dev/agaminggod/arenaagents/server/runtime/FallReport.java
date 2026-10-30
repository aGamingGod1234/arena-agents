package dev.agaminggod.arenaagents.server.runtime;

import java.util.Locale;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.DamageTypeTags;
import net.minecraft.world.damagesource.DamageSource;

/**
 * The worst fall the body took while one action ran, as the player feels it: the height from the ground it left to
 * where it landed, and the action's total health lost to fall damage. Reported on the action's result only when the
 * drop could hurt (4 blocks or more: vanilla fall damage is floor(distance - 3)) or fall damage was taken, so an ordinary step or jump adds nothing.
 */
final class FallReport {
	private static final double HURTFUL_DROP = 4.0D - 1.0E-3D;
	private double groundY = Double.NaN;
	private boolean airborne;
	private double worstDrop;
	private String worstInto;
	private float lastHealth = Float.NaN;
	private double fallDamage;

	void observe(ServerPlayer player) {
		DamageSource source = player.getLastDamageSource();
		String fluid = player.isInLava() ? "lava" : player.isInWater() ? "water" : null;
		observe(player.getY(), player.onGround() || player.onClimbable(), fluid, player.getHealth(),
				source != null && source.is(DamageTypeTags.IS_FALL));
	}

	/** One tick: feet height, standing (or climbing), the fluid the body is in, health, and whether the last hurt was a fall. */
	void observe(double y, boolean standing, String fluid, float health, boolean hurtByFall) {
		if (!Float.isNaN(lastHealth) && health < lastHealth && hurtByFall) fallDamage += lastHealth - health;
		lastHealth = health;
		if (!standing && fluid == null) {
			airborne = true;
			return;
		}
		if (airborne && !Double.isNaN(groundY) && groundY - y > worstDrop) {
			worstDrop = groundY - y;
			worstInto = fluid;
		}
		airborne = false;
		// A swimming body has no ground to fall from until it stands again.
		groundY = fluid == null ? y : Double.NaN;
	}

	/** "; fell 9 blocks; fall HP sum 7.0" (or "; fall HP sum 1.0") for a result message, or "" when nothing hurtful happened. */
	String describe() {
		boolean hurtfulDrop = worstDrop >= HURTFUL_DROP;
		if (!hurtfulDrop && fallDamage <= 0.0D) return "";
		StringBuilder text = new StringBuilder("; ");
		if (hurtfulDrop) {
			text.append("fell ").append(Math.round(worstDrop)).append(" blocks");
			if (worstInto != null) text.append(" into ").append(worstInto);
			if (fallDamage > 0.0D) text.append("; ");
		}
		if (fallDamage > 0.0D) text.append("fall HP sum ").append(String.format(Locale.ROOT, "%.1f", fallDamage));
		return text.toString();
	}
}
