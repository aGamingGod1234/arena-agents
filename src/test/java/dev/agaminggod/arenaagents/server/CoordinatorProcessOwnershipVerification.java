package dev.agaminggod.arenaagents.server;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;
import java.util.Comparator;
import java.util.concurrent.TimeUnit;

/** Verifies that a crashed Minecraft owner cannot leave the bundled coordinator blocking an update. */
public final class CoordinatorProcessOwnershipVerification {
	private static final String GENERATION_A = "a".repeat(64);
	private static final String GENERATION_B = "b".repeat(64);
	private static final String LAUNCH_A = "00000000-0000-0000-0000-000000000101";
	private static final String LAUNCH_B = "00000000-0000-0000-0000-000000000102";
	private static final String LAUNCH_C = "00000000-0000-0000-0000-000000000103";
	private static final CoordinatorProcessOwnership.SupervisorIdentity SUPERVISOR_A =
			new CoordinatorProcessOwnership.SupervisorIdentity("00000000-0000-0000-0000-000000000201");
	private static final CoordinatorProcessOwnership.SupervisorIdentity SUPERVISOR_B =
			new CoordinatorProcessOwnership.SupervisorIdentity("00000000-0000-0000-0000-000000000202");

	private CoordinatorProcessOwnershipVerification() {
	}

	public static void main(String[] arguments) throws Exception {
		System.out.println("PASS: " + verify() + " coordinator ownership assertions");
	}

