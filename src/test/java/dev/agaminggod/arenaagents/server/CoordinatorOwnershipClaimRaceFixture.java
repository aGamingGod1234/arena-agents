package dev.agaminggod.arenaagents.server;

import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

/**
 * One server JVM claiming a shared runtime root. It pauses inside the claim (when the coordinator PID is read for the
 * record) until the verification releases it, so two JVMs can be held at the point where both have checked ownership.
 */
final class CoordinatorOwnershipClaimRaceFixture {
	private CoordinatorOwnershipClaimRaceFixture() {
	}

	public static void main(String[] arguments) throws Exception {
		Path root = Path.of(arguments[0]);
		Path main = Path.of(arguments[1]);
		String launchId = arguments[2];
		Path signals = Path.of(arguments[3]);
		String name = arguments[4];
		String javaExecutable = Path.of(System.getProperty("java.home"), "bin", "java").toString();
		Process child = new ProcessBuilder(javaExecutable, "-cp", System.getProperty("java.class.path"),
				CoordinatorProcessFixture.class.getName(), main.toString()).start();
		String outcome;
		try {
			CoordinatorProcessOwnership.record(root, new PausingProcess(child, signals, name), main,
					"a".repeat(64), launchId, CoordinatorProcessOwnership.SupervisorIdentity.create());
			outcome = "CLAIMED " + child.pid();
		} catch (java.io.IOException conflict) {
			// A rejected launch retires its own coordinator, as the supervisor does after a failed record.
			child.destroyForcibly();
			child.waitFor(5, TimeUnit.SECONDS);
			outcome = "CONFLICT " + child.pid();
		}
		Path pending = signals.resolve(name + ".outcome.tmp");
		Files.writeString(pending, outcome, StandardCharsets.UTF_8);
		Files.move(pending, signals.resolve(name + ".outcome"), java.nio.file.StandardCopyOption.ATOMIC_MOVE);
		awaitFile(signals.resolve("stop"), 60_000L);
		child.destroyForcibly();
	}

	private static boolean awaitFile(Path file, long timeoutMs) throws InterruptedException {
		long deadline = System.currentTimeMillis() + timeoutMs;
		while (!Files.exists(file)) {
			if (System.currentTimeMillis() > deadline) return false;
			Thread.sleep(10L);
		}
		return true;
	}

	private static final class PausingProcess extends Process {
		private final Process delegate;
		private final Path signals;
		private final String name;

		PausingProcess(Process delegate, Path signals, String name) {
			this.delegate = delegate;
			this.signals = signals;
			this.name = name;
		}

		@Override
		public long pid() {
			try {
				Files.writeString(signals.resolve(name + ".reached"), "reached", StandardCharsets.UTF_8);
				awaitFile(signals.resolve("release"), 10_000L);
			} catch (Exception exception) {
				throw new IllegalStateException(exception);
			}
			return delegate.pid();
		}

		@Override public ProcessHandle.Info info() { return delegate.info(); }
		@Override public ProcessHandle toHandle() { return delegate.toHandle(); }
		@Override public boolean isAlive() { return delegate.isAlive(); }
		@Override public OutputStream getOutputStream() { return delegate.getOutputStream(); }
		@Override public InputStream getInputStream() { return delegate.getInputStream(); }
		@Override public InputStream getErrorStream() { return delegate.getErrorStream(); }
		@Override public int waitFor() throws InterruptedException { return delegate.waitFor(); }
		@Override public int exitValue() { return delegate.exitValue(); }
		@Override public void destroy() { delegate.destroy(); }
	}
}
