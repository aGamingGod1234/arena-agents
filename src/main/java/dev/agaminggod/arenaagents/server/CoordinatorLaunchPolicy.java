package dev.agaminggod.arenaagents.server;

/** Starts the owned coordinator immediately and keeps bounded retry delays after failures. */
public final class CoordinatorLaunchPolicy {
	public static final long STARTUP_GRACE_MS = 0L;
	private static final long[] RESTART_DELAYS_MS = {1_000L, 2_000L, 5_000L, 15_000L, 30_000L};
	/** Unexpected exits within {@link #RESTART_WINDOW_MS} that spend the restart budget: a crash loop, not a passing fault. */
	public static final int MAX_UNEXPECTED_EXITS = 10;
	public static final long RESTART_WINDOW_MS = 10L * 60_000L;
	/**
	 * Once the budget is spent, one probe launch per this interval instead of one every 30 s. Recovery is never latched
	 * (see the coordinator recovery design): a probe that stays up resets the budget, as does a runtime or config change.
	 */
	public static final long EXHAUSTED_RETRY_MS = 10L * 60_000L;

	private CoordinatorLaunchPolicy() {
	}

	public static boolean shouldStart(boolean bridgeAuthenticated, boolean ownedProcessAlive, long createdAtEpochMs, long nowEpochMs) {
		return !bridgeAuthenticated && !ownedProcessAlive && nowEpochMs - createdAtEpochMs >= STARTUP_GRACE_MS;
	}

	/** The capped delay before retry number {@code failures} (1 or more): 1, 2, 5, 15, then 30 s. */
	public static long restartDelayMs(int failures) {
		if (failures < 1) throw new IllegalArgumentException("failures must be at least 1");
		return RESTART_DELAYS_MS[Math.min(failures, RESTART_DELAYS_MS.length) - 1];
	}

	/** Capped restart state for one server startup episode. */
	public static final class RestartBudget {
		private final java.util.ArrayDeque<Long> recentExits = new java.util.ArrayDeque<>();
		private int restartCount;
		private boolean exhausted;

		/**
		 * Records one unexpected exit at {@code nowEpochMs}. Returns false once {@link #MAX_UNEXPECTED_EXITS} of them fall
		 * within {@link #RESTART_WINDOW_MS}; the budget then stays spent until {@link #resetAfterStability()}.
		 */
		public boolean recordUnexpectedExit(long nowEpochMs) {
			if (restartCount < Integer.MAX_VALUE) restartCount++;
			if (exhausted) return false;
			recentExits.addLast(nowEpochMs);
			while (nowEpochMs - recentExits.peekFirst() >= RESTART_WINDOW_MS) recentExits.removeFirst();
			exhausted = recentExits.size() >= MAX_UNEXPECTED_EXITS;
			if (exhausted) recentExits.clear();
			return !exhausted;
		}

		public long nextDelayMs() {
			if (restartCount < 1) {
				throw new IllegalStateException("No coordinator restart is pending");
			}
			return exhausted ? EXHAUSTED_RETRY_MS : restartDelayMs(restartCount);
		}

		public int restartCount() {
			return restartCount;
		}

		/** Whether the fast restarts are spent and only the slow probe remains. */
		public boolean exhausted() {
			return exhausted;
		}

		public void resetAfterStability() {
			restartCount = 0;
			exhausted = false;
			recentExits.clear();
		}

		/** Kept for source compatibility; supervisors call this only after authenticated stability. */
		public void resetAfterAuthentication() {
			resetAfterStability();
		}
	}
}
