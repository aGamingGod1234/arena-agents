package dev.agaminggod.arenaagents.server.runtime;

import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;

/** Whether a player could take any of a stack now, by the same paths vanilla's Inventory#add accepts a pickup. */
public final class InventoryRoom {
	private InventoryRoom() {
	}

	public static boolean canTake(Player player, ItemStack stack) {
		if (stack.isEmpty()) return true;
		// Evaluated lazily: a creative player never needs the slot search.
		return canTake(player.hasInfiniteMaterials(), () -> player.getInventory().getSlotWithRemainingSpace(stack),
				() -> player.getInventory().getFreeSlot());
	}

	/**
	 * Vanilla Inventory#add: a stack with room or an empty main slot takes the item; with neither, a player with
	 * infinite materials (creative) still accepts it and the drop is consumed. Only otherwise does it stay on the ground.
	 */
	static boolean canTake(boolean infiniteMaterials, java.util.function.IntSupplier slotWithRoom, java.util.function.IntSupplier freeSlot) {
		return infiniteMaterials || slotWithRoom.getAsInt() >= 0 || freeSlot.getAsInt() >= 0;
	}

	static String itemName(ItemStack stack) {
		String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
		return id.startsWith("minecraft:") ? id.substring("minecraft:".length()) : id;
	}

	/** The fact a player sees standing on a drop that does not come in. */
	public static String noRoomMessage(ItemStack stack) {
		return noRoomMessage(itemName(stack));
	}

	static String noRoomMessage(String item) {
		return "No inventory room for " + item + ": no empty slot and no " + item + " stack with room; the drop stays on the ground";
	}
}
