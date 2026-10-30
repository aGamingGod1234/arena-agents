package dev.agaminggod.arenaagents.server.runtime.controller;

import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.agent.AgentDomainException;
import dev.agaminggod.arenaagents.server.perception.ObservationVisibility;
import dev.agaminggod.arenaagents.server.runtime.ElapsedTimeAccumulator;
import dev.agaminggod.arenaagents.server.runtime.ServerProtectionPolicy;
import dev.agaminggod.arenaagents.server.runtime.transaction.ServerTransactionAdapter;
import dev.agaminggod.arenaagents.server.runtime.transaction.UseConfirmation;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.projectile.arrow.AbstractArrow;
import net.minecraft.world.item.BowItem;
import net.minecraft.world.item.ItemStack;

public final class ServerRangedUseController implements ServerTransactionAdapter.ActiveTransaction {
	private static final double PROJECTILE_OBSERVATION_RADIUS = 128.0D;
	private final ServerPlayer player;
	private final Entity target;
	private final InteractionHand hand;
	private final ItemStack bow;
	private final ElapsedTimeAccumulator elapsedTime;
	private final long drawDurationMs;
	private final long timeoutMs;
	private final int entityIdBaseline;
	private final net.minecraft.world.phys.Vec3 aimPoint;
	/** The visible target point a ballistic shot must reach; null with fixed aim fields. */
	private final net.minecraft.world.phys.Vec3 targetPoint;
	private final int drawTicks;
	private net.minecraft.world.phys.Vec3 lastAim;
	private net.minecraft.world.phys.Vec3 lastTargetPoint;
	private long drawStartedAtMs;
	private final boolean trackTarget;
	private final boolean explicitAim;
	/** Re-aims every tick while drawing because the target was seen moving (trackTarget asks for it at any speed). */
	private final boolean follow;
	/** Where the last solved aim expected the target to be when the arrow arrives (the target itself when still). */
	private net.minecraft.world.phys.Vec3 lastLead;
	private final ServerTransactionAdapter.TerminalGate terminal = new ServerTransactionAdapter.TerminalGate();
	private ServerTransactionAdapter.ConfirmedUseTimer useTimer = new ServerTransactionAdapter.ConfirmedUseTimer();
	/** Draws started again after something else (the agent's own shield reflex) ended one before release. */
	private int redraws;
	private UseConfirmation useConfirmation = UseConfirmation.initial();
	private boolean started;
	private boolean released;
	/** The view has finished its player-speed turn onto the aim point; the arrow is loosed only after that. */
	private boolean aimSettled;
	/** The loosed arrow, watched as a player watches it until it hits, sticks, leaves view or flies too long. */
	private ArrowWatch watch;

	public ServerRangedUseController(
			ServerPlayer player,
			JsonObject arguments,
			ServerProtectionPolicy protection
	) {
		this.player = Objects.requireNonNull(player, "player must not be null");
		Objects.requireNonNull(arguments, "arguments must not be null");
		this.target = resolveRangedTarget(player, arguments.get("targetId").getAsString());
		boolean protectionAllowed = Objects.requireNonNull(protection, "protection must not be null")
				.mayUseRangedWeapon(player, target);
		TargetFacts targetFacts = TargetFacts.from(target, protectionAllowed);
		if (!targetFacts.eligible()) {
			throw new AgentDomainException("RANGED_TARGET_DENIED", "Ranged target is protected, invulnerable, or not projectile-hittable");
		}
		// A bow on the hotbar is taken in hand the way a player presses its number key (deck c6-1 lost a shot to
		// BOW_NOT_EQUIPPED with the bow one key away); the switch happens only once the shot is accepted.
		int bowSlot = heldBow(player) ? -1 : hotbarBowSlot(player);
		this.hand = bowSlot >= 0 ? InteractionHand.MAIN_HAND : bowHand(player);
		this.bow = bowSlot >= 0 ? player.getInventory().getItem(bowSlot) : player.getItemInHand(hand);
		if (!(bow.getItem() instanceof BowItem)) {
			throw new AgentDomainException("BOW_NOT_EQUIPPED", "A bow must be held in either hand");
		}
		if (!canStartBowUse(!player.getProjectile(bow).isEmpty(), player.hasInfiniteMaterials())) {
			throw new AgentDomainException("PROJECTILE_REQUIRED", "Vanilla bow use requires an owned arrow");
		}
		this.elapsedTime = new ElapsedTimeAccumulator(System.currentTimeMillis());
		this.drawDurationMs = arguments.get("drawDurationMs").getAsLong();
		this.timeoutMs = arguments.get("timeoutMs").getAsLong();
		this.entityIdBaseline = globalEntityIdBaseline(player.level());
		this.trackTarget = arguments.has("trackTarget") && arguments.get("trackTarget").getAsBoolean();
		this.explicitAim = arguments.has("aimX");
		this.drawTicks = (int) Math.max(1L, (drawDurationMs + 49L) / 50L);
		if (explicitAim) {
			this.targetPoint = null;
			this.aimPoint = new net.minecraft.world.phys.Vec3(
					arguments.get("aimX").getAsDouble(), arguments.get("aimY").getAsDouble(), arguments.get("aimZ").getAsDouble());
		} else {
			this.targetPoint = visibleRangedPoint(player, target);
			this.aimPoint = ballisticAim(player, targetPoint, observedMotion(target), drawTicks);
			if (aimPoint == null) {
				throw new AgentDomainException("RANGED_TARGET_OUT_OF_REACH", String.format(java.util.Locale.ROOT,
						"An arrow from this bow cannot reach the target %.0f blocks away from here; move closer", player.getEyePosition().distanceTo(targetPoint)));
			}
		}
		// The arc, not the straight sightline, is what the arrow flies: one that meets a block first is refused up front.
		net.minecraft.world.phys.Vec3 arcTarget = lastTargetPoint != null ? lastTargetPoint : targetPoint != null ? targetPoint : target.getBoundingBox().getCenter();
		var arcBlock = RangedShotCheck.blockBefore(player, target, arcTarget, explicitAim ? null : lastLead, aimPoint, BowBallistics.speed(drawTicks));
		if (arcBlock != null) throw new AgentDomainException("TARGET_OBSTRUCTED", RangedShotCheck.obstruction(player, target, arcBlock, explicitAim) + RangedShotCheck.clearTargets(player));
		this.follow = !explicitAim && observedMotion(target).lengthSqr() >= MOVING_SQR;
		if (bowSlot >= 0) player.getInventory().setSelectedSlot(bowSlot);
	}

