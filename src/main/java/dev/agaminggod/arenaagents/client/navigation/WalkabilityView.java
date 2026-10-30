package dev.agaminggod.arenaagents.client.navigation;

import java.util.Objects;
import java.util.Set;

@FunctionalInterface
public interface WalkabilityView {
	Cell cellAt(GridPosition position);

	/** Navigation over acquired terrain may stop at a nearby sight boundary. Other searches keep their existing span. */
	default boolean allowsShortFrontiers() { return false; }

	/** Relative grounded movement speed. Exposure penalties must never enter ETAs or stall windows. */
	default double movementSpeedMultiplier(GridPosition position) { return 1.0D; }

	default boolean canJumpFrom(GridPosition position) { return true; }

	/** Whether a body can jump from {@code from} up onto {@code to}; views that know support heights check the real rise. */
	default boolean canJumpUp(GridPosition from, GridPosition to) { return canJumpFrom(from); }

	/** Whether the full airborne body can cross a gap and settle on its landing. */
	default boolean canJumpGap(GridPosition from, GridPosition to) { return canJumpFrom(from); }

	/** Fractional support surfaces can require a jump even when their grid feet cells have the same Y. */
	default boolean requiresJump(GridPosition from, GridPosition to) { return false; }

	default boolean isGapClear(GridPosition position) { return isBodyClear(position) || cellAt(position) == Cell.WATER; }

	default int exposureCost(GridPosition position) { return 0; }

	/** A cell whose block moves the body to another dimension the moment it touches it (an End portal or gateway). */
	default boolean teleportsOnContact(GridPosition position) { return false; }

	/**
	 * Portal cells the current move targets, entered as a player steps onto the portal: each is an arrival, and a step
	 * into one is a walk (the End portal pool has no floor; the body never reaches what lies under it).
	 */
	default Set<GridPosition> portalEntries() { return Set.of(); }

	/**
	 * Known lava level with the feet or head beside this cell, or over its head: lava spreads into the open cell next, so
	 * a body stepping there walks into the flow. Views without block states know no lava flow.
	 */
	default boolean lavaFlowsInto(GridPosition position) { return false; }

	/**
	 * Known lava that vanilla's spread puts into this open cell next (narrower than {@link #lavaFlowsInto}, which also
	 * counts lava that falls away or has no level left to spread): the cell a move must not enter. Defaults to it.
	 */
	default boolean lavaFillsNext(GridPosition position) { return lavaFlowsInto(position); }

	/** A one-cell gap can be jumped, but landing failure over hazards or a deep drop is more costly. */
	default int gapExposureCost(GridPosition gap) {
		if (cellAt(gap) == Cell.HAZARD) return 40;
		for (int depth = 1; depth <= LocalPathfinder.MAX_DROP_BLOCKS + 1; depth++) {
			Cell below = cellAt(gap.below(depth));
			if (below == Cell.HAZARD) return 40;
			if (below == Cell.UNLOADED) return 40;
			if (below == Cell.SAFE_SUPPORT || below == Cell.WATER) return 0;
		}
		return 40;
	}

	default TraversalType traversalAt(GridPosition position) {
		if (isStandable(position) || portalEntries().contains(position)) return TraversalType.WALK;
		// A player swims at the surface (head in air) and fully submerged (head in water); breath bounds the latter.
		if (cellAt(position) == Cell.WATER
				&& (isBodyClear(position.above()) || cellAt(position.above()) == Cell.WATER)) return TraversalType.SWIM;
		if (cellAt(position) == Cell.CLIMBABLE && isBodyClear(position.above())) return TraversalType.CLIMB;
		return null;
	}

	/** Feet and head both in water: the eyes are under water and air drains while the body is here. */
	default boolean isSubmerged(GridPosition position) {
		return cellAt(position) == Cell.WATER && cellAt(position.above()) == Cell.WATER;
	}

	default boolean isBodyClear(GridPosition position) {
		Cell cell = cellAt(position);
		return cell == Cell.CLEAR || cell == Cell.CLIMBABLE;
	}

	default boolean isTraversable(GridPosition position) {
		return traversalAt(position) != null;
	}

	default boolean isStandable(GridPosition feetPosition) {
		Objects.requireNonNull(feetPosition, "feetPosition must not be null");
		return isBodyClear(feetPosition)
				&& isBodyClear(feetPosition.above())
				&& cellAt(feetPosition.below()) == Cell.SAFE_SUPPORT;
	}

	enum Cell {
		UNLOADED,
		CLEAR,
		WATER,
		CLIMBABLE,
		SAFE_SUPPORT,
		BLOCKED,
		HAZARD
	}
}
