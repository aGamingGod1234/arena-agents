package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import dev.agaminggod.arenaagents.server.perception.ObservationVisibility;
import dev.agaminggod.arenaagents.server.perception.ThreatPerception;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputRuntime;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputState;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputStates;
import dev.agaminggod.arenaagents.server.runtime.input.InputLease;
import dev.agaminggod.arenaagents.server.runtime.input.InputOwner;
import dev.agaminggod.arenaagents.server.runtime.input.LeasedServerInputController;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.BiPredicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * travel_to: one model call for a whole trip toward a known place or heading, run at body speed. The body picks a
 * standing spot it has seen up to a leg ahead toward the target ({@link TravelCheckpoints}), sprints there with the
 * ordinary navigation (every navigate_to safety rule applies to each leg), and picks the next as new terrain comes into
 * view. Where no seen leg gets closer it builds its way on in a straight line toward the target ({@link TravelBuilder}):
 * bridges a gap or lava, pillars a ledge, tunnels a wall. It stops and hands back to the model on arrival, damage, a
 * hostile coming into range, low health or food, a needed block it does not have, no way on, or the chosen block
 * coming into view; the result says where and why. The model chooses when to travel and where; this never picks a goal.
 */
public final class ServerTravelController implements ServerController {
	private static final org.slf4j.Logger LOGGER = org.slf4j.LoggerFactory.getLogger(ServerTravelController.class);
	static final boolean DEBUG = Boolean.getBoolean("arenaagents.travel.debug");
	/** Longest checkpoint leg, verified as connected by the bounded walking search. */
	static final double LEG_REACH = 48.0D;
	static final double LEG_TOLERANCE = 1.0D;
	/** How close to an intermediate checkpoint the next leg is picked, without stopping (blocks). */
	static final double LEG_HANDOFF = 3.0D;
	/** A leg that takes the body this much farther from the target than where it started is backtracking (blocks). */
	static final double BACKTRACK = 3.0D;
	static final long LEG_TIMEOUT_MS = 20_000L;
	/** Legs in a row that end no closer before the body builds its way on, and before it gives up. */
	static final int FAILED_LEGS_BEFORE_BUILD = 3;
	static final int MAX_FAILED_LEGS = 6;
	/** Progress that counts as getting closer (blocks). */
	static final double PROGRESS_STEP = 2.0D;
	/** No new closest approach for this long ends the trip as having no way on. */
	static final long STALL_MS = 60_000L;
	/** Cells marched in one straight build run before seen legs are tried again. */
	static final int BUILD_RUN = 10;
	static final double DEFAULT_TOLERANCE = 3.0D;
	public static final long DEFAULT_TIMEOUT_MS = 600_000L;
	static final float DEFAULT_MIN_HEALTH = 8.0F;
	/** Vanilla sprinting needs food above 6. */
	static final int SPRINT_FOOD = 6;
	static final double HOSTILE_RANGE = ThreatPerception.RANGE;
	/** A hostile already in range at the start stops the trip only once this close. */
	static final double HOSTILE_CLOSE = 6.0D;
	/** A mob targeting the body stops the trip from this far (a ghast aims from up to 64). */
	static final double TARGETING_RANGE = 48.0D;
	static final double SIGHT_RANGE = 96.0D;
	private static final int SIGHT_YAWS = 13, SIGHT_PITCHES = 7;
	private static final float SIGHT_YAW_SPAN = 120.0F, SIGHT_PITCH_SPAN = 60.0F;

	private enum Phase { PLAN, LOOK, LEG, BUILD, WATCH, FIGHT }

	/** Longest single fight a fightThrough trip runs before the fight itself times out (the trip's own deadline still rules). */
	static final long FIGHT_TIMEOUT_MS = 30_000L;
	/**
	 * Fight results a trip may pass once (the mob got away or out of reach); every other failed ending (the model's
	 * health floor, death, lava, fire, a dimension change) hands the trip back at once with the fight's reason.
	 */
	static final Set<String> FIGHT_PASSABLE = Set.of("TARGET_ESCAPED", "TARGET_UNREACHABLE", "APPROACH_BLOCKED", "NO_SEEN_ROUTE", "FIGHT_TIMED_OUT");
	/** Failed fights (target escaped, unreachable, timed out) a trip passes before it hands back on the next one. */
	static final int MAX_FIGHT_FAILURES = 2;

	/** The model's fightThrough:true: a hostile that closes in or hits on the route is fought (fight_target rules), then the trip goes on. */
	private boolean fightThrough;
	private ServerFightController fight;
	private UUID fightTarget;
	private String fightLabel;
	private int fightFailures;
	private final java.util.List<String> fightLog = new java.util.ArrayList<>();
	private int reflexResumes;

	private final double targetX, targetZ, targetY;
	private boolean routeLeg;
	private final double tolerance;
	private final long timeoutMs;
	private final boolean build;
	private final String stopWhenSeen;
	private final float minHealth;
	private final BiPredicate<ServerPlayer, BlockPos> mayModify;
	private final long startedAt;

	private Phase phase = Phase.PLAN;
	private ResourceKey<Level> dimension;
	private Vec3 start, lastPosition;
	private double startLeft, bestLeft = Double.POSITIVE_INFINITY, travelled;
	private long bestAt;
	private float lastHealth, startHealth;
	private int startFood;
	private final Set<UUID> knownHostiles = new HashSet<>();
	private final Set<GridPosition> refused = new HashSet<>();
	private ServerNavigationController leg;
	private TravelCheckpoints.WalkingSearch checkpointSearch;
	private GridPosition legTarget;
	private double legStartLeft;
	private boolean legFinal;
	private int legTicks;
	private int failedLegs, legs, looks, bridged, pillared, tunnelled, ticks;
	private double legAllowedBacktrack = BACKTRACK;
	private String lastLegFailure, buildRefusal, buildRefusalCode;
	private float lookYaw, lookPitch;
	private boolean glanced;
	private int lookTicks;
	// Build moves.
	private TravelBuilder.Plan move;
	private Direction buildDirection;
	private int buildRun, moveTicks, moveStage, pillarDone;
	private BlockHitResult bridgeAttachment;
	private float bridgeViewYaw, bridgeViewPitch;
	private boolean centred, stepSneak;
	private int stepSpan = 1;
	private int tunnelWatch, tunnelReach;
	private final Set<GridPosition> tunnelDug = new HashSet<>();
	private GridPosition retreatFrom;
	/** The standing cells walked, oldest first, for backing out the way the body came (a march turns; a tunnel bends). */
	private final java.util.ArrayDeque<GridPosition> trail = new java.util.ArrayDeque<>();
	static final int TRAIL_CELLS = 48;
	private String retreatCode, retreatWhy;
	private int retreats, watchTicks;
	static final int MAX_RETREATS = 4, RETREAT_WATCH_TICKS = 60, RETREAT_CELLS = 8;
	static final double RETREAT_TOLERANCE = 0.5D;
	/** Ticks spent looking into a freshly opened tunnel cell before judging it (a Nether lava spread step is 10). */
	static final int TUNNEL_WATCH_TICKS = 12;
	private TravelBuilder.Kind lastKind;
	/** How close to the cell's middle the body stands before a build move (blocks). */
	static final double CENTRED = 0.12D;
	/** A level step starting within this of its line's centre walks without sneaking (blocks). */
	static final double STEP_LINE = 0.15D;
	private GridPosition moveFeet;
	private InputLease lease;
	private LeasedServerInputController input;
	private AgentInputStates.MotorState motor;

	public ServerTravelController(double targetX, double targetY, double targetZ, double tolerance, long timeoutMs,
			boolean build, String stopWhenSeen, Float minHealth, BiPredicate<ServerPlayer, BlockPos> mayModify, long startedAt) {
		if (!Double.isFinite(targetX) || !Double.isFinite(targetZ) || Double.isInfinite(targetY)) throw new IllegalArgumentException("travel target must be finite");
		if (!(tolerance >= 1.0D) || timeoutMs <= 0L) throw new IllegalArgumentException("invalid travel tolerance or timeout");
		this.targetX = targetX;
		this.targetY = targetY;
		this.targetZ = targetZ;
		this.tolerance = tolerance;
		this.timeoutMs = timeoutMs;
		this.build = build;
		this.stopWhenSeen = stopWhenSeen;
		this.minHealth = minHealth == null ? DEFAULT_MIN_HEALTH : minHealth;
		this.mayModify = Objects.requireNonNull(mayModify, "mayModify must not be null");
		this.startedAt = startedAt;
	}

	/** A remembered route leg needs its actual height, including a shaft's next standing level. */
 ServerTravelController routeLeg() { this.routeLeg=true; return this; }

	/** The model chose to fight hostiles on the route instead of stopping for them. */
	public ServerTravelController fightThrough(boolean enabled) {
		this.fightThrough = enabled;
		return this;
	}
 private double heightTolerance() {return routeLeg ? 0.6D : Math.max(3.0D,tolerance);}

 /** The target for a heading: {@code distance} blocks along {@code yaw} (Minecraft degrees) from the body. */
	public static double[] headingTarget(Vec3 from, double yaw, double distance) {
		double radians = Math.toRadians(yaw);
		return new double[] {from.x - Math.sin(radians) * distance, from.z + Math.cos(radians) * distance};
	}

