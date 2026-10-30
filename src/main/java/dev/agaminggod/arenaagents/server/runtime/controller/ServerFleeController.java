package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import dev.agaminggod.arenaagents.server.perception.ThreatPerception;
import dev.agaminggod.arenaagents.server.runtime.ElapsedTimeAccumulator;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputState;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputStates;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.entity.monster.Guardian;
import net.minecraft.world.entity.monster.zombie.Drowned;
import net.minecraft.world.phys.Vec3;

/**
 * Model-chosen flee_from: sprints away from the named entity and every other hostile threat within 16 blocks
 * (proximity weighted; creepers, and swelling creepers most, push hardest) until the named entity is at least
 * the requested distance away and no longer closing in, or it lost the agent. It never reports success while
 * another threat inside that distance is still closing in or any creeper is within 7 blocks, so escaping a
 * zombie cannot end beside a creeper. Unlike navigate_to it has no destination to "arrive" at.
 * Steering re-picks a walkable heading every tick (step-ups are jumped, hazards and deep drops avoided). Deep water
 * is costed, not blocked: land headings win when one exists, and once in water the agent swims like a player (jump
 * held, sprint-swim and look up while submerged). Once clear while still swimming it ends and reports the air left
 * and the land it can see, nearest first, so the model chooses where to swim. Steering reads only terrain the player
 * has seen ({@link ObservedTerrain}). Pressing away for 2 s without covering ground excludes that heading and tries the remaining headings,
 * including backtracking. Only exhausting them ends as FLEE_BLOCKED; every result reports the net ground covered.
 */
public final class ServerFleeController implements ServerController {
	private final Entity target;
	private final String targetType;
	private final double distance;
	private final long timeoutMs;
	private final ElapsedTimeAccumulator elapsedTime;
	private final CombatPlanning.FleeProgress progress;
	private final CombatPlanning.ClosingTracker closing = new CombatPlanning.ClosingTracker();
	private final CombatInputLease input = new CombatInputLease();
	private AgentInputStates.MotorState motor;
	private Float heading;
	/** Within this of the open heading the flee is already looking that way: still refused means truly refused. */
	static final float LOOK_ALIGNED_DEGREES = 10.0F;
	/** Set when drive() refused every heading: true if only the knockback margin refused them. */
	private boolean marginBoxed;
	private final CombatStallDetector stallDetector = new CombatStallDetector();
	/** Set by drive() when pressing away has covered no ground for the stall window. */
	private CombatStallDetector.Stall stall;
	private float stallYaw;
	private float blockedYaw;
	private Vec3 startPosition;
	private long elapsedMs;
	private final List<Float> stalledHeadings = new ArrayList<>();
	private Vec3 detourOrigin;
	/**
	 * Unknown headings already looked along from here that stayed unknown (hidden behind leaves or a trunk): looking
	 * again cannot reveal them. Without this the body turned to look, turned back to walk, and turned to look again
	 * every few ticks, pinned in place for the whole flee (the turn also restarts the stall clock).
	 */
	private final List<Float> lookedHeadings = new ArrayList<>();
	private Vec3 lookOrigin;
	private double bestSeparation = Double.NaN;
	private double lastSeparation = Double.NaN;
	private final HazardEntry hazard = new HazardEntry();
	private CombatPlanning.Margin margin = CombatPlanning.Margin.NONE;

	public ServerFleeController(Entity target, double distance, long timeoutMs, long startedAt) {
		this.target = Objects.requireNonNull(target, "target must not be null");
		this.targetType = typeOf(target);
		this.distance = distance;
		this.timeoutMs = timeoutMs;
		this.elapsedTime = new ElapsedTimeAccumulator(startedAt);
		this.progress = new CombatPlanning.FleeProgress(distance);
	}

	/** Another threat sensed this tick, with the geometry the pure flee rules need. */
	private record Other(LivingEntity mob, CombatPlanning.FleeThreat threat) {
	}

