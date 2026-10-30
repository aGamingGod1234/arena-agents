package dev.agaminggod.arenaagents.client.navigation;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

public final class LocalPathfinderVerification {
	private static final int TEST_NODE_LIMIT = 128;
	private static final long TEST_TIME_BUDGET_NANOS = 1_000L;

	private LocalPathfinderVerification() {
	}

	public static int verify() {
		int assertions = 0;
		assertions += verifyFlatPath();
		assertions += verifyOneBlockJump();
		assertions += verifyTooHighJumpIsRefused();
		assertions += verifySingleBlockGapJump();
		assertions += verifyDropBesideGapJump();
		assertions += verifySafeThreeBlockDrop();
		assertions += verifyWallHasNoPath();
		assertions += verifyUnsafeDropHasNoPath();
		assertions += verifyLimitsAreExplicit();
		assertions += verifyTieBreakIsDeterministic();
		assertions += verifyStartEqualsGoal();
		assertions += verifyPathIsImmutableAndAcyclic();
		assertions += verifySharedBudgetIsAggregate();
		assertions += verifySharedBudgetReportsPerRequestDeltas();
		assertions += verifyOpenSetExhaustionAtNodeBoundIsNoPath();
		assertions += verifyRetainedSearchContinuesAcrossBudgets();
		assertions += verifyThreeDimensionalFrontier();
		assertions += verifyFrontierNeverEndsBesideLava();
		assertions += verifyDetourCanStartAwayFromDestination();
		assertions += verifySurfaceSwimmingAndBreathingClearance();
		assertions += verifySubmergedSwimmingIsBoundedByBreath();
		assertions += verifyHigherBreathArrivalSurvivesCheaperDepletedOne();
		assertions += verifyAirPocketArrivalKeepsItsWayBack();
		assertions += verifyFloodedCaveSearchStaysBounded();
		assertions += verifyThirdPocketArrivalIsKept();
		assertions += verifyExtraArrivalsNeverCrowdOutReachableCells();
		assertions += verifyClimbingToGroundedExit();
		assertions += WeightedPathfinderVerification.verify();
		return assertions;
	}

	private static int verifyRetainedSearchContinuesAcrossBudgets() {
		TestWorld world = new TestWorld();
		for (int x = 0; x <= 24; x++) world.standable(position(x, 64, 0));
		GridPosition destination = position(24, 64, 0);
		LocalPathfinder.Search search = new LocalPathfinder().beginSearch(
				position(0, 64, 0), Set.of(destination), destination, 32, Set.of());
		PathPlan plan = null;
		int expanded = 0;
		int slices = 0;
		while (!search.finished() && slices++ < 20) {
			plan = search.advance(world, new LocalPathfinder.SearchBudget(2, TEST_TIME_BUDGET_NANOS, () -> 0L));
			expanded += plan.expandedNodes();
		}
		assertTrue(search.finished(), "small tick budgets eventually finish the retained route");
		assertEquals(PathOutcome.FOUND, plan.outcome(), "retained search finds the exact destination");
		assertEquals(destination, plan.nodes().getLast().position(), "resumption preserves endpoint authority");
		assertEquals(24, expanded, "resumption expands each corridor node once instead of restarting");
		assertTrue(slices > 1 && search.retainedNodes() <= LocalPathfinder.MAX_RETAINED_NODES, "search remains sliced and memory bounded");
		return 5;
	}

	private static int verifyThreeDimensionalFrontier() {
		TestWorld world = new TestWorld();
		for (int x = 0; x <= 8; x++) {
			GridPosition feet = position(x, 64 + Math.min(x, 4), 0);
			world.standable(feet);
			world.cell(feet.above(2), WalkabilityView.Cell.CLEAR);
		}
		GridPosition focus = position(100, 64, 0);
		LocalPathfinder.Search search = new LocalPathfinder().beginSearch(position(0, 64, 0), Set.of(), focus, 8, Set.of());
		PathPlan plan = search.advance(world, new LocalPathfinder.SearchBudget(128, TEST_TIME_BUDGET_NANOS, () -> 0L));
		assertEquals(PathOutcome.FOUND, plan.outcome(), "a reachable elevated boundary replaces the unsupported straight-line midpoint");
		assertEquals(position(8, 68, 0), plan.nodes().getLast().position(), "the local frontier retains actual terrain height");
		assertTrue(plan.nodes().stream().anyMatch(node -> node.traversal() == TraversalType.JUMP_UP), "the frontier has an executable route through the rise");
		LocalPathfinder.Search visited = new LocalPathfinder().beginSearch(position(0, 64, 0), Set.of(), focus, 8, Set.of(position(8, 68, 0)));
		assertEquals(PathOutcome.NO_PATH, visited.advance(world,
				new LocalPathfinder.SearchBudget(128, TEST_TIME_BUDGET_NANOS, () -> 0L)).outcome(), "an exhausted boundary does not repeat forever");
		return 4;
	}

	/** d14-iron-e: a partial route ended in a pit under a lava fall and the body waited there for the next decision. */
	private static int verifyFrontierNeverEndsBesideLava() {
		TestWorld world = new TestWorld() {
			@Override
			public int exposureCost(GridPosition position) { return position.equals(position(8, 64, 0)) ? 12 : 0; }
		};
		for (int x = 0; x <= 8; x++) {
			world.standable(position(x, 64, 0));
			world.standable(position(x, 64, 1));
		}
		GridPosition focus = position(100, 64, 0);
		PathPlan plan = new LocalPathfinder().beginSearch(position(0, 64, 0), Set.of(), focus, 8, Set.of())
				.advance(world, new LocalPathfinder.SearchBudget(256, TEST_TIME_BUDGET_NANOS, () -> 0L));
		assertEquals(PathOutcome.FOUND, plan.outcome(), "another boundary cell still continues the route");
		assertEquals(position(8, 64, 1), plan.nodes().getLast().position(), "the boundary cell beside lava is never where a partial route stops");
		return 2;
	}

