package dev.agaminggod.arenaagents.server.runtime.controller;

import carpet.helpers.EntityPlayerActionPack;
import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.LocalPathfinder;
import dev.agaminggod.arenaagents.client.navigation.PathNode;
import dev.agaminggod.arenaagents.client.navigation.PathOutcome;
import dev.agaminggod.arenaagents.client.navigation.PathPlan;
import dev.agaminggod.arenaagents.client.navigation.TraversalType;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import dev.agaminggod.arenaagents.protocol.ProtocolConstants;
import dev.agaminggod.arenaagents.server.runtime.ElapsedTimeAccumulator;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputRuntime;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputStates;
import dev.agaminggod.arenaagents.server.runtime.input.InputLease;
import dev.agaminggod.arenaagents.server.runtime.input.InputOwner;
import dev.agaminggod.arenaagents.server.runtime.input.LeasedServerInputController;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.AABB;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.ArrayList;
import java.util.Objects;
import java.util.Set;
import java.util.LinkedHashSet;
import java.util.function.BooleanSupplier;
import java.util.function.ToDoubleFunction;

public final class ServerNavigationController implements ServerController {
	private static final Logger LOGGER = LoggerFactory.getLogger(ServerNavigationController.class);
	private static final boolean TICK_DIAGNOSTICS_ENABLED = Boolean.getBoolean("arenaagents.navigation.debugTicks");
	public static final int DEFAULT_MAX_PATH_LENGTH = 256;
	public static final double MAX_LOCAL_PLANNING_DISTANCE = 32.0D;
	private static final long STALL_TIMEOUT_MS = 4_000L;
	private static final int MAX_REPLANS = 3;
	private static final double INTERMEDIATE_WAYPOINT_HORIZONTAL_TOLERANCE_SQUARED = 0.36D;
	private static final double INTERMEDIATE_WAYPOINT_VERTICAL_TOLERANCE = 0.25D;
	private static final double ENDPOINT_STABILITY_DISTANCE = 0.1D;
	/** Straight-line steering looks this many walk nodes ahead, so cardinal grid paths run as diagonals. */
	static final int STEERING_LOOKAHEAD_NODES = 8;
	/**
	 * Clear-line envelope. Between samples the body is at most half a spacing from the nearest sample on
	 * each axis, so a sample square of half-width player (0.3) + spacing / 2 + slack covers the swept
	 * hitbox; the slack also absorbs small drift off the line. The square stays under one block wide, so
	 * its four corners name every cell it touches.
	 */
	private static final double PLAYER_HALF_WIDTH = 0.3D;
	static final double STEERING_SAMPLE_SPACING = 0.1D;
	static final double STEERING_HALF_WIDTH = PLAYER_HALF_WIDTH + STEERING_SAMPLE_SPACING / 2.0D + 0.05D;
	/**
	 * Walking gaze: a little below the horizon, the way a player watches the ground ahead. It also keeps the crosshair
	 * off enderman eyes (about one block above yours) beyond a couple of blocks, where a level view provokes them.
	 */
	public static final float WALKING_GAZE_PITCH = 10.0F;
	private static final double GAZE_MIN_HORIZONTAL = 3.0D;
	/** A step-up jump is pressed only next to the step; vanilla step height covers 0.6 without one. */
	static final double JUMP_UP_TRIGGER_DISTANCE = 1.2D;
	private static final double STEP_HEIGHT = 0.6D;
	/** Gap jumps take off from the edge cell: between its center (2.0) and the landing's near side (1.0). */
	static final double GAP_TAKEOFF_MAX_DISTANCE = 2.0D;
	static final double GAP_TAKEOFF_MIN_DISTANCE = 1.0D;
	/** Inside this horizontal distance the view holds its heading on the final approach and after an overshoot. */
	static final double HOLD_HEADING_DISTANCE = 1.0D;
	private static final double PASSED_LEVEL_TOLERANCE = 0.1D;
	/** A steer point further round than this has been passed; the path never asks for such a turn this close. */
	static final float BEHIND_DEGREES = 100.0F;
	static final int GAZE_LOOKAHEAD_NODES = 3;
	static final float MAX_GAZE_OFFSET_DEGREES = 50.0F;
	private static final double GAZE_MIN_DISTANCE = 1.5D;

	private final DisplacementState displacement = new DisplacementState();
	private final Vec3 destination;
	private final AABB arrivalRegion;
	private final boolean allowNearArrival;
	private final NavigationContinuation continuation = new NavigationContinuation();
	private final double tolerance;
	private final boolean sprint;
	private final long timeoutMs;
	private final ElapsedTimeAccumulator elapsedTime;
	private final ServerPathPlanner planner = new ServerPathPlanner();
	private final BlockedMoveDetector blockedMoveDetector = new BlockedMoveDetector();
	private RouteProgress route;
	private MinecraftNavigationWorld navigationWorld;
	private Integer movementLevel;
	private LocalPathfinder.Search search;
	private Preparation preparation;
	private MinecraftNavigationWorld searchWorld;
	private GridPosition searchOrigin;
	private Set<GridPosition> searchGoals = Set.of();
	private final LinkedHashSet<GridPosition> previousFrontiers = new LinkedHashSet<>();
	private boolean searchRecovery;
	private PathPlan plan;
	/** Route cells lava already flowed beside when the route was chosen: the planner paid for them, so they never replan. */
	private Set<GridPosition> acceptedLavaContacts = Set.of();
	/** Route cells that held a seen hazard (fire) when the route was chosen: the planner accepted them, so they never replan. */
	private Set<GridPosition> acceptedHazards = Set.of();
	private boolean planEndsAtUnknown;
	private GridPosition reachedUnknownFrontier;
	private int waypointIndex;
	private Vec3[] routeTargets;
	private double[] routeTail;
	private final GapSprintGuard gapSprintGuard = new GapSprintGuard();
	private WaypointProgress progress;
	private double lastProgressValue;
	private Vec3 navigationStartPosition;
	private GridPosition resolvedEndpointPosition;
	private Vec3 resolvedEndpointTarget;
	private Vec3 endpointStabilityPosition;
	private boolean endpointStabilityConfirmed;
	private InputLease inputLease;
	private LeasedServerInputController inputController;
	private AgentInputStates.MotorState motorState;
	private boolean lastSprint;
	private double continuationHealth = Double.NaN;
	private boolean blockedMoveTracking;
	private boolean blockedMoveJumpPending;
	private boolean blockedMoveStepUp;
	private ResourceKey<Level> startingDimension;
	/** The portal cells this move targets (see {@link MinecraftNavigationWorld#targetedPortal}); null until first read. */
	private Set<GridPosition> targetedPortal;
	private NavigationBreathing breathing;
	private Vec3 diagnosticPreviousPosition;
	private Vec3 diagnosticTarget;
	private final LandingCheck landingCheck = new LandingCheck();
	private boolean lineUpForJump;
	private boolean crouched;

	public ServerNavigationController(
			Vec3 destination,
			double tolerance,
			boolean sprint,
			long startedAt,
			long timeoutMs
	) {
		this(destination, tolerance, sprint, startedAt, timeoutMs, null, false);
	}

	public ServerNavigationController(Vec3 destination, double tolerance, boolean sprint, long startedAt, long timeoutMs, boolean allowNearArrival) {
		this(destination, tolerance, sprint, startedAt, timeoutMs, null, allowNearArrival);
	}

	ServerNavigationController(Vec3 destination, double tolerance, boolean sprint, long startedAt, long timeoutMs, AABB arrivalRegion) {
		this(destination, tolerance, sprint, startedAt, timeoutMs, arrivalRegion, false);
	}

	private ServerNavigationController(Vec3 destination, double tolerance, boolean sprint, long startedAt, long timeoutMs, AABB arrivalRegion, boolean allowNearArrival) {
		this.destination = Objects.requireNonNull(destination, "destination must not be null");
		this.arrivalRegion = arrivalRegion;
		this.allowNearArrival = allowNearArrival;
		if (!Double.isFinite(tolerance)
				|| tolerance < ProtocolConstants.MIN_MOVEMENT_TOLERANCE
				|| tolerance > ProtocolConstants.MAX_MOVEMENT_TOLERANCE
				|| timeoutMs <= 0L || timeoutMs > ProtocolConstants.MAX_DURATION_MS) {
			throw new IllegalArgumentException("invalid navigation tolerance or timeout");
		}
		this.tolerance = tolerance;
		this.sprint = sprint;
		this.timeoutMs = timeoutMs;
		this.elapsedTime = new ElapsedTimeAccumulator(startedAt);
	}

	ServerNavigationController onLevel(int y) {
		movementLevel = y;
		return this;
	}

	/**
	 * The model's sneak:true held through a walk a fight runs for it: crouched the whole way and never sprinting. A crouched
	 * player cannot step off an edge (vanilla's sneak edge back-off) or sprint-jump a gap, so a route that needs a drop or a
	 * gap jump hands back SNEAK_HOLDS_EDGE at that edge instead of standing up.
	 */
	public ServerNavigationController crouched(boolean crouched) {
		this.crouched = crouched;
		return this;
	}

	@Override
	public TickResult tick(ServerPlayer player, long nowEpochMs) {
		Objects.requireNonNull(player, "player must not be null");
		BrinkGuard.commandedDestination(player, destination);
		if (!TICK_DIAGNOSTICS_ENABLED) return tickInternal(player, nowEpochMs);
		long startedNanos = System.nanoTime();
		try {
			return tickInternal(player, nowEpochMs);
		} finally {
			logTickDiagnostics(player, System.nanoTime() - startedNanos);
		}
	}