	public static int verify() throws Exception {
		Path root = Files.createTempDirectory("arena-coordinator-ownership");
		Process orphan = null;
		Process liveOwned = null;
		Process pidReused = null;
		Process legacyOwned = null;
		Process unrelated = null;
		Process staleGeneration = null;
		Process tree = null;
		Process interruptedTree = null;
		try {
			Path main = root.resolve("coordinator/src/dynamic-main.mjs").toAbsolutePath().normalize();
			Files.createDirectories(main.getParent());
			Files.writeString(main, "// ownership fixture", StandardCharsets.UTF_8);
			Path unrelatedMain = root.resolve("unrelated-main.mjs").toAbsolutePath().normalize();
			Files.writeString(unrelatedMain, "// unrelated fixture", StandardCharsets.UTF_8);

			orphan = startSleeper(main);
			CoordinatorProcessOwnership.record(root, orphan, main, GENERATION_A, LAUNCH_A);
			invalidateOwnerProcess(root);
			assertOwnershipIdentity(root, GENERATION_A, LAUNCH_A);
			assertTrue(CoordinatorProcessOwnership.reapOrphaned(root) == 1,
					"a coordinator whose Minecraft owner is gone is reaped even when the active runtime is corrupt");
			assertTrue(orphan.waitFor(5, TimeUnit.SECONDS), "the orphaned coordinator process exits");
			assertTrue(!Files.exists(CoordinatorProcessOwnership.ownershipFile(root)),
					"the stale ownership record is removed");

			liveOwned = startSleeper(main);
			CoordinatorProcessOwnership.record(root, liveOwned, main, GENERATION_A, LAUNCH_A,
					ProcessHandle.current().pid());
			assertTrue(CoordinatorProcessOwnership.reapOrphaned(root, GENERATION_A) == 0,
					"a coordinator with a live Minecraft owner is preserved");
			assertTrue(liveOwned.isAlive(), "the live owner's coordinator remains running");

			int clearAssertions = verifyClearPreservesNewerRecord(root, liveOwned);
			pidReused = startSleeper(main);
			CoordinatorProcessOwnership.record(root, pidReused, main, GENERATION_A, LAUNCH_A);
			invalidateOwnerStartTimestamp(root);
			assertTrue(CoordinatorProcessOwnership.reapOrphaned(root, GENERATION_A) == 1,
					"a reused Minecraft owner PID cannot suppress orphan cleanup when its start identity differs");
			assertTrue(pidReused.waitFor(5, TimeUnit.SECONDS), "the PID-reuse orphaned coordinator exits");

			legacyOwned = startSleeper(main);
			CoordinatorProcessOwnership.record(root, legacyOwned, main, GENERATION_A, LAUNCH_A);
			removeOwnerStartTimestamp(root);
			assertTrue(CoordinatorProcessOwnership.reapOrphaned(root, GENERATION_A) == 0,
					"a legacy ownership record remains compatible with its current Minecraft owner");
			assertTrue(legacyOwned.isAlive(), "legacy ownership keeps the live owner coordinator running");
			invalidateOwnerProcess(root);
			assertTrue(CoordinatorProcessOwnership.reapOrphaned(root, GENERATION_A) == 1,
					"a legacy record with a gone owner enters bounded coordinator cleanup");
			assertTrue(legacyOwned.waitFor(5, TimeUnit.SECONDS), "legacy orphaned coordinator exits");

			unrelated = startSleeper(unrelatedMain);
			CoordinatorProcessOwnership.record(root, unrelated, main, GENERATION_A, LAUNCH_A);
			invalidateOwnerProcess(root);
			invalidateStartTimestamp(root);
			assertTrue(CoordinatorProcessOwnership.reapOrphaned(root, GENERATION_A) == 0,
					"a stale PID with a different coordinator identity is not reaped");
			assertTrue(unrelated.isAlive(), "an unrelated process with the recorded PID survives");

			staleGeneration = startSleeper(main);
			CoordinatorProcessOwnership.record(root, staleGeneration, main, GENERATION_A, LAUNCH_A);
			invalidateOwnerProcess(root);
			assertTrue(CoordinatorProcessOwnership.reapOrphaned(root, GENERATION_B) == 1,
					"a stale-generation record still reaps its exact PID, start time, main, generation, and launch identity");
			assertTrue(staleGeneration.waitFor(5, TimeUnit.SECONDS),
					"the stale-generation exact coordinator exits before ownership clears");
			assertTrue(!Files.exists(CoordinatorProcessOwnership.ownershipFile(root)),
					"only the matching stale-generation ownership record is cleared");

			tree = startTreeSleeper(main);
			CoordinatorProcessOwnership.record(root, tree, main, GENERATION_A, LAUNCH_A);
			invalidateOwnerProcess(root);
			var descendants = tree.toHandle().descendants().toList();
			assertTrue(!descendants.isEmpty(), "ownership fixture creates a child process");
			assertTrue(CoordinatorProcessOwnership.reapOrphaned(root, GENERATION_A) == 1,
					"an orphaned coordinator tree is reaped");
			assertTrue(tree.waitFor(5, TimeUnit.SECONDS), "the orphaned coordinator exits");
			assertTrue(descendants.stream().noneMatch(ProcessHandle::isAlive), "orphaned coordinator children exit");

			interruptedTree = startTreeSleeper(main);
			var interruptedDescendants = interruptedTree.toHandle().descendants().toList();
			Thread.currentThread().interrupt();
			CoordinatorProcessOwnership.terminateTree(interruptedTree.toHandle());
			assertTrue(Thread.interrupted(), "tree termination preserves interruption status");
			assertTrue(interruptedDescendants.stream().noneMatch(ProcessHandle::isAlive),
					"interrupted tree termination still stops every child");
			return 24 + clearAssertions + verifySameJvmSupervisorRestart(root, main) + verifyForeignLiveOwnerIsPreserved(root, main)
					+ verifyConcurrentServerClaimsAdmitOne(root, main)
					+ verifyDelayedReaperKeepsLiveClaim(root, main)
					+ verifyStartupOwnershipRecordFailureCleanup(main)
					+ verifyRefusedProcessTreeTerminationFailsClosed() + verifyDescendantIdentityRejectsPidReuse();
		} finally {
			if (orphan != null && orphan.isAlive()) orphan.destroyForcibly();
			if (liveOwned != null && liveOwned.isAlive()) liveOwned.destroyForcibly();
			if (pidReused != null && pidReused.isAlive()) pidReused.destroyForcibly();
			if (legacyOwned != null && legacyOwned.isAlive()) legacyOwned.destroyForcibly();
			if (unrelated != null && unrelated.isAlive()) unrelated.destroyForcibly();
			if (staleGeneration != null && staleGeneration.isAlive()) staleGeneration.destroyForcibly();
			if (tree != null && tree.isAlive()) tree.destroyForcibly();
			if (interruptedTree != null && interruptedTree.isAlive()) interruptedTree.destroyForcibly();
			deleteTree(root);
		}
	}

