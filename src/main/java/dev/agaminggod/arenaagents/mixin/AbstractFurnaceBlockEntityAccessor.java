package dev.agaminggod.arenaagents.mixin;

import net.minecraft.world.inventory.ContainerData;
import net.minecraft.world.level.block.entity.AbstractFurnaceBlockEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;
import org.spongepowered.asm.mixin.gen.Invoker;

/** Vanilla progress and remaining burn ticks for furnaces the player has used. */
@Mixin(AbstractFurnaceBlockEntity.class)
public interface AbstractFurnaceBlockEntityAccessor {
	@Accessor("dataAccess")
	ContainerData arenaagents$getFurnaceData();
	@Invoker("getBurnDuration")
	int arenaagents$burnDuration(net.minecraft.server.level.ServerLevel level, net.minecraft.world.item.ItemStack stack);
}
