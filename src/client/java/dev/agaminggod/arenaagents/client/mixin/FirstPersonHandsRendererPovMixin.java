package dev.agaminggod.arenaagents.client.mixin;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import com.mojang.blaze3d.vertex.PoseStack;
import dev.agaminggod.arenaagents.client.pov.PovClient;
import net.minecraft.client.renderer.FirstPersonHandsAndItemsRenderer;
import net.minecraft.client.renderer.SubmitNodeCollector;
import net.minecraft.client.renderer.state.level.FirstPersonHandsAndItemsRenderState;
import net.minecraft.client.renderer.state.level.PlayerRenderState;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.item.ItemStack;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

/**
 * During an agent view the two arm draws are skipped while the agent entity is unavailable (signal lost, dead) and
 * while spectate free look hides the hands (PovClient.handsHidden). Everything else about the hands is the agent's
 * (ItemInHandRendererPovMixin, ScreenEffectRendererPovMixin).
 */
@Mixin(FirstPersonHandsAndItemsRenderer.class)
abstract class FirstPersonHandsRendererPovMixin {
	@WrapOperation(method = "submitHandsWithItems", at = @At(value = "INVOKE",
			target = "Lnet/minecraft/client/renderer/FirstPersonHandsAndItemsRenderer;submitArmWithItem(Lnet/minecraft/client/renderer/state/level/PlayerRenderState;"
					+ "Lnet/minecraft/client/renderer/state/level/FirstPersonHandsAndItemsRenderState;FFLnet/minecraft/world/InteractionHand;FLnet/minecraft/world/item/ItemStack;F"
					+ "Lcom/mojang/blaze3d/vertex/PoseStack;Lnet/minecraft/client/renderer/SubmitNodeCollector;I)V"))
	private void arenaagents$povArm(FirstPersonHandsAndItemsRenderer renderer, PlayerRenderState player, FirstPersonHandsAndItemsRenderState hands,
			float partialTick, float pitch, InteractionHand hand, float attack, ItemStack stack, float inverseArmHeight, PoseStack poseStack,
			SubmitNodeCollector collector, int light, Operation<Void> original) {
		if (PovClient.isActive() && (PovClient.agentPlayer() == null || PovClient.handsHidden())) return;
		original.call(renderer, player, hands, partialTick, pitch, hand, attack, stack, inverseArmHeight, poseStack, collector, light);
	}
}