	private static int verifyDetourCanStartAwayFromDestination() {
		TestWorld world = new TestWorld();
		for (int z = 0; z <= 8; z++) {
			world.standable(position(0, 64, z));
			world.standable(position(8, 64, z));
		}
		for (int x = 0; x <= 8; x++) world.standable(position(x, 64, 8));
		GridPosition destination = position(8, 64, 0);
		LocalPathfinder.Search search = new LocalPathfinder().beginSearch(position(0, 64, 0), Set.of(destination), destination, 8, Set.of());
		PathPlan plan = search.advance(world, new LocalPathfinder.SearchBudget(128, TEST_TIME_BUDGET_NANOS, () -> 0L));
		assertEquals(PathOutcome.FOUND, plan.outcome(), "a U-shaped detour reaches the selected goal");
		assertEquals(position(0, 64, 1), plan.nodes().get(1).position(), "the first detour step may increase distance to the goal");
		assertEquals(destination, plan.nodes().getLast().position(), "a reachable goal takes precedence over partial frontiers");
		return 3;
	}

	private static int verifySurfaceSwimmingAndBreathingClearance() {
		TestWorld world = new TestWorld().standable(position(0, 64, 0)).standable(position(9, 64, 0));
		for (int x = 1; x <= 8; x++) {
			world.cell(position(x, 64, 0), WalkabilityView.Cell.WATER);
			world.cell(position(x, 65, 0), WalkabilityView.Cell.CLEAR);
		}
		PathPlan plan = find(world, position(0, 64, 0), position(9, 64, 0));
		assertEquals(PathOutcome.FOUND, plan.outcome(), "open surface water can connect supported banks beyond four blocks");
		assertEquals(8L, plan.nodes().stream().filter(node -> node.traversal() == TraversalType.SWIM).count(), "water transitions are explicit");
		world.cell(position(4, 65, 0), WalkabilityView.Cell.WATER);
		PathPlan underArch = find(world, position(0, 64, 0), position(9, 64, 0));
		assertEquals(PathOutcome.FOUND, underArch.outcome(), "a short submerged stretch is swum like a player instead of refused");
		return 3;
	}

	/** Flooded tunnel: water at feet and head, rock above. A player swims it while the breath lasts. */
	private static TestWorld floodedTunnel(int length) {
		TestWorld world = new TestWorld().standable(position(0, 64, 0)).standable(position(length + 1, 64, 0));
		for (int x = 1; x <= length; x++) {
			world.cell(position(x, 63, 0), WalkabilityView.Cell.SAFE_SUPPORT);
			world.cell(position(x, 64, 0), WalkabilityView.Cell.WATER);
			world.cell(position(x, 65, 0), WalkabilityView.Cell.WATER);
			world.cell(position(x, 66, 0), WalkabilityView.Cell.BLOCKED);
		}
		return world;
	}

	private static int verifySubmergedSwimmingIsBoundedByBreath() {
		TestWorld tunnel = floodedTunnel(10);
		PathPlan plan = new LocalPathfinder().findPath(tunnel, position(0, 64, 0), position(11, 64, 0), 4_096, 1_000_000L, () -> 0L);
		assertEquals(PathOutcome.FOUND, plan.outcome(), "a ten-block flooded tunnel is traversable on one breath");
		assertEquals(10L, plan.nodes().stream().filter(node -> tunnel.isSubmerged(node.position())).count(),
				"the route swims through the submerged cells");
		assertTrue(plan.nodes().stream().filter(node -> tunnel.isSubmerged(node.position()))
				.allMatch(node -> node.traversal() == TraversalType.SWIM), "submerged cells are explicit swim steps");

		int tooLong = LocalPathfinder.FULL_BREATH_SUBMERGED_NODES + 1;
		TestWorld longTunnel = floodedTunnel(tooLong);
		assertEquals(PathOutcome.NO_PATH, new LocalPathfinder().findPath(longTunnel, position(0, 64, 0), position(tooLong + 1, 64, 0),
				4_096, 1_000_000L, () -> 0L).outcome(), "a flooded passage longer than one breath is not planned as a swim");

		// Already under water with little air: the start's run is bounded by the live breath, not a full one.
		GridPosition inside = position(5, 64, 0);
		LocalPathfinder.Search lowAir = new LocalPathfinder().beginSearch(inside, Set.of(position(11, 64, 0)), position(11, 64, 0), 32, Set.of(), 2);
		assertEquals(PathOutcome.NO_PATH, lowAir.advance(tunnel, new LocalPathfinder.SearchBudget(4_096, 1_000_000L, () -> 0L)).outcome(),
				"two cells of breath do not cover the five submerged cells to the exit");
		LocalPathfinder.Search enoughAir = new LocalPathfinder().beginSearch(inside, Set.of(position(11, 64, 0)), position(11, 64, 0), 32, Set.of(), 8);
		assertEquals(PathOutcome.FOUND, enoughAir.advance(tunnel, new LocalPathfinder.SearchBudget(4_096, 1_000_000L, () -> 0L)).outcome(),
				"enough breath swims out of the flooded tunnel from inside it");

		// Flooded shaft: dive from a surface pool down to a lit side passage, then walk out.
		TestWorld shaft = new TestWorld().standable(position(0, 64, 0)).standable(position(2, 58, 0));
		shaft.cell(position(1, 64, 0), WalkabilityView.Cell.WATER);
		shaft.cell(position(1, 65, 0), WalkabilityView.Cell.CLEAR);
		for (int y = 58; y <= 63; y++) shaft.cell(position(1, y, 0), WalkabilityView.Cell.WATER);
		shaft.cell(position(1, 57, 0), WalkabilityView.Cell.SAFE_SUPPORT);
		PathPlan dive = new LocalPathfinder().findPath(shaft, position(0, 64, 0), position(2, 58, 0), 4_096, 1_000_000L, () -> 0L);
		assertEquals(PathOutcome.FOUND, dive.outcome(), "a flooded shaft is swum straight down to the passage below");
		assertTrue(dive.nodes().stream().anyMatch(node -> node.position().equals(position(1, 59, 0))),
				"the dive descends through the water column");
		assertEquals(PathOutcome.FOUND, new LocalPathfinder().findPath(shaft, position(2, 58, 0), position(0, 64, 0),
				4_096, 1_000_000L, () -> 0L).outcome(), "the same shaft is swum back up to the surface");
		return 8;
	}

