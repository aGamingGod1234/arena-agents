package dev.agaminggod.arenaagents.server.runtime;

import net.minecraft.commands.arguments.EntityAnchorArgument;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

/** Access to the protected vanilla item ray, without an item instance or a second implementation of its math. */
final class VanillaItemRay extends Item {
	private VanillaItemRay(Properties properties) { super(properties); }

	static BlockHitResult hit(Player player, ClipContext.Fluid fluids) {
		return getPlayerPOVHitResult(player.level(), player, fluids);
	}

	static BlockHitResult atAim(Player player, Vec3 aim, ClipContext.Fluid fluids) {
		float pitch = player.getXRot(), yaw = player.getYRot(), head = player.getYHeadRot();
		float oldPitch = player.xRotO, oldYaw = player.yRotO, oldHead = player.yHeadRotO;
		try {
			player.lookAt(EntityAnchorArgument.Anchor.EYES, aim);
			return hit(player, fluids);
		} finally {
			// Candidate probes run synchronously on the server thread and must not leave a rejected look behind.
			player.setXRot(pitch);
			player.setYRot(yaw);
			player.setYHeadRot(head);
			player.xRotO = oldPitch;
			player.yRotO = oldYaw;
			player.yHeadRotO = oldHead;
		}
	}
}
