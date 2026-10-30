package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.LocalPathfinder;
import dev.agaminggod.arenaagents.client.navigation.PathPlan;
import dev.agaminggod.arenaagents.client.navigation.TraversalType;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import dev.agaminggod.arenaagents.server.runtime.input.VanillaSprint;
import java.util.Set;

/**
 * The Nether run's fight and flee failures as pure checks: melee at a piglin 15 blocks up (unreachable, or reachable by
 * a ramp), piglins below a 5-block drop, sprinting in place, jumping into a wall, policy switches restarting the
 * unreachable clock, and a flee pressed into a pit wall. Round 1 of the fight review adds: verdicts only from seen
 * terrain (F1), bounded or unloaded edges are not proof (F6), the knockback margin on route steps (F5) and
 * follow-through only on the model's opt-in (F3). Round 2 adds: a hidden cell reads as last seen, never live (F1), one
 * combat allowance per tick (B1), and a flee whose way out is behind it turns to look first. Round 3 adds: only news
 * the player perceived retires an answer, and ground just walked stays known behind the body.
 */
public final class FightMovementVerification {
	private static int assertions;
	private static final GridPosition AGENT = new GridPosition(0, 64, 0);
	private static final double REACH = 3.0D;

	private FightMovementVerification() {
	}

	public static void main(String[] args) {
		System.out.println("FightMovementVerification: " + verify() + " assertions passed");
	}

	public static int verify() {
		assertions = 0;
		assertions += FightFactsVerification.verify();
		verifyObservedProgress();
		verifyLevelRouteKeepsFacts();
		verifyUnreachableAbove();
		verifyReachableByRamp();
		verifyUnreachableBelowDrop();
		verifyReachableNearby();
		verifyExactMeleeAim();
		verifySprintParity();
		verifyWallStall();
		verifyPolicySwitchClock();
		verifyFleeStallFacts();
		verifyBlockedFleeFacts();
		verifyHazardEntry();
		verifyObservedTraversal();
		verifyNoJumpProbe();
		verifyKnockbackMargin();
		verifySeenTerrainOnly();
		verifyBoundedSearchIsNotProof();
		verifyStaleTerrain();
		verifyRouteMargin();
		verifyFollowThroughOptIn();
		verifyBudgetedReachCells();
		verifySeenMemory();
		verifyCombatAllowance();
		verifyFleeLooksFirst();
		verifyFleeAlternativeHeadings();
		verifyVisibleContactDetour();
		return assertions;
	}

	private static void verifyVisibleContactDetour() {
		WalkabilityView flat = cell -> cell.y() < 64 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		java.util.function.Predicate<GridPosition> contact = cell -> cell.x() >= 3 && cell.x() <= 8 && Math.abs(cell.z()) <= 3;
		GridPosition goal = new GridPosition(12, 64, 0);
		for (boolean avoid : new boolean[] {false, true}) {
			ObservedTerrain view = ObservedTerrain.over(flat, cell -> true);
			if (avoid) view.withContactCost(cell -> contact.test(cell) ? 200 : 0);
			LocalPathfinder.Search search = new LocalPathfinder().beginSearch(AGENT, Set.of(goal), goal, 24, Set.of());
			PathPlan plan = null;
			for (int slice = 0; slice < 400 && !search.finished(); slice++) {
				plan = search.advance(view, new LocalPathfinder.SearchBudget(LocalPathfinder.MAX_EXPANDED_NODES_PER_SLICE,
						1_000_000_000L, System::nanoTime));
			}
			check(plan != null && plan.nodes().getLast().position().equals(goal), "contact-aware routing still reaches the chosen fight target");
			check(plan.nodes().stream().anyMatch(node -> contact.test(node.position())) != avoid,
					"a visible contact cost selects the clear detour; ordinary routing keeps its direct route");
		}
		ObservedTerrain unseen = ObservedTerrain.over(flat, cell -> false).withContactCost(cell -> 200);
		check(unseen.cellAt(goal) == WalkabilityView.Cell.UNLOADED && unseen.exposureCost(goal) == 0,
				"contact routing never turns unknown terrain into a usable or classified cell");
	}

	/** Ground support at y 63 (feet 64); a 3x3 pillar at x 5..7, z -1..1 whose top is support at y 78 (feet 79). */
	private static WalkabilityView ledge(boolean ramp) {
		return position -> {
			int x = position.x();
			int y = position.y();
			int z = position.z();
			if (y <= 63) return WalkabilityView.Cell.SAFE_SUPPORT;
			if (x >= 5 && x <= 7 && Math.abs(z) <= 1 && y <= 78) return WalkabilityView.Cell.SAFE_SUPPORT;
			// A one-wide staircase east of the pillar at z 0: x 8 tops out at 77 (one jump below the ledge), x 22 at 63.
			if (ramp && z == 0 && x >= 8 && x <= 22 && y <= 77 - (x - 8)) return WalkabilityView.Cell.SAFE_SUPPORT;
			return WalkabilityView.Cell.CLEAR;
		};
	}

	private static Set<GridPosition> reachOfPiglinOnLedge(WalkabilityView world) {
		// A piglin (0.6 x 1.95) standing in the middle of the ledge.
		return MeleeReach.reachCells(world, 6.2D, 79.0D, -0.3D, 6.8D, 80.95D, 0.3D, REACH);
	}

	private static MeleeReach.Verdict search(WalkabilityView world, Set<GridPosition> goals, GridPosition destination, double distance) {
		return search(world, goals, destination, MeleeReach.searchRadius(distance));
	}

	/** The controller's check: the search reads terrain through the player's view (here everything is in sight). */
	private static MeleeReach.Verdict search(WalkabilityView world, Set<GridPosition> goals, GridPosition destination, int radius) {
		return search(ObservedTerrain.over(world, cell -> true), goals, destination, radius);
	}

	private static MeleeReach.Verdict search(ObservedTerrain view, Set<GridPosition> goals, GridPosition destination, int radius) {
		LocalPathfinder.Search search = new LocalPathfinder().beginSearch(AGENT, goals, destination, radius, Set.of());
		PathPlan plan = null;
		for (int slice = 0; slice < 400 && !search.finished(); slice++) {
			plan = search.advance(view, new LocalPathfinder.SearchBudget(LocalPathfinder.MAX_EXPANDED_NODES_PER_SLICE,
					1_000_000_000L, System::nanoTime));
		}
		check(search.finished(), "the bounded reachability search finishes within its radius");
		return MeleeReach.verdict(plan, search.finished(), search.retainedNodes(), goals, search.boundaryReached(), view.openUnknown());
	}

	/** {@code world} inside a closed arena: solid columns everywhere beyond {@code half} blocks, so nothing is cut off. */
	private static WalkabilityView walled(WalkabilityView world, int half) {
		return position -> Math.abs(position.x()) > half || Math.abs(position.z()) > half
				? WalkabilityView.Cell.SAFE_SUPPORT : world.cellAt(position);
	}

	private static void verifyUnreachableAbove() {
		WalkabilityView world = ledge(false);
		Set<GridPosition> goals = reachOfPiglinOnLedge(world);
		check(!goals.isEmpty() && goals.stream().allMatch(cell -> cell.y() == 79),
				"the only cells within melee reach of a piglin on a ledge are on the ledge itself");
		check(goals.stream().noneMatch(cell -> cell.y() == 64), "nobody on the ground 15 blocks below reaches it");
		check(search(walled(world, 10), goals, new GridPosition(6, 79, 0), 16.2D) == MeleeReach.Verdict.UNREACHABLE,
				"a piglin 15 above with no ramp, in a closed and fully seen arena, is unreachable at once (the run waited 5.4 s)");
		check(search(world, goals, new GridPosition(6, 79, 0), 16.2D) == MeleeReach.Verdict.UNSEEN,
				"on open ground the same search only proves there is no route within its box (F6), not that none exists");
	}