	private static int verifySameJvmSupervisorRestart(Path root, Path main) throws Exception {
		Process stale = null;
		Process current = null;
		Process reusedPid = null;
		try {
			stale = startSleeper(main);
			CoordinatorProcessOwnership.record(root, stale, main, GENERATION_A, LAUNCH_A, SUPERVISOR_A);
			assertSupervisorIdentity(root, SUPERVISOR_A);
			assertTrue(CoordinatorProcessOwnership.reapOrphaned(root, SUPERVISOR_B) == 1,
					"a new supervisor in the same JVM reaps the previous supervisor's coordinator");
			assertTrue(stale.waitFor(5, TimeUnit.SECONDS),
					"the previous same-JVM supervisor's coordinator exits");

			current = startSleeper(main);
			CoordinatorProcessOwnership.record(root, current, main, GENERATION_A, LAUNCH_B, SUPERVISOR_B);
			assertTrue(CoordinatorProcessOwnership.reapOrphaned(root, SUPERVISOR_B) == 0,
					"the current supervisor preserves its own coordinator");
			assertTrue(current.isAlive(), "the current supervisor's coordinator remains alive");
			CoordinatorProcessOwnership.clear(root, current, GENERATION_A, LAUNCH_B);

			reusedPid = startSleeper(main);
			CoordinatorProcessOwnership.record(root, reusedPid, main, GENERATION_A, LAUNCH_A, SUPERVISOR_A);
			invalidateStartTimestamp(root);
			assertTrue(CoordinatorProcessOwnership.reapOrphaned(root, SUPERVISOR_B) == 0,
					"a new supervisor does not terminate a reused coordinator PID");
			assertTrue(reusedPid.isAlive(), "the process behind a reused PID remains alive");
			assertTrue(!Files.exists(CoordinatorProcessOwnership.ownershipFile(root)),
					"the stale reused-PID ownership record is cleared");
			return 9;
		} finally {
			if (stale != null && stale.isAlive()) stale.destroyForcibly();
			if (current != null && current.isAlive()) current.destroyForcibly();
			if (reusedPid != null && reusedPid.isAlive()) reusedPid.destroyForcibly();
			Files.deleteIfExists(CoordinatorProcessOwnership.ownershipFile(root));
		}
	}