	@Override
	public TickResult tick(ServerPlayer player, long nowEpochMs) {
		if (start == null) begin(player, nowEpochMs);
		ticks++;
		if (!player.isAlive()) return fail(player, "AGENT_DEAD", "Agent player died");
		if (!ServerNavigationController.remainsInDimension(dimension, player.level().dimension())) return fail(player, "ACTION_DIMENSION_CHANGED", "Agent player changed dimension during travel");
		if (player.isPassenger() || player.isFallFlying()) return fail(player, "UNSUPPORTED_NAVIGATION_MODE", "Mounted travel and gliding require player control inputs");
		Vec3 position = player.position();
		travelled += Math.hypot(position.x - lastPosition.x, position.z - lastPosition.z);
		lastPosition = position;
		if (player.onGround() && retreatCode == null) {
			GridPosition at = feet(player);
			if (!at.equals(trail.peekLast())) {
				trail.addLast(at);
				if (trail.size() > TRAIL_CELLS) trail.removeFirst();
			}
		}
		if (phase == Phase.FIGHT) return fightTick(player, nowEpochMs);
		double left = left(position);
		if (left < bestLeft - PROGRESS_STEP || bestLeft == Double.POSITIVE_INFINITY) { bestLeft = left; bestAt = nowEpochMs; }
		if (arrived(player)) return finish(player, ServerController.State.SUCCEEDED, "ARRIVED", "Arrived within " + format(tolerance) + " blocks of the target");
		TickResult stop = stopCheck(player, nowEpochMs);
		if (stop != null) return stop;
		if (nowEpochMs - startedAt >= timeoutMs) return finish(player, ServerController.State.TIMED_OUT, "TRAVEL_TIMEOUT", "The trip's timeoutMs ran out before arrival");
		if (nowEpochMs - bestAt >= STALL_MS) return fail(player, buildRefusal == null ? "NO_ROUTE" : buildRefusalCode, "No closer to the target for " + STALL_MS / 1000 + " s"
				+ (buildRefusal == null ? "" : "; building cannot continue: " + buildRefusal) + lastFailureText());
		TickResult lava = lavaGuard(player, nowEpochMs);
		if (lava != null) return lava;
		return switch (phase) {
			case PLAN -> plan(player, nowEpochMs);
			case LOOK -> look(player, nowEpochMs);
			case LEG -> leg(player, nowEpochMs);
			case BUILD -> buildTick(player, nowEpochMs);
			case WATCH -> watchTick(player, nowEpochMs);
			case FIGHT -> fightTick(player, nowEpochMs);
		};
	}

	private void begin(ServerPlayer player, long nowEpochMs) {
		start = player.position();
		lastPosition = start;
		dimension = player.level().dimension();
		startLeft = Math.max(1.0E-3D, left(start));
		bestAt = nowEpochMs;
		lastHealth = startHealth = player.getHealth();
		startFood = player.getFoodData().getFoodLevel();
		for (Mob mob : hostiles(player)) knownHostiles.add(mob.getUUID());
	}

	/**
	 * Distance still to go: horizontal, plus the height past the arrival band when a y was given, so a target below the
	 * body (a cave floor, lava seen down a cave) counts the descent toward it as progress.
	 */
	private double left(Vec3 position) {
		return TravelCheckpoints.left(position.x, position.y, position.z, targetX, targetY, targetZ, heightTolerance());
	}

	private boolean arrived(ServerPlayer player) {
		if (left(player.position()) > tolerance) return false;
		if (Double.isFinite(targetY) && Math.abs(player.getY() - targetY) > heightTolerance()) return false;
		return player.onGround() || player.isInWater();
	}

	/** Everything that hands the trip back to the model before arrival. */
	private TickResult stopCheck(ServerPlayer player, long nowEpochMs) {
		float health = player.getHealth();
		if (health < lastHealth - 1.0E-3F) {
			var source = player.getLastDamageSource();
			String cause = source == null ? "unknown" : source.getMsgId()
					+ (source.getEntity() == null ? "" : " from " + BuiltInRegistries.ENTITY_TYPE.getKey(source.getEntity().getType()));
			if (fightThrough && health > minHealth && source != null && source.getEntity() instanceof Mob attacker && attacker.isAlive()
					&& attacker.distanceTo(player) <= HOSTILE_RANGE) {
				return engage(player, attacker, String.format(Locale.ROOT, "hit you for %.1f (%s)", lastHealth - health, cause), nowEpochMs);
			}
			return fail(player, "TRAVEL_DAMAGED", String.format(Locale.ROOT, "Took %.1f damage (%s); health %.1f", lastHealth - health, cause, health));
		}
		lastHealth = health;
		if (health <= minHealth && startHealth > minHealth) return fail(player, "LOW_HEALTH", "Health fell to " + format(health) + " (minHealth " + format(minHealth) + ")");
		int food = player.getFoodData().getFoodLevel();
		if (food <= SPRINT_FOOD && startFood > SPRINT_FOOD) return fail(player, "LOW_FOOD", "Food fell to " + food + "; sprinting needs more than " + SPRINT_FOOD);
		if (ticks % 5 == 0) {
			for (Mob mob : hostiles(player)) {
				double distance = mob.distanceTo(player);
				boolean targeting = mob.getTarget() == player;
				boolean known = knownHostiles.contains(mob.getUUID());
				// One the model already had in view when it chose to travel stops the trip only up close (or by a hit).
				if (known && distance > HOSTILE_CLOSE) continue;
				if (fightThrough) {
					// Fought once it closes in or hits; until then it is only in view, as for one seen at the start.
					if (distance > HOSTILE_CLOSE) { knownHostiles.add(mob.getUUID()); continue; }
					return engage(player, mob, String.format(Locale.ROOT, "%.1f blocks away%s", distance, targeting ? ", targeting you" : ""), nowEpochMs);
				}
				return fail(player, "HOSTILE_NEAR", String.format(Locale.ROOT, "%s %s %.1f blocks away at %.1f,%.1f,%.1f%s",
						BuiltInRegistries.ENTITY_TYPE.getKey(mob.getType()), mob.getUUID(), distance, mob.getX(), mob.getY(), mob.getZ(),
						targeting ? ", targeting you" : ""));
			}
		}
		if (stopWhenSeen != null && ticks % 20 == 0) {
			BlockPos seen = sees(player, stopWhenSeen);
			if (seen != null) return finish(player, ServerController.State.SUCCEEDED, "TARGET_SEEN", String.format(Locale.ROOT,
					"%s seen at %d,%d,%d, %.0f blocks away", stopWhenSeen, seen.getX(), seen.getY(), seen.getZ(), Math.sqrt(seen.distToCenterSqr(player.getEyePosition()))));
		}
		return null;
	}

	/** Visible hostiles in range and mobs targeting the body from further (see {@link ThreatPerception#isHostileTo}). */
	private static java.util.List<Mob> hostiles(ServerPlayer player) {
		AABB box = player.getBoundingBox().inflate(TARGETING_RANGE);
		return player.level().getEntitiesOfClass(Mob.class, box, mob -> mob.isAlive()
				&& ThreatPerception.isHostileTo(mob, player)
				&& (mob.distanceTo(player) <= HOSTILE_RANGE || mob.getTarget() == player)
				&& ObservationVisibility.canSeeEntity(player, mob));
	}

	/**
	 * The open cells above the block tops the eye's sight lines land on, toward the target: what a player looking that
	 * way picks as the next spot. Only candidates; each still has to be a seen standing cell (the planner's own rule).
	 */
	List<GridPosition> sightedSpots(ServerPlayer player) {
		Vec3 eye = player.getEyePosition();
		float bearing = (float) Math.toDegrees(Math.atan2(-(targetX - player.getX()), targetZ - player.getZ()));
		java.util.LinkedHashSet<GridPosition> spots = new java.util.LinkedHashSet<>();
		for (float yaw = -SPOT_YAW_SPAN; yaw <= SPOT_YAW_SPAN; yaw += SPOT_YAW_STEP) {
			for (float pitch = -10.0F; pitch <= 60.0F; pitch += SPOT_PITCH_STEP) {
				Vec3 direction = Vec3.directionFromRotation(pitch, bearing + yaw);
				BlockHitResult hit = player.level().clip(new ClipContext(eye, eye.add(direction.scale(LEG_REACH + 4.0D)),
						ClipContext.Block.VISUAL, ClipContext.Fluid.ANY, player));
				if (hit.getType() != HitResult.Type.BLOCK || hit.getDirection() != Direction.UP) continue;
				BlockPos top = hit.getBlockPos().above();
				spots.add(new GridPosition(top.getX(), top.getY(), top.getZ()));
			}
		}
		return List.copyOf(spots);
	}

	static final float SPOT_YAW_SPAN = 66.0F, SPOT_YAW_STEP = 6.0F, SPOT_PITCH_STEP = 5.0F;

	/** A block of the named kind the eye sees now: a fan of sight lines across the view (lava stops them). */
	static BlockPos sees(ServerPlayer player, String blockId) {
		Vec3 eye = player.getEyePosition();
		for (int yawStep = 0; yawStep < SIGHT_YAWS; yawStep++) {
			float yaw = player.getYRot() - SIGHT_YAW_SPAN / 2.0F + SIGHT_YAW_SPAN * yawStep / (SIGHT_YAWS - 1);
			for (int pitchStep = 0; pitchStep < SIGHT_PITCHES; pitchStep++) {
				float pitch = net.minecraft.util.Mth.clamp(player.getXRot() - SIGHT_PITCH_SPAN / 2.0F + SIGHT_PITCH_SPAN * pitchStep / (SIGHT_PITCHES - 1), -90.0F, 90.0F);
				Vec3 direction = Vec3.directionFromRotation(pitch, yaw);
				BlockHitResult hit = player.level().clip(new ClipContext(eye, eye.add(direction.scale(SIGHT_RANGE)),
						ClipContext.Block.VISUAL, ClipContext.Fluid.ANY, player));
				if (hit.getType() != HitResult.Type.BLOCK) continue;
				BlockState state = player.level().getBlockState(hit.getBlockPos());
				if (BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString().equals(blockId)) return hit.getBlockPos();
			}
		}
		return null;
	}