	private static boolean heldBow(ServerPlayer player) {
		return player.getMainHandItem().getItem() instanceof BowItem || player.getOffhandItem().getItem() instanceof BowItem;
	}

	/** The first hotbar slot holding a bow, or -1. */
	static int hotbarBowSlot(ServerPlayer player) {
		for (int slot = 0; slot < 9; slot++) if (player.getInventory().getItem(slot).getItem() instanceof BowItem) return slot;
		return -1;
	}

	/** Below this speed (0.4 blocks/s) a target counts as holding still. */
	static final double MOVING_SQR = 0.02D * 0.02D;
	/** A jump this large in one tick is a teleport (or a fresh entity), not motion to lead. */
	static final double TELEPORT_SQR = 4.0D * 4.0D;

	/**
	 * The target's motion over the last tick as seen (blocks per tick): its position against where it was drawn a tick
	 * ago. Dragon parts are moved by the dragon and keep their own previous positions. Zero for a still target.
	 */
	static net.minecraft.world.phys.Vec3 observedMotion(Entity target) {
		net.minecraft.world.phys.Vec3 motion = target.position().subtract(target.xo, target.yo, target.zo);
		return motion.lengthSqr() > TELEPORT_SQR || motion.lengthSqr() < MOVING_SQR ? net.minecraft.world.phys.Vec3.ZERO : motion;
	}

	/**
	 * Without fixed aim fields the bow aims as a practised archer does: ahead of a moving target by its motion over the
	 * arrow's flight, and above it by the arrow's drop over that range.
	 */
	private net.minecraft.world.phys.Vec3 ballisticAim(ServerPlayer player, net.minecraft.world.phys.Vec3 point,
			net.minecraft.world.phys.Vec3 motion, int ticks) {
		Shot shot = shot(player, target, point, motion, ticks);
		if (shot == null) return null;
		lastLead = shot.lead(); lastTargetPoint = shot.point();
		return shot.aim();
	}

	record Shot(net.minecraft.world.phys.Vec3 point, net.minecraft.world.phys.Vec3 lead, net.minecraft.world.phys.Vec3 aim) { }

	/** Shared by the requested shot and the visible choice report; never chooses another entity. */
	static Shot shot(ServerPlayer player, Entity target, net.minecraft.world.phys.Vec3 point,
			net.minecraft.world.phys.Vec3 motion, int ticks) {
		double speed = BowBallistics.speed(ticks);
		Shot initial = solveShot(player, point, motion, speed);
		if (initial == null) return null;
		if (RangedShotCheck.blockBefore(player, target, point, initial.lead(), initial.aim(), speed) == null) return steadiest(player, target, initial, motion, speed);
		// A visible centre can send the lower arrow launch into a sill. Aim through the visible upper
		// body of the SAME target, as a player shooting through an eye-height window does.
		var box = target.getBoundingBox();
		for (double height : new double[] {0.9D, 0.75D, 0.6D}) {
			var sample = new net.minecraft.world.phys.Vec3(box.getCenter().x, box.minY + box.getYsize() * height, box.getCenter().z);
			if (!openLine(player, net.minecraft.world.phys.shapes.CollisionContext.of(player), player.getEyePosition(), sample, box)) continue;
			Shot candidate = solveShot(player, sample, motion, speed);
			if (candidate != null && RangedShotCheck.blockBefore(player, target, sample, candidate.lead(), candidate.aim(), speed) == null) return steadiest(player, target, candidate, motion, speed);
		}
		return initial;
	}

	private static final double[] BODY_HEIGHTS = {0.1D, 0.25D, 0.4D, 0.55D, 0.7D, 0.85D, 0.95D};