	/** Two servers sharing a runtime root: a new supervisor must not reap or replace the other live server's coordinator. */
	private static int verifyForeignLiveOwnerIsPreserved(Path root, Path main) throws Exception {
		Process owner = null;
		Process coordinator = null;
		Process second = null;
		try {
			owner = startSleeper(main);
			coordinator = startSleeper(main);
			CoordinatorProcessOwnership.record(root, coordinator, main, GENERATION_A, LAUNCH_A, owner.pid());
			Path ownershipFile = CoordinatorProcessOwnership.ownershipFile(root);
			String recorded = Files.readString(ownershipFile, StandardCharsets.UTF_8);
			assertTrue(CoordinatorProcessOwnership.reapOrphaned(root, SUPERVISOR_B) == 0,
					"a coordinator owned by another live server JVM is not an orphan");
			assertTrue(coordinator.isAlive() && owner.isAlive(), "the other server and its coordinator keep running");
			assertTrue(recorded.equals(Files.readString(ownershipFile, StandardCharsets.UTF_8)),
					"the other server's ownership record is unchanged");

			second = startSleeper(main);
			Process claimant = second;
			boolean conflict = false;
			try {
				CoordinatorProcessOwnership.record(root, claimant, main, GENERATION_A, LAUNCH_B, SUPERVISOR_B);
			} catch (java.io.IOException expected) {
				conflict = true;
			}
			assertTrue(conflict, "a second launch claiming the root reports an ownership conflict");
			assertTrue(recorded.equals(Files.readString(ownershipFile, StandardCharsets.UTF_8)),
					"the conflicting claim does not replace the live owner's record");

			owner.destroyForcibly();
			assertTrue(owner.waitFor(5, TimeUnit.SECONDS), "the other server exits");
			assertTrue(CoordinatorProcessOwnership.reapOrphaned(root, SUPERVISOR_B) == 1,
					"once that server is gone its coordinator is a genuine orphan");
			assertTrue(coordinator.waitFor(5, TimeUnit.SECONDS), "the orphaned coordinator exits");
			return 7;
		} finally {
			if (owner != null && owner.isAlive()) owner.destroyForcibly();
			if (coordinator != null && coordinator.isAlive()) coordinator.destroyForcibly();
			if (second != null && second.isAlive()) second.destroyForcibly();
			Files.deleteIfExists(CoordinatorProcessOwnership.ownershipFile(root));
		}
	}

	/**
	 * Two server JVMs claim the same unclaimed root at once. Each pauses after its ownership check; exactly one claim
	 * may succeed, its record must stay published, and the rejected launch retires its coordinator.
	 */
	private static int verifyConcurrentServerClaimsAdmitOne(Path root, Path main) throws Exception {
		Files.deleteIfExists(CoordinatorProcessOwnership.ownershipFile(root));
		Path signals = Files.createTempDirectory("arena-ownership-claim-race");
		String javaExecutable = Path.of(System.getProperty("java.home"), "bin", isWindows() ? "java.exe" : "java").toString();
		String classPath = java.util.Arrays.stream(System.getProperty("java.class.path").split(java.io.File.pathSeparator))
				.filter(entry -> !entry.isBlank()).map(entry -> Path.of(entry).toAbsolutePath().toString())
				.collect(java.util.stream.Collectors.joining(java.io.File.pathSeparator));
		Process first = null;
		Process second = null;
		try {
			first = new ProcessBuilder(javaExecutable, "-cp", classPath, CoordinatorOwnershipClaimRaceFixture.class.getName(),
					root.toString(), main.toString(), LAUNCH_A, signals.toString(), "first").start();
			second = new ProcessBuilder(javaExecutable, "-cp", classPath, CoordinatorOwnershipClaimRaceFixture.class.getName(),
					root.toString(), main.toString(), LAUNCH_B, signals.toString(), "second").start();
			// Give both claims time to reach the pause. With a cross-JVM lock only one can be inside the claim.
			long deadline = System.currentTimeMillis() + 3_000L;
			while (System.currentTimeMillis() < deadline
					&& !(Files.exists(signals.resolve("first.reached")) && Files.exists(signals.resolve("second.reached")))) {
				Thread.sleep(20L);
			}
			Files.writeString(signals.resolve("release"), "go", StandardCharsets.UTF_8);
			deadline = System.currentTimeMillis() + 30_000L;
			while (System.currentTimeMillis() < deadline
					&& !(Files.exists(signals.resolve("first.outcome")) && Files.exists(signals.resolve("second.outcome")))) {
				Thread.sleep(20L);
			}
			String firstOutcome = Files.readString(signals.resolve("first.outcome"), StandardCharsets.UTF_8);
			String secondOutcome = Files.readString(signals.resolve("second.outcome"), StandardCharsets.UTF_8);
			boolean firstWon = firstOutcome.startsWith("CLAIMED");
			assertTrue(firstWon != secondOutcome.startsWith("CLAIMED"),
					"exactly one concurrent server claim succeeds: " + firstOutcome + " / " + secondOutcome);
			Process winner = firstWon ? first : second;
			String loserOutcome = firstWon ? secondOutcome : firstOutcome;
			assertTrue(loserOutcome.startsWith("CONFLICT"), "the other claim reports an ownership conflict");
			Properties values = new Properties();
			try (var reader = Files.newBufferedReader(CoordinatorProcessOwnership.ownershipFile(root))) {
				values.load(reader);
			}
			assertTrue(Long.toString(winner.pid()).equals(values.getProperty("ownerPid")),
					"the published record belongs to the successful claimant");
			long rejectedChild = Long.parseLong(loserOutcome.substring("CONFLICT ".length()).trim());
			assertTrue(ProcessHandle.of(rejectedChild).map(handle -> !handle.isAlive()).orElse(true),
					"the rejected launch's coordinator is retired");
			return 4;
		} finally {
			Files.writeString(signals.resolve("stop"), "stop", StandardCharsets.UTF_8);
			for (Process process : new Process[] {first, second}) {
				if (process == null) continue;
				if (!process.waitFor(10, TimeUnit.SECONDS)) process.destroyForcibly();
			}
			Files.deleteIfExists(CoordinatorProcessOwnership.ownershipFile(root));
			deleteTree(signals);
		}
	}

