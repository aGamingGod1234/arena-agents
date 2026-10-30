package dev.agaminggod.arenaagents.mixin;

import carpet.patches.EntityPlayerMPFake;
import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import dev.agaminggod.arenaagents.server.perception.EyeFlightObservation;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.projectile.EyeOfEnder;
import net.minecraft.world.item.EnderEyeItem;
import net.minecraft.world.level.Level;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

@Mixin(EnderEyeItem.class)
abstract class EnderEyeThrowMixin {
	@WrapOperation(method = "use", at = @At(value = "INVOKE",
			target = "Lnet/minecraft/world/level/Level;addFreshEntity(Lnet/minecraft/world/entity/Entity;)Z"))
	private boolean arenaagents$watchThrownEye(Level level, Entity entity, Operation<Boolean> original,
			Level useLevel, Player player, InteractionHand hand) {
		boolean added = original.call(level, entity);
		if (added && player instanceof EntityPlayerMPFake && entity instanceof EyeOfEnder eye) EyeFlightObservation.thrown((ServerPlayer) player, eye);
		return added;
	}
}