	private TickResult tickInternal(ServerPlayer player, long nowEpochMs) {
		Objects.requireNonNull(player, "player must not be null");
		ResourceKey<Level> currentDimension = player.level().dimension();
		if (startingDimension == null) {
			startingDimension = currentDimension;
		} else if (!remainsInDimension(startingDimension, currentDimension)) {
			return fail(player, "ACTION_DIMENSION_CHANGED",
					"Agent player changed dimension during navigation", currentProgress());
		}
		long elapsedMs = elapsedTime.advance(nowEpochMs);
		if (!player.isAlive()) {
			return fail(player, "AGENT_DEAD", "Agent player died", currentProgress());
		}
		if (player.isPassenger() || player.isFallFlying()) {
			return fail(player, "UNSUPPORTED_NAVIGATION_MODE", "Mounted travel and gliding require player control inputs", currentProgress());
		}
		if (elapsedMs >= timeoutMs) {
			return fail(player, "ACTION_TIMEOUT", "Navigation timed out", currentProgress());
		}
		if (Double.isFinite(continuationHealth)) {
			if (player.getHealth() < continuationHealth) {
				return fail(player, "NAVIGATION_DAMAGED", "Health dropped while observing a navigation continuation", currentProgress());
			}
			continuationHealth = player.getHealth();
		}
		MinecraftNavigationWorld breathWorld = navigationWorld(player);
		int submerged = plan == null ? 0 : submergedNodesAhead(breathWorld, plan.nodes(), waypointIndex);
		TickResult breathingResult = breathe(player, nowEpochMs, elapsedMs, submerged, false);
		if (breathingResult != null) return breathingResult;
		double remaining = player.position().distanceTo(destination);
		if (route == null) route = new RouteProgress(player.getX(), player.getY(), player.getZ(), remaining, elapsedMs);
		// Catching breath before a dive (air refilling with the eyes above water) is not standing still.
		RouteProgress.Stop stop = route.observe(player.getX(), player.getY(), player.getZ(), remaining, routeRemaining(player.position()), elapsedMs,
				!player.isUnderWater() && player.getAirSupply() < player.getMaxAirSupply());
		if (stop != null) return fail(player, "NO_PROGRESS", stop.message(), currentProgress());
		if (displacement.observe(player.getHealth(), player.getY(), player.fallDistance, player.hurtTime,
				player.getLastDamageSource() != null
						&& player.getLastDamageSource().getEntity() instanceof net.minecraft.world.entity.LivingEntity,
				player.onGround(), player.isInWater())) {
			var attacker = player.getLastHurtByMob();
			displacement.source = attacker != null && player.hasLineOfSight(attacker)
					? net.minecraft.core.registries.BuiltInRegistries.ENTITY_TYPE.getKey(attacker.getType()).toString()
					: "an unseen attacker";
		}
		if (displacement.offRoute) {
			if (displacement.hasLanded(player.onGround(), player.isInWater(), player.isInLava(), player.onClimbable())) {
				return fail(player, "DISPLACED", String.format(java.util.Locale.ROOT,
						"Knocked off route by %s, fell %.1f blocks, now at %.1f,%.1f,%.1f, health %.1f",
						displacement.source, displacement.fall, player.getX(), player.getY(), player.getZ(), player.getHealth()), currentProgress());
			}
			coast(player);
			return TickResult.running(currentProgress());
		}
		Vec3 missedLanding = landingCheck.observe(player.onGround(), player.isInWater() || player.onClimbable(), player.getY());
		if (missedLanding != null) {
			return fail(player, "MISSED_LANDING", String.format(java.util.Locale.ROOT,
					"Landed below the planned landing at %.1f,%.2f,%.1f; navigation stopped before choosing another route",
					missedLanding.x, missedLanding.y, missedLanding.z) + CombatMoveText.supportFacts(player), currentProgress());
		}
		MinecraftNavigationWorld world = navigationWorld(player);
		if (navigationStartPosition == null) navigationStartPosition = player.position();
		if (plan == null && blockedMoveTracking) {
			BlockedMoveDetector.Decision blockedDecision = blockedMoveDetector.observe(
					player.horizontalCollision, groundedOnLand(player), blockedMoveJumpPending, blockedMoveStepUp,
					player.getX(), player.getZ(), nowEpochMs);
			blockedMoveTracking = blockedDecision != BlockedMoveDetector.Decision.CONTINUE
					|| player.horizontalCollision && groundedOnLand(player) && !blockedMoveJumpPending && !blockedMoveStepUp;
			if (blockedDecision == BlockedMoveDetector.Decision.FAIL) {
				return fail(player, "PATH_BLOCKED", "Navigation remained blocked after three seconds", currentProgress());
			}
		}
		if (plan == null) {
			TickResult planned = replan(player, world, nowEpochMs, elapsedMs, false);
			if (planned != null) return planned;
		}
		breathingResult = breathe(player, nowEpochMs, elapsedMs,
				submergedNodesAhead(world, plan.nodes(), waypointIndex), false);
		if (breathingResult != null) return breathingResult;
		lastProgressValue = navigationProgress(player.position());
		TickResult endpointResult = verifyEndpoint(world, player);
		if (endpointResult != null) return endpointResult;
		List<PathNode> nodes = plan.nodes();
		if (waypointIndex >= nodes.size()) {
			noteReplan("waypoints-exhausted", player);
			return replanOrResult(player, world, nowEpochMs, elapsedMs);
		}
		PathNode waypoint = nodes.get(waypointIndex);
		if (!world.isTraversable(waypoint.position())) {
			noteReplan("waypoint-not-traversable", player);
			TickResult replanned = replan(player, world, nowEpochMs, elapsedMs, true);
			if (replanned != null) return replanned;
			nodes = plan.nodes();
			waypoint = nodes.get(waypointIndex);
		}
		if (lavaReachesRouteAhead(world, nodes, waypointIndex, acceptedLavaContacts)) {
			// Lava that has spread beside the cells ahead since the route was chosen: a player turns away from a flow
			// coming at the path instead of walking on into it (d22-lava).
			noteReplan("lava-beside-route", player);
			plan = null;
			TickResult replanned = replan(player, world, nowEpochMs, elapsedMs, false);
			if (replanned != null) return replanned;
			nodes = plan.nodes();
			waypoint = nodes.get(waypointIndex);
		}
		if (hazardReachesRouteAhead(world, nodes, waypointIndex, acceptedHazards)) {
			// Fire seen on a route cell ahead since the route was chosen (a ghast fireball, spreading flame): a player
			// walks around it rather than on through it (live Nether run 95e3b0fb 2026-10-23: fire lit 2 s ahead of a
			// move_to, which walked into it and burned the body down).
			noteReplan("hazard-on-route", player);
			plan = null;
			TickResult replanned = replan(player, world, nowEpochMs, elapsedMs, false);
			if (replanned != null) return replanned;
			nodes = plan.nodes();
			waypoint = nodes.get(waypointIndex);
		}
		int occupied = occupiedWalkNode(nodes, waypointIndex, grid(player.position()));
		if (occupied >= 0 && player.onGround()) {
			// Corner-cut steering crosses walk cells away from their centers; standing in a later
			// path cell means every node up to it is behind the player.
			waypointIndex = occupied + 1;
			waypoint = nodes.get(waypointIndex);
			progress.waypointAdvanced(player.position().distanceTo(
					targetFor(world, waypoint, waypointIndex == nodes.size() - 1)), nowEpochMs);
		}
		if (player.onGround() && waypointIndex < nodes.size() - 1) {
			Vec3 waypointCenter = center(waypoint.position());
			if (passedWaypoint(world, player.position(), nodes, waypointIndex,
					world.supportHeight(waypoint.position(), waypointCenter.x, waypointCenter.z))) {
				// A body that clears a short step lands on the supporting block's far side: the waypoint is behind it.
				waypointIndex++;
				waypoint = nodes.get(waypointIndex);
				progress.waypointAdvanced(player.position().distanceTo(
						targetFor(world, waypoint, waypointIndex == nodes.size() - 1)), nowEpochMs);
			}
		}
		if (!player.isUnderWater() && world.isSubmerged(waypoint.position())
				&& !SwimPlanning.breathCovers(player.getAirSupply(), submergedNodesAhead(world, nodes, waypointIndex))) {
			// Catch breath before the dive, as a player does: air refills while the eyes are above water.
			coast(player);
			return TickResult.running(lastProgressValue);
		}
		boolean finalWaypoint = waypointIndex == nodes.size() - 1;
		Vec3 target = targetFor(world, waypoint, finalWaypoint);
		boolean reached = canAdvanceWaypoint(waypoint.traversal(), player.onGround(), player.isInWater(), player.onClimbable())
				&& reachedTarget(world, player.position(), waypoint, finalWaypoint)
				&& !(finalWaypoint && surfaceEndpoint(world, waypoint.position()) && player.isUnderWater());
		boolean jumpPending = jumpPending(player, world, waypoint, target);
		boolean stepUp = waypoint.traversal() == TraversalType.JUMP_UP;
		if (reached) {
			blockedMoveDetector.reset();
			blockedMoveTracking = false;
		} else {
			blockedMoveJumpPending = jumpPending;
			blockedMoveStepUp = stepUp;
			blockedMoveTracking = player.horizontalCollision && groundedOnLand(player) && !jumpPending && !stepUp;
		}
		BlockedMoveDetector.Decision blockedDecision = reached ? BlockedMoveDetector.Decision.CONTINUE
				: blockedMoveDetector.observe(player.horizontalCollision, groundedOnLand(player), jumpPending, stepUp,
						player.getX(), player.getZ(), nowEpochMs);
		if (blockedDecision == BlockedMoveDetector.Decision.FAIL) {
			return fail(player, "PATH_BLOCKED", "Navigation remained blocked after three seconds", lastProgressValue);
		}
		if (blockedDecision == BlockedMoveDetector.Decision.REPLAN) {
			noteReplan("blocked", player);
			TickResult replanned = replan(player, world, nowEpochMs, elapsedMs, true);
			if (replanned != null) return replanned;
			nodes = plan.nodes();
			waypoint = nodes.get(waypointIndex);
			finalWaypoint = waypointIndex == nodes.size() - 1;
			target = targetFor(world, waypoint, finalWaypoint);
			reached = canAdvanceWaypoint(waypoint.traversal(), player.onGround(), player.isInWater(), player.onClimbable())
					&& reachedTarget(world, player.position(), waypoint, finalWaypoint);
		}
		double activeWaypointDistance = player.position().distanceTo(target);
		WaypointProgress.Update update = progress.observe(activeWaypointDistance, reached, nowEpochMs,
				Math.min(world.movementSpeedMultiplier(new GridPosition(player.blockPosition().getX(), player.blockPosition().getY(), player.blockPosition().getZ())),
						world.movementSpeedMultiplier(waypoint.position())));
		lastProgressValue = navigationProgress(player.position());
		if (reached) {
			waypointIndex++;
			if (waypointIndex >= nodes.size()) {
				noteReplan("waypoints-exhausted-after-reach", player);
				return replanOrResult(player, world, nowEpochMs, elapsedMs);
			}
			waypoint = nodes.get(waypointIndex);
			finalWaypoint = waypointIndex == nodes.size() - 1;
			target = targetFor(world, waypoint, finalWaypoint);
			progress.waypointAdvanced(player.position().distanceTo(target), nowEpochMs);
		}
		if (update.decision() == WaypointProgress.Decision.FAIL) {
			return fail(player, "PATH_BLOCKED", "Navigation could not recover from repeated stalls", lastProgressValue);
		}
		if (update.decision() == WaypointProgress.Decision.REPLAN) {
			// A nearby repeated stall without advancement on the accepted route repeats the failed attempt.
			if (route.noGainSinceStallReplan()) {
				return fail(player, "PATH_BLOCKED", "Stalled here again without route progress", lastProgressValue);
			}
			route.stallReplanned();
			noteReplan("stalled", player);
			TickResult replanned = replan(player, world, nowEpochMs, elapsedMs, true);
			if (replanned != null) return replanned;
			waypoint = plan.nodes().get(waypointIndex);
			target = targetFor(world, waypoint, waypointIndex == plan.nodes().size() - 1);
		}
		List<PathNode> active = plan.nodes();
		int steerIndex = waypoint.traversal() == TraversalType.WALK && player.onGround()
				? steeringIndex(world, player.position(), active, waypointIndex)
				: fallingSteerIndex(active, waypointIndex, player.onGround());
		Vec3 steer = steerIndex == waypointIndex ? target
				: targetFor(world, active.get(steerIndex), steerIndex == active.size() - 1);
		Vec3 lineUp = player.onGround() ? jumpLineUp(world, player.position(), player.getDeltaMovement(), active, waypointIndex) : null;
		lineUpForJump = lineUp != null;
		if (lineUp != null) steer = lineUp;
		diagnosticTarget = target;
		if (crouched && player.onGround() && (waypoint.traversal() == TraversalType.JUMP_GAP || waypoint.traversal() == TraversalType.DROP_DOWN)) {
			return fail(player, "SNEAK_HOLDS_EDGE", "sneak:true: the route needs a " + (waypoint.traversal() == TraversalType.DROP_DOWN ? "drop" : "gap jump")
					+ " at " + waypoint.position().x() + "," + waypoint.position().y() + "," + waypoint.position().z() + ", which a crouched body cannot take (vanilla edge back-off); the walk handed back crouched", lastProgressValue);
		}
		drive(player, world, waypoint, target, steer, steerIndex == active.size() - 1, steerIndex == waypointIndex, nowEpochMs);
		return TickResult.running(lastProgressValue);
	}

	/** Whether the body is following a planned walking stretch now (no jump, drop, swim or climb under way). Read-only. */
	public boolean walking() {
		return plan != null && waypointIndex < plan.nodes().size() && plan.nodes().get(waypointIndex).traversal() == TraversalType.WALK;
	}

	/** The planned route still ahead (feet cells), empty before a plan exists. Read-only. */
	public List<GridPosition> plannedRoute() {
		if (plan == null) return List.of();
		List<PathNode> nodes = plan.nodes();
		List<GridPosition> route = new java.util.ArrayList<>(Math.max(0, nodes.size() - waypointIndex));
		for (int index = Math.max(0, waypointIndex); index < nodes.size(); index++) route.add(nodes.get(index).position());
		return route;
	}

	@Override
	public void cancel(ServerPlayer player) {
		discardPlanning();
		releaseInput();
	}

	@Override
	public void resumed(ServerPlayer player) {
		if (Double.isFinite(continuationHealth)) continuationHealth = player.getHealth();
	}

	/** Cancellation releases the keys, not the body's existing momentum. */
	public String stoppedBodyFacts(ServerPlayer player) {
		String facts = "; navigation input released" + CombatMoveText.supportFacts(player);
		if (player.onGround() || player.isInWater() || player.onClimbable()) return facts;
		Vec3 landing = landingCheck.target();
		if (landing == null && plan != null && waypointIndex < plan.nodes().size()) {
			landing = targetFor(navigationWorld(player), plan.nodes().get(waypointIndex), waypointIndex == plan.nodes().size() - 1);
		}
		facts += airborneFacts(player.position(), player.getDeltaMovement(), landing);
		if (landing == null) return facts;
		GridPosition below = new GridPosition((int) Math.floor(landing.x), (int) Math.floor(landing.y - .01D), (int) Math.floor(landing.z));
		String block = CombatMoveText.knownBlock(player, below);
		return facts + "; planned footing: " + (block.isEmpty() ? "unknown " : block)
				+ "at " + below.x() + "," + below.y() + "," + below.z();
	}

	static String airborneFacts(Vec3 position, Vec3 velocity, Vec3 landing) {
		String facts = String.format(java.util.Locale.ROOT, "; airborne; velocity %.2f,%.2f,%.2f blocks/tick",
				velocity.x, velocity.y, velocity.z);
		if (landing == null) return facts + "; landing unknown";
		double seconds = secondsToLevel(position.y, velocity.y, landing.y);
		return facts + String.format(java.util.Locale.ROOT, "; planned landing %.1f,%.2f,%.1f", landing.x, landing.y, landing.z)
				+ (Double.isFinite(seconds) ? String.format(java.util.Locale.ROOT, "; gravity-only estimate %.2f s to its height", seconds)
						: "; its height is no longer reachable on the current fall")
				+ "; landing contact unverified; momentum continues after release";
	}

	/** Vanilla dry-air gravity, with no new input or collisions. This estimates a height crossing, never a safe landing. */
	static double secondsToLevel(double y, double velocityY, double level) {
		boolean aboveLevel = y >= level;
		for (int tick = 1; tick <= 60; tick++) {
			y += velocityY;
			aboveLevel |= y >= level;
			if (aboveLevel && velocityY < 0 && y <= level) return tick / 20.0D;
			velocityY = (velocityY - 0.08D) * 0.98D;
		}
		return Double.NaN;
	}

	/** A failed jump must return to the model instead of retrying an unreachable step, then routing downhill. */
	static final class LandingCheck {
		private Vec3 target;
		private boolean airborne;

		void track(TraversalType traversal, Vec3 landing, boolean onGround) {
			if (!onGround || airborne) return;
			target = traversal == TraversalType.JUMP_UP || traversal == TraversalType.JUMP_GAP || traversal == TraversalType.DROP_DOWN
					? landing : null;
		}

		Vec3 target() { return target; }

		Vec3 observe(boolean onGround, boolean waterOrClimb, double y) {
			if (waterOrClimb) { target = null; airborne = false; return null; }
			if (target == null) return null;
			if (!onGround) { airborne = true; return null; }
			if (!airborne) return null;
			// A stair's lower tread can still step up onto the steering point without another jump.
			Vec3 missed = y < target.y - STEP_HEIGHT - 1.0E-6D ? target : null;
			target = null;
			airborne = false;
			return missed;
		}
	}

	private void discardPlanning() {
		search = null;
		preparation = null;
		searchWorld = null;
		searchOrigin = null;
		searchGoals = Set.of();
	}

	void invalidatePlanning(GridPosition actualOrigin, boolean terrainCurrent) {
		if (TICK_DIAGNOSTICS_ENABLED && (search != null || preparation != null)) {
			if (!terrainCurrent) LOGGER.info("NAV_DISCARD reason=terrain");
			else if (searchOrigin != null && !actualOrigin.equals(searchOrigin)) LOGGER.info("NAV_DISCARD reason=origin");
		}
		if (!terrainCurrent) {
			previousFrontiers.clear();
			discardPlanning();
		}
		if (searchOrigin != null && !actualOrigin.equals(searchOrigin)) discardPlanning();
	}

	private void releaseInput() {
		if (inputLease == null) {
			motorState = null;
			return;
		}
		try {
			inputController.release(inputLease);
		} catch (LeasedServerInputController.StaleInputLeaseException ignored) {
			// A lifecycle clear may already have invalidated every lease.
		}
		inputLease = null;
		inputController = null;
		motorState = null;
	}

	private TickResult replanOrResult(
			ServerPlayer player,
			MinecraftNavigationWorld world,
			long nowEpochMs,
			long elapsedMs
	) {
		TickResult endpointResult = verifyEndpoint(world, player);
		if (endpointResult != null) return endpointResult;
		// Completed cells are still legal transit, but revisiting them is not a new sight frontier.
		for (PathNode node : plan.nodes()) previousFrontiers.add(node.position());
		while (previousFrontiers.size() > 512) previousFrontiers.remove(previousFrontiers.getFirst());
		// The approach can reveal a continuation that the committed segment could not see.
		if (planEndsAtUnknown) {
			reachedUnknownFrontier = plan.nodes().getLast().position();
			previousFrontiers.add(reachedUnknownFrontier);
		}
		TickResult replanned = replan(player, world, nowEpochMs, elapsedMs, false);
		if (replanned != null) return replanned;
		lastProgressValue = navigationProgress(player.position());
		return TickResult.running(currentProgress());
	}