	/**
	 * A reaper that read a dead owner's record cleans up late: by then server B has claimed the root, and while the
	 * reaper is inside its cleanup server C tries to claim too. B's record must stay published throughout, so C is
	 * rejected instead of also becoming a live owner.
	 */
	private static int verifyDelayedReaperKeepsLiveClaim(Path root, Path main) throws Exception {
		Path ownershipFile = CoordinatorProcessOwnership.ownershipFile(root);
		Files.deleteIfExists(ownershipFile);
		Path signals = Files.createTempDirectory("arena-ownership-delayed-reaper");
		Files.writeString(signals.resolve("release"), "go", StandardCharsets.UTF_8);
		String javaExecutable = Path.of(System.getProperty("java.home"), "bin", isWindows() ? "java.exe" : "java").toString();
		String classPath = java.util.Arrays.stream(System.getProperty("java.class.path").split(java.io.File.pathSeparator))
				.filter(entry -> !entry.isBlank()).map(entry -> Path.of(entry).toAbsolutePath().toString())
				.collect(java.util.stream.Collectors.joining(java.io.File.pathSeparator));
		Process[] servers = new Process[2];
		Process stale = null;
		try {
			stale = startSleeper(main);
			CoordinatorProcessOwnership.record(root, stale, main, GENERATION_A, LAUNCH_A);
			long staleStart = stale.info().startInstant().orElseThrow().toEpochMilli();
			Properties values = new Properties();
			try (var reader = Files.newBufferedReader(ownershipFile)) {
				values.load(reader);
			}
			values.setProperty("ownerPid", Long.toString(Long.MAX_VALUE));
			values.setProperty("posixSessionPid", Long.toString(stale.pid()));
			values.setProperty("posixSessionStartedAtEpochMs", Long.toString(staleStart));
			try (var writer = Files.newBufferedWriter(ownershipFile)) {
				values.store(writer, "dead owner with a POSIX session");
			}
			stale.destroyForcibly();
			assertTrue(stale.waitFor(5, TimeUnit.SECONDS), "the stale coordinator exits");

			// The reaper has its stale snapshot; server B claims before the reaper's cleanup step.
			CoordinatorProcessOwnership.PosixSessionTerminator lateCleanup = (runtimeRoot, launchId, session) -> {
				try {
					servers[0] = new ProcessBuilder(javaExecutable, "-cp", classPath,
							CoordinatorOwnershipClaimRaceFixture.class.getName(),
							root.toString(), main.toString(), LAUNCH_B, signals.toString(), "b").start();
					assertTrue(awaitOutcome(signals.resolve("b.outcome"), 30_000L).startsWith("CLAIMED"),
							"server B claims the root after the reaper read the stale record");
				} catch (Exception exception) {
					throw new java.io.IOException(exception);
				}
				return PosixCoordinatorSession.Termination.TERMINATED;
			};
			// Server C tries to claim while the reaper is inside its cleanup.
			CoordinatorProcessOwnership.cleanupProbeForVerification = () -> {
				try {
					servers[1] = new ProcessBuilder(javaExecutable, "-cp", classPath,
							CoordinatorOwnershipClaimRaceFixture.class.getName(),
							root.toString(), main.toString(), LAUNCH_C, signals.toString(), "c").start();
					awaitOutcome(signals.resolve("c.outcome"), 2_000L);
				} catch (Exception exception) {
					throw new IllegalStateException(exception);
				}
			};
			CoordinatorProcessOwnership.reapOrphaned(root, SUPERVISOR_B, lateCleanup);
			CoordinatorProcessOwnership.cleanupProbeForVerification = null;

			String cOutcome = awaitOutcome(signals.resolve("c.outcome"), 30_000L);
			assertTrue(cOutcome.startsWith("CONFLICT"), "server C is rejected while server B is live: " + cOutcome);
			Properties published = new Properties();
			try (var reader = Files.newBufferedReader(ownershipFile)) {
				published.load(reader);
			}
			assertTrue(Long.toString(servers[0].pid()).equals(published.getProperty("ownerPid")),
					"the late cleanup leaves server B's live record published");
			assertTrue(servers[0].isAlive(), "server B is still running");
			long rejectedChild = Long.parseLong(cOutcome.substring("CONFLICT ".length()).trim());
			assertTrue(ProcessHandle.of(rejectedChild).map(handle -> !handle.isAlive()).orElse(true),
					"server C's rejected launch retires its coordinator");
			return 6;
		} finally {
			CoordinatorProcessOwnership.cleanupProbeForVerification = null;
			Files.writeString(signals.resolve("stop"), "stop", StandardCharsets.UTF_8);
			for (Process process : servers) {
				if (process == null) continue;
				if (!process.waitFor(10, TimeUnit.SECONDS)) process.destroyForcibly();
			}
			if (stale != null && stale.isAlive()) stale.destroyForcibly();
			Files.deleteIfExists(ownershipFile);
			deleteTree(signals);
		}
	}

