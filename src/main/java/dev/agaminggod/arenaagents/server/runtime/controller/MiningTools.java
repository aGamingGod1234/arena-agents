package dev.agaminggod.arenaagents.server.runtime.controller;

import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;

/**
 * The tool a player reaches for before swinging at a block: dig_to's rule (the fastest item that harvests the block and
 * is not about to break), shared by break_block and mine_vein so a single block no longer costs a select_tool call and
 * an ore is never broken with too weak a pick while the right one is carried.
 */
public final class MiningTools {
	private MiningTools() {
	}

	/** Keep whatever is held: no carried item beats the hand on this block. */
	public static final int KEEP = -1;
	/** The block needs a tool for its drop and no carried item harvests it. */
	public static final int NONE = -2;
	/** The only items that harvest it have {@link ServerDigController#WORN_USES} uses left or fewer. */
	public static final int WORN = -3;

	/**
	 * The slot in {@code [0, slots)} to mine {@code state} with, or {@link #KEEP}, {@link #NONE} or {@link #WORN}.
	 * {@code preferred} (a slot, or -1) wins ties, so a held tool that is as fast as any other stays in hand. With
	 * {@code allowWorn} a worn tool is chosen when nothing else harvests the block: one more block still breaks with
	 * its last uses, and vanilla rolls the drop before the tool takes its damage.
	 */
	static int slot(Inventory inventory, BlockState state, int slots, int preferred, boolean allowWorn) {
		int best = KEEP, worn = KEEP;
		float bestSpeed = 1.0F, wornSpeed = 1.0F;
		for (int index = -1; index < slots; index++) {
			int slot = index < 0 ? preferred : index;
			if (slot < 0 || slot >= slots || index >= 0 && slot == preferred) continue;
			ItemStack stack = inventory.getItem(slot);
			if (stack.isEmpty()) continue;
			float speed = stack.getDestroySpeed(state);
			boolean harvests = !state.requiresCorrectToolForDrops() || stack.isCorrectToolForDrops(state);
			if (!harvests || speed <= 1.0F) continue;
			if (worn(stack)) {
				if (speed > wornSpeed) {
					wornSpeed = speed;
					worn = slot;
				}
				continue;
			}
			if (speed > bestSpeed) {
				bestSpeed = speed;
				best = slot;
			}
		}
		if (best >= 0) return best;
		if (allowWorn && worn >= 0) return worn;
		// Snow and the like break by hand in a moment with no drop: a player digging through does not stop for a shovel.
		if (state.requiresCorrectToolForDrops() && state.getBlock().defaultDestroyTime() > ServerDigController.HAND_BREAKS) {
			return worn >= 0 ? WORN : NONE;
		}
		return KEEP;
	}

	static boolean worn(ItemStack stack) {
		return stack.isDamageableItem() && stack.getMaxDamage() - stack.getDamageValue() <= ServerDigController.WORN_USES;
	}

	/**
	 * break_block's and mine_vein's choice over the whole inventory (slots 9-35 are swapped into the hotbar first).
	 * A held enchanted item that harvests the block stays in hand: silk touch or fortune is the model's own choice.
	 */
	public static Choice forBreak(Inventory inventory, BlockState state) {
		int held = inventory.getSelectedSlot();
		ItemStack heldStack = inventory.getItem(held);
		if (!heldStack.isEmpty() && heldStack.isEnchanted() && heldStack.getDestroySpeed(state) > 1.0F
				&& (!state.requiresCorrectToolForDrops() || heldStack.isCorrectToolForDrops(state))) {
			return new Choice(held, false);
		}
		int slot = slot(inventory, state, Inventory.INVENTORY_SIZE, held, true);
		return new Choice(slot, slot >= 0 && worn(inventory.getItem(slot)));
	}

	/** An ore whose drop needs a tool tier no carried item has: swinging would destroy it for nothing. */
	public static boolean wastesOre(Inventory inventory, BlockState state) {
		return ServerDigController.isOre(state) && forBreak(inventory, state).slot() == NONE;
	}

	/** {@code slot} 0-35, or {@link #KEEP} / {@link #NONE}; {@code worn} when the chosen tool is nearly broken. */
	public record Choice(int slot, boolean worn) {
		/** True when holding this choice needs a hotbar change. */
		public boolean changes(Inventory inventory) {
			return slot >= 0 && slot != inventory.getSelectedSlot();
		}

		public String itemName(Inventory inventory) {
			if (slot < 0) return "hand";
			ItemStack stack = inventory.getItem(slot);
			String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
			return id.startsWith("minecraft:") ? id.substring("minecraft:".length()) : id;
		}
	}
}
