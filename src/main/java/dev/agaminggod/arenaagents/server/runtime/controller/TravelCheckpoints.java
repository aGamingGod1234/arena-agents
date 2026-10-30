package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import java.util.function.Predicate;

/**
 * Where travel_to walks next: a standing spot the player has seen, up to a local leg away, that gets closest to the
 * target, never one with lava or fire beside it (a leg that ended with lava in front of the face left the body blind and
 * stuck, 2026-10-24). A player who knows where a place lies picks visible ground on the way to it and heads there, then picks the
 * next; this does the same over acquired terrain only (unknown cells are never standing spots), fanning out from the
 * bearing to the target so a detour is chosen only when straight ahead has no seen ground.
 */
final class TravelCheckpoints {
	/** Leg lengths tried, longest first, as fractions of the leg reach. */
	static final double[] RADII = {1.0D, 0.8D, 0.6D, 0.4D, 0.25D};
	/** Bearing offsets tried around the bearing to the target (degrees). */
	static final double[] OFFSETS = {0.0D, 15.0D, -15.0D, 30.0D, -30.0D, 45.0D, -45.0D, 65.0D, -65.0D, 90.0D, -90.0D};
	/** Cells above and below the preferred height searched for a standing spot in each column. */
	static final int SCAN_UP = 8;
	static final int SCAN_DOWN = 12;
	/** A spot must bring the body at least this much closer to the target (blocks). */
	static final double MIN_GAIN = 2.0D;
	/** Cost of a block of climb or descent against a block of progress: a player prefers level ground. */
	static final double HEIGHT_COST = 0.35D;

	private TravelCheckpoints() {
	}

	/** Debug counts of the last pick on this thread: columns tried, columns with any known cell, spots found, spots too little closer. */
	static final ThreadLocal<int[]> LAST_PICK = ThreadLocal.withInitial(() -> new int[4]);

	/** A chosen standing spot (feet cell) and how far it leaves the body from the target, horizontally. */
	record Checkpoint(GridPosition feet, double left, boolean finalApproach, double backtrack) {
		Checkpoint(GridPosition feet, double left, boolean finalApproach) { this(feet, left, finalApproach, 0); }
	}

	/**
	 * The best seen standing spot toward {@code target} (y NaN: any height), or null when no seen spot gets closer.
	 * {@code refused} names spots a leg already failed to reach.
	 */
	static Checkpoint pick(WalkabilityView world, double bodyX, double bodyY, double bodyZ, double targetX, double targetY,
			double targetZ, double reach, Predicate<GridPosition> refused) {
		return pick(world, bodyX, bodyY, bodyZ, targetX, targetY, targetZ, reach, refused, java.util.List.of());
	}

	/**
	 * As above, also weighing {@code sighted} cells: the open cells above block tops the eye's sight lines landed on
	 * (see ServerTravelController#sightedSpots). Sparse columns miss a one-wide ridge, ledge or fortress bridge that a
	 * player looking along it picks at once.
	 */
	static Checkpoint pick(WalkabilityView world, double bodyX, double bodyY, double bodyZ, double targetX, double targetY,
			double targetZ, double reach, Predicate<GridPosition> refused, java.util.List<GridPosition> sighted) {
		double bodyLeft = left(bodyX, bodyY, bodyZ, targetX, targetY, targetZ, Y_BAND);
		int feetY = ServerTravelController.standingCellY(bodyY);
		if (bodyLeft <= reach) {
			// The target itself is within one leg: stand as near it as seen ground allows.
			int preferred = Double.isFinite(targetY) ? (int) Math.floor(targetY) : feetY;
			GridPosition at = standing(world, (int) Math.floor(targetX), preferred, (int) Math.floor(targetZ), refused);
			if (at != null) return new Checkpoint(at, left(at, targetX, targetY, targetZ), true);
		}
		double bearing = Math.atan2(targetZ - bodyZ, targetX - bodyX);
		int[] counts = LAST_PICK.get();
		java.util.Arrays.fill(counts, 0);
		Checkpoint best = null;
		double bestScore = Double.POSITIVE_INFINITY;
		for (double fraction : RADII) {
			double radius = Math.min(reach * fraction, bodyLeft + 1.0D);
			if (radius < 3.0D) continue;
			for (double offset : OFFSETS) {
				double angle = bearing + Math.toRadians(offset);
				int x = (int) Math.floor(bodyX + Math.cos(angle) * radius);
				int z = (int) Math.floor(bodyZ + Math.sin(angle) * radius);
				int preferred = feetY;
				if (Double.isFinite(targetY) && bodyLeft > 1.0D) {
					preferred = (int) Math.floor(bodyY + (targetY - bodyY) * Math.min(1.0D, radius / bodyLeft));
				}
				GridPosition at = standing(world, x, preferred, z, refused);
				counts[0]++;
				if (at == null) {
					if (ServerTravelController.DEBUG && anyKnown(world, x, preferred, z)) counts[1]++;
					continue;
				}
				counts[1]++;
				counts[2]++;
				double left = left(at, targetX, targetY, targetZ);
				if (left > bodyLeft - MIN_GAIN) { counts[3]++; continue; }
				double score = score(world, at, left, feetY, targetY);
				if (score < bestScore) {
					bestScore = score;
					best = new Checkpoint(at, left, false);
				}
			}
		}
		for (GridPosition at : sighted) {
			counts[0]++;
			double reachNow = Math.hypot(at.x() + 0.5D - bodyX, at.z() + 0.5D - bodyZ);
			if (reachNow > reach || reachNow < 3.0D || Math.abs(at.y() - feetY) > SCAN_DOWN) continue;
			if (!world.isStandable(at) || world.exposureCost(at) > 0 || refused.test(at)) continue;
			counts[2]++;
			double left = left(at, targetX, targetY, targetZ);
			if (left > bodyLeft - MIN_GAIN) { counts[3]++; continue; }
			double score = score(world, at, left, feetY, targetY);
			if (score < bestScore) {
				bestScore = score;
				best = new Checkpoint(at, left, false);
			}
		}
		return best;
	}