	/**
	 * Low-air start inside a flooded tunnel (x 0..12, dry exit at 13). Swimming straight on reaches the junction at x 5
	 * cheaply with no air left; a dry U bypass (x 1 to 5 along z -2) reaches it later with a full breath.
	 */
	private static TestWorld depletedJunctionWithDryBypass(boolean bypass) {
		TestWorld world = new TestWorld().standable(position(13, 64, 0));
		for (int x = 0; x <= 12; x++) {
			world.cell(position(x, 63, 0), WalkabilityView.Cell.SAFE_SUPPORT);
			world.cell(position(x, 64, 0), WalkabilityView.Cell.WATER);
			world.cell(position(x, 65, 0), WalkabilityView.Cell.WATER);
			world.cell(position(x, 66, 0), WalkabilityView.Cell.BLOCKED);
		}
		if (bypass) {
			for (int z = -2; z <= -1; z++) {
				world.standable(position(1, 64, z));
				world.standable(position(5, 64, z));
			}
			for (int x = 2; x <= 4; x++) world.standable(position(x, 64, -2));
		}
		return world;
	}

	private static int verifyHigherBreathArrivalSurvivesCheaperDepletedOne() {
		GridPosition start = position(0, 64, 0);
		GridPosition exit = position(13, 64, 0);
		int startBreath = 5;
		TestWorld world = depletedJunctionWithDryBypass(true);
		LocalPathfinder.Search search = new LocalPathfinder().beginSearch(start, Set.of(exit), exit, 32, Set.of(), startBreath);
		PathPlan plan = search.advance(world, new LocalPathfinder.SearchBudget(4_096, 1_000_000L, () -> 0L));
		assertEquals(PathOutcome.FOUND, plan.outcome(), "a full-breath arrival through the dry bypass continues where the cheap depleted one cannot");
		assertEquals(exit, plan.nodes().getLast().position(), "the route reaches the exit, not a partial frontier");
		assertTrue(plan.nodes().stream().anyMatch(node -> node.position().equals(position(3, 64, -2))), "the route takes the dry bypass");
		int breath = startBreath;
		boolean breathValid = true;
		for (PathNode node : plan.nodes().subList(1, plan.nodes().size())) {
			breath = world.isSubmerged(node.position()) ? breath - 1 : LocalPathfinder.FULL_BREATH_SUBMERGED_NODES;
			breathValid &= breath >= 0;
		}
		assertTrue(breathValid, "no submerged run on the route exceeds the air available when it starts");
		assertTrue(search.retainedLabels() > search.retainedNodes(), "the junction retains both the cheap and the high-breath arrival");
		assertTrue(search.retainedLabels() <= search.retainedNodes() + LocalPathfinder.MAX_EXTRA_ARRIVALS,
				"arrivals beyond one per cell stay within their own budget");

		LocalPathfinder.Search noBypass = new LocalPathfinder().beginSearch(start, Set.of(exit), exit, 32, Set.of(), startBreath);
		assertEquals(PathOutcome.NO_PATH, noBypass.advance(depletedJunctionWithDryBypass(false),
				new LocalPathfinder.SearchBudget(4_096, 1_000_000L, () -> 0L)).outcome(), "without the bypass the low air still cannot cover the tunnel");

		// Dry terrain keeps exactly one state per cell, so its search work is unchanged.
		TestWorld dry = new TestWorld();
		for (int z = 0; z <= 8; z++) {
			dry.standable(position(0, 64, z));
			dry.standable(position(8, 64, z));
		}
		for (int x = 0; x <= 8; x++) dry.standable(position(x, 64, 8));
		LocalPathfinder.Search drySearch = new LocalPathfinder().beginSearch(position(0, 64, 0), Set.of(position(8, 64, 0)), position(8, 64, 0), 8, Set.of());
		PathPlan dryPlan = drySearch.advance(dry, new LocalPathfinder.SearchBudget(128, TEST_TIME_BUDGET_NANOS, () -> 0L));
		assertEquals(24, dryPlan.expandedNodes(), "a dry U detour expands each of its cells once");
		assertEquals(drySearch.retainedNodes(), drySearch.retainedLabels(), "dry cells hold one search state each");
		return 9;
	}

