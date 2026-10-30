package dev.agaminggod.arenaagents.server;

import dev.agaminggod.arenaagents.server.bridge.MultiplexedServerBridge;
import java.io.IOException;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/** Verifies fail-closed runtime ticks and manual-secret voice lifecycle transitions. */
public final class CodexAgentServerRuntimeVoiceStartVerification {
	private CodexAgentServerRuntimeVoiceStartVerification() {
	}

	private static final String ISOLATED_FIXTURE = "--isolated-default-secret-fixture";
	private static final String ASSERTION_PREFIX = "VOICE_START_ASSERTIONS=";

	public static void main(String[] arguments) throws Exception {
		if (arguments.length == 1 && ISOLATED_FIXTURE.equals(arguments[0])) {
			net.minecraft.SharedConstants.tryDetectVersion();
			net.minecraft.server.Bootstrap.bootStrap();
			System.out.println(ASSERTION_PREFIX + verifyInWorkingDirectory());
			return;
		}
		System.out.println("PASS: " + verify() + " runtime voice start assertions");
	}

	/**
	 * The fixture rewrites runtime/bridge-secret.txt and runtime/voice-secret.txt relative to its working directory to
	 * exercise default secret resolution, so it runs in a child JVM whose working directory is a fresh temporary
	 * directory. The checkout's own runtime secrets are never touched, even if the fixture is killed mid-write.
	 */
	public static int verify() throws Exception {
		Path checkoutBridgeSecret = Path.of("runtime", "bridge-secret.txt").toAbsolutePath();
		Path checkoutVoiceSecret = Path.of("runtime", "voice-secret.txt").toAbsolutePath();
		String bridgeBefore = fingerprint(checkoutBridgeSecret);
		String voiceBefore = fingerprint(checkoutVoiceSecret);
		Path workingDirectory = Files.createTempDirectory("arena-voice-start-fixture");
		try {
			String classPath = java.util.Arrays.stream(System.getProperty("java.class.path").split(java.io.File.pathSeparator))
					.filter(entry -> !entry.isBlank())
					.map(entry -> Path.of(entry).toAbsolutePath().toString())
					.collect(java.util.stream.Collectors.joining(java.io.File.pathSeparator));
			java.util.List<String> command = new java.util.ArrayList<>(java.util.List.of(
					Path.of(System.getProperty("java.home"), "bin", "java").toString(),
					"--enable-native-access=ALL-UNNAMED"));
			String nodePath = System.getProperty("arenaagents.nodePath");
			if (nodePath != null) command.add("-Darenaagents.nodePath=" + nodePath);
			command.addAll(java.util.List.of("-cp", classPath,
					CodexAgentServerRuntimeVoiceStartVerification.class.getName(), ISOLATED_FIXTURE));
			ProcessBuilder builder = new ProcessBuilder(command).directory(workingDirectory.toFile()).redirectErrorStream(true);
			// Default resolution is under test: no inherited explicit secret location may bypass it.
			builder.environment().keySet().removeIf(name -> name.toUpperCase(java.util.Locale.ROOT).contains("SECRET"));
			Process child = builder.start();
			String output;
			try (var stream = child.getInputStream()) {
				output = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
			}
			if (!child.waitFor(120, java.util.concurrent.TimeUnit.SECONDS)) {
				child.destroyForcibly();
				throw new AssertionError("isolated voice start fixture did not finish");
			}
			assertEquals(0, child.exitValue(), "isolated voice start fixture passes:\n" + output);
			// Bootstrap routes stdout through the game logger, which prefixes each line.
			int assertions = output.lines().filter(line -> line.contains(ASSERTION_PREFIX))
					.mapToInt(line -> Integer.parseInt(line.substring(line.indexOf(ASSERTION_PREFIX) + ASSERTION_PREFIX.length()).trim()))
					.findFirst().orElseThrow(() -> new AssertionError("isolated fixture reported no assertions:\n" + output));
			assertTrue(Files.exists(workingDirectory.resolve("runtime")), "the fixture exercised default runtime secrets in its own directory");
			assertEquals(bridgeBefore, fingerprint(checkoutBridgeSecret), "the checkout bridge secret is untouched");
			assertEquals(voiceBefore, fingerprint(checkoutVoiceSecret), "the checkout voice secret is untouched");
			return assertions + 4;
		} finally {
			deleteTree(workingDirectory);
		}
	}

