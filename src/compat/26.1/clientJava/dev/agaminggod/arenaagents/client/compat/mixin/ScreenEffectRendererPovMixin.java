package dev.agaminggod.arenaagents.client.compat.mixin;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import dev.agaminggod.arenaagents.client.pov.PovClient;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.client.renderer.ScreenEffectRenderer;
import net.minecraft.tags.TagKey;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.Fluid;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

/**
 * Before 26.3 the in-block, underwater and fire overlays read the local player inside ScreenEffectRenderer.renderScreenEffect (26.1).
 * During an agent view the camera is the agent, so they read the agent instead and draw nothing while it is
 * unavailable (signal lost or dead); a spectating agent shows no fluid or fire overlay, as vanilla's own check does.
 */
@Mixin(ScreenEffectRenderer.class)
abstract class ScreenEffectRendererPovMixin {
	@WrapOperation(method = "renderScreenEffect", at = @At(value = "INVOKE",
			target = "Lnet/minecraft/client/renderer/ScreenEffectRenderer;getViewBlockingState(Lnet/minecraft/world/entity/player/Player;)Lnet/minecraft/world/level/block/state/BlockState;"))
	private BlockState arenaagents$povViewBlockingState(Player player, Operation<BlockState> original) {
		if (!PovClient.isActive()) return original.call(player);
		AbstractClientPlayer agent = PovClient.agentPlayer();
		return agent == null ? null : original.call(agent);
	}

	@WrapOperation(method = "renderScreenEffect", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/player/LocalPlayer;isSpectator()Z"))
	private boolean arenaagents$povSpectator(LocalPlayer player, Operation<Boolean> original) {
		if (!PovClient.isActive()) return original.call(player);
		AbstractClientPlayer agent = PovClient.agentPlayer();
		return agent == null || agent.isSpectator();
	}

	@WrapOperation(method = "renderScreenEffect", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/player/LocalPlayer;isEyeInFluid(Lnet/minecraft/tags/TagKey;)Z"))
	private boolean arenaagents$povEyeInFluid(LocalPlayer player, TagKey<Fluid> fluid, Operation<Boolean> original) {
		if (!PovClient.isActive()) return original.call(player, fluid);
		AbstractClientPlayer agent = PovClient.agentPlayer();
		return agent != null && agent.isEyeInFluid(fluid);
	}

	@WrapOperation(method = "renderScreenEffect", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/player/LocalPlayer;isOnFire()Z"))
	private boolean arenaagents$povOnFire(LocalPlayer player, Operation<Boolean> original) {
		if (!PovClient.isActive()) return original.call(player);
		AbstractClientPlayer agent = PovClient.agentPlayer();
		return agent != null && agent.isOnFire();
	}
}