	static boolean satisfiesDestinationTolerance(double remaining, double tolerance) {
		return remaining <= tolerance;
	}

	static boolean remainsInDimension(ResourceKey<Level> startingDimension, ResourceKey<Level> currentDimension) {
		return Objects.requireNonNull(startingDimension, "startingDimension must not be null")
				.equals(Objects.requireNonNull(currentDimension, "currentDimension must not be null"));
	}

	Vec3 targetFor(PathNode waypoint, boolean finalWaypoint) {
		Objects.requireNonNull(waypoint, "waypoint must not be null");
		return targetFor(waypoint, finalWaypoint, waypoint.position().y());
	}

	boolean reachedTarget(Vec3 playerPosition, PathNode waypoint, boolean finalWaypoint) {
		return reachedTarget(playerPosition, waypoint, finalWaypoint, waypoint.position().y());
	}

	boolean reachedTarget(Vec3 playerPosition, PathNode waypoint, boolean finalWaypoint, double supportHeight) {
		Objects.requireNonNull(playerPosition, "playerPosition must not be null");
		if (!Double.isFinite(supportHeight)) return false;
		Vec3 target = targetFor(waypoint, finalWaypoint, supportHeight);
		if (finalWaypoint && waypoint.position().equals(resolvedEndpointPosition)) {
			return withinEndpoint(playerPosition);
		}
		if (finalWaypoint && arrivalRegion != null) {
			return arrivalRegion.contains(playerPosition) && playerPosition.distanceTo(target) <= tolerance;
		}
		return targetsExactDestination(waypoint, finalWaypoint)
				? satisfiesDestinationTolerance(playerPosition.distanceTo(target), tolerance)
				: reachedWaypoint(playerPosition, target);
	}

	private Vec3 targetFor(MinecraftNavigationWorld world, PathNode waypoint, boolean finalWaypoint) {
		if (finalWaypoint && waypoint.position().equals(resolvedEndpointPosition) && resolvedEndpointTarget != null) {
			return resolvedEndpointTarget;
		}
		if (finalWaypoint && surfaceEndpoint(world, waypoint.position())) return swimEndpointTarget(waypoint.position(), destination);
		if (!supportedEndpoint(world, waypoint.position()) && !(finalWaypoint && submergedFloor(world, waypoint.position()))) {
			if (waypoint.traversal() == TraversalType.SWIM) return center(waypoint.position()).add(0.0D, 0.4D, 0.0D);
			if (waypoint.traversal() == TraversalType.CLIMB) return center(waypoint.position());
		}
		Vec3 horizontalTarget = targetFor(waypoint, finalWaypoint);
		double supportHeight = world.supportHeight(
				waypoint.position(), horizontalTarget.x, horizontalTarget.z);
		return Double.isFinite(supportHeight)
				? targetFor(waypoint, finalWaypoint, supportHeight)
				: horizontalTarget;
	}

	private Vec3 targetFor(PathNode waypoint, boolean finalWaypoint, double supportHeight) {
		boolean exactDestination = targetsExactDestination(waypoint, finalWaypoint);
		Vec3 horizontalTarget = exactDestination ? destination : center(waypoint.position());
		double targetY = exactDestination && hasFullBlockSupportHeight(waypoint.position(), supportHeight)
				? destination.y
				: supportHeight;
		return new Vec3(horizontalTarget.x, targetY, horizontalTarget.z);
	}

	/**
	 * Returns the last server-observed navigation facts for callers that publish action evidence.
	 * The endpoint is retained from the selected final path node, never inferred from raw proximity.
	 */
	public AuthoritativeState authoritativeState(ServerPlayer player, long observedAtEpochMs) {
		Objects.requireNonNull(player, "player must not be null");
		MinecraftNavigationWorld world = navigationWorld(player);
		Vec3 position = player.position();
		lastProgressValue = navigationProgress(position);
		boolean endpointStandable = resolvedEndpointPosition != null && resolvedEndpointTarget != null
				&& goalEndpoint(world, resolvedEndpointPosition)
				&& Double.isFinite(world.supportHeight(
						resolvedEndpointPosition,
						resolvedEndpointTarget.x,
						resolvedEndpointTarget.z));
		boolean withinTolerance = withinEndpoint(position);
		boolean noCollision = player.level().noCollision(player.getBoundingBox());
		boolean physicallyValid = endpointStandable && withinTolerance && noCollision
				&& !player.isInWall() && player.onGround();
		boolean stable = physicallyValid && endpointStabilityConfirmed && endpointStabilityPosition != null
				&& position.distanceTo(endpointStabilityPosition) <= ENDPOINT_STABILITY_DISTANCE;
		return new AuthoritativeState(
				position,
				grid(position),
				destination,
				resolvedEndpointTarget,
				resolvedEndpointPosition,
				resolvedEndpointTarget == null ? null : position.distanceTo(resolvedEndpointTarget),
				tolerance,
				lastProgressValue,
				endpointStandable,
				withinTolerance,
				noCollision,
				player.isInWall(),
				player.onGround(),
				stable,
				observedAtEpochMs
		);
	}

	public record AuthoritativeState(
			Vec3 position,
			GridPosition blockPosition,
			Vec3 requestedDestination,
			Vec3 resolvedEndpoint,
			GridPosition resolvedEndpointBlock,
			Double distanceToEndpoint,
			double tolerance,
			double progress,
			boolean endpointStandable,
			boolean withinTolerance,
			boolean noCollision,
			boolean inWall,
			boolean onGround,
			boolean stable,
			long observedAtEpochMs
	) {
	}

	private TickResult verifyEndpoint(MinecraftNavigationWorld world, ServerPlayer player) {
		if (resolvedEndpointPosition == null || resolvedEndpointTarget == null) {
			endpointStabilityPosition = null;
			endpointStabilityConfirmed = false;
			return null;
		}
		if (surfaceArrival(surfaceEndpoint(world, resolvedEndpointPosition), player.isInWater(), player.isUnderWater(),
				withinEndpoint(player.position()), player.level().noCollision(player.getBoundingBox()), player.isInWall())) {
			return succeed(player, "DESTINATION_REACHED", "Chosen breathable swim target reached with eyes above water");
		}
		boolean endpointStandable = goalEndpoint(world, resolvedEndpointPosition)
				&& Double.isFinite(world.supportHeight(
						resolvedEndpointPosition,
						resolvedEndpointTarget.x,
						resolvedEndpointTarget.z));
		boolean withinTolerance = withinEndpoint(player.position());
		boolean physicallyValid = endpointStandable && withinTolerance
				&& player.level().noCollision(player.getBoundingBox())
				&& !player.isInWall() && player.onGround();
		if (!physicallyValid) {
			endpointStabilityPosition = null;
			endpointStabilityConfirmed = false;
			return null;
		}
		Vec3 motion = player.getDeltaMovement();
		if (fireAhead(world, player.getBoundingBox(), motion)) {
			// Letting go here would slide the box into seen fire or lava beside the endpoint: press against the motion
			// until it stops (a navigate_to that stopped 0.2 past the middle of a cell with lava on two sides slid into it).
			endpointStabilityPosition = null;
			endpointStabilityConfirmed = false;
			brake(player, motion);
			return TickResult.running(lastProgressValue);
		}
		if (endpointStabilityPosition != null
				&& player.position().distanceTo(endpointStabilityPosition) <= ENDPOINT_STABILITY_DISTANCE) {
			endpointStabilityConfirmed = true;
			return succeed(player, "DESTINATION_REACHED", "Destination reached at a verified standing position");
		}
		endpointStabilityPosition = player.position();
		endpointStabilityConfirmed = false;
		cancel(player);
		return TickResult.running(lastProgressValue);
	}

	private double navigationProgress(Vec3 position) {
		Vec3 target = resolvedEndpointTarget == null ? destination : resolvedEndpointTarget;
		if (navigationStartPosition == null) navigationStartPosition = position;
		return progressFromActualDistance(navigationStartPosition, target, position, lastProgressValue);
	}

	boolean withinEndpoint(Vec3 position) {
		return resolvedEndpointTarget != null
				&& satisfiesDestinationTolerance(position.distanceTo(resolvedEndpointTarget), tolerance)
				&& (arrivalRegion != null ? arrivalRegion.contains(position)
						: satisfiesRequestedEndpoint(position, resolvedEndpointPosition, resolvedEndpointTarget));
	}

	boolean satisfiesRequestedEndpoint(Vec3 position, GridPosition endpoint, Vec3 endpointTarget) {
		// Exact-cell partial support deliberately resolves requested Y to its collision surface.
		// A relocated endpoint must also satisfy the original radius, rather than granting it twice.
		Vec3 requestedTarget = endpoint.equals(grid(destination)) ? endpointTarget : destination;
		return satisfiesDestinationTolerance(position.distanceTo(requestedTarget), tolerance);
	}

	static double progressFromActualDistance(Vec3 start, Vec3 endpoint, Vec3 current, double previousProgress) {
		Objects.requireNonNull(start, "start must not be null");
		Objects.requireNonNull(endpoint, "endpoint must not be null");
		Objects.requireNonNull(current, "current must not be null");
		double startDistance = start.distanceTo(endpoint);
		double remaining = current.distanceTo(endpoint);
		if (!Double.isFinite(startDistance) || !Double.isFinite(remaining)) return previousProgress;
		double currentProgress = startDistance <= 1.0E-7D
				? (remaining <= 1.0E-7D ? 1.0D : 0.0D)
				: 1.0D - remaining / startDistance;
		if (!Double.isFinite(currentProgress)) return previousProgress;
		return Math.max(0.0D, Math.min(1.0D, currentProgress));
	}

	private boolean reachedTarget(
			MinecraftNavigationWorld world,
			Vec3 playerPosition,
			PathNode waypoint,
			boolean finalWaypoint
	) {
		if (!supportedEndpoint(world, waypoint.position())
				&& !(finalWaypoint && submergedFloor(world, waypoint.position()))
				&& (waypoint.traversal() == TraversalType.SWIM || waypoint.traversal() == TraversalType.CLIMB)) {
			Vec3 target = targetFor(world, waypoint, finalWaypoint);
			double dx = playerPosition.x - target.x;
			double dz = playerPosition.z - target.z;
			return dx * dx + dz * dz <= INTERMEDIATE_WAYPOINT_HORIZONTAL_TOLERANCE_SQUARED
					&& Math.abs(playerPosition.y - target.y) <= (waypoint.traversal() == TraversalType.SWIM ? 0.7D : 0.25D);
		}
		return reachedTarget(
				playerPosition,
				waypoint,
				finalWaypoint,
				world.supportHeight(waypoint.position(), playerPosition.x, playerPosition.z)
		);
	}

	private static boolean hasFullBlockSupportHeight(GridPosition position, double supportHeight) {
		return Math.abs(supportHeight - position.y()) < 1.0E-7D;
	}

	private boolean targetsExactDestination(PathNode waypoint, boolean finalWaypoint) {
		return finalWaypoint && arrivalRegion == null && waypoint.position().equals(grid(destination));
	}

