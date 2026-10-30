package dev.agaminggod.arenaagents.server.runtime;

/**
 * Tracks elapsed duration across wall-clock rollback and saturates timestamp overflow. While an action ticks inside
 * {@link #pausedFor}, every accumulator reads the clock minus the time that action spent paused under a reflex firing,
 * so its timeouts, stall limits and reported durations count only the time it actually ran.
 */
public final class ElapsedTimeAccumulator {
	private static final ThreadLocal<long[]> PAUSED = ThreadLocal.withInitial(() -> new long[1]);

	private long previousTimeMs;
	private long elapsedMs;

	public ElapsedTimeAccumulator(long initialTimeMs) {
		this.previousTimeMs = initialTimeMs - PAUSED.get()[0];
	}

	/** Sets the paused time the current thread's accumulators skip; returns the previous value to restore. */
	public static long pausedFor(long pausedMs) {
		long[] holder = PAUSED.get();
		long previous = holder[0];
		holder[0] = Math.max(0L, pausedMs);
		return previous;
	}

	public long advance(long currentTimeMs) {
		currentTimeMs -= PAUSED.get()[0];
		long delta = positiveDifference(currentTimeMs, previousTimeMs);
		previousTimeMs = currentTimeMs;
		elapsedMs = saturatingAdd(elapsedMs, delta);
		return elapsedMs;
	}

	public long elapsedMs() {
		return elapsedMs;
	}

	static long positiveDifference(long current, long previous) {
		if (current <= previous) return 0L;
		try {
			return Math.subtractExact(current, previous);
		} catch (ArithmeticException overflow) {
			return Long.MAX_VALUE;
		}
	}

	private static long saturatingAdd(long left, long right) {
		return left > Long.MAX_VALUE - right ? Long.MAX_VALUE : left + right;
	}
}