	private static void verifyReachableByRamp() {
		WalkabilityView world = ledge(true);
		Set<GridPosition> goals = reachOfPiglinOnLedge(world);
		check(search(world, goals, new GridPosition(6, 79, 0), 16.2D) == MeleeReach.Verdict.REACHABLE,
				"the same piglin with a staircase 15 blocks away is reachable: the approach walks round and up");
	}

	private static void verifyUnreachableBelowDrop() {
		// The agent's plateau at feet 64; a pit x 3..6, z -2..2 with its floor at feet 59 (a 5-block drop).
		WalkabilityView pit = position -> {
			boolean inPit = position.x() >= 3 && position.x() <= 6 && Math.abs(position.z()) <= 2;
			int floor = inPit ? 58 : 63;
			return position.y() <= floor ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		};
		Set<GridPosition> goals = MeleeReach.reachCells(pit, 4.2D, 59.0D, -0.3D, 4.8D, 60.95D, 0.3D, REACH);
		check(!goals.isEmpty() && goals.stream().allMatch(cell -> cell.y() == 59), "only the pit floor reaches a piglin in the pit");
		check(search(walled(pit, 8), goals, new GridPosition(4, 59, 0), 6.5D) == MeleeReach.Verdict.UNREACHABLE,
				"piglins at the bottom of a 5-block drop in a closed arena are unreachable on foot (drops stop at 3)");
		CombatPlanning.Refusal refusal = CombatPlanning.refusal(pit, new GridPosition(2, 64, 0), -90.0F);
		check(refusal != null && refusal.kind() == CombatPlanning.RefusalKind.DROP && refusal.drop() == 5,
				"the refused step names the 5-block drop instead of standing still silently");
		// The same pit 3 deep is a legal, damage-free drop for fight and flee (it was 2 before, stricter than the planner).
		WalkabilityView shallow = position -> {
			boolean inPit = position.x() >= 3 && position.x() <= 6 && Math.abs(position.z()) <= 2;
			return position.y() <= (inPit ? 60 : 63) ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		};
		check(CombatPlanning.canStep(shallow, new GridPosition(2, 64, 0), -90.0F), "a 3-block drop is walked like the planner allows");
		check(!CombatPlanning.canStep(pit, new GridPosition(2, 64, 0), -90.0F), "a 5-block drop is still refused");
	}

	private static void verifyFleeAlternativeHeadings() {
		WalkabilityView tunnel = position -> position.y() <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT
				: position.x() == 0 && position.z() <= 0 ? WalkabilityView.Cell.CLEAR : WalkabilityView.Cell.BLOCKED;
		var back = CombatPlanning.fleeHeading(tunnel, AGENT, 0F, null);
		check(back.clear() && Math.abs(back.yaw()) == 180F, "dead-end escape backtracks through the only known open heading");
		WalkabilityView step = position -> position.y() <= 63 || position.z() >= 1 && position.y() == 64
				? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		var up = CombatPlanning.fleeHeading(step, AGENT, 0F, null);
		check(up.clear() && up.jump(), "a one-block obstruction is escaped by a legal jump and step-up");
		WalkabilityView flat = position -> position.y() <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		var rejected = new java.util.ArrayList<Float>();
		for (int attempt = 0; attempt < 12; attempt++) {
			var next = CombatPlanning.fleeHeading(flat, AGENT, 0F, null, 0F, CombatPlanning.Margin.NONE, rejected);
			check(next.clear() && !rejected.contains(next.yaw()), "each physical stall selects another escape heading");
			rejected.add(next.yaw());
		}
		check(!CombatPlanning.fleeHeading(flat, AGENT, 0F, null, 0F, CombatPlanning.Margin.NONE, rejected).clear(),
				"FLEE_BLOCKED is justified only after every heading failed at this spot");
	}

	private static void verifyBlockedFleeFacts() {
		WalkabilityView unknown = position -> WalkabilityView.Cell.UNLOADED;
		var unseen = ServerFleeController.blockedHeadings(unknown, AGENT, 170.0F, CombatPlanning.Margin.NONE);
		check(unseen.size() == 12 && unseen.stream().allMatch(probe -> probe.refusal() != null
				&& probe.refusal().kind() == CombatPlanning.RefusalKind.UNLOADED),
				"blocked flee feedback preserves unknown terrain instead of claiming a wall or hazard");
		check(unseen.get(0).yaw() == 170.0F && unseen.stream().anyMatch(probe -> probe.yaw() == 80.0F) && unseen.stream().anyMatch(probe -> probe.yaw() == -100.0F),
				"blocked flee probes identify the away heading and both perpendicular directions");
		WalkabilityView boxed = position -> position.y() < 64 ? WalkabilityView.Cell.SAFE_SUPPORT
				: position.x() == 0 && position.z() == 0 ? WalkabilityView.Cell.CLEAR : WalkabilityView.Cell.BLOCKED;
		var walls = ServerFleeController.blockedHeadings(boxed, AGENT, 0.0F, CombatPlanning.Margin.NONE);
		check(walls.stream().allMatch(probe -> probe.refusal() != null
				&& probe.refusal().kind() == CombatPlanning.RefusalKind.WALL),
				"known walls remain walls in the blocked flee facts");
		check(walls.get(0).refusal().at().equals(new GridPosition(0, 64, 1)),
				"the away probe names the acquired wall cell instead of hidden geometry");
	}

	private static void verifyExactMeleeAim() {
		var eye = new net.minecraft.world.phys.Vec3(0.0D, 65.62D, 0.0D);
		var shortBox = new net.minecraft.world.phys.AABB(2.0D, 64.0D, -0.26D, 2.52D, 64.52D, 0.26D);
		var angles = ServerLookController.anglesTo(eye, shortBox.getCenter());
		check(ServerFightController.aimed(eye, angles.yaw(), angles.pitch(), shortBox, 3.0D),
				"aim at a small magma cube intersects its real box within survival reach");
		var missed = new net.minecraft.world.phys.AABB(2.0D, 65.5D, 0.05D, 2.52D, 66.02D, 0.57D);
		check(!ServerFightController.aimed(eye, -90.0F, 0.0F, missed, 3.0D),
				"a crosshair missing a small box by 5 cm must not count as a hit");
		var far = new net.minecraft.world.phys.AABB(3.05D, 65.5D, -0.26D, 3.57D, 66.02D, 0.26D);
		check(!ServerFightController.aimed(eye, -90.0F, 0.0F, far, 3.0D),
				"a real hitbox beyond three blocks cannot be reached by inflation");
	}