	private TickResult replan(
			ServerPlayer player,
			MinecraftNavigationWorld world,
			long nowEpochMs,
			long elapsedMs,
			boolean recovery
	) {
		if (ServerPathPlanner.currentBudget() == null) {
			try (ServerPathPlanner.TickScope ignored = ServerPathPlanner.beginServerTick()) {
				return replan(player, world, nowEpochMs, elapsedMs, recovery);
			}
		}
		if (continuation.waiting(elapsedMs)) {
			lookForContinuation(player, nowEpochMs);
			return TickResult.running(currentProgress());
		}
		GridPosition actualOrigin = grid(player.position());
		// Floating at a water surface bobs the feet across a block boundary every few ticks while the route is planned.
		// That is the same place: restarting the search on each bob kept a large search from ever finishing (a body
		// floating still for the whole action timeout in the replayed play-test).
		if (searchOrigin != null && player.isInWater() && sameSwimColumn(searchOrigin, actualOrigin)) actualOrigin = searchOrigin;
		invalidatePlanning(actualOrigin, searchWorld == null || (searchWorld.matchesMovement(player)
				&& searchWorld.isCurrent(dev.agaminggod.arenaagents.server.perception.SeenTerrain.of(player))));
		if (search == null) {
			if (preparation == null) {
				// Keep the lease and sprint through planning; releasing here made every replan a visible
				// stop, sprint drop and re-acceleration (the sprint-walk-sprint gait).
				coast(player);
				plan = null;
				searchWorld = world;
				searchOrigin = actualOrigin;
				searchRecovery = recovery;
				continuation.searching();
				preparation = new Preparation(actualOrigin, destination, tolerance, arrivalRegion, player.position());
			}
			ServerPathPlanner.TickBudget budget = ServerPathPlanner.currentBudget();
			if (!preparation.advance(searchWorld, position -> searchWorld.supportHeight(
					position, position.x() + 0.5D, position.z() + 0.5D), budget::tryPrepare)) {
				coast(player);
				return TickResult.running(currentProgress());
			}
			GridPosition start = preparation.start;
			if (start == null) {
				if (player.isUnderWater()) return breathe(player, nowEpochMs, elapsedMs, 0, true);
				if (displacement.missingStart()) {
					coast(player);
					return TickResult.running(currentProgress());
				}
				if (searchWorld.hasUnknown()) return retrySeenRoute(player, world, nowEpochMs, elapsedMs, "Start clearance or support is unseen");
				return fail(player, "NO_STANDABLE_PATH", "Start has no supported, climbable or swimmable position" + magmaDetail(world), currentProgress());
			}
			searchGoals = Set.copyOf(preparation.goals);
			if (preparation.destinationHasNoSupport) {
				if (player.isUnderWater()) return breathe(player, nowEpochMs, elapsedMs, 0, true);
				return fail(player, "NO_STANDABLE_PATH", "Destination has no supported arrival region that can be approached within the requested tolerance" + magmaDetail(world), currentProgress());
			}
			preparation = null;
			search = planner.beginSearch(start, searchGoals, grid(destination), (int) MAX_LOCAL_PLANNING_DISTANCE, previousFrontiers,
					SwimPlanning.navigationBreathNodes(player.getAirSupply(), breathableDestination(searchWorld, destination)));
		}
		ServerPathPlanner.PlanningResult planning = planner.resume(search, searchWorld);
		if (planning.deferred()) {
			coast(player);
			return TickResult.running(currentProgress());
		}
		PathPlan candidate = planning.plan();
		LocalPathfinder.Search finishedSearch = search;
		boolean unknownEndpoint = search.endedAtUnknown();
		search = null;
		if (candidate.outcome() != PathOutcome.FOUND) {
			if (player.isUnderWater()) return breathe(player, nowEpochMs, elapsedMs, 0, true);
			if (searchWorld.hasUnknown()) return retrySeenRoute(player, world, nowEpochMs, elapsedMs, "No seen continuation");
			return fail(player, candidate.outcome() == PathOutcome.NODE_LIMIT ? "PATH_LIMIT_REACHED" : "NO_PATH",
					"No local route found"
						+ (candidate.outcome() == PathOutcome.NO_PATH ? exploredDetail(finishedSearch, !searchWorld.hasUnknown()) + magmaDetail(world) : ""), currentProgress());
		}
		if (candidate.nodes().size() > DEFAULT_MAX_PATH_LENGTH) {
			candidate = new PathPlan(candidate.nodes().subList(0, DEFAULT_MAX_PATH_LENGTH), PathOutcome.FOUND, candidate.expandedNodes());
			unknownEndpoint = false;
		}
		GridPosition endpoint = candidate.nodes().getLast().position();
		boolean finalSegment = searchGoals.contains(endpoint);
		if (!finalSegment && (endpoint.equals(searchOrigin) || endpoint.equals(reachedUnknownFrontier))) {
			return retrySeenRoute(player, world, nowEpochMs, elapsedMs, "No seen continuation");
		}
		if (nonImprovingUnknownContinuation(reachedUnknownFrontier, player.position(),
				targetFor(searchWorld, candidate.nodes().getLast(), false), destination,
				finalSegment, unknownEndpoint, player.isUnderWater())) {
			return fail(player, "REACHED_FRONTIER", frontierMessage(reachedUnknownFrontier) + "; selected continuation gets no closer; other routes unverified", currentProgress());
		}
		GridPosition flowEntry = lavaFlowEntry(world, candidate.nodes());
		if (flowEntry != null) {
			// d22-nether2: a one-cell move into a tunnel cell beside lava a break had just opened; the lava flowed in
			// 0.1 s after arrival. A player does not step into the cell a flow is about to fill; a body already in one
			// may cross such cells to get out.
			return fail(player, "LAVA_FLOW", lavaFlowMessage(player, flowEntry), currentProgress());
		}
		continuation.accepted();
		continuationHealth = Double.NaN;
		if (!finalSegment) {
			previousFrontiers.add(endpoint);
			while (previousFrontiers.size() > 512) previousFrontiers.remove(previousFrontiers.getFirst());
		}
		plan = candidate;
		acceptedLavaContacts = lavaContacts(world, candidate.nodes());
		acceptedHazards = hazardCells(world, candidate.nodes());
		reachedUnknownFrontier = null;
		planEndsAtUnknown = !finalSegment && unknownEndpoint;
		gapSprintGuard.retainPlan(plan.nodes());
		if (TICK_DIAGNOSTICS_ENABLED) {
			LOGGER.info("NAV_PLAN tick={} nodes={} finalSegment={} recovery={} expanded={} etaSeconds={}",
					player.level().getGameTime(), candidate.nodes().size(), finalSegment, recovery, candidate.expandedNodes(), candidate.estimatedTravelSeconds(world, sprint));
		}
		if (finalSegment) {
			PathNode finalNode = candidate.nodes().get(candidate.nodes().size() - 1);
			resolvedEndpointTarget = null;
			resolvedEndpointPosition = finalNode.position();
			resolvedEndpointTarget = targetFor(world, finalNode, true);
			if (arrivalRegion == null && !targetsExactDestination(finalNode, true)) {
				Vec3 inward = world.inwardStandingTarget(finalNode.position(), destination, player.getBoundingBox());
				if (inward != null && inward.distanceTo(destination) < tolerance) resolvedEndpointTarget = inward;
			}
			endpointStabilityPosition = null;
			endpointStabilityConfirmed = false;
		} else {
			resolvedEndpointPosition = null;
			resolvedEndpointTarget = null;
			endpointStabilityPosition = null;
			endpointStabilityConfirmed = false;
		}
		waypointIndex = Math.min(1, Math.max(0, candidate.nodes().size() - 1));
		PathNode activeWaypoint = candidate.nodes().get(waypointIndex);
		boolean finalWaypoint = waypointIndex == candidate.nodes().size() - 1;
		double activeWaypointDistance = player.position().distanceTo(targetFor(world, activeWaypoint, finalWaypoint));
		routeTargets = new Vec3[candidate.nodes().size()];
		routeTail = new double[routeTargets.length];
		for (int i = routeTargets.length - 1; i >= 0; i--) {
			routeTargets[i] = targetFor(world, candidate.nodes().get(i), i == routeTargets.length - 1);
			if (i + 1 < routeTargets.length) routeTail[i] = routeTail[i + 1] + routeTargets[i].distanceTo(routeTargets[i + 1]);
		}
		route.beginPlan(routeRemaining(player.position()));
		if (progress == null) {
			progress = new WaypointProgress(activeWaypointDistance, nowEpochMs, STALL_TIMEOUT_MS, MAX_REPLANS);
		} else if (searchRecovery) {
			progress.replanned(activeWaypointDistance, nowEpochMs);
		} else {
			progress.waypointAdvanced(activeWaypointDistance, nowEpochMs);
		}
		return null;
	}

	/** A recheck may reveal a complete detour, but a worse unknown boundary is a new route choice for the player.
	 * Weighted path heuristics and a changing view can otherwise replace the reached frontier with a backtrack.
	 * Known radius continuations keep their ordinary execution paths.
	 */
	static boolean nonImprovingUnknownContinuation(GridPosition reached, Vec3 body, Vec3 endpoint,
			Vec3 destination, boolean finalSegment, boolean unknownEndpoint, boolean underWater) {
		return reached != null && !finalSegment && unknownEndpoint && !underWater
				&& endpoint.distanceToSqr(destination) >= body.distanceToSqr(destination);
	}

	private double routeRemaining(Vec3 body) {
		if (plan == null || routeTargets == null || waypointIndex >= routeTargets.length) return Double.NaN;
		return body.distanceTo(routeTargets[waypointIndex]) + routeTail[waypointIndex];
	}

	static boolean breathableDestination(WalkabilityView world, Vec3 destination) {
		return surfaceEndpoint(world, grid(destination));
	}

	static boolean sameSwimColumn(GridPosition searchOrigin, GridPosition actual) {
		return searchOrigin.x() == actual.x() && searchOrigin.z() == actual.z() && Math.abs(searchOrigin.y() - actual.y()) == 1;
	}

	/** Surface planning reads acquired water and clearance, never hidden columns. */
	static SwimPlanning.ColumnView columnView(MinecraftNavigationWorld world) {
		return (x, y, z) -> {
			net.minecraft.core.BlockPos position = new net.minecraft.core.BlockPos(x, y, z);
			var state = world.stateAt(position);
			if (state == null) return SwimPlanning.Cell.UNKNOWN;
			WalkabilityView.Cell cell = world.cellAt(new GridPosition(x, y, z));
			if (cell == WalkabilityView.Cell.UNLOADED) return SwimPlanning.Cell.UNKNOWN;
			if (state.is(net.minecraft.world.level.block.Blocks.BUBBLE_COLUMN)) {
				return state.getValue(net.minecraft.world.level.block.BubbleColumnBlock.DRAG_DOWN)
						? SwimPlanning.Cell.SINKING_WATER : SwimPlanning.Cell.RISING_WATER;
			}
			if (cell == WalkabilityView.Cell.WATER || state.is(net.minecraft.world.level.block.Blocks.WATER)) return SwimPlanning.Cell.WATER;
			return cell == WalkabilityView.Cell.CLEAR ? SwimPlanning.Cell.OPEN : SwimPlanning.Cell.SOLID;
		};
	}

	private TickResult breathe(ServerPlayer player, long nowEpochMs, long elapsedMs, int submerged, boolean noRoute) {
		if (breathing == null) {
			String reason = NavigationBreathing.reason(player.isUnderWater(), player.getAirSupply(), submerged, noRoute);
			if (reason == null) return null;
			breathing = new NavigationBreathing(reason, player.getAirSupply(), submerged, noRoute, elapsedMs);
			plan = null;
			discardPlanning();
		}
		var lookup = player.isUnderWater()
				? dev.agaminggod.arenaagents.server.perception.WaterAirFacts.surface(player)
				: new dev.agaminggod.arenaagents.server.perception.WaterAirFacts.SurfaceLookup(null, false);
		var step = breathing.tick(player.isUnderWater(), player.getAirSupply(), player.getEyePosition(), player.getEyeHeight(), lookup, elapsedMs, currentProgress());
		if (step.result() != null) return fail(player, step.result().reasonCode(), step.result().message(), currentProgress());
		if (step.eyeTarget() == null) { coast(player); return TickResult.running(currentProgress()); }
		Vec3 feetTarget = player.position().add(step.eyeTarget().subtract(player.getEyePosition()));
		if (!navigationWorld(player).knownSwimLine(player.position(), feetTarget, player.getBoundingBox())) {
			var stopped = breathing.stop(player.getAirSupply(), "No current acquired swimming clearance to next air-route cell", currentProgress()).result();
			return fail(player, stopped.reasonCode(), stopped.message(), currentProgress());
		}
		surface(player, nowEpochMs, step.eyeTarget());
		return TickResult.running(currentProgress());
	}

