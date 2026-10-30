package dev.agaminggod.arenaagents.mixin;

import carpet.patches.EntityPlayerMPFake;
import dev.agaminggod.arenaagents.server.perception.PlayerTeleports;
import java.util.Set;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import net.minecraft.world.entity.PositionMoveRotation;
import net.minecraft.world.entity.Relative;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Every server-forced reposition of a player (and Carpet's fake connection calls through) sends the client this teleport. */
@Mixin(ServerGamePacketListenerImpl.class)
abstract class PlayerTeleportMarkerMixin {
	@Inject(method = "teleport(Lnet/minecraft/world/entity/PositionMoveRotation;Ljava/util/Set;)V", at = @At("HEAD"))
	private void arenaagents$markTeleport(PositionMoveRotation position, Set<Relative> relatives, CallbackInfo callback) {
		ServerGamePacketListenerImpl connection = (ServerGamePacketListenerImpl) (Object) this;
		if (connection.player instanceof EntityPlayerMPFake) PlayerTeleports.record(connection.player);
	}
}
