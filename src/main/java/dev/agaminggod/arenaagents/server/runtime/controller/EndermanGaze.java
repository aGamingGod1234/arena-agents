package dev.agaminggod.arenaagents.server.runtime.controller;

import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Enderman;
import net.minecraft.world.phys.Vec3;

/**
 * Where the body's own walking view goes, it keeps the crosshair off calm endermen's eyes, as a player crossing the End
 * watches the ground rather than the endermen: vanilla's stare (Enderman.isBeingStaredBy) is a view within
 * 0.025/distance of their eyes, which widens with distance, and a walking view swinging round a turn swept the eyes of
 * endermen standing a few blocks lower or tens of blocks away (live End runs 2026-10-20: four of seven End deaths were
 * endermen provoked by the body's navigation or fight view). Only the pitch moves; a fight's aim at its target is
 * untouched. A look_at whose exact line meets calm eyes settles just off them and says so (live run d9-end-b: a look
 * at a pearl landing 2.5 blocks behind an enderman provoked it).
 */
public final class EndermanGaze {
	/** Twice vanilla's stare tolerance, matching the gaze reflex, so a turning view never brushes the edge. */
	static final double GUARD_TOLERANCE = 0.05D;
	static final double RANGE = 64.0D;
	private static final float STEP = 5.0F;

	private EndermanGaze() {
	}

	/** {@code pitch}, or the nearest pitch below (else above) it whose view along {@code yaw} meets no calm enderman's eyes. */
	public static float clearPitch(ServerPlayer player, float yaw, float pitch) {
		if (!LivingEntity.PLAYER_NOT_WEARING_DISGUISE_ITEM.test(player)) return pitch;
		var endermen = player.level().getEntitiesOfClass(Enderman.class, player.getBoundingBox().inflate(RANGE),
				enderman -> enderman.isAlive() && enderman.getTarget() != player && !enderman.isInvisibleTo(player));
		if (endermen.isEmpty()) return pitch;
		Vec3 eye = player.getEyePosition();
		if (clear(player, eye, endermen, yaw, pitch)) return pitch;
		for (int step = 1; step <= 12; step++) {
			float down = pitch + STEP * step;
			if (down <= 60.0F && clear(player, eye, endermen, yaw, down)) return down;
			float up = pitch - STEP * step;
			if (up >= -60.0F && clear(player, eye, endermen, yaw, up)) return up;
		}
		return pitch;
	}

	/**
	 * The nearest calm enderman whose eyes a view along {@code yaw}/{@code pitch} meets (with line of sight), or null.
	 * One whose box holds {@code onPurpose} is skipped: the view is on that enderman by the model's choice.
	 */
	public static Enderman staredAt(ServerPlayer player, float yaw, float pitch, Vec3 onPurpose) {
		return staredAt(player, Vec3.directionFromRotation(pitch, yaw), onPurpose);
	}

	/** As {@link #staredAt(ServerPlayer, float, float, Vec3)} for a view direction. */
	public static Enderman staredAt(ServerPlayer player, Vec3 view, Vec3 onPurpose) {
		var endermen = calm(player, onPurpose);
		if (endermen.isEmpty()) return null;
		Vec3 eye = player.getEyePosition();
		Enderman nearest = null;
		for (Enderman enderman : endermen) {
			if (!staring(eye, view, new Vec3(enderman.getX(), enderman.getEyeY(), enderman.getZ())) || !player.hasLineOfSight(enderman)) continue;
			if (nearest == null || player.distanceToSqr(enderman) < player.distanceToSqr(nearest)) nearest = enderman;
		}
		return nearest;
	}

	/**
	 * The pitch nearest {@code pitch} (whole degrees, lower first, at most {@link #NEAR_LIMIT} away) whose view meets no
	 * calm enderman's eyes, as a player aiming past an enderman drops the crosshair just under its head; {@code pitch}
	 * itself when it is clear or nothing near is.
	 */
	public static float nearClearPitch(ServerPlayer player, float yaw, float pitch, Vec3 onPurpose) {
		var endermen = calm(player, onPurpose);
		if (endermen.isEmpty()) return pitch;
		Vec3 eye = player.getEyePosition();
		if (clear(player, eye, endermen, yaw, pitch)) return pitch;
		for (int step = 1; step <= NEAR_LIMIT; step++) {
			if (pitch + step <= 90.0F && clear(player, eye, endermen, yaw, pitch + step)) return pitch + step;
			if (pitch - step >= -90.0F && clear(player, eye, endermen, yaw, pitch - step)) return pitch - step;
		}
		return pitch;
	}

	static final int NEAR_LIMIT = 20;

	private static java.util.List<Enderman> calm(ServerPlayer player, Vec3 onPurpose) {
		var endermen = player.level().getEntitiesOfClass(Enderman.class, player.getBoundingBox().inflate(RANGE),
				enderman -> enderman.isAlive() && enderman.getTarget() != player && !enderman.isInvisibleTo(player)
						&& (onPurpose == null || !enderman.getBoundingBox().inflate(0.3D).contains(onPurpose)));
		return endermen.isEmpty() || LivingEntity.PLAYER_NOT_WEARING_DISGUISE_ITEM.test(player) ? endermen : java.util.List.of();
	}

	private static boolean clear(ServerPlayer player, Vec3 eye, java.util.List<Enderman> endermen, float yaw, float pitch) {
		Vec3 view = Vec3.directionFromRotation(pitch, yaw);
		for (Enderman enderman : endermen) {
			if (staring(eye, view, new Vec3(enderman.getX(), enderman.getEyeY(), enderman.getZ())) && player.hasLineOfSight(enderman)) return false;
		}
		return true;
	}

	/** LivingEntity.isLookingAtMe with distance scaling, at the guard tolerance. */
	static boolean staring(Vec3 eye, Vec3 view, Vec3 enderEye) {
		Vec3 toward = enderEye.subtract(eye);
		double distance = toward.length();
		if (distance < 1.0E-6D || distance > RANGE) return false;
		return view.normalize().dot(toward.scale(1.0D / distance)) > 1.0D - GUARD_TOLERANCE / distance;
	}
}
