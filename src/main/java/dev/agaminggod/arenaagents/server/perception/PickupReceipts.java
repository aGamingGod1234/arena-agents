package dev.agaminggod.arenaagents.server.perception;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.WeakHashMap;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;

/** Remembers only this body's actual vanilla inventory gains, without emitting wakes or observations. */
public final class PickupReceipts {
	private static final Map<ServerPlayer, History> PLAYERS = new WeakHashMap<>();

	private PickupReceipts() {
	}

	public record Receipt(ItemStack identity, int count) {
	}

	public static void record(ServerPlayer player, UUID dropId, ItemStack identity, int gained) {
		if (gained <= 0) return;
		PLAYERS.computeIfAbsent(player, ignored -> new History()).record(dropId, identity, gained);
	}

	/** How many items this body has collected from this drop entity so far (0 when unknown or evicted). */
	public static int collected(ServerPlayer player, UUID dropId) {
		History history = PLAYERS.get(player);
		Receipt receipt = history == null ? null : history.get(dropId);
		return receipt == null ? 0 : receipt.count();
	}

	public static String describe(ServerPlayer player, UUID dropId) {
		History history = PLAYERS.get(player);
		Receipt receipt = history == null ? null : history.get(dropId);
		if (receipt == null) return null;
		return description(BuiltInRegistries.ITEM.getKey(receipt.identity().getItem()).toString(), receipt.count(), count(player, receipt.identity()));
	}

	static String description(String itemId, int collected, int held) {
		return held == 0 ? "Collected earlier: " + collected + " " + itemId + "; no longer held"
				: "Collected " + collected + " " + itemId + "; holds " + held + " matching";
	}

	private static int count(ServerPlayer player, ItemStack identity) {
		int count = 0;
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (ItemStack.isSameItemSameComponents(stack, identity)) count += stack.getCount();
		}
		return count;
	}

	static final class History {
		// Match the bounded player-event history; UUIDs never become a permanent world-item index.
		private final LinkedHashMap<UUID, Receipt> receipts = new LinkedHashMap<>();

		void record(UUID dropId, ItemStack identity, int count) {
			Receipt prior = receipts.remove(dropId);
			receipts.put(dropId, new Receipt(identity.copy(), count + (prior == null ? 0 : prior.count())));
			while (receipts.size() > 128) receipts.remove(receipts.keySet().iterator().next());
		}

		Receipt get(UUID dropId) {
			return receipts.get(dropId);
		}
	}
}
