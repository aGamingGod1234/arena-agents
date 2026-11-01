package dev.agaminggod.arenaagents.mixin;

import net.minecraft.world.inventory.ContainerData;
import net.minecraft.world.level.block.entity.AbstractFurnaceBlockEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** Vanilla progress for furnaces the player has used (burn ticks: McCompat.burnDuration). */
@Mixin(AbstractFurnaceBlockEntity.class)
public interface AbstractFurnaceBlockEntityAccessor {
	@Accessor("dataAccess")
	ContainerData arenaagents$getFurnaceData();
}
