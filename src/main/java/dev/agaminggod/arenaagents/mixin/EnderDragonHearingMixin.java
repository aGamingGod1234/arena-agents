package dev.agaminggod.arenaagents.mixin;

import dev.agaminggod.arenaagents.server.perception.HearingPerception;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.util.RandomSource;
import net.minecraft.world.entity.boss.enderdragon.EnderDragon;
import net.minecraft.world.entity.boss.enderdragon.phases.EnderDragonPhase;
import net.minecraft.world.entity.boss.enderdragon.phases.EnderDragonPhaseManager;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * The dragon's wing flaps and growls are client-only in vanilla ({@code playLocalSound} behind {@code isClientSide}),
 * so no packet carries them. The rules that time them run on the server too or read server state, so each is raised
 * to hearing at the server tick where a client plays it.
 */
@Mixin(EnderDragon.class)
abstract class EnderDragonHearingMixin {
	@Shadow private int growlTime;
	@Shadow @Final private EnderDragonPhaseManager phaseManager;
	/** Growl timing draws from its own source so the server dragon's random sequence stays vanilla. */
	@Unique private final RandomSource arenaagents$growlRandom = RandomSource.create();

	/** onFlap runs from processFlappingMovement on both sides when flapTime's cosine crosses -0.3 upward. */
	@Inject(method = "onFlap", at = @At("HEAD"))
	private void arenaagents$hearFlap(CallbackInfo callback) {
		EnderDragon dragon = (EnderDragon) (Object) this;
		if (!dragon.level().isClientSide() && !dragon.isSilent()) HearingPerception.clientLocalSound(dragon, SoundEvents.ENDER_DRAGON_FLAP, 5.0F);
	}

	/**
	 * aiStep's client branch: unless silent or sitting, growlTime counts down and a growl plays every 200-399 ticks
	 * (vanilla leaves the server's growlTime untouched, so it is free to count here). A live, AI-driven dragon in the
	 * sitting-attacking phase also growls every tick from DragonSittingAttackingPhase.doClientTick.
	 */
	@Inject(method = "aiStep", at = @At("HEAD"))
	private void arenaagents$hearGrowl(CallbackInfo callback) {
		EnderDragon dragon = (EnderDragon) (Object) this;
		if (dragon.level().isClientSide()) return;
		if (!dragon.isSilent() && !phaseManager.getCurrentPhase().isSitting() && --growlTime < 0) {
			HearingPerception.clientLocalSound(dragon, SoundEvents.ENDER_DRAGON_GROWL, 2.5F);
			growlTime = 200 + arenaagents$growlRandom.nextInt(200);
		}
		if (!dragon.isNoAi() && !dragon.isDeadOrDying() && phaseManager.getCurrentPhase().getPhase() == EnderDragonPhase.SITTING_ATTACKING) {
			HearingPerception.clientLocalSound(dragon, SoundEvents.ENDER_DRAGON_GROWL, 2.5F);
		}
	}
}