	@Override
	public TickResult tick(ServerPlayer player, long nowEpochMs) {
		long elapsed = elapsedTime.advance(nowEpochMs);
		elapsedMs = elapsed;
		if (!player.isAlive()) return finish(TickResult.failed("AGENT_DEAD", "Agent player died while fleeing", 0.0D));
		if (startPosition == null) startPosition = player.position();
		String hazardCode = hazard.observe(player);
		if (hazardCode != null) {
			return finish(TickResult.failed(hazardCode, CombatMoveText.hazardStop(hazardCode, player, "flee_from") + covered(player),
					0.0D));
		}
		List<Other> others = otherThreats(player);
		List<CombatPlanning.FleeThreat> otherThreats = others.stream().map(Other::threat).toList();
		int blocker = CombatPlanning.escapeBlocker(otherThreats, distance);
		boolean targetPresent = target.isAlive() && !target.isRemoved() && target.level() == player.level();
		if (!targetPresent) {
			if (blocker < 0) {
				return finish(TickResult.failed("TARGET_GONE", targetType + " is gone; disappearance does not establish escape; last observed separation "
						+ separation(lastSeparation) + clearOf(others) + swimming(player) + covered(player), 0.0D));
			}
			// The named chaser is gone but others still close in: keep fleeing from them.
			if (!drive(player, nowEpochMs, others, false)) return blocked(player, others, -1.0D);
			return running(player, elapsed, others, blocker, 0.0D);
		}
		double current = player.distanceTo(target);
		lastSeparation = current;
		bestSeparation = Double.isNaN(bestSeparation) ? current : Math.max(bestSeparation, current);
		double fraction = Math.min(0.99D, current / distance);
		boolean hunting = target instanceof Mob mob
				? mob.getTarget() == player || mob.hasLineOfSight(player)
				: target instanceof LivingEntity living && living.hasLineOfSight(player);
		CombatPlanning.FleeProgress.Outcome outcome = progress.observe(current, hunting);
		// A creeper as the named target is held to the same blast margin as any other creeper.
		boolean creeperTooClose = target instanceof Creeper && current < CombatPlanning.CREEPER_SAFE_DISTANCE;
		if (blocker < 0 && !creeperTooClose) {
			switch (outcome) {
				case ESCAPED -> {
					return finish(TickResult.succeeded("ESCAPED", String.format(Locale.ROOT,
							"%.1f blocks from %s and it is not closing in", current, targetType) + clearOf(others) + swimming(player)
							+ covered(player)));
				}
				case LOST -> {
					return finish(TickResult.succeeded("TARGET_LOST", String.format(Locale.ROOT,
							"%s lost track of the agent at %.1f blocks", targetType, current) + clearOf(others) + swimming(player)
							+ covered(player)));
				}
				case RUNNING -> { }
			}
		}
		if (elapsed >= timeoutMs) {
			return finish(TickResult.timedOut("FLEE_TIMED_OUT", String.format(Locale.ROOT,
					"Still %.1f of %.1f blocks from %s when the flee timed out", current, distance, targetType)
					+ blockerText(others, blocker) + waterText(player) + covered(player), fraction));
		}
		if (!drive(player, nowEpochMs, others, true)) return blocked(player, others, current);
		return TickResult.running(fraction);
	}

	private TickResult running(ServerPlayer player, long elapsed, List<Other> others, int blocker, double fraction) {
		if (elapsed >= timeoutMs) {
			return finish(TickResult.timedOut("FLEE_TIMED_OUT", targetType + " is gone but the flee timed out"
					+ blockerText(others, blocker) + covered(player), fraction));
		}
		return TickResult.running(fraction);
	}

	private TickResult blocked(ServerPlayer player, List<Other> others, double current) {
		String from = current < 0.0D ? "the remaining threats" : String.format(Locale.ROOT, "%s (%.1f blocks)", targetType, current);
		return finish(TickResult.failed("FLEE_BLOCKED", "No safe direction away from " + from
				+ (marginBoxed ? "; every open heading passes lava or a damaging drop edge with a mob within 3 blocks (knockback)"
						: stalledHeadings.isEmpty() ? "; no tested heading is safe in seen terrain" : "; alternatives exhausted after physical stalls")
				+ CombatMoveText.supportFacts(player) + blockedFacts(player) + blockerText(others, CombatPlanning.escapeBlocker(
						others.stream().map(Other::threat).toList(), distance)) + covered(player),
				current < 0.0D ? 0.0D : Math.min(0.99D, current / distance)));
	}