	private TickResult plan(ServerPlayer player, long nowEpochMs) {
		if (onMagma(player)) apply(player, new AgentInputStates.MotorTarget(player.getYRot(), player.getXRot(), false, false, false), true, false, false, nowEpochMs);
		else releaseInput();
		if (!player.onGround() && !player.isInWater()) return TickResult.running(progress(player));
		MinecraftNavigationWorld world = new MinecraftNavigationWorld(player.level(), player);
  // The ordinary checkpoint picker accepts a height band; it would keep choosing this shaft's own floor forever.
  if(routeLeg && Double.isFinite(targetY) && targetY>player.getY()+0.6D && Math.hypot(targetX-player.getX(),targetZ-player.getZ())<0.8D) {
   if(!build) return fail(player,"NO_ROUTE","This remembered shaft needs blocks to pillar up; build is false");
   return startBuild(player,world,nowEpochMs);
  }
  if (failedLegs >= MAX_FAILED_LEGS) return fail(player, buildRefusal == null ? "NO_ROUTE" : buildRefusalCode, "No seen leg gets closer"
				+ (buildRefusal == null ? "" : ", and building cannot continue: " + buildRefusal) + lastFailureText());
		boolean buildNow = build && failedLegs >= FAILED_LEGS_BEFORE_BUILD && buildRefusal == null;
		long pickStarted = System.nanoTime();
		TravelCheckpoints.Checkpoint next = null;
		if (buildNow || onMagma(player)) checkpointSearch = null;
		else {
			if (checkpointSearch != null && !checkpointSearch.origin.equals(feet(player))) checkpointSearch = null;
			if (checkpointSearch == null) checkpointSearch = TravelCheckpoints.beginWalkingPick(world, player.getX(), player.getY(), player.getZ(),
					targetX, targetY, targetZ, LEG_REACH, this::isRefused, sightedSpots(player));
			if (checkpointSearch != null) {
				next = checkpointSearch.advance(world);
				if (!checkpointSearch.finished()) return TickResult.running(progress(player));
				checkpointSearch = null;
			}
		}
		if (DEBUG) LOGGER.info("TRAVEL_PICK at={} left={} next={} failedLegs={} refused={} looks={} pickMs={}", cell(feet(player)),
				format(left(player.position())), next == null ? "-" : cell(next.feet()) + " left " + format(next.left()), failedLegs, refused.size(), looks,
				format((System.nanoTime() - pickStarted) / 1.0E6D) + " columns=" + java.util.Arrays.toString(TravelCheckpoints.LAST_PICK.get()));
		if (next != null) {
			legFinal = next.finalApproach();
			startLeg(player, next.feet(), nowEpochMs);
			legAllowedBacktrack += next.backtrack();
			return leg(player, nowEpochMs);
		}
		// Nothing seen gets closer: look along the bearing and either side before building (a player glances round).
		float bearing = (float) Math.toDegrees(Math.atan2(-(targetX - player.getX()), targetZ - player.getZ()));
		if (looks < 3 && !buildNow) {
			lookYaw = bearing + (looks == 0 ? 0.0F : looks == 1 ? 50.0F : -50.0F);
			looks++;
			lookTicks = 0;
			phase = Phase.LOOK;
			return look(player, nowEpochMs);
		}
		if (!onMagma(player) && failedLegs < MAX_FAILED_LEGS && (buildRefusal != null || !build)) {
			GridPosition detour = TravelCheckpoints.detour(world, player.getX(), player.getY(), player.getZ(), targetX, targetZ, this::isRefused);
			if (detour != null) {
				refused.add(detour);
				legFinal = false;
				startLeg(player, detour, nowEpochMs);
				return leg(player, nowEpochMs);
			}
		}
		if (!build) return fail(player, "NO_ROUTE", "No seen standing spot ahead gets closer, and build is false" + lastFailureText());
		if (buildRefusal != null) return fail(player, buildRefusalCode, "No seen way on toward the target, and building cannot continue: " + buildRefusal + lastFailureText());
		return startBuild(player, world, nowEpochMs);
	}

	private TickResult look(ServerPlayer player, long nowEpochMs) {
		lookTicks++;
		// Check nearby uphill footing before committing to a tunnel through the slope.
		float pitch = glanced ? lookPitch : looks == 1 ? -20.0F : ServerNavigationController.WALKING_GAZE_PITCH + 5.0F;
		apply(player, new AgentInputStates.MotorTarget(lookYaw, pitch, false, false, false), true, false, false, nowEpochMs);
		boolean settled = Math.abs(AgentInputStates.shortestAngleDelta(player.getYRot(), lookYaw)) < 3.0F
				&& Math.abs(player.getXRot() - pitch) < 3.0F;
		if (settled || lookTicks > 20) {
			if (glanced) return startBuild(player, new MinecraftNavigationWorld(player.level(), player), nowEpochMs);
			phase = Phase.PLAN;
		}
		return TickResult.running(progress(player));
	}

	private void startLeg(ServerPlayer player, GridPosition feet, long nowEpochMs) {
		startLeg(player, feet, nowEpochMs, LEG_TOLERANCE);
	}

	private void startLeg(ServerPlayer player, GridPosition feet, long nowEpochMs, double tolerance) {
		releaseInput();
		legTarget = feet;
		legTicks = 0;
		legStartLeft = left(player.position());
		legAllowedBacktrack = BACKTRACK;
		leg = new ServerNavigationController(new Vec3(feet.x() + 0.5D, feet.y(), feet.z() + 0.5D), tolerance, true,
				nowEpochMs, LEG_TIMEOUT_MS, true);
		phase = Phase.LEG;
	}

	private TickResult leg(ServerPlayer player, long nowEpochMs) {
		TickResult result = leg.tick(player, nowEpochMs);
		legTicks++;
		if (result.state() == ServerController.State.RUNNING) {
			// Near a checkpoint on the way, pick the next one while still running, as a player does: a leg's own arrival
			// stops the body and waits for it to stand still before the next leg could start.
			double dx = legTarget.x() + 0.5D - player.getX(), dz = legTarget.z() + 0.5D - player.getZ();
			if (!legFinal && legTicks >= 10 && player.onGround() && leg.walking() && dx * dx + dz * dz <= LEG_HANDOFF * LEG_HANDOFF
					&& Math.abs(player.getY() - legTarget.y()) <= 1.0D
					&& legStartLeft - left(player.position()) >= PROGRESS_STEP) {
				leg.cancel(player);
				leg = null;
				legs++;
				failedLegs = 0;
				looks = 0;
				buildRefusal = null;
				phase = Phase.PLAN;
				if (DEBUG) LOGGER.info("TRAVEL_HANDOFF at={} near={}", cell(feet(player)), cell(legTarget));
				return plan(player, nowEpochMs);
			}
			if (retreatCode == null && legStartLeft - left(player.position()) < -legAllowedBacktrack && player.onGround()) {
				// A verified route may initially go around a cliff. Only cancel beyond its known maximum retreat
				// plus the normal margin; a fixed three-block cap repeatedly cancelled these valid routes.
				leg.cancel(player);
				leg = null;
				legs++;
				failedLegs++;
				refused.add(legTarget);
				lastLegFailure = "backtracking toward " + cell(legTarget);
				if (DEBUG) LOGGER.info("TRAVEL_BACKTRACK at={} to={}", cell(feet(player)), cell(legTarget));
				phase = Phase.PLAN;
				return TickResult.running(progress(player));
			}
			return TickResult.running(progress(player));
		}
		leg = null;
		legs++;
		if (retreatCode != null) return startWatch(player);
		String code = result.reasonCode();
		switch (code) {
			case "AGENT_DEAD", "ACTION_DIMENSION_CHANGED", "UNSUPPORTED_NAVIGATION_MODE" -> { return fail(player, code, result.message()); }
			case "DISPLACED", "NAVIGATION_DAMAGED", "BREATH_LOW", "SURFACE_NOT_FOUND" -> { return fail(player, code, "Leg to " + cell(legTarget) + " stopped: " + result.message()); }
			default -> { }
		}
		double gained = legStartLeft - left(player.position());
		if (DEBUG) LOGGER.info("TRAVEL_LEG to={} result={} {} gained={} msg={}", cell(legTarget), result.state(), code, format(gained), firstClause(result.message()));
		if (result.state() == ServerController.State.SUCCEEDED || gained >= PROGRESS_STEP) {
			failedLegs = 0;
			looks = 0;
			buildRefusal = null;
			if (result.state() != ServerController.State.SUCCEEDED) refused.add(legTarget);
		} else {
			failedLegs++;
			refused.add(legTarget);
			lastLegFailure = code + " toward " + cell(legTarget) + ": " + firstClause(result.message());
		}
		phase = Phase.PLAN;
		return TickResult.running(progress(player));
	}

	private boolean isRefused(GridPosition cell) {
		for (GridPosition refusal : refused) {
			if (Math.abs(refusal.x() - cell.x()) <= 1 && Math.abs(refusal.z() - cell.z()) <= 1 && Math.abs(refusal.y() - cell.y()) <= 2) return true;
		}
		return false;
	}

	// ---- Building -------------------------------------------------------------------------------------------------

