package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.PathNode;
import dev.agaminggod.arenaagents.client.navigation.TraversalType;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputStates;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.world.phys.Vec3;

/** Player-like motion: eased turning, smoothed steering, steady gaze and need-based jumps. */
public final class NavigationMotionVerification {
	private static final int LEVEL = 64;
	private static int assertions;

	private NavigationMotionVerification() {
	}

	public static int verify() {
		assertions = 0;
		verifyDisplacement();
		verifyEasedTurning();
		verifyLookController();
		verifySteering();
		verifyClearWalkLineScratchEquivalence();
		verifyForwardInputAndCornering();
		verifyOccupiedNode();
		verifyFallingSteering();
		verifyD1AirborneLanding();
		verifyLateD1Landing();
		verifyLandingChecks();
		verifyAirborneHandoff();
		verifyPassedWaypoint();
		verifyJumps();
		verifyGapRunoutSprint();
		verifyGaze();
		verifyHeadingHold();
		verifyStairOvershootDoesNotSpin();
		verifyStaircaseGaze();
		return assertions;
	}

	private static void verifyDisplacement() {
		ServerNavigationController.DisplacementState displaced = new ServerNavigationController.DisplacementState();
		displaced.observe(20.0D, 100.0D, 0.0D, 0, false, true, false);
		displaced.observe(18.0D, 100.0D, 0.0D, 10, true, true, false);
		displaced.observe(18.0D, 99.0D, 1.0D, 9, true, false, false);
		assertTrue(displaced.missingStart(), "a null planning start during damage knockback keeps running until landing");
		assertTrue(!displaced.hasLanded(false, false, false, false), "airborne displacement does not fail before landing");
		displaced.observe(18.0D, 92.0D, 8.0D, 0, false, false, false);
		displaced.observe(7.0D, 86.0D, 0.0D, 10, false, true, false);
		assertTrue(displaced.hasLanded(true, false, false, false), "landing after the unsupported start returns DISPLACED");
		assertEquals(14.0D, displaced.fallDistance(), "landing retains the knockback fall after vanilla clears fallDistance");

		ServerNavigationController.DisplacementState supported = new ServerNavigationController.DisplacementState();
		supported.observe(20.0D, 100.0D, 0.0D, 0, false, true, false);
		supported.observe(18.0D, 99.0D, 1.0D, 10, true, false, false);
		supported.observe(18.0D, 97.0D, 3.0D, 8, true, false, false);
		supported.observe(18.0D, 97.0D, 0.0D, 7, true, true, false);
		assertTrue(!supported.hasLanded(true, false, false, false), "ordinary supported knockback keeps navigating");
		assertTrue(!supported.missingStart(), "supported landing clears the displacement candidate");
		assertEquals(0.0D, supported.fallDistance(), "supported landing clears the old fall distance");
		supported.observe(16.0D, 96.0D, 1.0D, 10, true, false, false);
		assertTrue(supported.missingStart(), "a later unsupported knockback starts a fresh displacement");
		supported.observe(16.0D, 95.0D, 0.0D, 0, false, true, false);
		assertTrue(supported.hasLanded(true, false, false, false), "the later unsupported knockback reports displacement");
		assertEquals(2.0D, supported.fallDistance(), "the previous three-block supported fall does not leak into a later two-block fall");

		ServerNavigationController.DisplacementState ordinaryFall = new ServerNavigationController.DisplacementState();
		ordinaryFall.observe(20.0D, 100.0D, 0.0D, 0, false, true, false);
		ordinaryFall.observe(20.0D, 99.0D, 1.0D, 0, false, false, false);
		assertTrue(!ordinaryFall.missingStart(), "an unsupported start without a living-attacker hit remains an ordinary path failure");
	}

	private static void verifyGapRunoutSprint() {
		GridPosition departure = new GridPosition(0, LEVEL, 0), landing = new GridPosition(2, LEVEL, 0);
		for (WalkabilityView.Cell hazard : List.of(WalkabilityView.Cell.HAZARD, WalkabilityView.Cell.CLEAR)) {
			int[] reads = {0};
			WalkabilityView world = p -> {
				reads[0]++;
				if (p.x() == 3 && p.y() < LEVEL) return hazard;
				return p.y() == LEVEL - 1 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
			};
			ServerNavigationController.GapSprintGuard guard = new ServerNavigationController.GapSprintGuard();
			assertTrue(guard.dangerous(world, departure, landing), "hazard/void one block beyond landing suppresses sprint");
			int initialReads = reads[0];
			assertTrue(initialReads <= 6, "runout uses at most six cached cell samples");
			assertTrue(guard.dangerous(world, departure, landing) && reads[0] == initialReads, "same planned gap does not sample each tick");
			Vec3[] positions = {new Vec3(0.5D, LEVEL, 0.5D), new Vec3(1.5D, LEVEL + 0.6D, 0.5D),
					new Vec3(2.5D, LEVEL + 0.1D, 0.5D), new Vec3(2.5D, LEVEL, 0.5D)};
			for (int i = 0; i < positions.length; i++) {
				boolean suppressed = guard.suppress(world, i == 0 ? landing : null, positions[i], i == 0 || i == 3);
				AgentInputStates.MotorStep motor = AgentInputStates.stepMotor(AgentInputStates.MotorState.initial(-90, 0),
						new AgentInputStates.MotorTarget(-90, 0, true, i == 0, !suppressed), i * 50L);
				assertTrue(!motor.sprint() && motor.forward() > 0, "dangerous gap motor walks through departure, flight and landing " + i);
				if (i < 3) assertTrue(guard.active(), "suppression survives waypoint advancement and planning hold " + i);
			}
			assertTrue(!guard.suppress(world, landing, positions[3], true), "settled landing resumes requested sprint without rearming same gap");
			assertTrue(!guard.suppress(world, null, positions[3], true), "next ordinary waypoint releases completed gap memory");
			assertTrue(guard.suppress(world, landing, positions[0], true), "later trip across same gap rearms sprint guard");
			assertTrue(guard.suppress(world, null, positions[1], false), "repeated trip retains guard in flight");
			assertTrue(guard.suppress(world, landing, positions[0], true) && guard.active(), "failed jump landing back at departure remains guarded");
		}
		int[] reads = {0};
		WalkabilityView ordinary = p -> { reads[0]++; return p.y() == LEVEL - 1 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR; };
		ServerNavigationController.GapSprintGuard guard = new ServerNavigationController.GapSprintGuard();
		assertTrue(!guard.suppress(ordinary, null, new Vec3(0.5D, LEVEL, 0.5D), true) && reads[0] == 0,
				"ordinary non-gap movement adds zero cell reads");
		assertTrue(!guard.dangerous(ordinary, departure, landing) && reads[0] == 3, "safe gap runout samples only body, head and support");
		boolean suppressed = guard.suppress(ordinary, null, new Vec3(0.5D, LEVEL, 0.5D), true);
		AgentInputStates.MotorStep motor = AgentInputStates.stepMotor(AgentInputStates.MotorState.initial(-90, 0),
				new AgentInputStates.MotorTarget(-90, 0, true, true, !suppressed), 0);
		assertTrue(motor.sprint() && motor.jump() && motor.forward() > 0, "ordinary gap retains sprint-jump motor input");
		for (Vec3 settled : List.of(new Vec3(2.95D, LEVEL, 0.5D), new Vec3(4.5D, LEVEL, 0.5D))) {
			guard = new ServerNavigationController.GapSprintGuard();
			guard.suppress(ordinary, landing, new Vec3(0.5D, LEVEL, 0.5D), true);
			guard.suppress(ordinary, null, new Vec3(1.5D, LEVEL + 0.6D, 0.5D), false);
			for (int tick = 0; tick < 3; tick++) guard.suppress(ordinary, null, settled, true);
			assertTrue(!guard.active(), "corner cut or missed landing releases after three supported ground ticks");
			assertTrue(!guard.suppress(ordinary, null, settled, true), "sprint resumes after missed landing");
		}
		guard = new ServerNavigationController.GapSprintGuard();
		guard.suppress(ordinary, landing, new Vec3(0.5D, LEVEL, 0.5D), true);
		guard.retainPlan(List.of(new PathNode(landing, TraversalType.JUMP_GAP)));
		assertTrue(guard.active(), "replan keeping the landing retains the guard");
		guard.retainPlan(List.of(new PathNode(departure, TraversalType.START)));
		assertTrue(!guard.active(), "replan detouring away clears the guard even before takeoff");
	}

