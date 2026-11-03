package dev.agaminggod.arenaagents.compat;

import dev.agaminggod.arenaagents.compat.mixin.FurnaceBurnDurationInvoker;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Stream;
import net.minecraft.advancements.DisplayInfo;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.game.ClientboundOpenSignEditorPacket;
import net.minecraft.network.protocol.game.ClientboundPlayerChatPacket;
import net.minecraft.network.protocol.game.ServerboundSignUpdatePacket;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.network.FilteredText;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.attribute.BedRule;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.EnderMan;
import net.minecraft.world.entity.monster.Monster;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.ItemStackTemplate;
import net.minecraft.world.item.component.BundleContents;
import net.minecraft.world.item.crafting.display.SlotDisplay;
import net.minecraft.world.level.block.entity.AbstractFurnaceBlockEntity;
import net.minecraft.world.level.block.entity.SignBlockEntity;
import net.minecraft.world.level.block.entity.SignText;

/** Minecraft 26.2 implementation of {@code McCompat}; see the 26.3 one for what each call means. */
public final class McCompat {
	public static final String TARGET = "26.1";

	private McCompat() {
	}

	// Entities.

	public static void setPermanentlyInvulnerable(Entity entity, boolean invulnerable) {
		entity.setInvulnerable(invulnerable);
	}

	public static void syncVelocity(Entity entity) {
		entity.hurtMarked = true;
	}

	public static boolean velocitySyncPending(Entity entity) {
		return entity.hurtMarked;
	}

	public static final Class<? extends Monster> ENDERMAN = EnderMan.class;

	public static boolean isEnderman(Entity entity) {
		return entity instanceof EnderMan;
	}

	public static boolean endermanCreepy(Entity entity) {
		return entity instanceof EnderMan enderman && enderman.isCreepy();
	}

	/** The block an enderman carries, or null for none or for any other entity. */
	public static net.minecraft.world.level.block.state.BlockState endermanCarriedBlock(Entity entity) {
		return entity instanceof EnderMan enderman ? enderman.getCarriedBlock() : null;
	}

	/** Before 26.3 a swing's swingTime started at -1 and rose each tick, so "just started" is swingTime <= 1. */
	public static boolean swingJustStarted(Mob mob) {
		return mob.swinging && mob.swingTime <= 1;
	}

	/** Before 26.3 the arm swing took no animation; swing(hand, false) shows it to watchers only. */
	public static void swingAttack(LivingEntity entity, InteractionHand hand) {
		entity.swing(hand, false);
	}

	public static void swingUse(LivingEntity entity, InteractionHand hand, boolean toSelf) {
		entity.swing(hand, toSelf);
	}

	public static boolean serverSwing(InteractionResult.Success success) {
		return success.swingSource() == InteractionResult.SwingSource.SERVER;
	}

	public static boolean isSlimeOrMagmaCube(Entity entity) {
		return entity instanceof net.minecraft.world.entity.monster.Slime;
	}

	public static boolean isMagmaCube(Entity entity) {
		return entity instanceof net.minecraft.world.entity.monster.MagmaCube;
	}

	/** A slime or magma cube of the smallest size (no contact damage from slimes). */
	public static boolean cubeIsTiny(Entity entity) {
		return entity instanceof net.minecraft.world.entity.monster.Slime slime && slime.isTiny();
	}

	/** A dry, downward pointed-dripstone tip, the only state that drips. */
	public static boolean isDrippingDripstoneTip(net.minecraft.world.level.block.state.BlockState state) {
		return state.is(net.minecraft.world.level.block.Blocks.POINTED_DRIPSTONE)
				&& state.getValue(net.minecraft.world.level.block.PointedDripstoneBlock.TIP_DIRECTION) == net.minecraft.core.Direction.DOWN
				&& state.getValue(net.minecraft.world.level.block.PointedDripstoneBlock.THICKNESS) == net.minecraft.world.level.block.state.properties.DripstoneThickness.TIP
				&& !state.getValue(net.minecraft.world.level.block.PointedDripstoneBlock.WATERLOGGED);
	}

	public static final net.minecraft.tags.TagKey<net.minecraft.world.level.block.Block> LOGS_THAT_BURN = net.minecraft.tags.BlockTags.LOGS_THAT_BURN;

	/** The sidebar slot a team's colour shows on, or null for a team without one. */
	public static net.minecraft.world.scores.DisplaySlot teamDisplaySlot(net.minecraft.world.scores.PlayerTeam team) {
		return net.minecraft.world.scores.DisplaySlot.teamColorToSlot(team.getColor());
	}

	// Items and inventories.

	/**
	 * 26.3's drop(stack, keepOwnership, prediction) swings the arm on the server (for watchers, and the dropper too unless
	 * its client predicted it) and never scatters; 26.2's drop(stack, throwRandomly, keepOwnership) does not swing.
	 */
	public static ItemEntity drop(LivingEntity entity, ItemStack stack, boolean keepOwnership, boolean predicted) {
		if (stack.isEmpty()) return null;
		if (!entity.level().isClientSide()) entity.swing(InteractionHand.MAIN_HAND, !predicted);
		return entity.drop(stack, false, keepOwnership);
	}

	public static void dropScattered(LivingEntity entity, ItemStack stack) {
		entity.drop(stack, true, false);
	}

	public static void placeItemBackInInventory(Inventory inventory, ItemStack stack) {
		inventory.placeItemBackInInventory(stack);
	}

	public static BundleContents.Mutable mutableBundle(BundleContents contents) {
		return new BundleContents.Mutable(contents);
	}

	public static Stream<ItemStack> bundleItemCopies(BundleContents contents) {
		return contents.items().stream().map(ItemStackTemplate::create);
	}

	/** Resolve virtual furnace adjustments; without a furnace, use the raw level fuel table. */
	public static int burnDuration(ServerLevel level, AbstractFurnaceBlockEntity furnace, ItemStack fuel) {
		if (furnace instanceof FurnaceBurnDurationInvoker invoker) return invoker.arenaagents$burnDuration(level.fuelValues(), fuel);
		return level.fuelValues().burnDuration(fuel);
	}

	public static String tagId(SlotDisplay.TagSlotDisplay display) {
		return display.tag().location().toString();
	}

	// World rules, advancements and chat.

	public static boolean bedExplodes(BedRule rule) {
		return rule.explodes();
	}

	public static Component advancementTitle(DisplayInfo display) {
		return display.getTitle();
	}

	public static boolean advancementShowsToast(DisplayInfo display) {
		return display.shouldShowToast();
	}

	public static Component unsignedContent(ClientboundPlayerChatPacket chat) {
		return chat.unsignedContent();
	}

	// Signs.

	public static boolean facingFrontText(SignBlockEntity sign, Player player) {
		return sign.isFacingFrontText(player);
	}

	public static SignText signText(SignBlockEntity sign, boolean front) {
		return sign.getText(front);
	}

	public static List<Component> signMessages(SignText text, boolean filtered) {
		return Arrays.asList(text.getMessages(filtered));
	}

	public static void updateSignText(SignBlockEntity sign, Player player, boolean front, List<FilteredText> lines) {
		sign.updateSignText(player, front, lines);
	}

	public static ServerboundSignUpdatePacket signUpdatePacket(BlockPos position, List<String> lines, boolean front) {
		return new ServerboundSignUpdatePacket(position, front, lines.get(0), lines.get(1), lines.get(2), lines.get(3));
	}

	public static BlockPos signEditorPosition(ClientboundOpenSignEditorPacket packet) {
		return packet.getPos();
	}
}
