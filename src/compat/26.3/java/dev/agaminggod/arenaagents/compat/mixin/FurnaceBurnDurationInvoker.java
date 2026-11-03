package dev.agaminggod.arenaagents.compat.mixin;

import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.AbstractFurnaceBlockEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

/** 26.3 resolves a fuel's burn ticks through the furnace (its cooking_fuel component); before 26.3 the level's fuel table did. */
@Mixin(AbstractFurnaceBlockEntity.class)
public interface FurnaceBurnDurationInvoker {
	@Invoker("getBurnDuration")
	int arenaagents$burnDuration(ServerLevel level, ItemStack stack);
}