	private static void verifyReachableNearby() {
		WalkabilityView flat = position -> position.y() <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		Set<GridPosition> goals = MeleeReach.reachCells(flat, 5.2D, 64.0D, -0.3D, 5.8D, 65.95D, 0.3D, REACH);
		check(search(flat, goals, new GridPosition(5, 64, 0), 5.5D) == MeleeReach.Verdict.REACHABLE, "a zombie on open ground is reachable");
		check(MeleeReach.verdict(null, false, 0, goals, false, false) == MeleeReach.Verdict.UNKNOWN, "an unfinished search decides nothing");
		check(MeleeReach.verdict(PathPlan.failed(dev.agaminggod.arenaagents.client.navigation.PathOutcome.INVALID, 0), true, 0, goals,
				false, false) == MeleeReach.Verdict.UNKNOWN, "an invalid start (edge, slab) decides nothing rather than claiming unreachable");
		PathPlan none = PathPlan.failed(dev.agaminggod.arenaagents.client.navigation.PathOutcome.NO_PATH, 10);
		check(MeleeReach.verdict(none, true, 10, goals, false, false) == MeleeReach.Verdict.UNREACHABLE
				&& MeleeReach.verdict(none, true, 10, goals, true, false) == MeleeReach.Verdict.UNSEEN
				&& MeleeReach.verdict(none, true, 10, goals, false, true) == MeleeReach.Verdict.UNSEEN,
				"only a closed, fully seen area is unreachable; a search edge or unseen cells beside open space are not proof");
		check(MeleeReach.searchRadius(2.0D) == MeleeReach.MIN_SEARCH_RADIUS && MeleeReach.searchRadius(40.0D) == MeleeReach.MAX_SEARCH_RADIUS,
				"the search box is bounded");
		check(MeleeReach.jumpFor(TraversalType.JUMP_UP, 1.0D, true) && !MeleeReach.jumpFor(TraversalType.JUMP_UP, 2.0D, true)
				&& !MeleeReach.jumpFor(TraversalType.JUMP_UP, 1.0D, false) && !MeleeReach.jumpFor(TraversalType.WALK, 0.5D, true),
				"route step-ups are jumped only beside the step and only from the ground");
	}

	private static void verifySprintParity() {
		check(!VanillaSprint.keeps(true, 0.0F, false, false, false), "no sprint without forward input (the pit's sprint-in-place)");
		check(VanillaSprint.keeps(true, 1.0F, false, false, false), "sprint holds while running forward");
		check(!VanillaSprint.keeps(true, -0.6F, false, false, false), "backing off never sprints");
		check(!VanillaSprint.keeps(true, 1.0F, true, false, false), "a head-on wall drops sprint like a vanilla client");
		check(!VanillaSprint.keeps(true, 1.0F, false, false, false, VanillaSprint.enoughFood(false, 6, false)),
				"raw control input cannot sprint at food 6, like a vanilla client");
		check(VanillaSprint.keeps(true, 1.0F, false, false, false, VanillaSprint.enoughFood(false, 7, false)), "food 7 sprints");
		check(VanillaSprint.enoughFood(false, 0, true) && VanillaSprint.enoughFood(true, 0, false),
				"creative flight and riding sprint regardless of food");
		check(VanillaSprint.keeps(true, 1.0F, true, true, false), "grazing a wall (minor collision) keeps sprint");
		check(VanillaSprint.keeps(true, 1.0F, true, false, true), "swim-sprint ignores the wall rule");
		check(!VanillaSprint.keeps(false, 1.0F, false, false, false), "sprint is never added when not requested");
		check(VanillaSprint.minorCollision(0.0F, 0.0F, 1.0F, 0.01D, 0.2D), "moving almost straight along the input is a graze");
		check(!VanillaSprint.minorCollision(0.0F, 0.0F, 1.0F, 0.2D, 0.0D), "being deflected sideways is a full collision");
		check(!VanillaSprint.minorCollision(0.0F, 0.0F, 1.0F, 0.0D, 0.0D), "no movement at all is a full stop");
		check(VanillaSprint.minorCollision(90.0F, 0.0F, 1.0F, -0.2D, 0.01D), "the input direction turns with the yaw");
	}

	private static void verifyWallStall() {
		CombatStallDetector detector = new CombatStallDetector();
		CombatStallDetector.Stall stall = null;
		for (int tick = 0; tick < CombatStallDetector.WINDOW_TICKS && stall == null; tick++) {
			// Jumping into the wall: up and down every 12 ticks, a few hundredths sideways, a ceiling bump at each apex.
			int phase = tick % 12;
			boolean grounded = phase == 0;
			stall = detector.observe(0.3D + 0.02D * (tick % 3), 64.0D + (grounded ? 0.0D : 1.0D), 0.5D, grounded, true, true, phase == 6);
		}
		check(stall != null && stall.metres() < CombatStallDetector.MIN_PROGRESS_BLOCKS && stall.ceilingBumps() > 0 && stall.wallTicks() > 0,
				"jumping into a wall under a low ceiling is a stall, with the bumps counted (it reset navigation's detector)");
		detector.reset();
		stall = null;
		for (int tick = 0; tick < 80 && stall == null; tick++) stall = detector.observe(tick * 0.2D, 64.0D, 0.0D, true, true, false, false);
		check(stall == null, "a sprinting approach never stalls");
		detector.reset();
		stall = null;
		for (int tick = 0; tick < 80 && stall == null; tick++) {
			double angle = tick * 0.4D;
			stall = detector.observe(0.4D * Math.cos(angle), 64.0D, 0.4D * Math.sin(angle), true, true, true, false);
		}
		check(stall != null, "circling in a corner covers no net ground and stalls");
		detector.reset();
		stall = null;
		for (int tick = 0; tick < 80 && stall == null; tick++) stall = detector.observe(0.5D, 64.0D + tick * 0.12D, 0.5D, true, true, false, false);
		check(stall == null, "climbing a ladder gains height and is progress");
		detector.reset();
		stall = null;
		for (int tick = 0; tick < 80 && stall == null; tick++) stall = detector.observe(0.0D, 64.0D, 0.0D, true, tick % 4 == 0, false, false);
		check(stall == null, "standing to swing or recharge is not a stall");
	}

	private static void verifyPolicySwitchClock() {
		// nearest_attacker alternating between two unreachable piglins every 10 ticks, distances jittering.
		CombatPlanning.ProgressClock clock = new CombatPlanning.ProgressClock();
		int ticks = 0;
		for (int tick = 0; tick < ServerFightController.UNREACHABLE_TICKS; tick++) {
			if (tick > 0 && tick % 10 == 0) clock.switched(tick % 20 == 0 ? 4.7D : 5.5D);
			ticks = clock.observe(tick % 20 < 10 ? 4.7D : 5.5D);
		}
		check(ticks >= ServerFightController.UNREACHABLE_TICKS - 1,
				"policy switches no longer restart the unreachable clock (the pit fight ran 7.05 s)");
		clock.progressed();
		check(clock.ticks() == 0, "a landed hit or a step along the route resets it");
		CombatPlanning.ProgressClock approach = new CombatPlanning.ProgressClock();
		approach.observe(10.0D);
		approach.observe(10.0D);
		check(approach.ticks() == 1 && approach.observe(9.4D) == 0, "gaining half a block on the target resets it");
		clock.killed();
		check(clock.observe(12.0D) == 0, "a kill starts the follow-through fresh");
	}

