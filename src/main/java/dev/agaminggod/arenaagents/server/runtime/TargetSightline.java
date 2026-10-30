package dev.agaminggod.arenaagents.server.runtime;

import dev.agaminggod.arenaagents.agent.AgentDomainException;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

/** One visible-part aiming rule; it retains the model's target and requested face. */
public final class TargetSightline {
	private TargetSightline() { }

	public static Vec3 block(BlockGetter world, CollisionContext context, Vec3 eye, BlockPos target, double reach, Direction face) {
		return BreakSightline.visiblePoint(world, context, eye, target, reach, eye, face);
	}

	public static Vec3 entity(BlockGetter world, CollisionContext context, Vec3 eye, AABB target, double reach) {
		return entity(world, context, eye, target, reach, ClipContext.Block.COLLIDER);
	}

	public static Vec3 entity(BlockGetter world, CollisionContext context, Vec3 eye, AABB target, double reach, ClipContext.Block shape) {
		return BreakSightline.visibleEntityPoint(world, context, eye, target, reach, shape);
	}

	public static Vec3 block(ServerPlayer player, BlockPos target, Direction face) {
		Vec3 point = block(player.level(), CollisionContext.of(player), player.getEyePosition(), target, player.blockInteractionRange(), face);
		if (point == null) throw new AgentDomainException("TARGET_OBSTRUCTED", "No part of the requested block face is reachable from this eye");
		return point;
	}

	public static Vec3 fluid(net.minecraft.world.entity.player.Player player, BlockPos target, Direction face) {
		var fluids = BreakSightline.fluidRay(player.level(), target);
		net.minecraft.world.phys.BlockHitResult[] lastHit = { null };
		Vec3 point = BreakSightline.visibleFluidPoint(player.level(), player.getEyePosition(), target,
				player.blockInteractionRange(), face, aim -> lastHit[0] = VanillaItemRay.atAim(player, aim, fluids));
		if (point == null) {
			var hit = lastHit[0];
			throw new AgentDomainException("TARGET_OBSTRUCTED", hit == null
					? "No part of the requested fluid surface is reachable from this eye"
					: "Full fluid ray hits " + hit.getType() + " at " + hit.getBlockPos() + " face " + hit.getDirection()
							+ "; choose another face or position");
		}
		return point;
	}

	public static Vec3 rangedEntity(ServerPlayer player, Entity target) {
		AABB box = target.getBoundingBox();
		return entity(player, target, rangedReach(player.getEyePosition(), box), ClipContext.Block.COLLIDER);
	}

	static double rangedReach(Vec3 eye, AABB box) {
		// AABB.getSize is the average side length, which can truncate the only exposed end of a tall entity.
		double diagonal = Math.sqrt(box.getXsize() * box.getXsize() + box.getYsize() * box.getYsize() + box.getZsize() * box.getZsize());
		return eye.distanceTo(box.getCenter()) + diagonal * .5D + .01D;
	}

	public static Vec3 entity(ServerPlayer player, Entity target, double reach) {
		return entity(player, target, reach, ClipContext.Block.OUTLINE);
	}

	private static Vec3 entity(ServerPlayer player, Entity target, double reach, ClipContext.Block shape) {
		Vec3 point = entity(player.level(), CollisionContext.of(player), player.getEyePosition(), target.getBoundingBox(), reach, shape);
		if (point == null) throw new AgentDomainException("TARGET_OBSTRUCTED", "No part of the requested entity is reachable from this eye");
		return point;
	}
}
