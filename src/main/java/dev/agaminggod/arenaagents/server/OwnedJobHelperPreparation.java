package dev.agaminggod.arenaagents.server;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

/**
 * Builds the coordinator's Windows job helper before the coordinator starts. The first build takes seconds on a
 * fresh machine; done inside a provider launch it would spend the authentication and catalog deadlines instead.
 * A failure here is only logged: the wrapper still builds the helper itself on first use.
 */
final class OwnedJobHelperPreparation {
	private static final Logger LOGGER = LoggerFactory.getLogger(OwnedJobHelperPreparation.class);
	private static final long TIMEOUT_MS = 120_000L;

	private OwnedJobHelperPreparation() {
	}

	static void prepare(Path coordinatorRoot) {
		if (!System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).contains("win")) return;
		Path script = coordinatorRoot.resolve("src/owned-windows-job.ps1");
		String systemRoot = System.getenv("SystemRoot");
		if (systemRoot == null || systemRoot.isBlank() || !Files.isRegularFile(script)) return;
		// The same System32 path the coordinator uses, never a PATH lookup.
		Path powershell = Path.of(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		if (!Files.isRegularFile(powershell)) return;
		ProcessBuilder builder = new ProcessBuilder(powershell.toString(), "-NoProfile", "-NonInteractive",
				"-ExecutionPolicy", "Bypass", "-File", script.toString(), "-LibraryOnly");
		builder.redirectErrorStream(true);
		builder.redirectOutput(ProcessBuilder.Redirect.DISCARD);
		long started = System.nanoTime();
		Process process = null;
		try {
			process = builder.start();
			process.getOutputStream().close();
			if (!process.waitFor(TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
				stopHelperTree(process);
				LOGGER.warn("Arena Agents job helper build did not finish; providers will build it on first launch");
				return;
			}
			long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
			if (process.exitValue() == 0) LOGGER.info("Prepared the Arena Agents job helper in {} ms", elapsedMs);
			else LOGGER.warn("Arena Agents job helper build exited with {}; providers will build it on first launch", process.exitValue());
		} catch (IOException failure) {
			if (process != null) stopHelperTree(process);
			LOGGER.warn("Could not build the Arena Agents job helper; providers will build it on first launch", failure);
		} catch (InterruptedException interrupted) {
			// An interrupted startup must not leave the helper build (PowerShell and its compiler) running.
			if (process != null) stopHelperTree(process);
			Thread.currentThread().interrupt();
		}
	}

	/** Terminates the exact helper process and its descendants, waiting for them, without losing an interrupt. */
	private static void stopHelperTree(Process process) {
		if (!process.isAlive()) return;
		try {
			CoordinatorProcessOwnership.terminateTree(process.toHandle());
		} catch (RuntimeException failure) {
			LOGGER.warn("Could not stop the Arena Agents job helper build", failure);
		}
	}
}