	private static String awaitOutcome(Path file, long timeoutMs) throws Exception {
		long deadline = System.currentTimeMillis() + timeoutMs;
		while (System.currentTimeMillis() < deadline) {
			if (Files.exists(file)) {
				String text = Files.readString(file, StandardCharsets.UTF_8);
				if (!text.isBlank()) return text;
			}
			Thread.sleep(20L);
		}
		return "";
	}

	private static void assertSupervisorIdentity(
			Path root,
			CoordinatorProcessOwnership.SupervisorIdentity expected
	) throws Exception {
		Properties values = new Properties();
		try (var reader = Files.newBufferedReader(CoordinatorProcessOwnership.ownershipFile(root))) {
			values.load(reader);
		}
		assertTrue(expected.value().equals(values.getProperty("supervisorId")),
				"ownership records the exact supervisor identity");
	}

	private static void assertOwnershipIdentity(Path root, String generationId, String launchId) throws Exception {
		Properties values = new Properties();
		try (var reader = Files.newBufferedReader(CoordinatorProcessOwnership.ownershipFile(root))) {
			values.load(reader);
		}
		assertTrue(generationId.equals(values.getProperty("generationId")),
				"ownership records the exact runtime generation");
		assertTrue(launchId.equals(values.getProperty("launchId")),
				"ownership records the exact supervisor launch UUID");
		long ownerStart = ProcessHandle.current().info().startInstant().orElseThrow().toEpochMilli();
		assertTrue(Long.toString(ownerStart).equals(values.getProperty("ownerStartedAtEpochMs")),
				"ownership records the exact Minecraft owner start identity");
	}