	private void surface(ServerPlayer player, long nowEpochMs, Vec3 eyeTarget) {
		if (inputLease == null) {
			inputController = AgentInputRuntime.controller(player);
			inputLease = inputController.acquire(AgentInputRuntime.requireAgentId(player), InputOwner.NAVIGATION, 100);
		}
		if (motorState == null) motorState = AgentInputStates.MotorState.initial(player.getYRot(), player.getXRot());
		double dx = eyeTarget.x - player.getX(), dz = eyeTarget.z - player.getZ();
		boolean across = dx * dx + dz * dz > 0.04D;
		float yaw = across ? net.minecraft.util.Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-dx, dz))) : motorState.yaw();
		boolean rise = eyeTarget.y > player.getEyePosition().y + 0.05;
		boolean swimSprint = across && SwimPlanning.swimSprint(true, true, 1.0F, player.getFoodData().getFoodLevel());
		var step = AgentInputStates.stepMotor(motorState,
				new AgentInputStates.MotorTarget(yaw, rise ? SwimPlanning.SURFACING_PITCH : 0, across, rise, swimSprint), nowEpochMs);
		motorState = step.state(); lastSprint = step.sprint() && !crouched;
		inputController.apply(inputLease, new dev.agaminggod.arenaagents.server.runtime.input.AgentInputState(
				step.forward(), step.strafe(), step.jump(), crouched, lastSprint, false, false,
				step.state().yaw(), step.state().pitch(), player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
	}

	/** One tick of keys pressing straight against the horizontal motion, the view held. */
	private void brake(ServerPlayer player, Vec3 motion) {
		if (inputLease == null) {
			inputController = AgentInputRuntime.controller(player);
			inputLease = inputController.acquire(AgentInputRuntime.requireAgentId(player), InputOwner.NAVIGATION, 100);
		}
		float yaw = motorState == null ? player.getYRot() : motorState.yaw(), pitch = motorState == null ? player.getXRot() : motorState.pitch();
		float[] keys = brakeInput(motion, yaw);
		lastSprint = false;
		inputController.apply(inputLease, new dev.agaminggod.arenaagents.server.runtime.input.AgentInputState(
				keys[0], keys[1], false, crouched, false, false, false, yaw, pitch,
				player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
	}

	/** Holds the lease, view and sprint with no movement keys while a route is being planned. */
	private void coast(ServerPlayer player) {
		if (inputLease == null || motorState == null) return;
		// Afloat, keep holding jump while planning; releasing it sank the body back under between plans.
		inputController.apply(inputLease, new dev.agaminggod.arenaagents.server.runtime.input.AgentInputState(
				0.0F, 0.0F, SwimPlanning.floatJump(player.isInWater(), player.onGround(), player.isUnderWater()), crouched,
				!crouched && lastSprint && !gapSprintGuard.active() && player.getFoodData().getFoodLevel() > 6,
				false, false, motorState.yaw(), motorState.pitch(),
				player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND
		));
	}

	/** How many route cells ahead of the body are watched for lava spreading beside them (a flow moves a cell per 0.5-1.5 s). */
	static final int LAVA_LOOKAHEAD_NODES = 6;

	static Set<GridPosition> lavaContacts(WalkabilityView world, List<PathNode> nodes) {
		Set<GridPosition> contacts = new java.util.HashSet<>();
		for (PathNode node : nodes) if (world.lavaFlowsInto(node.position())) contacts.add(node.position());
		return contacts;
	}

	/**
	 * The first route cell after the start that seen lava fills next (see {@link WalkabilityView#lavaFillsNext}), or
	 * null when there is none or the start is itself such a cell (the body is in the flow's way and may walk out).
	 */
	static GridPosition lavaFlowEntry(WalkabilityView world, List<PathNode> nodes) {
		if (nodes.isEmpty() || world.lavaFillsNext(nodes.getFirst().position())) return null;
		for (int i = 1; i < nodes.size(); i++) if (world.lavaFillsNext(nodes.get(i).position())) return nodes.get(i).position();
		return null;
	}

	/** Names the refused cell and the known lava that flows into it (beside the feet or head, or over the head). */
	static String lavaFlowMessage(ServerPlayer player, GridPosition cell) {
		var seen = dev.agaminggod.arenaagents.server.perception.SeenTerrain.of(player);
		String lava = null;
		int[][] offsets = {{0, 0, 0}, {0, 1, 0}, {0, 2, 0}, {1, 0, 0}, {-1, 0, 0}, {0, 0, 1}, {0, 0, -1}, {1, 1, 0}, {-1, 1, 0}, {0, 1, 1}, {0, 1, -1}};
		for (int[] o : offsets) {
			int x = cell.x() + o[0], y = cell.y() + o[1], z = cell.z() + o[2];
			net.minecraft.world.level.block.state.BlockState state = seen.known(x, y, z);
			if (state != null && state.getFluidState().getType().isSame(net.minecraft.world.level.material.Fluids.LAVA)) {
				lava = x + "," + y + "," + z;
				break;
			}
		}
		return "Route enters " + cell.x() + "," + cell.y() + "," + cell.z() + ", where seen lava" + (lava == null ? "" : " at " + lava)
				+ " flows next; not entered. Keep out of the flow's way, or block the lava first";
	}

	/** Whether seen lava now flows into a route cell within the look-ahead that it did not reach when the route was chosen. */
	static boolean lavaReachesRouteAhead(WalkabilityView world, List<PathNode> nodes, int from, Set<GridPosition> accepted) {
		for (int i = Math.max(0, from - 1); i < nodes.size() && i <= from + LAVA_LOOKAHEAD_NODES; i++) {
			GridPosition cell = nodes.get(i).position();
			if (!accepted.contains(cell) && world.lavaFlowsInto(cell)) return true;
		}
		return false;
	}

	/** Route cells whose body or head cell holds a seen hazard (fire, a campfire, a berry bush). */
	static Set<GridPosition> hazardCells(WalkabilityView world, List<PathNode> nodes) {
		Set<GridPosition> cells = new java.util.HashSet<>();
		for (PathNode node : nodes) if (hazardAt(world, node.position())) cells.add(node.position());
		return cells;
	}

	private static boolean hazardAt(WalkabilityView world, GridPosition cell) {
		return world.cellAt(cell) == WalkabilityView.Cell.HAZARD || world.cellAt(cell.above()) == WalkabilityView.Cell.HAZARD;
	}

	/** Whether a seen hazard now fills a route cell within the look-ahead that held none when the route was chosen. */
	static boolean hazardReachesRouteAhead(WalkabilityView world, List<PathNode> nodes, int from, Set<GridPosition> accepted) {
		for (int i = Math.max(0, from); i < nodes.size() && i <= from + LAVA_LOOKAHEAD_NODES; i++) {
			GridPosition cell = nodes.get(i).position();
			if (!accepted.contains(cell) && hazardAt(world, cell)) return true;
		}
		return false;
	}

	static boolean dangerousGapRunout(WalkabilityView world, GridPosition departure, GridPosition landing) {
		GridPosition beyond = landing.offset(Integer.signum(landing.x() - departure.x()), 0,
				Integer.signum(landing.z() - departure.z()));
		for (GridPosition body : List.of(beyond, beyond.above())) {
			WalkabilityView.Cell cell = world.cellAt(body);
			if (cell == WalkabilityView.Cell.HAZARD || cell == WalkabilityView.Cell.UNLOADED) return true;
		}
		for (int depth = 1; depth <= LocalPathfinder.MAX_DROP_BLOCKS + 1; depth++) {
			WalkabilityView.Cell cell = world.cellAt(beyond.below(depth));
			if (cell == WalkabilityView.Cell.HAZARD || cell == WalkabilityView.Cell.UNLOADED) return true;
			if (cell == WalkabilityView.Cell.SAFE_SUPPORT || cell == WalkabilityView.Cell.WATER) return false;
		}
		return true;
	}

	static final class GapSprintGuard {
		private GridPosition landing;
		private boolean airborne;
		private int settledTicks;
		private GridPosition completed;
		private WalkabilityView sampledWorld;
		private GridPosition sampledDeparture, sampledLanding;
		private boolean sampledDanger;

		boolean dangerous(WalkabilityView world, GridPosition departure, GridPosition destination) {
			if (sampledWorld != world || !departure.equals(sampledDeparture) || !destination.equals(sampledLanding)) {
				sampledWorld = world;
				sampledDeparture = departure;
				sampledLanding = destination;
				sampledDanger = dangerousGapRunout(world, departure, destination);
			}
			return sampledDanger;
		}

		void forgetSample() { sampledWorld = null; }

		boolean active() { return landing != null; }

		void retainPlan(List<PathNode> nodes) {
			if (landing != null && nodes.stream().noneMatch(node -> node.position().equals(landing))) {
				landing = null;
				airborne = false;
				settledTicks = 0;
			}
		}

		boolean suppress(WalkabilityView world, GridPosition dangerousLanding, Vec3 position, boolean onGround) {
			if (landing == null && dangerousLanding == null) completed = null;
			if (landing == null && dangerousLanding != null && !dangerousLanding.equals(completed)) {
				landing = dangerousLanding;
				airborne = false;
				settledTicks = 0;
			}
			if (landing == null) return false;
			if (!onGround) { airborne = true; settledTicks = 0; }
			GridPosition current = grid(position);
			// A missed landing or a corner cut can settle on other support. Three grounded ticks establish that flight ended.
			if (airborne && onGround && dangerousLanding == null && world.isStandable(current)) settledTicks++;
			else settledTicks = 0;
			// A waypoint can advance in midair. Keep walking pace until the body actually settles on support.
			if (settledTicks >= 3 || airborne && onGround && current.equals(landing) && world.isStandable(current)
					&& Math.abs(position.y - current.y()) < 0.25D
					&& Math.abs(position.x - current.x() - 0.5D) < 0.35D
					&& Math.abs(position.z - current.z() - 0.5D) < 0.35D) {
				completed = landing;
				landing = null;
				airborne = false;
				settledTicks = 0;
				return true;
			}
			return true;
		}
	}

	private void drive(
			ServerPlayer player,
			MinecraftNavigationWorld world,
			PathNode waypoint,
			Vec3 target,
			Vec3 steer,
			boolean steerIsEndpoint,
			boolean steerIsWaypoint,
			long nowEpochMs
	) {
		landingCheck.track(waypoint.traversal(), target, player.onGround());
		boolean gapJump = waypoint.traversal() == TraversalType.JUMP_GAP;
		boolean drop = waypoint.traversal() == TraversalType.DROP_DOWN;
		GridPosition guardedLanding = (gapJump || drop) && waypointIndex > 0
				&& gapSprintGuard.dangerous(world, plan.nodes().get(waypointIndex - 1).position(), waypoint.position())
				? waypoint.position() : null;
		if (drop && guardedLanding != null) {
			dropDeparture = plan.nodes().get(waypointIndex - 1).position();
			dropLanding = guardedLanding;
		}
		boolean suppressSprint = gapSprintGuard.suppress(world, guardedLanding, player.position(), player.onGround());
		if (!gapSprintGuard.active()) dropDeparture = dropLanding = null;
		// A drop whose landing has unseen ground, a hazard or a further drop past it: crouch to the lip and step off from
		// there, then press against any motion that would carry the body past the landing's middle. A sprinting leg ran off
		// a ledge onto soul sand two blocks down and its momentum took it on into an unseen lava hole (lug6z1, 2026-10-24).
		boolean edgeCrouch = false, runoutBrake = false;
		if (dropLanding != null) {
			int sx = Integer.signum(dropLanding.x() - dropDeparture.x()), sz = Integer.signum(dropLanding.z() - dropDeparture.z());
			double along = (player.getX() - dropDeparture.x() - 0.5D) * sx + (player.getZ() - dropDeparture.z() - 0.5D) * sz;
			double speed = player.getDeltaMovement().x * sx + player.getDeltaMovement().z * sz;
			boolean onDeparture = player.getY() > dropLanding.y() + 0.75D;
			if (player.onGround() && onDeparture && dropDeparture.y() - dropLanding.y() >= 2) {
				edgeCrouch = drop && along >= DROP_CROUCH_FROM && along < DROP_STEP_OFF;
			} else if (!onDeparture || !player.onGround()) {
				runoutBrake = speed > 0.0D && along + speed * FIRE_LOOKAHEAD_TICKS > DROP_RUNOUT_LIMIT;
			}
		}
		boolean swimming = waypoint.traversal() == TraversalType.SWIM || player.isInWater();
		// Over a submerged-floor endpoint let go of space and sink onto it, as a player does to stand on a flooded floor.
		boolean settleOnFloor = waypoint.position().equals(resolvedEndpointPosition) && submergedFloor(world, waypoint.position());
		boolean climbing = waypoint.traversal() == TraversalType.CLIMB;
		boolean crouching = waypoint.traversal() == TraversalType.CROUCH;
		double climbDx = player.getX() - target.x;
		double climbDz = player.getZ() - target.z;
		boolean atClimbColumn = climbDx * climbDx + climbDz * climbDz <= 0.16D;
		boolean descendingClimb = climbing && atClimbColumn && target.y < player.getY() - 0.15D;
		if (inputLease == null) {
			inputController = AgentInputRuntime.controller(player);
			inputLease = inputController.acquire(AgentInputRuntime.requireAgentId(player), InputOwner.NAVIGATION, 100);
		}
		if (motorState == null) motorState = AgentInputStates.MotorState.initial(player.getYRot(), player.getXRot());
		double steerDx = steer.x - player.getX();
		double steerDz = steer.z - player.getZ();
		double steerHorizontal = Math.sqrt(steerDx * steerDx + steerDz * steerDz);
		boolean walkingOnGround = !swimming && !climbing && !crouching && !gapJump && player.onGround();
		// Swimming and climbing move where the view points (no separate walk direction), so they never hold the
		// heading near a point: a swimmer that held it swam on past the point, looped back and stalled.
		Heading heading = heading(motorState.yaw(), steerDx, steerDz, steerIsEndpoint,
				walkingOnGround && steerIsWaypoint ? gazeYaw(player.position(), plan.nodes(), waypointIndex) : Float.NaN,
				!swimming && !climbing);
		float targetYaw = heading.viewYaw();
		float moveYaw = swimming || climbing ? Float.NaN : heading.moveYaw();
		float targetPitch;
		if (swimming || climbing) {
			Vec3 delta = target.add(0.0D, 0.85D, 0.0D).subtract(player.getEyePosition());
			targetPitch = net.minecraft.util.Mth.clamp((float) -Math.toDegrees(
					Math.atan2(delta.y, Math.sqrt(delta.x * delta.x + delta.z * delta.z))), -90.0F, 90.0F);
		} else {
			targetPitch = EndermanGaze.clearPitch(player, targetYaw, walkingGazePitch(steer.y - player.getY(), steerHorizontal));
		}
		if (climbing && atClimbColumn) {
			net.minecraft.core.Direction wall = world.climbDirection(waypoint.position());
			if (wall != null) targetYaw = (float) Math.toDegrees(Math.atan2(-wall.getStepX(), wall.getStepZ()));
			moveYaw = Float.NaN;
		}
		float facing = motorState == null ? player.getYRot() : motorState.yaw();
		boolean jump = !lineUpForJump && !turningIntoNotch(world, plan == null ? List.of() : plan.nodes(), waypointIndex, facing)
				&& jumpPending(player, world, waypoint, target);
		// With sprint requested, sprint-swim while the eyes are under water (faster, steered by the view pitch).
		boolean sprintSwim = sprint && !settleOnFloor && SwimPlanning.swimSprint(player.isInWater(), player.isUnderWater(),
				1.0F, player.getFoodData().getFoodLevel());
		AgentInputStates.MotorStep step = AgentInputStates.stepMotor(
				motorState,
				new AgentInputStates.MotorTarget(
						targetYaw,
						targetPitch,
						!descendingClimb && (player.onGround() || swimming || climbing || steerHorizontal > 0.2D),
						jump,
						!suppressSprint && (sprintSwim || !swimming && !crouching && !climbing && (sprint || gapJump) && player.getFoodData().getFoodLevel() > 6),
						moveYaw
				),
				nowEpochMs
		);
		motorState = step.state();
		// About to touch seen fire (momentum or a corner carrying the box off the line): press against the motion this
		// tick, as a player taps back short of flames; the route then goes on past them or is replanned.
		Vec3 motion = player.getDeltaMovement();
		boolean fire = fireAhead(world, player.getBoundingBox(), motion)
				|| fireAhead(world, player.getBoundingBox(), inputMotion(motion, step.forward(), step.strafe(), step.state().yaw(), player.onGround()))
				|| runoutBrake;
		float[] brake = fire ? brakeInput(motion, step.state().yaw()) : null;
		if (fire && !runoutBrake && player.onGround() && !fireAhead(world, player.getBoundingBox(), motion)) {
			// A safe route through a cell can still clip fire when entered off centre. Settle within that same
			// standing cell before resuming, rather than alternating forward and back across the fire boundary.
			Vec3 centre = new Vec3(Math.floor(player.getX()) + 0.5D, player.getY(), Math.floor(player.getZ()) + 0.5D);
			Vec3 correction = centre.subtract(player.position()).scale(0.5D).subtract(motion.multiply(1, 0, 1));
			float[] centering = brakeInput(correction.scale(-1), step.state().yaw());
			float amount = (float) Math.min(1.0D, correction.horizontalDistance() / 0.1D);
			centering[0] *= amount;
			centering[1] *= amount;
			Vec3 next = inputMotion(motion, centering[0], centering[1], step.state().yaw(), true);
			if (!fireAhead(world, player.getBoundingBox(), next)
					&& player.level().noCollision(player.getBoundingBox().move(next.x, 0, next.z))) brake = centering;
		}
		lastSprint = step.sprint() && !fire && !edgeCrouch && !crouched;
		inputController.apply(inputLease, new dev.agaminggod.arenaagents.server.runtime.input.AgentInputState(
				fire ? brake[0] : step.forward(), fire ? brake[1] : step.strafe(), step.jump(), crouched || crouching || edgeCrouch, lastSprint,
				false, false, step.state().yaw(), step.state().pitch(),
				player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND
		));
	}

	/** Include this tick's acceleration: a brake can leave reverse velocity which forward input immediately reverses. */
	static Vec3 inputMotion(Vec3 motion, float forward, float strafe, float yaw, boolean onGround) {
		double length = Math.max(1.0D, Math.hypot(forward, strafe));
		double acceleration = onGround ? 0.13D : 0.026D;
		double sin = Math.sin(Math.toRadians(yaw)), cos = Math.cos(Math.toRadians(yaw));
		return motion.add((strafe * cos - forward * sin) / length * acceleration, 0,
				(forward * cos + strafe * sin) / length * acceleration);
	}

	/**
	 * Whether the body's box {@link #FIRE_LOOKAHEAD_TICKS} on at its current velocity touches a cell of seen fire (or the
	 * fluid of seen lava). Vanilla
	 * fire burns any box that touches its cell; route costs keep paths a cell away where there is room, and this stops the
	 * last few tenths a turn or momentum would add (a travel leg turning beside fire caught it, 2026-10-24). Airborne,
	 * the fall counts too, so a drop drifting toward flames beside its landing is braked.
	 */
	static boolean fireAhead(MinecraftNavigationWorld world, AABB box, Vec3 velocity) {
		return fireAhead(world::stateAt, box, velocity);
	}

	static boolean fireAhead(java.util.function.Function<net.minecraft.core.BlockPos, net.minecraft.world.level.block.state.BlockState> states,
			AABB box, Vec3 velocity) {
		double fall = velocity.y < -0.1D || velocity.y > 0.0D ? velocity.y * FIRE_LOOKAHEAD_TICKS : 0.0D;
		AABB next = box.move(velocity.x * FIRE_LOOKAHEAD_TICKS, fall, velocity.z * FIRE_LOOKAHEAD_TICKS).minmax(box);
		for (int x = (int) Math.floor(next.minX); x <= (int) Math.floor(next.maxX); x++) {
			for (int z = (int) Math.floor(next.minZ); z <= (int) Math.floor(next.maxZ); z++) {
				for (int y = (int) Math.floor(next.minY); y <= (int) Math.floor(next.maxY - 1.0E-7D); y++) {
					var state = states.apply(new net.minecraft.core.BlockPos(x, y, z));
					if (state == null) continue;
					AABB hazard = new AABB(x, y, z, x + 1, y + 1, z + 1);
					boolean flame = state.is(net.minecraft.world.level.block.Blocks.FIRE) || state.is(net.minecraft.world.level.block.Blocks.SOUL_FIRE);
					boolean lava = state.getFluidState().getType().isSame(net.minecraft.world.level.material.Fluids.LAVA);
					if (lava) hazard = new AABB(x, y, z, x + 1, y + Math.max(0.1D, state.getFluidState().getOwnHeight()), z + 1);
					// Strict intersection matters at a cell boundary: a tunnel retreat must move away when its box
					// merely touches the arriving lava. Only a newly intersected flame/fluid volume needs braking.
					if ((flame || lava) && next.intersects(hazard) && !box.intersects(hazard)) return true;
				}
			}
		}
		return false;
	}

	/**
	 * Ticks of motion {@link #fireAhead} looks over: a body letting go on ground slides v/(1-0.546), 2.2 ticks of its
	 * speed, and the check runs a tick before the move. Two ticks let a sprint arriving square at fire beside its waypoint
	 * slide 0.05 into the fire cell (entry9-fortress, 2026-10-24).
	 */
	static final double FIRE_LOOKAHEAD_TICKS = 3.0D;

	/**
	 * A guarded drop, along its direction from the departure cell's middle (the lip is 0.5, the landing's middle 1.0):
	 * crouched from {@link #DROP_CROUCH_FROM} so vanilla's edge back-off stops the body at the lip, upright again from
	 * {@link #DROP_STEP_OFF} so it steps off nearly from rest, and braked once its motion would carry the middle past
	 * {@link #DROP_RUNOUT_LIMIT} (the box then still clears the next cell's fluid by 0.1).
	 */
	static final double DROP_CROUCH_FROM = 0.0D, DROP_STEP_OFF = 0.7D, DROP_RUNOUT_LIMIT = 1.1D;
	private GridPosition dropDeparture, dropLanding;

	/** Forward and strafe (vanilla's input frame for this yaw) pressing straight against the body's horizontal motion. */
	static float[] brakeInput(Vec3 motion, float yaw) {
		double length = Math.hypot(motion.x, motion.z);
		if (length < 1.0E-4D) return new float[] {0.0F, 0.0F};
		double dx = -motion.x / length, dz = -motion.z / length;
		double sin = Math.sin(Math.toRadians(yaw)), cos = Math.cos(Math.toRadians(yaw));
		return new float[] {(float) (-dx * sin + dz * cos), (float) (dx * cos + dz * sin)};
	}

	/**
	 * The standing spot a requested cell names when that cell itself cannot be stood in, or null to keep the request:
	 * a seen solid block with seen standing room on top is a request to stand on it (block coordinates, as a landmark row
	 * gives them, are centred on the block), and a seen open cell over seen standing ground one lower is that ground. In
	 * two Sol Nether games on 2026-10-23, 14 of 55 NO_STANDABLE_PATH refusals named a seen solid block (5 by integer block
	 * coordinates, whose top is 1.22 from the request with tolerance 1). Unseen cells never move a request.
	 */
	public static Vec3 standingInColumn(WalkabilityView world, Vec3 requested) {
		GridPosition cell = grid(requested);
		if (world.isStandable(cell)) return null;
		WalkabilityView.Cell at = world.cellAt(cell);
		if ((at == WalkabilityView.Cell.SAFE_SUPPORT || at == WalkabilityView.Cell.BLOCKED) && world.isStandable(cell.above())) {
			boolean block = requested.x == Math.floor(requested.x) && requested.z == Math.floor(requested.z);
			return new Vec3(block ? cell.x() + 0.5D : requested.x, cell.y() + 1, block ? cell.z() + 0.5D : requested.z);
		}
		if (world.isBodyClear(cell) && world.isStandable(cell.below())) return new Vec3(requested.x, cell.y() - 1, requested.z);
		return null;
	}

	/** Largest sideways offset from a step-up's axis that still enters a one-wide landing (body half-width 0.3, slack 0.2). */
	static final double JUMP_LINE_UP = 0.15D;

	/**
	 * Ticks of sideways momentum a step-up jump carries before the body is over the landing (air keeps 0.91 a tick). A path
	 * turning 90 degrees into a notch at the takeoff cell jumped at once while still moving 0.14 a tick along the wall,
	 * drifted a block off the notch in the air and missed it 17 times in a row (entry9-fortress, 2026-10-24).
	 */
	static final double JUMP_DRIFT_TICKS = 5.0D;

	/**
	 * For a straight step up into a landing walled in at its sides (a one-wide notch in a wall), the takeoff cell's
	 * centre to line up on before jumping, or null when the body is lined up or the landing is open. The jump is pressed
	 * up to 1.2 blocks from the landing, so a body arriving 0.4 off the notch's centreline met its side wall in the air,
	 * fell back and missed the landing on every retry (236 MISSED_LANDING in a row on a scripted Nether course, 2026-10-24).
	 * Sideways momentum counts as offset ({@link #JUMP_DRIFT_TICKS}).
	 */
	static Vec3 jumpLineUp(WalkabilityView world, Vec3 body, Vec3 velocity, List<PathNode> nodes, int index) {
		if (!narrowStepUp(world, nodes, index)) return null;
		GridPosition from = nodes.get(index - 1).position(), to = nodes.get(index).position();
		int dx = Integer.signum(to.x() - from.x()), dz = Integer.signum(to.z() - from.z());
		double lateral = dx != 0 ? body.z - (from.z() + 0.5D) : body.x - (from.x() + 0.5D);
		double drift = dx != 0 ? velocity.z : velocity.x;
		return Math.abs(lateral + drift * JUMP_DRIFT_TICKS) <= JUMP_LINE_UP ? null : new Vec3(from.x() + 0.5D, from.y(), from.z() + 0.5D);
	}

	/** Whether waypoint {@code index} is a straight step up into a landing walled in at its sides (a one-wide notch). */
	static boolean narrowStepUp(WalkabilityView world, List<PathNode> nodes, int index) {
		if (index <= 0 || index >= nodes.size() || nodes.get(index).traversal() != TraversalType.JUMP_UP) return false;
		GridPosition from = nodes.get(index - 1).position(), to = nodes.get(index).position();
		int dx = Integer.signum(to.x() - from.x()), dz = Integer.signum(to.z() - from.z());
		if ((dx == 0) == (dz == 0)) return false;
		for (int side = -1; side <= 1; side += 2) {
			for (int dy = 0; dy <= 1; dy++) if (!world.isBodyClear(to.offset(dz * side, dy, dx * side))) return true;
		}
		return false;
	}

	/** Largest angle between the facing and a notch's axis at which its step-up jump is pressed. */
	static final float NOTCH_FACING_DEGREES = 20.0F;

	/**
	 * Whether a step up into a one-wide notch waits for the eased look to finish turning: vanilla's sprint jump pushes 0.2
	 * along the facing, so a jump pressed mid-turn (facing 136 degrees, notch at 90) shoved the body into the notch's side
	 * wall and it missed the landing 15 times in a row (entry9-fortress, 2026-10-24). A player faces the step, then jumps.
	 */
	static boolean turningIntoNotch(WalkabilityView world, List<PathNode> nodes, int index, float facing) {
		if (!narrowStepUp(world, nodes, index)) return false;
		GridPosition from = nodes.get(index - 1).position(), to = nodes.get(index).position();
		float axis = (float) Math.toDegrees(Math.atan2(-(to.x() - from.x()), to.z() - from.z()));
		return Math.abs(net.minecraft.util.Mth.wrapDegrees(facing - axis)) > NOTCH_FACING_DEGREES;
	}

	/** Wading is slow and a current can pin the body against a wall, so the fast blocked rule only judges dry ground. */
	private static boolean groundedOnLand(ServerPlayer player) {
		return player.onGround() && !player.isInWater();
	}

	private boolean jumpPending(ServerPlayer player, MinecraftNavigationWorld world, PathNode waypoint, Vec3 target) {
		boolean shallowWater = world.isShallowWater(waypoint.position());
		boolean swimming = waypoint.traversal() == TraversalType.SWIM || player.isInWater();
		boolean settleOnFloor = waypoint.position().equals(resolvedEndpointPosition) && submergedFloor(world, waypoint.position());
		boolean climbing = waypoint.traversal() == TraversalType.CLIMB;
		// Step and gap jumps are timed from the landing cell, as a player jumps at the step. An exact destination on a
		// block corner put the steering point 1.3 blocks from a body already pressed against the step, past the trigger,
		// so it walked into the step until the stall replans ran out.
		Vec3 landing = center(waypoint.position());
		double targetDx = landing.x - player.getX();
		double targetDz = landing.z - player.getZ();
		return jumpNeeded(waypoint.traversal(), target.y - player.getY(),
				Math.sqrt(targetDx * targetDx + targetDz * targetDz))
				|| shallowWater || SwimPlanning.navigationJump(swimming, target.y - player.getY(), settleOnFloor)
				|| (climbing && target.y > player.getY() + 0.15D);
	}

	/** Whether this move targets a seen portal, so crossing through it is its arrival. */
	public boolean targetsPortal() {
		return targetedPortal != null && !targetedPortal.isEmpty();
	}

	/**
	 * Opens the targeted portal's cells to step into. Read until the portal is seen (from the floor of a portal room
	 * the frame hides the pool; the stairs show it), then kept for the rest of the move.
	 */
	private MinecraftNavigationWorld portalAware(MinecraftNavigationWorld world) {
		if (!targetsPortal()) targetedPortal = world.targetedPortal(destination);
		if (!world.portalEntries().equals(targetedPortal)) world.allowPortalEntries(targetedPortal);
		return world;
	}

	private MinecraftNavigationWorld navigationWorld(ServerPlayer player) {
		var seen = dev.agaminggod.arenaagents.server.perception.SeenTerrain.of(player);
		if (navigationWorld == null || !navigationWorld.belongsTo(player.level())
				|| !navigationWorld.matchesMovement(player)) {
			previousFrontiers.clear();
			navigationWorld = new MinecraftNavigationWorld(player.level(), player);
		} else if (!navigationWorld.uses(seen)) {
			if (navigationWorld == searchWorld && (search != null || preparation != null)) {
				navigationWorld = new MinecraftNavigationWorld(player.level(), player);
			} else {
				navigationWorld.nextFrame(seen);
				gapSprintGuard.forgetSample();
			}
		}
		if (movementLevel != null) navigationWorld.onLevel(movementLevel);
		return portalAware(navigationWorld);
	}

	/**
	 * Only acquired search geometry can establish a pocket or exhausted edges. Unknown
	 * neighbours cannot establish either fact.
	 */
	static String exploredDetail(LocalPathfinder.Search search, boolean fullySeen) {
		if (!fullySeen || search == null || !search.finished()) return "";
		int cells = search.retainedNodes();
		int farthest = search.farthestExplored();
		return search.boundaryReached()
				? "; walking reaches " + cells + " cells up to " + farthest + " blocks away, and none leads to an untried edge"
				: "; the walkable area here is closed: " + cells + " cells, all within " + farthest + " blocks";
	}

	static String frontierMessage(GridPosition farthest) {
		return "Destination not reached; seen path ends at " + farthest.x() + "," + farthest.y() + "," + farthest.z()
				+ "; beyond unseen. Observe beyond the edge or choose another route before retrying";
	}

	private TickResult noSeenRoute(ServerPlayer player, String detail) {
		if (reachedUnknownFrontier != null) return fail(player, "REACHED_FRONTIER", detail + "; " + frontierMessage(reachedUnknownFrontier), currentProgress());
		return fail(player, "NO_SEEN_ROUTE", detail + "; " + frontierMessage(grid(player.position())), currentProgress());
	}

	private TickResult retrySeenRoute(ServerPlayer player, MinecraftNavigationWorld world, long nowEpochMs, long elapsedMs, String detail) {
		if (player.isUnderWater()) return breathe(player, nowEpochMs, elapsedMs, 0, true);
		resolvedEndpointPosition = null;
		resolvedEndpointTarget = null;
		endpointStabilityPosition = null;
		endpointStabilityConfirmed = false;
		boolean stable = continuation.stableAt(player.position());
		boolean exhausted = continuation.exhausted(player.position(), elapsedMs);
		discardPlanning();
		plan = null;
		if (exhausted) {
			boolean safeStanding = player.onGround() && !player.isInWater() && !player.isInLava()
					&& !player.isInWall() && player.level().noCollision(player.getBoundingBox())
					&& supportedEndpoint(world, grid(player.position()))
					&& Double.isFinite(world.supportHeight(grid(player.position()), player.getX(), player.getZ()));
			if (allowNearArrival && arrivalRegion == null && stable && safeStanding
					&& NavigationContinuation.nearUnseenTarget(world, player.position(), destination, tolerance)) {
				return fail(player, "DESTINATION_NEAR_UNVERIFIED", String.format(java.util.Locale.ROOT,
						"Stopped %.1f blocks from target (requested tolerance %s); target footing seen, remaining approach unverified",
						player.position().distanceTo(destination), tolerance), currentProgress());
			}
			return noSeenRoute(player, detail + " after " + NavigationContinuation.MAX_EMPTY_REPLANS + " observation replans");
		}
		lookForContinuation(player, nowEpochMs);
		return TickResult.running(currentProgress());
	}

	private void lookForContinuation(ServerPlayer player, long nowEpochMs) {
		if (!Double.isFinite(continuationHealth)) continuationHealth = player.getHealth();
		if (inputLease == null) {
			inputController = AgentInputRuntime.controller(player);
			inputLease = inputController.acquire(AgentInputRuntime.requireAgentId(player), InputOwner.NAVIGATION, 100);
		}
		if (motorState == null) motorState = AgentInputStates.MotorState.initial(player.getYRot(), player.getXRot());
		Vec3 ahead = destination.subtract(player.position());
		AgentInputStates.MotorStep step = AgentInputStates.stepMotor(motorState, new AgentInputStates.MotorTarget(
				(float) Math.toDegrees(Math.atan2(-ahead.x, ahead.z)), WALKING_GAZE_PITCH, false,
				SwimPlanning.floatJump(player.isInWater(), player.onGround(), player.isUnderWater()), false), nowEpochMs);
		motorState = step.state();
		lastSprint = false;
		inputController.apply(inputLease, new dev.agaminggod.arenaagents.server.runtime.input.AgentInputState(
				0.0F, 0.0F, step.jump(), crouched, false, false, false, motorState.yaw(), motorState.pitch(),
				player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
	}

	private static String magmaDetail(MinecraftNavigationWorld world) {
		return world.blockedMagma() ? "; magma blocks sampled passages without Fire Resistance or Frost Walker" : "";
	}

	private void noteReplan(String reason, ServerPlayer player) {
		if (!TICK_DIAGNOSTICS_ENABLED) return;
		LOGGER.info("NAV_REPLAN tick={} reason={} onGround={} waypoint={}/{}",
				player.level().getGameTime(), reason, player.onGround(), waypointIndex, plan == null ? 0 : plan.nodes().size());
	}

	private void logTickDiagnostics(ServerPlayer player, long durationNanos) {
		Vec3 position = player.position();
		Vec3 velocity = player.getDeltaMovement();
		Vec3 previous = diagnosticPreviousPosition;
		diagnosticPreviousPosition = position;
		String delta = previous == null ? "-" : String.format(java.util.Locale.ROOT, "%.4f,%.4f,%.4f",
				position.x - previous.x, position.y - previous.y, position.z - previous.z);
		String lease = "-";
		String winner = "-";
		try {
			var agentId = AgentInputRuntime.findAgentId(player).orElse(null);
			if (agentId != null) {
				var controller = AgentInputRuntime.existingController(player.level().getServer()).orElse(null);
				if (controller == null) throw new IllegalStateException("input controller is unavailable");
				var winningLease = controller.currentWinner(agentId).orElse(null);
				var winningState = controller.currentState(agentId).orElse(null);
				if (winningLease != null) lease = winningLease.owner() + ":" + winningLease.priority() + ":" + winningLease.sequence();
				if (winningState != null) winner = String.format(java.util.Locale.ROOT,
						"f%.2f,s%.2f,j%s,sp%s,y%.1f,p%.1f", winningState.forward(), winningState.strafe(),
						winningState.jump(), winningState.sprint(), winningState.yaw(), winningState.pitch());
			}
		} catch (RuntimeException error) {
			lease = "unavailable:" + error.getClass().getSimpleName();
		}
		String traversal = plan == null || waypointIndex >= plan.nodes().size()
				? "-" : plan.nodes().get(waypointIndex).traversal().name();
		if (HazardExits.contact(player) == HazardExits.Contact.FIRE) {
			StringBuilder cells = new StringBuilder();
			AABB box = player.getBoundingBox().inflate(0.35D, 0.0D, 0.35D);
			for (net.minecraft.core.BlockPos cell : net.minecraft.core.BlockPos.betweenClosed(net.minecraft.core.BlockPos.containing(box.minX, box.minY - 1, box.minZ), net.minecraft.core.BlockPos.containing(box.maxX, box.maxY, box.maxZ))) {
				if (!player.level().getBlockState(cell).is(net.minecraft.tags.BlockTags.FIRE)) continue;
				var seen = navigationWorld == null ? null : navigationWorld.stateAt(cell);
				cells.append(' ').append(cell.getX()).append(',').append(cell.getY()).append(',').append(cell.getZ())
						.append(seen == null ? ":unseen" : seen.is(net.minecraft.tags.BlockTags.FIRE) ? ":seen" : ":seen-as-" + seen.getBlock());
			}
			StringBuilder nodes = new StringBuilder();
			if (plan != null) for (int i = Math.max(0, waypointIndex - 3); i < Math.min(plan.nodes().size(), waypointIndex + 3); i++) {
				PathNode node = plan.nodes().get(i);
				nodes.append(' ').append(i).append(':').append(node.position().x()).append(',').append(node.position().y()).append(',')
						.append(node.position().z()).append(':').append(node.traversal());
			}
			LOGGER.info("NAV_FIRE tick={} pos={},{},{} vel={},{},{} fire=[{}] nodes=[{}]", player.level().getGameTime(),
					position.x, position.y, position.z, velocity.x, velocity.y, velocity.z, cells, nodes);
		}
		LOGGER.info("NAV_TICK tick={} elapsedMs={} durationUs={} pos={},{},{} dpos={} vel={},{},{} "
				+ "ground={} hcoll={} vcoll={} motor={} winner={} lease={} planNodes={} prep={} search={} waypoint={}/{} traversal={} "
				+ "fallDistance={} hurtTime={} hurtMarked={} target={}",
				player.level().getGameTime(), elapsedTime.elapsedMs(), durationNanos / 1_000L,
				position.x, position.y, position.z, delta, velocity.x, velocity.y, velocity.z,
				player.onGround(), player.horizontalCollision, player.verticalCollision,
				motorState == null ? "-" : String.format(java.util.Locale.ROOT, "f%.2f,s%.2f,j%s,sp%s",
						motorState.forward(), motorState.strafe(), motorState.jumpHeld(), lastSprint),
				winner, lease, plan == null ? 0 : plan.nodes().size(), preparation != null,
				search != null, waypointIndex, plan == null ? 0 : plan.nodes().size(), traversal,
				player.fallDistance, player.hurtTime, player.syncVelocity,
				diagnosticTarget == null ? "-" : String.format(java.util.Locale.ROOT, "%.2f,%.2f,%.2f", diagnosticTarget.x, diagnosticTarget.y, diagnosticTarget.z));
	}

	/**
	 * Jump only where the terrain needs it: next to a step taller than vanilla's step height, or from the
	 * take-off cell of a gap. Holding jump for the whole waypoint re-jumped on every landing short of the
	 * waypoint center, which read as a jump-walk-jump gait.
	 */
	static boolean jumpNeeded(TraversalType traversal, double rise, double horizontalDistance) {
		return switch (traversal) {
			case JUMP_UP -> rise > STEP_HEIGHT && horizontalDistance <= JUMP_UP_TRIGGER_DISTANCE;
			case JUMP_GAP -> horizontalDistance > GAP_TAKEOFF_MIN_DISTANCE
					&& horizontalDistance <= GAP_TAKEOFF_MAX_DISTANCE;
			default -> false;
		};
	}

	/**
	 * Steady gaze toward the steering point, tilted by the slope; avoids nodding at each node near the feet. Uphill it
	 * rises only to {@link #UPHILL_GAZE_PITCH} below the horizon: a level or raised walking view sweeps the eyes of
	 * endermen standing tens of blocks away (vanilla's stare tolerance widens with distance), and a raised walking gaze
	 * provoked an enderman 20 blocks away in a live End run (2026-10-20, killed by two endermen).
	 */
	static float walkingGazePitch(double rise, double horizontalDistance) {
		double run = Math.max(GAZE_MIN_HORIZONTAL, horizontalDistance);
		return net.minecraft.util.Mth.clamp(
				WALKING_GAZE_PITCH - (float) Math.toDegrees(Math.atan2(rise, run)), UPHILL_GAZE_PITCH, 60.0F);
	}

	/** Highest walking gaze: still below the horizon by more than an enderman's eye height subtends beyond a few blocks. */
	static final float UPHILL_GAZE_PITCH = 5.0F;

	/** View and walk direction for one tick; {@code moveYaw} is NaN when the body walks where it looks. */
	record Heading(float viewYaw, float moveYaw) {
	}

	/**
	 * Where to look and where to walk. Within {@link #HOLD_HEADING_DISTANCE} of the endpoint, or of a waypoint that
	 * has fallen behind (stepping down a stair carries the body past the cell center), the view keeps its heading
	 * and the keys step onto the point, as a player backs up half a block instead of spinning round to face it.
	 * Turning toward a point that close also swings wildly as atan2 sweeps around it; the play-test showed a
	 * 180 degree spin at the end of 76 of 117 short moves. Otherwise the view follows {@code gazeYaw} (the path
	 * ahead) when it is within {@link #MAX_GAZE_OFFSET_DEGREES} of the walk direction, else the walk direction.
	 */
	static Heading heading(float currentYaw, double dx, double dz, boolean endpoint, float gazeYaw) {
		return heading(currentYaw, dx, dz, endpoint, gazeYaw, true);
	}

	/** As above; with {@code mayHold} false (swimming, climbing) the view always turns toward a nearby point. */
	static Heading heading(float currentYaw, double dx, double dz, boolean endpoint, float gazeYaw, boolean mayHold) {
		double horizontal = Math.sqrt(dx * dx + dz * dz);
		// Directly over the point atan2 has no direction; holding the heading avoids a spurious turn.
		if (horizontal < 0.05D) return new Heading(currentYaw, Float.NaN);
		float moveYaw = net.minecraft.util.Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-dx, dz)));
		float offView = Math.abs(AgentInputStates.shortestAngleDelta(currentYaw, moveYaw));
		if (mayHold && horizontal < HOLD_HEADING_DISTANCE && (endpoint || offView > BEHIND_DEGREES)) {
			return new Heading(currentYaw, moveYaw);
		}
		if (!Float.isNaN(gazeYaw) && offView <= 90.0F
				&& Math.abs(AgentInputStates.shortestAngleDelta(moveYaw, gazeYaw)) <= MAX_GAZE_OFFSET_DEGREES) {
			return new Heading(gazeYaw, moveYaw);
		}
		return new Heading(moveYaw, Float.NaN);
	}

	/**
	 * Direction to the furthest of the next {@link #GAZE_LOOKAHEAD_NODES} walk, step and drop nodes, or NaN. Used
	 * where the straight-line lookahead stops (each level change of a stair): steering node by node there turns
	 * the view left and right at every step of a diagonal staircase, while a player looks down the stairs.
	 */
	static float gazeYaw(Vec3 position, List<PathNode> nodes, int index) {
		int furthest = -1;
		int last = Math.min(nodes.size() - 1, index + GAZE_LOOKAHEAD_NODES);
		for (int candidate = index; candidate <= last; candidate++) {
			TraversalType traversal = nodes.get(candidate).traversal();
			if (traversal != TraversalType.WALK && traversal != TraversalType.DROP_DOWN
					&& traversal != TraversalType.JUMP_UP) break;
			furthest = candidate;
		}
		if (furthest <= index) return Float.NaN;
		GridPosition far = nodes.get(furthest).position();
		double dx = far.x() + 0.5D - position.x;
		double dz = far.z() + 0.5D - position.z;
		if (dx * dx + dz * dz < GAZE_MIN_DISTANCE * GAZE_MIN_DISTANCE) return Float.NaN;
		return net.minecraft.util.Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-dx, dz)));
	}

	/**
	 * Index of the furthest node, up to {@link #STEERING_LOOKAHEAD_NODES} ahead, that the player can walk
	 * to in a straight line over standable cells at its own level. The planner only links cardinal
	 * neighbours, so following each node turns a diagonal route into a staircase of 90 degree turns.
	 */
	static int steeringIndex(WalkabilityView world, Vec3 position, List<PathNode> nodes, int index) {
		PathNode first = nodes.get(index);
		int level = first.position().y();
		if (first.traversal() != TraversalType.WALK || grid(position).y() != level) return index;
		int best = index;
		int last = Math.min(nodes.size() - 1, index + STEERING_LOOKAHEAD_NODES);
		for (int candidate = index + 1; candidate <= last; candidate++) {
			PathNode node = nodes.get(candidate);
			if (node.traversal() != TraversalType.WALK || node.position().y() != level) break;
			if (!clearWalkLine(world, position, center(node.position()), level)) break;
			best = candidate;
		}
		return best;
	}

	/**
	 * Index of a node within the lookahead window whose cell holds the player's feet, or -1. Nodes before it must be
	 * walk or drop nodes, which a body can step past or fly over, except that the waypoint itself may also be the
	 * landing of a gap jump or step-up. A body that overshoots a landing, or clears a short step on the way down, is
	 * already standing in a later cell; requiring it to walk back onto the skipped cell first cost about a second
	 * after most drops (measured on a headless server).
	 */
	static int occupiedWalkNode(List<PathNode> nodes, int index, GridPosition feet) {
		int last = Math.min(nodes.size() - 2, index + STEERING_LOOKAHEAD_NODES);
		for (int candidate = index; candidate <= last; candidate++) {
			PathNode node = nodes.get(candidate);
			TraversalType traversal = node.traversal();
			boolean passable = traversal == TraversalType.WALK || traversal == TraversalType.DROP_DOWN
					|| candidate == index && (traversal == TraversalType.JUMP_GAP || traversal == TraversalType.JUMP_UP);
			if (!passable) return -1;
			if (node.position().equals(feet)) return candidate;
		}
		return -1;
	}

	/**
	 * True when a grounded body at a walk or drop waypoint's level has gone past it toward the next walk or drop node,
	 * within {@link #HOLD_HEADING_DISTANCE} of its center. Without this the controller stepped back onto the waypoint
	 * (the heading hold below), though a player just keeps going down the stairs. A body standing in a later path cell
	 * is passed on by {@link #occupiedWalkNode}; anywhere else it must still have walkable support under the whole
	 * swept hitbox on the way to the next node, so a body shoved off a narrow bridge or ledge corner is not waved on
	 * across the gap.
	 */
	static boolean passedWaypoint(WalkabilityView world, Vec3 position, List<PathNode> nodes, int index, double supportY) {
		if (index < 0 || index + 1 >= nodes.size() || !Double.isFinite(supportY)) return false;
		PathNode node = nodes.get(index);
		PathNode next = nodes.get(index + 1);
		if (!walksOrFalls(node.traversal()) || !walksOrFalls(next.traversal())) return false;
		if (Math.abs(position.y - supportY) > PASSED_LEVEL_TOLERANCE) return false;
		double dx = position.x - (node.position().x() + 0.5D);
		double dz = position.z - (node.position().z() + 0.5D);
		if (dx * dx + dz * dz > HOLD_HEADING_DISTANCE * HOLD_HEADING_DISTANCE) return false;
		if (dx * (next.position().x() - node.position().x()) + dz * (next.position().z() - node.position().z()) <= 0.0D) {
			return false;
		}
		return clearWalkLine(world, position, center(next.position()), node.position().y(), next.position().y());
	}

	private static boolean walksOrFalls(TraversalType traversal) {
		return traversal == TraversalType.WALK || traversal == TraversalType.DROP_DOWN;
	}

	/** Near a landing in midair is not arrival: advancing here can send the body past its only support. */
	static boolean canAdvanceWaypoint(TraversalType traversal, boolean onGround, boolean inWater, boolean onClimbable) {
		return onGround || traversal == TraversalType.SWIM && inWater || traversal == TraversalType.CLIMB && onClimbable;
	}

	/** Settle on the planned landing before steering toward the next edge, which may turn or jump again. */
	static int fallingSteerIndex(List<PathNode> nodes, int index, boolean onGround) {
		return index;
	}

	static boolean clearWalkLine(WalkabilityView world, Vec3 from, Vec3 to, int level) {
		return clearWalkLine(world, from, to, level, level);
	}

	/** As above for a leg that changes level: each swept cell must be standable at either of the two levels. */
	static boolean clearWalkLine(WalkabilityView world, Vec3 from, Vec3 to, int level, int otherLevel) {
		return clearWalkLineWithScratch(world, from, to, level, otherLevel, CLEAR_WALK_LINE_SCRATCH.get());
	}

	static boolean clearWalkLineWithScratch(WalkabilityView world, Vec3 from, Vec3 to, int level, long[] checked) {
		return clearWalkLineWithScratch(world, from, to, level, level, checked);
	}

	static boolean clearWalkLineWithScratch(WalkabilityView world, Vec3 from, Vec3 to, int level, int otherLevel, long[] checked) {
		double dx = to.x - from.x;
		double dz = to.z - from.z;
		int samples = Math.max(1, (int) Math.ceil(Math.sqrt(dx * dx + dz * dz) / STEERING_SAMPLE_SPACING));
		if (checked.length == 0) throw new IllegalArgumentException("clearWalkLine scratch must not be empty");
		GridPosition source = new GridPosition((int) Math.floor(from.x), level, (int) Math.floor(from.z));
		GridPosition target = new GridPosition((int) Math.floor(to.x), otherLevel, (int) Math.floor(to.z));
		double minimumSpeed = Math.min(world.movementSpeedMultiplier(source), world.movementSpeedMultiplier(target));
		int maximumExposure = Math.min(world.exposureCost(source), world.exposureCost(target));
		int cursor = 0;
		int checkedCount = 0;
		for (int sample = 0; sample <= samples; sample++) {
			double t = (double) sample / samples;
			double x = from.x + dx * t;
			double z = from.z + dz * t;
			for (int corner = 0; corner < 4; corner++) {
				int cellX = (int) Math.floor(x + ((corner & 1) == 0 ? -STEERING_HALF_WIDTH : STEERING_HALF_WIDTH));
				int cellZ = (int) Math.floor(z + ((corner & 2) == 0 ? -STEERING_HALF_WIDTH : STEERING_HALF_WIDTH));
				long key = (long) cellX << 32 | cellZ & 0xffffffffL;
				boolean seen = false;
				for (int previous = 0; previous < checkedCount; previous++) {
					if (checked[previous] == key) {
						seen = true;
						break;
					}
				}
				if (seen) continue;
				checked[cursor] = key;
				cursor = (cursor + 1) % checked.length;
				checkedCount = Math.min(checkedCount + 1, checked.length);
				GridPosition standing = new GridPosition(cellX, level, cellZ);
				if (world.traversalAt(standing) != TraversalType.WALK) {
					standing = new GridPosition(cellX, otherLevel, cellZ);
					if (otherLevel == level || world.traversalAt(standing) != TraversalType.WALK) return false;
				}
				// A clear shortcut must preserve the terrain cost that selected this route.
				if (world.movementSpeedMultiplier(standing) + 1.0E-6D < minimumSpeed
						|| world.exposureCost(standing) > maximumExposure) return false;
			}
		}
		return true;
	}

	private static final ThreadLocal<long[]> CLEAR_WALK_LINE_SCRATCH = ThreadLocal.withInitial(() -> new long[8]);

	private TickResult succeed(ServerPlayer player, String reasonCode, String message) {
		cancel(player);
		return TickResult.succeeded(reasonCode, message + movementFacts(player));
	}

	private TickResult fail(ServerPlayer player, String reasonCode, String message, double progressValue) {
		cancel(player);
		String facts = movementFacts(player);
		return TickResult.failed(reasonCode, message + facts, progressValue);
	}

	private String movementFacts(ServerPlayer player) {
		return String.format(java.util.Locale.ROOT, "; replans %d; walked %.1f, left %.1f; stopped at %.2f,%.2f,%.2f",
				continuation.replans(), route == null ? 0.0D : route.walked(), player.position().distanceTo(destination),
				player.getX(), player.getY(), player.getZ())
				+ (route == null ? "" : route.closestFacts());
	}

	private double currentProgress() {
		return lastProgressValue;
	}

	private static boolean reachedWaypoint(Vec3 player, Vec3 waypoint) {
		double dx = player.x - waypoint.x;
		double dz = player.z - waypoint.z;
		return dx * dx + dz * dz <= INTERMEDIATE_WAYPOINT_HORIZONTAL_TOLERANCE_SQUARED
				&& Math.abs(player.y - waypoint.y) <= INTERMEDIATE_WAYPOINT_VERTICAL_TOLERANCE;
	}

	static boolean shouldRetryPlanning(
			PathOutcome outcome,
			boolean deferred,
			long elapsedMs,
			long timeoutMs
	) {
		Objects.requireNonNull(outcome, "outcome must not be null");
		if (!deferred && outcome != PathOutcome.NODE_LIMIT && outcome != PathOutcome.TIME_LIMIT) return false;
		return elapsedMs >= 0L && timeoutMs > 0L && elapsedMs < timeoutMs;
	}

	private static Vec3 center(GridPosition position) {
		return new Vec3(position.x() + 0.5D, position.y(), position.z() + 0.5D);
	}

	private static GridPosition grid(Vec3 position) {
		return new GridPosition(
				(int) Math.floor(position.x),
				(int) Math.floor(position.y),
				(int) Math.floor(position.z)
		);
	}

	/** Damage followed by an unsupported start is reported after landing, rather than as a path failure. */
	static final class DisplacementState {
		private double previousHealth = Double.NaN;
		private double previousY;
		private boolean damageImpulsePending;
		private double topY = Double.NaN;
		private double fall;
		private String source;
		private boolean offRoute;

		boolean observe(double health, double y, double fallDistance, int hurtTime, boolean livingAttacker,
				boolean onGround, boolean inWater) {
			if (Double.isFinite(previousHealth) && health < previousHealth && livingAttacker && hurtTime > 0) {
				damageImpulsePending = true;
			}
			if (hurtTime <= 0) damageImpulsePending = false;
			boolean airborneImpulse = damageImpulsePending && !onGround && !inWater;
			if (airborneImpulse) {
				if (!Double.isFinite(topY)) topY = Math.max(previousY, y);
			}
			previousHealth = health;
			previousY = y;
			if (Double.isFinite(topY)) {
				fall = Math.max(fall, Math.max(fallDistance, topY - y));
				if (!offRoute && onGround) {
					topY = Double.NaN;
					fall = 0.0D;
					damageImpulsePending = false;
					source = null;
				}
			}
			return airborneImpulse;
		}

		boolean missingStart() {
			if (!Double.isFinite(topY)) return false;
			offRoute = true;
			return true;
		}

		boolean hasLanded(boolean onGround, boolean inWater, boolean inLava, boolean onClimbable) {
			return offRoute && (onGround || inWater || inLava || onClimbable);
		}

		double fallDistance() {
			return fall;
		}
	}

	/** Retains enumeration order and terrain facts across server-tick budget boundaries. */
	static final class Preparation {
		private final Vec3 destination;
		private final double tolerance;
		private final AABB region;
		private final Vec3 actualStart;
		private final List<GridPosition> starts = new ArrayList<>();
		final List<GridPosition> goals = new ArrayList<>();
		GridPosition start;
		boolean destinationHasNoSupport;
		boolean unknownGoal;
		private int startIndex;
		private int x, y, z, minY, minZ, maxX, maxY, maxZ;
		private boolean initializedGoals;
		private boolean enumerated;
		private boolean complete;

		Preparation(GridPosition origin, Vec3 destination, double tolerance, AABB region) {
			this(origin, destination, tolerance, region, center(origin));
		}

		Preparation(GridPosition origin, Vec3 destination, double tolerance, AABB region, Vec3 actualStart) {
			this.actualStart = actualStart;
			this.destination = destination;
			this.tolerance = tolerance;
			this.region = region;
			for (int radius = 0; radius <= 1; radius++) {
				for (int dx = -radius; dx <= radius; dx++) {
					for (int dz = -radius; dz <= radius; dz++) {
						if (Math.max(Math.abs(dx), Math.abs(dz)) != radius) continue;
						for (int vertical = 0; vertical <= 2; vertical++) {
							starts.add(origin.offset(dx, vertical, dz));
							if (vertical > 0) starts.add(origin.offset(dx, -vertical, dz));
						}
					}
				}
			}
		}

		boolean advance(WalkabilityView world, ToDoubleFunction<GridPosition> supportHeight, BooleanSupplier claimWork) {
			if (complete) return true;
			while (start == null && startIndex < starts.size()) {
				if (!claimWork.getAsBoolean()) return false;
				GridPosition candidate = starts.get(startIndex++);
				if (world.isTraversable(candidate)) start = candidate;
			}
			if (start == null || center(start).distanceTo(destination) > MAX_LOCAL_PLANNING_DISTANCE) {
				complete = true;
				return true;
			}
			if (!initializedGoals) {
				// Touching any cell of the targeted portal is the arrival.
				goals.addAll(world.portalEntries());
				GridPosition origin = grid(destination);
				int radius = (int) Math.ceil(tolerance) + 1;
				x = region == null ? origin.x() - radius : (int) Math.floor(region.minX);
				y = minY = region == null ? origin.y() - radius : (int) Math.floor(region.minY);
				z = minZ = region == null ? origin.z() - radius : (int) Math.floor(region.minZ);
				maxX = region == null ? origin.x() + radius : (int) Math.ceil(region.maxX);
				maxY = region == null ? origin.y() + radius : (int) Math.ceil(region.maxY);
				maxZ = region == null ? origin.z() + radius : (int) Math.ceil(region.maxZ);
				initializedGoals = true;
			}
			while (!enumerated) {
				if (!claimWork.getAsBoolean()) return false;
				GridPosition candidate = new GridPosition(x, y, z);
				// Point pruning uses the possible support interval, then checks the actual collision height.
				// Region Y also requires that actual surface, so only its X/Z can be pruned.
				boolean geometryMatches = region == null ? candidateSatisfiesTolerance(candidate, destination, tolerance)
						: x + 0.5D >= region.minX && x + 0.5D < region.maxX
						&& z + 0.5D >= region.minZ && z + 0.5D < region.maxZ;
				if (geometryMatches && !goalEndpoint(world, candidate)) {
					unknownGoal |= unknownEndpoint(world, candidate);
				} else if (geometryMatches && surfaceEndpoint(world, candidate)) {
					Vec3 point = swimEndpointTarget(candidate, destination);
					if (point.distanceTo(destination) <= tolerance && (region == null || region.contains(point))) goals.add(candidate);
				} else if (geometryMatches) {
					if (region == null) {
						if (approachableEndpoint(candidate, destination, tolerance,
								supportHeight.applyAsDouble(candidate), actualStart)) goals.add(candidate);
					} else {
						double support = supportHeight.applyAsDouble(candidate);
						if (Double.isFinite(support) && region.contains(x + 0.5D, support, z + 0.5D)) goals.add(candidate);
					}
				}
				if (++y > maxY) {
					y = minY;
					if (++z > maxZ) { z = minZ; if (++x > maxX) enumerated = true; }
				}
			}
			if (goals.isEmpty()) {
				if (!claimWork.getAsBoolean()) return false;
				destinationHasNoSupport = !unknownGoal && !unknownEndpoint(world, grid(destination));
			}
			// The planner consumes goal membership, not list order; retain enumeration order.
			complete = true;
			return true;
		}
	}

	private static boolean unknownEndpoint(WalkabilityView world, GridPosition position) {
		return world.cellAt(position) == WalkabilityView.Cell.UNLOADED
				|| world.cellAt(position.above()) == WalkabilityView.Cell.UNLOADED
				|| world.cellAt(position.below()) == WalkabilityView.Cell.UNLOADED;
	}

	static boolean approachableEndpoint(GridPosition candidate, Vec3 destination, double tolerance,
			double supportHeight, Vec3 actualPosition) {
		if (!Double.isFinite(supportHeight)) return false;
		if (candidate.equals(grid(destination))) return true;
		Vec3 surface = new Vec3(candidate.x() + 0.5D, supportHeight, candidate.z() + 0.5D);
		if (surface.distanceTo(destination) > tolerance) return false;
		// A sphere tangent to the standing plane has no horizontal arrival area to steer into.
		// Preserve an already satisfied boundary instead of weakening the requested radius.
		return Math.abs(supportHeight - destination.y) < tolerance
				|| (actualPosition.distanceTo(destination) <= tolerance
						&& actualPosition.distanceTo(surface) <= tolerance);
	}

	static boolean candidateSatisfiesTolerance(GridPosition candidate, Vec3 destination, double tolerance) {
		if (candidate.equals(grid(destination))) return true;
		// Safe support lies in the block below the feet cell, and may be fractional (slabs/stairs).
		double closestY = Math.max(candidate.y() - 1D, Math.min(candidate.y(), destination.y));
		return new Vec3(candidate.x() + 0.5D, closestY, candidate.z() + 0.5D).distanceTo(destination) <= tolerance;
	}

	private static boolean supportedEndpoint(WalkabilityView world, GridPosition position) {
		TraversalType traversal = world.traversalAt(position);
		return traversal == TraversalType.WALK || traversal == TraversalType.CROUCH;
	}

	/** The floor of flooded space: a player can stand on it under water (ore in a water cave is mined from here). */
	static boolean submergedFloor(WalkabilityView world, GridPosition position) {
		return world.isSubmerged(position) && world.cellAt(position.below()) == WalkabilityView.Cell.SAFE_SUPPORT;
	}

	static boolean surfaceEndpoint(WalkabilityView world, GridPosition position) {
		return world.cellAt(position) == WalkabilityView.Cell.WATER && world.isBodyClear(position.above());
	}

	static Vec3 swimEndpointTarget(GridPosition position, Vec3 requested) {
		return position.equals(grid(requested)) ? requested : center(position).add(0, 0.75, 0);
	}

	static boolean surfaceArrival(boolean surface, boolean inWater, boolean underWater, boolean withinTolerance,
			boolean noCollision, boolean inWall) {
		return surface && inWater && !underWater && withinTolerance && noCollision && !inWall;
	}

	/** Navigation can arrive on support or at a breathable water target; surface arrival verifies actual breathing. */
	static boolean goalEndpoint(WalkabilityView world, GridPosition position) {
		return supportedEndpoint(world, position) || submergedFloor(world, position) || surfaceEndpoint(world, position);
	}

	/** Consecutive submerged route cells from {@code index}: the swim the breath must cover before reaching air. */
	static int submergedNodesAhead(WalkabilityView world, List<PathNode> nodes, int index) {
		int count = 0;
		for (int i = Math.max(0, index); i < nodes.size() && world.isSubmerged(nodes.get(i).position()); i++) count++;
		return count;
	}

	static boolean hasAirReserve(boolean inWater, int air) {
		return !inWater || air > SwimPlanning.AIR_RESERVE_TICKS;
	}
}
