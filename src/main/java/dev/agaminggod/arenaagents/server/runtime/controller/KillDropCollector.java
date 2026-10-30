package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.server.perception.ObservationVisibility;
import dev.agaminggod.arenaagents.server.perception.ObservedDrops;
import dev.agaminggod.arenaagents.server.perception.PickupReceipts;
import dev.agaminggod.arenaagents.server.runtime.InventoryRoom;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.UUID;
import java.util.function.BiPredicate;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;

/**
 * The optional {@code collect:true} after a kill: walks to each drop the player saw fall, one at a time, by the same
 * route pick_up_item takes (navigation over seen, hazard-free footing; a blaze rod is followed on the shooter's deck),
 * and reports what came into the inventory or why a drop was left: it burns in lava or fire below, the inventory has
 * no room, the route failed, or the collect time ran out.
 */
public final class KillDropCollector {
	public static final long COLLECT_BUDGET_MS = 15_000L;
	private final ArrayDeque<UUID> pending;
	private final BiPredicate<ServerPlayer, Entity> mayTake;
	private final List<String> notes = new ArrayList<>();
	private final long deadline;
	private ServerItemPickupController current;
	private String currentLabel;
	/** The model's sneak:true: every walk to a drop is crouched (see ServerNavigationController#crouched). */
	private boolean crouched;

	public KillDropCollector(Collection<UUID> drops, BiPredicate<ServerPlayer, Entity> mayTake, long nowEpochMs) {
		this.pending = new ArrayDeque<>(drops);
		this.mayTake = mayTake;
		this.deadline = nowEpochMs + COLLECT_BUDGET_MS;
	}

	public KillDropCollector crouched(boolean crouched) {
		this.crouched = crouched;
		return this;
	}

	/** Null while walking to a drop; the summary once every drop was taken or left. */
	public String tick(ServerPlayer player, long nowEpochMs) {
		while (true) {
			if (current != null) {
				ServerController.TickResult result = current.tick(player, nowEpochMs);
				if (result.state() == ServerController.State.RUNNING) return null;
				notes.add(result.state() == ServerController.State.SUCCEEDED ? "picked up " + currentLabel
						: "left " + currentLabel + ": " + result.reasonCode() + " (" + result.message() + ")");
				current = null;
			}
			UUID id = pending.poll();
			if (id == null) return notes.isEmpty() ? "no drop was seen to collect" : String.join("; ", notes);
			Entity entity = ((net.minecraft.server.level.ServerLevel) player.level()).getEntity(id);
			if (!(entity instanceof ItemEntity item) || !item.isAlive() || item.getItem().isEmpty()) {
				notes.add(PickupReceipts.collected(player, id) > 0 ? "picked up " + ObservedDrops.describe(player, id) + " on the way"
						: "left " + ObservedDrops.describe(player, id) + ": it is gone (burnt, despawned or taken)");
				continue;
			}
			String label = item.getItem().getCount() + "x " + BuiltInRegistries.ITEM.getKey(item.getItem().getItem()) + " uuid=" + id;
			if (ObservationVisibility.canSeeEntity(player, item)) ObservedDrops.remember(player, item);
			if (item.getItem().is(net.minecraft.world.item.Items.BLAZE_ROD) && item.onGround() && item.getY() > player.getY() + 0.6D) {
				// The rod pickup keeps to the body's floor: one resting on a ledge above is left to a ledge trip.
				notes.add("left " + label + ": on a ledge above the feet");
				continue;
			}
			String below = ServerFightController.burnsBelow(player, item.position());
			if (below.contains("burns")) { notes.add("left " + label + ":" + below); continue; }
			if (mayTake != null && !mayTake.test(player, item)) { notes.add("left " + label + ": PROTECTION_DENIED"); continue; }
			if (!InventoryRoom.canTake(player, item.getItem())) { notes.add("left " + label + ": INVENTORY_FULL"); continue; }
			long left = deadline - nowEpochMs;
			if (left <= 0L) { notes.add("left " + label + ": the " + COLLECT_BUDGET_MS / 1000 + " s collect time ran out"); continue; }
			current = new ServerItemPickupController(player, item, nowEpochMs, left).crouched(crouched);
			currentLabel = label;
		}
	}

	public boolean walking() {
		return current != null;
	}

	public void cancel(ServerPlayer player) {
		if (current != null) current.cancel(player);
		current = null;
	}
}
