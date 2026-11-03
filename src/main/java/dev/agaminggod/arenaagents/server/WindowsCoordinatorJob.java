package dev.agaminggod.arenaagents.server;

import com.sun.jna.Memory;
import com.sun.jna.Native;
import com.sun.jna.Pointer;
import com.sun.jna.WString;
import com.sun.jna.win32.StdCallLibrary;
import com.sun.jna.win32.W32APIOptions;

import java.io.IOException;
import java.util.Locale;
import java.util.Objects;
import java.util.UUID;

/** Gives one Windows coordinator launch durable, kernel-owned process-tree lifetime. */
final class WindowsCoordinatorJob {
	private static final int JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
	private static final int BASIC_ACCOUNTING_INFORMATION_SIZE = 48;
	private static final long ACTIVE_PROCESSES_OFFSET = 40L;
	private static final int JOB_OBJECT_QUERY = 0x0004;
	static final long DRAIN_TIMEOUT_MS = 5_000L;
	private static final int JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
	private static final int JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
	private static final int JOB_OBJECT_TERMINATE = 0x0008;
	private static final int PROCESS_TERMINATE = 0x0001;
	private static final int PROCESS_SET_QUOTA = 0x0100;
	private static final int ERROR_FILE_NOT_FOUND = 2;
	private static final int ERROR_ALREADY_EXISTS = 183;
	private static final int EXTENDED_LIMIT_INFORMATION_SIZE_32 = 108;
	private static final int EXTENDED_LIMIT_INFORMATION_SIZE_64 = 144;
	private static final long LIMIT_FLAGS_OFFSET = 16L;
	private static final String NAME_PREFIX = "Local\\ArenaAgentsCoordinator-";

	private final Pointer handle;
	private boolean closed;

	private WindowsCoordinatorJob(Pointer handle) {
		this.handle = handle;
	}

	static boolean supported() {
		return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
	}

	static WindowsCoordinatorJob create(String launchId) throws IOException {
		requireWindows();
		String name = name(launchId);
		Pointer handle = Kernel32.INSTANCE.CreateJobObjectW(Pointer.NULL, new WString(name));
		int createError = Native.getLastError();
		if (nullHandle(handle)) throw failure("create coordinator job", createError);
		if (createError == ERROR_ALREADY_EXISTS) {
			Kernel32.INSTANCE.CloseHandle(handle);
			throw new IOException("Could not create coordinator job: launch identity is already in use");
		}
		WindowsCoordinatorJob job = new WindowsCoordinatorJob(handle);
		try {
			job.enableKillOnClose();
			return job;
		} catch (IOException failure) {
			try {
				job.closeHandle();
			} catch (IOException closeFailure) {
				failure.addSuppressed(closeFailure);
			}
			throw failure;
		}
	}

	static boolean terminateExisting(String launchId) throws IOException {
		if (!supported()) return false;
		Pointer handle = Kernel32.INSTANCE.OpenJobObjectW(
				JOB_OBJECT_TERMINATE | JOB_OBJECT_QUERY, false, new WString(name(launchId))
		);
		if (nullHandle(handle)) {
			int error = Native.getLastError();
			if (error == ERROR_FILE_NOT_FOUND) return false;
			throw failure("open owned coordinator job", error);
		}
		WindowsCoordinatorJob job = new WindowsCoordinatorJob(handle);
		try {
			job.terminateAndClose();
		} catch (IOException failure) {
			// Reaping has no retained owner to retry this handle. Keep the ownership record and release the query handle.
			try { job.closeHandle(); } catch (IOException closeFailure) { failure.addSuppressed(closeFailure); }
			throw failure;
		}
		return true;
	}

	synchronized void attach(long processId) throws IOException {
		if (closed) throw new IOException("Could not attach coordinator process: job is closed");
		if (processId <= 0L || processId > 0xffff_ffffL) {
			throw new IOException("Could not attach coordinator process: process ID is invalid");
		}
		Pointer process = Kernel32.INSTANCE.OpenProcess(
				PROCESS_TERMINATE | PROCESS_SET_QUOTA,
				false,
				(int) processId
		);
		if (nullHandle(process)) throw failure("open coordinator launcher process", Native.getLastError());
		try {
			if (!Kernel32.INSTANCE.AssignProcessToJobObject(handle, process)) {
				throw failure("attach coordinator launcher to its job", Native.getLastError());
			}
		} finally {
			Kernel32.INSTANCE.CloseHandle(process);
		}
	}