	private static void verifyForwardInputAndCornering() {
		AgentInputStates.MotorState initial = AgentInputStates.MotorState.initial(0.0F, 0.0F);
		AgentInputStates.MotorStep straight = AgentInputStates.stepMotor(initial,
				new AgentInputStates.MotorTarget(0.0F, 10.0F, true, false, true), 0L);
		assertEquals(1.0F, straight.forward(), "forward input is full strength on the first movement tick");
		assertTrue(Math.abs(straight.strafe()) < 1.0E-6F, "straight movement does not invent lateral input");

		AgentInputStates.MotorStep corner = AgentInputStates.stepMotor(initial,
				new AgentInputStates.MotorTarget(90.0F, 10.0F, true, false, true), 0L);
		assertEquals(45.0F, corner.yaw(), "a corner keeps the existing eased turn cap");
		assertTrue(Math.abs(corner.forward() - (float) Math.cos(Math.toRadians(45.0D))) < 1.0E-4F,
				"cornering uses the full forward component for its current heading");
		assertEquals(-0.2F, corner.strafe(), "cornering retains the 0.2 strafe smoothing step");
		AgentInputStates.MotorStep settled = AgentInputStates.stepMotor(corner.state(),
				new AgentInputStates.MotorTarget(90.0F, 10.0F, true, false, true), 50L);
		assertTrue(settled.forward() > corner.forward(), "forward strength follows the eased corner turn immediately");
		assertTrue(Math.abs(settled.strafe()) > Math.abs(corner.strafe()),
				"strafe smoothing continues to ease into the corner");
	}

	private static void verifyHeadingHold() {
		// Body just past a stair landing's center: the point is 0.2 behind.
		ServerNavigationController.Heading behind = ServerNavigationController.heading(-82.5F, -0.2D, 0.0D, false, Float.NaN);
		assertEquals(-82.5F, behind.viewYaw(), "a passed waypoint inside one block keeps the view's heading");
		assertTrue(Math.abs(AgentInputStates.shortestAngleDelta(90.0F, behind.moveYaw())) < 1.0F,
				"the keys still walk back toward the passed point");
		ServerNavigationController.Heading endpoint = ServerNavigationController.heading(0.0F, 0.6D, 0.0D, true, Float.NaN);
		assertEquals(0.0F, endpoint.viewYaw(), "the final approach sidesteps instead of turning to a point under a block away");
		ServerNavigationController.Heading corner = ServerNavigationController.heading(0.0F, 0.9D, 0.0D, false, Float.NaN);
		assertTrue(Float.isNaN(corner.moveYaw()), "a sideways waypoint that is not behind still turns the view (path corners)");
		ServerNavigationController.Heading far = ServerNavigationController.heading(0.0F, 0.0D, -3.0D, true, Float.NaN);
		assertTrue(Float.isNaN(far.moveYaw()) && Math.abs(AgentInputStates.shortestAngleDelta(far.viewYaw(), 180.0F)) < 1.0F,
				"a destination more than a block behind is turned to and walked to, as before");
		ServerNavigationController.Heading over = ServerNavigationController.heading(33.0F, 0.01D, 0.02D, true, Float.NaN);
		assertEquals(33.0F, over.viewYaw(), "directly over the point the view holds");
		// Review finding: a swimmer half a block past its endpoint held its view, and with no separate walk direction
		// in water it swam on, looped back and stalled. Swimming and climbing turn toward the point.
		ServerNavigationController.Heading swim = ServerNavigationController.heading(-82.5F, -0.2D, 0.0D, true, Float.NaN, false);
		assertTrue(Math.abs(AgentInputStates.shortestAngleDelta(90.0F, swim.viewYaw())) < 1.0F && Float.isNaN(swim.moveYaw()),
				"a swimmer turns its view onto a point behind it and swims there");

		AgentInputStates.MotorStep back = AgentInputStates.stepMotor(
				new AgentInputStates.MotorState(-82.5F, 20.0F, 0.0F, 0.0F, false),
				new AgentInputStates.MotorTarget(-82.5F, 10.0F, true, false, true, 97.5F), 0L);
		assertEquals(-82.5F, back.yaw(), "a held heading never turns");
		assertTrue(back.forward() < 0.0F && Math.abs(back.strafe()) < 1.0E-3F, "a point behind is reached by backing up");
		assertTrue(!back.sprint(), "no sprint while backing up");
	}

	/**
	 * Closed-loop replay of the play-test staircase step: a move_to one block down carries the body about 0.2
	 * past the landing's center. Old steering turned the view toward the point behind (the trace's 180 degree
	 * spin at 45 degrees a tick); the held heading backs onto it without turning.
	 */
	private static void verifyStairOvershootDoesNotSpin() {
		StairRun old = simulateStairStep(false);
		StairRun held = simulateStairStep(true);
		assertTrue(old.yawTravel() > 120.0F, "coupled steering reproduces the play-test spin, travelled " + old.yawTravel());
		assertTrue(held.yawTravel() <= 1.0F, "held heading does not turn during the overshoot, travelled " + held.yawTravel());
		assertTrue(held.maxStep() <= 1.0F, "held heading has no per-tick yaw jump, max " + held.maxStep());
		assertTrue(held.closestAfterLanding() < 0.15D, "the body backs onto the landing, closest " + held.closestAfterLanding());
	}

	private record StairRun(float yawTravel, float maxStep, double closestAfterLanding) {
	}