	/** Synchronous convenience for geometry fixtures; live travel retains WalkingSearch between ticks. */
	static Checkpoint walkingPick(WalkabilityView world, double x, double y, double z, double targetX, double targetY,
			double targetZ, double reach, Predicate<GridPosition> refused, java.util.List<GridPosition> sighted) {
		WalkingSearch pending = beginWalkingPick(world, x, y, z, targetX, targetY, targetZ, reach, refused, sighted);
		if (pending == null) return null;
		Checkpoint result;
		do { result = pending.advance(world); } while (!pending.finished());
		return result;
	}

	static WalkingSearch beginWalkingPick(WalkabilityView world, double x, double y, double z, double targetX, double targetY,
			double targetZ, double reach, Predicate<GridPosition> refused, java.util.List<GridPosition> sighted) {
		var candidates = new java.util.ArrayList<Checkpoint>();
		for (int i = 0; i < 8; i++) {
			Checkpoint next = pick(world, x, y, z, targetX, targetY, targetZ, reach,
					cell -> refused.test(cell) || candidates.stream().anyMatch(p -> Math.abs(p.feet().x() - cell.x()) <= 4
							&& Math.abs(p.feet().z() - cell.z()) <= 4 && Math.abs(p.feet().y() - cell.y()) <= 2), sighted);
			if (next == null) continue;
			candidates.add(next);
		}
		// Longer legs must not skip an acquired uphill path whose first eight blocks are all the height scan can reach.
		// Keep this out of the ordinary goal set: a nearby goal there would truncate an available longer walking leg.
		if (candidates.isEmpty() && reach > SCAN_UP) {
			Checkpoint near = pick(world, x, y, z, targetX, targetY, targetZ, SCAN_UP, refused, sighted);
			if (near != null) candidates.add(near);
		}
		if (candidates.isEmpty()) return null;
		var goals = candidates.stream().map(Checkpoint::feet).collect(java.util.stream.Collectors.toSet());
		GridPosition start = new GridPosition((int) Math.floor(x), ServerTravelController.standingCellY(y), (int) Math.floor(z));
		GridPosition destination = new GridPosition((int) Math.floor(targetX), Double.isFinite(targetY) ? (int) Math.floor(targetY) : start.y(), (int) Math.floor(targetZ));
		var planner = new dev.agaminggod.arenaagents.client.navigation.LocalPathfinder();
		var search = planner.beginSearch(start, goals, destination, Math.min(64, (int) Math.ceil(reach) + 4), java.util.Set.of());
		// Standing at the end of a newly built bridge is a valid frontier. If it is best, build on from here
		// rather than walking back to a worse frontier near the old start of the bridge.
		search.allowStartFrontier();
		return new WalkingSearch(start, search, candidates, left(x, y, z, targetX, targetY, targetZ, Y_BAND), targetX, targetY, targetZ, refused);
	}

	/** A slice limit means unfinished work, not proof that the acquired ground has no connected route. */
	static final class WalkingSearch {
		final GridPosition origin;
		private final dev.agaminggod.arenaagents.client.navigation.LocalPathfinder.Search search;
		private final java.util.List<Checkpoint> candidates;
		private final double before, targetX, targetY, targetZ;
		private final Predicate<GridPosition> refused;
		private int expanded;
		private boolean done;

		WalkingSearch(GridPosition origin, dev.agaminggod.arenaagents.client.navigation.LocalPathfinder.Search search,
				java.util.List<Checkpoint> candidates, double before, double targetX, double targetY, double targetZ, Predicate<GridPosition> refused) {
			this.origin = origin; this.search = search; this.candidates = candidates; this.before = before;
			this.targetX = targetX; this.targetY = targetY; this.targetZ = targetZ; this.refused = refused;
		}

