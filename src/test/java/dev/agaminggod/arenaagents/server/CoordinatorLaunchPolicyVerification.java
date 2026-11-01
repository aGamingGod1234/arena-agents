package dev.agaminggod.arenaagents.server;

public final class CoordinatorLaunchPolicyVerification {
	private static int assertions;

	private CoordinatorLaunchPolicyVerification() {
	}

	public static int verify() {
		assertions = 0;
		long createdAt = 10_000L;
		assertTrue(CoordinatorLaunchPolicy.shouldStart(false, false, createdAt, createdAt), "owned coordinator starts without an artificial delay");
		assertFalse(CoordinatorLaunchPolicy.shouldStart(true, false, createdAt, createdAt + 5_000L), "authenticated coordinator is reused");
		assertFalse(CoordinatorLaunchPolicy.shouldStart(false, true, createdAt, createdAt + 5_000L), "live owned coordinator is retained");
		assertTrue(CoordinatorLaunchPolicy.shouldStart(false, false, createdAt, createdAt + CoordinatorLaunchPolicy.STARTUP_GRACE_MS), "missing coordinator starts immediately");
		CoordinatorLaunchPolicy.RestartBudget budget = new CoordinatorLaunchPolicy.RestartBudget();
		long[] expectedDelays = {1_000L, 2_000L, 5_000L, 15_000L, 30_000L, 30_000L, 30_000L, 30_000L};
		long now = createdAt;
		for (int crash = 0; crash < expectedDelays.length; crash++) {
			assertTrue(budget.recordUnexpectedExit(now), "coordinator crash " + (crash + 1) + " remains restartable");
			assertEquals(expectedDelays[crash], budget.nextDelayMs(),
					"coordinator crash " + (crash + 1) + " uses the capped retry delay");
			now += budget.nextDelayMs();
		}
		budget.resetAfterStability();
		assertTrue(budget.recordUnexpectedExit(now), "authenticated stability resets crash-loop history");
		assertEquals(1_000L, budget.nextDelayMs(), "stable reset uses the first delay");
		verifyFiniteBudget();
		return assertions;
	}

	/** A crash loop spends the budget; exits spread wider than the window, or a stable run between them, do not. */
	private static void verifyFiniteBudget() {
		int max = CoordinatorLaunchPolicy.MAX_UNEXPECTED_EXITS;
		long window = CoordinatorLaunchPolicy.RESTART_WINDOW_MS;
		assertEquals(10L, max, "ten unexpected exits spend the budget");
		assertEquals(600_000L, window, "within a ten-minute sliding window");
		CoordinatorLaunchPolicy.RestartBudget loop = new CoordinatorLaunchPolicy.RestartBudget();
		long now = 0L;
		for (int exit = 1; exit < max; exit++) {
			assertTrue(loop.recordUnexpectedExit(now), "exit " + exit + " of a crash loop is still restarted");
			now += loop.nextDelayMs();
		}
		assertFalse(loop.exhausted(), "nine exits leave the budget unspent");
		assertFalse(loop.recordUnexpectedExit(now), "the tenth exit within the window spends the budget");
		assertTrue(loop.exhausted(), "the spent budget is reported");
		assertEquals(CoordinatorLaunchPolicy.EXHAUSTED_RETRY_MS, loop.nextDelayMs(), "a spent budget waits the slow probe interval");
		assertFalse(loop.recordUnexpectedExit(now + 10L * window), "a spent budget stays spent across a failed probe, however late");
		assertEquals(CoordinatorLaunchPolicy.EXHAUSTED_RETRY_MS, loop.nextDelayMs(), "and keeps the slow probe interval");
		loop.resetAfterStability();
		assertFalse(loop.exhausted(), "a stable probe earns back the budget");
		assertTrue(loop.recordUnexpectedExit(now), "the first exit after a stable run restarts");
		assertEquals(1_000L, loop.nextDelayMs(), "with the first fast delay");

		// Exits 66.7 s apart put at most nine in any window, so old exits slide out and the budget is never spent.
		CoordinatorLaunchPolicy.RestartBudget sparse = new CoordinatorLaunchPolicy.RestartBudget();
		boolean restartable = true;
		long spacing = window / (max - 1) + 1L;
		for (int exit = 0; exit < 100; exit++) restartable &= sparse.recordUnexpectedExit(exit * spacing);
		assertTrue(restartable && !sparse.exhausted(), "exits spaced wider than the window allows never spend the budget");
		assertEquals(30_000L, sparse.nextDelayMs(), "and keep the capped 30 s delay");
		assertEquals(30_000L, CoordinatorLaunchPolicy.restartDelayMs(Integer.MAX_VALUE), "the shared delay stays capped for any count");
	}

	private static void assertEquals(long expected, long actual, String label) {
		if (expected != actual) throw new AssertionError(label + ": expected=" + expected + ", actual=" + actual);
		assertions++;
	}

	private static void assertTrue(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
		assertions++;
	}

	private static void assertFalse(boolean condition, String label) {
		assertTrue(!condition, label);
	}
}
