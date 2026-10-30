package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.LocalPathfinder;
import dev.agaminggod.arenaagents.client.navigation.PathNode;
import dev.agaminggod.arenaagents.client.navigation.PathOutcome;
import dev.agaminggod.arenaagents.client.navigation.PathPlan;
import dev.agaminggod.arenaagents.client.navigation.TraversalType;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.function.BooleanSupplier;
import java.util.function.Function;
import java.util.function.BiPredicate;
import dev.agaminggod.arenaagents.server.perception.EntityHitboxSight;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/**
 * Pure geometry behind fight_target's reachability check: which cells a player could stand in and still reach the
 * target's hitbox, and what a finished bounded search over the terrain the player has seen says about getting to one.
 * It only answers "can the chosen target be reached on foot"; the model still decides what to do about it.
 */
public final class MeleeReach {
	/** Player eye height above the feet while standing. */
	public static final double EYE_HEIGHT = 1.62D;
	/** A body can stand anywhere in its cell; judging from the centre keeps this much slack. */
	static final double CELL_SLACK = 0.3D;
	/** Search box half-size around the agent: the chase limit plus room to walk round to a ramp. */
	static final int MIN_SEARCH_RADIUS = 12;
	static final int MAX_SEARCH_RADIUS = 32;

	private MeleeReach() {
	}

	/**
	 * REACHABLE: a route ends on a reach cell. UNREACHABLE: the whole area the player can walk from here is known and
	 * was searched, and none of it is within reach.
 UNSEEN: no route through seen terrain, but the walkable area runs on
	 * into unseen or unloaded cells or past the search box, so a route may exist there. UNKNOWN: the search did not
	 * finish (cap, invalid start); nothing is decided.
	 */
	public enum Verdict { REACHABLE, UNREACHABLE, UNSEEN, UNKNOWN }

	/**
	 * Cells (feet positions) a player can stand, swim or climb in with the target's box within {@code reach} of the
	 * eyes. Scans only a small box around the target, so it costs a few hundred cell reads.
	 */
	public static Set<GridPosition> reachCells(WalkabilityView view, double minX, double minY, double minZ,
			double maxX, double maxY, double maxZ, double reach) {
		ReachCells cells = new ReachCells(minX, minY, minZ, maxX, maxY, maxZ, reach);
		cells.advance(view, () -> true);
		return cells.cells();
	}

	/**
	 * {@link #reachCells} as resumable work: each cell close enough to reach from claims one unit of work (the caller's
	 * share of the tick), so many fights checking at once spread the scan over ticks. Distance is checked before any
	 * terrain read. A cell whose footing could not be decided because a cell it needs is unknown is counted
	 * ({@link #undetermined}): with no known spot in reach, such a cell means a spot may exist out of sight.
	 */
	public static final class ReachCells {
		private final double minX, minY, minZ, maxX, maxY, maxZ, reach;
		private final int fromX, toX, fromY, toY, fromZ, toZ;
		private int x, y, z;
		private boolean complete;
		private int undetermined;
		private final Set<GridPosition> cells = new LinkedHashSet<>();
		private final Function<GridPosition, Boolean> clearLine;

		public ReachCells(double minX, double minY, double minZ, double maxX, double maxY, double maxZ, double reach) {
			this(minX, minY, minZ, maxX, maxY, maxZ, reach, null);
		}

		/** Exact hit-line checks need no conservative cell slack. */
		public ReachCells(double minX, double minY, double minZ, double maxX, double maxY, double maxZ, double reach,
				Function<GridPosition, Boolean> clearLine) {
			this.clearLine = clearLine;
			this.minX = minX;
			this.minY = minY;
			this.minZ = minZ;
			this.maxX = maxX;
			this.maxY = maxY;
			this.maxZ = maxZ;
			this.reach = reach;
			int horizontal = (int) Math.ceil(reach) + 1;
			fromX = (int) Math.floor(minX) - horizontal;
			toX = (int) Math.floor(maxX) + horizontal;
			fromZ = (int) Math.floor(minZ) - horizontal;
			toZ = (int) Math.floor(maxZ) + horizontal;
			fromY = (int) Math.floor(minY - reach - EYE_HEIGHT);
			toY = (int) Math.floor(maxY + reach - EYE_HEIGHT) + 1;
			x = fromX;
			y = fromY;
			z = fromZ;
		}


		/** Scans until done (true) or the budget refuses more work (false; call again next tick). */
		public boolean advance(WalkabilityView view, BooleanSupplier claimWork) {
			Objects.requireNonNull(view, "view must not be null");
			while (!complete) {
				if (inReach(x, y, z)) {
					if (!claimWork.getAsBoolean()) return false;
					test(view, new GridPosition(x, y, z));
				}
				if (++y > toY) {
					y = fromY;
					if (++z > toZ) {
						z = fromZ;
						if (++x > toX) complete = true;
					}
				}
			}
			return true;
		}