	private static void verifyFleeStallFacts() {
		// A pit wall straight ahead (south): solid from the floor up.
		WalkabilityView wall = position -> position.y() <= 63 || position.z() >= 1 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		CombatPlanning.Refusal refusal = CombatPlanning.refusal(wall, AGENT, 0.0F);
		check(refusal != null && refusal.kind() == CombatPlanning.RefusalKind.WALL && refusal.at().equals(new GridPosition(0, 64, 1)),
				"a flee pressed into a pit wall names the wall cell");
		// A one-block step under a ceiling two blocks above the feet: the jump is refused by the ceiling.
		WalkabilityView ceiling = position -> {
			if (position.y() <= 63 || (position.z() >= 1 && position.y() == 64) || (position.z() <= 0 && position.y() == 66)) {
				return WalkabilityView.Cell.SAFE_SUPPORT;
			}
			return WalkabilityView.Cell.CLEAR;
		};
		CombatPlanning.Refusal low = CombatPlanning.refusal(ceiling, AGENT, 0.0F);
		check(low != null && low.kind() == CombatPlanning.RefusalKind.LOW_CEILING, "a step-up under a low ceiling is named as such");
		WalkabilityView open = position -> position.y() <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		check(CombatPlanning.refusal(open, AGENT, 0.0F) == null, "an open heading has no refusal");
		CombatStallDetector detector = new CombatStallDetector();
		CombatStallDetector.Stall stall = null;
		for (int tick = 0; tick < CombatStallDetector.WINDOW_TICKS && stall == null; tick++) {
			stall = detector.observe(0.5D, 64.0D, 0.69D + 0.001D * tick, true, true, true, false);
		}
		check(stall != null && stall.wallTicks() == CombatStallDetector.WINDOW_TICKS, "a flee sprinting into a wall stalls in 2 s");
	}

	private static void verifyHazardEntry() {
		// The input is terrain contact (HazardExits.contact), null for none or for a fire-immune body. Burning from a blaze
		// or a flaming arrow on dry ground is no contact: the same rule for every action, fight and flee included.
		HazardEntry fight = new HazardEntry();
		check(fight.observe((HazardExits.Contact) null) == null && fight.observe((HazardExits.Contact) null) == null,
				"dry ground never stops a fight, burning or not (an arrow or blaze ignition is not terrain)");
		check(HazardEntry.IN_LAVA.equals(fight.observe(HazardExits.Contact.LAVA)),
				"falling into lava stops the fight at once (the run's fight aimed 4.4 s more in lava)");
		HazardEntry chosen = new HazardEntry();
		check(chosen.observe(HazardExits.Contact.LAVA) == null && chosen.observe(HazardExits.Contact.LAVA) == null,
				"a fight the model started while already in lava is its own informed choice");
		check(chosen.observe((HazardExits.Contact) null) == null && HazardEntry.IN_LAVA.equals(chosen.observe(HazardExits.Contact.LAVA)),
				"leaving and falling back in stops it");
		HazardEntry fire = new HazardEntry();
		fire.observe((HazardExits.Contact) null);
		check(HazardEntry.ON_FIRE.equals(fire.observe(HazardExits.Contact.FIRE)), "walking into a fire block stops it");
		check(fire.observe(HazardExits.Contact.FIRE) == null, "standing on in the same fire is no new entry");
		HazardEntry burning = new HazardEntry();
		burning.observe(HazardExits.Contact.FIRE);
		check(burning.observe(HazardExits.Contact.FIRE) == null, "an action started in fire is not stopped by it");
		HazardEntry hot = new HazardEntry();
		hot.observe((HazardExits.Contact) null);
		check(hot.observe(HazardExits.Contact.HOT_FLOOR) == null, "magma or a campfire underfoot is reported, never a stop");
		HazardEntry immune = new HazardEntry();
		immune.observe((HazardExits.Contact) null);
		check(immune.observe((HazardExits.Contact) null) == null, "Fire Resistance makes lava harmless: an immune body touches nothing");
		check(HazardEntry.IN_LAVA.equals(immune.observe(HazardExits.Contact.LAVA)),
				"lava that turns damaging (the effect runs out while in it) stops like a new entry");
	}

