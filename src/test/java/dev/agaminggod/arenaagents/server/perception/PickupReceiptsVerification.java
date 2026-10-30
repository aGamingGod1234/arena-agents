package dev.agaminggod.arenaagents.server.perception;

import java.util.UUID;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

public final class PickupReceiptsVerification {
	private PickupReceiptsVerification() {
	}

	public static int verify() {
		PickupReceipts.History history = new PickupReceipts.History();
		UUID drop = UUID.randomUUID();
		ItemStack sword = new ItemStack(Items.DIAMOND_SWORD);
		assertEquals(null, history.get(drop), "an unknown or merged UUID is not proof of collection");
		history.record(drop, sword, 1);
		sword.setCount(0);
		assertEquals(Items.DIAMOND_SWORD, history.get(drop).identity().getItem(), "receipt owns the item identity before vanilla empties the drop");
		assertEquals(1, history.get(drop).count(), "receipt reports the real collected quantity");
		history.record(drop, new ItemStack(Items.DIAMOND_SWORD), 1);
		assertEquals(2, history.get(drop).count(), "partial pickups accumulate for the same drop");
		for (int i = 0; i < 128; i++) history.record(UUID.randomUUID(), new ItemStack(Items.OAK_LOG), 1);
		assertEquals(null, history.get(drop), "old receipts expire at the existing player-event budget");
		assertEquals("Collected 1 minecraft:diamond_sword; holds 1 matching",
				PickupReceipts.description("minecraft:diamond_sword", 1, 1), "already-collected feedback includes current inventory");
		assertEquals("Collected earlier: 1 minecraft:diamond_sword; no longer held",
				PickupReceipts.description("minecraft:diamond_sword", 1, 0), "a later drop or use does not falsely claim the item is still held");
		assertEquals(true, PickupReceipts.description("minecraft:diamond_sword", 1, 0).length() <= 80,
				"receipt preserves item, historical gain and current holdings within its message budget");
		return 8;
	}

	private static void assertEquals(Object expected, Object actual, String message) {
		if (!java.util.Objects.equals(expected, actual)) throw new AssertionError(message + " expected=" + expected + " actual=" + actual);
	}
}