	/** Size, modification time and content digest; never the secret itself. */
	private static String fingerprint(Path file) throws Exception {
		if (!Files.exists(file)) return "absent";
		byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(file));
		return Files.size(file) + ":" + Files.getLastModifiedTime(file).toMillis() + ":" + java.util.HexFormat.of().formatHex(digest);
	}

	private static void deleteTree(Path root) throws IOException {
		if (!Files.exists(root)) return;
		try (var paths = Files.walk(root)) {
			for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
		}
	}

	private static int verifyInWorkingDirectory() throws Exception {
		String oldAutoStart = System.getProperty("arenaagents.coordinatorAutoStart");
		String oldBridgeSecret = System.getProperty("arenaagents.bridgeSecretFile");
		String oldVoiceSecret = System.getProperty("arenaagents.voiceSecretFile");
		String oldBridgePort = System.getProperty("arenaagents.bridgePort");
		Path defaultBridgeSecret = Path.of("runtime", "bridge-secret.txt");
		Path defaultVoiceSecret = Path.of("runtime", "voice-secret.txt");
		boolean hadDefaultBridgeSecret = Files.exists(defaultBridgeSecret);
		boolean hadDefaultVoiceSecret = Files.exists(defaultVoiceSecret);
		byte[] previousBridgeSecret = hadDefaultBridgeSecret ? Files.readAllBytes(defaultBridgeSecret) : null;
		byte[] previousVoiceSecret = hadDefaultVoiceSecret ? Files.readAllBytes(defaultVoiceSecret) : null;
		CoordinatorProcessSupervisor supervisor = null;
		CodexAgentServerRuntime.BridgeSlot slot = null;
		try {
			Files.createDirectories(defaultBridgeSecret.getParent());
			Files.writeString(defaultBridgeSecret, "b".repeat(32), StandardCharsets.UTF_8);
			Files.writeString(defaultVoiceSecret, "d".repeat(32), StandardCharsets.UTF_8);
			System.setProperty("arenaagents.coordinatorAutoStart", "false");
			System.clearProperty("arenaagents.bridgeSecretFile");
			System.clearProperty("arenaagents.voiceSecretFile");
			System.setProperty("arenaagents.bridgePort", Integer.toString(unusedLoopbackPort()));

			supervisor = new CoordinatorProcessSupervisor(
					Path.of("build", "default-secret-voice-game"), Map.of(), () -> 0L,
					null, null, () -> "00000000-0000-0000-0000-000000000901"
			);
			assertFalse(supervisor.configured(), "disabled autostart skips coordinator dependency preparation");
			assertTrue(CodexAgentServerRuntime.voiceConfigurationPrepared(supervisor),
					"readable default voice secret prepares voice without an explicit secret property");
			Object unchangedSecretCache = CodexAgentServerRuntime.explicitSecretCacheEntryForVerification(defaultVoiceSecret);
			for (int index = 0; index < 20; index++) CodexAgentServerRuntime.voiceConfigurationRevision(supervisor);
			assertTrue(unchangedSecretCache == CodexAgentServerRuntime.explicitSecretCacheEntryForVerification(defaultVoiceSecret),
					"unchanged secret metadata reuses its cached fingerprint");

			slot = new CodexAgentServerRuntime.BridgeSlot(System::currentTimeMillis);
			CodexAgentServerRuntime.reconcileBridgeConfiguration(slot, uninitializedManager(), supervisor);
			assertTrue(slot.bridge() != null, "the Java bridge starts from its separate default runtime secret");
			MultiplexedServerBridge adoptionListener = slot.bridge();
			AtomicInteger boundRuntimeTicks = new AtomicInteger();
			assertFalse(CodexAgentServerRuntime.runRestoredStateTick(false, boundRuntimeTicks::incrementAndGet),
					"failed persisted-state restoration fences the bound runtime tick");
			assertEquals(0, boundRuntimeTicks.get(),
					"failed restoration does not drain commands or mutate stale-bound agents");
			assertEquals(adoptionListener, slot.bridge(),
					"failed restoration leaves the bridge listener available for coordinator adoption");
			assertTrue(CodexAgentServerRuntime.runRestoredStateTick(true, boundRuntimeTicks::incrementAndGet),
					"a later successful restoration resumes the bound runtime tick");
			assertEquals(1, boundRuntimeTicks.get(), "successful restoration resumes bound work exactly once");

			AtomicInteger voiceStarts = new AtomicInteger();
			AtomicInteger voiceCloses = new AtomicInteger();
			CodexAgentServerRuntime.VoiceInitializationGate gate =
					new CodexAgentServerRuntime.VoiceInitializationGate(
							voiceStarts::incrementAndGet, voiceCloses::incrementAndGet
					);
			assertTrue(gate.reconcile(CodexAgentServerRuntime.voiceConfigurationPrepared(supervisor),
					CodexAgentServerRuntime.voiceConfigurationRevision(supervisor)),
					"prepared default runtime secret starts the voice subsystem");
			assertEquals(1, voiceStarts.get(), "voice starts once for the prepared default runtime secret");

			Files.writeString(defaultVoiceSecret, "invalid", StandardCharsets.UTF_8);
			boolean invalidPrepared = CodexAgentServerRuntime.voiceConfigurationPrepared(supervisor);
			assertFalse(invalidPrepared, "invalid default runtime secret keeps voice fail-closed");
			assertTrue(gate.reconcile(invalidPrepared, CodexAgentServerRuntime.voiceConfigurationRevision(supervisor)),
					"invalidating the effective manual secret fences the active voice subsystem");
			assertEquals(1, voiceCloses.get(), "invalid secret transition closes the active voice subsystem once");

			Files.writeString(defaultVoiceSecret, "r".repeat(32), StandardCharsets.UTF_8);
			assertTrue(gate.reconcile(CodexAgentServerRuntime.voiceConfigurationPrepared(supervisor),
					CodexAgentServerRuntime.voiceConfigurationRevision(supervisor)),
					"repairing the effective manual secret restarts voice without restarting Minecraft");
			assertEquals(2, voiceStarts.get(), "valid secret recovery starts one replacement voice subsystem");

			Files.delete(defaultVoiceSecret);
			boolean missingPrepared = CodexAgentServerRuntime.voiceConfigurationPrepared(supervisor);
			assertFalse(missingPrepared, "missing default runtime secret keeps voice fail-closed");
			Object missingSecretCache = CodexAgentServerRuntime.explicitSecretCacheEntryForVerification(defaultVoiceSecret);
			for (int index = 0; index < 20; index++) CodexAgentServerRuntime.voiceConfigurationRevision(supervisor);
			assertTrue(missingSecretCache == CodexAgentServerRuntime.explicitSecretCacheEntryForVerification(defaultVoiceSecret),
					"a missing secret is negatively cached between bounded retries");
			assertTrue(gate.reconcile(missingPrepared, CodexAgentServerRuntime.voiceConfigurationRevision(supervisor)),
					"removing the effective manual secret fences the recovered voice subsystem");
			assertEquals(2, voiceCloses.get(), "missing secret transition closes the recovered voice subsystem once");

			Files.writeString(defaultVoiceSecret, "s".repeat(32), StandardCharsets.UTF_8);
			Thread.sleep(300L);
			assertTrue(gate.reconcile(CodexAgentServerRuntime.voiceConfigurationPrepared(supervisor),
					CodexAgentServerRuntime.voiceConfigurationRevision(supervisor)),
					"recreating the missing manual secret recovers voice on a later tick");
			assertEquals(3, voiceStarts.get(), "missing secret recovery starts one replacement voice subsystem");
			return 21;
		} finally {
			if (slot != null) slot.close();
			if (supervisor != null) supervisor.close();
			restoreProperty("arenaagents.coordinatorAutoStart", oldAutoStart);
			restoreProperty("arenaagents.bridgeSecretFile", oldBridgeSecret);
			restoreProperty("arenaagents.voiceSecretFile", oldVoiceSecret);
			restoreProperty("arenaagents.bridgePort", oldBridgePort);
			if (hadDefaultBridgeSecret) Files.write(defaultBridgeSecret, previousBridgeSecret);
			else Files.deleteIfExists(defaultBridgeSecret);
			if (hadDefaultVoiceSecret) Files.write(defaultVoiceSecret, previousVoiceSecret);
			else Files.deleteIfExists(defaultVoiceSecret);
			CodexAgentServerRuntime.clearExplicitSecretCacheForVerification(defaultBridgeSecret);
			CodexAgentServerRuntime.clearExplicitSecretCacheForVerification(defaultVoiceSecret);
		}
	}

	private static CodexAgentManager uninitializedManager() {
		try {
			Field field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
			field.setAccessible(true);
			sun.misc.Unsafe unsafe = (sun.misc.Unsafe) field.get(null);
			CodexAgentManager manager = (CodexAgentManager) unsafe.allocateInstance(CodexAgentManager.class);
			Field savedData = CodexAgentManager.class.getDeclaredField("savedData");
			unsafe.putObject(manager, unsafe.objectFieldOffset(savedData), new AgentSavedData());
			Field pendingRegistrations = CodexAgentManager.class.getDeclaredField("pendingAgentRegistrations");
			unsafe.putObject(manager, unsafe.objectFieldOffset(pendingRegistrations), new java.util.LinkedHashSet<>());
			return manager;
		} catch (ReflectiveOperationException exception) {
			throw new AssertionError("could not allocate lifecycle-only manager", exception);
		}
	}

	private static int unusedLoopbackPort() throws IOException {
		try (var socket = new java.net.ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())) {
			return socket.getLocalPort();
		}
	}

	private static void restoreProperty(String name, String value) {
		if (value == null) System.clearProperty(name);
		else System.setProperty(name, value);
	}

	private static void assertTrue(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
	}

	private static void assertFalse(boolean condition, String label) {
		if (condition) throw new AssertionError(label);
	}

	private static void assertEquals(Object expected, Object actual, String label) {
		if (!java.util.Objects.equals(expected, actual)) {
			throw new AssertionError(label + ": expected <" + expected + "> but was <" + actual + ">");
		}
	}
}
