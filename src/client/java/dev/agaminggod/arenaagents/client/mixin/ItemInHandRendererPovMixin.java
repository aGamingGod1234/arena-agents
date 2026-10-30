package dev.agaminggod.arenaagents.client.mixin;

import com.llamalad7.mixinextras.injector.ModifyExpressionValue;
import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import dev.agaminggod.arenaagents.client.pov.PovClient;
import dev.agaminggod.arenaagents.client.pov.PovHands;
import dev.agaminggod.arenaagents.client.pov.PovHudProxy;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.client.player.FirstPersonHandsAndItems;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.HumanoidArm;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.vehicle.boat.AbstractBoat;
import net.minecraft.world.item.ItemStack;
import org.objectweb.asm.Opcodes;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

/**
 * First-person hands during an agent view are the agent's: every read of the local player while the
 * hands are ticked and extracted is answered by the agent's in-level entity (swing, item use, scoping,
 * main arm, held items), so what the operator sees is what a player in the agent's body would see.
 * Minecraft 26.3 split the old ItemInHandRenderer into this extraction and FirstPersonHandsAndItemsRenderer;
 * the arm skin, sleeves, swing, map tilt and light now come from the extracted avatar (ScreenEffectRendererPovMixin) and the
 * arm draws are skipped in FirstPersonHandsRendererPovMixin.
 */
@Mixin(FirstPersonHandsAndItems.class)
abstract class ItemInHandRendererPovMixin {
	@WrapOperation(method = "extractRenderState", at = @At(value = "INVOKE",
			target = "Lnet/minecraft/client/player/LocalPlayer;getCurrentSwing()Lnet/minecraft/world/entity/LivingEntity$SwingDescription;"))
	private LivingEntity.SwingDescription arenaagents$povSwing(LocalPlayer player, Operation<LivingEntity.SwingDescription> original) {
		AbstractClientPlayer agent = PovClient.agentPlayer();
		return agent == null ? original.call(player) : agent.getCurrentSwing();
	}

	@WrapOperation(method = "extractRenderState", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/player/LocalPlayer;getViewXRot(F)F"))
	private float arenaagents$povViewPitch(LocalPlayer player, float partialTick, Operation<Float> original) {
		AbstractClientPlayer agent = PovClient.agentPlayer();
		return agent == null ? original.call(player, partialTick) : agent.getViewXRot(partialTick);
	}

	@WrapOperation(method = "extractRenderState", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/player/LocalPlayer;getViewYRot(F)F"))
	private float arenaagents$povViewYaw(LocalPlayer player, float partialTick, Operation<Float> original) {
		AbstractClientPlayer agent = PovClient.agentPlayer();
		if (agent == null) return original.call(player, partialTick);
		PovHands hands = PovClient.hands();
		float yaw = agent.getViewYRot(partialTick);
		return hands.seeded() ? hands.viewYaw(partialTick, yaw) : yaw;
	}

	@ModifyExpressionValue(method = "extractRenderState", at = @At(value = "FIELD", target = "Lnet/minecraft/client/player/LocalPlayer;xBobO:F", opcode = Opcodes.GETFIELD))
	private float arenaagents$povXBobO(float original) {
		return arenaagents$bob(original, 0.0F, true);
	}

	@ModifyExpressionValue(method = "extractRenderState", at = @At(value = "FIELD", target = "Lnet/minecraft/client/player/LocalPlayer;xBob:F", opcode = Opcodes.GETFIELD))
	private float arenaagents$povXBob(float original) {
		return arenaagents$bob(original, 1.0F, true);
	}

	@ModifyExpressionValue(method = "extractRenderState", at = @At(value = "FIELD", target = "Lnet/minecraft/client/player/LocalPlayer;yBobO:F", opcode = Opcodes.GETFIELD))
	private float arenaagents$povYBobO(float original) {
		return arenaagents$bob(original, 0.0F, false);
	}

	@ModifyExpressionValue(method = "extractRenderState", at = @At(value = "FIELD", target = "Lnet/minecraft/client/player/LocalPlayer;yBob:F", opcode = Opcodes.GETFIELD))
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

	// The old arm draw took the agent as its player, so scoping, item use and the main arm were the agent's.
	@WrapOperation(method = "extractRenderState", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/player/LocalPlayer;isScoping()Z"))
	private boolean arenaagents$povScoping(LocalPlayer player, Operation<Boolean> original) {
		AbstractClientPlayer agent = PovClient.agentPlayer();
		return agent == null ? original.call(player) : agent.isScoping();
	}

	@WrapOperation(method = "extractRenderState", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/player/LocalPlayer;getUseItemRemainingTicks()I"))
	private int arenaagents$povUseRemaining(LocalPlayer player, Operation<Integer> original) {
		AbstractClientPlayer agent = PovClient.agentPlayer();
		return agent == null ? original.call(player) : agent.getUseItemRemainingTicks();
	}

	@WrapOperation(method = "extractRenderState", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/player/LocalPlayer;getMainArm()Lnet/minecraft/world/entity/HumanoidArm;"))
	private HumanoidArm arenaagents$povMainArm(LocalPlayer player, Operation<HumanoidArm> original) {
		AbstractClientPlayer agent = PovClient.agentPlayer();
		return agent == null ? original.call(player) : agent.getMainArm();
	}

	// Hand selection (bow, crossbow, charged crossbow, item in use) keeps vanilla's logic on the agent's items.
	@WrapOperation(method = {"evaluateWhichHandsToRender", "tick"}, at = @At(value = "INVOKE",
			target = "Lnet/minecraft/client/player/LocalPlayer;getMainHandItem()Lnet/minecraft/world/item/ItemStack;"))
	private static ItemStack arenaagents$povMainHandItem(LocalPlayer player, Operation<ItemStack> original) {
		Player source = arenaagents$heldItemSource();
		return source == null ? original.call(player) : source.getMainHandItem();
	}

	@WrapOperation(method = {"evaluateWhichHandsToRender", "tick"}, at = @At(value = "INVOKE",
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

	@WrapOperation(method = "evaluateWhichHandsToRender", at = @At(value = "INVOKE",
			target = "Lnet/minecraft/client/player/LocalPlayer;getUseItem()Lnet/minecraft/world/item/ItemStack;"))
	private static ItemStack arenaagents$povUseItem(LocalPlayer player, Operation<ItemStack> original) {
		Player source = arenaagents$heldItemSource();
		return source == null ? original.call(player) : source.getUseItem();
	}

	@WrapOperation(method = "evaluateWhichHandsToRender", at = @At(value = "INVOKE",
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