	private static void submerged(TestWorld world, int x, int z) {
		world.cell(position(x, 63, z), WalkabilityView.Cell.SAFE_SUPPORT);
		world.cell(position(x, 64, z), WalkabilityView.Cell.WATER);
		world.cell(position(x, 65, z), WalkabilityView.Cell.WATER);
		world.cell(position(x, 66, z), WalkabilityView.Cell.BLOCKED);
	}

	/**
	 * Review fixture: flooded tunnel x 0..8 to a dry exit at 9, with a dry air pocket at (2,-1) beside junction (2,0)
	 * and a flooded loop (0,-1),(0,-2),(1,-2),(2,-2) into the pocket. The cheap pocket arrival came through the
	 * junction and may not return to it; the loop arrival may, so it must not be discarded as a full-breath duplicate.
	 */
	private static TestWorld airPocketBesideJunction() {
		TestWorld world = new TestWorld().standable(position(2, 64, -1)).standable(position(9, 64, 0));
		for (int x = 0; x <= 8; x++) submerged(world, x, 0);
		submerged(world, 0, -1);
		submerged(world, 0, -2);
		submerged(world, 1, -2);
		submerged(world, 2, -2);
		return world;
	}

	private static int verifyAirPocketArrivalKeepsItsWayBack() {
		GridPosition start = position(0, 64, 0);
		GridPosition exit = position(9, 64, 0);
		int startBreath = 5;
		TestWorld world = airPocketBesideJunction();
		int assertions = 0;
		for (int slice : new int[]{4_096, 1, 2}) {
			LocalPathfinder.Search search = new LocalPathfinder().beginSearch(start, Set.of(exit), exit, 32, Set.of(), startBreath);
			PathPlan plan = null;
			int slices = 0;
			while (!search.finished() && slices++ < 200) {
				plan = search.advance(world, new LocalPathfinder.SearchBudget(slice, 1_000_000L, () -> 0L));
			}
			assertEquals(PathOutcome.FOUND, plan.outcome(), "the loop into the air pocket reaches the exit with slices of " + slice);
			assertEquals(exit, plan.nodes().getLast().position(), "the route ends at the exit with slices of " + slice);
			assertEquals(List.of(position(0, 64, -1), position(0, 64, -2), position(1, 64, -2), position(2, 64, -2),
					position(2, 64, -1), position(2, 64, 0)), plan.nodes().subList(1, 7).stream().map(PathNode::position).toList(),
					"the route refills in the pocket and leaves through the junction with slices of " + slice);
			int breath = startBreath;
			boolean breathValid = true;
			for (PathNode node : plan.nodes().subList(1, plan.nodes().size())) {
				breath = world.isSubmerged(node.position()) ? breath - 1 : LocalPathfinder.FULL_BREATH_SUBMERGED_NODES;
				breathValid &= breath >= 0;
			}
			assertTrue(breathValid, "every submerged run fits the air available with slices of " + slice);
			assertions += 4;
		}
		return assertions;
	}

	/** Open flooded cave: route histories differ per simple path, so history-only arrivals per cell stay bounded. */
	private static int verifyFloodedCaveSearchStaysBounded() {
		TestWorld cave = new TestWorld();
		java.util.Random random = new java.util.Random(11L);
		for (int x = 0; x <= 24; x++) {
			for (int z = 0; z <= 24; z++) {
				if (random.nextInt(100) < 15) cave.standable(position(x, 64, z));
				else submerged(cave, x, z);
			}
		}
		submerged(cave, 0, 0);
		GridPosition exit = position(24, 64, 24);
		cave.standable(exit);
		LocalPathfinder.Search search = new LocalPathfinder().beginSearch(position(0, 64, 0), Set.of(exit), exit, 32, Set.of(), 6);
		PathPlan plan = null;
		int expanded = 0;
		int slices = 0;
		while (!search.finished() && slices++ < 100) {
			plan = search.advance(cave, new LocalPathfinder.SearchBudget(LocalPathfinder.MAX_EXPANDED_NODES, 1_000_000_000L, () -> 0L));
			expanded += plan.expandedNodes();
		}
		assertEquals(PathOutcome.FOUND, plan.outcome(), "a low-air start crosses an open flooded cave");
		assertEquals(exit, plan.nodes().getLast().position(), "the cave route reaches the exit rather than a partial frontier");
		assertTrue(search.retainedLabels() <= 3 * search.retainedNodes(),
				"retained arrivals stay within a small multiple of reached cells: " + search.retainedLabels() + " for " + search.retainedNodes());
		assertTrue(expanded <= 3 * search.retainedNodes(), "expansions stay within a small multiple of reached cells: " + expanded);

		// Seeded 31x31 caves (dry share, seed, start air) that a position-keyed search crosses: each must still be crossed.
		int[][] seeded = {{15, 11, 6}, {15, 3, 6}, {25, 5, 4}, {8, 7, 8}, {40, 9, 3}};
		for (int[] seed : seeded) {
			TestWorld seededCave = new TestWorld();
			java.util.Random seededRandom = new java.util.Random(seed[1]);
			for (int x = 0; x <= 30; x++) {
				for (int z = 0; z <= 30; z++) {
					if (seededRandom.nextInt(100) < seed[0]) seededCave.standable(position(x, 64, z));
					else submerged(seededCave, x, z);
				}
			}
			submerged(seededCave, 0, 0);
			GridPosition seededExit = position(30, 64, 30);
			seededCave.standable(seededExit);
			LocalPathfinder.Search seededSearch = new LocalPathfinder().beginSearch(position(0, 64, 0), Set.of(seededExit), seededExit, 32, Set.of(), seed[2]);
			PathPlan seededPlan = null;
			int seededSlices = 0;
			while (!seededSearch.finished() && seededSlices++ < 100) {
				seededPlan = seededSearch.advance(seededCave, new LocalPathfinder.SearchBudget(LocalPathfinder.MAX_EXPANDED_NODES, 1_000_000_000L, () -> 0L));
			}
			assertEquals(seededExit, seededPlan.nodes().isEmpty() ? null : seededPlan.nodes().getLast().position(),
					"seeded cave " + seed[0] + "% dry, seed " + seed[1] + " is crossed to its exit");
		}
		return 9;
	}

