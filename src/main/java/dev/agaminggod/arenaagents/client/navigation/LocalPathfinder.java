package dev.agaminggod.arenaagents.client.navigation;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.PriorityQueue;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;

public final class LocalPathfinder implements PathPlanner {
	public static final int MAX_EXPANDED_NODES = 8_192;
	public static final long MAX_PLANNING_TIME_NANOS = TimeUnit.MILLISECONDS.toNanos(40L);
	public static final int MAX_DROP_BLOCKS = 3;
	public static final int MAX_RETAINED_NODES = 32_768;
	public static final int MAX_EXPANDED_NODES_PER_SLICE = 512;
	/**
	 * Consecutive submerged cells a route may cross on one full breath: vanilla 300 air less a 60-tick reserve is 12 s,
	 * at a conservative 2 blocks/s. Callers pass the live breath for the run that contains the start.
	 */
	public static final int FULL_BREATH_SUBMERGED_NODES = 24;
	/**
	 * Arrivals kept beyond one per reached cell (other breath levels, other route histories). They have their own
	 * budget so they can never use up {@link #MAX_RETAINED_NODES}; once it is spent each cell keeps one arrival.
	 */
	static final int MAX_EXTRA_ARRIVALS = 4_096;

	private static final int WALK_COST = 10;
	private static final int JUMP_UP_COST = 14;
	private static final int JUMP_GAP_COST = 18;
	private static final int DROP_BASE_COST = 11;
	private static final int DROP_PER_BLOCK_COST = 1;
	private static final int SURFACE_SWIM_COST = 16;
	/** Submerged swimming costs more so a dry or surface route of similar length wins. */
	private static final int SUBMERGED_SWIM_COST = 20;
	private static final int HEIGHT_HEURISTIC_COST = 1;
	private static final int[][] CARDINAL_OFFSETS = {
		{1, 0},
		{0, 1},
		{-1, 0},
		{0, -1}
	};
	private static final Comparator<SearchNode> OPEN_ORDER = Comparator
			.comparingLong(SearchNode::estimatedTotalCost)
			.thenComparingLong(SearchNode::heuristicCost)
			.thenComparingLong(SearchNode::pathCost)
			.thenComparingLong(SearchNode::sequence)
			.thenComparingInt(node -> node.position().x())
			.thenComparingInt(node -> node.position().y())
			.thenComparingInt(node -> node.position().z());

	@Override
	public PathPlan findPath(
			WalkabilityView view,
			GridPosition start,
			GridPosition destination
	) {
		return findPath(
				view,
				start,
				destination,
				MAX_EXPANDED_NODES,
				MAX_PLANNING_TIME_NANOS,
				System::nanoTime
		);
	}

	public PathPlan findPath(
			WalkabilityView view,
			GridPosition start,
			GridPosition destination,
			int maximumExpandedNodes,
			long timeBudgetNanos,
			LongSupplier monotonicClock
	) {
		if (view == null || start == null || destination == null || monotonicClock == null
				|| maximumExpandedNodes <= 0 || timeBudgetNanos <= 0L) {
			return PathPlan.failed(PathOutcome.INVALID, 0);
		}
		return findPath(
				view,
				start,
				destination,
				new SearchBudget(maximumExpandedNodes, timeBudgetNanos, monotonicClock)
		);
	}

	/**
	 * Plans against a caller-owned budget. Reusing the budget across requests makes
	 * its expansion and deadline limits aggregate instead of multiplying per path.
	 */
	public PathPlan findPath(
			WalkabilityView view,
			GridPosition start,
			GridPosition destination,
			SearchBudget budget
	) {
		if (view == null || start == null || destination == null || budget == null) {
			return PathPlan.failed(PathOutcome.INVALID, 0);
		}
		if (!view.isTraversable(start) || !view.isTraversable(destination)) {
			return PathPlan.failed(PathOutcome.INVALID, 0);
		}
		if (start.equals(destination)) return new PathPlan(List.of(new PathNode(start, TraversalType.START)), PathOutcome.FOUND, 0);
		return new Search(start, Set.of(destination), destination, 0, Set.of(), FULL_BREATH_SUBMERGED_NODES).advance(view, budget);
	}