	/**
	 * A clear shot whose arc grazes cover (deck c6-4: three arrows at a blaze standing beside its spawner stuck in the
	 * spawner's face; the aim cleared its edge by about 0.05 block, inside vanilla scatter) is moved to the visible part
	 * of the SAME target that most of the scatter reaches, as a player aims at the head over a wall rather than its top
	 * edge. A shot whose whole scatter already reaches the target is kept.
	 */
	private static Shot steadiest(ServerPlayer player, Entity target, Shot clear, net.minecraft.world.phys.Vec3 motion, double speed) {
		int best = RangedShotCheck.scatterHits(player, target, clear.point(), clear.lead(), clear.aim(), speed);
		if (best >= RangedShotCheck.SCATTER_ARCS) return clear;
		Shot chosen = clear;
		var box = target.getBoundingBox();
		var eye = player.getEyePosition();
		var context = net.minecraft.world.phys.shapes.CollisionContext.of(player);
		var sight = box.getCenter().subtract(eye).multiply(1.0D, 0.0D, 1.0D);
		var right = sight.lengthSqr() < 1.0E-6D ? new net.minecraft.world.phys.Vec3(1.0D, 0.0D, 0.0D)
				: new net.minecraft.world.phys.Vec3(-sight.z, 0.0D, sight.x).normalize();
		double side = Math.min(box.getXsize(), box.getZsize()) * 0.3D;
		for (double height : BODY_HEIGHTS) for (double lateral : new double[] {0.0D, -side, side}) {
			var sample = new net.minecraft.world.phys.Vec3(box.getCenter().x + right.x * lateral,
					box.minY + box.getYsize() * height, box.getCenter().z + right.z * lateral);
			if (!openLine(player, context, eye, sample, box)) continue;
			Shot candidate = solveShot(player, sample, motion, speed);
			if (candidate == null || RangedShotCheck.blockBefore(player, target, sample, candidate.lead(), candidate.aim(), speed) != null) continue;
			int hits = RangedShotCheck.scatterHits(player, target, sample, candidate.lead(), candidate.aim(), speed);
			if (hits > best) { best = hits; chosen = candidate; }
			if (best >= RangedShotCheck.SCATTER_ARCS) return chosen;
		}
		return chosen;
	}

	private static Shot solveShot(ServerPlayer player, net.minecraft.world.phys.Vec3 point,
			net.minecraft.world.phys.Vec3 motion, double speed) {
		var led = BowBallistics.lead(player.getEyePosition(), point, motion, speed);
		if (led == null) return null;
		var aim = BowBallistics.aimPoint(player.getEyePosition(), led, speed);
		return aim == null ? null : new Shot(point, led, aim);
	}

	/** The visible body point the arrow should reach; names the first block in the way when none is open to an arrow. */
	private static net.minecraft.world.phys.Vec3 visibleRangedPoint(ServerPlayer player, Entity target) {
		try {
			return visibleCentre(player, target, dev.agaminggod.arenaagents.server.runtime.TargetSightline.rangedEntity(player, target));
		} catch (AgentDomainException exception) {
			// The archer sees what the arrow would meet: lines to the body's centre and top. A see-through blocker
			// (iron bars, glass panes) is named first, since the target looks open behind it.
			net.minecraft.world.phys.AABB box = target.getBoundingBox();
			net.minecraft.core.BlockPos named = null;
			boolean seeThrough = false;
			for (net.minecraft.world.phys.Vec3 point : new net.minecraft.world.phys.Vec3[] {box.getCenter(),
					new net.minecraft.world.phys.Vec3(box.getCenter().x, box.maxY - 0.05D, box.getCenter().z)}) {
				var hit = player.level().clip(new net.minecraft.world.level.ClipContext(player.getEyePosition(), point,
						net.minecraft.world.level.ClipContext.Block.COLLIDER, net.minecraft.world.level.ClipContext.Fluid.NONE, player));
				if (hit.getType() != net.minecraft.world.phys.HitResult.Type.BLOCK) continue;
				var state = player.level().getBlockState(hit.getBlockPos());
				boolean clearToEye = state.getVisualShape(player.level(), hit.getBlockPos(), net.minecraft.world.phys.shapes.CollisionContext.of(player)).isEmpty();
				if (named == null || clearToEye && !seeThrough) { named = hit.getBlockPos(); seeThrough = clearToEye; }
			}
			if (named == null) throw exception;
			String block = net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(player.level().getBlockState(named).getBlock()).toString();
			String advice = RangedShotCheck.advice(player, target, named);
			throw new AgentDomainException("TARGET_OBSTRUCTED", "No line from this eye reaches the target unblocked; arrows stop at " + block
					+ " at " + named.getX() + "," + named.getY() + "," + named.getZ() + (seeThrough ? " (you can see through it, but arrows cannot pass)" : "")
					+ (advice.isEmpty() ? "" : ". " + advice) + RangedShotCheck.clearTargets(player));
		}
	}

