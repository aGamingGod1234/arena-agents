package dev.agaminggod.arenaagents.mixin;

import net.minecraft.world.entity.LivingEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** Ticks since the current swing started (26.3 replaced LivingEntity.swingTime, which started at -1, with this). */
@Mixin(LivingEntity.SwingState.class)
public interface SwingStateAccessor {
	@Accessor("ticks")
	int arenaagents$ticks();
}