		private boolean inReach(int cellX, int cellY, int cellZ) {
			double eyeX = cellX + 0.5D;
			double eyeY = cellY + EYE_HEIGHT;
			double eyeZ = cellZ + 0.5D;
			double dx = Math.max(Math.max(minX - eyeX, 0.0D), eyeX - maxX);
			double dy = Math.max(Math.max(minY - eyeY, 0.0D), eyeY - maxY);
			double dz = Math.max(Math.max(minZ - eyeZ, 0.0D), eyeZ - maxZ);
			return Math.sqrt(dx * dx + dy * dy + dz * dz) <= reach - (clearLine == null ? CELL_SLACK : 0D);
		}

		private void test(WalkabilityView view, GridPosition cell) {
			int unknownBefore = view instanceof ObservedTerrain observed ? observed.unknownReads() : 0;
			if (standable(view.traversalAt(cell))) {
				Boolean clear = clearLine == null ? Boolean.TRUE : clearLine.apply(cell);
				if (Boolean.TRUE.equals(clear)) cells.add(cell);
				else if (clear == null) undetermined++;
			} else if (view instanceof ObservedTerrain observed && observed.unknownReads() > unknownBefore) {
				undetermined++;
			}
		}

		private static boolean standable(TraversalType traversal) {
			return traversal == TraversalType.WALK || traversal == TraversalType.SWIM || traversal == TraversalType.CLIMB;
		}

		public double reach() { return reach; }

		public Set<GridPosition> cells() {
			return cells;
		}

		/** Cells in reach whose footing depends on a cell the player does not know. */
		public int undetermined() {
			return undetermined;
		}
	}

	/** A clear hit on any exposed part of the current hitbox, measured from the standing cell's eyes. */
	static boolean clearHit(GridPosition cell, AABB box, double reach, BiPredicate<Vec3, Vec3> clear) {
		return clearHit(cell, box, 0D, reach, clear);
	}

	static boolean clearHit(GridPosition cell, AABB box, double minimum, double reach, BiPredicate<Vec3, Vec3> clear) {
		Vec3 eye = new Vec3(cell.x() + .5D, cell.y() + EYE_HEIGHT, cell.z() + .5D);
		if (box.distanceToSqr(eye) < minimum * minimum) return false;
		return EntityHitboxSight.point(eye, box, aim -> {
			Vec3 hit = EntityHitboxSight.intersection(eye, aim, box);
			return hit != null && eye.distanceToSqr(hit) <= reach * reach && clear.test(eye, hit);
		}) != null;
	}

	/** Null means that an unseen ray cell or shape dependency prevents deciding whether any part is exposed. */
	static Boolean knownHit(GridPosition cell, AABB box, double minimum, double reach, AcquiredGeometry geometry) {
		boolean[] unknown = {false};
		boolean hit = clearHit(cell, box, minimum, reach, (eye, point) -> {
			boolean clear = geometry.clearLine(eye, point);
			unknown[0] |= geometry.unknownLine();
			return clear;
		});
		if (hit) return Boolean.TRUE;
		return unknown[0] ? null : Boolean.FALSE;
	}

	/** Search box half-size for a target this far away (blocks, 3D). */
	public static int searchRadius(double distance) {
		int wanted = (int) Math.ceil(distance) + 8;
		return Math.max(MIN_SEARCH_RADIUS, Math.min(MAX_SEARCH_RADIUS, wanted));
	}

	/**
	 * Reads a bounded search (see {@link Verdict}). {@code boundaryReached}: a legal move left the search box.
	 * {@code openUnknown}: the search ran into an unknown cell beside known open space ({@link ObservedTerrain}).
	 */
	public static Verdict verdict(PathPlan plan, boolean finished, int retainedNodes, Set<GridPosition> goals,
			boolean boundaryReached, boolean openUnknown) {
		if (plan != null && !plan.nodes().isEmpty() && goals.contains(plan.nodes().get(plan.nodes().size() - 1).position())) {
			return Verdict.REACHABLE;
		}
		if (!finished || retainedNodes >= LocalPathfinder.MAX_RETAINED_NODES
				|| (plan != null && plan.outcome() == PathOutcome.INVALID)) return Verdict.UNKNOWN;
		return boundaryReached || openUnknown ? Verdict.UNSEEN : Verdict.UNREACHABLE;
	}

	/** The index of the last path node the feet already stand in (at or after {@code from}), or -1. */
	public static int occupiedNode(List<PathNode> nodes, int from, GridPosition feet) {
		for (int index = nodes.size() - 1; index >= from; index--) {
			if (nodes.get(index).position().equals(feet)) return index;
		}
		return -1;
	}

	/** A step-up or gap jump is pressed only near its takeoff, as navigation does. */
	public static boolean jumpFor(TraversalType traversal, double horizontalDistance, boolean onGround) {
		if (!onGround) return false;
		if (traversal == TraversalType.JUMP_UP) return horizontalDistance <= ServerNavigationController.JUMP_UP_TRIGGER_DISTANCE;
		if (traversal == TraversalType.JUMP_GAP) return horizontalDistance <= ServerNavigationController.GAP_TAKEOFF_MAX_DISTANCE;
		return false;
	}
}
