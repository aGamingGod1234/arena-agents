package dev.agaminggod.arenaagents.mixin;

import dev.agaminggod.arenaagents.server.audit.InterventionAuditHook;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.BaseCommandBlock;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Command blocks and command block minecarts are interventions whatever they run. */
@Mixin(BaseCommandBlock.class)
abstract class CommandBlockInterventionAuditMixin {
	@Shadow public abstract String getCommand();

	@Inject(method = "performCommand", at = @At("HEAD"))
	private void arenaagents$auditCommandBlock(ServerLevel level, CallbackInfoReturnable<Boolean> callback) {
		InterventionAuditHook.commandBlock(level.getServer(), getCommand());
	}
}
