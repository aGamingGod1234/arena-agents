package dev.agaminggod.arenaagents.server;

import java.io.IOException;
import java.util.concurrent.atomic.AtomicInteger;

/** Exercises the real drain loop without loading the Windows kernel library. */
public final class WindowsCoordinatorJobDrainVerification {
	private WindowsCoordinatorJobDrainVerification() {
	}

	public static void main(String[] args) throws Exception {
		System.out.println("PASS: " + verify() + " Windows job drain assertions");
	}

	public static int verify() throws Exception {
		AtomicInteger queries = new AtomicInteger();
		WindowsCoordinatorJob.awaitDrained(() -> { queries.incrementAndGet(); return 0L; }, 0L);
		check(queries.get() == 1, "an empty job completes after one observation");

		queries.set(0);
		WindowsCoordinatorJob.awaitDrained(() -> Math.max(0, 2 - queries.getAndIncrement()), WindowsCoordinatorJob.DRAIN_TIMEOUT_MS);
		check(queries.get() == 3, "the drain waits until the last active process leaves");

		IOException queryFailure = new IOException("query failed");
		try {
			WindowsCoordinatorJob.awaitDrained(() -> { throw queryFailure; }, 1_000L);
			throw new AssertionError("query failure cannot report a completed stop");
		} catch (IOException failure) {
			check(failure == queryFailure, "the original query failure survives");
		}

		queries.set(0);
		try {
			WindowsCoordinatorJob.awaitDrained(() -> { queries.incrementAndGet(); return 1L; }, 0L);
			throw new AssertionError("an undrained job cannot report a completed stop");
		} catch (IOException failure) {
			check(failure.getMessage().contains("1 coordinator job process"), "timeout identifies the remaining process count");
			check(queries.get() == 1, "an expired deadline does not start another polling interval");
		}

		Thread.currentThread().interrupt();
		try {
			WindowsCoordinatorJob.awaitDrained(() -> 1L, WindowsCoordinatorJob.DRAIN_TIMEOUT_MS);
			throw new AssertionError("interruption cannot report a completed stop");
		} catch (IOException failure) {
			check(failure.getCause() instanceof InterruptedException, "interruption remains the failure cause");
			check(Thread.currentThread().isInterrupted(), "interruption remains set for the caller");
		} finally {
			Thread.interrupted();
		}
		check(!Thread.currentThread().isInterrupted(), "the fixture restores the test thread");
		return 8;
	}

	private static void check(boolean value, String message) {
		if (!value) throw new AssertionError(message);
	}
}
