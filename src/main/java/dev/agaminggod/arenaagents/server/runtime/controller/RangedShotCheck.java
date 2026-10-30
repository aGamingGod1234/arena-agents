package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.agent.AgentDomainException;
import dev.agaminggod.arenaagents.server.perception.CrystalCage;
import dev.agaminggod.arenaagents.server.perception.ThreatDamage;
import java.util.Locale;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.boss.enderdragon.EndCrystal;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

/**
 * Whether an arrow's arc, not just a straight sightline, reaches a target, and what would make a blocked target
 * hittable. End runs 2026-10-21 loosed 297 arrows into the iron-bar walls round caged crystals: a straight line slipped
 * through a corner of the cage, but the arc above it met the bars.
 */
public final class RangedShotCheck {
	/** ProjectileUtil.DEFAULT_ENTITY_HIT_RESULT_MARGIN: an arrow in flight hits a box grown by this much. */
	static final double HIT_MARGIN = 0.3D;
	/** A full draw (BowItem: power 1 after 20 ticks). */
	static final int FULL_DRAW_TICKS = 20;

	private RangedShotCheck() { }

	/**
	 * The block a released arrow aimed through {@code aim} meets before it reaches {@code target}'s box (moved to
	 * {@code lead} when the bow leads a moving target), following vanilla flight from 0.1 below the eye; null when the arc
	 * reaches the box or passes it without meeting a block on the way.
	 */
	static BlockHitResult blockBefore(ServerPlayer player, Entity target, Vec3 targetPoint, Vec3 lead, Vec3 aim, double speed) {
		Vec3 eye = player.getEyePosition();
		Vec3 position = eye.add(0.0D, -BowBallistics.LAUNCH_DROP, 0.0D);
		Vec3 velocity = aim.subtract(eye).normalize().scale(speed);
		Vec3 there = lead == null ? targetPoint : lead;
		AABB box = target.getBoundingBox().move(there.subtract(targetPoint)).inflate(HIT_MARGIN);
		double range = horizontal(there.subtract(position));
		double halfWidth = Math.max(box.getXsize(), box.getZsize()) / 2.0D;
		int minY = player.level().getMinY();
		for (int tick = 0; tick < BowBallistics.MAX_TICKS && position.y >= minY; tick++) {
			Vec3 next = position.add(velocity);
			BlockHitResult block = player.level().clip(new ClipContext(position, next, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, CollisionContext.empty()));
			var entry = box.clip(position, next);
			boolean blocked = block.getType() == HitResult.Type.BLOCK;
			if (entry.isPresent() && (!blocked || entry.get().distanceToSqr(position) <= block.getLocation().distanceToSqr(position))) return null;
			if (blocked) {
				// A block met beyond the target's near side is a miss past it, not something in the way.
				return horizontal(block.getLocation().subtract(eye)) < range - halfWidth ? block : null;
			}
			if (horizontal(next.subtract(eye)) > range + halfWidth) return null;
			position = next;
			velocity = velocity.scale(BowBallistics.DRAG).subtract(0.0D, BowBallistics.GRAVITY, 0.0D);
		}
		return null;
	}

	/**
	 * Whether an arrow aimed through {@code aim} enters {@code target}'s box (moved to {@code lead}, grown by the vanilla
	 * hit margin) before any block, following the same flight as {@link #blockBefore}.
	 */
	static boolean arcHits(ServerPlayer player, Entity target, Vec3 targetPoint, Vec3 lead, Vec3 aim, double speed) {
		Vec3 eye = player.getEyePosition();
		Vec3 position = eye.add(0.0D, -BowBallistics.LAUNCH_DROP, 0.0D);
		Vec3 velocity = aim.subtract(eye).normalize().scale(speed);
		Vec3 there = lead == null ? targetPoint : lead;
		AABB box = target.getBoundingBox().move(there.subtract(targetPoint)).inflate(HIT_MARGIN);
		double range = horizontal(there.subtract(position)) + Math.max(box.getXsize(), box.getZsize());
		int minY = player.level().getMinY();
		for (int tick = 0; tick < BowBallistics.MAX_TICKS && position.y >= minY; tick++) {
			Vec3 next = position.add(velocity);
			BlockHitResult block = player.level().clip(new ClipContext(position, next, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, CollisionContext.empty()));
			var entry = box.clip(position, next);
			boolean blocked = block.getType() == HitResult.Type.BLOCK;
			if (entry.isPresent()) return !blocked || entry.get().distanceToSqr(position) <= block.getLocation().distanceToSqr(position);
			if (blocked || horizontal(next.subtract(eye)) > range) return false;
			position = next;
			velocity = velocity.scale(BowBallistics.DRAG).subtract(0.0D, BowBallistics.GRAVITY, 0.0D);
		}
		return false;
	}

