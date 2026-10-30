package dev.agaminggod.arenaagents.server.runtime.controller;

/** Route-level stop rules: each stop needs demonstrated lack of progress on the body, never elapsed time alone. */
public final class RouteProgressVerification {
	private static final double TX = 60.0D, TY = 64.0D, TZ = 0.0D;
	private static int assertions;

	private RouteProgressVerification() {
	}

	public static int verify() {
		assertions = 0;
		verifyStraightWalk();
		verifyStandingStill();
		verifyWalkingAway();
		verifyWallDetourSucceeds();
		verifyCircling();
		verifyStallReplan();
		verifyFacts();
		verifySwimColumn();
		verifyUnknownContinuation();
		verifyAcceptedRouteProgress();
		verifySlowProgress();
		return assertions;
	}

	private static double remaining(double x, double y, double z) {
		return Math.sqrt((x - TX) * (x - TX) + (y - TY) * (y - TY) + (z - TZ) * (z - TZ));
	}

	/** Walks straight from (x0,z0) to (x1,z1) at sprint pace, one 50 ms tick per 0.28 blocks; returns the first stop. */
	private static RouteProgress.Stop walk(RouteProgress route, double[] at, double x1, double z1, long[] clock) {
		double dx = x1 - at[0], dz = z1 - at[1];
		int steps = (int) Math.ceil(Math.hypot(dx, dz) / 0.28D);
		double x0 = at[0], z0 = at[1];
		for (int i = 1; i <= steps; i++) {
			double x = x0 + dx * i / steps, z = z0 + dz * i / steps;
			clock[0] += 50L;
			at[0] = x;
			at[1] = z;
			RouteProgress.Stop stop = route.observe(x, TY, z, remaining(x, TY, z), clock[0], false);
			if (stop != null) return stop;
		}
		return null;
	}

	private static void verifyStraightWalk() {
		RouteProgress route = new RouteProgress(0.0D, TY, 0.0D, remaining(0.0D, TY, 0.0D), 0L);
		double[] at = {0.0D, 0.0D};
		assertTrue(walk(route, at, 59.0D, 0.0D, new long[] {0L}) == null, "a converging walk never stops");
	}

	private static void verifyStandingStill() {
		RouteProgress route = new RouteProgress(0.0D, TY, 0.0D, 60.0D, 0L);
		RouteProgress.Stop stop = null;
		for (long ms = 50L; ms < RouteProgress.STILL_MS; ms += 50L) stop = route.observe(0.2D, TY, 0.1D, 60.0D, ms, false);
		assertTrue(stop == null, "standing still under eight seconds is not yet evidence");
		stop = route.observe(0.2D, TY, 0.1D, 60.0D, RouteProgress.STILL_MS, false);
		assertTrue(stop != null && stop.kind() == RouteProgress.Kind.STILL, "eight seconds without moving a block stops");
		assertTrue(stop.message().contains("0.0,64.0,0.0"), "the still stop names where the body stood: " + stop.message());
		RouteProgress breathing = new RouteProgress(0.0D, TY, 0.0D, 60.0D, 0L);
		for (long ms = 50L; ms <= 20_000L; ms += 50L) stop = breathing.observe(0.0D, TY, 0.0D, 60.0D, ms, true);
		assertTrue(stop == null, "waiting for breath before a dive is not standing still");
		RouteProgress fidget = new RouteProgress(0.0D, TY, 0.0D, 60.0D, 0L);
		stop = null;
		for (long ms = 50L; ms <= 60_000L && stop == null; ms += 50L) {
			double x = (ms / 2_000L) % 2L == 0L ? 0.0D : 1.5D;
			stop = fidget.observe(x, TY, 0.0D, 60.0D, ms, false);
		}
		assertTrue(stop != null, "rocking between two spots without getting closer still ends (as a revisit or as no gain)");
	}