	private String blockedFacts(ServerPlayer player) {
		ObservedTerrain world = ObservedTerrain.of(player);
		GridPosition feet = CombatMoveText.feet(player);
		StringBuilder text = new StringBuilder();
		for (BlockedHeading probe : blockedHeadings(world, feet, blockedYaw, margin)) {
			text.append(String.format(Locale.ROOT, "; yaw %.0f: ", probe.yaw()))
					.append(probe.refusal() == null ? "open footing" : CombatMoveText.refusal(player, probe.refusal()));
		}
		return text.append("; headroom ").append(CombatMoveText.headroom(player, feet)).toString();
	}

	record BlockedHeading(float yaw, CombatPlanning.Refusal refusal) { }

	static List<BlockedHeading> blockedHeadings(WalkabilityView world, GridPosition feet, float awayYaw,
			CombatPlanning.Margin margin) {
		List<BlockedHeading> probes = new ArrayList<>(3);
		for (int offset : CombatPlanning.FLEE_OFFSETS) {
			float yaw = AgentInputStates.shortestAngleDelta(0.0F, awayYaw + offset);
			probes.add(new BlockedHeading(yaw, CombatPlanning.refusal(world, feet, yaw, margin)));
		}
		return probes;
	}

	/** "; moved 8.2 m in 10.6 s" (net ground from the start), in every flee result: how much the flee actually achieved. */
	private String covered(ServerPlayer player) {
		double moved = startPosition == null ? 0.0D : CombatMoveText.horizontal(startPosition, player.getX(), player.getZ());
		return String.format(Locale.ROOT, "; moved %.1f m in %.1f s; best observed separation %s; stalled headings tried %d", moved, elapsedMs / 1000.0D, separation(bestSeparation), stalledHeadings.size());
	}

	private static String separation(double value) {
		return Double.isNaN(value) ? "unknown" : String.format(Locale.ROOT, "%.1f blocks", value);
	}

	/**
	 * "; still swimming in deep water; land seen at 12,64,-3 (4.1 m), ..." when the flee ends afloat: facts for the
	 * model's own choice of where to swim (the flee never picks a shore).
	 */
	private String swimming(ServerPlayer player) {
		String water = waterText(player);
		if (water.isEmpty()) return "";
		GridPosition feet = CombatMoveText.feet(player);
		List<GridPosition> shores = CombatPlanning.shoreCandidates(ObservedTerrain.of(player), feet,
				SwimPlanning.SURFACE_SEARCH_RADIUS + 4, 3);
		if (shores.isEmpty()) return water + "; no land seen within " + (SwimPlanning.SURFACE_SEARCH_RADIUS + 4) + " blocks";
		StringBuilder text = new StringBuilder(water).append("; land seen at ");
		for (int index = 0; index < shores.size(); index++) {
			GridPosition shore = shores.get(index);
			if (index > 0) text.append(", ");
			text.append(shore.x()).append(',').append(shore.y()).append(',').append(shore.z()).append(String.format(Locale.ROOT,
					" (%.1f m)", CombatMoveText.horizontal(player.position(), shore.x() + 0.5D, shore.z() + 0.5D)));
		}
		return text.toString();
	}

