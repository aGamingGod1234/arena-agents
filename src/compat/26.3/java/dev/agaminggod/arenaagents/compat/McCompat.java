package dev.agaminggod.arenaagents.compat;

import dev.agaminggod.arenaagents.compat.mixin.FurnaceBurnDurationInvoker;
import dev.agaminggod.arenaagents.compat.mixin.LivingEntitySwingStateAccessor;
import dev.agaminggod.arenaagents.compat.mixin.SwingStateAccessor;
import java.util.List;
import java.util.stream.Stream;
import net.minecraft.advancements.DisplayInfo;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.game.ClientboundOpenSignEditorPacket;
import net.minecraft.network.protocol.game.ClientboundPlayerChatPacket;
import net.minecraft.network.protocol.game.ServerboundSignUpdatePacket;
import net.minecraft.server.network.FilteredText;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.Prediction;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.attribute.BedRule;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Enderman;
import net.minecraft.world.entity.monster.Monster;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.BundleContents;
import net.minecraft.world.item.crafting.display.SlotDisplay;
import net.minecraft.world.level.block.entity.AbstractFurnaceBlockEntity;
import net.minecraft.world.level.block.entity.SignBlockEntity;
import net.minecraft.world.level.block.entity.SignText;
import net.minecraft.world.level.block.entity.SignTextSlot;

/**
 * Minecraft 26.3 implementation of the Minecraft API calls that differ between the 26.x drops. Each target under
 * src/compat/&lt;target&gt;/ implements the same public methods; the rest of the mod calls only these for the APIs that moved.
 */
public final class McCompat {
	public static final String TARGET = "26.3";

	private McCompat() {
	}

	// Entities.

	public static void setPermanentlyInvulnerable(Entity entity, boolean invulnerable) {
		entity.setPermanentlyInvulnerable(invulnerable);
	}

	/** Ask the server to send this entity's velocity to clients this tick (a set push, a cart launch). */
	public static void syncVelocity(Entity entity) {
		entity.syncVelocity = true;
	}

	public static boolean velocitySyncPending(Entity entity) {
		return entity.syncVelocity;
	}

	public static final Class<? extends Monster> ENDERMAN = Enderman.class;

	public static boolean isEnderman(Entity entity) {
		return entity instanceof Enderman;
	}

	/** An enderman that has been provoked (stared at or hit) and screams; false for any other entity. */
	public static boolean endermanCreepy(Entity entity) {
		return entity instanceof Enderman enderman && enderman.isCreepy();
	}

	/** The block an enderman carries, or null for none or for any other entity. */
	public static net.minecraft.world.level.block.state.BlockState endermanCarriedBlock(Entity entity) {
		return entity instanceof Enderman enderman ? enderman.getCarriedBlock() : null;
	}

	/** A mob swing that began this tick or the last (vanilla's swing ticks start at 0 in 26.3). */
	public static boolean swingJustStarted(Mob mob) {
		LivingEntity.SwingState swing = ((LivingEntitySwingStateAccessor) mob).arenaagents$swingState();
		return mob.isSwinging() && ((SwingStateAccessor) swing).arenaagents$ticks() <= 2;
	}

	/** The arm swing a player's attack or dig shows; watchers see it, the swinger's own client does not. */
	public static void swingAttack(LivingEntity entity, InteractionHand hand) {
		entity.swing(hand, entity.getItemInHand(hand).getAttackAnimation(), false);
	}

	/** The arm swing a block, item or entity use shows; {@code toSelf} also plays it for the swinger's own client. */
	public static void swingUse(LivingEntity entity, InteractionHand hand, boolean toSelf) {
		entity.swing(hand, entity.getItemInHand(hand).getInteractAnimation(), toSelf);
	}

	/** An interaction whose arm swing the server shows (not one the client already predicted). */
	public static boolean serverSwing(InteractionResult.Success success) {
		return success.swingSource() == InteractionResult.SwingSource.SERVER_ONLY;
	}