	synchronized void terminateAndClose() throws IOException {
		if (closed) return;
		if (!Kernel32.INSTANCE.TerminateJobObject(handle, 1)) {
			throw failure("terminate owned coordinator job", Native.getLastError());
		}
		awaitDrained();
		closeHandle();
	}

	/** An unconfirmed stop must not let callers discard ownership of a process tree. */
	private void awaitDrained() throws IOException {
		try (Memory information = new Memory(BASIC_ACCOUNTING_INFORMATION_SIZE)) {
			awaitDrained(() -> {
				information.clear();
				if (!Kernel32.INSTANCE.QueryInformationJobObject(
						handle, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION, information, BASIC_ACCOUNTING_INFORMATION_SIZE, Pointer.NULL
				)) {
					throw failure("query terminated coordinator job process count", Native.getLastError());
				}
				return Integer.toUnsignedLong(information.getInt(ACTIVE_PROCESSES_OFFSET));
			}, DRAIN_TIMEOUT_MS);
		}
	}

	@FunctionalInterface
	interface ActiveProcessCount {
		long read() throws IOException;
	}

	static void awaitDrained(ActiveProcessCount count, long timeoutMs) throws IOException {
		long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(timeoutMs);
		while (true) {
			long active = count.read();
			if (active == 0L) return;
			if (System.nanoTime() >= deadline) {
				throw new IOException(active + " coordinator job process(es) still exiting after " + timeoutMs + " ms");
			}
			try {
				Thread.sleep(10L);
			} catch (InterruptedException interrupted) {
				Thread.currentThread().interrupt();
				throw new IOException("Interrupted while waiting for the coordinator job to drain", interrupted);
			}
		}
	}

	synchronized void closeHandle() throws IOException {
		if (closed) return;
		if (!Kernel32.INSTANCE.CloseHandle(handle)) {
			throw failure("close coordinator job handle", Native.getLastError());
		}
		closed = true;
	}

	private void enableKillOnClose() throws IOException {
		int size = Native.POINTER_SIZE == Long.BYTES
				? EXTENDED_LIMIT_INFORMATION_SIZE_64 : EXTENDED_LIMIT_INFORMATION_SIZE_32;
		try (Memory information = new Memory(size)) {
			information.clear();
			information.setInt(LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
			if (!Kernel32.INSTANCE.SetInformationJobObject(
					handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, information, size
			)) {
				throw failure("configure coordinator job lifetime", Native.getLastError());
			}
		}
	}

	private static String name(String launchId) {
		return NAME_PREFIX + UUID.fromString(Objects.requireNonNull(
				launchId, "launch ID must not be null"
		)).toString();
	}

	private static void requireWindows() throws IOException {
		if (!supported()) throw new IOException("Windows coordinator jobs are unavailable on this platform");
	}

	private static boolean nullHandle(Pointer handle) {
		return handle == null || Pointer.nativeValue(handle) == 0L;
	}

	private static IOException failure(String operation, int error) {
		return new IOException("Could not " + operation + " (Windows error " + error + ")");
	}

	private interface Kernel32 extends StdCallLibrary {
		Kernel32 INSTANCE = Native.load("kernel32", Kernel32.class, W32APIOptions.DEFAULT_OPTIONS);

		Pointer CreateJobObjectW(Pointer attributes, WString name);

		Pointer OpenJobObjectW(int desiredAccess, boolean inheritHandle, WString name);

		Pointer OpenProcess(int desiredAccess, boolean inheritHandle, int processId);

		boolean SetInformationJobObject(Pointer job, int informationClass, Pointer information, int length);

		boolean QueryInformationJobObject(Pointer job, int informationClass, Pointer information, int length, Pointer returnLength);

		boolean AssignProcessToJobObject(Pointer job, Pointer process);

		boolean TerminateJobObject(Pointer job, int exitCode);

		boolean CloseHandle(Pointer handle);
	}
}