	/**
	 * The middle of what the archer sees of the target. Aiming at the one corner left in view (a crystal half hidden
	 * by its pillar's top seen from below) put default shots just over the box: live End runs 2026-10-20 missed 1.1-1.6
	 * blocks above and about 1 block beside the centre, then switched to hand-picked aim points.
	 */
	static net.minecraft.world.phys.Vec3 visibleCentre(ServerPlayer player, Entity target, net.minecraft.world.phys.Vec3 visible) {
		net.minecraft.world.phys.AABB box = target.getBoundingBox();
		if (visible.equals(box.getCenter())) return visible;
		net.minecraft.world.phys.Vec3 eye = player.getEyePosition();
		var context = net.minecraft.world.phys.shapes.CollisionContext.of(player);
		java.util.ArrayList<net.minecraft.world.phys.Vec3> open = new java.util.ArrayList<>();
		int samples = 5;
		for (int i = 0; i < samples; i++) for (int j = 0; j < samples; j++) for (int k = 0; k < samples; k++) {
			net.minecraft.world.phys.Vec3 point = new net.minecraft.world.phys.Vec3(
					box.minX + box.getXsize() * (i + 0.5D) / samples,
					box.minY + box.getYsize() * (j + 0.5D) / samples,
					box.minZ + box.getZsize() * (k + 0.5D) / samples);
			if (openLine(player, context, eye, point, box)) open.add(point);
		}
		if (open.isEmpty()) return visible;
		net.minecraft.world.phys.Vec3 mean = net.minecraft.world.phys.Vec3.ZERO;
		for (net.minecraft.world.phys.Vec3 point : open) mean = mean.add(point);
		mean = mean.scale(1.0D / open.size());
		if (openLine(player, context, eye, mean, box)) return mean;
		// Otherwise the open sample nearest that mean.
		net.minecraft.world.phys.Vec3 best = visible;
		double bestDistance = Double.POSITIVE_INFINITY;
		for (net.minecraft.world.phys.Vec3 point : open) {
			double distance = point.distanceToSqr(mean);
			if (distance < bestDistance) { bestDistance = distance; best = point; }
		}
		return best;
	}

	/** Whether the straight line from the eye to where it first meets the box toward {@code point} is free of blocks. */
	private static boolean openLine(ServerPlayer player, net.minecraft.world.phys.shapes.CollisionContext context,
			net.minecraft.world.phys.Vec3 eye, net.minecraft.world.phys.Vec3 point, net.minecraft.world.phys.AABB box) {
		return dev.agaminggod.arenaagents.server.perception.EntityHitboxSight.clear(player.level(), context, eye,
				dev.agaminggod.arenaagents.server.perception.EntityHitboxSight.intersection(eye, point, box),
				net.minecraft.world.level.ClipContext.Block.COLLIDER);
	}

	/** The ballistic aim for this tick at the power the bow will have when it is released. */
	private net.minecraft.world.phys.Vec3 currentAim(long nowEpochMs) {
		if (explicitAim) return aimPoint;
		net.minecraft.world.phys.Vec3 point = targetPoint;
		net.minecraft.world.phys.Vec3 motion = net.minecraft.world.phys.Vec3.ZERO;
		if (trackTarget || follow) {
			motion = observedMotion(target);
			point = visibleRangedPoint(player, target);
		}
		if (point == null) return lastAim != null ? lastAim : aimPoint;
		// Bow power follows the game ticks the draw has been held; release comes at the planned draw or later.
		int heldTicks = started ? player.getTicksUsingItem() : 0;
		int ticks = Math.max(drawTicks, heldTicks);
		net.minecraft.world.phys.Vec3 aim = ballisticAim(player, point, motion, ticks);
		if (aim != null) lastAim = aim;
		return lastAim;
	}

