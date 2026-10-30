package dev.agaminggod.arenaagents.mixin;

import carpet.patches.EntityPlayerMPFake;
import com.llamalad7.mixinextras.sugar.Share;
import com.llamalad7.mixinextras.sugar.ref.LocalBooleanRef;
import dev.agaminggod.arenaagents.server.CodexAgentServerRuntime;
import net.minecraft.advancements.AdvancementHolder;
import net.minecraft.advancements.AdvancementProgress;
import net.minecraft.server.PlayerAdvancements;
import net.minecraft.server.level.ServerPlayer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(PlayerAdvancements.class)
abstract class PlayerAdvancementsMixin {
	@Shadow private ServerPlayer player;
	@Shadow public abstract AdvancementProgress getOrStartProgress(AdvancementHolder holder);

	@Inject(method = "award", at = @At("HEAD"))
	private void arenaagents$captureAdvancementProgress(AdvancementHolder holder, String criterion, CallbackInfoReturnable<Boolean> callback, @Share("wasDone") LocalBooleanRef wasDone) {
		wasDone.set(player instanceof EntityPlayerMPFake && holder.value().display().isPresent()
				&& getOrStartProgress(holder).isDone());
	}

	@Inject(method = "award", at = @At("RETURN"))
	private void arenaagents$advancementGranted(AdvancementHolder holder, String criterion, CallbackInfoReturnable<Boolean> callback, @Share("wasDone") LocalBooleanRef wasDone) {
		if (player instanceof EntityPlayerMPFake && holder.value().display().isPresent() && dev.agaminggod.arenaagents.server.goal.PlanProgressFacts.advancementCompleted(
				holder.value().display().isPresent(), wasDone.get(), getOrStartProgress(holder).isDone())) {
			CodexAgentServerRuntime.advancementGranted(player, holder.id().toString());
			holder.value().display().filter(display -> display.showToast()).ifPresent(display ->
					dev.agaminggod.arenaagents.server.perception.PlayerObservationEvents.advancementToast(player, display.title().getString()));
		}
	}
}
