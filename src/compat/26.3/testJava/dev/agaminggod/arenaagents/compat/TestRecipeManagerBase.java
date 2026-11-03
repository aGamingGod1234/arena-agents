package dev.agaminggod.arenaagents.compat;

import java.util.Map;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.MappedRegistry;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.item.crafting.Recipe;
import net.minecraft.world.item.crafting.RecipeManager;

/** A recipe manager holding exactly the given recipes (26.3 reads them from the recipe registry of its lookup). */
public abstract class TestRecipeManagerBase extends RecipeManager {
	protected TestRecipeManagerBase(Map<ResourceKey<Recipe<?>>, Recipe<?>> recipes) {
		super(lookup(recipes));
	}

	private static HolderLookup.Provider lookup(Map<ResourceKey<Recipe<?>>, Recipe<?>> recipes) {
		var registry = new MappedRegistry<Recipe<?>>(Registries.RECIPE, com.mojang.serialization.Lifecycle.stable());
		recipes.forEach((key, recipe) -> Registry.register(registry, key, recipe));
		registry.freeze();
		return HolderLookup.Provider.create(java.util.stream.Stream.of(registry));
	}
}
