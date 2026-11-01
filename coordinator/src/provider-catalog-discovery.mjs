import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';

const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000;
const DISCOVERY_MAX_BUFFER_BYTES = 1_024 * 1_024;

/**
 * Parse the human-readable `agy models` output without trusting display names
 * as model IDs. Antigravity currently prints one line per model/effort pair,
 * e.g. `Gemini 3.6 Flash (High)`.
 */
export function parseAntigravityModelsOutput(output) {
	if (typeof output !== 'string') throw new TypeError('Antigravity model output must be text');
	const models = new Map();
	for (const rawLine of output.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '').split(/\r?\n/)) {
		const line = rawLine.trim();
		const match = /^(?<label>.+?)\s+\((?<effort>[^()]+)\)$/.exec(line);
		if (match === null) continue;
		const { wireId, name } = splitWireId(match.groups.label);
		const effort = normalizeEffort(match.groups.effort);
		if (name.length === 0 || effort === null) continue;
		const id = baseModelId(wireId, effort, name);
		const current = models.get(id) ?? {
			id,
			model: id,
			displayName: name,
			reasoningEfforts: [],
			serviceTiers: [],
		};
		if (!current.reasoningEfforts.includes(effort)) current.reasoningEfforts.push(effort);
		models.set(id, current);
	}
	return [...models.values()];
}

export async function discoverAntigravityCatalog({ executable = 'agy', execFile = nodeExecFile, spawn = nodeSpawn, environment, timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS } = {}) {
	const childEnvironment = requireEnvironment(environment);
	if (execFile === nodeExecFile) {
		// Runs on the coordinator event loop (startup and every Rescan), so the child is awaited, never spawnSync'd.
		const stdout = await runDiscoveryCommand(spawn, executable, ['models'], timeoutMs, childEnvironment);
		return parseAntigravityModelsOutput(stdout);
	}
	const result = await runExecFile(execFile, executable, ['models'], timeoutMs, childEnvironment);
	return parseAntigravityModelsOutput(result.stdout);
}

// A leading wire ID is either tab-separated or a lowercase hyphenated slug. Display-only rows such as
// `Gemini 3.6 Flash (High)` start with an ordinary name word, which must stay part of the display name.
function splitWireId(label) {
	const tab = label.indexOf('\t');
	if (tab >= 0) return { wireId: label.slice(0, tab).trim(), name: label.slice(tab + 1).trim() };
	const match = /^(?<wireId>[a-z0-9]+(?:[._:/-][a-z0-9]+)*)\s+(?<name>.+)$/.exec(label);
	if (match !== null && match.groups.wireId.includes('-')) return { wireId: match.groups.wireId, name: match.groups.name.trim() };
	return { wireId: undefined, name: label.trim() };
}

function normalizeEffort(value) {
	const normalized = value.trim().toLowerCase().replace(/\s+/g, '_');
	return ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'thinking'].includes(normalized) ? normalized : null;
}

function slugifyModelName(value) {
	return value.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
}

function baseModelId(wireId, effort, displayName) {
	if (typeof wireId !== 'string' || wireId.length === 0) return slugifyModelName(displayName);
	const suffix = `-${effort}`;
	return wireId.endsWith(suffix) ? wireId.slice(0, -suffix.length) : wireId;
}

/**
 * Asynchronous stand-in for the spawnSync call this replaced, with the same outcomes: the spawn error code
 * (ENOENT, ...), ETIMEDOUT after `timeoutMs`, ENOBUFS when either stream passes the buffer cap, and
 * `exit_<status>` (`exit_null` when a signal ended it) for any other nonzero end. Resolves with UTF-8 stdout.
 */
function runDiscoveryCommand(spawn, command, args, timeoutMs, environment) {
	return new Promise((resolve, reject) => {
		const stdout = [];
		const streamBytes = { stdout: 0, stderr: 0 };
		let settled = false;
		let timer = null;
		let child;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			if (error === null) resolve(Buffer.concat(stdout).toString('utf8'));
			else reject(error);
		};
		const fail = (code) => finish(new Error(`Provider model discovery failed (${code})`));
		const stop = (code) => {
			if (settled) return;
			try { child.kill('SIGTERM'); } catch { /* the child may already be gone */ }
			fail(code);
		};
		try {
			child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: environment });
		} catch (error) {
			reject(error);
			return;
		}
		if (Number.isFinite(timeoutMs) && timeoutMs > 0) timer = setTimeout(() => stop('ETIMEDOUT'), timeoutMs);
		const collect = (name) => (chunk) => {
			if (settled) return;
			streamBytes[name] += chunk.length;
			if (streamBytes[name] > DISCOVERY_MAX_BUFFER_BYTES) {
				stop('ENOBUFS');
				return;
			}
			if (name === 'stdout') stdout.push(chunk);
		};
		child.stdout?.on('data', collect('stdout'));
		child.stderr?.on('data', collect('stderr'));
		child.once('error', (error) => fail(error?.code ?? 'command_error'));
		child.once('close', (status) => {
			if (status === 0) finish(null);
			else fail(`exit_${status}`);
		});
	});
}

function runExecFile(execFile, command, args, timeoutMs, environment) {
	return new Promise((resolve, reject) => {
		try {
			execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1_024 * 1_024, env: environment }, (error, stdout) => {
				if (error !== null && error !== undefined) {
					const wrapped = new Error(`Provider model discovery failed (${error.code ?? 'command_error'})`);
					wrapped.code = error.code ?? 'DISCOVERY_FAILED';
					reject(wrapped);
					return;
				}
				resolve({ stdout: String(stdout ?? '') });
			});
		} catch (error) {
			reject(error);
		}
	});
}

function requireEnvironment(environment) {
	if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
		throw new TypeError('provider catalog environment must be an object');
	}
	return environment;
}