	/**
	 * Review round 2, F2: the air pocket at (1,2) is first reached through (1,1) twice; only the third arrival,
	 * through (0,2), may swim back out through (1,1) with a full breath.
	 */
	private static int verifyThirdPocketArrivalIsKept() {
		String[] rows = {"ww###", "wwww#", "w.#w#", "###w#", "###w."};
		TestWorld world = new TestWorld();
		for (int z = 0; z < rows.length; z++) {
			for (int x = 0; x < rows[z].length(); x++) {
				switch (rows[z].charAt(x)) {
					case 'w' -> submerged(world, x, z);
					case '.' -> world.standable(position(x, 64, z));
					default -> {
						world.cell(position(x, 64, z), WalkabilityView.Cell.BLOCKED);
						world.cell(position(x, 65, z), WalkabilityView.Cell.BLOCKED);
					}
				}
			}
		}
		GridPosition exit = position(4, 64, 4);
		int assertions = 0;
		for (int slice : new int[]{4_096, 1, 2}) {
			LocalPathfinder.Search search = new LocalPathfinder().beginSearch(position(0, 64, 0), Set.of(exit), exit, 32, Set.of(), 3);
			PathPlan plan = null;
			int slices = 0;
			while (!search.finished() && slices++ < 200) {
				plan = search.advance(world, new LocalPathfinder.SearchBudget(slice, 1_000_000L, () -> 0L));
			}
			assertEquals(PathOutcome.FOUND, plan.outcome(), "the third pocket arrival reaches the exit with slices of " + slice);
			assertEquals(List.of(position(0, 64, 0), position(0, 64, 1), position(0, 64, 2), position(1, 64, 2), position(1, 64, 1),
					position(2, 64, 1), position(3, 64, 1), position(3, 64, 2), position(3, 64, 3), position(3, 64, 4), exit),
					plan.nodes().stream().map(PathNode::position).toList(), "the route refills in the pocket and swims back out with slices of " + slice);
			assertions += 2;
		}
		return assertions;
	}

	/**
	 * Review round 2, F1: six stacked flooded 63x63 cave floors joined by three water shafts, low-air start, exit on the
	 * top floor. A position-keyed search reaches it; extra arrivals must never use up the cell retention bound first.
	 */
	private static final class LayeredCave implements WalkabilityView {
		private final char[][][] floors;
		private final int half;

		private LayeredCave(int size, int count, long seed) {
			half = size / 2;
			floors = new char[count][size][size];
			for (int floor = 0; floor < count; floor++) {
				java.util.Random random = new java.util.Random(seed + floor * 389L);
				for (int x = 0; x < size; x++) {
					for (int z = 0; z < size; z++) floors[floor][x][z] = random.nextInt(100) < 15 ? '.' : 'w';
				}
				floors[floor][0][0] = 'w';
				floors[floor][size - 1][size - 1] = '.';
				floors[floor][half][half] = 'w';
			}
			floors[0][half + 1][half] = '.';
		}

		private GridPosition exit() {
			return position(half, 64 + 3 * (floors.length - 1), half);
		}

		@Override
		public Cell cellAt(GridPosition position) {
			int x = position.x() + half;
			int z = position.z() + half;
			if (x < 0 || z < 0 || x >= floors[0].length || z >= floors[0].length) return Cell.BLOCKED;
			int relative = position.y() - 64;
			if (position.z() == 0 && (position.x() == 0 || position.x() == 15 || position.x() == -15)) {
				return relative >= 0 && relative <= 3 * (floors.length - 1) + 1 ? Cell.WATER : Cell.BLOCKED;
			}
			if (relative < 0) return relative == -1 ? Cell.SAFE_SUPPORT : Cell.BLOCKED;
			int floor = relative / 3;
			if (floor >= floors.length) return Cell.BLOCKED;
			if (relative % 3 == 2) return floor + 1 < floors.length ? Cell.SAFE_SUPPORT : Cell.BLOCKED;
			return floors[floor][x][z] == 'w' ? Cell.WATER : Cell.CLEAR;
		}
	}

	private static int verifyExtraArrivalsNeverCrowdOutReachableCells() {
		LayeredCave cave = new LayeredCave(63, 6, 11L);
		GridPosition exit = cave.exit();
		int assertions = 0;
		for (int slice : new int[]{LocalPathfinder.MAX_EXPANDED_NODES, 2}) {
			LocalPathfinder.Search search = new LocalPathfinder().beginSearch(position(0, 64, 0), Set.of(exit), exit, 32, Set.of(), 6);
			PathPlan plan = null;
			int slices = 0;
			while (!search.finished() && slices++ < 100_000) {
				plan = search.advance(cave, new LocalPathfinder.SearchBudget(slice, 1_000_000_000L, () -> 0L));
			}
			assertEquals(PathOutcome.FOUND, plan.outcome(), "the layered cave is crossed with tick budgets of " + slice);
			assertEquals(exit, plan.nodes().getLast().position(), "the layered cave route reaches the top exit with tick budgets of " + slice);
			assertTrue(search.retainedLabels() - search.retainedNodes() <= LocalPathfinder.MAX_EXTRA_ARRIVALS,
					"extra arrivals stay within their own budget with tick budgets of " + slice);
			assertions += 3;
		}
		return assertions;
	}

