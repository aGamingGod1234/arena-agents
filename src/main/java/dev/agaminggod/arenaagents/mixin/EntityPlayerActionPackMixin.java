package dev.agaminggod.arenaagents.mixin;

import carpet.helpers.EntityPlayerActionPack;
import carpet.patches.EntityPlayerMPFake;
import dev.agaminggod.arenaagents.server.runtime.controller.BrinkGuard;
import dev.agaminggod.arenaagents.server.runtime.input.CarpetActionArbitration;
import dev.agaminggod.arenaagents.server.runtime.input.CarpetInputStateSink;
import dev.agaminggod.arenaagents.server.runtime.input.ModelPlayerInputBridge;
import dev.agaminggod.arenaagents.server.runtime.input.VanillaMoveInput;
import dev.agaminggod.arenaagents.server.runtime.input.VanillaSprint;
import java.util.function.Supplier;
import net.minecraft.server.level.ServerPlayer;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Redirect;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(value = EntityPlayerActionPack.class, remap = false)
abstract class EntityPlayerActionPackMixin {
	@Inject(method = "getTarget", at = @At("HEAD"), cancellable = true)
	private static void arenaagents$reuseAttackTarget(ServerPlayer player,
			org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable<net.minecraft.world.phys.HitResult> callback) {
		net.minecraft.world.phys.HitResult target = CarpetInputStateSink.takeAttackTarget(player);
		if (target != null) callback.setReturnValue(target);
	}

	@Shadow
	@Final
	private ServerPlayer player;

	@Shadow
	private float forward;

	@Shadow
	private float strafing;

	@Shadow
	private boolean sprinting;

	@Shadow
	private boolean sneaking;

	@Inject(method = "onUpdate", at = @At("TAIL"))
	private void arenaagents$applyAuthoredVehicleInputs(CallbackInfo callback) {
		// Replaces Carpet's sneak-only 0.3 with the client's item-use, crouch/crawl and Swift Sneak scaling.
		if (player instanceof EntityPlayerMPFake) {
			// A lethal brink: crouch at its lip and hold a still stance against shoves (BrinkGuard).
			BrinkGuard.Keys keys = ModelPlayerInputBridge.guard(player, forward, strafing, sneaking);
			BrinkGuard.applySneak(player, keys);
			// Carpet's held jump action set the jump key earlier this tick; a refused jump lets go of it before the move.
			if (keys.jumpRefused()) player.setJumping(false);
			// An airborne walk-back lowers a raised shield (ruling 15) before the move reads the item-use slowdown.
			if (keys.lowerShield() && player.isUsingItem()) player.releaseUsingItem();
			VanillaMoveInput.apply(player, keys.forward(), keys.strafe());
			// Runs before this tick's move, so the collision and movement are last tick's, as on a client.
			boolean keep = VanillaSprint.keeps(sprinting && !keys.sneak(), keys.forward(), player.horizontalCollision,
					VanillaSprint.minorCollision(player.getYRot(), keys.strafe(), keys.forward(), player.getX() - player.xo, player.getZ() - player.zo),
					player.isSwimming(), VanillaSprint.enoughFood(player.isPassenger(), player.getFoodData().getFoodLevel(),
							player.getAbilities().mayfly));
			if (player.isSprinting() != keep) player.setSprinting(keep);
		}
		ModelPlayerInputBridge.tickPlayer(player);
	}

	@Redirect(
			method = "onUpdate",
			at = @At(
					value = "INVOKE",
					target = "Lcarpet/helpers/EntityPlayerActionPack$Action;tick(Lcarpet/helpers/EntityPlayerActionPack;Lcarpet/helpers/EntityPlayerActionPack$ActionType;)Ljava/lang/Boolean;"
			)
	)
	private Boolean arenaagents$arbitrateExactHandUse(
			EntityPlayerActionPack.Action action,
			EntityPlayerActionPack actionPack,
			EntityPlayerActionPack.ActionType actionType
	) {
		Supplier<Boolean> original = () -> ((EntityPlayerActionInvoker) (Object) action)
				.arenaagents$invokeTick(actionPack, actionType);
		if (actionType != EntityPlayerActionPack.ActionType.ATTACK) return original.get();
		// Null is Carpet's skipped-Action.tick result; onUpdate retains continuous actions until Action.done is true.
		return CarpetActionArbitration.arbitrate(player,
				() -> CarpetInputStateSink.tickAttack(player, action, original));
	}
}