	private static void invalidateOwnerProcess(Path root) throws Exception {
		Path ownership = CoordinatorProcessOwnership.ownershipFile(root);
		Properties values = new Properties();
		try (var reader = Files.newBufferedReader(ownership)) {
			values.load(reader);
		}
		values.setProperty("ownerPid", Long.toString(Long.MAX_VALUE));
		try (var writer = Files.newBufferedWriter(ownership)) {
			values.store(writer, "owner process exited");
		}
	}

	private static void invalidateOwnerStartTimestamp(Path root) throws Exception {
		Path ownership = CoordinatorProcessOwnership.ownershipFile(root);
		Properties values = new Properties();
		try (var reader = Files.newBufferedReader(ownership)) {
			values.load(reader);
		}
		values.setProperty("ownerStartedAtEpochMs", "1");
		try (var writer = Files.newBufferedWriter(ownership)) {
			values.store(writer, "reused owner PID fixture");
		}
	}

	private static void removeOwnerStartTimestamp(Path root) throws Exception {
		Path ownership = CoordinatorProcessOwnership.ownershipFile(root);
		Properties values = new Properties();
		try (var reader = Files.newBufferedReader(ownership)) {
			values.load(reader);
		}
		values.remove("ownerStartedAtEpochMs");
		try (var writer = Files.newBufferedWriter(ownership)) {
			values.store(writer, "legacy ownership fixture");
		}
	}

	private static void invalidateStartTimestamp(Path root) throws Exception {
		Path ownership = CoordinatorProcessOwnership.ownershipFile(root);
		Properties values = new Properties();
		try (var reader = Files.newBufferedReader(ownership)) {
			values.load(reader);
		}
		values.setProperty("startedAtEpochMs", "1");
		try (var writer = Files.newBufferedWriter(ownership)) {
			values.store(writer, "invalidated ownership fixture");
		}
	}

	private static int verifyStartupOwnershipRecordFailureCleanup(Path main) throws Exception {
		Process failedStart = startTreeSleeper(main);
		try {
			var descendants = failedStart.toHandle().descendants().toList();
			assertTrue(!descendants.isEmpty(), "startup failure fixture creates a child process");
			CoordinatorProcessSupervisor.terminateFailedStart(failedStart);
			assertTrue(failedStart.waitFor(5, TimeUnit.SECONDS),
					"startup ownership-record failure terminates the coordinator");
			assertTrue(descendants.stream().noneMatch(ProcessHandle::isAlive),
					"startup ownership-record failure terminates every coordinator child");
			return 3;
		} finally {
			if (failedStart.isAlive()) failedStart.destroyForcibly();
		}
	}

	private static int verifyRefusedProcessTreeTerminationFailsClosed() {
		RefusingProcessHandle child = new RefusingProcessHandle(9002L, java.util.List.of());
		RefusingProcessHandle parent = new RefusingProcessHandle(9001L, java.util.List.of(child));
		try {
			CoordinatorProcessOwnership.terminateTree(parent, 1L);
			throw new AssertionError("a surviving exact process tree must fail termination");
		} catch (IllegalStateException expected) {
			assertTrue(expected.getMessage().contains("still alive"),
					"surviving process-tree failure is explicit");
		}
		assertTrue(parent.normalDestroyAttempts == 1 && parent.forcedDestroyAttempts == 1,
				"the exact parent receives normal and forced termination attempts");
		assertTrue(child.normalDestroyAttempts == 1 && child.forcedDestroyAttempts == 1,
				"every captured descendant receives normal and forced termination attempts");
		assertTrue(parent.isAlive() && child.isAlive(),
				"refused process handles remain visibly alive to the caller");
		return 4;
	}

	private static int verifyDescendantIdentityRejectsPidReuse() {
		ProcessHandle current = ProcessHandle.current();
		CoordinatorProcessOwnership.ProcessIdentity exact =
				CoordinatorProcessOwnership.ProcessIdentity.from(current).orElseThrow();
		assertTrue(exact.resolve().filter(current::equals).isPresent(),
				"captured descendant identity resolves the exact live process");
		CoordinatorProcessOwnership.ProcessIdentity reused = new CoordinatorProcessOwnership.ProcessIdentity(
				current.pid(), exact.startedAtEpochMs() + 1L
		);
		assertTrue(reused.resolve().isEmpty(),
				"a reused PID with a different start identity cannot be terminated as an owned descendant");
		return 2;
	}