		boolean finished() { return done; }

		Checkpoint advance(WalkabilityView world) {
			var budget = new dev.agaminggod.arenaagents.client.navigation.LocalPathfinder.SearchBudget(
					dev.agaminggod.arenaagents.client.navigation.LocalPathfinder.MAX_EXPANDED_NODES - expanded,
					dev.agaminggod.arenaagents.client.navigation.LocalPathfinder.MAX_PLANNING_TIME_NANOS, System::nanoTime);
			var route = search.advance(world, budget);
			expanded += budget.expandedNodes();
			done = search.finished() || expanded >= dev.agaminggod.arenaagents.client.navigation.LocalPathfinder.MAX_EXPANDED_NODES;
			if (!done) return null;
			if (route.nodes().isEmpty() || route.nodes().stream().anyMatch(n -> world.exposureCost(n.position()) > 0)) return null;
			GridPosition end = route.nodes().getLast().position();
			double after = left(end, targetX, targetY, targetZ);
			boolean finalApproach = candidates.stream().anyMatch(p -> p.finalApproach() && p.feet().equals(end));
			// Dense remembered turns and a trip's last block need less than the intermediate-leg progress threshold.
			if (!finalApproach && before - after < MIN_GAIN || refused.test(end)) return null;
			double backtrack = route.nodes().stream().mapToDouble(n -> left(n.position().x() + 0.5D, n.position().y(),
					n.position().z() + 0.5D, targetX, targetY, targetZ, Y_BAND) - before).max().orElse(0);
			return new Checkpoint(end, after, finalApproach, Math.max(0, backtrack));
		}
	}

	/** A short sideways route around a blocked bearing, over acquired ground only, before returning NO_ROUTE. */
	static GridPosition detour(WalkabilityView world, double x, double y, double z, double targetX, double targetZ,
			Predicate<GridPosition> refused) {
		double bearing = Math.atan2(targetZ - z, targetX - x), left = Math.hypot(targetX - x, targetZ - z);
		for (double radius : new double[] {8.0D, 5.0D}) for (double turn : new double[] {60, -60, 90, -90}) {
			double angle = bearing + Math.toRadians(turn);
			GridPosition at = standing(world, (int) Math.floor(x + Math.cos(angle) * radius),
					ServerTravelController.standingCellY(y), (int) Math.floor(z + Math.sin(angle) * radius), refused);
			if (at != null && Math.hypot(targetX - at.x() - 0.5D, targetZ - at.z() - 0.5D) <= left + ServerTravelController.BACKTRACK)
				return at;
		}
		return null;
	}

	/** Height change toward a given target y is the progress itself, not a detour: only height away from it costs. */
	static double score(WalkabilityView world, GridPosition at, double left, int feetY, double targetY) {
		if (!Double.isFinite(targetY)) return left + HEIGHT_COST * Math.abs(at.y() - feetY);
		boolean toward = (at.y() - feetY) * (targetY - feetY) > 0 && Math.abs(at.y() - feetY) <= Math.abs(targetY - feetY) + Y_BAND;
		return left + (toward ? 0.0D : HEIGHT_COST * Math.abs(at.y() - feetY));
	}

	/** Height within which a target y counts as reached (travel_to's arrival band). */
	static final double Y_BAND = 3.0D;

	/** Horizontal distance to the target, plus the height past {@code band} when the target has a y. */
	static double left(double x, double y, double z, double targetX, double targetY, double targetZ, double band) {
		double horizontal = Math.hypot(targetX - x, targetZ - z);
		if (!Double.isFinite(targetY)) return horizontal;
		return Math.hypot(horizontal, Math.max(0.0D, Math.abs(targetY - y) - band));
	}

	private static double left(GridPosition at, double targetX, double targetY, double targetZ) {
		return left(at.x() + 0.5D, at.y(), at.z() + 0.5D, targetX, targetY, targetZ, Y_BAND);
	}

	private static boolean anyKnown(WalkabilityView world, int x, int preferred, int z) {
		for (int dy = -SCAN_DOWN; dy <= SCAN_UP; dy += 4) if (world.cellAt(new GridPosition(x, preferred + dy, z)) != WalkabilityView.Cell.UNLOADED) return true;
		return false;
	}

	/** The seen standing cell in this column nearest {@code preferred}, or null. */
	static GridPosition standing(WalkabilityView world, int x, int preferred, int z, Predicate<GridPosition> refused) {
		for (int step = 0; step <= Math.max(SCAN_UP, SCAN_DOWN) * 2; step++) {
			int dy = (step + 1) / 2 * ((step & 1) == 0 ? -1 : 1);
			if (dy > SCAN_UP || -dy > SCAN_DOWN) continue;
			GridPosition cell = new GridPosition(x, preferred + dy, z);
			if (world.isStandable(cell) && world.exposureCost(cell) == 0 && !refused.test(cell)) return cell;
		}
		return null;
	}
}