	private TickResult startBuild(ServerPlayer player, MinecraftNavigationWorld world, long nowEpochMs) {
		GridPosition feet = feet(player);
		boolean haveBlocks = TravelBuilder.blockSlot(player) >= 0;
		int climb = Double.isFinite(targetY) ? (int) Math.floor(targetY) - feet.y() : 0;
		TravelBuilder.Plan best = null, firstRefusal = null;
		boolean shaft = routeLeg && climb>0 && Math.hypot(targetX-player.getX(),targetZ-player.getZ())<0.8D;
  if(shaft) {
   if(!glanced) {
    glanced=true;lookYaw=player.getYRot();lookPitch=-90;lookTicks=0;phase=Phase.LOOK;
    return look(player,nowEpochMs);
   }
   if(!world.isBodyClear(feet.above(2))) return fail(player,"NO_ROUTE","Remembered shaft has blocked or unseen headroom above; no new tunnel chosen");
   if(!haveBlocks) return fail(player,"OUT_OF_BLOCKS","Remembered shaft needs a plain carried block per level to pillar up"+offHotbarText(player));
   best=new TravelBuilder.Plan(TravelBuilder.Kind.PILLAR,Direction.NORTH,1,null,null);
  }
  for (Direction direction : shaft ? new Direction[0] : directionsToward(player)) {
			TravelBuilder.Plan plan = TravelBuilder.decide(world, states(world), feet, direction, haveBlocks, climb);
			if (plan.possible() && plan.kind() == TravelBuilder.Kind.TUNNEL) {
				String why = tunnelRefusal(player, world, feet, direction);
				if (why != null) plan = TravelBuilder.Plan.refuse(direction, "cannot-tunnel", why);
			}
			if (plan.possible()) { best = plan; break; }
			if (!plan.possible() && firstRefusal == null) firstRefusal = plan;
		}
		if (best == null && firstRefusal != null && "unseen".equals(firstRefusal.refusalCode()) && !glanced) {
			// Look down at the cells ahead before judging them, as a player glances at the ground before stepping on.
			glanced = true;
			lookYaw = TravelBuilder.yaw(firstRefusal.direction());
			lookPitch = 40.0F;
			lookTicks = 0;
			phase = Phase.LOOK;
			return look(player, nowEpochMs);
		}
		glanced = false;
		if (best == null) {
			// Building is blocked here: other seen legs may still lead on, so try those before stopping.
			buildRefusalCode = firstRefusal != null && "out-of-blocks".equals(firstRefusal.refusalCode()) ? "OUT_OF_BLOCKS" : "NO_ROUTE";
			buildRefusal = (firstRefusal == null ? "no direction toward the target can be walked or built" : firstRefusal.refusal())
					+ ("OUT_OF_BLOCKS".equals(buildRefusalCode) ? offHotbarText(player) : "");
			if (DEBUG) LOGGER.info("TRAVEL_BUILD_REFUSED at={} {}", cell(feet), buildRefusal);
			phase = Phase.PLAN;
			return TickResult.running(progress(player));
		}
		if (DEBUG) LOGGER.info("TRAVEL_BUILD at={} plan={} {} count={}", cell(feet), best.kind(), best.direction(), best.count());
		move = best;
		buildDirection = best.direction();
		moveFeet = feet;
		moveTicks = 0;
		moveStage = 0;
		pillarDone = 0;
		centred = false;
		phase = Phase.BUILD;
		return buildTick(player, nowEpochMs);
	}

