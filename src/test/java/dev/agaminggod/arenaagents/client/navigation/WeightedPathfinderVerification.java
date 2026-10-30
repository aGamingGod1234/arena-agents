package dev.agaminggod.arenaagents.client.navigation;

import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;
import java.util.function.BiPredicate;
import java.util.function.ToIntBiFunction;

public final class WeightedPathfinderVerification {
	private static final GridPosition START = new GridPosition(0, 64, 0);
	private static final double SAND_SPEED = MovementCosts.groundSpeedMultiplier(0.4D, 0);
	private static final int[][] DIRECTIONS = {{1, 0}, {0, 1}, {-1, 0}, {0, -1}};
	private static int assertions;

	private WeightedPathfinderVerification() { }

	public static int verify() {
		assertions = 0;
		Field stone = new Field((x, z) -> 63, (x, z) -> false);
		for (int[] target : new int[][]{{40, 0, 40}, {30, 30, 60}, {60, 20, 80}}) {
			verifyExpansions(stone, new GridPosition(target[0], 64, target[1]), target[2], "ordinary ground");
		}
		Field chasm = new Field((x, z) -> x >= 10 && x <= 12 && z != 30 ? 40 : 63, (x, z) -> false);
		verifyExpansions(chasm, new GridPosition(25, 64, 0), 1_477, "chasm detour matches main");
		Field hills = new Field((x, z) -> 63 + (int) Math.round(3 * Math.sin(x / 7.0) * Math.cos(z / 9.0)
				+ 2 * Math.sin((x + z) / 5.0)), (x, z) -> false);
		verifyExpansions(hills, new GridPosition(40, hills.floor.applyAsInt(40, 30) + 1, 30), 1_159, "hills match main");
		Field sand = new Field((x, z) -> 63, (x, z) -> true);
		verifyExpansions(sand, new GridPosition(30, 64, 30), 60, "uniform sand 30x30");
		verifyExpansions(sand, new GridPosition(60, 64, 20), 80, "uniform sand 60x20");
		sand.slowSpeed = MovementCosts.groundSpeedMultiplier(1.0D, 3);
		verifyExpansions(sand, new GridPosition(30, 64, 30), 60, "Soul Speed III");
		verifyHeuristicBound();

		Field patches = new Field((x, z) -> 63, (x, z) -> x * x + z * z >= 4 && smooth(x, z) > 0.5D);
		verifyCost(patches, new GridPosition(40, 64, 30), 832, 780, 565, "reviewer mixed patches");
		Field road = new Field((x, z) -> 63, (x, z) -> !(z == 5 || (x == 0 || x == 40) && z >= 0 && z <= 5));
		verifyCost(road, new GridPosition(40, 64, 0), 500, 500, 50, "sand with stone road");

		// A single sand entrance hides a cheap straight corridor behind a long stone U-shaped detour.
		Field trap = new Field((x, z) -> 63, (x, z) -> x == 1 && z == 0);
		trap.allowed = (x, z) -> x >= 0 && x <= 60 && (z == 0 || z == 21 || (x == 0 || x == 60) && z >= 0 && z <= 21);
		verifyCost(trap, new GridPosition(60, 64, 0), 1_020, 608, 102, "constructed sand-entrance trap");

		// Exercise inconsistent priorities, blocked columns, hazard support and retained tick slices together.
		for (int seed = 0; seed < 32; seed++) {
			final int salt = seed;
			Field mixed = new Field((x, z) -> 63, (x, z) -> noise(x, z, salt) > 0.45D);
			mixed.allowed = (x, z) -> x >= 0 && x <= 24 && z >= 0 && z <= 24;
			mixed.blocked = (x, z) -> x != 0 && z != 24 && noise(x, z, salt + 100) > 0.78D;
			mixed.hazard = (x, z) -> x != 0 && z != 24 && noise(x, z, salt + 200) > 0.92D;
			GridPosition goal = new GridPosition(24, 64, 24);
			PathPlan direct = find(mixed, goal);
			validate(mixed, direct, goal);
			LocalPathfinder.Search search = new LocalPathfinder().beginSearch(START, Set.of(goal), goal, 32, Set.of());
			PathPlan sliced = null;
			int expanded = 0;
			for (int tick = 0; tick < 512 && !search.finished(); tick++) {
				sliced = search.advance(mixed, new LocalPathfinder.SearchBudget(7, 1_000, () -> 0));
				expanded += sliced.expandedNodes();
			}
			check(search.finished(), "mixed sliced search finishes " + seed);
			validate(mixed, sliced, goal);
			check(direct.nodes().equals(sliced.nodes()) && direct.expandedNodes() == expanded, "tick slicing preserves mixed path " + seed);
		}
		return assertions;
	}