	/** Retains one bounded search. The caller must discard it when its terrain snapshot changes. */
	public Search beginSearch(GridPosition start, Set<GridPosition> goals, GridPosition destination,
			int radius, Set<GridPosition> previousFrontiers) {
		return beginSearch(start, goals, destination, radius, previousFrontiers, FULL_BREATH_SUBMERGED_NODES);
	}

	/**
	 * As {@link #beginSearch(GridPosition, Set, GridPosition, int, Set)} where the start's submerged run may continue
	 * for at most {@code startBreathNodes} cells (the swimmer's remaining air); later runs get a full breath.
	 */
	public Search beginSearch(GridPosition start, Set<GridPosition> goals, GridPosition destination,
			int radius, Set<GridPosition> previousFrontiers, int startBreathNodes) {
		if (radius < 1 || radius > 64) throw new IllegalArgumentException("local search radius must be 1..64");
		return new Search(start, goals, destination, radius, previousFrontiers, startBreathNodes);
	}

	public static final class Search {
		private final GridPosition start;
		private final Set<GridPosition> goals;
		private final GridPosition destination;
		private final int radius;
		private final Set<GridPosition> previousFrontiers;
		private final PriorityQueue<SearchNode> open = new PriorityQueue<>(OPEN_ORDER);
		/**
		 * Nondominated arrivals per reached cell. Remaining breath decides which later submerged edges are legal, so a
		 * cheap depleted arrival must not discard a costlier one with more air. Dry cells always hold full breath and so
		 * keep exactly one label, as a position-keyed search would.
		 */
		private final Map<GridPosition, CellLabels> labels = new HashMap<>();
		private final Label startLabel;
		private final int startBreathNodes;
		private int retainedLabels;
		private SearchNode frontier;
		private long nextSequence;
		private boolean finished;
		private boolean boundaryReached;
		private boolean unknownFrontier;
		private boolean allowStartFrontier;
		private boolean frontierHasKnownContinuation;

		private Search(GridPosition start, Set<GridPosition> goals, GridPosition destination,
				int radius, Set<GridPosition> previousFrontiers, int startBreathNodes) {
			this.start = Objects.requireNonNull(start);
			this.startBreathNodes = Math.max(0, Math.min(FULL_BREATH_SUBMERGED_NODES, startBreathNodes));
			this.goals = Set.copyOf(goals);
			this.destination = Objects.requireNonNull(destination);
			this.radius = radius;
			this.previousFrontiers = Set.copyOf(previousFrontiers);
			startLabel = new Label(start, 0L, -1, null, TraversalType.START);
			CellLabels startCell = new CellLabels();
			startCell.labels.add(startLabel);
			labels.put(start, startCell);
			retainedLabels = 1;
			open.add(new SearchNode(startLabel, 0L, 0L, nextSequence++));
		}

		public boolean finished() { return finished; }
		/** Distinct cells the search reached (its start included); bounded by {@link #MAX_RETAINED_NODES}. */
		public int retainedNodes() { return labels.size(); }
		/** All retained arrivals: one per reached cell plus at most {@link #MAX_EXTRA_ARRIVALS} more. */
		int retainedLabels() { return retainedLabels; }
		/** True once a legal move led out of the search box: the explored area is cut off there, not closed. */
		public boolean boundaryReached() { return boundaryReached; }
		/** The returned partial route ends where acquired terrain stops. */
		public boolean endedAtUnknown() { return unknownFrontier; }

		/** Recheck a reached sight frontier without substituting a worse boundary when no continuation was acquired. */
		public void allowStartFrontier() { allowStartFrontier = true; }
		/** True when the search reached this cell (its start included). */
		public boolean explored(GridPosition position) { return labels.containsKey(position); }
		/** The largest per-axis distance from the start of any reached cell; read once when a search fails. */
		public int farthestExplored() {
			int farthest = 0;
			for (GridPosition position : labels.keySet()) farthest = Math.max(farthest, distanceFromStart(position));
			return farthest;
		}