	private static void verifyWalkingAway() {
		RouteProgress route = new RouteProgress(0.0D, TY, 0.0D, remaining(0.0D, TY, 0.0D), 0L);
		double[] at = {0.0D, 0.0D};
		long[] clock = {0L};
		assertTrue(walk(route, at, 30.0D, 0.0D, clock) == null, "approach to 30 blocks out");
		// Best is 30: allowance 2 * 30 + 32 = 92 blocks of walking without a gain.
		RouteProgress.Stop stop = walk(route, at, 30.0D, 200.0D, clock);
		assertTrue(stop != null && stop.kind() == RouteProgress.Kind.NOT_CONVERGING, "walking off sideways forever stops");
		assertTrue(at[1] >= 91.0D && at[1] <= 93.5D, "the stop comes at the detour allowance, not before: " + at[1]);
	}

	private static void verifyWallDetourSucceeds() {
		// Wall at x = 19 from z = -100 to 40, destination 60 away: approach, 40 along the wall, through the gap, then in.
		RouteProgress route = new RouteProgress(0.0D, TY, 0.0D, remaining(0.0D, TY, 0.0D), 0L);
		double[] at = {0.0D, 0.0D};
		long[] clock = {0L};
		assertTrue(walk(route, at, 18.0D, 0.0D, clock) == null, "approach the wall");
		assertTrue(walk(route, at, 18.0D, 41.0D, clock) == null, "walk 41 blocks along the wall");
		assertTrue(walk(route, at, 21.0D, 41.0D, clock) == null, "through the gap");
		assertTrue(walk(route, at, 59.0D, 0.0D, clock) == null, "a real detour reaches the destination without a stop");
		// A U-shaped bay: 40 in, 30 across the closed end, 40 back out, then around.
		RouteProgress bay = new RouteProgress(0.0D, TY, 0.0D, remaining(0.0D, TY, 0.0D), 0L);
		double[] bayAt = {0.0D, 0.0D};
		long[] bayClock = {0L};
		assertTrue(walk(bay, bayAt, 40.0D, 0.0D, bayClock) == null
				&& walk(bay, bayAt, 40.0D, 30.0D, bayClock) == null
				&& walk(bay, bayAt, 0.0D, 30.0D, bayClock) == null, "walking out of a dead-end bay is within the allowance");
	}

	private static void verifyCircling() {
		RouteProgress route = new RouteProgress(0.0D, TY, 0.0D, remaining(0.0D, TY, 0.0D), 0L);
		double[] at = {0.0D, 0.0D};
		long[] clock = {0L};
		assertTrue(walk(route, at, 20.0D, 0.0D, clock) == null, "approach");
		RouteProgress.Stop stop = walk(route, at, 20.0D, 6.0D, clock);
		if (stop == null) stop = walk(route, at, 14.0D, 6.0D, clock);
		if (stop == null) stop = walk(route, at, 14.0D, -6.0D, clock);
		if (stop == null) stop = walk(route, at, 20.0D, -6.0D, clock);
		if (stop == null) stop = walk(route, at, 20.0D, 0.0D, clock);
		assertTrue(stop != null && stop.kind() == RouteProgress.Kind.CIRCLING, "walking a loop back onto its own track stops");
		assertTrue(stop.message().contains("Back at 20,64,"), "the circling stop names the revisited place: " + stop.message());
		RouteProgress stairs = new RouteProgress(0.0D, TY, 0.0D, 60.0D, 0L);
		RouteProgress.Stop climb = null;
		long ms = 0L;
		double walked = 0.0D;
		for (int lap = 0; lap < 12 && climb == null; lap++) {
			for (int side = 0; side < 4 && climb == null; side++) {
				for (int i = 0; i < 10 && climb == null; i++) {
					ms += 50L;
					walked += 0.3D;
					double x = side == 0 ? i * 0.3D : side == 1 ? 3.0D : side == 2 ? 3.0D - i * 0.3D : 0.0D;
					double z = side == 1 ? i * 0.3D : side == 2 ? 3.0D : side == 3 ? 3.0D - i * 0.3D : 0.0D;
					double y = TY - walked / 4.0D;
					climb = stairs.observe(x, y, z, 70.0D - walked / 4.0D, ms, false);
				}
			}
		}
		assertTrue(climb == null, "a spiral staircase that keeps getting closer in height is not circling");
	}