	private static void verifyHeuristicBound() {
		try {
			var heuristic = LocalPathfinder.class.getDeclaredMethod("heuristic", WalkabilityView.class, GridPosition.class, GridPosition.class);
			heuristic.setAccessible(true);
			Field field = new Field((x, z) -> 63, (x, z) -> x == 0);
			GridPosition next = new GridPosition(1, 64, 0), goal = new GridPosition(2, 64, 0);
			long own = (long) heuristic.invoke(null, field, START, goal);
			long after = (long) heuristic.invoke(null, field, next, goal);
			check(own == 36 && after == 10 && own > edgeCost(field, START, next) + after, "sand-to-stone heuristic is intentionally inconsistent");
			for (double speed : new double[]{SAND_SPEED, 0.1135D, 0.01D, 1.0D, 1.615D}) {
				field.slowSpeed = speed;
				long value = (long) heuristic.invoke(null, field, START, goal);
				check(value >= 20 && value <= 36, "horizontal weighting stays between 1 and 1.8 at speed " + speed);
			}
		} catch (ReflectiveOperationException exception) {
			throw new AssertionError(exception);
		}
	}

	private static void verifyExpansions(Field field, GridPosition goal, int expected, String label) {
		PathPlan plan = find(field, goal);
		validate(field, plan, goal);
		check(plan.expandedNodes() == expected, label + " expansions: " + plan.expandedNodes());
		System.out.println("WEIGHTED_PATH " + label + " expanded=" + plan.expandedNodes());
	}

	private static void verifyCost(Field field, GridPosition goal, long expected, long optimal, int expansions, String label) {
		PathPlan plan = find(field, goal);
		validate(field, plan, goal);
		long cost = 0;
		for (int i = 1; i < plan.nodes().size(); i++) {
			check(plan.nodes().get(i).traversal() == TraversalType.WALK, label + " flat path uses only cardinal walks");
			cost += edgeCost(field, plan.nodes().get(i - 1).position(), plan.nodes().get(i).position());
		}
		long reference = optimalCost(field, goal);
		check(cost == expected && reference == optimal, label + " selected=" + cost + " optimal=" + reference);
		check(plan.expandedNodes() == expansions, label + " expansions=" + plan.expandedNodes());
		System.out.println("WEIGHTED_PATH " + label + " selected=" + cost + " optimal=" + reference + " expanded=" + plan.expandedNodes());
	}

	/** Independent Dijkstra oracle for flat cardinal fixtures; it never uses the production heuristic or closed set. */
	private static long optimalCost(Field field, GridPosition goal) {
		record Entry(GridPosition position, long cost) { }
		PriorityQueue<Entry> queue = new PriorityQueue<>(Comparator.comparingLong(Entry::cost));
		Map<GridPosition, Long> costs = new HashMap<>();
		queue.add(new Entry(START, 0));
		costs.put(START, 0L);
		while (!queue.isEmpty()) {
			Entry current = queue.remove();
			if (current.cost() != costs.get(current.position())) continue;
			if (current.position().equals(goal)) return current.cost();
			for (int[] direction : DIRECTIONS) {
				GridPosition next = current.position().offset(direction[0], 0, direction[1]);
				if (!field.isStandable(next)) continue;
				long candidate = current.cost() + edgeCost(field, current.position(), next);
				if (candidate >= costs.getOrDefault(next, Long.MAX_VALUE)) continue;
				costs.put(next, candidate);
				queue.add(new Entry(next, candidate));
			}
		}
		throw new AssertionError("oracle found no path");
	}

