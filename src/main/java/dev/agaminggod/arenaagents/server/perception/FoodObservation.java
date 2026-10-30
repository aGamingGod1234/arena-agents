package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.core.component.DataComponentMap;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.effect.MobEffectCategory;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.component.Consumable;
import net.minecraft.world.item.consume_effects.ApplyStatusEffectsConsumeEffect;
import net.minecraft.world.item.consume_effects.ConsumeEffect;
import net.minecraft.world.item.consume_effects.TeleportRandomlyConsumeEffect;

/**
 * The hunger points a player carries, read from the installed food components so every edible item counts. Foods
 * whose eating can harm (a harmful effect at any chance), teleport, or have an effect the player cannot know (suspicious
 * stew) are named as risky; whether to eat them stays the model's choice.
 */
final class FoodObservation {
	// The food facts of an item's own components, so an unchanged inventory does not repeat the risk checks on every
	// observation. An entry is used only while the item still has that exact prototype (a component rebind misses).
	private static final Map<Item, Facts> PROTOTYPE_FACTS = new ConcurrentHashMap<>();

	private int items;
	private int nutrition;
	private final Map<String, int[]> risky = new TreeMap<>();

	void add(ItemStack stack) {
		Facts facts = facts(stack);
		if (facts.nutrition() < 0) return;
		int count = stack.getCount();
		items += count;
		nutrition += count * facts.nutrition();
		if (!facts.risky()) return;
		int[] totals = risky.computeIfAbsent(facts.itemId(), id -> new int[2]);
		totals[0] += count;
		totals[1] += count * facts.nutrition();
	}

	/** A stack that patches none of the components these facts read shares its item's prototype facts. */
	static Facts facts(ItemStack stack) {
		if (stack.hasNonDefault(DataComponents.FOOD) || stack.hasNonDefault(DataComponents.CONSUMABLE)
				|| stack.hasNonDefault(DataComponents.SUSPICIOUS_STEW_EFFECTS)) return compute(stack, null);
		DataComponentMap prototype = stack.getPrototype();
		Facts cached = PROTOTYPE_FACTS.get(stack.getItem());
		if (cached != null && cached.prototype() == prototype) return cached;
		Facts computed = compute(stack, prototype);
		PROTOTYPE_FACTS.put(stack.getItem(), computed);
		return computed;
	}

	private static Facts compute(ItemStack stack, DataComponentMap prototype) {
		FoodProperties food = stack.get(DataComponents.FOOD);
		if (food == null) return new Facts(prototype, -1, false, null);
		return new Facts(prototype, food.nutrition(), risky(stack), BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
	}

	/** Nutrition per item, or -1 when the stack is not food. */
	record Facts(DataComponentMap prototype, int nutrition, boolean risky, String itemId) {
	}

	static boolean risky(ItemStack stack) {
		if (stack.has(DataComponents.SUSPICIOUS_STEW_EFFECTS)) return true;
		Consumable consumable = stack.get(DataComponents.CONSUMABLE);
		if (consumable == null) return false;
		for (ConsumeEffect effect : consumable.onConsumeEffects()) {
			if (effect instanceof TeleportRandomlyConsumeEffect) return true;
			if (effect instanceof ApplyStatusEffectsConsumeEffect apply
					&& apply.effects().stream().anyMatch(instance -> instance.getEffect().value().getCategory() == MobEffectCategory.HARMFUL)) return true;
		}
		return false;
	}

	JsonObject toJson() {
		JsonObject json = new JsonObject();
		json.addProperty("items", items);
		json.addProperty("nutrition", nutrition);
		if (!risky.isEmpty()) {
			JsonArray rows = new JsonArray();
			risky.forEach((itemId, totals) -> {
				JsonObject row = new JsonObject();
				row.addProperty("itemId", itemId);
				row.addProperty("count", totals[0]);
				row.addProperty("nutrition", totals[1]);
				rows.add(row);
			});
			json.add("risky", rows);
		}
		return json;
	}
}