	private static void verifyStallReplan() {
		RouteProgress route = new RouteProgress(0.0D, TY, 0.0D, 10.0D, 0L);
		assertTrue(!route.noGainSinceStallReplan(), "no stall replan yet");
		route.observe(1.0D, TY, 0.0D, 9.0D, 50L, false);
		route.stallReplanned();
		route.observe(1.1D, TY, 0.0D, 8.9D, 100L, false);
		assertTrue(!route.noGainSinceStallReplan(), "even a small measured gain distinguishes advancement after a stall");
		route.observe(3.0D, TY, 0.0D, 7.0D, 150L, false);
		assertTrue(!route.noGainSinceStallReplan(), "getting closer after the replan earns another one");
	}

	private static void verifyFacts() {
		RouteProgress instant = new RouteProgress(0.0D, TY, 0.0D, 60.0D, 0L);
		assertEquals("", instant.facts(60.0D), "an instant refusal adds no travel facts");
		RouteProgress moved = new RouteProgress(0.0D, TY, 0.0D, remaining(0.0D, TY, 0.0D), 0L);
		double[] at = {0.0D, 0.0D};
		walk(moved, at, 20.0D, 0.0D, new long[] {0L});
		String facts = moved.facts(40.0D);
		assertTrue(facts.contains("walked 20") && facts.contains("left 40.0")
				&& facts.contains("closest 40.0 at 20,64,0"), "travel facts: " + facts);
		moved.observe(20.2D, TY, 0.0D, 39.8D, 4_000L, false);
		assertTrue(moved.facts(39.8D).contains("closest 39.8 at 20,64,0"), "closest reports sub-threshold gains truthfully");
	}

	private static void verifySwimColumn() {
		var origin = new dev.agaminggod.arenaagents.client.navigation.GridPosition(4, 62, 9);
		assertTrue(ServerNavigationController.sameSwimColumn(origin, origin.offset(0, 1, 0))
				&& ServerNavigationController.sameSwimColumn(origin, origin.offset(0, -1, 0)), "bobbing one block at the surface is the same place");
		assertTrue(!ServerNavigationController.sameSwimColumn(origin, origin.offset(1, 0, 0))
				&& !ServerNavigationController.sameSwimColumn(origin, origin.offset(0, 2, 0)), "drifting sideways or sinking two blocks is a new origin");
	}

	private static void verifyUnknownContinuation() {
		NavigationContinuation continuation = new NavigationContinuation();
		var body = new net.minecraft.world.phys.Vec3(3.5D, 64D, 0.5D);
		continuation.searching();
		assertTrue(continuation.replans() == 0, "initial search is not a replan");
		assertTrue(!continuation.exhausted(body, 0L), "first missing continuation waits for observation");
		assertTrue(continuation.waiting(249L) && !continuation.waiting(250L), "replans leave time for fresh sight");
		assertTrue(continuation.stableAt(body), "repeated stop can establish stable near footing");
		continuation.searching();
		assertTrue(!continuation.exhausted(body, 250L), "second missing continuation still retries");
		continuation.searching();
		assertTrue(continuation.exhausted(body, 500L), "three completed empty replans stop");
		assertTrue(continuation.replans() == 2, "receipt counts actual new searches, excluding initial and deferred slices");
		continuation.accepted();
		assertTrue(!continuation.exhausted(body, 750L), "a found continuation resets the empty-search streak");
		assertTrue(!continuation.exhausted(body.add(1D, 0D, 0D), 1000L), "measured body movement resets failures");
		assertTrue(!continuation.exhausted(body.add(1D, 0D, 0D), 1250L), "new stop gets its second recheck");
		assertTrue(continuation.exhausted(body.add(1D, 0D, 0D), 1500L), "new stop is still bounded");
	}

