package dev.agaminggod.arenaagents.server.runtime;

import dev.agaminggod.arenaagents.agent.AgentDomainException;
import dev.agaminggod.arenaagents.server.perception.ObservationVisibility;
import java.util.UUID;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.boss.enderdragon.EnderDragonPart;
import net.minecraft.world.phys.EntityHitResult;

/** Resolves an exact observed identity, including separately indexed multipart hit targets. */
public final class ObservedEntityTarget {
	private ObservedEntityTarget() { }

	/** Overlapping parts can share the first ray intersection; unrelated or nearer hits still block. */
	public static boolean matchesHit(Entity target, EntityHitResult hit) {
		if (hit.getEntity() == target) return true;
		return target instanceof EnderDragonPart requested && hit.getEntity() instanceof EnderDragonPart struck
				&& requested.parentMob == struck.parentMob
				&& requested.getBoundingBox().inflate(requested.getPickRadius() + 1.0E-7D).contains(hit.getLocation());
	}

	public static Entity resolve(ServerPlayer player, String targetId) {
		return resolve(player, targetId, true);
	}

	/** As {@link #resolve}, but a target outside the view cone counts while the eye has a clear line to it (turning to it is free). */
	public static Entity resolveInSight(ServerPlayer player, String targetId) {
		return resolve(player, targetId, false);
	}

	private static Entity resolve(ServerPlayer player, String targetId, boolean inView) {
		final UUID uuid;
		try { uuid = UUID.fromString(targetId); }
		catch (IllegalArgumentException exception) {
			throw new AgentDomainException("TARGET_NOT_FOUND", "Target id is not a UUID");
		}
		Entity target = player.level().getEntity(uuid);
		if (target == null) {
			for (var part : player.level().dragonParts()) {
				if (part.getUUID().equals(uuid) && part.parentMob.isAlive()) { target = part; break; }
			}
		}
		if (target == null || target.level() != player.level() || !target.isAlive() || target == player) {
			throw new AgentDomainException("TARGET_UNAVAILABLE", "Observed target is no longer available");
		}
		var frame = ObservationVisibility.frame(player.level(), player);
		if (inView ? !frame.canSeeEntity(target) : target.isInvisibleTo(player) || !frame.hasLineOfSight(target)) {
			throw new AgentDomainException("TARGET_NOT_VISIBLE", "Observed target is no longer visible");
		}
		return target;
	}
}
