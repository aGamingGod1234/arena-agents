package dev.agaminggod.arenaagents.mixin;

import net.minecraft.world.entity.projectile.arrow.AbstractArrow;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

@Mixin(AbstractArrow.class)
public interface AbstractArrowInvoker {
	@Invoker("isInGround")
	boolean arenaagents$isInGround();
}
