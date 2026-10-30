package dev.agaminggod.arenaagents.server.perception;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.WeakHashMap;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.phys.Vec3;

/** Drops witnessed at a kill, retained at their last seen position, never followed through walls. */
public final class ObservedDrops {
	private static final long KEEP_TICKS = 1200L;
	private static final Map<ServerPlayer, Map<UUID, Drop>> MEMORY = new WeakHashMap<>();
	public record Drop(Vec3 position, String dimension, long tick, String item, int count, boolean landed) { }
	private ObservedDrops() { }

	public static void remember(ServerPlayer player, ItemEntity item) {
		Map<UUID, Drop> drops = MEMORY.computeIfAbsent(player, ignored -> new LinkedHashMap<>());
		drops.put(item.getUUID(), new Drop(item.position(), player.level().dimension().identifier().toString(),
				player.level().getGameTime(), net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(item.getItem().getItem()).toString(),
				item.getItem().getCount(), item.onGround()));
		while (drops.size() > 32) drops.remove(drops.keySet().iterator().next());
	}

	public static Drop recall(ServerPlayer player, UUID id) {
		Map<UUID, Drop> drops = MEMORY.get(player);
		if (drops == null) return null;
		Drop drop = drops.get(id);
		long now = player.level().getGameTime();
		if (drop != null && (!drop.dimension().equals(player.level().dimension().identifier().toString())
				|| now < drop.tick() || now - drop.tick() > KEEP_TICKS)) {
			drops.remove(id);
			return null;
		}
		return drop;
	}

	/** The ids of every drop still remembered (last sight not expired), oldest first. */
	public static java.util.List<UUID> remembered(ServerPlayer player) {
		Map<UUID, Drop> drops = MEMORY.get(player);
		if (drops == null) return java.util.List.of();
		java.util.List<UUID> ids = new java.util.ArrayList<>();
		for (UUID id : new java.util.ArrayList<>(drops.keySet())) if (recall(player, id) != null) ids.add(id);
		return ids;
	}

	/** Read current coordinates only when the item is visible; a hidden item keeps its last seen coordinates. */
	public static Vec3 position(ServerPlayer player, ItemEntity item) {
		if (ObservationVisibility.canSeeEntity(player, item)) {
			remember(player, item);
			return item.position();
		}
		Drop drop = recall(player, item.getUUID());
		return drop == null ? null : drop.position();
	}

	public static String describe(ServerPlayer player, UUID id) {
		Drop drop = recall(player, id);
		if (drop == null) return "drop " + id + " last sight expired";
		Vec3 at = drop.position();
		return drop.count() + "x " + drop.item() + " at " + net.minecraft.util.Mth.floor(at.x) + ","
				+ net.minecraft.util.Mth.floor(at.y) + "," + net.minecraft.util.Mth.floor(at.z) + " uuid=" + id
				+ (drop.landed() ? " (landed, last seen)" : " (falling, last seen)");
	}
}
