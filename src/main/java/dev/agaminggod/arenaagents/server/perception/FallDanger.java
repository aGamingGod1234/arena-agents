package dev.agaminggod.arenaagents.server.perception;

import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.ai.attributes.Attributes;

/** Mirrors 26.1 LivingEntity.calculateFallDamage, with observable fall immunity. */
public final class FallDanger {
	private FallDanger() {}
	public static int damage(ServerPlayer player) {
		if (player.fallDistance <= 0) return 0;
		if (player.hasEffect(MobEffects.SLOW_FALLING) || player.isIgnoringFallDamageFromCurrentImpulse()
				|| player.isInWater() || player.isInLava() || player.getAbilities().flying) return 0;
		return damage(player.fallDistance, player.getAttributeValue(Attributes.SAFE_FALL_DISTANCE),
				player.getAttributeValue(Attributes.FALL_DAMAGE_MULTIPLIER));
	}
	/** Snapshot estimate for the visible landing directly below, after vanilla protection and Resistance. */
	public static double reportedDamage(ServerPlayer player) {
		if (damage(player) == 0) return 0;
		var landing = player.level().clip(new net.minecraft.world.level.ClipContext(player.getEyePosition(),
				player.position().add(0, -16, 0), net.minecraft.world.level.ClipContext.Block.COLLIDER,
				net.minecraft.world.level.ClipContext.Fluid.ANY, player));
		var state = landing.getType() == net.minecraft.world.phys.HitResult.Type.BLOCK
				? player.level().getBlockState(landing.getBlockPos()) : null;
		var source = player.level().damageSources().fall();
		double reduced = landingDamage(player.fallDistance, player.getAttributeValue(Attributes.SAFE_FALL_DISTANCE),
				player.getAttributeValue(Attributes.FALL_DAMAGE_MULTIPLIER), state, player.isSuppressingBounce(),
				net.minecraft.world.item.enchantment.EnchantmentHelper.getDamageProtection(player.level(), player, source));
		var resistance = player.getEffect(MobEffects.RESISTANCE);
		if (resistance != null) reduced = ThreatDamage.resistanceScaled(reduced, resistance.getAmplifier());
		return Math.round(reduced * 10.0D) / 10.0D;
	}

	static double landingDamage(double distance, double safeDistance, double multiplier,
			net.minecraft.world.level.block.state.BlockState state, boolean suppressBounce, float protection) {
		if (state != null) {
			if (state.is(net.minecraft.world.level.block.Blocks.SLIME_BLOCK) && !suppressBounce) return 0;
			if (!state.getFluidState().isEmpty()) return 0;
			if (state.is(net.minecraft.world.level.block.Blocks.HAY_BLOCK)) multiplier *= 0.2D;
			else if (state.getBlock() instanceof net.minecraft.world.level.block.BedBlock) multiplier *= 0.5D;
		}
		return net.minecraft.world.damagesource.CombatRules.getDamageAfterMagicAbsorb(
				(float) damage(distance, safeDistance, multiplier), protection);
	}

	static int damage(double distance, double safeDistance, double multiplier) {
		return Math.max(0, (int) Math.floor((distance + 1.0E-6D - safeDistance) * multiplier));
	}
}