		public PathPlan advance(WalkabilityView view, SearchBudget budget) {
			return advance(view, budget, () -> false);
		}

		/**
		 * As {@link #advance(WalkabilityView, SearchBudget)}, also pausing (unfinished, resumable) once
		 * {@code sliceOver} says this caller's own share of the tick is spent.
		 */
		public PathPlan advance(WalkabilityView view, SearchBudget budget, java.util.function.BooleanSupplier sliceOver) {
			if (finished) throw new IllegalStateException("search has already finished");
			int expandedAtStart = budget.expandedNodes();
			if (!view.isTraversable(start)) return finish(PathPlan.failed(PathOutcome.INVALID, 0));
			if (startLabel.breath < 0) startLabel.breath = view.isSubmerged(start) ? startBreathNodes : FULL_BREATH_SUBMERGED_NODES;
			while (!open.isEmpty()) {
				if (budget.timeExceeded()) return PathPlan.failed(budget.exhaustionOutcome(), budget.expandedNodes() - expandedAtStart);
				if (sliceOver.getAsBoolean()) return PathPlan.failed(PathOutcome.TIME_LIMIT, budget.expandedNodes() - expandedAtStart);
				if (radius > 0 && budget.expandedNodes() - expandedAtStart >= MAX_EXPANDED_NODES_PER_SLICE) {
					return PathPlan.failed(PathOutcome.NODE_LIMIT, budget.expandedNodes() - expandedAtStart);
				}
				SearchNode current = open.peek();
				Label currentLabel = current.label();
				if (currentLabel.discarded || currentLabel.closed) {
					open.remove();
					continue;
				}
				if (goals.contains(current.position())) {
					return finish(reconstruct(start, currentLabel, budget.expandedNodes() - expandedAtStart));
				}
				if (!budget.tryExpand()) return PathPlan.failed(budget.exhaustionOutcome(), budget.expandedNodes() - expandedAtStart);
				open.remove();
				currentLabel.closed = true;
				CellLabels currentCell = labels.get(current.position());
				currentCell.hasClosed = true;
				currentCell.closedClean |= currentLabel.breath >= FULL_BREATH_SUBMERGED_NODES && currentLabel.barred == null;
				int currentBreath = currentLabel.breath;
				if (radius > 0 && isFrontier(view, current.position())) {
					// The start's queue priority is zero; frontier comparisons need its actual destination cost.
					SearchNode candidate = current.position().equals(start)
							? new SearchNode(currentLabel, current.pathCost(), heuristic(view, start, destination), current.sequence()) : current;
					if (frontier == null || candidate.heuristicCost() < frontier.heuristicCost()
							|| (candidate.heuristicCost() == frontier.heuristicCost() && candidate.pathCost() < frontier.pathCost())) {
						frontier = candidate;
						frontierHasKnownContinuation = false;
					}
				}
				for (Neighbor neighbor : neighbors(view, current.position())) {
					CellLabels known = labels.get(neighbor.position());
					// Do not reopen: a closed arrival with full breath and no air-short history covers every later one.
					// Inconsistent weights can lose a cheaper route, but cannot change validated edges or create a cycle.
					if (known != null && known.closedClean) continue;
					if (radius > 0 && distanceFromStart(neighbor.position()) > radius) {
						boundaryReached = true;
						if (frontier != null && current.position().equals(frontier.position())
								&& (!view.isSubmerged(neighbor.position()) || currentBreath > 0)) frontierHasKnownContinuation = true;
						continue;
					}
					long candidateCost = saturatedAdd(current.pathCost(), neighbor.cost());
					// Reaching air (or never leaving it) restores a full breath; each submerged cell spends one.
					boolean submerged = view.isSubmerged(neighbor.position());
					int neighborBreath = submerged ? currentBreath - 1 : FULL_BREATH_SUBMERGED_NODES;
					if (neighborBreath < 0) continue;
					Deficit run = currentLabel.run;
					Deficit barred = currentLabel.barred;
					if (submerged) {
						if (neighborBreath < FULL_BREATH_SUBMERGED_NODES - 1) run = new Deficit(neighbor.position(), run);
					} else if (run != null) {
						barred = run;
						run = null;
					}
					List<Label> dominated = List.of();
					if (known != null) {
						// An arrival no cheaper and with no more air than a retained (or expanded) one adds only its route
						// history: worth keeping only if it may still enter a cell every retained arrival here is barred from.
						if (known.coveredIgnoringHistory(candidateCost, neighborBreath)
								&& !known.freesCommonlyBarredCell(currentLabel, neighbor.position())) continue;
						// PathPlan forbids repeated cells; every closed label on this chain shares its cell with a closed arrival.
						if (known.hasClosed && onChain(currentLabel, neighbor.position())) continue;
						dominated = known.dominatedOpenLabels(candidateCost, neighborBreath, barred);
						if (dominated.isEmpty() && retainedLabels - labels.size() >= MAX_EXTRA_ARRIVALS) {
							// Extra arrivals are spent: keep one arrival per cell, as a position-keyed search does.
							if (known.hasClosed || candidateCost >= known.cheapestOpenCost()) continue;
							dominated = List.copyOf(known.labels);
						}
					} else if (labels.size() >= MAX_RETAINED_NODES) {
						unknownFrontier = frontier != null && !frontierHasKnownContinuation && bordersUnknown(view, frontier.position());
						return finish(frontierPlan(PathOutcome.NODE_LIMIT, budget.expandedNodes() - expandedAtStart));
					}
					int discarded = dominated.size();
					if (known == null) {
						known = new CellLabels();
						labels.put(neighbor.position(), known);
					} else if (discarded > 0) {
						for (Label label : dominated) label.discarded = true;
						known.labels.removeAll(dominated);
					}
					Label label = new Label(neighbor.position(), candidateCost, neighborBreath, currentLabel, neighbor.traversal(), run, barred);
					known.labels.add(label);
					retainedLabels += 1 - discarded;
					open.add(new SearchNode(label, candidateCost,
							heuristic(view, neighbor.position(), destination), nextSequence++));
				}
			}
			unknownFrontier = frontier != null && !frontierHasKnownContinuation && bordersUnknown(view, frontier.position());
			return finish(frontierPlan(PathOutcome.NO_PATH, budget.expandedNodes() - expandedAtStart));
		}

