package dev.agaminggod.arenaagents.server.runtime.controller;

import java.util.ArrayDeque;
import java.util.Deque;

/**
 * Detects a fight approach or flee that keeps pressing forward without getting anywhere: jumping against a wall,
 * bumping a low ceiling, circling in a corner or held by a refused step. Unlike {@link BlockedMoveDetector} a pending
 * jump does not reset it, because jumping into a wall over and over is exactly the stall it must catch. Net ground
 * covered over the window is what counts, so circling in place is a stall too.
 */
final class CombatStallDetector {
	/** Two seconds of pressing forward. */
	static final int WINDOW_TICKS = 40;
	/** Less net movement than this over the window is a stall (sprinting covers about 11 blocks). */
	static final double MIN_PROGRESS_BLOCKS = 1.0D;
	/** Forward must have been wanted for most of the window; a pause to swing or turn is not a stall. */
	static final int MIN_PUSHING_TICKS = 30;

	private final Deque<Sample> samples = new ArrayDeque<>(WINDOW_TICKS + 1);

	private record Sample(double x, double y, double z, boolean grounded, boolean pushing, boolean wall, boolean ceiling) {
	}

	/** What the window saw when it stalled: net metres covered, wall-push ticks and ceiling bumps. */
	record Stall(double metres, int wallTicks, int ceilingBumps) {
	}

	/**
	 * One tick. {@code pushing}: the controller wanted to move forward (even if a safety check withheld the input).
	 * {@code grounded}: standing, swimming or on a ladder, so its height is a real level (mid-jump heights are not).
	 * Returns the stall once the window is full and shows no progress, otherwise null.
	 */
	Stall observe(double x, double y, double z, boolean grounded, boolean pushing, boolean wall, boolean ceiling) {
		if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(z)) {
			reset();
			return null;
		}
		samples.addLast(new Sample(x, y, z, grounded, pushing, wall, ceiling));
		while (samples.size() > WINDOW_TICKS) samples.removeFirst();
		if (samples.size() < WINDOW_TICKS) return null;
		int pushingTicks = 0;
		int wallTicks = 0;
		int ceilingBumps = 0;
		Sample firstGrounded = null;
		Sample lastGrounded = null;
		for (Sample sample : samples) {
			if (sample.pushing()) pushingTicks++;
			if (sample.wall()) wallTicks++;
			if (sample.ceiling()) ceilingBumps++;
			if (sample.grounded()) {
				if (firstGrounded == null) firstGrounded = sample;
				lastGrounded = sample;
			}
		}
		if (pushingTicks < MIN_PUSHING_TICKS) return null;
		Sample first = samples.getFirst();
		Sample last = samples.getLast();
		double horizontal = Math.hypot(last.x() - first.x(), last.z() - first.z());
		// Climbing a ladder or stepping up a stair gains height, not ground; only compare levels that were stood on.
		double vertical = firstGrounded == null || firstGrounded == lastGrounded ? 0.0D : Math.abs(lastGrounded.y() - firstGrounded.y());
		double metres = Math.max(horizontal, vertical);
		return metres < MIN_PROGRESS_BLOCKS ? new Stall(metres, wallTicks, ceilingBumps) : null;
	}

	void reset() {
		samples.clear();
	}
}
