package dev.agaminggod.arenaagents.server;

import dev.agaminggod.arenaagents.control.AgentControlRedaction;
import dev.agaminggod.arenaagents.control.AgentControlSnapshot;
import java.util.List;

/** Exercises the runtime failure message through the console snapshot contract. */
public final class CoordinatorExhaustedStatusSnapshotVerification {
	private CoordinatorExhaustedStatusSnapshotVerification() {
	}

	public static void main(String[] arguments) throws Exception {
		System.out.println("PASS: " + verify() + " exhausted status snapshot assertions");
	}

	public static int verify() throws Exception {
		var statusMethod = Class.forName("dev.agaminggod.arenaagents.server.CodexAgentServerRuntime")
				.getDeclaredMethod("startupFailureStatus", String.class);
		statusMethod.setAccessible(true);
		String status = (String) statusMethod.invoke(null, "COORDINATOR_RESTART_EXHAUSTED");
		int assertions = 0;
		for (boolean canControl : List.of(false, true)) {
			// Match the publisher: construction must succeed before redaction can bound fields.
			AgentControlSnapshot snapshot = AgentControlRedaction.forViewer(AgentControlSnapshot.fromRecords(
					canControl, false, status, 1L, List.of(), List.of(), List.of(), List.of(), ignored -> false));
			assertTrue(snapshot.automationStatus().equals(status), "the complete failure status survives publication");
			assertTrue(!snapshot.automationAvailable(), "exhausted coordinator remains unavailable");
			assertTrue(snapshot.canControl() == canControl, "viewer permissions survive publication");
			assertions += 3;
		}
		assertTrue(status.contains(CoordinatorLaunchPolicy.EXHAUSTED_RETRY_MS / 60_000L + " minutes"),
				"status explains the current slow retry interval");
		assertTrue(status.contains("coordinator error log"), "status points to diagnostic logs");
		assertTrue(status.contains("runtime/config") && status.contains("restart Minecraft"),
				"status retains recovery guidance");
		return assertions + 3;
	}

	private static void assertTrue(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