	/**
	 * Hostiles other than the named target that the flee must also get away from: sensed threats within 16 blocks
	 * (targeting the agent, its last attacker, or with sight of it) and any creeper within the 7-block blast margin.
	 * Players count only while they actively attack the agent (hurt it within 30 s).
	 */
	private List<Other> otherThreats(ServerPlayer player) {
		List<LivingEntity> mobs = player.level().getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(CombatPlanning.THREAT_RANGE),
				mob -> mob != target && mob != player && ThreatPerception.isActiveThreat(player, mob));
		List<Other> others = new ArrayList<>(mobs.size());
		Set<String> present = new HashSet<>();
		for (LivingEntity mob : mobs) {
			double away = player.distanceTo(mob);
			boolean creeper = mob instanceof Creeper;
			boolean nearCreeper = creeper && away < CombatPlanning.CREEPER_SAFE_DISTANCE;
			if (!nearCreeper && !ThreatPerception.isSensedThreat(player, mob)) continue;
			String id = mob.getUUID().toString();
			present.add(id);
			boolean swelling = creeper && ((Creeper) mob).getSwellDir() > 0;
			others.add(new Other(mob, new CombatPlanning.FleeThreat(mob.getX() - player.getX(), mob.getZ() - player.getZ(),
					away, creeper, swelling, closing.observe(id, away))));
		}
		closing.retain(present);
		return others;
	}

	/** Applies one flee tick; false when standing with no safe heading, so the model chooses (fight, pillar, block). */
	private boolean drive(ServerPlayer player, long nowEpochMs, List<Other> others, boolean includeTarget) {
		if (detourOrigin != null && CombatMoveText.horizontal(detourOrigin, player.getX(), player.getZ()) >= 1.5D) {
			stalledHeadings.clear();
			detourOrigin = null;
		}
		if (lookOrigin != null && CombatMoveText.horizontal(lookOrigin, player.getX(), player.getZ()) >= 1.5D) {
			lookedHeadings.clear();
			lookOrigin = null;
		}
		if (motor == null) motor = AgentInputStates.MotorState.initial(player.getYRot(), player.getXRot());
		List<CombatPlanning.FleeThreat> threats = new ArrayList<>(others.size() + 1);
		if (includeTarget) {
			boolean creeper = target instanceof Creeper;
			threats.add(new CombatPlanning.FleeThreat(target.getX() - player.getX(), target.getZ() - player.getZ(),
					player.distanceTo(target), creeper, creeper && ((Creeper) target).getSwellDir() > 0, true));
		}
		for (Other other : others) threats.add(other.threat());
		// Directly above or below every threat there is no "away"; keep the current heading.
		Float away = CombatPlanning.fleeAwayYaw(threats);
		float awayYaw = away == null ? motor.yaw() : away;
		blockedYaw = awayYaw;
		GridPosition feet = new GridPosition(Mth.floor(player.getX()), Mth.floor(player.getY() + 0.2D), Mth.floor(player.getZ()));
		ObservedTerrain world = ObservedTerrain.of(player);
		margin = CombatMoveText.knockbackMargin(player);
		CombatPlanning.Heading chosen = CombatPlanning.fleeHeading(world, feet, awayYaw, heading, waterPenalty(includeTarget, others), margin, stalledHeadings);
		// A better way away may only be out of sight (behind the agent, facing its chaser): turn to look first, as a
		// player turns before running. Unknown ground is assumed only to choose where to look, never to move; once
		// looked at, a heading reads as what the eye found. Meanwhile a known heading that does not close on the
		// chasers (ground just walked, say) is walked while the view turns.
		List<Float> unlooked = new ArrayList<>(stalledHeadings);
		unlooked.addAll(lookedHeadings);
		CombatPlanning.Heading look = CombatPlanning.fleeHeading(assumingLevelGround(world, feet.y()), feet, awayYaw, heading,
				waterPenalty(includeTarget, others), margin, unlooked);
		if (look.clear() && (!chosen.clear() || look.yaw() != chosen.yaw())) {
			if (Math.abs(AgentInputStates.shortestAngleDelta(motor.yaw(), look.yaw())) > LOOK_ALIGNED_DEGREES) {
				boolean walk = chosen.clear() && Math.abs(AgentInputStates.shortestAngleDelta(awayYaw, chosen.yaw())) <= 90.0F;
				turnToLook(player, look.yaw(), walk ? chosen : null, nowEpochMs);
				return true;
			}
			// Facing it and still the better way only because it is unknown: the eye cannot see it from here.
			if (lookOrigin == null) lookOrigin = player.position();
			lookedHeadings.add(look.yaw());
		}
		if (!chosen.clear()) {
			// Passing a lava or drop edge under knockback is a risk only the model may choose (control, move_to).
			marginBoxed = margin.active()
					&& CombatPlanning.fleeHeading(world, feet, awayYaw, heading, waterPenalty(includeTarget, others), CombatPlanning.Margin.NONE, stalledHeadings).clear();
			if (player.onGround() || player.isInWater()) return false;

			// Mid-jump the feet cell is ambiguous; coast without input and judge again on landing.
			input.apply(player, new AgentInputState(0.0F, 0.0F, false, false, false, false, false,
					motor.yaw(), motor.pitch(), player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			return true;
		}
		heading = chosen.yaw();
		boolean inWater = player.isInWater();
		boolean eyesInWater = player.isUnderWater();
		int food = player.getFoodData().getFoodLevel();
		// In water a player holds space (rise, stay afloat, climb out at the shore) and sprint-swims while submerged.
		boolean jump = SwimPlanning.floatJump(inWater, player.onGround(), eyesInWater)
				|| (player.onGround() && (chosen.jump() || player.horizontalCollision));
		boolean sprint = inWater ? SwimPlanning.swimSprint(true, eyesInWater, 1.0F, food) : food > 6;
		// On land, steer along the cell centres the heading was checked through, as a player keeps to a path: running the
		// raw heading off-centre let the 0.6-wide body clip a trunk or ledge in the next column and jump against it.
		float steerYaw = inWater ? chosen.yaw() : CombatPlanning.fleeSteerYaw(player.getX(), player.getZ(), feet, chosen.yaw());
		AgentInputStates.MotorStep step = AgentInputStates.stepMotor(motor,
				new AgentInputStates.MotorTarget(steerYaw, SwimPlanning.swimPitch(inWater, eyesInWater, 0.0F), true, jump, sprint),
				nowEpochMs);
		motor = step.state();
		// About to touch seen fire or lava: press against the motion, as navigation does. A sprinting flee turned beside
		// fire it had seen for a second and its momentum carried the box into the fire's cell (lui4g3, 2026-10-24).
		Vec3 motion = player.getDeltaMovement();
		boolean burn = ServerNavigationController.fireAhead(cell -> world.stateAt(new GridPosition(cell.getX(), cell.getY(), cell.getZ())),
				player.getBoundingBox(), motion);
		float[] brake = burn ? ServerNavigationController.brakeInput(motion, step.yaw()) : null;
		input.apply(player, new AgentInputState(burn ? brake[0] : step.forward(), burn ? brake[1] : step.strafe(), step.jump(), false,
				step.sprint() && !burn, false, false, step.yaw(), step.pitch(), player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
		stall = stallDetector.observe(player.getX(), player.getY(), player.getZ(),
				player.onGround() || inWater || player.onClimbable(), step.forward() > 0.0F,
				player.horizontalCollision && player.onGround(), player.verticalCollision && !player.onGround());
		stallYaw = chosen.yaw();
		if (stall != null) {
			if (detourOrigin == null) detourOrigin = player.position();
			stalledHeadings.add(stallYaw);
			stallDetector.reset();
			stall = null;
			heading = null;
			return drive(player, nowEpochMs, others, includeTarget);
		}
		return true;
	}

	/** Unknown cells read as level ground (support below the feet, open air from the feet up); known cells as known. */
	static WalkabilityView assumingLevelGround(WalkabilityView known, int feetY) {
		return new WalkabilityView() {
			@Override
			public Cell cellAt(GridPosition position) {
				Cell cell = known.cellAt(position);
				if (cell != Cell.UNLOADED) return cell;
				return position.y() < feetY ? Cell.SAFE_SUPPORT : Cell.CLEAR;
			}

			// Known lava flows count here too: a heading into one is not worth turning to look at.
			@Override
			public boolean lavaFlowsInto(GridPosition position) {
				return known.lavaFlowsInto(position);
			}
		};
	}

	/**
	 * Turns the view toward {@code yaw}, walking along {@code known} (a heading on known ground) meanwhile, or holding
	 * still (staying afloat in water) when there is none; the stall clock does not run.
	 */
	private void turnToLook(ServerPlayer player, float yaw, CombatPlanning.Heading known, long nowEpochMs) {
		boolean inWater = player.isInWater();
		boolean eyesInWater = player.isUnderWater();
		boolean walk = known != null;
		boolean jump = SwimPlanning.floatJump(inWater, player.onGround(), eyesInWater)
				|| (walk && player.onGround() && (known.jump() || player.horizontalCollision));
		boolean sprint = walk && (inWater ? SwimPlanning.swimSprint(true, eyesInWater, 1.0F, player.getFoodData().getFoodLevel())
				: player.getFoodData().getFoodLevel() > 6);
		AgentInputStates.MotorStep step = AgentInputStates.stepMotor(motor, new AgentInputStates.MotorTarget(yaw,
				SwimPlanning.swimPitch(inWater, eyesInWater, 0.0F), walk, jump, sprint, walk ? known.yaw() : Float.NaN), nowEpochMs);
		motor = step.state();
		input.apply(player, new AgentInputState(step.forward(), step.strafe(), step.jump(), false, step.sprint(), false, false,
				step.yaw(), step.pitch(), player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
		stall = null;
		stallDetector.reset();
	}

	/** Drowned and guardians out-swim a player, so water is a last resort while one is among the threats. */
	private float waterPenalty(boolean includeTarget, List<Other> others) {
		boolean aquatic = includeTarget && aquatic(target);
		for (Other other : others) aquatic |= aquatic(other.mob());
		return aquatic ? SwimPlanning.AQUATIC_THREAT_WATER_PENALTY_DEGREES : SwimPlanning.WATER_PENALTY_DEGREES;
	}

	private static boolean aquatic(Entity entity) {
		return entity instanceof Drowned || entity instanceof Guardian;
	}

	/**
	 * "; still under water with 6.5 s of air; swim input released" so a flee ending afloat tells the model it must
	 * still surface or swim: the flee holds no float input after its result.
	 */
	private static String waterText(ServerPlayer player) {
		if (!player.isInWater() || player.onGround()) return "";
		return (player.isUnderWater()
				? String.format(Locale.ROOT, "; still under water with %.1f s of air", SwimPlanning.airSecondsLeft(player.getAirSupply()))
				: "; still swimming in deep water") + "; swim input released";
	}


	/** "; also clear of 2 other threat(s), nearest minecraft:creeper at 11.4 blocks" when others are around. */
	private static String clearOf(List<Other> others) {
		if (others.isEmpty()) return "";
		Other nearest = others.get(0);
		for (Other other : others) if (other.threat().distance() < nearest.threat().distance()) nearest = other;
		return String.format(Locale.ROOT, "; also clear of %d other threat(s), nearest %s at %.1f blocks",
				others.size(), typeOf(nearest.mob()), nearest.threat().distance());
	}

	private static String blockerText(List<Other> others, int blocker) {
		if (blocker < 0) return "";
		Other other = others.get(blocker);
		CombatPlanning.FleeThreat threat = other.threat();
		String why = threat.creeper() && threat.distance() < CombatPlanning.CREEPER_SAFE_DISTANCE
				? (threat.swelling() ? "swelling creeper" : "creeper") + " within blast range" : "still closing in";
		return String.format(Locale.ROOT, "; %s %s at %.1f blocks (%s)", typeOf(other.mob()), other.mob().getUUID(),
				threat.distance(), why);
	}

	private static String typeOf(Entity entity) {
		return BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
	}

	private TickResult finish(TickResult result) {
		input.release();
		return new TickResult(result.state(), result.reasonCode(), "body idle; no further retreat performed; " + result.message(), result.progress());
	}

	@Override
	public void cancel(ServerPlayer player) {
		input.release();
	}
}