		private int distanceFromStart(GridPosition position) {
			return (int) Math.min(Integer.MAX_VALUE, Math.max(absoluteDifference(start.x(), position.x()),
					Math.max(absoluteDifference(start.y(), position.y()), absoluteDifference(start.z(), position.z()))));
		}

		private boolean isFrontier(WalkabilityView view, GridPosition position) {
			int distance = distanceFromStart(position);
			if (distance == 0 ? !allowStartFrontier
					: (!view.allowsShortFrontiers() && distance < Math.min(8, radius)) || previousFrontiers.contains(position)) return false;
			// A partial route never ends with the eyes under water; the next segment would start out of breath.
			if (view.isSubmerged(position)) return false;
			// Nor beside lava: the body waits there for the next decision (d14-iron-e stopped in a pit under a lava fall).
			if (distance > 0 && view.exposureCost(position) > 0) return false;
			if (distance == radius) return true;
			return bordersUnknown(view, position);
		}

		private PathPlan frontierPlan(PathOutcome failure, int expanded) {
			return frontier == null ? PathPlan.failed(failure, expanded) : reconstruct(start, frontier.label(), expanded);
		}

		private PathPlan finish(PathPlan result) {
			finished = true;
			return result;
		}
	}

	private static boolean onChain(Label label, GridPosition position) {
		for (Label cursor = label; cursor != null; cursor = cursor.parent) {
			if (cursor.position.equals(position)) return true;
		}
		return false;
	}

