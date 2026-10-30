package dev.agaminggod.arenaagents.mixin;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import dev.agaminggod.arenaagents.server.perception.EyeFlightObservation;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.projectile.EyeOfEnder;
import net.minecraft.world.level.Level;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(EyeOfEnder.class)
abstract class EyeOfEnderFlightMixin {
	@WrapOperation(method = "tick", at = @At(value = "INVOKE",
			target = "Lnet/minecraft/world/level/Level;addFreshEntity(Lnet/minecraft/world/entity/Entity;)Z"))
	private boolean arenaagents$watchDroppedItem(Level level, Entity entity, Operation<Boolean> original) {
		boolean added = original.call(level, entity);
		if (added && entity instanceof ItemEntity item) EyeFlightObservation.dropped((EyeOfEnder) (Object) this, item);
		return added;
	}

	@Inject(method = "tick", at = @At(value = "INVOKE",
			target = "Lnet/minecraft/world/level/Level;levelEvent(ILnet/minecraft/core/BlockPos;I)V"))
	private void arenaagents$watchShatter(CallbackInfo callback) {
		EyeFlightObservation.shattered((EyeOfEnder) (Object) this);
	}

	@Inject(method = "tick", at = @At("TAIL"))
	private void arenaagents$observeFlight(CallbackInfo callback) {
		EyeOfEnder eye = (EyeOfEnder) (Object) this;
		if (!eye.level().isClientSide()) EyeFlightObservation.ticked(eye);
	}
}