	private static StairRun simulateStairStep(boolean hold) {
		double targetX = 76.5D;
		double targetZ = 231.5D;
		double x = 76.3D;
		double z = 231.55D;
		double vx = 0.24D;
		double vz = 0.0D;
		AgentInputStates.MotorState motor = new AgentInputStates.MotorState(-82.5F, 28.0F, 1.0F, 0.0F, false);
		float travel = 0.0F;
		float maxStep = 0.0F;
		double closest = Double.MAX_VALUE;
		for (int tick = 0; tick < 30; tick++) {
			boolean airborne = tick < 4;
			double dx = targetX - x;
			double dz = targetZ - z;
			AgentInputStates.MotorTarget target;
			if (hold) {
				ServerNavigationController.Heading heading = ServerNavigationController.heading(motor.yaw(), dx, dz, true, Float.NaN);
				target = new AgentInputStates.MotorTarget(heading.viewYaw(), 10.0F, true, false, false, heading.moveYaw());
			} else {
				float yaw = Math.hypot(dx, dz) < 0.05D ? motor.yaw()
						: net.minecraft.util.Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-dx, dz)));
				target = new AgentInputStates.MotorTarget(yaw, 10.0F, true, false, false);
			}
			AgentInputStates.MotorStep step = AgentInputStates.stepMotor(motor, target, tick * 50L);
			float turned = Math.abs(AgentInputStates.shortestAngleDelta(motor.yaw(), step.yaw()));
			travel += turned;
			maxStep = Math.max(maxStep, turned);
			motor = step.state();
			// Vanilla moveRelative: strafe is +x in input space, forward +z, rotated by the view yaw.
			double radians = Math.toRadians(step.yaw());
			double sin = Math.sin(radians);
			double cos = Math.cos(radians);
			double ax = step.strafe() * cos - step.forward() * sin;
			double az = step.forward() * cos + step.strafe() * sin;
			double length = Math.hypot(ax, az);
			if (length > 1.0D) {
				ax /= length;
				az /= length;
			}
			double acceleration = airborne ? 0.02D : 0.1D;
			double friction = airborne ? 0.91D : 0.546D;
			vx = vx * friction + ax * acceleration;
			vz = vz * friction + az * acceleration;
			x += vx;
			z += vz;
			if (!airborne) closest = Math.min(closest, Math.hypot(targetX - x, targetZ - z));
		}
		return new StairRun(travel, maxStep, closest);
	}

	/** A diagonal staircase: east and south steps, each one block down. */
	private static void verifyStaircaseGaze() {
		List<PathNode> nodes = new ArrayList<>();
		int x = 0;
		int y = LEVEL;
		int z = 0;
		nodes.add(new PathNode(new GridPosition(x, y, z), TraversalType.WALK));
		for (int step = 0; step < 4; step++) {
			nodes.add(new PathNode(new GridPosition(++x, --y, z), TraversalType.DROP_DOWN));
			nodes.add(new PathNode(new GridPosition(x, --y, ++z), TraversalType.DROP_DOWN));
		}
		float oldMin = 180.0F;
		float oldMax = -180.0F;
		float newMin = 180.0F;
		float newMax = -180.0F;
		float view = -45.0F;
		for (int index = 1; index < nodes.size() - 3; index++) {
			GridPosition from = nodes.get(index - 1).position();
			GridPosition to = nodes.get(index).position();
			Vec3 position = new Vec3(from.x() + 0.5D, from.y(), from.z() + 0.5D);
			double dx = to.x() - from.x();
			double dz = to.z() - from.z();
			float nodeYaw = net.minecraft.util.Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-dx, dz)));
			oldMin = Math.min(oldMin, nodeYaw);
			oldMax = Math.max(oldMax, nodeYaw);
			float gaze = ServerNavigationController.gazeYaw(position, nodes, index);
			ServerNavigationController.Heading heading = ServerNavigationController.heading(view, dx, dz, false, gaze);
			view = heading.viewYaw();
			newMin = Math.min(newMin, view);
			newMax = Math.max(newMax, view);
			assertTrue(!Float.isNaN(heading.moveYaw()), "the keys still walk each stair cell while the view looks down the stairs");
		}
		assertEquals(90.0F, oldMax - oldMin, "node-by-node steering swung the view 90 degrees at every stair");
		assertTrue(newMax - newMin <= 30.0F, "looking down the stairs keeps the view within 30 degrees, swung "
				+ (newMax - newMin));
		List<PathNode> ladder = List.of(nodes.get(0), new PathNode(new GridPosition(0, LEVEL + 1, 0), TraversalType.CLIMB));
		assertTrue(Float.isNaN(ServerNavigationController.gazeYaw(new Vec3(0.5D, LEVEL, 0.5D), ladder, 0)),
				"climbs keep their own facing");
	}

	private static void verifyEasedTurning() {
		assertEquals(AgentInputStates.MAX_TURN_STEP_DEGREES,
				Math.abs(AgentInputStates.shortestAngleDelta(0.0F, AgentInputStates.turnYaw(0.0F, 180.0F))),
				"a large turn starts at the flick speed limit");
		int flick = ticksToTurn(0.0F, 179.0F);
		assertTrue(flick >= 4 && flick <= 6, "a 179 degree flick settles in 200-300 ms, took " + flick + " ticks");
		int quarter = ticksToTurn(0.0F, 90.0F);
		assertTrue(quarter >= 3 && quarter <= 5, "a 90 degree turn settles in 150-250 ms, took " + quarter + " ticks");
		assertEquals(-178.0F, AgentInputStates.turnYaw(178.0F, -178.0F), "a small turn across the wrap lands exactly");
		assertEquals(-90.0F, AgentInputStates.turnPitch(-85.0F, -120.0F), "pitch turns stay within the vertical range");
	}

	private static int ticksToTurn(float from, float to) {
		float yaw = from;
		float remaining = Math.abs(AgentInputStates.shortestAngleDelta(yaw, to));
		for (int tick = 1; tick <= 40; tick++) {
			yaw = AgentInputStates.turnYaw(yaw, to);
			float next = Math.abs(AgentInputStates.shortestAngleDelta(yaw, to));
			assertTrue(next < remaining, "each eased step closes the turn without overshoot");
			remaining = next;
			if (remaining == 0.0F) return tick;
		}
		throw new AssertionError("turn never settled");
	}

	private static void verifyLookController() {
		Vec3 eye = new Vec3(0.5D, 65.62D, 0.5D);
		ServerLookController.Angles south = ServerLookController.anglesTo(eye, eye.add(0.0D, 0.0D, 3.0D));
		assertTrue(Math.abs(south.yaw()) < 1.0E-3F, "+Z is yaw 0, matching Entity.lookAt");
		ServerLookController.Angles west = ServerLookController.anglesTo(eye, eye.add(-3.0D, 0.0D, 0.0D));
		assertTrue(Math.abs(west.yaw() - 90.0F) < 1.0E-3F, "-X is yaw 90, matching Entity.lookAt");
		ServerLookController.Angles up = ServerLookController.anglesTo(eye, eye.add(0.0D, 2.0D, 2.0D));
		assertTrue(Math.abs(up.pitch() + 45.0F) < 1.0E-3F, "looking up is negative pitch");

		ServerLookController.Angles goal = ServerLookController.anglesTo(eye, new Vec3(-2.5D, 64.5D, -1.5D));
		ServerLookController.Angles current = new ServerLookController.Angles(0.0F, 0.0F);
		ServerLookController.Angles first = ServerLookController.step(current, goal);
		assertTrue(!first.equals(goal), "a large look_at turn is spread over ticks instead of snapping");
		int ticks = 1;
		current = first;
		while (!current.equals(goal)) {
			current = ServerLookController.step(current, goal);
			if (++ticks > 10) throw new AssertionError("look controller never settled");
		}
		assertTrue(ticks <= 6, "look_at settles on the exact target within about 300 ms, took " + ticks);
		ServerLookController.Angles near = new ServerLookController.Angles(goal.yaw() + 2.0F, goal.pitch() - 1.0F);
		assertEquals(goal, ServerLookController.step(near, goal), "an already aimed look completes in one tick");
	}

	private static void verifySteering() {
		// Open field: a cardinal staircase toward the south-east runs as one diagonal.
		WalkabilityView open = world(cells(-2, 8, -2, 8));
		List<PathNode> stairs = staircase(4);
		Vec3 start = new Vec3(0.5D, LEVEL, 0.5D);
		assertEquals(stairs.size() - 1, ServerNavigationController.steeringIndex(open, start, stairs, 1),
				"open ground steers straight at the furthest visible node");

		// Corridor that is exactly the staircase: no corner may be cut.
		Set<Long> corridor = new HashSet<>();
		for (PathNode node : stairs) corridor.add(key(node.position().x(), node.position().z()));
		WalkabilityView narrow = world(corridor);
		assertEquals(1, ServerNavigationController.steeringIndex(narrow, start, stairs, 1),
				"a corridor keeps node-by-node steering so the body never clips a wall");

		List<PathNode> withStep = new ArrayList<>(stairs);
		GridPosition stepPosition = withStep.get(3).position();
		withStep.set(3, new PathNode(new GridPosition(stepPosition.x(), LEVEL + 1, stepPosition.z()), TraversalType.JUMP_UP));
		assertEquals(2, ServerNavigationController.steeringIndex(open, start, withStep, 1),
				"steering never looks past a jump or level change");
		assertEquals(1, ServerNavigationController.steeringIndex(open, new Vec3(0.5D, LEVEL + 1, 0.5D), stairs, 1),
				"steering is only smoothed on the player's own level");

		// Off-center start whose diagonal sweeps the body through cell (1, 0) between samples. The previous
		// 0.25 spacing with a 0.35 half-width checked neither sample square over that cell.
		Vec3 offCenter = new Vec3(0.49D, LEVEL, 0.03D);
		Vec3 diagonalTarget = new Vec3(1.5D, LEVEL, -1.5D);
		Set<Long> hazardBeside = cells(-3, 4, -4, 3);
		hazardBeside.remove(key(1, 0));
		assertTrue(!ServerNavigationController.clearWalkLine(world(hazardBeside), offCenter, diagonalTarget, LEVEL),
				"a hazard the swept hitbox clips between samples rejects the straight line");
		assertTrue(ServerNavigationController.clearWalkLine(world(cells(-3, 4, -4, 3)), offCenter, diagonalTarget, LEVEL),
				"the same line is clear when that cell is standable");
		assertTrue(ServerNavigationController.STEERING_HALF_WIDTH
						> 0.3D + ServerNavigationController.STEERING_SAMPLE_SPACING / 2.0D
						&& ServerNavigationController.STEERING_HALF_WIDTH < 0.5D,
				"the sample envelope covers the hitbox between samples and stays under one block wide");
	}

	private static void verifyOccupiedNode() {
		List<PathNode> stairs = staircase(4);
		assertEquals(3, ServerNavigationController.occupiedWalkNode(stairs, 1, stairs.get(3).position()),
				"standing in a later walk cell marks the nodes before it as passed");
		assertEquals(-1, ServerNavigationController.occupiedWalkNode(stairs, 1, stairs.getLast().position()),
				"the final node keeps its exact arrival check");
		List<PathNode> withStep = new ArrayList<>(stairs);
		withStep.set(2, new PathNode(withStep.get(2).position(), TraversalType.JUMP_UP));
		assertEquals(-1, ServerNavigationController.occupiedWalkNode(withStep, 1, stairs.get(3).position()),
				"a jump node is never skipped");
		// A drop, gap jump or step-up landing is skipped once the body stands in a later walk cell: an overshoot
		// must not walk back onto the landing cell first.
		for (TraversalType landing : List.of(TraversalType.DROP_DOWN, TraversalType.JUMP_GAP, TraversalType.JUMP_UP)) {
			List<PathNode> route = new ArrayList<>();
			route.add(new PathNode(new GridPosition(0, LEVEL + 1, 0), TraversalType.WALK));
			route.add(new PathNode(new GridPosition(1, LEVEL, 0), landing));
			for (int x = 2; x <= 6; x++) route.add(new PathNode(new GridPosition(x, LEVEL, 0), TraversalType.WALK));
			assertEquals(2, ServerNavigationController.occupiedWalkNode(route, 1, route.get(2).position()),
					landing + " landing is passed when the body overshoots into the next walk cell");
			assertEquals(1, ServerNavigationController.occupiedWalkNode(route, 1, route.get(1).position()),
					landing + " landing is passed when the body stands on it");
			assertEquals(-1, ServerNavigationController.occupiedWalkNode(route, 1, route.get(0).position()),
					landing + " landing stays active while the body is still on the upper level");
			assertEquals(landing == TraversalType.DROP_DOWN ? 2 : -1,
					ServerNavigationController.occupiedWalkNode(route, 0, route.get(2).position()),
					"only a drop node further down the window is flown over; a jump node is never skipped");
		}
		// A sprinting body can clear the first step of a staircase down and land on the second: both drop nodes are behind it.
		List<PathNode> stepsDown = new ArrayList<>();
		stepsDown.add(new PathNode(new GridPosition(0, LEVEL + 3, 0), TraversalType.WALK));
		stepsDown.add(new PathNode(new GridPosition(1, LEVEL + 2, 0), TraversalType.DROP_DOWN));
		stepsDown.add(new PathNode(new GridPosition(2, LEVEL + 1, 0), TraversalType.DROP_DOWN));
		stepsDown.add(new PathNode(new GridPosition(3, LEVEL, 0), TraversalType.DROP_DOWN));
		stepsDown.add(new PathNode(new GridPosition(4, LEVEL, 0), TraversalType.WALK));
		stepsDown.add(new PathNode(new GridPosition(5, LEVEL, 0), TraversalType.WALK));
		assertEquals(2, ServerNavigationController.occupiedWalkNode(stepsDown, 1, stepsDown.get(2).position()),
				"flying over a step lands on a later drop node, which passes the skipped one");
		assertEquals(3, ServerNavigationController.occupiedWalkNode(stepsDown, 1, stepsDown.get(3).position()),
				"clearing two steps passes both");
		assertEquals(-1, ServerNavigationController.occupiedWalkNode(stepsDown, 1, stepsDown.get(0).position()),
				"standing on the upper level passes nothing");
		List<PathNode> dropThenTurn = new ArrayList<>();
		dropThenTurn.add(new PathNode(new GridPosition(0, LEVEL + 1, 0), TraversalType.WALK));
		dropThenTurn.add(new PathNode(new GridPosition(1, LEVEL, 0), TraversalType.DROP_DOWN));
		dropThenTurn.add(new PathNode(new GridPosition(1, LEVEL, 1), TraversalType.JUMP_UP));
		dropThenTurn.add(new PathNode(new GridPosition(1, LEVEL + 1, 2), TraversalType.WALK));
		assertEquals(-1, ServerNavigationController.occupiedWalkNode(dropThenTurn, 1, new GridPosition(1, LEVEL + 1, 2)),
				"a jump after the landing is never skipped");
		assertEquals(1, ServerNavigationController.occupiedWalkNode(dropThenTurn, 1, dropThenTurn.get(1).position()),
				"standing on the landing still passes it");
		assertEquals(-1, ServerNavigationController.occupiedWalkNode(
				List.of(new PathNode(new GridPosition(0, LEVEL, 0), TraversalType.WALK),
						new PathNode(new GridPosition(1, LEVEL, 0), TraversalType.CLIMB),
						new PathNode(new GridPosition(2, LEVEL, 0), TraversalType.WALK),
						new PathNode(new GridPosition(3, LEVEL, 0), TraversalType.WALK)),
				1, new GridPosition(2, LEVEL, 0)), "a climb is never skipped");
	}

	private static void verifyPassedWaypoint() {
		List<PathNode> route = new ArrayList<>();
		route.add(new PathNode(new GridPosition(0, LEVEL + 2, 0), TraversalType.WALK));
		route.add(new PathNode(new GridPosition(1, LEVEL + 1, 0), TraversalType.DROP_DOWN));
		route.add(new PathNode(new GridPosition(2, LEVEL, 0), TraversalType.DROP_DOWN));
		route.add(new PathNode(new GridPosition(3, LEVEL, 0), TraversalType.WALK));
		WalkabilityView ground = supportedRoute(route);
		double level = LEVEL + 1;
		assertTrue(ServerNavigationController.passedWaypoint(ground, new Vec3(2.26D, level, 0.5D), route, 1, level),
				"a body hanging over the far edge of a drop landing has passed it");
		assertTrue(!ServerNavigationController.passedWaypoint(ground, new Vec3(1.2D, level, 0.5D), route, 1, level),
				"a body still short of the landing center has not");
		assertTrue(!ServerNavigationController.passedWaypoint(ground, new Vec3(1.5D, level, 0.5D), route, 1, level),
				"standing exactly on the center is left to the normal arrival check");
		assertTrue(!ServerNavigationController.passedWaypoint(ground, new Vec3(2.6D, level, 0.5D), route, 1, level),
				"more than a block past the center is a different problem than stepping back");
		assertTrue(!ServerNavigationController.passedWaypoint(ground, new Vec3(2.26D, level + 1.0D, 0.5D), route, 1, level),
				"a body on another level has not passed it");
		assertTrue(!ServerNavigationController.passedWaypoint(ground, new Vec3(2.26D, level, 0.5D), route, 3, level),
				"the endpoint always keeps its exact arrival check");
		List<PathNode> jumpNext = new ArrayList<>(route);
		jumpNext.set(2, new PathNode(new GridPosition(2, LEVEL + 2, 0), TraversalType.JUMP_UP));
		assertTrue(!ServerNavigationController.passedWaypoint(supportedRoute(jumpNext), new Vec3(2.26D, level, 0.5D), jumpNext, 1, level),
				"a jump leg after the waypoint still needs the body to line up");
		List<PathNode> turn = new ArrayList<>(route);
		turn.set(2, new PathNode(new GridPosition(1, LEVEL + 1, 1), TraversalType.WALK));
		WalkabilityView turned = supportedRoute(turn);
		assertTrue(!ServerNavigationController.passedWaypoint(turned, new Vec3(2.26D, level, 0.5D), turn, 1, level),
				"past the center along the old heading is not past a corner that turns the other way");
		assertTrue(ServerNavigationController.passedWaypoint(turned, new Vec3(1.5D, level, 1.2D), turn, 1, level),
				"past the center toward the new heading is");
		assertTrue(!ServerNavigationController.passedWaypoint(supportedRoute(route.subList(0, 2)), new Vec3(2.26D, level, 0.5D), route, 1, level),
				"a body over the far edge with nothing to stand on toward the next node has not passed it");

		// One-block-wide bridge: a body shoved sideways to the rim, still standing, is not waved on across the gap.
		List<PathNode> bridge = new ArrayList<>();
		for (int x = 0; x <= 5; x++) bridge.add(new PathNode(new GridPosition(x, LEVEL, 0), TraversalType.WALK));
		WalkabilityView bridgeWorld = supportedRoute(bridge);
		assertTrue(ServerNavigationController.passedWaypoint(bridgeWorld, new Vec3(1.7D, LEVEL, 0.5D), bridge, 1, LEVEL),
				"a centred body past a bridge node moves on to the next one");
		assertTrue(!ServerNavigationController.passedWaypoint(bridgeWorld, new Vec3(1.7D, LEVEL, 0.88D), bridge, 1, LEVEL),
				"a body pushed to the south rim of a bridge has not passed the node");
		assertTrue(!ServerNavigationController.passedWaypoint(bridgeWorld, new Vec3(1.7D, LEVEL, 0.12D), bridge, 1, LEVEL),
				"a body pushed to the north rim of a bridge has not passed the node");

		// Ledge corner: the path turns from east to south at (2,0); a body on the outside of the turn is over the void.
		List<PathNode> ledge = new ArrayList<>();
		ledge.add(new PathNode(new GridPosition(1, LEVEL, 0), TraversalType.WALK));
		ledge.add(new PathNode(new GridPosition(2, LEVEL, 0), TraversalType.WALK));
		ledge.add(new PathNode(new GridPosition(2, LEVEL, 1), TraversalType.WALK));
		ledge.add(new PathNode(new GridPosition(2, LEVEL, 2), TraversalType.WALK));
		WalkabilityView ledgeWorld = supportedRoute(ledge);
		assertTrue(ServerNavigationController.passedWaypoint(ledgeWorld, new Vec3(2.5D, LEVEL, 0.8D), ledge, 1, LEVEL),
				"a body past the corner node toward the new heading, on the ledge, has passed it");
		assertTrue(!ServerNavigationController.passedWaypoint(ledgeWorld, new Vec3(2.92D, LEVEL, 0.7D), ledge, 1, LEVEL),
				"a body on the outer rim of a ledge corner has not passed it");
		assertTrue(!ServerNavigationController.passedWaypoint(ledgeWorld, new Vec3(2.5D, LEVEL, 0.1D), ledge, 1, LEVEL),
				"a body that has not yet reached the turn has not passed it");

		// Stairs down a one-block-wide cave passage with walls on both sides.
		List<PathNode> stairs = new ArrayList<>();
		stairs.add(new PathNode(new GridPosition(0, LEVEL + 2, 0), TraversalType.WALK));
		stairs.add(new PathNode(new GridPosition(1, LEVEL + 1, 0), TraversalType.DROP_DOWN));
		stairs.add(new PathNode(new GridPosition(2, LEVEL, 0), TraversalType.DROP_DOWN));
		stairs.add(new PathNode(new GridPosition(3, LEVEL - 1, 0), TraversalType.DROP_DOWN));
		stairs.add(new PathNode(new GridPosition(4, LEVEL - 1, 0), TraversalType.WALK));
		Set<GridPosition> cave = supportBlocks(stairs);
		for (int x = -1; x <= 5; x++) {
			for (int y = LEVEL - 2; y <= LEVEL + 5; y++) {
				cave.add(new GridPosition(x, y, -1));
				cave.add(new GridPosition(x, y, 1));
			}
		}
		WalkabilityView caveWorld = solidWorld(cave);
		double step = LEVEL + 1;
		assertTrue(ServerNavigationController.passedWaypoint(caveWorld, new Vec3(2.2D, step, 0.5D), stairs, 1, step),
				"a body that clears a stair in a passage has passed it");
		assertTrue(!ServerNavigationController.passedWaypoint(caveWorld, new Vec3(2.2D, step, 0.22D), stairs, 1, step),
				"a body pressed against the passage wall is not waved on");
		assertTrue(!ServerNavigationController.passedWaypoint(caveWorld, new Vec3(1.2D, step, 0.5D), stairs, 1, step),
				"a body still on the stair has not passed it");
	}

	private static void verifyD1AirborneLanding() {
		// Retained D1 at 1792080512566: the jump is still airborne, followed by a fall to lava at y50.
		Vec3 airborne = new Vec3(23.285455054373593D, 57.17675927506424D, 38.30000001192093D);
		var controller = new ServerNavigationController(new Vec3(34, 58, 57), 2, false, 0, 30_000);
		for (TraversalType traversal : List.of(TraversalType.JUMP_GAP, TraversalType.JUMP_UP, TraversalType.DROP_DOWN)) {
			PathNode landing = new PathNode(new GridPosition(23, 57, 38), traversal);
			assertTrue(controller.reachedTarget(airborne, landing, false), "D1 airborne position passes the old landing proximity check");
			assertTrue(!ServerNavigationController.canAdvanceWaypoint(traversal, false, false, false),
					"the controller retains landing ownership until actual support, even within tolerance");
			assertTrue(ServerNavigationController.canAdvanceWaypoint(traversal, true, false, false), "grounded landing can advance");
		}
	}

	private static void verifyLateD1Landing() {
		try (var input = NavigationMotionVerification.class.getResourceAsStream("/d1-late4-handoff.json")) {
			var fixture = com.google.gson.JsonParser.parseReader(new java.io.InputStreamReader(input, java.nio.charset.StandardCharsets.UTF_8)).getAsJsonObject();
			var blocks = new java.util.HashMap<net.minecraft.core.BlockPos, net.minecraft.world.level.block.state.BlockState>();
			for (var row : fixture.getAsJsonArray("sampledBlocks")) {
				var block = row.getAsJsonObject();
				var state = switch (block.get("blockId").getAsString()) {
					case "minecraft:basalt" -> net.minecraft.world.level.block.Blocks.BASALT.defaultBlockState();
					case "minecraft:magma_block" -> net.minecraft.world.level.block.Blocks.MAGMA_BLOCK.defaultBlockState();
					case "minecraft:lava" -> net.minecraft.world.level.block.Blocks.LAVA.defaultBlockState();
					default -> throw new AssertionError("unexpected D1 terrain " + block);
				};
				blocks.put(new net.minecraft.core.BlockPos(block.get("x").getAsInt(), block.get("y").getAsInt(), block.get("z").getAsInt()), state);
			}
			// Only body-occupied cells establish open space. Missing terrain stays unknown.
			Set<net.minecraft.core.BlockPos> open = new HashSet<>();
			for (var row : fixture.getAsJsonArray("frames")) {
				var frame = row.getAsJsonObject();
				Vec3 point = vector(frame.getAsJsonObject("position"));
				for (int x = (int) Math.floor(point.x - .3D + 1E-6); x <= (int) Math.floor(point.x + .3D - 1E-6); x++)
					for (int y = (int) Math.floor(point.y + 1E-6); y <= (int) Math.floor(point.y + 1.8D - 1E-6); y++)
						for (int z = (int) Math.floor(point.z - .3D + 1E-6); z <= (int) Math.floor(point.z + .3D - 1E-6); z++)
							open.add(new net.minecraft.core.BlockPos(x, y, z));
				if (frame.get("at").getAsLong() < 1792089061666L)
					assertEquals(20D, frame.get("health").getAsDouble(), "D1 keeps full health through cancellation and descent to the first lower ledge");
				if (frame.get("at").getAsLong() >= 1792089061666L) break;
			}
			var terrain = new SeenNavigationVerification.World();
			terrain.states.putAll(blocks);
			var source = new dev.agaminggod.arenaagents.server.perception.SeenTerrain.Source<net.minecraft.world.level.block.state.BlockState>() {
				public net.minecraft.world.level.block.state.BlockState live(int x, int y, int z) { return terrain.live(x, y, z); }
				public boolean sees(int x, int y, int z) { var p = new net.minecraft.core.BlockPos(x, y, z); return blocks.containsKey(p) || open.contains(p); }
			};
			var view = new MinecraftNavigationWorld(terrain, new dev.agaminggod.arenaagents.server.perception.SeenTerrain.Reader<>(
					new dev.agaminggod.arenaagents.server.perception.SeenTerrain.Memory<>(), source, 1L, null));
			assertTrue(view.isStandable(new GridPosition(28, 56, 28)), "D1's y56 basalt pocket is actual safe support");
			assertTrue(!view.canJumpUp(new GridPosition(28, 56, 28), new GridPosition(27, 58, 28)),
					"the observed two-block return from the pocket to the basalt top is not an unboosted jump");
			assertTrue(!view.isStandable(new GridPosition(30, 50, 27)), "D1's magma trap cannot be a planned safe landing");
			assertTrue(view.cellAt(new GridPosition(30, 49, 27)) == WalkabilityView.Cell.HAZARD, "actual trap support classifies as hazardous");
			var collision = new MinecraftNavigationWorld.Obstacles(blocks.entrySet().stream().map(entry ->
					entry.getValue().getCollisionShape(net.minecraft.world.level.EmptyBlockGetter.INSTANCE, entry.getKey())
							.move(entry.getKey().getX(), entry.getKey().getY(), entry.getKey().getZ())).filter(shape -> !shape.isEmpty()).toList());
			var cancelled = fixture.getAsJsonObject("cancellation").getAsJsonObject("actionObservation");
			Vec3 coastStart = vector(cancelled.getAsJsonObject("position"));
			Vec3 velocity = vector(cancelled.getAsJsonObject("velocity"));
			var body = new net.minecraft.world.phys.AABB(coastStart.x - .3D, coastStart.y, coastStart.z - .3D,
					coastStart.x + .3D, coastStart.y + 1.8D, coastStart.z + .3D);
			boolean passedLedge = false;
			boolean onGround = false;
			for (int tick = 0; tick < 40; tick++) {
				double friction = onGround ? .6F * .91F : .91F;
				Vec3 moved = MinecraftNavigationWorld.collide(velocity, body, collision);
				boolean grounded = velocity.y < 0 && moved.y != velocity.y;
				body = body.move(moved);
				if (grounded && body.minY == 52D && body.minX >= 30D) passedLedge = true;
				velocity = new Vec3(moved.x == velocity.x ? velocity.x * friction : 0D,
						((moved.y == velocity.y ? velocity.y : 0D) - .08D) * .98D,
						moved.z == velocity.z ? velocity.z * friction : 0D);
				onGround = grounded;
			}
			assertTrue(passedLedge, "in the retained local geometry, coasting can pass the basalt support during the tick that reports onGround");
			assertEquals(50D, body.minY, "the retained cancellation momentum alone reaches the magma floor without another movement command");
			// Feed the retained body frames through the production landing check for this local jump.
			var check = new ServerNavigationController.LandingCheck();
			Vec3 landing = new Vec3(27.5D, 58D, 28.5D);
			check.track(TraversalType.JUMP_UP, landing, true);
			boolean stopped = false;
			for (var row : fixture.getAsJsonArray("frames")) {
				var frame = row.getAsJsonObject();
				long at = frame.get("at").getAsLong();
				if (at < 1792089055915L) continue;
				Vec3 missed = check.observe(frame.get("onGround").getAsBoolean(), false, vector(frame.getAsJsonObject("position")).y);
				if (missed != null) {
					assertEquals(1792089056917L, at, "D1 local jump stops at the first observed y56 landing, before the guard and y53 descent");
					stopped = true;
					break;
				}
			}
			assertTrue(stopped, "the local jump reproduction returns control instead of retrying the unreachable landing");
		} catch (java.io.IOException failure) { throw new AssertionError(failure); }
	}

	private static Vec3 vector(com.google.gson.JsonObject object) {
		return new Vec3(object.get("x").getAsDouble(), object.get("y").getAsDouble(), object.get("z").getAsDouble());
	}

	private static void verifyLandingChecks() {
		for (TraversalType traversal : List.of(TraversalType.JUMP_UP, TraversalType.JUMP_GAP, TraversalType.DROP_DOWN)) {
			var check = new ServerNavigationController.LandingCheck();
			Vec3 target = new Vec3(28.5D, 53D, 27.5D);
			check.track(traversal, target, true);
			assertTrue(check.observe(true, false, 56D) == null, "departure does not count as a missed landing " + traversal);
			assertTrue(check.observe(false, false, 54D) == null, "flight retains control " + traversal);
			assertTrue(check.observe(true, false, 53D) == null, "the planned supported landing succeeds " + traversal);
			check.track(traversal, target, true);
			check.observe(false, false, 54D);
			assertEquals(target, check.observe(true, false, 52D), "landing below the planned support is reported " + traversal);
			assertTrue(check.observe(true, false, 52D) == null, "a missed landing is reported once " + traversal);
		}
		for (boolean wet : List.of(false, true)) {
			var check = new ServerNavigationController.LandingCheck();
			check.track(TraversalType.JUMP_UP, new Vec3(1.5D, 65D, .5D), true);
			check.observe(false, false, 65D);
			assertTrue(check.observe(wet, true, 62D) == null && check.target() == null, "water or a ladder takes over without a dry landing failure");
		}
		var check = new ServerNavigationController.LandingCheck();
		check.track(TraversalType.JUMP_UP, new Vec3(1.5D, 65D, .5D), false);
		assertTrue(check.observe(true, false, 64D) == null, "starting in midair cannot invent a planned takeoff");
		check.track(TraversalType.JUMP_UP, new Vec3(1.5D, 65D, .5D), true);
		check.observe(false, false, 65.2D);
		assertTrue(check.observe(true, false, 64.5D) == null, "a stair's lower tread can still step up onto its steering point");
	}

	private static void verifyAirborneHandoff() {
		Vec3 position = new Vec3(29.802431157388547D, 52.92159999847412D, 27.44358298655306D);
		Vec3 velocity = new Vec3(.14623870879798498D, -.1552320045166016D, -.03315141272664165D);
		String message = ServerNavigationController.airborneFacts(position, velocity, new Vec3(29.5D, 52D, 27.5D));
		assertTrue(message.contains("airborne") && message.contains("gravity-only estimate 0.20 s to its height"), "retained D1 cancellation estimates crossing the next basalt ledge's height");
		assertTrue(message.contains("landing contact unverified; momentum continues after release"), "the handoff never promises landing or braking");
		assertTrue(ServerNavigationController.airborneFacts(position, velocity, null).contains("landing unknown"), "a missing planned landing stays unknown");
		assertTrue(Double.isNaN(ServerNavigationController.secondsToLevel(56D, -.1D, 58D)), "a falling body cannot reach the missed landing above it");
		assertTrue(Double.isNaN(ServerNavigationController.secondsToLevel(56D, .2D, 58D)), "an insufficient ascent cannot predict a landing height it never reaches");
		assertTrue(ServerNavigationController.secondsToLevel(57D, .42D, 58D) > .2D, "a reachable higher landing estimates the descending height crossing");
	}

	private static void verifyFallingSteering() {
		List<PathNode> route = new ArrayList<>();
		route.add(new PathNode(new GridPosition(0, LEVEL + 1, 0), TraversalType.WALK));
		route.add(new PathNode(new GridPosition(1, LEVEL, 0), TraversalType.DROP_DOWN));
		route.add(new PathNode(new GridPosition(2, LEVEL, 0), TraversalType.WALK));
		assertEquals(1, ServerNavigationController.fallingSteerIndex(route, 1, false),
				"a falling body must settle on its planned landing before taking the next edge");
		assertEquals(1, ServerNavigationController.fallingSteerIndex(route, 1, true),
				"a grounded body steers at its waypoint as before");
		assertEquals(0, ServerNavigationController.fallingSteerIndex(route, 0, false),
				"only drop landings are looked past");
		route.remove(2);
		assertEquals(1, ServerNavigationController.fallingSteerIndex(route, 1, false),
				"a landing that is the endpoint keeps its exact arrival steering");
	}

	private static void verifyClearWalkLineScratchEquivalence() {
		try {
			var optimized = ServerNavigationController.class.getDeclaredMethod("clearWalkLineWithScratch",
					WalkabilityView.class, Vec3.class, Vec3.class, int.class, long[].class);
			optimized.setAccessible(true);
			java.util.Random random = new java.util.Random(0x5EEDC1EAFL);
			long[] scratch = new long[8];
			for (int sample = 0; sample < 5_000; sample++) {
				Set<Long> walkable = new HashSet<>();
				for (int x = -14; x <= 14; x++) for (int z = -14; z <= 14; z++) {
					if (random.nextDouble() < 0.76D) walkable.add(key(x, z));
				}
				Vec3 from = new Vec3(random.nextDouble() * 18.0D - 9.0D, LEVEL, random.nextDouble() * 18.0D - 9.0D);
				Vec3 to = new Vec3(random.nextDouble() * 18.0D - 9.0D, LEVEL, random.nextDouble() * 18.0D - 9.0D);
				boolean expected = referenceClearWalkLine(world(walkable), from, to, LEVEL);
				boolean actual = (boolean) optimized.invoke(null, world(walkable), from, to, LEVEL, scratch);
				assertEquals(expected, actual, "scratch ring preserves clearWalkLine answer for seeded random path " + sample);
			}
		} catch (ReflectiveOperationException exception) {
			throw new AssertionError("clearWalkLine must expose the reusable scratch-ring implementation", exception);
		}
	}

	private static boolean referenceClearWalkLine(WalkabilityView world, Vec3 from, Vec3 to, int level) {
		double dx = to.x - from.x;
		double dz = to.z - from.z;
		int samples = Math.max(1, (int) Math.ceil(Math.sqrt(dx * dx + dz * dz) / ServerNavigationController.STEERING_SAMPLE_SPACING));
		Set<GridPosition> checked = new HashSet<>();
		for (int sample = 0; sample <= samples; sample++) {
			double t = (double) sample / samples;
			double x = from.x + dx * t;
			double z = from.z + dz * t;
			for (int corner = 0; corner < 4; corner++) {
				GridPosition cell = new GridPosition(
						(int) Math.floor(x + ((corner & 1) == 0 ? -ServerNavigationController.STEERING_HALF_WIDTH : ServerNavigationController.STEERING_HALF_WIDTH)),
						level,
						(int) Math.floor(z + ((corner & 2) == 0 ? -ServerNavigationController.STEERING_HALF_WIDTH : ServerNavigationController.STEERING_HALF_WIDTH)));
				if (checked.add(cell) && world.traversalAt(cell) != TraversalType.WALK) return false;
			}
		}
		return true;
	}

	private static void verifyJumps() {
		assertTrue(!ServerNavigationController.jumpNeeded(TraversalType.JUMP_UP, 1.0D, 1.5D),
				"no jump while still a block and a half from the step");
		assertTrue(ServerNavigationController.jumpNeeded(TraversalType.JUMP_UP, 1.0D, 0.9D),
				"jump next to a full block step");
		assertTrue(!ServerNavigationController.jumpNeeded(TraversalType.JUMP_UP, 0.5D, 0.9D),
				"a slab is climbed by step height, without a jump");
		assertTrue(!ServerNavigationController.jumpNeeded(TraversalType.JUMP_UP, 0.0D, 0.9D),
				"landing on the step releases the jump instead of hopping again");
		assertTrue(!ServerNavigationController.jumpNeeded(TraversalType.JUMP_GAP, 0.0D, 2.4D),
				"gap jumps wait for the take-off cell");
		assertTrue(ServerNavigationController.jumpNeeded(TraversalType.JUMP_GAP, 0.0D, 1.6D),
				"gap jumps fire from the take-off cell edge");
		assertTrue(!ServerNavigationController.jumpNeeded(TraversalType.JUMP_GAP, 0.0D, 0.7D),
				"a landed gap jump does not re-jump");
		assertTrue(!ServerNavigationController.jumpNeeded(TraversalType.WALK, 0.0D, 0.5D), "walking never jumps");
	}

	private static void verifyGaze() {
		float near = ServerNavigationController.walkingGazePitch(0.0D, 0.6D);
		float far = ServerNavigationController.walkingGazePitch(0.0D, 1.0D);
		assertEquals(near, far, "flat walking gaze is steady between nodes instead of nodding toward the feet");
		assertEquals(ServerNavigationController.WALKING_GAZE_PITCH, near, "flat walking looks slightly below the horizon");
		assertTrue(ServerNavigationController.walkingGazePitch(1.0D, 3.0D) < near, "uphill raises the gaze");
		assertTrue(ServerNavigationController.walkingGazePitch(-1.0D, 3.0D) > near, "downhill lowers the gaze");
		assertEquals(ServerNavigationController.UPHILL_GAZE_PITCH, ServerNavigationController.walkingGazePitch(3.0D, 3.0D),
				"a steep climb keeps the walking gaze below the horizon, off distant enderman eyes");
	}

	/** Alternating east/south steps from (0,0): (0,0) (1,0) (1,1) (2,1) (2,2) ... */
	private static List<PathNode> staircase(int diagonalSteps) {
		List<PathNode> nodes = new ArrayList<>();
		int x = 0;
		int z = 0;
		nodes.add(new PathNode(new GridPosition(x, LEVEL, z), TraversalType.WALK));
		for (int step = 0; step < diagonalSteps; step++) {
			nodes.add(new PathNode(new GridPosition(++x, LEVEL, z), TraversalType.WALK));
			nodes.add(new PathNode(new GridPosition(x, LEVEL, ++z), TraversalType.WALK));
		}
		return nodes;
	}

	private static Set<Long> cells(int minX, int maxX, int minZ, int maxZ) {
		Set<Long> cells = new HashSet<>();
		for (int x = minX; x <= maxX; x++) for (int z = minZ; z <= maxZ; z++) cells.add(key(x, z));
		return cells;
	}

	private static long key(int x, int z) {
		return ((long) x << 32) | (z & 0xffffffffL);
	}

	/** Standable at LEVEL wherever the column is listed; everything else is solid. */
	private static WalkabilityView world(Set<Long> walkable) {
		return position -> {
			boolean column = walkable.contains(key(position.x(), position.z()));
			if (position.y() == LEVEL - 1) return column ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.BLOCKED;
			if (position.y() == LEVEL || position.y() == LEVEL + 1) {
				return column ? WalkabilityView.Cell.CLEAR : WalkabilityView.Cell.BLOCKED;
			}
			return WalkabilityView.Cell.CLEAR;
		};
	}

	/** Every node's feet cell stands on a full block below it. */
	private static Set<GridPosition> supportBlocks(List<PathNode> nodes) {
		Set<GridPosition> blocks = new HashSet<>();
		for (PathNode node : nodes) blocks.add(node.position().below());
		return blocks;
	}

	private static WalkabilityView supportedRoute(List<PathNode> nodes) {
		return solidWorld(supportBlocks(nodes));
	}

	/** Air everywhere except the listed blocks, which are solid and support a body standing on top. */
	private static WalkabilityView solidWorld(Set<GridPosition> solid) {
		return position -> solid.contains(position) ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
	}

	private static void assertEquals(Object expected, Object actual, String message) {
		if (!java.util.Objects.equals(expected, actual)) {
			throw new AssertionError(message + ": expected " + expected + " but was " + actual);
		}
		assertions++;
	}

	private static void assertTrue(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
