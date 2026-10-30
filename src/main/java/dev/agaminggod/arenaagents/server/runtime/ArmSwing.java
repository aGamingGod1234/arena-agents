package dev.agaminggod.arenaagents.server.runtime;

import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.LivingEntity;

/**
 * Minecraft 26.3 split the held item's swing animation into an attack and an interact animation and made
 * {@link LivingEntity#swing} take one. Attacks and digs swing like vanilla's punch packet; block, item and entity
 * use swings like vanilla's use handlers. Watchers see the same arm swing as before; {@code toSelf} keeps the old
 * {@code swing(hand, true)} behaviour.
 */
public final class ArmSwing {
	private ArmSwing() {
	}

	public static void attack(LivingEntity entity, InteractionHand hand) {
		entity.swing(hand, entity.getItemInHand(hand).getAttackAnimation(), false);
	}

	public static void use(LivingEntity entity, InteractionHand hand) {
		use(entity, hand, false);
	}

	public static void use(LivingEntity entity, InteractionHand hand, boolean toSelf) {
		entity.swing(hand, entity.getItemInHand(hand).getInteractAnimation(), toSelf);
	}
}