	private static int edgeCost(Field field, GridPosition source, GridPosition target) {
		return (int) Math.ceil(10 * (1 / field.movementSpeedMultiplier(source) + 1 / field.movementSpeedMultiplier(target)) / 2);
	}

	private static PathPlan find(Field field, GridPosition goal) {
		return new LocalPathfinder().findPath(field, START, goal, 8_192, 1_000, () -> 0);
	}

	private static void validate(Field field, PathPlan plan, GridPosition goal) {
		check(plan != null && plan.outcome() == PathOutcome.FOUND, "route found");
		check(plan.nodes().getFirst().position().equals(START) && plan.nodes().getLast().position().equals(goal), "route preserves endpoints");
		Set<GridPosition> visited = new HashSet<>();
		for (int i = 0; i < plan.nodes().size(); i++) {
			GridPosition position = plan.nodes().get(i).position();
			check(field.isStandable(position) && visited.add(position), "closed parent chain stays standable and acyclic: " + position);
			if (i == 0) continue;
			GridPosition previous = plan.nodes().get(i - 1).position();
			int horizontal = Math.abs(previous.x() - position.x()) + Math.abs(previous.z() - position.z());
			TraversalType traversal = plan.nodes().get(i).traversal();
			check(horizontal == (traversal == TraversalType.JUMP_GAP ? 2 : 1), "route has connected cardinal edges");
			check(traversal != TraversalType.WALK || previous.y() == position.y(), "walk edge preserves height");
		}
	}

	private static double noise(int x, int z, int seed) {
		long hash = x * 374761393L + z * 668265263L + seed * 1442695040888963407L;
		hash = (hash ^ (hash >>> 13)) * 1274126177L;
		return ((hash ^ (hash >>> 16)) & 0xffff) / 65535.0D;
	}

	private static double smooth(int x, int z) {
		double sum = 0;
		for (int dx = -4; dx <= 4; dx++) for (int dz = -4; dz <= 4; dz++) {
			sum += noise(Math.floorDiv(x + dx, 4), Math.floorDiv(z + dz, 4), 7);
		}
		return sum / 81;
	}

	private static void check(boolean condition, String label) {
		assertions++;
		if (!condition) throw new AssertionError(label);
	}

	private static final class Field implements WalkabilityView {
		final ToIntBiFunction<Integer, Integer> floor;
		final BiPredicate<Integer, Integer> slow;
		BiPredicate<Integer, Integer> allowed = (x, z) -> Math.abs(x) <= 72 && Math.abs(z) <= 72;
		BiPredicate<Integer, Integer> blocked = (x, z) -> false, hazard = (x, z) -> false;
		double slowSpeed = SAND_SPEED;
		Field(ToIntBiFunction<Integer, Integer> floor, BiPredicate<Integer, Integer> slow) { this.floor = floor; this.slow = slow; }
		public Cell cellAt(GridPosition position) {
			int x = position.x(), z = position.z(), height = floor.applyAsInt(x, z);
			if (!allowed.test(x, z)) return Cell.UNLOADED;
			if (blocked.test(x, z)) return Cell.BLOCKED;
			if (position.y() == height) return hazard.test(x, z) ? Cell.HAZARD : Cell.SAFE_SUPPORT;
			return position.y() > height ? Cell.CLEAR : Cell.BLOCKED;
		}
		public double movementSpeedMultiplier(GridPosition position) { return slow.test(position.x(), position.z()) ? slowSpeed : 1.0D; }
		public boolean isGapClear(GridPosition position) { return !hazard.test(position.x(), position.z()) && WalkabilityView.super.isGapClear(position); }
	}
}