	/**
	 * Of the arcs a player's arrow can leave on (the aim and the four extremes of vanilla scatter), how many reach the
	 * target before a block: a shot that grazes a spawner or sill edge fails most of its scatter.
	 */
	static int scatterHits(ServerPlayer player, Entity target, Vec3 targetPoint, Vec3 lead, Vec3 aim, double speed) {
		Vec3 eye = player.getEyePosition();
		Vec3 line = aim.subtract(eye);
		double length = line.length();
		if (length < 1.0E-6D) return 0;
		Vec3 dir = line.scale(1.0D / length);
		Vec3 right = dir.cross(new Vec3(0.0D, 1.0D, 0.0D));
		right = right.lengthSqr() < 1.0E-9D ? new Vec3(1.0D, 0.0D, 0.0D) : right.normalize();
		Vec3 up = right.cross(dir).normalize();
		int hits = 0;
		double d = BowBallistics.SPREAD;
		for (double[] o : new double[][] {{0, 0}, {d, 0}, {-d, 0}, {0, d}, {0, -d}}) {
			Vec3 turned = dir.add(right.scale(o[0])).add(up.scale(o[1])).normalize().scale(length);
			if (arcHits(player, target, targetPoint, lead, eye.add(turned), speed)) hits++;
		}
		return hits;
	}

	static final int SCATTER_ARCS = 5;

	private static double horizontal(Vec3 offset) {
		return Math.sqrt(offset.x * offset.x + offset.z * offset.z);
	}

	/** Why a shot whose arc meets a block first is refused: what it meets and what would make the target hittable. */
	static String obstruction(ServerPlayer player, Entity target, BlockHitResult hit, boolean chosenAim) {
		BlockPos cell = hit.getBlockPos();
		var state = player.level().getBlockState(cell);
		boolean seeThrough = state.getVisualShape(player.level(), cell, CollisionContext.of(player)).isEmpty() || state.is(Blocks.IRON_BARS);
		String text = String.format(Locale.ROOT, "%s from here meets %s at %d,%d,%d before the target%s",
				chosenAim ? "The arc of this aim point" : "The bow's arc to the target",
				BuiltInRegistries.BLOCK.getKey(state.getBlock()), cell.getX(), cell.getY(), cell.getZ(),
				seeThrough ? " (you can see through it, but arrows cannot pass)" : "");
		String advice = advice(player, target, cell);
		return text + (advice.isEmpty() ? "" : ". " + advice);
	}

	/**
	 * What would make a blocked crystal hittable: for a caged one the cage, the bars to break and where to stand; for one
	 * hidden by its own pillar's top, how far out from the pillar its top edge stops hiding it.
	 */
	static String advice(ServerPlayer player, Entity target, BlockPos blocker) {
		if (!(target instanceof EndCrystal crystal)) return "";
		BlockPos feet = crystal.blockPosition();
		// Only the target's own cage or pillar: another cage in the way says nothing about this one.
		if (Math.abs(blocker.getX() - feet.getX()) > 6 || Math.abs(blocker.getZ() - feet.getZ()) > 6) return "";
		CrystalCage cage = CrystalCage.of(player.level(), crystal);
		if (cage != null) return cage.advice(player, ThreatDamage.crystalBlastAt(crystal, player, cage.standSpot(player.position())));
		return pillarEdge(player, crystal, blocker);
	}

	/**
	 * A crystal on a pillar seen from below is hidden by the pillar's top edge until the eye is far enough out: the line to
	 * its top (2 above its feet) clears an edge R out from the centre at the obsidian top (1 below its feet) from
	 * (top - eye) * R / 3 blocks out. End runs 2026-10-21: 34 shots refused at obsidian in 9 games.
	 */
	static String pillarEdge(ServerPlayer player, EndCrystal crystal, BlockPos blocker) {
		BlockPos feet = crystal.blockPosition();
		var level = player.level();
		boolean pillar = blocker.getY() < feet.getY() && (level.getBlockState(blocker).is(Blocks.OBSIDIAN) || level.getBlockState(blocker).is(Blocks.BEDROCK));
		if (!pillar) return "";
		Vec3 centre = Vec3.atBottomCenterOf(feet);
		Vec3 toward = player.position().subtract(centre).multiply(1.0D, 0.0D, 1.0D);
		if (toward.lengthSqr() < 1.0E-6D) return "";
		toward = toward.normalize();
		double edge = 0.0D;
		while (edge < 16.0D && level.getBlockState(BlockPos.containing(centre.add(toward.scale(edge + 0.25D)).add(0.0D, -1.5D, 0.0D))).is(Blocks.OBSIDIAN)) edge += 0.25D;
		if (edge <= 0.0D) return "";
		double rise = feet.getY() + 2.0D - player.getEyeY();
		if (rise <= 0.0D) return "";
		double out = rise * edge / 3.0D;
		double now = horizontal(player.position().subtract(centre));
		return String.format(Locale.ROOT, "Its pillar's top edge (about %.0f blocks from the pillar's centre) hides it from below: from your eye height a line to it clears that edge from about %.0f blocks out from the pillar's centre; you are %.0f out",
				edge, out, now);
	}

