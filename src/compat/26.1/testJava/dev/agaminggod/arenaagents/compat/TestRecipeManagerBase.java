package dev.agaminggod.arenaagents.compat;

import java.util.Map;
import net.minecraft.core.HolderLookup;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.item.crafting.Recipe;
import net.minecraft.world.item.crafting.RecipeHolder;
import net.minecraft.world.item.crafting.RecipeManager;
import net.minecraft.world.item.crafting.RecipeMap;

/** A recipe manager holding exactly the given recipes (before 26.3 they arrive through the reload's apply step). */
public abstract class TestRecipeManagerBase extends RecipeManager {
	protected TestRecipeManagerBase(Map<ResourceKey<Recipe<?>>, Recipe<?>> recipes) {
		super(HolderLookup.Provider.create(java.util.stream.Stream.empty()));
		apply(RecipeMap.create(recipes.entrySet().stream().<RecipeHolder<?>>map(entry -> new RecipeHolder<>(entry.getKey(), entry.getValue())).toList()), null, null);
	}
}
