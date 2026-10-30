package dev.agaminggod.arenaagents.mixin;

import dev.agaminggod.arenaagents.server.audit.InterventionAuditHook;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.functions.CommandFunction;
import net.minecraft.server.ServerFunctionManager;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Tick, load and scheduled functions run here, and their lines bypass performCommand. The audit cannot see what
 * they change, so each run leaves every agent's coverage partial (before, and after for agents it created).
 */
@Mixin(ServerFunctionManager.class)
abstract class FunctionInterventionAuditMixin {
	@Inject(method = "execute", at = @At("HEAD"))
	private void arenaagents$auditFunctionStart(CommandFunction<CommandSourceStack> function, CommandSourceStack source, CallbackInfo callback) {
		InterventionAuditHook.functionExecuted(source.getServer(), function.id().toString());
	}
}
