package dev.agaminggod.arenaagents.client.mixin;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import dev.agaminggod.arenaagents.client.pov.PovClient;
import net.minecraft.client.gui.Gui;
import net.minecraft.client.player.LocalPlayer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

/**
 * Vanilla opens the in-bed screen (chat plus Leave Bed) while the local player sleeps and closes it on waking
 * (Gui.tick since 26.3, Minecraft.tick before). In a takeover the body that sleeps is the agent, so both checks
 * read it; Leave Bed is relayed by InBedChatScreenPovMixin.
 */
@Mixin(Gui.class)
abstract class GuiInBedPovMixin {
	@WrapOperation(method = "tick", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/player/LocalPlayer;isSleeping()Z"))
	private boolean arenaagents$agentInBed(LocalPlayer player, Operation<Boolean> original) {
		return PovClient.isTakeover() ? PovClient.agentSleeping() : original.call(player);
	}
}