	private static int verifyClearPreservesNewerRecord(Path root, Process process) throws Exception {
		Path ownership = CoordinatorProcessOwnership.ownershipFile(root);
		Properties values = new Properties();
		try (var reader = Files.newBufferedReader(ownership)) {
			values.load(reader);
		}
		values.setProperty("generationId", GENERATION_B);
		values.setProperty("launchId", LAUNCH_B);
		try (var writer = Files.newBufferedWriter(ownership)) {
			values.store(writer, "newer ownership fixture");
		}

		CoordinatorProcessOwnership.clear(root, process, GENERATION_A, LAUNCH_A);
		assertTrue(Files.exists(ownership),
				"clear preserves a newer generation and launch record with the same PID and start time");
		Files.deleteIfExists(ownership);
		return 1;
	}

	private static Process startSleeper(Path main) throws Exception {
		String java = Path.of(System.getProperty("java.home"), "bin", isWindows() ? "java.exe" : "java").toString();
		Process process = new ProcessBuilder(
				java,
				"-cp",
				fixtureClassPath(),
				CoordinatorProcessFixture.class.getName(),
				main.toString()
		).start();
		Thread.sleep(100L);
		assertTrue(process.isAlive(), "ownership fixture process started");
		return process;
	}

	private static Process startTreeSleeper(Path main) throws Exception {
		String java = Path.of(System.getProperty("java.home"), "bin", isWindows() ? "java.exe" : "java").toString();
		Process process = new ProcessBuilder(
				java,
				"-cp",
				fixtureClassPath(),
				CoordinatorProcessTreeFixture.class.getName(),
				main.toString()
		).start();
		long deadline = System.currentTimeMillis() + 5_000L;
		while (process.toHandle().descendants().findAny().isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(25L);
		assertTrue(process.isAlive(), "ownership tree fixture process started");
		return process;
	}

	static String fixtureClassPath() throws Exception {
		return Path.of(CoordinatorProcessFixture.class.getProtectionDomain().getCodeSource().getLocation().toURI()).toString();
	}

	private static void deleteTree(Path root) throws Exception {
		if (!Files.exists(root)) return;
		try (var paths = Files.walk(root)) {
			for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
		}
	}

	private static boolean isWindows() {
		return System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).contains("win");
	}

	private static final class RefusingProcessHandle implements ProcessHandle {
		private final long pid;
		private final java.util.List<ProcessHandle> descendants;
		private int normalDestroyAttempts;
		private int forcedDestroyAttempts;

		private RefusingProcessHandle(long pid, java.util.List<ProcessHandle> descendants) {
			this.pid = pid;
			this.descendants = descendants;
		}

		@Override public long pid() { return pid; }
		@Override public java.util.Optional<ProcessHandle> parent() { return java.util.Optional.empty(); }
		@Override public java.util.stream.Stream<ProcessHandle> children() { return descendants.stream(); }
		@Override public java.util.stream.Stream<ProcessHandle> descendants() { return descendants.stream(); }
		@Override public Info info() { return ProcessHandle.current().info(); }
		@Override public java.util.concurrent.CompletableFuture<ProcessHandle> onExit() { return new java.util.concurrent.CompletableFuture<>(); }
		@Override public boolean supportsNormalTermination() { return true; }
		@Override public boolean destroy() { normalDestroyAttempts++; return false; }
		@Override public boolean destroyForcibly() { forcedDestroyAttempts++; return false; }
		@Override public boolean isAlive() { return true; }
		@Override public int compareTo(ProcessHandle other) { return Long.compare(pid, other.pid()); }
	}

	private static void assertTrue(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
	}

}