	@Override
	public ServerTransactionAdapter.TickResult tick(long nowEpochMs) {
		ServerTransactionAdapter.TickResult existing = terminal.terminalResult();
		if (existing != null) return existing;
		long elapsed = elapsedTime.advance(nowEpochMs);
		if (watch != null) {
			String outcome = watch.tick(elapsed >= timeoutMs);
			if (outcome != null) arrowOutcome = outcome;
			return outcome == null ? ServerTransactionAdapter.TickResult.running()
					: finish(ServerTransactionAdapter.TickResult.succeeded("OWNED_PROJECTILE_CONFIRMED", "Arrow loosed" + watch.aimNote + redrawNote() + "; " + outcome));
		}
		if (elapsed >= timeoutMs) {
			if (!released && holdCode != null) {
				return finish(ServerTransactionAdapter.TickResult.failed(holdCode, holdMessage + String.format(java.util.Locale.ROOT,
						"; held the draw %.1f s to the timeout waiting for a clear shot", (elapsed - holdSinceMs) / 1000.0D) + redrawNote()));
			}
			return finish(ServerTransactionAdapter.TickResult.timedOut(
					"RANGED_USE_TIMED_OUT", "No newly spawned owned arrow was observed before timeout" + redrawNote()));
		}
		if (!released && (!target.isAlive() || target.level() != player.level())) {
			return finish(ServerTransactionAdapter.TickResult.failed("TARGET_UNAVAILABLE", "Ranged target is no longer alive"));
		}
		// Mid-draw, a target that slips behind cover (a blaze sinking below its platform edge or a window frame) is
		// waited for with the bow held, as a player holds the draw until it shows again; the timeout ends the wait.
		boolean holding = false;
		if (!released && !ObservationVisibility.frame(player.level(), player).hasLineOfSight(target)) {
			String code = "TARGET_NOT_VISIBLE", message = null;
			try { visibleRangedPoint(player, target); }
			catch (AgentDomainException blocked) { code = blocked.code(); message = blocked.getMessage(); }
			hold(code, message != null ? message : "Lost sight of the ranged target before release" + RangedShotCheck.clearTargets(player), elapsed);
			holding = true;
		}
		if (!released && !holding) {
			// Draw while turning, as a player does; a snap onto the aim point read as a camera jump to spectators. A
			// ballistic aim is re-solved each tick for the power the draw will have at release.
			net.minecraft.world.phys.Vec3 aim = null;
			try { aim = currentAim(nowEpochMs); }
			catch (AgentDomainException blocked) { hold(blocked.code(), blocked.getMessage(), elapsed); holding = true; }
			if (!holding) {
				var point = lastTargetPoint != null ? lastTargetPoint : target.getBoundingBox().getCenter();
				var block = RangedShotCheck.blockBefore(player, target, point, explicitAim ? null : lastLead, aim, BowBallistics.speed(drawTicks));
				if (block != null) {
					hold("TARGET_OBSTRUCTED", RangedShotCheck.obstruction(player, target, block, explicitAim) + RangedShotCheck.clearTargets(player), elapsed);
					holding = true;
				} else {
					holdCode = null;
					boolean onAim = ServerLookController.turnToward(player, aim);
					aimSettled = explicitAim && !trackTarget ? aimSettled || onAim : onAim;
				}
			}
		}
		if (holding) aimSettled = false;
		if (started && !released && (!player.isUsingItem() || player.getUsedItemHand() != hand || player.getUseItem().getItem() != bow.getItem())) {
			// A shield/use handoff can end the vanilla draw while this transaction is paused. It must not wait
			// for its old timer and then "release" an idle hand (the natural-spawner timeout).
			AbstractArrow arrow = newestOwnedArrow(player, entityIdBaseline);
			if (arrow != null) {
				released = true; watch = new ArrowWatch(player, arrow, target, aimNote());
				return ServerTransactionAdapter.TickResult.running();
			}
			ItemStack inHand = player.getItemInHand(hand);
			if (inHand.getItem() instanceof BowItem && canStartBowUse(!player.getProjectile(inHand).isEmpty(), player.hasInfiniteMaterials())) {
				// The agent's own reflex (a raised shield against a fireball) ended the draw while this shot was paused. As
				// a player lowers the shield and draws again, the shot restarts from an empty draw inside its timeout.
				redraws++;
				started = false;
				aimSettled = false;
				useTimer = new ServerTransactionAdapter.ConfirmedUseTimer();
				useConfirmation = UseConfirmation.initial();
				return ServerTransactionAdapter.TickResult.running();
			}
			return finish(ServerTransactionAdapter.TickResult.failed("RANGED_DRAW_INTERRUPTED",
					"Vanilla bow draw ended before release; using=" + player.isUsingItem()
					+ "; active item=" + net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(player.getUseItem().getItem())
					+ "; no new owned arrow observed; choose the next action"));
		}
		if (!started) {
			InteractionResult result = player.gameMode.useItem(player, player.level(), bow, hand);
			if (!result.consumesAction() || !player.isUsingItem() || player.getUsedItemHand() != hand) {
				return finish(ServerTransactionAdapter.TickResult.failed(
						"RANGED_USE_NOT_STARTED", "Vanilla bow use did not enter the observed using state"));
			}
			started = true;
			drawStartedAtMs = nowEpochMs;
			useConfirmation = useConfirmation.observeUsing(true);
			useTimer.observeStarted(true, nowEpochMs);
		}
		// Released once the bow has been drawn the requested game ticks (what sets vanilla arrow power), not wall-clock
		// time: a lagging server would otherwise loose a weaker arrow than the aim was solved for.
		if (!released && aimSettled && player.getTicksUsingItem() >= drawTicks) {
			player.releaseUsingItem();
			released = true;
			useConfirmation = useConfirmation.observeUsing(player.isUsingItem());
			if (!useConfirmation.confirmed()) {
				return finish(ServerTransactionAdapter.TickResult.failed(
						"RANGED_RELEASE_NOT_OBSERVED", "Bow release was not observed after use started"));
			}
		}
		if (released && confirmOwnedProjectile(entityIdBaseline, liveOwnedArrows(player), player.getUUID())) {
			AbstractArrow arrow = newestOwnedArrow(player, entityIdBaseline);
			if (arrow == null) {
				return finish(ServerTransactionAdapter.TickResult.succeeded(
						"OWNED_PROJECTILE_CONFIRMED", "A new live arrow owned by the agent was observed"));
			}
			watch = new ArrowWatch(player, arrow, target, aimNote());
			return ServerTransactionAdapter.TickResult.running();
		}
		return ServerTransactionAdapter.TickResult.running();
	}

	/** The named target this shot aims at. */
	public Entity target() {
		return target;
	}

	/** How the loosed arrow's flight ended as the archer saw it, or null before that (or when no arrow flew). */
	public String arrowOutcome() {
		return arrowOutcome;
	}

	private String arrowOutcome;

	@Override
	public void cancel(String reason) {
		terminal.finish(ServerTransactionAdapter.TickResult.cancelled(reason == null ? "Ranged use cancelled" : reason));
		cleanup();
	}

	@Override
	public void cleanup() {
		terminal.cleanupOnce(() -> ServerTransactionAdapter.runBestEffort(
				() -> { if (player.isUsingItem()) player.stopUsingItem(); },
				() -> {
					ItemStack carried = player.containerMenu.getCarried();
					player.containerMenu.setCarried(ItemStack.EMPTY);
					if (!carried.isEmpty()) player.getInventory().placeItemBackInInventory(carried, net.minecraft.util.Prediction.SERVER_ONLY);
				}
		));
	}