	private static boolean containsDeficit(Deficit deficits, GridPosition position) {
		for (Deficit cursor = deficits; cursor != null; cursor = cursor.next) {
			if (cursor.position.equals(position)) return true;
		}
		return false;
	}

	/**
	 * Submerged cells a route crossed short of air (breath below a fresh breath's first step). After refilling in an
	 * air pocket a route may need to swim back through one of them with more air, which its own chain bars (routes
	 * never repeat a cell). Other chain cells never need a revisit: the earlier arrival had as much air for less.
	 */
	private record Deficit(GridPosition position, Deficit next) { }

	/** One arrival at a cell: its cost, the submerged cells still allowed before air, and its own immutable parent chain. */
	private static final class Label {
		private final GridPosition position;
		private final long cost;
		/** Set once for the start, when the first slice can ask the view whether it is under water. */
		private int breath;
		private final Label parent;
		private final TraversalType traversal;
		/** Air-short cells of the current submerged run. */
		private final Deficit run;
		/** Air-short cells of the run before the latest refill: the ones a swim back from that air would need. */
		private final Deficit barred;
		private boolean closed;
		private boolean discarded;

		private Label(GridPosition position, long cost, int breath, Label parent, TraversalType traversal) {
			this(position, cost, breath, parent, traversal, null, null);
		}

		private Label(GridPosition position, long cost, int breath, Label parent, TraversalType traversal,
				Deficit run, Deficit barred) {
			this.position = position;
			this.cost = cost;
			this.breath = breath;
			this.parent = parent;
			this.traversal = traversal;
			this.run = run;
			this.barred = barred;
		}
	}

	/**
	 * Retained arrivals at one cell. Each costs less or has more breath than every other, except arrivals kept in air
	 * because they alone may still swim back through an adjacent air-short cell.
	 */
	private static final class CellLabels {
		private final List<Label> labels = new ArrayList<>(1);
		private boolean hasClosed;
		/** An expanded full-breath arrival is barred from no air-short cell, so it covers every later arrival. */
		private boolean closedClean;

		/** A retained label that is closed or no costlier, with no less air, ignoring route history. */
		private boolean coveredIgnoringHistory(long cost, int breath) {
			for (Label label : labels) {
				if (label.breath >= breath && (label.closed || label.cost <= cost)) return true;
			}
			return false;
		}

		/**
		 * True when an arrival at {@code position} through {@code parent} may still enter a cell that every retained
		 * arrival here is barred from. Each kept arrival shrinks that common set, so a cell keeps few of them.
		 */
		private boolean freesCommonlyBarredCell(Label parent, GridPosition position) {
			if (labels.isEmpty()) return false;
			for (Deficit cursor = labels.getFirst().barred; cursor != null; cursor = cursor.next) {
				GridPosition cell = cursor.position;
				boolean barredForAll = !cell.equals(position);
				for (int index = 1; index < labels.size() && barredForAll; index++) {
					barredForAll = containsDeficit(labels.get(index).barred, cell);
				}
				if (barredForAll && !onChain(parent, cell)) return true;
			}
			return false;
		}

		/** Open labels the arrival beats on cost and breath, except those still free to enter a cell it is barred from. */
		private List<Label> dominatedOpenLabels(long cost, int breath, Deficit arrivalBarred) {
			List<Label> dominated = null;
			for (Label label : labels) {
				if (label.closed || cost > label.cost || breath < label.breath) continue;
				if (freesBarredCell(label, arrivalBarred)) continue;
				if (dominated == null) dominated = new ArrayList<>(1);
				dominated.add(label);
			}
			return dominated == null ? List.of() : dominated;
		}

		private static boolean freesBarredCell(Label label, Deficit arrivalBarred) {
			for (Deficit cursor = arrivalBarred; cursor != null; cursor = cursor.next) {
				if (!onChain(label, cursor.position)) return true;
			}
			return false;
		}

		private long cheapestOpenCost() {
			long cheapest = Long.MAX_VALUE;
			for (Label label : labels) {
				if (!label.closed) cheapest = Math.min(cheapest, label.cost);
			}
			return cheapest;
		}
	}