	private static void verifyAcceptedRouteProgress() {
		// Sol's finite detour: the returning leg used to exceed the Euclidean travel allowance.
		RouteProgress route = new RouteProgress(0, 64, 0, 16, 0);
		double[][] corners = {{6.7, 0}, {6.7, 27}, {16, 27}, {16, 0}};
		double pathLeft = 70, x = 0, z = 0;
		long ms = 0;
		route.beginPlan(pathLeft);
		RouteProgress.Stop stop = null;
		for (double[] corner : corners) {
			double x0 = x, z0 = z, length = Math.hypot(corner[0] - x, corner[1] - z);
			int steps = (int) Math.ceil(length / 0.28);
			for (int i = 1; i <= steps; i++) {
				x = x0 + (corner[0] - x0) * i / steps;
				z = z0 + (corner[1] - z0) * i / steps;
				pathLeft -= length / steps;
				ms += 50;
				stop = route.observe(x, 64, z, Math.hypot(16 - x, z), pathLeft, ms, false);
				if (stop != null) break;
			}
			if (stop != null) break;
		}
		assertTrue(stop == null && x == 16 && z == 0, "complete accepted detour advances even on its away-going leg: " + stop);
		RouteProgress stalled = new RouteProgress(0, 64, 0, 16, 0);
		stalled.beginPlan(70);
		stalled.stallReplanned();
		stalled.observe(0, 64, 8, Math.hypot(16, 8), 62, 2000, false);
		assertTrue(!stalled.noGainSinceStallReplan(), "a new blocker eight blocks along a sideways detour is not the previous stall");
		stalled.stallReplanned();
		stalled.beginPlan(20);
		stalled.observe(0, 64, 8, Math.hypot(16, 8), 20, 2050, false);
		assertTrue(stalled.noGainSinceStallReplan(), "replacing a plan without moving earns no progress");
	}

	private static void verifySlowProgress() {
		for (boolean vertical : new boolean[] {false, true}) {
			RouteProgress slow = new RouteProgress(0, 64, 0, 20, 0);
			slow.beginPlan(40);
			RouteProgress.Stop stop = null;
			for (long ms = 50; ms <= 20_000 && stop == null; ms += 50) {
				double advance = 0.1 * ms / 1000;
				stop = slow.observe(vertical ? 0 : advance, vertical ? 64 + advance : 64, 0,
						20 + advance, 40 - advance, ms, false);
			}
			assertTrue(stop == null, "0.1 blocks/s along the route remains progress even away from the goal, vertical=" + vertical);
		}
		RouteProgress slow = new RouteProgress(0, 64, 0, 20, 0);
		RouteProgress.Stop stop = null;
		for (long ms = 50; ms <= 8000 && stop == null; ms += 50) {
			double x = 0.1 * ms / 1000;
			stop = slow.observe(x, 64, 0, 20 - x, ms, false);
		}
		assertTrue(stop == null, "Sol's unchanged slow-progress reproduction advances 0.8 blocks without stopping");
		RouteProgress cuttingCorner = new RouteProgress(0, 64, 0, 20, 0);
		cuttingCorner.beginPlan(40);
		for (long ms = 50; ms <= 8000 && stop == null; ms += 50) {
			double x = 0.1 * ms / 1000;
			stop = cuttingCorner.observe(x, 64, 0, 20 - x, 40 + x, ms, false);
		}
		assertTrue(stop == null, "measured goal gain remains progress even while an active waypoint lies farther away");
	}

	private static void assertTrue(boolean condition, String message) {
		assertions++;
		if (!condition) throw new AssertionError(message);
	}

	private static void assertEquals(Object expected, Object actual, String message) {
		assertions++;
		if (!expected.equals(actual)) throw new AssertionError(message + " (expected=" + expected + ", actual=" + actual + ")");
	}
}