	private static int verifyClimbingToGroundedExit() {
		TestWorld world = new TestWorld().standable(position(0, 64, 0)).standable(position(1, 69, 0));
		for (int y = 64; y <= 69; y++) world.cell(position(0, y, 0), WalkabilityView.Cell.CLIMBABLE);
		world.cell(position(0, 70, 0), WalkabilityView.Cell.CLEAR);
		world.cell(position(0, 71, 0), WalkabilityView.Cell.CLEAR);
		PathPlan plan = find(world, position(0, 64, 0), position(1, 69, 0));
		assertEquals(PathOutcome.FOUND, plan.outcome(), "a climbable column connects to a supported exit");
		assertTrue(plan.nodes().stream().anyMatch(node -> node.traversal() == TraversalType.CLIMB), "vertical climb steps are explicit");
		assertEquals(position(1, 69, 0), plan.nodes().getLast().position(), "climbing preserves the grounded endpoint");
		return 3;
	}

	private static int verifyFlatPath() {
		TestWorld world = new TestWorld();
		for (int x = 0; x <= 4; x++) {
			world.standable(position(x, 64, 0));
		}

		PathPlan plan = find(world, position(0, 64, 0), position(4, 64, 0));
		assertEquals(PathOutcome.FOUND, plan.outcome(), "flat path outcome");
		assertEquals(5, plan.nodes().size(), "flat path includes start and destination");
		assertEquals(position(0, 64, 0), plan.nodes().getFirst().position(), "flat path start");
		assertEquals(position(4, 64, 0), plan.nodes().getLast().position(), "flat path destination");
		assertEquals(
				List.of(
						TraversalType.START,
						TraversalType.WALK,
						TraversalType.WALK,
						TraversalType.WALK,
						TraversalType.WALK
				),
				plan.nodes().stream().map(PathNode::traversal).toList(),
				"flat path traversal types"
		);
		return 5;
	}

	private static int verifyOneBlockJump() {
		TestWorld world = new TestWorld()
				.standable(position(0, 64, 0))
				.standable(position(1, 65, 0));
		world.cell(position(0, 66, 0), WalkabilityView.Cell.CLEAR);

		PathPlan plan = find(world, position(0, 64, 0), position(1, 65, 0));
		assertEquals(PathOutcome.FOUND, plan.outcome(), "one-block jump outcome");
		assertEquals(2, plan.nodes().size(), "one-block jump node count");
		assertEquals(TraversalType.JUMP_UP, plan.nodes().getLast().traversal(), "one-block jump traversal");
		return 3;
	}

	/** A view that knows the rise from a slab onto a full block is too high must route around it. */
	private static int verifyTooHighJumpIsRefused() {
		TestWorld world = new TestWorld() {
			@Override
			public boolean canJumpUp(GridPosition from, GridPosition to) {
				return !(from.equals(position(0, 64, 0)) && to.equals(position(1, 65, 0)));
			}
		};
		world.standable(position(0, 64, 0)).standable(position(1, 65, 0))
				.standable(position(0, 64, 1)).standable(position(1, 65, 1));
		world.cell(position(0, 66, 0), WalkabilityView.Cell.CLEAR);
		world.cell(position(0, 66, 1), WalkabilityView.Cell.CLEAR);
		PathPlan plan = find(world, position(0, 64, 0), position(1, 65, 0));
		assertEquals(PathOutcome.FOUND, plan.outcome(), "the refused rise has a walking bypass");
		assertTrue(!plan.nodes().get(1).position().equals(position(1, 65, 0)),
				"the impossible slab-to-block jump is not planned: " + plan.nodes());
		return 2;
	}

	private static int verifySingleBlockGapJump() {
		TestWorld world = new TestWorld()
				.standable(position(0, 64, 0))
				.standable(position(2, 64, 0));
		world.cell(position(1, 64, 0), WalkabilityView.Cell.CLEAR);
		world.cell(position(1, 65, 0), WalkabilityView.Cell.CLEAR);
		world.cell(position(0, 66, 0), WalkabilityView.Cell.CLEAR);

		PathPlan plan = find(world, position(0, 64, 0), position(2, 64, 0));
		assertEquals(PathOutcome.FOUND, plan.outcome(), "single-block gap jump outcome");
		assertEquals(2, plan.nodes().size(), "single-block gap jump node count");
		assertEquals("JUMP_GAP", plan.nodes().getLast().traversal().name(), "single-block gap traversal");
		return 3;
	}

	private static int verifyDropBesideGapJump() {
		GridPosition start = position(0, 64, 0);
		GridPosition trench = position(1, 63, 0);
		GridPosition rim = position(2, 64, 0);
		TestWorld world = new TestWorld().standable(start).standable(trench).standable(rim);
		world.cell(position(1, 65, 0), WalkabilityView.Cell.CLEAR);
		world.cell(position(0, 66, 0), WalkabilityView.Cell.CLEAR);
		world.cell(position(2, 66, 0), WalkabilityView.Cell.CLEAR);
		LocalPathfinder.Search search = new LocalPathfinder().beginSearch(start, Set.of(trench), trench, 32, Set.of());
		PathPlan drop = search.advance(world, new LocalPathfinder.SearchBudget(128, TEST_TIME_BUDGET_NANOS, () -> 0L));
		assertEquals(PathOutcome.FOUND, drop.outcome(), "jumpable opposite rim does not hide legal trench descent");
		assertEquals(List.of(new PathNode(start, TraversalType.START), new PathNode(trench, TraversalType.DROP_DOWN)),
				drop.nodes(), "trench descent retains the direct drop edge");
		PathPlan jump = find(world, start, rim);
		assertEquals(TraversalType.JUMP_GAP, jump.nodes().getLast().traversal(), "opposite-rim route keeps its cheaper gap jump");
		return 3;
	}