	private static boolean bordersUnknown(WalkabilityView view, GridPosition position) {
		for (int[] offset : CARDINAL_OFFSETS) {
			GridPosition next = position.offset(offset[0], 0, offset[1]);
			if (view.cellAt(next) == WalkabilityView.Cell.UNLOADED
					|| view.allowsShortFrontiers() && (view.cellAt(next.above()) == WalkabilityView.Cell.UNLOADED
					|| view.cellAt(next.below()) == WalkabilityView.Cell.UNLOADED)) return true;
		}
		return false;
	}

	private static List<Neighbor> neighbors(WalkabilityView view, GridPosition current) {
		List<Neighbor> neighbors = new ArrayList<>(CARDINAL_OFFSETS.length);
		if (view.cellAt(current) == WalkabilityView.Cell.CLIMBABLE) {
			for (int dy : new int[]{1, -1}) {
				GridPosition vertical = current.offset(0, dy, 0);
				if (view.isTraversable(vertical)) neighbors.add(new Neighbor(vertical, TraversalType.CLIMB, 16));
			}
		}
		if (view.cellAt(current) == WalkabilityView.Cell.WATER) {
			// Swim straight up or down a flooded column, as a player does with jump held or released.
			for (int dy : new int[]{1, -1}) {
				GridPosition vertical;
				try {
					vertical = current.offset(0, dy, 0);
				} catch (ArithmeticException exception) {
					continue;
				}
				if (view.traversalAt(vertical) == TraversalType.SWIM) {
					neighbors.add(new Neighbor(vertical, TraversalType.SWIM, swimCost(view, vertical)));
				}
			}
		}
		for (int[] offset : CARDINAL_OFFSETS) {
			GridPosition sameLevel;
			try {
				sameLevel = current.offset(offset[0], 0, offset[1]);
			} catch (ArithmeticException exception) {
				continue;
			}
			Neighbor neighbor = resolveNeighbor(view, current, sameLevel);
			if (neighbor != null) {
				neighbors.add(neighbor);
				// A jump over a trench and a drop into it are independent legal edges.
				if (neighbor.traversal() == TraversalType.JUMP_GAP) {
					Neighbor drop = resolveDrop(view, current, sameLevel);
					if (drop != null) neighbors.add(drop);
				}
			}
		}
		double sourceSpeed = neighbors.isEmpty() ? 1.0D : view.movementSpeedMultiplier(current);
		for (int index = 0; index < neighbors.size(); index++) {
			Neighbor edge = neighbors.get(index);
			double targetSpeed = view.movementSpeedMultiplier(edge.position());
			double timeMultiplier = (1.0D / sourceSpeed + 1.0D / targetSpeed) / 2.0D;
			int cost = (int) Math.ceil(edge.cost() * timeMultiplier) + view.exposureCost(edge.position());
			if (edge.traversal() == TraversalType.JUMP_GAP) {
				GridPosition gap = current.offset((edge.position().x() - current.x()) / 2, 0,
						(edge.position().z() - current.z()) / 2);
				cost += view.gapExposureCost(gap);
			}
			neighbors.set(index, new Neighbor(edge.position(), edge.traversal(), cost));
		}
		return neighbors;
	}