	/**
	 * How the bow allowed for drop and motion, as the archer knows it: the aim point (straight above where it expected
	 * the target), so a hand-chosen aim can start from it. With fixed aim fields, where that point's arc passes the
	 * target at its range.
	 */
	private String aimNote() {
		if (explicitAim) return fixedAimNote();
		if (lastAim == null || lastTargetPoint == null) return "";
		net.minecraft.world.phys.Vec3 lead = lastLead == null ? lastTargetPoint : lastLead;
		double ahead = lead.distanceTo(lastTargetPoint);
		return String.format(java.util.Locale.ROOT, " (aim point %.1f,%.1f,%.1f: %.1f blocks above %s for drop over %.0f blocks%s)",
				lastAim.x, lastAim.y, lastAim.z, lastAim.y - lead.y,
				ahead >= 0.5D ? "where the target's motion carries it" : "the target's visible point",
				player.getEyePosition().distanceTo(lead),
				ahead >= 0.5D ? String.format(java.util.Locale.ROOT, ", %.1f blocks ahead of it", ahead) : "");
	}

	/** Where a hand-chosen aim point's arc passes the target's visible point (moved on by its motion) at its range. */
	private String fixedAimNote() {
		net.minecraft.world.phys.Vec3 visible;
		try { visible = visibleCentre(player, target, dev.agaminggod.arenaagents.server.runtime.TargetSightline.rangedEntity(player, target)); }
		catch (AgentDomainException hidden) { return ""; }
		net.minecraft.world.phys.Vec3 eye = player.getEyePosition();
		double speed = BowBallistics.speed(Math.max(drawTicks, (int) Math.max(1L, (System.currentTimeMillis() - drawStartedAtMs) / 50L)));
		net.minecraft.world.phys.Vec3 there = BowBallistics.lead(eye, visible, observedMotion(target), speed);
		if (there == null) there = visible;
		net.minecraft.world.phys.Vec3 arc = BowBallistics.arcAt(eye, aimPoint, there, speed);
		if (arc == null) return " (your aim point's arc never reaches the target's range; without aim fields the bow solves drop and motion)";
		net.minecraft.world.phys.Vec3 offset = arc.subtract(there);
		net.minecraft.world.phys.Vec3 sight = there.subtract(eye).multiply(1.0D, 0.0D, 1.0D);
		double lateral = sight.lengthSqr() < 1.0E-6D ? 0.0D : offset.dot(new net.minecraft.world.phys.Vec3(-sight.z, 0.0D, sight.x).normalize());
		return String.format(java.util.Locale.ROOT, " (your aim point's arc reaches the target's range %.1f %s and %.1f %s of %s; without aim fields the bow solves drop and motion)",
				Math.abs(offset.y), offset.y >= 0 ? "above" : "below", Math.abs(lateral), lateral >= 0 ? "right" : "left",
				there.distanceTo(visible) >= 0.5D ? "where its motion carries it" : "its visible point");
	}

	/** Why the drawn bow is being held instead of loosed, and since when (transaction ms); null while the shot is clear. */
	private String holdCode;
	private String holdMessage;
	private long holdSinceMs;

	private void hold(String code, String message, long elapsed) {
		if (holdCode == null) holdSinceMs = elapsed;
		holdCode = code;
		holdMessage = message;
	}

	/** Says when a reflex-raised shield ended earlier draws of this shot, so the time spent is explained. */
	private String redrawNote() {
		return redraws == 0 ? "" : String.format(java.util.Locale.ROOT, "; drew again %d time%s after a reflex ended the draw", redraws, redraws == 1 ? "" : "s");
	}

	private ServerTransactionAdapter.TickResult finish(ServerTransactionAdapter.TickResult result) {
		return terminal.finish(result);
	}

	public static boolean confirmOwnedProjectile(
			int entityIdBaseline,
			Map<Integer, UUID> liveArrowOwners,
			UUID expectedOwner
	) {
		Objects.requireNonNull(liveArrowOwners, "liveArrowOwners must not be null");
		Objects.requireNonNull(expectedOwner, "expectedOwner must not be null");
		return liveArrowOwners.entrySet().stream().anyMatch(entry ->
				entry.getKey() > entityIdBaseline && expectedOwner.equals(entry.getValue()));
	}

	public static boolean canStartBowUse(boolean projectilePresent, boolean infiniteMaterials) {
		return projectilePresent || infiniteMaterials;
	}

	public record TargetFacts(
			boolean protectionAllowed,
			boolean entityInvulnerable,
			boolean creativePlayer,
			boolean spectatorPlayer,
			boolean abilitiesInvulnerable,
			boolean projectileHittable
	) {
		public static TargetFacts from(Entity target, boolean protectionAllowed) {
			Objects.requireNonNull(target, "target must not be null");
			if (target instanceof ServerPlayer playerTarget) {
				return new TargetFacts(
						protectionAllowed,
						target.isInvulnerable(),
						playerTarget.isCreative(),
						playerTarget.isSpectator(),
						playerTarget.getAbilities().invulnerable,
						target.canBeHitByProjectile()
				);
			}
			return new TargetFacts(
					protectionAllowed, target.isInvulnerable(), false, false, false, target.canBeHitByProjectile());
		}

		public boolean eligible() {
			return protectionAllowed
					&& !entityInvulnerable
					&& !creativePlayer
					&& !spectatorPlayer
					&& !abilitiesInvulnerable
					&& projectileHittable;
		}
	}

