package dev.agaminggod.arenaagents.client.compat.mixin;

import com.llamalad7.mixinextras.injector.ModifyExpressionValue;
import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import com.mojang.blaze3d.vertex.PoseStack;
import dev.agaminggod.arenaagents.client.pov.PovClient;
import dev.agaminggod.arenaagents.client.pov.PovHands;
import dev.agaminggod.arenaagents.client.pov.PovHudProxy;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.client.renderer.ItemInHandRenderer;
import net.minecraft.client.renderer.SubmitNodeCollector;
import net.minecraft.client.renderer.entity.EntityRenderDispatcher;
import net.minecraft.client.renderer.entity.player.AvatarRenderer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.player.PlayerModelPart;
import net.minecraft.world.entity.player.PlayerSkin;
import net.minecraft.world.entity.vehicle.boat.AbstractBoat;
import net.minecraft.world.item.ItemStack;
import org.objectweb.asm.Opcodes;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

/**
 * First-person hands during an agent view are the agent's. Before 26.3 ItemInHandRenderer both reads the player and
 * draws the arms: each arm draw takes the agent as its player (swing, item use, scoping, main arm come from it), the
 * view, bob, attack swing and arm skin are read from the agent, and the arm draws are skipped while the agent is
 * unavailable or free look hides the hands. The 26.3 split of this class is handled by its own mixins.
 */
@Mixin(ItemInHandRenderer.class)
abstract class ItemInHandRendererPovMixin {
	private static final String ARM_WITH_ITEM = "Lnet/minecraft/client/renderer/ItemInHandRenderer;submitArmWithItem(Lnet/minecraft/client/player/AbstractClientPlayer;"
			+ "FFLnet/minecraft/world/InteractionHand;FLnet/minecraft/world/item/ItemStack;FLcom/mojang/blaze3d/vertex/PoseStack;Lnet/minecraft/client/renderer/SubmitNodeCollector;I)V";

	@WrapOperation(method = "submitHandsWithItems", at = @At(value = "INVOKE", target = ARM_WITH_ITEM))
	private void arenaagents$povArm(ItemInHandRenderer renderer, AbstractClientPlayer player, float partialTick, float pitch, InteractionHand hand,
			float attack, ItemStack stack, float inverseArmHeight, PoseStack poseStack, SubmitNodeCollector collector, int light, Operation<Void> original) {
		if (!PovClient.isActive()) {
			original.call(renderer, player, partialTick, pitch, hand, attack, stack, inverseArmHeight, poseStack, collector, light);
			return;
		}
		AbstractClientPlayer agent = PovClient.agentPlayer();
		if (agent == null || PovClient.handsHidden()) return;
		original.call(renderer, agent, partialTick, pitch, hand, attack, stack, inverseArmHeight, poseStack, collector, light);
	}

