package dev.agaminggod.arenaagents.mixin;

import com.mojang.brigadier.ParseResults;
import dev.agaminggod.arenaagents.server.audit.InterventionAuditHook;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Console, RCON, player and command-block commands all dispatch here; the audit classifies their parsed node path. */
@Mixin(Commands.class)
abstract class CommandsInterventionAuditMixin {
	@Inject(method = "performCommand", at = @At("HEAD"))
	private void arenaagents$auditIntervention(ParseResults<CommandSourceStack> parse, String command, CallbackInfo callback) {
		InterventionAuditHook.beforeCommand(parse, command);
	}

	@Inject(method = "performCommand", at = @At("RETURN"))
	private void arenaagents$observeGoals(ParseResults<CommandSourceStack> parse, String command, CallbackInfo callback) {
		InterventionAuditHook.afterCommand(parse.getContext().getSource());
	}
}