	private static int verifySafeThreeBlockDrop() {
		GridPosition start = position(0, 68, 0);
		GridPosition destination = position(1, 65, 0);
		TestWorld world = new TestWorld().standable(start).standable(destination);
		for (int y = 67; y <= 69; y++) {
			world.cell(position(1, y, 0), WalkabilityView.Cell.CLEAR);
		}

		PathPlan plan = find(world, start, destination);
		assertEquals(PathOutcome.FOUND, plan.outcome(), "safe three-block drop outcome");
		assertEquals(TraversalType.DROP_DOWN, plan.nodes().getLast().traversal(), "safe drop traversal");
		return 2;
	}

	private static int verifyWallHasNoPath() {
		TestWorld world = new TestWorld()
				.standable(position(0, 64, 0))
				.standable(position(2, 64, 0));
		world.cell(position(1, 64, 0), WalkabilityView.Cell.BLOCKED);
		world.cell(position(1, 65, 0), WalkabilityView.Cell.BLOCKED);

		PathPlan plan = find(world, position(0, 64, 0), position(2, 64, 0));
		assertEquals(PathOutcome.NO_PATH, plan.outcome(), "two-block wall has no path");
		assertEquals(List.of(), plan.nodes(), "no-path plan has no nodes");
		return 2;
	}

	private static int verifyUnsafeDropHasNoPath() {
		TestWorld world = new TestWorld()
				.standable(position(0, 68, 0))
				.standable(position(1, 64, 0));
		// Load and clear the whole shaft so only the drop cap, not an unloaded cell, can reject the four-block drop.
		for (int y = 66; y <= 69; y++) world.cell(position(1, y, 0), WalkabilityView.Cell.CLEAR);

		PathPlan plan = find(world, position(0, 68, 0), position(1, 64, 0));
		assertEquals(PathOutcome.NO_PATH, plan.outcome(), "drop beyond three blocks is rejected");

		TestWorld hazardousLanding = new TestWorld()
				.standable(position(0, 65, 0))
				.standable(position(1, 64, 0));
		hazardousLanding.cell(position(1, 63, 0), WalkabilityView.Cell.HAZARD);
		PathPlan hazardousPlan = find(
				hazardousLanding,
				position(0, 65, 0),
				position(1, 64, 0)
		);
		assertEquals(PathOutcome.INVALID, hazardousPlan.outcome(), "hazardous destination is invalid");
		return 2;
	}

	private static int verifyLimitsAreExplicit() {
		TestWorld world = new TestWorld();
		for (int x = 0; x <= 8; x++) {
			world.standable(position(x, 64, 0));
		}

		LocalPathfinder pathfinder = new LocalPathfinder();
		AtomicLong steadyClock = new AtomicLong();
		PathPlan nodeLimited = pathfinder.findPath(
				world,
				position(0, 64, 0),
				position(8, 64, 0),
				2,
				TEST_TIME_BUDGET_NANOS,
				steadyClock::get
		);
		assertEquals(PathOutcome.NODE_LIMIT, nodeLimited.outcome(), "node limit outcome");
		assertEquals(2, nodeLimited.expandedNodes(), "node limit expanded count");

		AtomicLong advancingClock = new AtomicLong();
		PathPlan timeLimited = pathfinder.findPath(
				world,
				position(0, 64, 0),
				position(8, 64, 0),
				TEST_NODE_LIMIT,
				40L,
				() -> advancingClock.getAndAdd(41L)
		);
		assertEquals(PathOutcome.TIME_LIMIT, timeLimited.outcome(), "deadline outcome");
		assertEquals(0, timeLimited.expandedNodes(), "deadline stops before expansion");
		return 4;
	}

	private static int verifyTieBreakIsDeterministic() {
		TestWorld world = new TestWorld();
		for (int x = 0; x <= 2; x++) {
			world.standable(position(x, 64, -1));
			world.standable(position(x, 64, 1));
		}
		world.standable(position(0, 64, 0));
		world.standable(position(2, 64, 0));

		PathPlan first = find(world, position(0, 64, 0), position(2, 64, 0));
		PathPlan second = find(world, position(0, 64, 0), position(2, 64, 0));
		assertEquals(PathOutcome.FOUND, first.outcome(), "tie-break path outcome");
		assertEquals(first, second, "tie-break path is repeatable");
		assertEquals(position(0, 64, 1), first.nodes().get(1).position(), "fixed neighbor-order tie break");
		return 3;
	}

	private static int verifyStartEqualsGoal() {
		GridPosition start = position(3, 70, -2);
		PathPlan plan = find(new TestWorld().standable(start), start, start);
		assertEquals(PathOutcome.FOUND, plan.outcome(), "start-equals-goal outcome");
		assertEquals(List.of(new PathNode(start, TraversalType.START)), plan.nodes(), "start-equals-goal path");
		assertEquals(0, plan.expandedNodes(), "start-equals-goal expands no nodes");
		return 3;
	}