	// Items and inventories.

	/**
	 * Drop a stack in front of the entity like a player's throw, keeping ownership when asked. {@code predicted} is a drop
	 * the player's own client already animated, so only watchers see the arm swing.
	 */
	public static ItemEntity drop(LivingEntity entity, ItemStack stack, boolean keepOwnership, boolean predicted) {
		return entity.drop(stack, keepOwnership, predicted ? Prediction.PREDICTED : Prediction.SERVER_ONLY);
	}

	/** The randomly scattered drop of a dead body (no arm swing). */
	public static void dropScattered(LivingEntity entity, ItemStack stack) {
		ItemEntity dropped = entity.createItemStackToDrop(stack, true, false);
		if (dropped != null) entity.level().addFreshEntity(dropped);
	}

	/** Put a stack back into the inventory as the server does after a closed screen (no client prediction). */
	public static void placeItemBackInInventory(Inventory inventory, ItemStack stack) {
		inventory.placeItemBackInInventory(stack, Prediction.SERVER_ONLY);
	}

	public static BundleContents.Mutable mutableBundle(BundleContents contents) {
		return contents.asMutable();
	}

	public static Stream<ItemStack> bundleItemCopies(BundleContents contents) {
		return contents.itemCopies();
	}

	/** Vanilla burn ticks of a fuel stack, as the furnace (when given) or the furnace-independent default resolves it. */
	public static int burnDuration(ServerLevel level, AbstractFurnaceBlockEntity furnace, ItemStack fuel) {
		net.minecraft.world.item.component.CookingFuel component = fuel.get(net.minecraft.core.component.DataComponents.COOKING_FUEL);
		if (component == null) return 0;
		if (furnace instanceof FurnaceBurnDurationInvoker invoker) return invoker.arenaagents$burnDuration(level, fuel);
		return component.burnTime() instanceof net.minecraft.world.level.storage.loot.providers.number.ints.ResolvableInt.Constant constant ? constant.value() : 0;
	}

	/** The tag id a recipe's tag slot names. */
	public static String tagId(SlotDisplay.TagSlotDisplay display) {
		return display.tag().unwrapKey().map(key -> key.location().toString()).orElse("");
	}

	// World rules, advancements and chat.

	public static boolean bedExplodes(BedRule rule) {
		return rule.destroyOnUse();
	}

	public static Component advancementTitle(DisplayInfo display) {
		return display.title();
	}

	public static boolean advancementShowsToast(DisplayInfo display) {
		return display.showToast();
	}

	/** The unsigned (server-decorated) content of a player chat packet, or null when it has none. */
	public static Component unsignedContent(ClientboundPlayerChatPacket chat) {
		return chat.unsignedContent().orElse(null);
	}

	// Signs.

	public static boolean facingFrontText(SignBlockEntity sign, Player player) {
		return sign.getSlotPlayerIsFacing(player) == SignTextSlot.FRONT;
	}

	public static SignText signText(SignBlockEntity sign, boolean front) {
		return sign.getText(front ? SignTextSlot.FRONT : SignTextSlot.BACK);
	}

	public static List<Component> signMessages(SignText text, boolean filtered) {
		return text.getMessages(filtered);
	}

	public static void updateSignText(SignBlockEntity sign, Player player, boolean front, List<FilteredText> lines) {
		sign.updateSignText(player, front ? SignTextSlot.FRONT : SignTextSlot.BACK, lines);
	}

	public static ServerboundSignUpdatePacket signUpdatePacket(BlockPos position, List<String> lines, boolean front) {
		return new ServerboundSignUpdatePacket(position, lines, front ? SignTextSlot.FRONT : SignTextSlot.BACK);
	}

	public static BlockPos signEditorPosition(ClientboundOpenSignEditorPacket packet) {
		return packet.pos();
	}
}
