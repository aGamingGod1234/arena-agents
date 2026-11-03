package dev.agaminggod.arenaagents.compat.mixin;

import carpet.patches.EntityPlayerMPFake;
import com.mojang.authlib.GameProfile;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ClientInformation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Carpet 26.1 overrides checkFallDamage on its fake player to call Entity.doCheckFallDamage, which calls
 * checkFallDamage again: the two recurse until the server dies with a StackOverflowError ("Ticking player") as soon
 * as a fake player's fall check runs, which FakePlayerFallAuthorityMixin makes happen on every move. Carpet 26.2 and
 * later dropped that override, so on 26.1 the fake player now takes vanilla's ServerPlayer fall handling instead,
 * the same as on 26.2 and 26.3.
 */
@Mixin(EntityPlayerMPFake.class)
abstract class FakePlayerFallDamageMixin extends ServerPlayer {
	private FakePlayerFallDamageMixin(MinecraftServer server, ServerLevel level, GameProfile profile, ClientInformation information) {
		super(server, level, profile, information);
	}

	@Inject(method = "checkFallDamage", at = @At("HEAD"), cancellable = true)
	private void arenaagents$vanillaFallDamage(double y, boolean onGround, BlockState state, BlockPos pos, CallbackInfo ci) {
		super.checkFallDamage(y, onGround, state, pos);
		ci.cancel();
	}
}