	private static Neighbor resolveNeighbor(
			WalkabilityView view,
			GridPosition current,
			GridPosition sameLevel
	) {
		TraversalType traversal = view.traversalAt(sameLevel);
		if (traversal != null) {
			if (traversal == TraversalType.WALK && view.requiresJump(current, sameLevel)) {
				return isClear(view, current.above(2)) && view.canJumpUp(current, sameLevel)
						? new Neighbor(sameLevel, TraversalType.JUMP_UP, JUMP_UP_COST) : null;
			}
			return new Neighbor(sameLevel, traversal, traversal == TraversalType.WALK ? WALK_COST
					: traversal == TraversalType.SWIM ? swimCost(view, sameLevel) : traversal == TraversalType.CROUCH ? 33 : 16);
		}

		GridPosition jumpDestination;
		try {
			jumpDestination = sameLevel.above();
		} catch (ArithmeticException exception) {
			return null;
		}
		// The jump check moves the body through the jump; ask it last, once the landing and headroom already qualify.
		if (view.traversalAt(jumpDestination) == TraversalType.WALK && isClear(view, current.above(2))
				&& view.canJumpUp(current, jumpDestination)) {
			return new Neighbor(jumpDestination, TraversalType.JUMP_UP, JUMP_UP_COST);
		}

		GridPosition gapLanding;
		try {
			int dx = sameLevel.x() - current.x();
			int dz = sameLevel.z() - current.z();
			gapLanding = sameLevel.offset(dx, 0, dz);
		} catch (ArithmeticException exception) {
			return null;
		}
		if (view.canJumpFrom(current) && view.isGapClear(sameLevel)
				&& isClear(view, sameLevel.above())
				&& isClear(view, current.above(2))
				&& view.traversalAt(gapLanding) == TraversalType.WALK
				&& view.canJumpGap(current, gapLanding)) {
			return new Neighbor(gapLanding, TraversalType.JUMP_GAP, JUMP_GAP_COST);
		}

		return resolveDrop(view, current, sameLevel);
	}

	private static Neighbor resolveDrop(WalkabilityView view, GridPosition current, GridPosition sameLevel) {
		for (int drop = 1; drop <= MAX_DROP_BLOCKS; drop++) {
			GridPosition landing;
			try {
				landing = sameLevel.below(drop);
			} catch (ArithmeticException exception) {
				return null;
			}
			TraversalType landingTraversal = view.traversalAt(landing);
			if (landingTraversal == null) {
				continue;
			}
			if (isClearDropShaft(view, landing, current.y())) {
				return new Neighbor(
						landing,
						landingTraversal == TraversalType.SWIM || landingTraversal == TraversalType.CLIMB
								? landingTraversal : TraversalType.DROP_DOWN,
						DROP_BASE_COST + DROP_PER_BLOCK_COST * drop
				);
			}
		}
		return null;
	}

	private static boolean isClearDropShaft(
			WalkabilityView view,
			GridPosition landing,
			int sourceFeetY
	) {
		for (int y = landing.y(); y <= sourceFeetY + 1; y++) {
			if (!isClear(view, new GridPosition(landing.x(), y, landing.z()))) {
				return false;
			}
		}
		return true;
	}

	private static int swimCost(WalkabilityView view, GridPosition position) {
		return view.isSubmerged(position) ? SUBMERGED_SWIM_COST : SURFACE_SWIM_COST;
	}

	private static boolean isStandable(WalkabilityView view, GridPosition position) {
		try {
			return view.isStandable(position);
		} catch (ArithmeticException exception) {
			return false;
		}
	}

	private static boolean isClear(WalkabilityView view, GridPosition position) {
		return view.isBodyClear(position) || view.cellAt(position) == WalkabilityView.Cell.WATER;
	}

	private static long heuristic(WalkabilityView view, GridPosition position, GridPosition destination) {
		long horizontalDistance = absoluteDifference(position.x(), destination.x())
				+ absoluteDifference(position.z(), destination.z());
		long heightDistance = absoluteDifference(position.y(), destination.y());
		// Intentional weighted A*: own-ground cost avoids flooding uniform soul sand. It can
		// overestimate when leaving slow ground; cap the horizontal weight at 1.8 (18 / 10).
		// This bounds the heuristic relative to the ordinary heuristic, not path suboptimality.
		long horizontalCost = Math.min(18L, Math.max(WALK_COST,
				(long) Math.ceil(WALK_COST / view.movementSpeedMultiplier(position))));
		return saturatedAdd(
				saturatedMultiply(horizontalDistance, horizontalCost),
				saturatedMultiply(heightDistance, HEIGHT_HEURISTIC_COST)
		);
	}