	private static Map<Integer, UUID> liveOwnedArrows(ServerPlayer player) {
		HashMap<Integer, UUID> result = new HashMap<>();
		for (AbstractArrow arrow : player.level().getEntitiesOfClass(
				AbstractArrow.class,
				player.getBoundingBox().inflate(PROJECTILE_OBSERVATION_RADIUS),
				Entity::isAlive
		)) {
			Entity owner = arrow.getOwner();
			if (owner != null) result.put(arrow.getId(), owner.getUUID());
		}
		return result;
	}

	private static AbstractArrow newestOwnedArrow(ServerPlayer player, int baseline) {
		AbstractArrow newest = null;
		for (AbstractArrow arrow : player.level().getEntitiesOfClass(AbstractArrow.class,
				player.getBoundingBox().inflate(PROJECTILE_OBSERVATION_RADIUS), Entity::isAlive)) {
			if (arrow.getId() <= baseline || arrow.getOwner() != player) continue;
			if (newest == null || arrow.getId() > newest.getId()) newest = arrow;
		}
		return newest;
	}

	/**
	 * Follows the loosed arrow the way the shooter sees it: its closest pass to the target (how far above, below, left or
	 * right), whether it struck the target or stuck in a block, and whether the target broke or flashed hurt. Only flight
	 * the shooter could see counts; the watch ends after {@link #MAX_WATCH_TICKS} ticks.
	 */
	static final class ArrowWatch {
		static final int MAX_WATCH_TICKS = 60;
		private final ServerPlayer player;
		private final AbstractArrow arrow;
		private final Entity target;
		/** The dragon behind a part (or the dragon itself): a perched one takes no arrow damage and sets arrows alight. */
		private final net.minecraft.world.entity.boss.enderdragon.EnderDragon dragon;
		private final boolean burningAtLaunch;
		private net.minecraft.world.phys.Vec3 last;
		private double best = Double.POSITIVE_INFINITY;
		private net.minecraft.world.phys.Vec3 bestPoint;
		private net.minecraft.world.phys.Vec3 bestCenter;
		private int ticks;
		final String aimNote;

		ArrowWatch(ServerPlayer player, AbstractArrow arrow, Entity target) {
			this(player, arrow, target, "");
		}

		ArrowWatch(ServerPlayer player, AbstractArrow arrow, Entity target, String aimNote) {
			this.aimNote = aimNote;
			this.player = player;
			this.arrow = arrow;
			this.target = target;
			Entity body = target instanceof net.minecraft.world.entity.boss.enderdragon.EnderDragonPart part ? part.parentMob : target;
			this.dragon = body instanceof net.minecraft.world.entity.boss.enderdragon.EnderDragon enderDragon ? enderDragon : null;
			this.burningAtLaunch = arrow.isOnFire();
			this.last = arrow.position();
		}

		/** The outcome text once the flight is over (or {@code force}), else null while the arrow still flies. */
		String tick(boolean force) {
			ticks++;
			ArrowImpactReceipt impact = (ArrowImpactReceipt) arrow;
			if (impact.arenaagents$struck(target)) return impact.arenaagents$destroyed(target)
					? "it struck the target, which broke or died" : "it struck the target";
			// Stop before reading another hidden position or outcome. Seeing an earlier flight segment
			// does not authorize following the arrow through a wall or behind the shooter's view.
			if (!ObservationVisibility.canSeeEntity(player, arrow)) return "you lost sight of it; impact not confirmed";
			boolean alive = arrow.isAlive() && !arrow.isRemoved();
			net.minecraft.world.phys.Vec3 now = alive ? arrow.position() : last;
			if (target.isAlive() && ObservationVisibility.canSeeEntity(player, target)) {
				net.minecraft.world.phys.AABB box = target.getBoundingBox();
				for (int step = 1; step <= 8; step++) {
					net.minecraft.world.phys.Vec3 point = last.lerp(now, step / 8.0D);
					double distance = Math.sqrt(box.distanceToSqr(point));
					if (distance < best) {
						best = distance;
						bestPoint = point;
						bestCenter = box.getCenter();
					}
				}
			}
			last = now;
			boolean stuck = alive && ((dev.agaminggod.arenaagents.mixin.AbstractArrowInvoker) arrow).arenaagents$isInGround();
			if (!target.isAlive() && ObservationVisibility.canSeeEntity(player, target))
				return "the target broke or died (something else did it; your arrow impact not confirmed)";
			// AbstractDragonSittingPhase.onHurt: an arrow at a perched dragon does no damage, is set alight and bounces off.
			if (dragon != null && !burningAtLaunch && arrow.isOnFire() && best <= 1.0D
					&& dragon.getPhaseManager().getCurrentPhase().isSitting()) {
				return "it struck the perched dragon and bounced off burning: a perched dragon takes no arrow damage, melee hits still count";
			}
			String other = impact.arenaagents$struckOther(target);
			if (other != null) return "it struck " + other + " in the way, not the target" + miss();
			if (!alive) return "it vanished; impact not confirmed" + miss();
			if (stuck) {
				return "missed: stuck in " + stuckBlock(arrow) + miss();
			}
			if (ticks >= MAX_WATCH_TICKS || force) return "still flying after " + ticks / 20.0D + " s" + miss();
			return null;
		}

