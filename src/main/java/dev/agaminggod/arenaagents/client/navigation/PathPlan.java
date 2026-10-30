package dev.agaminggod.arenaagents.client.navigation;

import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

public record PathPlan(List<PathNode> nodes, PathOutcome outcome, int expandedNodes) {
	public PathPlan {
		nodes = List.copyOf(Objects.requireNonNull(nodes, "nodes must not be null"));
		outcome = Objects.requireNonNull(outcome, "outcome must not be null");
		if (expandedNodes < 0) {
			throw new IllegalArgumentException("expandedNodes must not be negative");
		}
		if (outcome == PathOutcome.FOUND) {
			validateFoundPath(nodes);
		} else if (!nodes.isEmpty()) {
			throw new IllegalArgumentException("non-found path plans must not contain nodes");
		}
	}

	/** Estimate travel only, excluding exposure penalties and server planning time. */
	public double estimatedTravelSeconds(WalkabilityView view, boolean sprint) {
		double seconds = 0.0D;
		for (int index = 1; index < nodes.size(); index++) {
			GridPosition from = nodes.get(index - 1).position();
			PathNode next = nodes.get(index);
			GridPosition to = next.position();
			double distance = Math.sqrt(Math.pow((double) to.x() - from.x(), 2)
					+ Math.pow((double) to.z() - from.z(), 2));
			double inverseSpeed = (1.0D / view.movementSpeedMultiplier(from) + 1.0D / view.movementSpeedMultiplier(to)) / 2.0D;
			seconds += switch (next.traversal()) {
				case CLIMB -> Math.abs(to.y() - from.y()) / 2.0D + distance / 2.0D;
				case SWIM -> Math.sqrt(distance * distance + Math.pow((double) to.y() - from.y(), 2)) / 2.0D;
				case CROUCH -> MovementCosts.seconds(distance, 0.3D / inverseSpeed, false);
				case JUMP_UP, JUMP_GAP -> Math.max(0.6D, MovementCosts.seconds(distance, 1.0D / inverseSpeed, sprint));
				case DROP_DOWN -> Math.max(Math.sqrt(2.0D * (from.y() - to.y()) / 0.08D) / 20.0D,
						MovementCosts.seconds(distance, 1.0D / inverseSpeed, sprint));
				default -> MovementCosts.seconds(distance, 1.0D / inverseSpeed, sprint);
			};
		}
		return seconds;
	}

	public static PathPlan failed(PathOutcome outcome, int expandedNodes) {
		if (outcome == PathOutcome.FOUND) {
			throw new IllegalArgumentException("failed plan outcome must not be FOUND");
		}
		return new PathPlan(List.of(), outcome, expandedNodes);
	}

	private static void validateFoundPath(List<PathNode> nodes) {
		if (nodes.isEmpty()) {
			throw new IllegalArgumentException("found path plans must contain at least one node");
		}
		if (nodes.getFirst().traversal() != TraversalType.START) {
			throw new IllegalArgumentException("the first path node must use START traversal");
		}
		Set<GridPosition> positions = new HashSet<>(nodes.size());
		for (int index = 0; index < nodes.size(); index++) {
			PathNode node = nodes.get(index);
			if (index > 0 && node.traversal() == TraversalType.START) {
				throw new IllegalArgumentException("only the first path node may use START traversal");
			}
			if (!positions.add(node.position())) {
				throw new IllegalArgumentException("path must not contain a cycle");
			}
		}
	}
}