	@WrapOperation(method = "submitHandsWithItems", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/player/LocalPlayer;getAttackAnim(F)F"))
	private float arenaagents$povAttack(LocalPlayer player, float partialTick, Operation<Float> original) {
		AbstractClientPlayer agent = PovClient.isActive() ? PovClient.agentPlayer() : null;
		return agent == null ? original.call(player, partialTick) : agent.getAttackAnim(partialTick);
	}

	@ModifyExpressionValue(method = "submitHandsWithItems", at = @At(value = "FIELD", target = "Lnet/minecraft/client/player/LocalPlayer;swingingArm:Lnet/minecraft/world/InteractionHand;", opcode = Opcodes.GETFIELD))
	private InteractionHand arenaagents$povSwingingArm(InteractionHand original) {
		AbstractClientPlayer agent = PovClient.isActive() ? PovClient.agentPlayer() : null;
		return agent == null ? original : agent.swingingArm;
	}

	@WrapOperation(method = "submitHandsWithItems", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/player/LocalPlayer;getXRot(F)F"))
	private float arenaagents$povPitch(LocalPlayer player, float partialTick, Operation<Float> original) {
		AbstractClientPlayer agent = PovClient.isActive() ? PovClient.agentPlayer() : null;
		return agent == null ? original.call(player, partialTick) : agent.getXRot(partialTick);
	}

	@WrapOperation(method = "submitHandsWithItems", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/player/LocalPlayer;getViewXRot(F)F"))
	private float arenaagents$povViewPitch(LocalPlayer player, float partialTick, Operation<Float> original) {
		AbstractClientPlayer agent = PovClient.isActive() ? PovClient.agentPlayer() : null;
		return agent == null ? original.call(player, partialTick) : agent.getViewXRot(partialTick);
	}

	@WrapOperation(method = "submitHandsWithItems", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/player/LocalPlayer;getViewYRot(F)F"))
	private float arenaagents$povViewYaw(LocalPlayer player, float partialTick, Operation<Float> original) {
		AbstractClientPlayer agent = PovClient.isActive() ? PovClient.agentPlayer() : null;
		if (agent == null) return original.call(player, partialTick);
		PovHands hands = PovClient.hands();
		float yaw = agent.getViewYRot(partialTick);
		return hands.seeded() ? hands.viewYaw(partialTick, yaw) : yaw;
	}

	@ModifyExpressionValue(method = "submitHandsWithItems", at = @At(value = "FIELD", target = "Lnet/minecraft/client/player/LocalPlayer;xBobO:F", opcode = Opcodes.GETFIELD))
	private float arenaagents$povXBobO(float original) {
		return arenaagents$bob(original, 0.0F, true);
	}

	@ModifyExpressionValue(method = "submitHandsWithItems", at = @At(value = "FIELD", target = "Lnet/minecraft/client/player/LocalPlayer;xBob:F", opcode = Opcodes.GETFIELD))
	private float arenaagents$povXBob(float original) {
		return arenaagents$bob(original, 1.0F, true);
	}

	@ModifyExpressionValue(method = "submitHandsWithItems", at = @At(value = "FIELD", target = "Lnet/minecraft/client/player/LocalPlayer;yBobO:F", opcode = Opcodes.GETFIELD))
	private float arenaagents$povYBobO(float original) {
		return arenaagents$bob(original, 0.0F, false);
	}

	@ModifyExpressionValue(method = "submitHandsWithItems", at = @At(value = "FIELD", target = "Lnet/minecraft/client/player/LocalPlayer;yBob:F", opcode = Opcodes.GETFIELD))
	private float arenaagents$povYBob(float original) {
		return arenaagents$bob(original, 1.0F, false);
	}

	// Vanilla lerps the two fields itself, so each field read answers with the bob at its end of the tick.
	// Before the first seeded tick the agent's own look is the bob, so the operator's value never tilts the hands.
	private static float arenaagents$bob(float original, float tickEnd, boolean pitch) {
		AbstractClientPlayer agent = PovClient.agentPlayer();
		if (agent == null) return original;
		PovHands hands = PovClient.hands();
		if (!hands.seeded()) return pitch ? agent.getViewXRot(1.0F) : agent.getViewYRot(1.0F);
		return pitch ? hands.xBob(tickEnd) : hands.yBob(tickEnd);
	}

	// The bare arm and the map hands draw the local player's skin and sleeves; during an agent view they are the agent's.
	@WrapOperation(method = "renderPlayerArm", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/player/AbstractClientPlayer;getSkin()Lnet/minecraft/world/entity/player/PlayerSkin;"))
	private PlayerSkin arenaagents$povArmSkin(AbstractClientPlayer player, Operation<PlayerSkin> original) {
		AbstractClientPlayer agent = PovClient.isActive() ? PovClient.agentPlayer() : null;
		return original.call(agent == null ? player : agent);
	}

	@WrapOperation(method = "renderPlayerArm", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/player/AbstractClientPlayer;isModelPartShown(Lnet/minecraft/world/entity/player/PlayerModelPart;)Z"))
	private boolean arenaagents$povArmSleeve(AbstractClientPlayer player, PlayerModelPart part, Operation<Boolean> original) {
		AbstractClientPlayer agent = PovClient.isActive() ? PovClient.agentPlayer() : null;
		return original.call(agent == null ? player : agent, part);
	}

	@WrapOperation(method = {"renderPlayerArm", "renderMapHand"}, at = @At(value = "INVOKE",
			target = "Lnet/minecraft/client/renderer/entity/EntityRenderDispatcher;getPlayerRenderer(Lnet/minecraft/client/player/AbstractClientPlayer;)Lnet/minecraft/client/renderer/entity/player/AvatarRenderer;"))
	private AvatarRenderer<AbstractClientPlayer> arenaagents$povArmRenderer(EntityRenderDispatcher dispatcher, AbstractClientPlayer player, Operation<AvatarRenderer<AbstractClientPlayer>> original) {
		AbstractClientPlayer agent = PovClient.isActive() ? PovClient.agentPlayer() : null;
		return original.call(dispatcher, agent == null ? player : agent);
	}

	// Map helpers read Minecraft.player directly instead of the player passed to the arm draw.
	@WrapOperation(method = {"renderOneHandedMap", "renderTwoHandedMap"}, at = @At(value = "INVOKE",
			target = "Lnet/minecraft/client/player/LocalPlayer;isInvisible()Z"))
	private boolean arenaagents$povMapInvisible(LocalPlayer player, Operation<Boolean> original) {
		AbstractClientPlayer agent = PovClient.isActive() ? PovClient.agentPlayer() : null;
		return agent == null ? original.call(player) : agent.isInvisible();
	}

	@WrapOperation(method = "renderMapHand", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/player/LocalPlayer;getSkin()Lnet/minecraft/world/entity/player/PlayerSkin;"))
	private PlayerSkin arenaagents$povMapSkin(LocalPlayer player, Operation<PlayerSkin> original) {
		AbstractClientPlayer agent = PovClient.isActive() ? PovClient.agentPlayer() : null;
		return agent == null ? original.call(player) : agent.getSkin();
	}

	@WrapOperation(method = "renderMapHand", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/player/LocalPlayer;isModelPartShown(Lnet/minecraft/world/entity/player/PlayerModelPart;)Z"))
	private boolean arenaagents$povMapSleeve(LocalPlayer player, PlayerModelPart part, Operation<Boolean> original) {
		AbstractClientPlayer agent = PovClient.isActive() ? PovClient.agentPlayer() : null;
		return agent == null ? original.call(player, part) : agent.isModelPartShown(part);
	}

	// Hand selection (bow, crossbow, charged crossbow, item in use) keeps vanilla's logic on the agent's items; before 26.3
	// the item-in-use part of it is its own method.
	@WrapOperation(method = {"evaluateWhichHandsToRender", "tick"}, at = @At(value = "INVOKE",
			target = "Lnet/minecraft/client/player/LocalPlayer;getMainHandItem()Lnet/minecraft/world/item/ItemStack;"))
	private static ItemStack arenaagents$povMainHandItem(LocalPlayer player, Operation<ItemStack> original) {
		Player source = arenaagents$heldItemSource();
		return source == null ? original.call(player) : source.getMainHandItem();
	}

	@WrapOperation(method = {"evaluateWhichHandsToRender", "selectionUsingItemWhileHoldingBowLike", "tick"}, at = @At(value = "INVOKE",
			target = "Lnet/minecraft/client/player/LocalPlayer;getOffhandItem()Lnet/minecraft/world/item/ItemStack;"))
	private static ItemStack arenaagents$povOffhandItem(LocalPlayer player, Operation<ItemStack> original) {
		Player source = arenaagents$heldItemSource();
		return source == null ? original.call(player) : source.getOffhandItem();
	}

	@WrapOperation(method = "evaluateWhichHandsToRender", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/player/LocalPlayer;isUsingItem()Z"))
	private static boolean arenaagents$povUsingItem(LocalPlayer player, Operation<Boolean> original) {
		Player source = arenaagents$heldItemSource();
		return source == null ? original.call(player) : source.isUsingItem();
	}

	@WrapOperation(method = "selectionUsingItemWhileHoldingBowLike", at = @At(value = "INVOKE",
			target = "Lnet/minecraft/client/player/LocalPlayer;getUseItem()Lnet/minecraft/world/item/ItemStack;"))
	private static ItemStack arenaagents$povUseItem(LocalPlayer player, Operation<ItemStack> original) {
		Player source = arenaagents$heldItemSource();
		return source == null ? original.call(player) : source.getUseItem();
	}

	@WrapOperation(method = "selectionUsingItemWhileHoldingBowLike", at = @At(value = "INVOKE",
			target = "Lnet/minecraft/client/player/LocalPlayer;getUsedItemHand()Lnet/minecraft/world/InteractionHand;"))
	private static InteractionHand arenaagents$povUsedItemHand(LocalPlayer player, Operation<InteractionHand> original) {
		Player source = arenaagents$heldItemSource();
		return source == null ? original.call(player) : source.getUsedItemHand();
	}

	// LocalPlayer.handsBusy comes from local boat input, which the agent never has; the boat's synced
	// paddle state is what its rowing looks like from here.
	@WrapOperation(method = "tick", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/player/LocalPlayer;isHandsBusy()Z"))
	private boolean arenaagents$povHandsBusy(LocalPlayer player, Operation<Boolean> original) {
		if (!PovClient.isActive()) return original.call(player);
		AbstractClientPlayer agent = PovClient.agentPlayer();
		return agent != null && agent.getControlledVehicle() instanceof AbstractBoat boat
				&& (boat.getPaddleState(AbstractBoat.PADDLE_LEFT) || boat.getPaddleState(AbstractBoat.PADDLE_RIGHT));
	}

	// The agent entity's own swap ticker runs client-side like vanilla's (Player.tick advances it and resets
	// it on an item change). The streamed attack strength is not usable here: ServerPlayer.swing resets it
	// on every swing, so it would keep the tool lowered for as long as the agent mines. The one-off dip
	// after a hit is therefore not reproduced; the never-ticked stand-in simply reports a raised hand.
	@WrapOperation(method = "tick", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/player/LocalPlayer;getItemSwapScale(F)F"))
	private float arenaagents$povItemSwapScale(LocalPlayer player, float partialTick, Operation<Float> original) {
		if (!PovClient.isActive()) return original.call(player, partialTick);
		AbstractClientPlayer agent = PovClient.agentPlayer();
		return agent == null ? 1.0F : agent.getItemSwapScale(partialTick);
	}

	// Held items come from the agent entity's synced equipment; the HUD stand-in covers a lost signal.
	private static Player arenaagents$heldItemSource() {
		if (!PovClient.isActive()) return null;
		AbstractClientPlayer agent = PovClient.agentPlayer();
		return agent != null ? agent : PovHudProxy.current();
	}
}