	private static int verifyPathIsImmutableAndAcyclic() {
		TestWorld world = new TestWorld();
		for (int x = 0; x <= 4; x++) {
			world.standable(position(x, 64, 0));
		}
		PathPlan plan = find(world, position(0, 64, 0), position(4, 64, 0));
		Set<GridPosition> unique = new HashSet<>(plan.nodes().stream().map(PathNode::position).toList());
		assertEquals(plan.nodes().size(), unique.size(), "reconstructed path has no cycle");
		expectThrows(
				UnsupportedOperationException.class,
				() -> plan.nodes().add(new PathNode(position(5, 64, 0), TraversalType.WALK)),
				"path nodes are immutable"
		);
		return 2;
	}

	private static int verifySharedBudgetIsAggregate() {
		TestWorld world = new TestWorld();
		world.standable(position(0, 64, 0)).standable(position(1, 64, 0));
		LocalPathfinder.SearchBudget budget = new LocalPathfinder.SearchBudget(
				1,
				TEST_TIME_BUDGET_NANOS,
				() -> 0L
		);
		LocalPathfinder pathfinder = new LocalPathfinder();

		PathPlan first = pathfinder.findPath(
				world,
				position(0, 64, 0),
				position(1, 64, 0),
				budget
		);
		PathPlan second = pathfinder.findPath(
				world,
				position(0, 64, 0),
				position(1, 64, 0),
				budget
		);

		assertEquals(PathOutcome.FOUND, first.outcome(), "shared budget first request is served");
		assertEquals(PathOutcome.NODE_LIMIT, second.outcome(), "shared budget defers the next request");
		assertEquals(1, first.expandedNodes(), "first request reports its own expansion count");
		assertEquals(0, second.expandedNodes(), "deferred request reports no local expansions");
		assertEquals(1, budget.expandedNodes(), "shared budget counts expansions once across requests");
		assertTrue(budget.exhausted(), "shared budget reports aggregate exhaustion");
		return 6;
	}

	private static int verifySharedBudgetReportsPerRequestDeltas() {
		TestWorld world = new TestWorld()
				.standable(position(0, 64, 0))
				.standable(position(1, 64, 0))
				.standable(position(0, 64, 1))
				.standable(position(1, 64, 1));
		LocalPathfinder.SearchBudget budget = new LocalPathfinder.SearchBudget(
				2,
				TEST_TIME_BUDGET_NANOS,
				() -> 0L
		);
		LocalPathfinder pathfinder = new LocalPathfinder();
		PathPlan first = pathfinder.findPath(
				world,
				position(0, 64, 0),
				position(1, 64, 0),
				budget
		);
		PathPlan second = pathfinder.findPath(
				world,
				position(0, 64, 1),
				position(1, 64, 1),
				budget
		);

		assertEquals(PathOutcome.FOUND, first.outcome(), "first shared request finds its path");
		assertEquals(PathOutcome.FOUND, second.outcome(), "second shared request finds its path");
		assertEquals(1, first.expandedNodes(), "first shared request reports a local delta");
		assertEquals(1, second.expandedNodes(), "second shared request reports a local delta");
		assertEquals(2, budget.expandedNodes(), "shared budget still reports aggregate expansions");
		return 5;
	}

	private static int verifyOpenSetExhaustionAtNodeBoundIsNoPath() {
		GridPosition start = position(0, 64, 0);
		GridPosition destination = position(4, 64, 0);
		TestWorld world = new TestWorld().standable(start).standable(destination);
		PathPlan plan = new LocalPathfinder().findPath(
				world,
				start,
				destination,
				1,
				TEST_TIME_BUDGET_NANOS,
				() -> 0L
		);
		assertEquals(PathOutcome.NO_PATH, plan.outcome(), "an empty open set at the node bound is no path");
		assertEquals(1, plan.expandedNodes(), "the isolated search reports its one expansion");
		return 2;
	}

	private static PathPlan find(TestWorld world, GridPosition start, GridPosition destination) {
		return new LocalPathfinder().findPath(
				world,
				start,
				destination,
				TEST_NODE_LIMIT,
				TEST_TIME_BUDGET_NANOS,
				() -> 0L
		);
	}

	private static GridPosition position(int x, int y, int z) {
		return new GridPosition(x, y, z);
	}

	private static void assertEquals(Object expected, Object actual, String label) {
		if (!expected.equals(actual)) {
			throw new AssertionError(label + ": expected <" + expected + "> but was <" + actual + ">");
		}
	}

	private static void assertTrue(boolean condition, String label) {
		if (!condition) {
			throw new AssertionError(label);
		}
	}

	private static <T extends Throwable> void expectThrows(
			Class<T> expectedType,
			Runnable action,
			String label
	) {
		try {
			action.run();
		} catch (Throwable throwable) {
			if (expectedType.isInstance(throwable)) {
				return;
			}
			throw new AssertionError(label + " threw " + throwable.getClass().getSimpleName(), throwable);
		}
		throw new AssertionError(label + " did not throw " + expectedType.getSimpleName());
	}

	private static class TestWorld implements WalkabilityView {
		private final Map<GridPosition, Cell> cells = new HashMap<>();

		private TestWorld standable(GridPosition feet) {
			cell(feet.below(), Cell.SAFE_SUPPORT);
			cell(feet, Cell.CLEAR);
			cell(feet.above(), Cell.CLEAR);
			return this;
		}

		private void cell(GridPosition position, Cell cell) {
			cells.put(position, cell);
		}

		@Override
		public Cell cellAt(GridPosition position) {
			return cells.getOrDefault(position, Cell.UNLOADED);
		}
	}
}