	/** For a seen crystal now out of sight: its own pillar's top edge in the way, and how far out it shows again. */
	static String hiddenByPillar(ServerPlayer player, String targetId) {
		Entity entity;
		try { entity = player.level().getEntity(java.util.UUID.fromString(targetId)); }
		catch (IllegalArgumentException invalid) { return ""; }
		if (!(entity instanceof EndCrystal crystal) || !crystal.isAlive()) return "";
		AABB box = crystal.getBoundingBox();
		BlockHitResult hit = player.level().clip(new ClipContext(player.getEyePosition(), new Vec3(box.getCenter().x, box.maxY - 0.05D, box.getCenter().z),
				ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, player));
		if (hit.getType() != HitResult.Type.BLOCK) return "";
		BlockPos feet = crystal.blockPosition(), blocker = hit.getBlockPos();
		if (Math.abs(blocker.getX() - feet.getX()) > 6 || Math.abs(blocker.getZ() - feet.getZ()) > 6) return "";
		return pillarEdge(player, crystal, blocker);
	}

	/**
	 * The inspect fact for a crystal: whether a full-draw arrow from here reaches it, and if not what stops it and what
	 * would make it hittable.
	 */
	public static String fromHere(ServerPlayer player, Entity target) {
		Vec3 point;
		try {
			point = ServerRangedUseController.visibleCentre(player, target, dev.agaminggod.arenaagents.server.runtime.TargetSightline.rangedEntity(player, target));
		} catch (AgentDomainException hidden) {
			// As the use_ranged refusal names it: lines to the body's centre and top, a see-through blocker first.
			AABB box = target.getBoundingBox();
			BlockHitResult named = null;
			for (Vec3 line : new Vec3[] {box.getCenter(), new Vec3(box.getCenter().x, box.maxY - 0.05D, box.getCenter().z)}) {
				BlockHitResult hit = player.level().clip(new ClipContext(player.getEyePosition(), line, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, player));
				if (hit.getType() != HitResult.Type.BLOCK) continue;
				if (named == null || player.level().getBlockState(hit.getBlockPos()).is(Blocks.IRON_BARS)) named = hit;
			}
			return named == null ? "no clear line from here" : blockedText(player, target, named);
		}
		double speed = BowBallistics.speed(FULL_DRAW_TICKS);
		var shot = ServerRangedUseController.shot(player, target, point, ServerRangedUseController.observedMotion(target), FULL_DRAW_TICKS);
		if (shot == null) return String.format(Locale.ROOT, "beyond a full-draw arrow's reach from here (%.0f blocks)", player.getEyePosition().distanceTo(point));
		BlockHitResult hit = blockBefore(player, target, shot.point(), shot.lead(), shot.aim(), speed);
		return hit == null ? "clear: a full-draw arrow's arc reaches it" : blockedText(player, target, hit);
	}

	/** Current visual candidates only. This reports choices to the model; it never selects a replacement target. */
	static String clearTargets(ServerPlayer player) {
		var frame = dev.agaminggod.arenaagents.server.perception.ObservationVisibility.frame(player.level(), player);
		var visible = new java.util.ArrayList<>(player.level().getEntities(player, player.getBoundingBox().inflate(128D),
				e -> e.isAlive() && e.isPickable() && frame.canSeeEntity(e)));
		visible.sort(java.util.Comparator.comparingDouble(player::distanceToSqr));
		var choices = new java.util.ArrayList<String>();
		for (Entity candidate : visible) {
			if (!fromHere(player, candidate).startsWith("clear:")) continue;
			choices.add(String.format(Locale.ROOT, "%s uuid=%s distance=%.1f", net.minecraft.core.registries.BuiltInRegistries.ENTITY_TYPE.getKey(candidate.getType()),
					candidate.getUUID(), player.distanceTo(candidate)));
		}
		return "; currently visible targets with a clear full-draw arrow line, nearest first: " + (choices.isEmpty() ? "none" : String.join("; ", choices));
	}

	private static String blockedText(ServerPlayer player, Entity target, BlockHitResult hit) {
		BlockPos cell = hit.getBlockPos();
		String text = String.format(Locale.ROOT, "blocked: arrows stop at %s at %d,%d,%d", BuiltInRegistries.BLOCK.getKey(player.level().getBlockState(cell).getBlock()),
				cell.getX(), cell.getY(), cell.getZ());
		String advice = advice(player, target, cell);
		return advice.isEmpty() ? text : text + ". " + advice;
	}
}