	/**
	 * Fight and flee read navigation's traversal rules from the known block states (honey and cobweb forbid jumps, soul
	 * sand slows, lava beside a cell costs, magma is footing for a protected body); a cell nobody saw keeps the default.
	 */
	private static void verifyObservedTraversal() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		java.util.Map<net.minecraft.core.BlockPos, net.minecraft.world.level.block.state.BlockState> states = new java.util.HashMap<>();
		net.minecraft.world.level.BlockGetter level = new net.minecraft.world.level.BlockGetter() {
			@Override
			public net.minecraft.world.level.block.entity.BlockEntity getBlockEntity(net.minecraft.core.BlockPos position) {
				return null;
			}

			@Override
			public net.minecraft.world.level.block.state.BlockState getBlockState(net.minecraft.core.BlockPos position) {
				return states.getOrDefault(position, net.minecraft.world.level.block.Blocks.AIR.defaultBlockState());
			}

			@Override
			public net.minecraft.world.level.material.FluidState getFluidState(net.minecraft.core.BlockPos position) {
				return getBlockState(position).getFluidState();
			}

			@Override
			public int getHeight() {
				return 384;
			}

			@Override
			public int getMinY() {
				return -64;
			}
		};
		var blocks = new Object() {
			void put(int x, int y, int z, net.minecraft.world.level.block.Block block) {
				states.put(new net.minecraft.core.BlockPos(x, y, z), block.defaultBlockState());
			}
		};
		for (int x = -3; x <= 3; x++) for (int z = -3; z <= 3; z++) blocks.put(x, 63, z, net.minecraft.world.level.block.Blocks.STONE);
		blocks.put(0, 63, 0, net.minecraft.world.level.block.Blocks.HONEY_BLOCK);
		blocks.put(1, 63, 0, net.minecraft.world.level.block.Blocks.SOUL_SAND);
		blocks.put(2, 63, 0, net.minecraft.world.level.block.Blocks.MAGMA_BLOCK);
		blocks.put(3, 63, 0, net.minecraft.world.level.block.Blocks.LAVA);
		blocks.put(-1, 64, 0, net.minecraft.world.level.block.Blocks.COBWEB);
		blocks.put(0, 64, -2, net.minecraft.world.level.block.Blocks.FIRE);
		// x = -3 is out of sight: honey and lava there are never seen.
		blocks.put(-3, 63, 0, net.minecraft.world.level.block.Blocks.HONEY_BLOCK);
		blocks.put(-3, 63, 1, net.minecraft.world.level.block.Blocks.LAVA);
		java.util.function.Function<Boolean, ObservedTerrain> view = magmaProtected -> new ObservedTerrain(ObservedTerrain.known(
				new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), new SeenTerrain.Source<>() {
					@Override
					public net.minecraft.world.level.block.state.BlockState live(int x, int y, int z) {
						return level.getBlockState(new net.minecraft.core.BlockPos(x, y, z));
					}

					@Override
					public boolean sees(int x, int y, int z) {
						return x != -3;
					}
				}, 0L, null), level, magmaProtected, 0, false), null);
		ObservedTerrain plain = view.apply(false);
		var air = net.minecraft.world.level.block.Blocks.AIR.defaultBlockState();
		check(!plain.canJumpFrom(new GridPosition(0, 64, 0))
				&& !MinecraftNavigationWorld.canJump(air, air, net.minecraft.world.level.block.Blocks.HONEY_BLOCK.defaultBlockState()),
				"honey underfoot forbids a jump for fight as for navigation");
		check(plain.canJumpFrom(new GridPosition(0, 64, 1)), "stone underfoot allows a jump");
		check(!plain.canJumpFrom(new GridPosition(-1, 64, 0)), "a cobweb at the feet forbids a jump");
		check(plain.canJumpFrom(new GridPosition(-3, 64, 0)), "honey nobody saw never shapes a fight route");
		double soul = MinecraftNavigationWorld.movementSpeed(air, air, net.minecraft.world.level.block.Blocks.SOUL_SAND.defaultBlockState(), 0, false);
		check(plain.movementSpeedMultiplier(new GridPosition(1, 64, 0)) == soul && soul < 1.0D, "soul sand slows fight as it slows navigation");
		check(plain.movementSpeedMultiplier(new GridPosition(-3, 64, 0)) == 1.0D, "unknown ground keeps the plain speed");
		// Seen lava costing 12 needs bound fluid tags (a server): checked live. Unseen lava must cost nothing either way.
		check(plain.exposureCost(new GridPosition(-2, 64, 1)) == 0, "lava nobody saw adds no cost");
		check(!plain.isStandable(new GridPosition(2, 64, 0)), "magma is no footing for an unprotected body");
		check(view.apply(true).isStandable(new GridPosition(2, 64, 0)), "magma is footing with Fire Resistance or Frost Walker");
		check(!plain.isGapClear(new GridPosition(0, 64, -2)), "a fire block is no gap a jump clears (the box touches it below its top), as in navigation");
	}

	/** The direct steering probe applies the jump rule too: a one-block step up from honey is a wall. */
	private static void verifyNoJumpProbe() {
		java.util.function.Function<Boolean, WalkabilityView> world = jump -> new WalkabilityView() {
			@Override
			public Cell cellAt(GridPosition position) {
				if (position.x() == 0 && position.y() == 64 && position.z() == 1) return Cell.SAFE_SUPPORT;
				return position.y() <= 63 ? Cell.SAFE_SUPPORT : Cell.CLEAR;
			}

			@Override
			public boolean canJumpFrom(GridPosition position) {
				return jump || !position.equals(AGENT);
			}
		};
		check(CombatPlanning.canStep(world.apply(true), AGENT, 0.0F), "a one-block step up is climbed from stone");
		check(!CombatPlanning.canStep(world.apply(false), AGENT, 0.0F), "the same step is refused from honey");
		CombatPlanning.Refusal refusal = CombatPlanning.refusal(world.apply(false), AGENT, 0.0F);
		check(refusal != null && refusal.kind() == CombatPlanning.RefusalKind.WALL && refusal.at().equals(new GridPosition(0, 64, 1)),
				"and is named as a wall at the step");
	}

	private static void verifyKnockbackMargin() {
		// Flat ground; a lava pool cell at (1,63,1), beside the cell south of the agent.
		WalkabilityView pool = position -> {
			if (position.x() == 1 && position.z() == 1 && position.y() == 63) return WalkabilityView.Cell.HAZARD;
			return position.y() <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		};
		CombatPlanning.Margin near = new CombatPlanning.Margin(true, Set.of());
		check(CombatPlanning.canStep(pool, AGENT, 0.0F), "without a mob near, walking past the pool's edge is allowed");
		check(!CombatPlanning.canStep(pool, AGENT, 0.0F, near), "with a mob within 3 blocks, lava beside the next cell is refused");
		CombatPlanning.Refusal refusal = CombatPlanning.refusal(pool, AGENT, 0.0F, near);
		check(refusal != null && refusal.kind() == CombatPlanning.RefusalKind.HAZARD && refusal.at().equals(new GridPosition(1, 63, 1)),
				"the margin refusal names the lava cell");
		check(CombatPlanning.canStep(pool, AGENT, 180.0F, near), "stepping away from the pool stays allowed");
		// The body overhangs column (1,0), a 1x1 shaft down to lava at y 60 (the branch run's fatal shaft).
		WalkabilityView shaft = position -> {
			if (position.x() == 1 && position.z() == 0) {
				if (position.y() == 60) return WalkabilityView.Cell.HAZARD;
				return position.y() < 60 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
			}
			return position.y() <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		};
		CombatPlanning.Margin overhanging = new CombatPlanning.Margin(true, Set.of(new GridPosition(1, 64, 0)));
		check(CombatPlanning.canStep(shaft, AGENT, -45.0F), "without the margin a diagonal step past the shaft is allowed");
		check(!CombatPlanning.canStep(shaft, AGENT, -45.0F, overhanging),
				"under knockback risk, moving toward the overhung shaft edge is refused");
		check(CombatPlanning.canStep(shaft, AGENT, 90.0F, overhanging), "moving back onto the support is allowed");
		WalkabilityView lake = position -> {
			if (position.x() == 1 && position.z() == 1) {
				if (position.y() <= 58) return WalkabilityView.Cell.SAFE_SUPPORT;
				return position.y() <= 59 ? WalkabilityView.Cell.WATER : WalkabilityView.Cell.CLEAR;
			}
			return position.y() <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		};
		check(CombatPlanning.canStep(lake, AGENT, 0.0F, near), "a deep drop into water beside the path is not a damaging drop");
	}

	/**
	 * F1: the search reads only cells the player can see. A ramp behind the pillar (out of sight) is never used to find
	 * a route, and its absence from view never proves the target unreachable.
	 */
	private static void verifySeenTerrainOnly() {
		WalkabilityView world = walled(ledge(true), 24);
		Set<GridPosition> goals = reachOfPiglinOnLedge(world);
		check(search(world, goals, new GridPosition(6, 79, 0), 24) == MeleeReach.Verdict.REACHABLE,
				"with the staircase in sight the approach walks round and up it");
		// The staircase at x >= 8 is behind the pillar: the player has not seen it.
		ObservedTerrain hidden = ObservedTerrain.over(world, cell -> cell.x() < 8);
		MeleeReach.Verdict verdict = search(hidden, goals, new GridPosition(6, 79, 0), 24);
		check(verdict == MeleeReach.Verdict.UNSEEN,
				"with the staircase out of sight there is no route through seen terrain, and no proof there is none");
		SeenTerrain.Memory<WalkabilityView.Cell> remembered = new SeenTerrain.Memory<>();
		ObservedTerrain first = ObservedTerrain.over(world, remembered, 0L, cell -> cell.x() < 8 || cell.y() <= 70);
		search(first, goals, new GridPosition(6, 79, 0), 24);
		ObservedTerrain later = ObservedTerrain.over(world, remembered, 40L, cell -> cell.x() < 8 || cell.y() > 66);
		check(search(later, goals, new GridPosition(6, 79, 0), 24) == MeleeReach.Verdict.REACHABLE,
				"cells seen 2 s earlier stay known: the lower stairs seen first and the upper ones later make a route");
		ObservedTerrain forgotten = ObservedTerrain.over(world, remembered, 40L + SeenTerrain.MEMORY_TICKS + 1L,
				cell -> cell.x() < 8 || cell.y() > 66);
		check(search(forgotten, goals, new GridPosition(6, 79, 0), 24) != MeleeReach.Verdict.REACHABLE,
				"after 10 s out of sight the lower stairs are forgotten and no longer make a route");
		// Buried cells under a seen floor and inside seen walls are unknown but cannot hide a route.
		WalkabilityView closed = walled(ledge(false), 10);
		ObservedTerrain surface = ObservedTerrain.over(closed,
				cell -> cell.y() >= 63 && Math.abs(cell.x()) <= 11 && Math.abs(cell.z()) <= 11
						&& !(cell.x() == 6 && cell.z() == 0 && cell.y() < 78));
		check(search(surface, reachOfPiglinOnLedge(closed), new GridPosition(6, 79, 0), 16) == MeleeReach.Verdict.UNREACHABLE,
				"unseen cells buried under the seen floor or inside the pillar do not stop a closed arena being unreachable");
	}

	/**
	 * F2 and fight review r3 (hidden region revisions): one check reads one consistent picture, and its negative answer
	 * is retired only when the player learns something new about a cell it read, never by a change nobody perceived.
	 */
	private static void verifyStaleTerrain() {
		java.util.Map<GridPosition, WalkabilityView.Cell> placed = new java.util.HashMap<>();
		WalkabilityView world = walled(position -> placed.getOrDefault(position, ledge(false).cellAt(position)), 10);
		SeenTerrain.Memory<WalkabilityView.Cell> memory = new SeenTerrain.Memory<>();
		// The eye sees the arena west of x 3 (the pillar's far side and the ground behind it are out of sight).
		java.util.function.Predicate<GridPosition> sight = cell -> cell.x() < 3;
		ObservedTerrain view = ObservedTerrain.forCheck(ObservedTerrain.known(ObservedTerrain.reader(world, memory, 0L, sight)), memory);
		view.beginSlice();
		check(search(view, reachOfPiglinOnLedge(world), new GridPosition(6, 79, 0), 16) == MeleeReach.Verdict.UNSEEN,
				"with the far side out of sight there is no seen route and no proof there is none");
		view.endSlice();
		GridPosition hidden = new GridPosition(9, 64, 0);
		check(view.cellAt(hidden) == WalkabilityView.Cell.UNLOADED, "a cell behind the pillar is unknown to the check");
		view.endSlice();
		// The reviewer's probe: a block toggled out of sight (underground, behind the pillar) while the check runs.
		placed.put(new GridPosition(-6, 50, 0), WalkabilityView.Cell.CLEAR);
		placed.put(new GridPosition(9, 63, 0), WalkabilityView.Cell.CLEAR);
		ObservedTerrain.over(world, memory, 1L, sight).cellAt(new GridPosition(9, 63, 0));
		view.rebind(ObservedTerrain.known(ObservedTerrain.reader(world, memory, 1L, sight)));
		view.beginSlice();
		check(view.unchanged(), "a block changing out of sight never retires the answer (r3: a hidden underground toggle did)");
		view.endSlice();
		ObservedTerrain.over(world, memory, 2L, cell -> true).cellAt(new GridPosition(-30, 70, 30));
		view.rebind(ObservedTerrain.known(ObservedTerrain.reader(world, memory, 2L, sight)));
		view.beginSlice();
		check(view.unchanged(), "a fact acquired about a cell the check never read leaves it standing");
		view.endSlice();
		// Another consumer (steering) sees the cell the check read as unknown.
		ObservedTerrain.over(world, memory, 3L, cell -> cell.equals(hidden)).cellAt(hidden);
		view.rebind(ObservedTerrain.known(ObservedTerrain.reader(world, memory, 3L, sight)));
		view.beginSlice();
		check(!view.unchanged(), "a cell the check read as unknown and the player has seen since retires the answer");
		check(view.cellAt(hidden) == WalkabilityView.Cell.UNLOADED, "within one check a cell keeps the value it first read as");
		view.endSlice();
		view.beginSlice();
		check(!view.unchanged(), "once retired it stays retired");
	}

	/**
	 * F1 (fight review r2): what the player knows of a hidden cell is what it looked like when last seen, for 10 s.
	 * The reviewer's probe: seen CLEAR, changed to HAZARD out of sight, read again with no sight: it was HAZARD (live).
	 */
	private static void verifySeenMemory() {
		GridPosition cell = new GridPosition(-6, 64, 0);
		java.util.Map<GridPosition, WalkabilityView.Cell> facts = new java.util.HashMap<>();
		WalkabilityView world = position -> facts.getOrDefault(position, WalkabilityView.Cell.CLEAR);
		SeenTerrain.Memory<WalkabilityView.Cell> memory = new SeenTerrain.Memory<>();
		check(ObservedTerrain.over(world, memory, 0L, position -> true).cellAt(cell) == WalkabilityView.Cell.CLEAR,
				"a cell in sight reads as it is");
		facts.put(cell, WalkabilityView.Cell.HAZARD);
		check(ObservedTerrain.over(world, memory, 20L, position -> false).cellAt(cell) == WalkabilityView.Cell.CLEAR,
				"changed out of sight, it reads as last seen (was HAZARD, the live value)");
		check(ObservedTerrain.over(world, memory, 20L + SeenTerrain.MEMORY_TICKS, position -> false).cellAt(cell)
				== WalkabilityView.Cell.UNLOADED, "10 s after it was last seen it is unknown");
		check(ObservedTerrain.over(world, memory, 300L, position -> true).cellAt(cell) == WalkabilityView.Cell.HAZARD,
				"seen again, it reads as it is now");
		check(ObservedTerrain.over(world, position -> false).cellAt(cell) == WalkabilityView.Cell.UNLOADED,
				"never seen, it is unknown whatever it holds");
		// A remembered cell whose value has not changed needs no sight line: seen or hidden, the answer is the same.
		int[] rays = {0};
		SeenTerrain.Memory<WalkabilityView.Cell> warm = new SeenTerrain.Memory<>();
		SeenTerrain.Source<WalkabilityView.Cell> source = new SeenTerrain.Source<>() {
			@Override
			public WalkabilityView.Cell live(int x, int y, int z) {
				return world.cellAt(new GridPosition(x, y, z));
			}

			@Override
			public boolean sees(int x, int y, int z) {
				rays[0]++;
				return true;
			}
		};
		new SeenTerrain.Reader<>(warm, source, 0L, null).known(1, 64, 0);
		SeenTerrain.Reader<WalkabilityView.Cell> next = new SeenTerrain.Reader<>(warm, source, 1L, null);
		check(next.known(1, 64, 0) == WalkabilityView.Cell.CLEAR && rays[0] == 1,
				"an unchanged remembered cell costs a lookup, not another sight ray");
		check(next.secondsSinceSeen(1, 64, 0) == 0 && rays[0] == 2, "asked whether it is in view now, it casts the ray");
		SeenTerrain.Memory<WalkabilityView.Cell> touched = new SeenTerrain.Memory<>();
		SeenTerrain.Reader<WalkabilityView.Cell> body = new SeenTerrain.Reader<>(touched, new SeenTerrain.Source<>() {
			@Override
			public WalkabilityView.Cell live(int x, int y, int z) {
				return y < 64 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
			}

			@Override
			public boolean sees(int x, int y, int z) {
				return false;
			}

			@Override
			public boolean touches(int x, int y, int z) {
				return x == 0 && z == 0 && y >= 63 && y <= 65;
			}
		}, 0L, null);
		check(body.known(0, 63, 0) == WalkabilityView.Cell.SAFE_SUPPORT && body.known(0, 64, 0) == WalkabilityView.Cell.CLEAR,
				"the block under the feet and the cells the body is in are known by touch");
		check(body.known(-1, 64, 0) == null && body.known(0, 66, 0) == null,
				"the cell behind the body and the one above the head are not (no closeness allowance)");
	}

	/** B1: all fights share one 2 ms combat allowance per tick; a slice charges what it used and stops at the rest. */
	private static void verifyCombatAllowance() {
		long[] now = {0L};
		ServerPathPlanner.TickBudget budget = new ServerPathPlanner.TickBudget(8_192, 40_000_000L, () -> now[0]);
		try (ServerPathPlanner.CombatSlice first = budget.combatSlice()) {
			now[0] += 1_500_000L;
			check(!first.over(), "the first fight has the allowance to itself");
		}
		check(budget.combatNanosLeft() == 500_000L, "the slice charged the 1.5 ms it used");
		try (ServerPathPlanner.CombatSlice second = budget.combatSlice()) {
			now[0] += 400_000L;
			check(!second.over(), "the second fight gets what is left");
			now[0] += 100_000L;
			check(second.over(), "and stops once the shared 2 ms is spent, not after its own 2 ms");
		}
		check(budget.combatNanosLeft() == 0L, "nothing is left for a third fight this tick");
		check(new ServerPathPlanner.TickBudget(8_192, 40_000_000L, () -> 0L).combatNanosLeft()
				== ServerPathPlanner.COMBAT_ALLOWANCE_NANOS, "the next tick starts with a fresh 2 ms");
	}

	/** Facing a chaser, the way out is behind and unseen: the flee turns to look, it never steps on assumed ground. */
	private static void verifyFleeLooksFirst() {
		WalkabilityView flat = position -> position.y() <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		// Facing +x (yaw -90) at a chaser to the east; the ground west (x < 0, "away") is behind the eye and unseen.
		ObservedTerrain view = ObservedTerrain.over(flat, cell -> cell.x() >= 1 || (cell.x() == 0 && cell.z() == 0));
		float away = 90.0F;
		CombatPlanning.Heading known = CombatPlanning.fleeHeading(view, AGENT, away, null);
		check(!known.clear() || Math.abs(net.minecraft.util.Mth.wrapDegrees(known.yaw() - away)) > 90.0F,
				"on seen ground alone the only open headings lead back toward the chaser");
		CombatPlanning.Heading look = CombatPlanning.fleeHeading(ServerFleeController.assumingLevelGround(view, AGENT.y()), AGENT,
				away, null);
		check(look.clear() && look.yaw() == away,
				"assuming level ground only to choose where to look, it turns straight away from the chaser first");
		// Fight review r3: the ground the body walked in on (x -3..0, here touched on the way) stays known behind it.
		SeenTerrain.Memory<WalkabilityView.Cell> walked = new SeenTerrain.Memory<>();
		for (int x = -3; x <= 0; x++) {
			int column = x;
			SeenTerrain.Reader<WalkabilityView.Cell> body = new SeenTerrain.Reader<>(walked, new SeenTerrain.Source<>() {
				@Override
				public WalkabilityView.Cell live(int cx, int cy, int cz) {
					return flat.cellAt(new GridPosition(cx, cy, cz));
				}

				@Override
				public boolean sees(int cx, int cy, int cz) {
					return false;
				}

				@Override
				public boolean touches(int cx, int cy, int cz) {
					return cx == column && cz == 0 && cy >= 63 && cy <= 65;
				}
			}, 10L + x, null);
			for (int y = 63; y <= 65; y++) body.known(x, y, 0);
		}
		ObservedTerrain later = ObservedTerrain.over(flat, walked, 10L + SeenTerrain.MEMORY_TICKS + 100L,
				cell -> cell.x() >= 1 || (cell.x() == 0 && cell.z() == 0));
		check(CombatPlanning.canStep(later, AGENT, away), "15 s later, stepping back onto ground just walked is allowed");
		check(!CombatPlanning.canStep(view, AGENT, away), "never walked nor seen, the rear is unknown and the backstep is refused");
		CombatPlanning.Heading back = CombatPlanning.fleeHeading(later, AGENT, away, null);
		check(back.clear() && back.yaw() == away, "a flee can run straight back along the way it came, without looking first");
		ObservedTerrain gone = ObservedTerrain.over(flat, walked, 10L + SeenTerrain.WALKED_MEMORY_TICKS + 1L,
				cell -> cell.x() >= 1 || (cell.x() == 0 && cell.z() == 0));
		check(!CombatPlanning.canStep(gone, AGENT, away), "30 s after it was walked the ground is unknown again");
	}

	/** F6 (the reviewer's Java probes): a search that stops at its box or at unloaded terrain is not proof of unreachable. */
	private static void verifyBoundedSearchIsNotProof() {
		WalkabilityView nearRamp = position -> {
			int x = position.x();
			int y = position.y();
			int z = position.z();
			if (y <= 63 || (x >= 5 && x <= 20 && Math.abs(z) <= 1 && y <= 68) || (z == 0 && x >= 21 && x <= 25 && y <= 67 - (x - 21))) {
				return WalkabilityView.Cell.SAFE_SUPPORT;
			}
			return WalkabilityView.Cell.CLEAR;
		};
		Set<GridPosition> goals = MeleeReach.reachCells(nearRamp, 6.2D, 69.0D, -0.3D, 6.8D, 70.95D, 0.3D, REACH);
		check(search(nearRamp, goals, new GridPosition(6, 69, 0), MeleeReach.searchRadius(Math.hypot(6.5D, 5.0D)))
				== MeleeReach.Verdict.UNSEEN, "a staircase just past the 17-block search box is not proof of unreachable (was UNREACHABLE)");
		check(search(nearRamp, goals, new GridPosition(6, 69, 0), 28) == MeleeReach.Verdict.REACHABLE,
				"with a wider box the same staircase is found");
		WalkabilityView unloaded = position -> {
			if (position.x() >= 10) return WalkabilityView.Cell.UNLOADED;
			if (position.y() <= 63 || (position.x() >= 5 && position.x() <= 7 && Math.abs(position.z()) <= 1 && position.y() <= 78)) {
				return WalkabilityView.Cell.SAFE_SUPPORT;
			}
			return WalkabilityView.Cell.CLEAR;
		};
		check(search(walled(unloaded, 12), reachOfPiglinOnLedge(unloaded), new GridPosition(6, 79, 0), 25) == MeleeReach.Verdict.UNSEEN,
				"ground running on into unloaded chunks at x 10 is not proof of unreachable (was UNREACHABLE)");
	}

	/** F5: the knockback margin also holds a planned route step, without outlawing the route's legal gap jumps. */
	private static void verifyRouteMargin() {
		// The reviewer's live layout: lava along z 1 at y 63, the route east along z 0.
		WalkabilityView rim = position -> {
			if (position.z() == 1 && position.x() >= 1 && position.x() <= 9 && position.y() == 63) return WalkabilityView.Cell.HAZARD;
			return position.y() <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		};
		CombatPlanning.Margin near = new CombatPlanning.Margin(true, Set.of());
		GridPosition next = new GridPosition(1, 64, 0);
		CombatPlanning.Refusal refusal = CombatPlanning.routeMarginRefusal(rim, AGENT, next, TraversalType.WALK, near);
		check(refusal != null && refusal.kind() == CombatPlanning.RefusalKind.HAZARD && refusal.at().equals(new GridPosition(1, 63, 1)),
				"with a mob within 3 blocks the route step along the lava rim is held and names the lava (it walked to x 5.87)");
		check(CombatPlanning.routeMarginRefusal(rim, AGENT, next, TraversalType.WALK, CombatPlanning.Margin.NONE) == null,
				"with no mob near, the planned route walks the rim");
		check(CombatPlanning.routeMarginRefusal(rim, AGENT, new GridPosition(-1, 64, 0), TraversalType.WALK, near) == null,
				"a route step away from the lava keeps the margin");
		// The body overhangs (0,64,-1), a 1x1 shaft down to lava at y 60, beside the route north of it.
		WalkabilityView shaft = position -> {
			if (position.x() == 0 && position.z() == -1) return position.y() == 60 ? WalkabilityView.Cell.HAZARD
					: position.y() < 60 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
			return position.y() <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		};
		CombatPlanning.Margin overhanging = new CombatPlanning.Margin(true, Set.of(new GridPosition(0, 64, -1)));
		CombatPlanning.Refusal overhang = CombatPlanning.routeMarginRefusal(shaft, AGENT, new GridPosition(0, 64, -2),
				TraversalType.JUMP_GAP, overhanging);
		check(overhang != null && overhang.kind() == CombatPlanning.RefusalKind.HAZARD,
				"a planned jump north across the overhung lava shaft is held under knockback");
		check(CombatPlanning.routeMarginRefusal(shaft, AGENT, new GridPosition(0, 64, 1), TraversalType.WALK, overhanging) == null,
				"a route step away from the overhung shaft is not held by it");
		WalkabilityView dryShaft = position -> position.x() == 0 && position.z() == -1
				? (position.y() <= 58 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR)
				: position.y() <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		check(CombatPlanning.routeMarginRefusal(dryShaft, AGENT, new GridPosition(0, 64, -2), TraversalType.JUMP_GAP, overhanging) == null,
				"overhanging a dry gap the route jumps is the jump itself, not a refusal");
		// A one-block gap 5 deep with no lava: a legal planned gap jump stays legal under knockback.
		WalkabilityView trench = position -> {
			if (position.x() == 1) return position.y() <= 58 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
			return position.y() <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		};
		check(CombatPlanning.routeMarginRefusal(trench, AGENT, new GridPosition(2, 64, 0), TraversalType.JUMP_GAP, near) == null,
				"a planned jump across a deep gap is not refused for the gap it clears");
		WalkabilityView lavaTrench = position -> {
			if (position.x() == 1 && position.y() == 59) return WalkabilityView.Cell.HAZARD;
			return trench.cellAt(position);
		};
		CombatPlanning.Refusal gapLava = CombatPlanning.routeMarginRefusal(lavaTrench, AGENT, new GridPosition(2, 64, 0),
				TraversalType.JUMP_GAP, near);
		check(gapLava != null && gapLava.kind() == CombatPlanning.RefusalKind.HAZARD, "a gap jump over lava is held under knockback");
	}

	/** F3: a named fight ends with its target; going on needs the model's continueWithAttackers:true or a policy. */
	private static void verifyFollowThroughOptIn() {
		check(!CombatPlanning.followThrough(null, CombatPlanning.TargetPolicy.NAMED),
				"omitted, a named fight stops when its target dies (it swung 8x at a second zombie the model never named)");
		check(CombatPlanning.followThrough(true, CombatPlanning.TargetPolicy.NAMED), "continueWithAttackers:true opts in");
		check(CombatPlanning.followThrough(null, CombatPlanning.TargetPolicy.HIGHEST_RISK)
				&& CombatPlanning.followThrough(null, CombatPlanning.TargetPolicy.NEAREST_ATTACKER),
				"a targetPolicy is the model's own selection rule, so it continues by it");
		check(!CombatPlanning.followThrough(false, CombatPlanning.TargetPolicy.HIGHEST_RISK), "an explicit false always wins");
	}

	/** The reach-cell scan claims the shared per-tick planning budget and resumes where it stopped. */
	private static void verifyBudgetedReachCells() {
		WalkabilityView world = ledge(false);
		Set<GridPosition> all = reachOfPiglinOnLedge(world);
		MeleeReach.ReachCells cells = new MeleeReach.ReachCells(6.2D, 79.0D, -0.3D, 6.8D, 80.95D, 0.3D, REACH);
		int[] claims = {0};
		int rounds = 0;
		while (!cells.advance(world, () -> ++claims[0] % 100 != 0)) rounds++;
		check(rounds > 0 && cells.cells().equals(all), "a scan cut off by the budget resumes next tick and finds the same cells");
		WalkabilityView stairs = ledge(true);
		// Only cells close enough to reach from are read: the scan box corners cost nothing.
		int[] reads = {0};
		MeleeReach.reachCells(position -> {
			reads[0]++;
			return world.cellAt(position);
		}, 6.2D, 79.0D, -0.3D, 6.8D, 80.95D, 0.3D, REACH);
		check(reads[0] < 1_200, "the reach scan reads only cells within reach of the target (" + reads[0] + " reads)");
		// The piglin's ledge top is out of sight from the ground: no known spot, but footing that may be one.
		ObservedTerrain below = ObservedTerrain.over(stairs, cell -> cell.y() < 78 && !(cell.x() >= 5 && cell.x() <= 7));
		MeleeReach.ReachCells hidden = new MeleeReach.ReachCells(6.2D, 79.0D, -0.3D, 6.8D, 80.95D, 0.3D, REACH);
		hidden.advance(below, () -> true);
		check(hidden.cells().isEmpty() && hidden.undetermined() > 0,
				"with the ledge top unseen there is no known spot in reach, and spots whose footing is unknown");
		ObservedTerrain open = ObservedTerrain.over(stairs, cell -> true);
		MeleeReach.ReachCells known = new MeleeReach.ReachCells(6.2D, 79.0D, -0.3D, 6.8D, 80.95D, 0.3D, REACH);
		known.advance(open, () -> true);
		check(!known.cells().isEmpty(), "with it in sight the ledge top is a known spot in reach");
		WalkabilityView sky = position -> position.y() <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		MeleeReach.ReachCells floating = new MeleeReach.ReachCells(6.2D, 79.0D, -0.3D, 6.8D, 80.95D, 0.3D, REACH);
		floating.advance(ObservedTerrain.over(sky, cell -> true), () -> true);
		check(floating.cells().isEmpty() && floating.undetermined() == 0,
				"a target in open sky with every cell known has no spot in reach and nothing undetermined");
	}


	private static void verifyObservedProgress() {
		var progress = new ServerFightController.ObservedProgress();
		var first = new java.util.UUID(0L, 1L);
		var second = new java.util.UUID(0L, 2L);
		check(progress.update(first, 20.0F, () -> Double.NaN) == 0.0D, "an unseen target exposes no health progress");
		check(progress.update(first, 20.0F, () -> { throw new AssertionError("unchanged health rechecks sight"); }) == 0.0D,
				"stable health needs no extra per-tick visibility ray");
		check(progress.update(first, 10.0F, () -> .5D) == .5D, "visible damage updates progress");
		check(progress.update(first, 5.0F, () -> Double.NaN) == .5D, "hidden damage retains only the last visible progress");
		check(progress.update(first, 5.0F, () -> .75D) == .5D, "progress retains its sample until another health change");
		check(progress.update(first, 4.0F, () -> .8D) == .8D, "the next visible damage sample refreshes progress");
		check(progress.update(second, 18.0F, () -> Double.NaN) == 0.0D, "retargeting cannot carry another body's health progress");
		check(progress.update(second, 17.0F, () -> .15D) == .15D, "a visible sample for the new target is independent");
	}

	private static void verifyLevelRouteKeepsFacts() {
		WalkabilityView floors = cell -> cell.y() == 63 || cell.y() == 68 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		ObservedTerrain level = ObservedTerrain.over(floors, cell -> true).onLevel(64);
		check(level.isStandable(new GridPosition(0, 64, 0)), "the current deck stays traversable");
		check(!level.isStandable(new GridPosition(0, 69, 0)), "a seen upper deck is not a destination of a level fight");
		check(level.cellAt(new GridPosition(0, 68, 0)) == WalkabilityView.Cell.SAFE_SUPPORT,
				"restricting movement does not hide or invent terrain facts");
		check(!level.canJumpFrom(new GridPosition(0, 64, 0)), "a level fight cannot plan a gap jump off its deck");
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