	/** The two horizontal directions closest to the bearing to the target, nearest first (the second within 90 degrees). */
	private Direction[] directionsToward(ServerPlayer player) {
		double dx = targetX - player.getX(), dz = targetZ - player.getZ();
		Direction first = Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? Direction.EAST : Direction.WEST) : (dz >= 0 ? Direction.SOUTH : Direction.NORTH);
		Direction second = Math.abs(dx) >= Math.abs(dz) ? (dz >= 0 ? Direction.SOUTH : Direction.NORTH) : (dx >= 0 ? Direction.EAST : Direction.WEST);
		return new Direction[] {first, second};
	}

	private String tunnelRefusal(ServerPlayer player, MinecraftNavigationWorld world, GridPosition feet, Direction direction) {
		BlockPos body = new BlockPos(feet.x() + direction.getStepX(), feet.y(), feet.z() + direction.getStepZ());
		for (BlockPos cell : new BlockPos[] {body.above(), body}) {
			BlockState state = player.level().getBlockState(cell);
			if (state.isAir() || state.getCollisionShape(player.level(), cell).isEmpty()) continue;
			BlockState known = world.stateAt(cell);
			if (known == null) return "the wall at " + cell(cell) + " is unseen";
			String why = TravelBuilder.unmineable(known);
			if (why != null) return "the wall at " + cell(cell) + " cannot be mined: " + why;
			if (TravelBuilder.seenLavaBeside(world, cell)) return "seen lava is beside " + cell(cell) + ", so opening it lets the lava in";
			if (!mayModify.test(player, cell)) return "the block at " + cell(cell) + " is protected";
			double[] ticks = TravelBuilder.mineTicks(player, known, known.getDestroySpeed(player.level(), cell));
			if (ticks[1] > TravelBuilder.maximumTunnelMineTicks(known)) {
				// Tunnelling by hand crawled at 6 s a cell while two pickaxes sat in the main inventory (course run, 2026-10-24).
				return String.format(Locale.ROOT, "%s at %s takes %.1f s per block with the inventory's best tool%s",
						BuiltInRegistries.BLOCK.getKey(known.getBlock()), cell(cell), ticks[1] / 20.0D,
						ticks[1] <= TravelBuilder.maximumTunnelMineTicks(known) ? "; a better tool is in the main inventory (select_tool moves it)" : "");
			}
		}
		return null;
	}

	private TickResult buildTick(ServerPlayer player, long nowEpochMs) {
		moveTicks++;
		TravelBuilder.Plan plan = move;
		// Bridging, filling and pillaring stand in the middle first; mining and putting out fire aim from anywhere in reach.
		boolean needsCentre = plan.kind() == TravelBuilder.Kind.BRIDGE || plan.kind() == TravelBuilder.Kind.FILL || plan.kind() == TravelBuilder.Kind.PILLAR;
		if (needsCentre && moveStage == 0 && !centred) {
			// Stand in the middle of the cell first, as a player lines up before bridging or pillaring: off-centre, the
			// body caught on a neighbouring column and never reached the edge (smoke run 2026-10-24).
			double dx = moveFeet.x() + 0.5D - player.getX(), dz = moveFeet.z() + 0.5D - player.getZ();
			if (dx * dx + dz * dz <= CENTRED * CENTRED && player.onGround()) {
				centred = true;
				moveTicks = 0;
			} else if (moveTicks > 40) {
				centred = true;
				moveTicks = 0;
			} else {
				apply(player, new AgentInputStates.MotorTarget(player.getYRot(), player.getXRot(), true, false, false,
						(float) Math.toDegrees(Math.atan2(-dx, dz))), true, false, false, nowEpochMs);
				return TickResult.running(progress(player));
			}
		}
		TickResult result = switch (plan.kind()) {
			case STEP, CROSS -> stepTick(player, plan.direction(), nowEpochMs);
			case BRIDGE -> bridgeTick(player, plan.direction(), nowEpochMs);
			case FILL -> fillTick(player, plan.direction(), nowEpochMs);
			case PILLAR -> pillarTick(player, nowEpochMs);
			case TUNNEL -> tunnelTick(player, plan.direction(), nowEpochMs);
			case CLEAR_UP -> clearUpTick(player, nowEpochMs);
			case EXTINGUISH -> extinguishTick(player, plan.direction(), nowEpochMs);
		};
		if (result != null) return result;
		return TickResult.running(progress(player));
	}

	/** After a move: march on in the same line while the run lasts, then try seen legs again. */
	private TickResult moveDone(ServerPlayer player, long nowEpochMs) {
		if (retreatCode != null) return startWatch(player);
		// The keys stay held between chained moves: releasing them for a tick lifts the crouch at an edge.
		buildRun += marchedCells(moveFeet, feet(player));
		lastKind = move == null ? null : move.kind();
		move = null;
		if (!routeLeg && buildRun < BUILD_RUN) {
			MinecraftNavigationWorld world = new MinecraftNavigationWorld(player.level(), player);
			TravelBuilder.Plan next = TravelBuilder.decide(world, states(world), feet(player), buildDirection, TravelBuilder.blockSlot(player) >= 0,
					Double.isFinite(targetY) ? (int) Math.floor(targetY) - feet(player).y() : 0);
			if (next.possible() && next.kind() == TravelBuilder.Kind.TUNNEL && tunnelRefusal(player, world, feet(player), buildDirection) != null) next = null;
			if (DEBUG) LOGGER.info("TRAVEL_BUILD_NEXT at={} plan={} {}", cell(feet(player)), next == null ? "-" : next.kind(), next == null ? "" : next.possible() ? next.direction() : next.refusal());
			if (next != null && !next.possible() && "unseen".equals(next.refusalCode()) && !glanced) {
				// Bridging faces backwards: look ahead along the line before judging the next cell.
				glanced = true;
				lookYaw = TravelBuilder.yaw(buildDirection);
				lookPitch = 40.0F;
				lookTicks = 0;
				phase = Phase.LOOK;
				return null;
			}
			if (next != null && next.possible()) {
				// A bridge chained on in the same line is already on its centreline.
				boolean chained = next.kind() == TravelBuilder.Kind.BRIDGE && move == null && lastKind == TravelBuilder.Kind.BRIDGE;
				move = next;
				moveFeet = feet(player);
				moveTicks = 0;
				moveStage = 0;
				pillarDone = 0;
				centred = chained;
				return null;
			}
		}
		// Replanning must keep crouch held while magma still touches the feet. Releasing it for even
		// one tick dealt hotFloor damage every tenth construction step and ended otherwise valid trips.
		if (onMagma(player)) apply(player, new AgentInputStates.MotorTarget(player.getYRot(), player.getXRot(), false, false, false), true, false, false, nowEpochMs);
		else releaseInput();
		buildRun = 0;
		buildDirection = null;
		failedLegs = 0;
		// Looks are not repeated after a build run: where nothing seen got closer before, the march itself shows more.
		// Refused legs stay refused: a leg back to where the march began was picked again after every run.
		buildRefusal = null;
		phase = Phase.PLAN;
		return null;
	}

	private TickResult moveFailed(ServerPlayer player, String why) {
		releaseInput();
		if (DEBUG) LOGGER.info("TRAVEL_MOVE_FAILED {}", why);
		buildRefusalCode = "BUILD_FAILED";
		buildRefusal = why;
		failedLegs++;
		looks = 0;
		phase = Phase.PLAN;
		return TickResult.running(progress(player));
	}

	/**
	 * When seen lava will flow into the body's own cell next, step out of its way at once (the way the body came if
	 * that is clear) and hand the trip back; the navigation refuses to step into such a cell, but a body already standing
	 * still where a flow is arriving (a tunnel just opened into hidden lava) needs to leave it.
	 */
	private TickResult lavaGuard(ServerPlayer player, long nowEpochMs) {
		if (retreatCode != null && phase != Phase.WATCH || !player.onGround()) return null;
		MinecraftNavigationWorld world = new MinecraftNavigationWorld(player.level(), player);
		GridPosition here = feet(player);
		if (!world.lavaFillsNext(here)) return null;
		if (leg != null) { leg.cancel(player); leg = null; }
		if (retreatCode != null) {
			// Still coming after a retreat: back off again, a few times at most.
			if (++retreats > MAX_RETREATS) return fail(player, retreatCode, retreatWhy + "; the lava kept coming after " + MAX_RETREATS + " retreats");
			return retreat(player, nowEpochMs, retreatCode, retreatWhy);
		}
		return retreat(player, nowEpochMs, "LAVA_INCOMING", "Seen lava was flowing into " + cell(here));
	}

	/** Stand crouched and watch for 3 s after backing away; the lava guard backs off again if the flow still comes. */
	private TickResult startWatch(ServerPlayer player) {
		releaseInput();
		watchTicks = 0;
		phase = Phase.WATCH;
		return TickResult.running(progress(player));
	}

	private TickResult watchTick(ServerPlayer player, long nowEpochMs) {
		if (++watchTicks >= RETREAT_WATCH_TICKS) return fail(player, retreatCode, retreatWhy + "; backed out to " + cell(feet(player)) + " and the flow stopped short of it");
		apply(player, new AgentInputStates.MotorTarget(player.getYRot(), player.getXRot(), false, false, false), true, false, false, nowEpochMs);
		return TickResult.running(progress(player));
	}

	/**
	 * Back away from lava coming at the body: up to eight cells back the way the march came (Nether lava runs seven blocks
	 * along a tunnel or bridge, about two a second, slower than a walk), else the clear neighbouring cell, through the
	 * ordinary navigation; then the trip ends with {@code code}, naming where the body backed out to.
	 */
	private TickResult retreat(ServerPlayer player, long nowEpochMs, String code, String why) {
		MinecraftNavigationWorld world = new MinecraftNavigationWorld(player.level(), player);
		GridPosition here = feet(player);
		retreatCode = code;
		retreatWhy = why;
		GridPosition behind = trailBack(world, here);
		if (behind != null) {
			// Back along the cells the body walked: a straight line back from a tunnel that turned met rock one cell on,
			// and the body backed a cell at a time while the lava came two a second (high110 course, 2026-10-24).
			if (DEBUG) LOGGER.info("TRAVEL_LAVA_RETREAT from={} to={} (trail)", cell(here), cell(behind));
			releaseInput();
			startLeg(player, behind, nowEpochMs, RETREAT_TOLERANCE);
			legFinal = true;
			return leg(player, nowEpochMs);
		}
		Direction back = buildDirection != null ? buildDirection.getOpposite() : awayFromLava(world, here);
		if (back != null) {
			for (int distance = RETREAT_CELLS; distance >= 1; distance--) {
				GridPosition cell = here.offset(back.getStepX() * distance, 0, back.getStepZ() * distance);
				if (world.isStandable(cell) && !world.lavaFillsNext(cell) && world.exposureCost(cell) == 0) {
					if (DEBUG) LOGGER.info("TRAVEL_LAVA_RETREAT from={} to={}", cell(here), cell(cell));
					releaseInput();
					startLeg(player, cell, nowEpochMs, RETREAT_TOLERANCE);
					legFinal = true;
					return leg(player, nowEpochMs);
				}
			}
		}
		return retreatToNeighbour(player, world, here, nowEpochMs);
	}

	/**
	 * Prefer a dry standing cell up to {@link #RETREAT_CELLS} cells back; use older dry ground when that
	 * section borders lava. Return null when the trail offers none at least two cells back.
	 */
	private GridPosition trailBack(MinecraftNavigationWorld world, GridPosition here) {
		return retreatAlong(new java.util.ArrayList<>(trail), here,
				cell -> world.isStandable(cell) && !world.lavaFillsNext(cell) && world.exposureCost(cell) == 0);
	}

	/** Keep the normal eight-cell retreat, but continue back to older dry ground when those cells border lava. */
	static GridPosition retreatAlong(java.util.List<GridPosition> walked, GridPosition here,
			java.util.function.Predicate<GridPosition> safe) {
		int from = walked.lastIndexOf(here);
		if (from < 0) from = walked.size();
		int preferred = Math.max(0, from - RETREAT_CELLS);
		for (int index = preferred; index <= from - 2; index++) if (safe.test(walked.get(index))) return walked.get(index);
		for (int index = preferred - 1; index >= 0; index--) if (safe.test(walked.get(index))) return walked.get(index);
		return null;
	}

	/** The horizontal direction away from seen lava beside the feet or head (or one step down beside them), or null. */
	private static Direction awayFromLava(MinecraftNavigationWorld world, GridPosition here) {
		for (Direction side : Direction.Plane.HORIZONTAL) {
			for (int dy = -1; dy <= 1; dy++) {
				BlockState state = world.stateAt(new BlockPos(here.x() + side.getStepX(), here.y() + dy, here.z() + side.getStepZ()));
				if (TravelBuilder.lava(state)) return side.getOpposite();
			}
		}
		return null;
	}

	private TickResult retreatToNeighbour(ServerPlayer player, MinecraftNavigationWorld world, GridPosition here, long nowEpochMs) {
		GridPosition best = null;
		Direction bestDirection = null;
		int bestRise = 0;
		double bestScore = Double.POSITIVE_INFINITY;
		for (Direction side : Direction.Plane.HORIZONTAL) {
			for (int rise : new int[] {0, -1, 1}) {
				GridPosition next = here.offset(side.getStepX(), rise, side.getStepZ());
				if (!world.isStandable(next) || world.lavaFillsNext(next)) continue;
				if (rise == 1 && !world.isBodyClear(here.above(2))) continue;
				double score = (buildDirection != null && side == buildDirection.getOpposite() ? 0.0D : 1.0D) + world.exposureCost(next) / 100.0D + Math.abs(rise) * 0.5D;
				if (score < bestScore) { bestScore = score; best = next; bestDirection = side; bestRise = rise; }
				break;
			}
		}
		if (best == null) return fail(player, retreatCode, retreatWhy + "; no seen standing cell beside it is clear of the lava");
		if (DEBUG) LOGGER.info("TRAVEL_LAVA_RETREAT from={} to={}", cell(here), cell(best));
		retreatFrom = here;
		move = new TravelBuilder.Plan(TravelBuilder.Kind.STEP, bestDirection, bestRise, null, null);
		moveFeet = here;
		moveTicks = 0;
		moveStage = 0;
		phase = Phase.BUILD;
		return null;
	}

	/**
	 * Walk one cell along the line (a step up is jumped). A level step that starts off the line's centre beside a drop
	 * sneaks, so an edge never takes the body; one that starts on the centreline walks straight along the axis at full
	 * pace (sneaking every step of a one-wide bridge made a march 1.3 blocks/s instead of 4.3).
	 */
	private TickResult stepTick(ServerPlayer player, Direction direction, long nowEpochMs) {
		if (moveTicks == 1) {
			stepSpan = 1;
			if (move.kind() == TravelBuilder.Kind.STEP && move.count() == 0) {
				MinecraftNavigationWorld seen = new MinecraftNavigationWorld(player.level(), player);
				for (int span = 1; span <= 10; span++) {
					GridPosition at = moveFeet.offset(direction.getStepX() * span, 0, direction.getStepZ() * span);
					if (!seen.isStandable(at) || seen.exposureCost(at) > 0 || edgeBeside(seen, at)) break;
					stepSpan = span;
				}
			}
		}
		GridPosition goal = moveFeet.offset(direction.getStepX() * stepSpan, move.count(), direction.getStepZ() * stepSpan);
		if (move.count() < 0) {
			// Sneaking at a down-step lip can never leave the old support. Ordinary navigation already owns
			// the guarded drop and its runout brake, so use it instead of repeatedly completing a false step.
			legFinal = true;
			startLeg(player, goal, nowEpochMs);
			return leg(player, nowEpochMs);
		}
		double dx = goal.x() + 0.5D - player.getX(), dz = goal.z() + 0.5D - player.getZ();
		// Done on the goal's column within a block of its height: soul sand, slabs or a stale cell can put the feet a level
		// off the plan, and waiting for the exact height left the step stuck; the next move is judged from where it stands.
		if (stepArrived(player.position(), feet(player), goal, player.onGround())) return moveDone(player, nowEpochMs);
		if (moveTicks > 80) return moveFailed(player, "Could not step onto " + cell(goal));
		if (moveTicks == 1) {
			MinecraftNavigationWorld world = new MinecraftNavigationWorld(player.level(), player);
			double lateral = direction.getStepX() != 0 ? player.getZ() - (moveFeet.z() + 0.5D) : player.getX() - (moveFeet.x() + 0.5D);
			// Also crouched when the cell past the goal is no ground to walk on (a hazard, a gap, a wall): the walk's own
			// momentum carried the body one cell on, into fire it was about to put out (course run, 2026-10-24).
			GridPosition past = goal.offset(direction.getStepX(), 0, direction.getStepZ());
			boolean wallRunout = world.cellAt(past) == WalkabilityView.Cell.SAFE_SUPPORT
					|| world.cellAt(past.offset(0, 1, 0)) == WalkabilityView.Cell.SAFE_SUPPORT;
			stepSneak = move.kind() == TravelBuilder.Kind.CROSS
					|| move.count() == 0 && Math.abs(lateral) > STEP_LINE && (edgeBeside(world, moveFeet) || edgeBeside(world, goal))
					|| !world.isStandable(past) && !wallRunout || world.exposureCost(past) > 0;
		}
		// Steer along the axis toward the goal's centre: a level step keeps to its line.
		float yaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
		boolean jump = goal.y() > moveFeet.y() && player.onGround() && dx * dx + dz * dz < 1.44D && feet(player).y() < goal.y();
		apply(player, new AgentInputStates.MotorTarget(yaw, 30.0F, true, jump, stepSpan >= 4 && dx * dx + dz * dz > 4.0D && !stepSneak && player.getFoodData().getFoodLevel() > SPRINT_FOOD), stepSneak, false, false, nowEpochMs);
		return null;
	}

	/** A batched step spends its actual cells, while a stationary mining or fire-clearing move spends none. */
	static int marchedCells(GridPosition from, GridPosition to) {
		return Math.max(Math.abs(to.x() - from.x()), Math.max(Math.abs(to.y() - from.y()), Math.abs(to.z() - from.z())));
	}

	static boolean stepArrived(Vec3 position, GridPosition support, GridPosition goal, boolean onGround) {
		double dx = goal.x() + 0.5D - position.x, dz = goal.z() + 0.5D - position.z;
		return onGround && support.x() == goal.x() && support.z() == goal.z()
				&& Math.abs(support.y() - goal.y()) <= 1 && dx * dx + dz * dz < 0.09D;
	}

	/** Whether an open cell with no seen support (a drop, or unseen ground) is beside this standing cell. */
	static boolean edgeBeside(WalkabilityView world, GridPosition cell) {
		for (Direction side : Direction.Plane.HORIZONTAL) {
			GridPosition next = cell.offset(side.getStepX(), 0, side.getStepZ());
			if (world.isBodyClear(next) && world.cellAt(next.below()) != WalkabilityView.Cell.SAFE_SUPPORT) return true;
			if (world.cellAt(next) == WalkabilityView.Cell.UNLOADED) return true;
		}
		return false;
	}

	/**
	 * Sneak-bridging: face back along the bridge, back to the edge of the block underfoot (sneak stops the body at the
	 * lip), and click the held block on that block's outer side face once the crosshair is on it; then step back onto the
	 * new block. Stage 0 selects the block, 1 backs to the edge and places, 2 steps onto it.
	 */
	private TickResult bridgeTick(ServerPlayer player, Direction direction, long nowEpochMs) {
		BlockPos support = new BlockPos(moveFeet.x(), moveFeet.y() - 1, moveFeet.z());
		BlockPos placed = support.relative(direction);
		if (moveStage == 0) {
			int slot = TravelBuilder.blockSlot(player);
			if (slot < 0) return fail(player, "OUT_OF_BLOCKS", "No plain block left on the hotbar to bridge " + cell(placed) + offHotbarText(player));
			if (!mayModify.test(player, placed)) return moveFailed(player, "Placing at " + cell(placed) + " is protected");
			slot = select(player, slot, nowEpochMs);
			if (player.getInventory().getSelectedSlot() == slot) {
				moveStage = 1;
				bridgeAttachment = bridgeAttachment(player, placed);
				float[] view = bridgeAttachment == null ? new float[] {TravelBuilder.yaw(direction.getOpposite()), bridgePitch()}
						: TravelBuilder.lookAt(player.getEyePosition(), bridgeAttachment.getLocation());
				bridgeViewYaw = view[0]; bridgeViewPitch = view[1];
			}
			return null;
		}
		float back = TravelBuilder.yaw(direction.getOpposite());
		if (moveStage == 1) {
			if (solid(player, placed)) { moveStage = 2; return null; }
			if (moveTicks > 120) return moveFailed(player, "Could not reach a view of the side of " + cell(support) + " to bridge " + cell(placed));
			BlockHitResult hit = TravelBuilder.crosshair(player);
			if (bridgeAttachment != null) {
				// A visible wall beside the gap takes the block without turning away from the tunnel just mined.
				boolean onFace = hit != null && hit.getBlockPos().equals(bridgeAttachment.getBlockPos())
						&& hit.getDirection() == bridgeAttachment.getDirection();
				if (onFace && player.onGround() && !player.getBoundingBox().intersects(new AABB(placed))) {
					TravelBuilder.click(player, hit);
					if (solid(player, placed)) { bridged++; moveStage = 2; }
				}
				apply(player, new AgentInputStates.MotorTarget(bridgeViewYaw, bridgeViewPitch, false, false, false), true, false, false, nowEpochMs);
				return null;
			}
			boolean onFace = hit != null && hit.getBlockPos().equals(support) && hit.getDirection() == direction;
			if (onFace && player.onGround() && !player.getBoundingBox().intersects(new AABB(placed))) {
				TravelBuilder.click(player, hit);
				if (solid(player, placed)) { bridged++; moveStage = 2; }
				apply(player, new AgentInputStates.MotorTarget(back, bridgePitch(), false, false, false), true, false, false, nowEpochMs);
				return null;
			}
			// Back toward the middle of the gap cell (which also corrects sideways drift), view down onto the edge;
			// sneak holds the body on the block.
			double gx = moveFeet.x() + 0.5D + direction.getStepX() - player.getX(), gz = moveFeet.z() + 0.5D + direction.getStepZ() - player.getZ();
			double alongSupport = (player.getX() - moveFeet.x() - 0.5D) * direction.getStepX()
					+ (player.getZ() - moveFeet.z() - 0.5D) * direction.getStepZ();
			// Walk the supported centre, then sneak before the lip; the brink guard still owns lethal edges.
			apply(player, new AgentInputStates.MotorTarget(back, bridgePitch(), true, false, false, (float) Math.toDegrees(Math.atan2(-gx, gz))), alongSupport >= 0.25D, false, false, nowEpochMs);
			return null;
		}
		// Stage 2 walks onto the placed block up to its centre. Only an overshoot needs sneak; the far edge is
		// still half a block away when this move hands off to the next placement (which sneaks before its lip).
		GridPosition onto = moveFeet.offset(direction.getStepX(), 0, direction.getStepZ());
		double dx = onto.x() + 0.5D - player.getX(), dz = onto.z() + 0.5D - player.getZ();
		double along = -(dx * direction.getStepX() + dz * direction.getStepZ());
		if (along > -0.15D && player.onGround() && feet(player).equals(onto)) return moveDone(player, nowEpochMs);
		if (moveTicks > 200) return moveFailed(player, "Could not step onto the bridge block at " + cell(placed));
		apply(player, new AgentInputStates.MotorTarget(bridgeViewYaw, bridgeViewPitch, true, false, false, (float) Math.toDegrees(Math.atan2(-dx, dz))), along > 0.0D, false, false, nowEpochMs);
		return null;
	}

	/** A remembered full face beside the gap, still directly visible and within vanilla placement reach. */
	private BlockHitResult bridgeAttachment(ServerPlayer player, BlockPos placed) {
		MinecraftNavigationWorld seen = new MinecraftNavigationWorld(player.level(), player);
		Vec3 eye = player.getEyePosition();
		BlockHitResult best = null;
		double bestTurn = Double.POSITIVE_INFINITY;
		for (Direction side : Direction.Plane.HORIZONTAL) {
			BlockPos anchor = placed.relative(side);
			BlockState state = seen.stateAt(anchor);
			if (state == null || !state.isCollisionShapeFullBlock(player.level(), anchor)) continue;
			Direction face = side.getOpposite();
			Vec3 normal = new Vec3(face.getStepX(), face.getStepY(), face.getStepZ());
			Vec3 point = Vec3.atCenterOf(anchor).add(normal.scale(0.5D));
			if (eye.distanceTo(point) > player.blockInteractionRange()) continue;
			BlockHitResult hit = player.level().clip(new ClipContext(eye, point.subtract(normal.scale(0.01D)),
					ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
			if (hit.getType() != HitResult.Type.BLOCK || !hit.getBlockPos().equals(anchor) || hit.getDirection() != face) continue;
			float[] look = TravelBuilder.lookAt(eye, point);
			double turn = Math.abs(AgentInputStates.shortestAngleDelta(player.getYRot(), look[0])) + Math.abs(player.getXRot() - look[1]);
			if (turn < bestTurn) { best = hit; bestTurn = turn; }
		}
		return best;
	}

	/**
	 * Fill a one-deep hole ahead: stand back from it (crouched), look down at its floor and click a block onto it, then
	 * step onto the filled cell. Stage 0 selects the block, 1 places, 2 steps on.
	 */
	private TickResult fillTick(ServerPlayer player, Direction direction, long nowEpochMs) {
		BlockPos hole = new BlockPos(moveFeet.x() + direction.getStepX(), moveFeet.y() - 1, moveFeet.z() + direction.getStepZ());
		if (moveStage == 0) {
			int slot = TravelBuilder.blockSlot(player);
			if (slot < 0) return fail(player, "OUT_OF_BLOCKS", "No plain block left on the hotbar to fill " + cell(hole) + offHotbarText(player));
			if (!mayModify.test(player, hole)) return moveFailed(player, "Placing at " + cell(hole) + " is protected");
			slot = select(player, slot, nowEpochMs);
			if (player.getInventory().getSelectedSlot() == slot) moveStage = 1;
			return null;
		}
		if (moveStage == 1) {
			if (solid(player, hole)) { moveStage = 2; return null; }
			if (moveTicks > 100) return moveFailed(player, "Could not place a block into the hole at " + cell(hole));
			float[] look = TravelBuilder.lookAt(player.getEyePosition(), new Vec3(hole.getX() + 0.5D, hole.getY() + 0.02D, hole.getZ() + 0.5D));
			boolean overlaps = player.getBoundingBox().intersects(new AABB(hole));
			BlockHitResult hit = TravelBuilder.crosshair(player);
			if (!overlaps && hit != null && hit.getBlockPos().equals(hole.below()) && hit.getDirection() == Direction.UP && player.onGround()) {
				TravelBuilder.click(player, hit);
				if (solid(player, hole)) { bridged++; moveStage = 2; }
			}
			// Back off the hole's edge while the body still dips into it; otherwise hold still and aim.
			apply(player, new AgentInputStates.MotorTarget(look[0], look[1], overlaps, false, false,
					overlaps ? TravelBuilder.yaw(direction.getOpposite()) : Float.NaN), true, false, false, nowEpochMs);
			return null;
		}
		move = new TravelBuilder.Plan(TravelBuilder.Kind.STEP, direction, 0, null, null);
		moveTicks = 0;
		return null;
	}

	/** Steep enough that the view from past the edge meets the side face below the feet. */
	private static float bridgePitch() {
		return 81.0F;
	}

	/** Pillar up {@code count} blocks: look straight down, jump, and place under the feet at the top of the jump. */
	private TickResult pillarTick(ServerPlayer player, long nowEpochMs) {
		GridPosition current = feet(player);
		if (moveStage == 0) {
			int slot = TravelBuilder.blockSlot(player);
			if (slot < 0) return fail(player, "OUT_OF_BLOCKS", "No plain block left on the hotbar to pillar at " + cell(current) + offHotbarText(player));
			slot = select(player, slot, nowEpochMs);
			if (player.getInventory().getSelectedSlot() == slot && player.onGround()) {
				moveStage = 1;
				moveFeet = current;
				moveTicks = 0;
			}
			return null;
		}
		if (moveTicks > 60) return moveFailed(player, "Could not pillar up at " + cell(moveFeet));
		BlockPos cellBelow = new BlockPos(moveFeet.x(), moveFeet.y(), moveFeet.z());
		if (solid(player, cellBelow) && player.onGround() && current.y() > moveFeet.y()) {
			pillared++;
			// Done climbing once the ledge is a step up.
			if (++pillarDone >= move.count()) return moveDone(player, nowEpochMs);
			moveStage = 0;
			return null;
		}
		if (player.onGround() && current.y() == moveFeet.y()) {
			// Jump only with the centre over the block underfoot: the brink guard lets the body's own jump run, and a jump
			// from a lip lands on nothing.
			BlockPos under = BlockPos.containing(player.getX(), moveFeet.y() - 1, player.getZ());
			if (player.level().getBlockState(under).getCollisionShape(player.level(), under).isEmpty()) {
				double dx = moveFeet.x() + 0.5D - player.getX(), dz = moveFeet.z() + 0.5D - player.getZ();
				apply(player, new AgentInputStates.MotorTarget(player.getYRot(), 90.0F, true, false, false,
						(float) Math.toDegrees(Math.atan2(-dx, dz))), true, false, false, nowEpochMs);
				return null;
			}
		}
		boolean high = player.getY() >= moveFeet.y() + 1.0D + 1.0E-3D;
		BlockHitResult hit = TravelBuilder.crosshair(player);
		if (high && hit != null && hit.getDirection() == Direction.UP && hit.getBlockPos().equals(cellBelow.below())
				&& mayModify.test(player, cellBelow)) {
			TravelBuilder.click(player, hit);
		}
		apply(player, new AgentInputStates.MotorTarget(player.getYRot(), 90.0F, false, player.onGround() && player.getXRot() > 85.0F, false), true, false, false, nowEpochMs);
		return null;
	}

	/** Mine a short visible run within vanilla reach, then watch every opening before walking into the batch. */
	private TickResult tunnelTick(ServerPlayer player, Direction direction, long nowEpochMs) {
		if (moveTicks == 1) { tunnelWatch = 0; tunnelReach = 1; tunnelDug.clear(); }
		BlockPos body = new BlockPos(moveFeet.x() + direction.getStepX(), moveFeet.y(), moveFeet.z() + direction.getStepZ());
		BlockPos target = null;
		GridPosition diggingCell = moveFeet.offset(direction.getStepX(), 0, direction.getStepZ());
		MinecraftNavigationWorld world = new MinecraftNavigationWorld(player.level(), player);
		// Clear the head row first, then the feet row near to far: this keeps the crosshair near one height
		// instead of swinging between head and feet for every block. Each ray still stops at an occluding block.
		int headReach = 0;
		tunnelReach = 0;
		choose: for (int row : new int[] {1, 0}) {
			for (int distance = 1; distance <= (row == 1 ? 4 : headReach); distance++) {
				BlockPos nextBody = body.relative(direction, distance - 1), cell = nextBody.above(row);
				BlockState known = world.stateAt(cell);
				if (known == null) break;
				if (!player.level().getBlockState(cell).getFluidState().isEmpty()) {
					return retreat(player, nowEpochMs, "TUNNEL_FLOODED", "Fluid flowed into the opened tunnel at " + cell(cell) + "; not entered");
				}
				if (!known.getCollisionShape(player.level(), cell).isEmpty()) {
					if (TravelBuilder.unmineable(known) != null || TravelBuilder.seenLavaBeside(world, cell)
							|| !mayModify.test(player, cell) || player.getEyePosition().distanceTo(Vec3.atCenterOf(cell)) > 4.5D
							|| TravelBuilder.mineTicks(player, known, known.getDestroySpeed(player.level(), cell))[1] > TravelBuilder.maximumTunnelMineTicks(known)) break;
					target = cell;
					diggingCell = moveFeet.offset(direction.getStepX() * distance, 0, direction.getStepZ() * distance);
					break choose;
				}
				if (row == 1) headReach = distance;
				else tunnelReach = distance;
			}
		}
		if (target == null) {
			// The full d35 observation window follows the LAST mining input in the batch. No freshly mined
			// cell is entered while this runs, including cells farther down the same visible opening.
			if (tunnelWatch++ < TUNNEL_WATCH_TICKS) {
				BlockPos end = body.relative(direction, Math.max(0, tunnelReach - 1));
				float[] into = TravelBuilder.lookAt(player.getEyePosition(), Vec3.atCenterOf(end).add(direction.getStepX() * 0.5D, 0, direction.getStepZ() * 0.5D));
				apply(player, new AgentInputStates.MotorTarget(into[0], into[1], false, false, false), true, false, false, nowEpochMs);
				return null;
			}
			tunnelWatch = 0;
			for (GridPosition dug : tunnelDug) {
				BlockState foot = world.stateAt(new BlockPos(dug.x(), dug.y(), dug.z()));
				if (foot != null && foot.isAir()) tunnelled++;
			}
			dev.agaminggod.arenaagents.server.perception.RouteMemory.of(player).mark(player, "mined tunnel: pickaxe if obstructed on return");
			return moveDone(player, nowEpochMs);
		}
		tunnelWatch = 0;
		tunnelDug.add(diggingCell);
		BlockState state = player.level().getBlockState(target);
		int slot = TravelBuilder.toolSlot(player, state);
		if (player.getInventory().getSelectedSlot() != slot) {
			select(player, slot, nowEpochMs);
			return null;
		}
		float perTick = state.getDestroyProgress(player, player.level(), target);
		if (perTick <= 0.0F || 1.0F / perTick > TravelBuilder.MAX_MINE_TICKS) {
			return moveFailed(player, "Mining " + BuiltInRegistries.BLOCK.getKey(state.getBlock()) + " at " + cell(target) + " would take over " + TravelBuilder.MAX_MINE_TICKS / 20 + " s with the inventory's best tool");
		}
		if (moveTicks > 400) return moveFailed(player, "Could not mine through " + cell(target));
		// Aim near eye height on the visible block face, rather than swinging to each block's centre.
		float[] look = TravelBuilder.lookAt(player.getEyePosition(), TravelBuilder.miningAim(player.getEyePosition(), target));
		BlockHitResult hit = TravelBuilder.crosshair(player);
		boolean aimed = hit != null && hit.getBlockPos().equals(target);
		apply(player, new AgentInputStates.MotorTarget(look[0], look[1], false, false, false), true, aimed, false, nowEpochMs);
		return null;
	}

	/** Mine the block over the head (a low ceiling over feet-level lava ahead), then judge the line again. */
	private TickResult clearUpTick(ServerPlayer player, long nowEpochMs) {
		BlockPos over = new BlockPos(moveFeet.x(), moveFeet.y() + 2, moveFeet.z());
		BlockState state = player.level().getBlockState(over);
		if (state.getCollisionShape(player.level(), over).isEmpty()) {
			if (!state.getFluidState().isEmpty()) return fail(player, "TUNNEL_FLOODED", "Fluid flowed in above the head at " + cell(over));
			return moveDone(player, nowEpochMs);
		}
		String why = TravelBuilder.unmineable(state);
		if (why != null || !mayModify.test(player, over)) return moveFailed(player, "Cannot mine the block over the head at " + cell(over) + (why == null ? ": protected" : ": " + why));
		int slot = TravelBuilder.toolSlot(player, state);
		if (player.getInventory().getSelectedSlot() != slot) { select(player, slot, nowEpochMs); return null; }
		float perTick = state.getDestroyProgress(player, player.level(), over);
		if (perTick <= 0.0F || 1.0F / perTick > TravelBuilder.MAX_MINE_TICKS || moveTicks > 200) return moveFailed(player, "Could not mine the block over the head at " + cell(over));
		BlockHitResult hit = TravelBuilder.crosshair(player);
		boolean aimed = hit != null && hit.getBlockPos().equals(over);
		apply(player, new AgentInputStates.MotorTarget(player.getYRot(), -90.0F, false, false, false), true, aimed, false, nowEpochMs);
		return null;
	}

	/** Punch out fire in the cell ahead (fire breaks at once to a hit on its flame), then step on. */
	private TickResult extinguishTick(ServerPlayer player, Direction direction, long nowEpochMs) {
		BlockPos flame = new BlockPos(moveFeet.x() + direction.getStepX(), moveFeet.y(), moveFeet.z() + direction.getStepZ());
		if (!TravelBuilder.fire(player.level().getBlockState(flame))) {
			return moveDone(player, nowEpochMs);
		}
		if (moveTicks > 60) return moveFailed(player, "Could not put out the fire at " + cell(flame));
		if (!mayModify.test(player, flame)) return moveFailed(player, "The fire at " + cell(flame) + " is protected");
		float[] look = TravelBuilder.lookAt(player.getEyePosition(), new Vec3(flame.getX() + 0.5D, flame.getY() + 0.03D, flame.getZ() + 0.5D));
		BlockHitResult hit = TravelBuilder.crosshair(player);
		boolean aimed = hit != null && hit.getBlockPos().equals(flame);
		apply(player, new AgentInputStates.MotorTarget(look[0], look[1], false, false, false), true, aimed, false, nowEpochMs);
		return null;
	}

	private static java.util.function.Function<GridPosition, BlockState> states(MinecraftNavigationWorld world) {
		return cell -> world.stateAt(new BlockPos(cell.x(), cell.y(), cell.z()));
	}

	private static boolean solid(ServerPlayer player, BlockPos cell) {
		return !player.level().getBlockState(cell).getCollisionShape(player.level(), cell).isEmpty();
	}

	private String offHotbarText(ServerPlayer player) {
		int off = TravelBuilder.blocksOffHotbar(player);
		return off > 0 ? "; " + off + " plain blocks are in the main inventory (select_tool moves them to the hotbar)" : "";
	}

	// ---- Input ----------------------------------------------------------------------------------------------------

	private int selectedSlot = -1;

	/** Selects a hotbar slot, crouched and still: every build move holds sneak so its pauses never slide off an edge. */
	private int select(ServerPlayer player, int slot, long nowEpochMs) {
		if (slot >= 9) {
			// Same vanilla number-key swap as select_tool; no empty hotbar slot is required.
			int hotbar = player.getInventory().getSelectedSlot();
			var refused = dev.agaminggod.arenaagents.server.runtime.AdvancedInteractionService.swapIntoHotbar(player, slot, hotbar);
			if (refused != null) return -1;
			slot = hotbar;
		}
		selectedSlot = slot;
		apply(player, new AgentInputStates.MotorTarget(player.getYRot(), player.getXRot(), false, false, false), true, false, false, nowEpochMs);
		return slot;
	}

	private void apply(ServerPlayer player, AgentInputStates.MotorTarget target, boolean sneak, boolean attack, boolean use, long nowEpochMs) {
		if (lease == null) {
			input = AgentInputRuntime.controller(player);
			lease = input.acquire(AgentInputRuntime.requireAgentId(player), InputOwner.NAVIGATION, 100);
		}
		if (motor == null) motor = AgentInputStates.MotorState.initial(player.getYRot(), player.getXRot());
		AgentInputStates.MotorStep step = AgentInputStates.stepMotor(motor, target, nowEpochMs);
		motor = step.state();
		int slot = selectedSlot >= 0 ? selectedSlot : player.getInventory().getSelectedSlot();
		// Crouched on magma, as a player steps carefully across it: vanilla magma does not burn a sneaking body.
		boolean onMagma = onMagma(player);
		MinecraftNavigationWorld seen = new MinecraftNavigationWorld(player.level(), player);
		boolean brake = ServerNavigationController.fireAhead(seen, player.getBoundingBox(), player.getDeltaMovement())
				|| ServerNavigationController.fireAhead(seen, player.getBoundingBox(), ServerNavigationController.inputMotion(
						player.getDeltaMovement(), step.forward(), step.strafe(), step.state().yaw(), player.onGround()));
		float[] braking = brake ? ServerNavigationController.brakeInput(player.getDeltaMovement(), step.state().yaw()) : null;
		input.apply(lease, new AgentInputState(brake ? braking[0] : step.forward(), brake ? braking[1] : step.strafe(),
				step.jump(), sneak || onMagma, step.sprint() && !sneak && !onMagma && !brake, attack, use, step.state().yaw(), step.state().pitch(), slot, InteractionHand.MAIN_HAND));
	}

	private static boolean onMagma(ServerPlayer player) {
		return BrinkGuard.onMagma(player);
	}

	private void releaseInput() {
		motor = null;
		if (lease == null) return;
		try {
			input.release(lease);
		} catch (LeasedServerInputController.StaleInputLeaseException ignored) {
			// A lifecycle clear may already have invalidated every lease.
		}
		lease = null;
		input = null;
	}

	@Override
	public void cancel(ServerPlayer player) {
		if (leg != null) leg.cancel(player);
		leg = null;
		if (fight != null) fight.cancel(player);
		fight = null;
		releaseInput();
	}

	/**
	 * A model-armed reflex held the body: health it lost and ground it was pushed over belong to that firing, so the trip
	 * takes the new health as its baseline and plans the next leg from where the body stands (a leg or build move
	 * half done before the firing no longer matches the body). A hostile still close stops it as before.
	 */
	@Override
	public void resumed(ServerPlayer player) {
		reflexResumes++;
		lastHealth = player.getHealth();
		bestAt = System.currentTimeMillis();
		if (phase == Phase.LEG || phase == Phase.BUILD || phase == Phase.LOOK) {
			if (leg != null) leg.cancel(player);
			leg = null;
			move = null;
			releaseInput();
			phase = Phase.PLAN;
		}
		if (fight != null) fight.resumed(player);
	}

	// ---- Fighting through (fightThrough:true) ---------------------------------------------------------------------

	private TickResult engage(ServerPlayer player, Mob mob, String why, long nowEpochMs) {
		if (leg != null) leg.cancel(player);
		leg = null;
		move = null;
		releaseInput();
		long remaining = timeoutMs - (nowEpochMs - startedAt);
		fight = new ServerFightController(mob, null, minHealth,
				CombatPlanning.followThrough(null, CombatPlanning.TargetPolicy.NAMED), CombatPlanning.TargetPolicy.NAMED,
				false, true, false, false, Math.max(1_000L, Math.min(FIGHT_TIMEOUT_MS, remaining)), nowEpochMs);
		fightTarget = mob.getUUID();
		fightLabel = BuiltInRegistries.ENTITY_TYPE.getKey(mob.getType()).getPath() + " (" + why + ")";
		phase = Phase.FIGHT;
		if (DEBUG) LOGGER.info("TRAVEL_FIGHT {} {}", mob.getUUID(), fightLabel);
		return TickResult.running(progress(player));
	}

	private TickResult fightTick(ServerPlayer player, long nowEpochMs) {
		if (nowEpochMs - startedAt >= timeoutMs) {
			return finish(player, ServerController.State.TIMED_OUT, "TRAVEL_TIMEOUT", "The trip's timeoutMs ran out while fighting " + fightLabel);
		}
		TickResult result = fight.tick(player, nowEpochMs);
		if (result.state() == ServerController.State.RUNNING) return TickResult.running(progress(player));
		fight = null;
		String code = result.reasonCode();
		fightLog.add(fightLabel + ": " + code);
		if (result.state() != ServerController.State.SUCCEEDED) {
			fightFailures++;
			boolean passable = FIGHT_PASSABLE.contains(code);
			if (!passable || fightFailures >= MAX_FIGHT_FAILURES) {
				return fail(player, code, "Fighting through " + fightLabel + " stopped the trip"
						+ (passable ? " (failed fight " + fightFailures + ")" : "") + ": " + result.message());
			}
			// A first failed fight (escaped, out of reach) lets the trip go on; that mob stops or is fought again only up close.
			knownHostiles.add(fightTarget);
		}
		lastHealth = player.getHealth();
		bestAt = nowEpochMs;
		phase = Phase.PLAN;
		return TickResult.running(progress(player));
	}

	// ---- Results --------------------------------------------------------------------------------------------------

	private double progress(ServerPlayer player) {
		return Math.max(0.0D, Math.min(1.0D, 1.0D - left(player.position()) / startLeft));
	}

	private TickResult fail(ServerPlayer player, String code, String message) {
		return finish(player, ServerController.State.FAILED, code, message);
	}

	private TickResult finish(ServerPlayer player, ServerController.State state, String code, String message) {
		cancel(player);
		String text = message + facts(player);
		return switch (state) {
			case SUCCEEDED -> TickResult.succeeded(code, text);
			case TIMED_OUT -> TickResult.timedOut(code, text, progress(player));
			default -> TickResult.failed(code, text, progress(player));
		};
	}

	private String facts(ServerPlayer player) {
		Vec3 at = player.position();
		double seconds = Math.max(0.05D, (System.currentTimeMillis() - startedAt) / 1000.0D);
		double gained = startLeft - left(at);
		double bearing = Math.toDegrees(Math.atan2(-(targetX - at.x), targetZ - at.z));
		return String.format(Locale.ROOT, "; at %.1f,%.1f,%.1f; %.0f blocks left to the target (yaw %.0f)%s; covered %.0f blocks toward it in %.0f s (%.0f blocks/min, %.0f walked); %d legs, bridged %d, pillared %d, tunnelled %d; %d plain blocks carried",
				at.x, at.y, at.z, left(at), bearing, Double.isFinite(targetY) ? String.format(Locale.ROOT, ", %.0f above", targetY - at.y) : "",
				gained, seconds, gained / seconds * 60.0D, travelled, legs, bridged, pillared, tunnelled, TravelBuilder.blocksOnHotbar(player) + TravelBuilder.blocksOffHotbar(player))
				+ (fightLog.isEmpty() ? "" : "; fought through " + String.join(", ", fightLog))
				+ (reflexResumes == 0 ? "" : "; replanned after " + reflexResumes + " reflex firing(s)");
	}

	private String lastFailureText() {
		return lastLegFailure == null ? "" : "; last leg: " + lastLegFailure;
	}

	private static String firstClause(String message) {
		if (message == null) return "";
		int cut = message.indexOf("; replans");
		return cut > 0 ? message.substring(0, cut) : message.length() > 200 ? message.substring(0, 200) : message;
	}

	/**
	 * The open cell the feet stand in, with its support below it: on soul sand (top 0.875) or a bottom slab (top 0.5)
	 * the feet are inside the support block's own cell, so rounding (not flooring) the height names the open cell.
	 */
	static GridPosition feet(ServerPlayer player) {
		GridPosition centre = new GridPosition((int) Math.floor(player.getX()), standingCellY(player.getY()), (int) Math.floor(player.getZ()));
		if (!player.onGround()) return centre;
		// Crouched at a bridge's lip the centre hangs over the gap: the cell is the block actually underfoot. A trip that
		// stopped mid-bridge left the body there, and the next one judged the gap as its own cell, read the air under it as
		// a partial block to pillar from and jumped off the lip into lava 17 below (lvkppl, 2026-10-24).
		BlockPos under = new BlockPos(centre.x(), centre.y() - 1, centre.z());
		if (!player.level().getBlockState(under).getCollisionShape(player.level(), under).isEmpty()) return centre;
		BlockPos support = player.getOnPos();
		if (player.level().getBlockState(support).getCollisionShape(player.level(), support).isEmpty()) return centre;
		return new GridPosition(support.getX(), centre.y(), support.getZ());
	}

	static int standingCellY(double feetY) {
		return (int) Math.floor(feetY + 0.5D);
	}

	private static String cell(GridPosition position) {
		return position == null ? "?" : position.x() + "," + position.y() + "," + position.z();
	}

	private static String cell(BlockPos position) {
		return position.getX() + "," + position.getY() + "," + position.getZ();
	}

	private static String format(double value) {
		return String.format(Locale.ROOT, "%.1f", value);
	}
}
