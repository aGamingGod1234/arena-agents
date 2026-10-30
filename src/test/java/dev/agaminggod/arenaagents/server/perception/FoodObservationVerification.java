package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonObject;
import java.lang.reflect.Field;
import java.util.HashMap;
import java.util.Map;
import net.minecraft.core.Holder;
import net.minecraft.core.component.DataComponentInitializers;
import net.minecraft.core.component.DataComponentMap;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.data.registries.VanillaRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

/** Verifies the food summary against the installed food components: every edible item counts, risky ones are named. */
public final class FoodObservationVerification {
	private FoodObservationVerification() {
	}

	public static int verify() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		// A bare bootstrap binds no item components; bind the installed vanilla ones for this check and restore afterwards.
		Map<Holder.Reference<Item>, DataComponentMap> originals = bindVanillaItemComponents();
		try {
			return checks();
		} finally {
			restore(originals);
		}
	}

	private static int checks() {
		int passed = 0;
		// Harmful effects at any chance, a random teleport, or a stew's unknown effect make a food risky.
		for (var item : new Item[] {Items.ROTTEN_FLESH, Items.SPIDER_EYE, Items.POISONOUS_POTATO, Items.PUFFERFISH,
				Items.CHORUS_FRUIT, Items.SUSPICIOUS_STEW, Items.CHICKEN}) {
			assertEquals(true, FoodObservation.risky(new ItemStack(item)), item + " is risky"); passed++;
		}
		for (var item : new Item[] {Items.COOKED_BEEF, Items.BREAD, Items.GOLDEN_APPLE, Items.ENCHANTED_GOLDEN_APPLE, Items.HONEY_BOTTLE, Items.BEEF}) {
			assertEquals(false, FoodObservation.risky(new ItemStack(item)), item + " is not risky"); passed++;
		}

		// The End start the review named: only chorus fruit is still food, with its risk labelled.
		FoodObservation end = new FoodObservation();
		end.add(new ItemStack(Items.CHORUS_FRUIT, 8));
		end.add(new ItemStack(Items.ENDER_PEARL, 4));
		assertEquals("{\"items\":8,\"nutrition\":32,\"risky\":[{\"itemId\":\"minecraft:chorus_fruit\",\"count\":8,\"nutrition\":32}]}", end.toJson().toString(), "chorus fruit only"); passed++;

		FoodObservation mixed = new FoodObservation();
		mixed.add(new ItemStack(Items.COOKED_BEEF, 16));
		mixed.add(new ItemStack(Items.ROTTEN_FLESH, 64));
		mixed.add(new ItemStack(Items.ROTTEN_FLESH, 3));
		mixed.add(new ItemStack(Items.DIAMOND_SWORD));
		JsonObject json = mixed.toJson();
		assertEquals(83, json.get("items").getAsInt(), "every edible stack counts"); passed++;
		assertEquals(16 * 8 + 67 * 4, json.get("nutrition").getAsInt(), "nutrition comes from the installed food component"); passed++;
		assertEquals("[{\"itemId\":\"minecraft:rotten_flesh\",\"count\":67,\"nutrition\":268}]", json.get("risky").toString(), "stacks of one risky food merge"); passed++;

		assertEquals("{\"items\":0,\"nutrition\":0}", new FoodObservation().toJson().toString(), "no food is reported as zero, not omitted"); passed++;

		// Unchanged stacks reuse their item's facts, even with unrelated patches such as a name or damage.
		ItemStack named = new ItemStack(Items.ROTTEN_FLESH, 2);
		named.set(DataComponents.CUSTOM_NAME, Component.literal("snack"));
		assertEquals(true, FoodObservation.facts(new ItemStack(Items.ROTTEN_FLESH)) == FoodObservation.facts(named), "a renamed stack shares its item's facts"); passed++;
		assertEquals(true, FoodObservation.facts(new ItemStack(Items.DIAMOND_SWORD)) == FoodObservation.facts(new ItemStack(Items.DIAMOND_SWORD)), "non-food is cached too"); passed++;
		// A stack whose own food component differs is read afresh and does not change the item's cached facts.
		ItemStack patched = new ItemStack(Items.BREAD, 3);
		patched.set(DataComponents.FOOD, new FoodProperties(1, 0.1F, false));
		ItemStack inedible = new ItemStack(Items.COOKED_BEEF, 5);
		inedible.remove(DataComponents.FOOD);
		FoodObservation edited = new FoodObservation();
		edited.add(patched);
		edited.add(inedible);
		edited.add(new ItemStack(Items.BREAD, 2));
		assertEquals("{\"items\":5,\"nutrition\":13}", edited.toJson().toString(), "patched food components are read, not cached"); passed++;
		var steak = new net.minecraft.world.SimpleContainer(new ItemStack(Items.COOKED_BEEF, 16));
		assertEquals(false, SurvivalPerception.carriedFood(steak, 20).canEat(), "ordinary food is inedible at full hunger"); passed++;
		assertEquals(true, SurvivalPerception.carriedFood(steak, 19).canEat(), "ordinary food is edible below full hunger"); passed++;
		assertEquals(false, SurvivalPerception.carriedFood(new net.minecraft.world.SimpleContainer(41), 19).canEat(), "empty inventory is not food"); passed++;
		var choices = new net.minecraft.world.SimpleContainer(new ItemStack(Items.COOKED_BEEF, 16), new ItemStack(Items.GOLDEN_APPLE));
		var carried = SurvivalPerception.carriedFood(choices, 20);
		assertEquals(true, carried.canEat(), "an edible alternative counts even when steak ranks higher"); passed++;
		assertEquals("minecraft:cooked_beef", carried.bestFood().itemId(), "the existing best-food ranking is preserved"); passed++;
		var survival = SurvivalPerception.evaluate(6, 20, 20, carried.bestFood(), false, true, new SurvivalPerception.Latch(), 0, carried.canEat());
		assertEquals(true, SurvivalPerception.toJson(survival).get("canEat").getAsBoolean(), "inventory eatability reaches the wire"); passed++;
		var healing = SurvivalPerception.evaluate(6, 20, 20, carried.bestFood(), false, true, new SurvivalPerception.Latch(), 0,
				carried.canEat(), carried.healFood());
		assertEquals("minecraft:golden_apple", carried.healFood().itemId(), "the edible golden apple is the heal food at full hunger"); passed++;
		assertEquals(true, healing.canHealNow(), "an edible alternative lets an injured, safe player heal at full hunger"); passed++;
		assertEquals(true, healing.signals().contains(SurvivalPerception.HEAL_OPPORTUNITY), "the heal opportunity is reported"); passed++;
		assertEquals("minecraft:golden_apple", SurvivalPerception.toJson(healing).getAsJsonObject("healFood").get("itemId").getAsString(),
				"the wire names which food heals now"); passed++;
		var steakOnly = SurvivalPerception.carriedFood(steak, 20);
		assertEquals(true, steakOnly.healFood() == null, "steak alone cannot heal at full hunger"); passed++;
		assertEquals(false, SurvivalPerception.evaluate(6, 20, 20, steakOnly.bestFood(), false, true, new SurvivalPerception.Latch(), 0,
				steakOnly.canEat(), steakOnly.healFood()).canHealNow(), "steak alone at full hunger is not a heal opportunity"); passed++;
		for (var item : new Item[] {Items.GOLDEN_APPLE, Items.ENCHANTED_GOLDEN_APPLE, Items.CHORUS_FRUIT, Items.SUSPICIOUS_STEW}) {
			var candidate = SurvivalPerception.carriedFood(new net.minecraft.world.SimpleContainer(new ItemStack(item)), 20);
			assertEquals(true, candidate.canEat(), item + " is always edible according to its food component"); passed++;
			if (candidate.bestFood() != null) {
				assertEquals(true, candidate.bestFood().alwaysEdible(), item + " keeps its component flag"); passed++;
			}
		}
		var componentFood = new ItemStack(Items.BREAD);
		componentFood.set(DataComponents.FOOD, new FoodProperties(1, 0.1F, true));
		var componentInventory = SurvivalPerception.carriedFood(new net.minecraft.world.SimpleContainer(componentFood), 20);
		assertEquals(true, componentInventory.canEat(), "a patched always-edible component counts without an item-name list"); passed++;
		return passed;
	}

	@SuppressWarnings("unchecked")
	private static Map<Holder.Reference<Item>, DataComponentMap> bindVanillaItemComponents() {
		Map<Holder.Reference<Item>, DataComponentMap> originals = new HashMap<>();
		for (DataComponentInitializers.PendingComponents<?> pending : BuiltInRegistries.DATA_COMPONENT_INITIALIZERS.build(net.minecraft.data.registries.VanillaRegistries.createReloadableLookup(net.minecraft.data.registries.VanillaRegistries.createWorldLookup()))) {
			if (!pending.key().equals(Registries.ITEM)) continue;
			((DataComponentInitializers.PendingComponents<Item>) pending).forEach((holder, components) -> {
				originals.put(holder, boundComponents(holder));
				holder.bindComponents(components);
			});
		}
		return originals;
	}

	private static DataComponentMap boundComponents(Holder.Reference<Item> holder) {
		try {
			return (DataComponentMap) componentsField().get(holder);
		} catch (ReflectiveOperationException exception) {
			throw new AssertionError("could not read item components", exception);
		}
	}

	private static void restore(Map<Holder.Reference<Item>, DataComponentMap> originals) {
		try {
			Field components = componentsField();
			for (Map.Entry<Holder.Reference<Item>, DataComponentMap> entry : originals.entrySet()) components.set(entry.getKey(), entry.getValue());
		} catch (ReflectiveOperationException exception) {
			throw new AssertionError("could not restore item components", exception);
		}
	}

	private static Field componentsField() throws NoSuchFieldException {
		Field components = Holder.Reference.class.getDeclaredField("components");
		components.setAccessible(true);
		return components;
	}

	public static void main(String[] args) {
		System.out.println("PASS: " + verify() + " food observation assertions");
	}

	private static void assertEquals(Object expected, Object actual, String label) {
		if (!expected.equals(actual)) {
			throw new AssertionError(label + ": expected <" + expected + "> but was <" + actual + ">");
		}
	}
}