		/** The block the arrow sticks in, as the shooter sees it: iron bars around a crystal stop every arrow. */
		private String stuckBlock(AbstractArrow arrow) {
			net.minecraft.core.BlockPos cell = arrow.blockPosition();
			var state = arrow.level().getBlockState(cell);
			if (state.getCollisionShape(arrow.level(), cell).isEmpty()) {
				// The arrow rests against the face of the neighbouring block it travelled into.
				var motion = arrow.getDeltaMovement();
				net.minecraft.core.BlockPos ahead = net.minecraft.core.BlockPos.containing(arrow.position().add(motion.normalize().scale(0.2D)));
				if (!arrow.level().getBlockState(ahead).getCollisionShape(arrow.level(), ahead).isEmpty()) cell = ahead;
				else {
					// A stuck arrow has no motion left to follow (deck c6-4 reported "air" for a spawner face): name the
					// neighbouring block whose shape it rests against.
					double nearest = 0.1D;
					for (net.minecraft.core.Direction direction : net.minecraft.core.Direction.values()) {
						net.minecraft.core.BlockPos side = cell.relative(direction);
						var shape = arrow.level().getBlockState(side).getCollisionShape(arrow.level(), side);
						if (shape.isEmpty()) continue;
						double distance = Math.sqrt(shape.bounds().move(side).distanceToSqr(arrow.position()));
						if (distance < nearest) { nearest = distance; cell = side; }
					}
				}
				state = arrow.level().getBlockState(cell);
			}
			String id = net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
			return id + " at " + cell.getX() + "," + cell.getY() + "," + cell.getZ();
		}

		private String miss() {
			if (bestPoint == null) return "";
			return describePass(player.getEyePosition(), bestPoint, bestCenter, best) + spread(player.getEyePosition().distanceTo(bestCenter), best);
		}
	}

	/**
	 * The closest pass of an arrow as the shooter sees it: distance from the target's box, and the offset from its centre
	 * above/below and left/right of the shooter's line of sight.
	 */
	static String describePass(net.minecraft.world.phys.Vec3 eye, net.minecraft.world.phys.Vec3 point, net.minecraft.world.phys.Vec3 center, double distance) {
		if (distance <= 0.05D) return "; it reached the target's body (no damage seen: deflected or immune)";
		net.minecraft.world.phys.Vec3 offset = point.subtract(center);
		net.minecraft.world.phys.Vec3 sight = center.subtract(eye).multiply(1.0D, 0.0D, 1.0D);
		double lateral = 0.0D;
		if (sight.lengthSqr() > 1.0E-6D) {
			// Minecraft's right-hand side of a view along (x, z) is (-z, x).
			net.minecraft.world.phys.Vec3 right = new net.minecraft.world.phys.Vec3(-sight.z, 0.0D, sight.x).normalize();
			lateral = offset.dot(right);
		}
		return String.format(java.util.Locale.ROOT, "; closest pass %.1f blocks from the target's box, %.1f %s and %.1f %s of its centre",
				distance, Math.abs(offset.y), offset.y >= 0 ? "above" : "below", Math.abs(lateral), lateral >= 0 ? "right" : "left");
	}

	/**
	 * Vanilla scatter at this range: every player arrow leaves up to {@link BowBallistics#SPREAD} radians off the aim on
	 * each axis, so a pass inside it says nothing about the aim.
	 */
	static String spread(double range, double pass) {
		double scatter = BowBallistics.SPREAD * range;
		return String.format(java.util.Locale.ROOT, "; arrows scatter up to %.1f blocks each way at %.0f blocks%s", scatter, range,
				pass <= scatter ? ", so this pass is within scatter" : "");
	}

	private static int globalEntityIdBaseline(ServerLevel level) {
		// Entity IDs are allocated monotonically in the Entity constructor. A never-spawned
		// sentinel therefore establishes a process-global boundary without loading chunks:
		// every entity that already exists, including an unloaded arrow, has a lower ID.
		return new ItemEntity(level, 0.0D, 0.0D, 0.0D, ItemStack.EMPTY).getId();
	}

	private static InteractionHand bowHand(ServerPlayer player) {
		if (player.getMainHandItem().getItem() instanceof BowItem) return InteractionHand.MAIN_HAND;
		if (player.getOffhandItem().getItem() instanceof BowItem) return InteractionHand.OFF_HAND;
		throw new AgentDomainException("BOW_NOT_EQUIPPED", "A bow must be held in either hand");
	}

	/**
	 * An observed target the archer has a clear line of sight to, even outside the current view: a player who saw a
	 * crystal turns back to it to shoot (live End runs 2026-10-20 lost 13 shots to TARGET_NOT_VISIBLE while turned away).
	 */
	private static Entity resolveRangedTarget(ServerPlayer player, String targetId) {
		try {
			return dev.agaminggod.arenaagents.server.runtime.ObservedEntityTarget.resolveInSight(player, targetId);
		} catch (AgentDomainException hidden) {
			// A crystal hidden by its own pillar's top from close below: say how far out it shows again.
			String why = "TARGET_NOT_VISIBLE".equals(hidden.code()) ? RangedShotCheck.hiddenByPillar(player, targetId) : "";
			if (why.isEmpty()) throw hidden;
			throw new AgentDomainException("TARGET_NOT_VISIBLE", hidden.getMessage() + ". " + why);
		}
	}
}
