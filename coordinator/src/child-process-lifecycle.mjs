import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import path, { resolve } from 'node:path';
const ownedEvidence = new WeakMap();
const ownedPreparation = new WeakMap();

export const DEFAULT_CHILD_STOP_TIMEOUT_MS = 2_000;
const windowsJobLauncher = fileURLToPath(new URL('./owned-windows-job.ps1', import.meta.url));

// The wrapper joins a kill-on-close job before starting the requested command.
// Its ChildProcess handle owns the job lifetime, including descendants after the command exits.
export function spawnOwnedProcess(command, args, options = {}, { platform = process.platform, spawn = nodeSpawn } = {}) {
	const { ownedJobEvidencePath, ...spawnOptions } = options;
	if (ownedJobEvidencePath && platform !== 'win32') throw new Error('owned job completion evidence requires Windows');
	if (platform !== 'win32') return spawn(command, args, spawnOptions);
	const environment = spawnOptions.env ? windowsEnvironmentBlock(spawnOptions.env) : null;
	const commandJson = Buffer.from(JSON.stringify({ command, args, ...(environment ? { env: environment } : {}) }), 'utf8').toString('base64');
	const child = spawn(windowsPowerShellExecutable(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', windowsJobLauncher, '-CommandJson', commandJson, ...(ownedJobEvidencePath ? ['-EvidencePath', ownedJobEvidencePath] : [])], {
		...spawnOptions, ...(environment ? { env: windowsWrapperEnvironment(environment) } : {}), windowsHide: true,
	});
	if (ownedJobEvidencePath) ownedEvidence.set(child, resolve(ownedJobEvidencePath));
	return child;
}

// Builds the wrapper's cached C# helper ahead of time. The first build takes seconds on a fresh host,
// which would otherwise land inside the first provider launch and its deadline.
export function prepareOwnedProcessHelper({ platform = process.platform, spawn = nodeSpawn } = {}) {
	if (platform !== 'win32') return Promise.resolve({ prepared: false, exitCode: null });
	return new Promise((settle) => {
		const child = spawn(windowsPowerShellExecutable(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', windowsJobLauncher, '-LibraryOnly'], {
			stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
		});
		let stderr = '';
		child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4_096); });
		child.once('error', (error) => settle({ prepared: false, exitCode: null, error: error.message }));
		child.once('close', (exitCode) => settle({ prepared: exitCode === 0, exitCode, ...(stderr ? { error: stderr.trim() } : {}) }));
	});
}

// Windows PowerShell hung without output on a GitHub runner when started with only a provider's allowlisted
// environment. The wrapper therefore also gets the standard Windows system variables, none of them credentials,
// and hands the provider exactly its own environment.
const WINDOWS_SYSTEM_ENVIRONMENT_VARIABLES = Object.freeze([
	'ALLUSERSPROFILE', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'COMPUTERNAME', 'DRIVERDATA',
	'LOGONSERVER', 'NUMBER_OF_PROCESSORS', 'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL',
	'PROCESSOR_REVISION', 'PSMODULEPATH', 'PUBLIC', 'SESSIONNAME', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE', 'USERNAME',
]);

// Windows names are case-insensitive and ConvertFrom-Json rejects keys differing only by case. Keep the
// entry Node itself would use: the first name in sorted order.
function windowsEnvironmentBlock(environment) {
	const block = {};
	const seen = new Set();
	for (const name of Object.keys(environment).sort()) {
		const value = environment[name];
		if (value === undefined || seen.has(name.toUpperCase())) continue;
		seen.add(name.toUpperCase());
		block[name] = String(value);
	}
	return block;
}

function windowsWrapperEnvironment(environment, source = process.env) {
	const wrapper = { ...environment };
	const present = new Set(Object.keys(wrapper).map((name) => name.toUpperCase()));
	for (const [name, value] of Object.entries(source)) {
		const upper = name.toUpperCase();
		if (typeof value === 'string' && !present.has(upper) && WINDOWS_SYSTEM_ENVIRONMENT_VARIABLES.includes(upper)) {
			wrapper[name] = value;
			present.add(upper);
		}
	}
	return wrapper;
}

// Provider environments can carry a PATH without System32, and a PATH lookup could pick up a planted powershell.exe.
function windowsPowerShellExecutable() {
	const systemRoot = process.env.SystemRoot;
	return typeof systemRoot === 'string' && systemRoot !== ''
		? path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
		: 'powershell.exe';
}

export function prepareOwnedJobStop(child, options = {}) {
	if (!ownedPreparation.has(child)) ownedPreparation.set(child, prepareOwnedJobStopOnce(child, options));
	return ownedPreparation.get(child);
}

async function prepareOwnedJobStopOnce(child, { timeoutMs = 15000 } = {}) {
	const evidence = ownedEvidence.get(child);
	if (!evidence) throw new Error('Owned process has no smoke cleanup witness');
	await writeFile(evidence + '.freeze', 'freeze');
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		const ready = await readFile(evidence + '.ready', 'utf8').catch(() => '');
		if (ready === 'FROZEN_JOB_HANDLE_CLOSED') return;
		const failed = await readFile(evidence, 'utf8').catch(() => '');
		if (failed) throw new Error('Owned job witness could not freeze cleanup census: ' + failed);
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	throw new Error('Owned job witness did not prepare cleanup before deadline');
}

export async function terminateChildProcess(child, {
	timeoutMs = DEFAULT_CHILD_STOP_TIMEOUT_MS,
	platform = process.platform,
} = {}) {
	if (child === null || child === undefined) return;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('child process stop timeout must be a positive safe integer');
	if (hasExited(child)) return;

	// On Windows Node signals its retained process HANDLE. Never reopen a PID, even
	// after an identity query: the process can exit and its PID be reused between calls.
	sendSignal(child, 'SIGTERM');
	if (hasExited(child) || await waitForExit(child, Math.max(1, Math.floor(timeoutMs / 2)))) return;
	sendSignal(child, 'SIGKILL');
	if (platform === 'win32' && Number.isSafeInteger(child.pid) && !hasExited(child)
		&& !await waitForExit(child, Math.max(1, Math.ceil(timeoutMs / 2)))) {
		throw new Error(`Could not confirm termination of owned process before the ${timeoutMs}ms deadline`);
	}
}

function hasExited(child) {
	return child.exitCode !== null || child.signalCode !== null;
}

function sendSignal(child, signal) {
	try {
		child.kill(signal);
	} catch (error) {
		if (!hasExited(child)) throw new Error(`Could not send ${signal} to provider process: ${error.message}`, { cause: error });
	}
}

function waitForExit(child, timeoutMs) {
	if (hasExited(child)) return Promise.resolve(true);
	return new Promise((resolve) => {
		let timer;
		const onExit = () => finish(true);
		const finish = (exited) => {
			clearTimeout(timer);
			child.off('exit', onExit);
			resolve(exited);
		};
		child.once('exit', onExit);
		timer = setTimeout(() => finish(hasExited(child)), timeoutMs);
	});
}
