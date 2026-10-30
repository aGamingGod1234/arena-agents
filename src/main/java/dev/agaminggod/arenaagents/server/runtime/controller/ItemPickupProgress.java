package dev.agaminggod.arenaagents.server.runtime.controller;

/** Pure postcondition policy: pickup succeeds only after the player's inventory really changes. */
public final class ItemPickupProgress {
	private ItemPickupProgress() {
	}

	public static Decision evaluate(int initialCount, int currentCount, boolean itemAlive, boolean timedOut) {
		if (initialCount < 0 || currentCount < 0) throw new IllegalArgumentException("item counts must not be negative");
		if (currentCount > initialCount) return Decision.SUCCEEDED;
		if (!itemAlive) return Decision.ITEM_UNAVAILABLE;
		return timedOut ? Decision.TIMED_OUT : Decision.RUNNING;
	}

	/**
	 * Entity-specific pickup: success needs a new pickup receipt for the requested drop. While that drop is still on the
	 * ground, picking up another identical drop is not this action's result. Once the drop is gone (collected, or merged
	 * into a neighbour that was then collected) an inventory gain still counts, because vanilla merges carry no receipt.
	 */
	public static Decision evaluate(int initialCount, int currentCount, int initialReceipt, int currentReceipt,
			boolean itemAlive, boolean timedOut) {
		if (initialCount < 0 || currentCount < 0) throw new IllegalArgumentException("item counts must not be negative");
		if (currentReceipt > initialReceipt) return Decision.SUCCEEDED;
		if (!itemAlive) return currentCount > initialCount ? Decision.SUCCEEDED : Decision.ITEM_UNAVAILABLE;
		return timedOut ? Decision.TIMED_OUT : Decision.RUNNING;
	}

	public enum Decision {
		RUNNING,
		SUCCEEDED,
		ITEM_UNAVAILABLE,
		TIMED_OUT
	}
}