	private static PathPlan reconstruct(
			GridPosition start,
			Label destination,
			int expandedNodes
	) {
		LinkedList<PathNode> nodes = new LinkedList<>();
		Set<GridPosition> visited = new HashSet<>();
		Label current = destination;
		while (!current.position.equals(start)) {
			if (!visited.add(current.position) || current.parent == null) {
				return PathPlan.failed(PathOutcome.INVALID, expandedNodes);
			}
			nodes.addFirst(new PathNode(current.position, current.traversal));
			current = current.parent;
		}
		nodes.addFirst(new PathNode(start, TraversalType.START));
		return new PathPlan(nodes, PathOutcome.FOUND, expandedNodes);
	}

	private static long absoluteDifference(int first, int second) {
		return Math.abs((long) first - second);
	}

	private static long saturatedAdd(long first, long second) {
		try {
			return Math.addExact(first, second);
		} catch (ArithmeticException exception) {
			return Long.MAX_VALUE;
		}
	}

	private static long saturatedMultiply(long value, long multiplier) {
		try {
			return Math.multiplyExact(value, multiplier);
		} catch (ArithmeticException exception) {
			return Long.MAX_VALUE;
		}
	}

	private record SearchNode(
			Label label,
			long pathCost,
			long heuristicCost,
			long sequence
	) {
		private SearchNode {
			Objects.requireNonNull(label, "label must not be null");
		}

		private GridPosition position() {
			return label.position;
		}

		private long estimatedTotalCost() {
			return saturatedAdd(pathCost, heuristicCost);
		}
	}

	private record Neighbor(GridPosition position, TraversalType traversal, int cost) {
	}

	/** Mutable limits shared by all path requests admitted during one server tick. */
	public static final class SearchBudget {
		private final int maximumExpandedNodes;
		private final long timeBudgetNanos;
		private final LongSupplier monotonicClock;
		private final long startedAtNanos;
		private int expandedNodes;
		private int preparationWork;
		private boolean exhausted;
		private PathOutcome exhaustionOutcome;

		public SearchBudget(int maximumExpandedNodes, long timeBudgetNanos, LongSupplier monotonicClock) {
			if (maximumExpandedNodes <= 0 || timeBudgetNanos <= 0L || monotonicClock == null) {
				throw new IllegalArgumentException("path search budget must be positive");
			}
			this.maximumExpandedNodes = maximumExpandedNodes;
			this.timeBudgetNanos = timeBudgetNanos;
			this.monotonicClock = monotonicClock;
			this.startedAtNanos = monotonicClock.getAsLong();
		}

		public int maximumExpandedNodes() {
			return maximumExpandedNodes;
		}

		public long timeBudgetNanos() {
			return timeBudgetNanos;
		}

		public int expandedNodes() {
			return expandedNodes;
		}

		public boolean exhausted() {
			return exhausted;
		}

		/** Claims one preparation candidate against the same aggregate limits as expansion. */
		public boolean tryPrepare() {
			if (!tryClaimWork()) return false;
			preparationWork++;
			return true;
		}

		public int preparationWork() { return preparationWork; }

		public PathOutcome exhaustionOutcome() {
			if (!exhausted || exhaustionOutcome == null) {
				throw new IllegalStateException("path search budget is not exhausted");
			}
			return exhaustionOutcome;
		}

		private boolean timeExceeded() {
			if (exhausted) return exhaustionOutcome == PathOutcome.TIME_LIMIT;
			if (monotonicClock.getAsLong() - startedAtNanos < timeBudgetNanos) return false;
			exhausted = true;
			exhaustionOutcome = PathOutcome.TIME_LIMIT;
			return true;
		}

		private boolean tryExpand() {
			if (!tryClaimWork()) return false;
			expandedNodes++;
			return true;
		}

		private boolean tryClaimWork() {
			if (exhausted || timeExceeded()) return false;
			if ((long) expandedNodes + preparationWork >= maximumExpandedNodes) {
				exhausted = true;
				exhaustionOutcome = PathOutcome.NODE_LIMIT;
				return false;
			}
			return true;
		}
	}
}
