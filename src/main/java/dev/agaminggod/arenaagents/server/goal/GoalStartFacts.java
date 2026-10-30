package dev.agaminggod.arenaagents.server.goal;

import java.util.LinkedHashMap;
import java.util.Map;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.player.Inventory;

/** A once-per-goal inventory digest; no spatial scan or action advice. */
public final class GoalStartFacts {
	private GoalStartFacts() { }
	public static String describe(ServerPlayer player) {
		Map<String, Integer> worn = new LinkedHashMap<>(), carried = new LinkedHashMap<>();
		for (EquipmentSlot slot : new EquipmentSlot[]{EquipmentSlot.HEAD, EquipmentSlot.CHEST, EquipmentSlot.LEGS, EquipmentSlot.FEET}) {
			var stack = player.getItemBySlot(slot);
			if (!stack.isEmpty()) worn.merge(BuiltInRegistries.ITEM.getKey(stack.getItem()).getPath(), stack.getCount(), Integer::sum);
		}
		var inventory = player.getInventory();
		for (int slot = 0; slot < inventory.getContainerSize(); slot++) {
			if (Inventory.EQUIPMENT_SLOT_MAPPING.containsKey(slot)) continue;
			var stack = inventory.getItem(slot);
			if (!stack.isEmpty()) carried.merge(BuiltInRegistries.ITEM.getKey(stack.getItem()).getPath(), stack.getCount(), Integer::sum);
		}
		var offhand = player.getOffhandItem();
		if (!offhand.isEmpty()) carried.merge(BuiltInRegistries.ITEM.getKey(offhand.getItem()).getPath(), offhand.getCount(), Integer::sum);
		return describe(player.level().dimension().identifier().toString(), worn, carried);
	}
	public static String describe(String dimension, Map<String, Integer> worn, Map<String, Integer> carried) {
		StringBuilder result = new StringBuilder(dimension);
		append(result, "; worn:", worn);
		Map<String, Integer> ordered = new LinkedHashMap<>();
		carried.entrySet().stream().sorted(java.util.Comparator.comparingInt(entry -> priority(entry.getKey())))
				.forEach(entry -> ordered.put(entry.getKey(), entry.getValue()));
		append(result, "; carried:", ordered);
		return result.toString();
	}
	private static int priority(String id) {
		return id.matches(".*(pickaxe|sword|helmet|chestplate|leggings|boots)|ender_eye|ender_pearl|blaze_rod|blaze_powder") ? 0 : 1;
	}
	private static void append(StringBuilder result, String heading, Map<String, Integer> items) {
		if (result.length() + heading.length() > 240) return;
		result.append(heading);
		if (items.isEmpty()) { result.append("none"); return; }
		int used = 0;
		for (var entry : items.entrySet()) {
			String piece = (used == 0 ? "" : ",") + entry.getKey() + "*" + entry.getValue();
			if (result.length() + piece.length() + 10 > 250) break;
			result.append(piece); used++;
		}
		if (used < items.size()) result.append(",+").append(items.size() - used).append(" more");
	}
}
