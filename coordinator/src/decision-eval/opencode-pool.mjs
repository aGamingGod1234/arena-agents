import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { spawnOwnedProcess, terminateChildProcess } from '../child-process-lifecycle.mjs';

/**
 * Long-lived `opencode serve` processes for decision-eval players and judges, instead of one process per sample.
 *
 * Each OpenCode process costs 450-750 MB and about 1.5 cores while it boots, and the eval started one per player sample
 * and one per judge call. OpenCode serves every working directory as its own instance (the `directory` query): that
 * directory's opencode.json, its own MCP connections, sessions and event stream. A player sample's OpenCodeAgent writes
 * its config into its private directory exactly as before; the pool hands it a server where that directory is the
 * instance, so the agent prompt, permissions and Minecraft MCP route each sample runs with are the ones its build wrote.
 * Only the process is shared. The server is launched with the build's own environment minus the two variables that
 * point one process at one config (OPENCODE_CONFIG, OPENCODE_DISABLE_PROJECT_CONFIG); with project config on, OpenCode
 * also reads AGENTS.md and .opencode directories from the instance directory up to the filesystem root, so a sample whose directory
 * has any of those above it is refused (the sample directories live under the system temp directory, which has none).
 */

const LISTENING = /listening on (http:\/\/127\.0\.0\.1:\d+)/;
const PER_PROCESS_KEYS = new Set(['OPENCODE_CONFIG', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'XDG_CONFIG_HOME', 'OPENCODE_DB', 'OPENCODE_SERVER_PASSWORD']);

export class OpenCodeServerPool {
	#servers = new Map();
	#leases = new Map();
	#spawn;
	#terminate;
	#root;
	#startupTimeoutMs;
	#onExit = () => { for (const server of this.#servers.values()) try { server.child?.kill('SIGTERM'); } catch { /* exiting */ } };
	#onSignal = (signal) => { this.#onExit(); process.removeListener(signal, this.#onSignal); process.kill(process.pid, signal); };
	stats = { started: 0, leases: 0 };

	constructor({ root = os.tmpdir(), startupTimeoutMs = 30_000, spawn = spawnOwnedProcess, terminate = terminateChildProcess } = {}) {
		this.#root = root;
		this.#startupTimeoutMs = startupTimeoutMs;
		this.#spawn = spawn;
		this.#terminate = terminate;
	}

	/** The server for a launch (command, args, env without the per-process keys); started on first use. */
	async server({ command, args, env }) {
		const shared = Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => !PER_PROCESS_KEYS.has(key)).sort(([a], [b]) => a.localeCompare(b)));
		const key = JSON.stringify([command, args, shared]);
		let entry = this.#servers.get(key);
		if (entry === undefined || entry.exited) {
			entry = { key, child: null, url: null, auth: null, exited: false, leases: new Set(), ready: null, directory: null };
			this.#servers.set(key, entry);
			entry.ready = this.#start(entry, command, args, shared).catch((error) => { this.#servers.delete(key); throw error; });
		}
		await entry.ready;
		return entry;
	}

	async #start(entry, command, args, shared) {
		if (this.stats.started === 0) {
			process.once('exit', this.#onExit);
			for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, this.#onSignal);
		}
		this.stats.started += 1;
		entry.directory = await mkdtemp(path.join(this.#root, 'arena-opencode-pool-'));
		const password = randomBytes(24).toString('hex');
		entry.auth = `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
		const child = this.#spawn(command, args, {
			cwd: entry.directory, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
			env: { ...shared, XDG_CONFIG_HOME: path.join(entry.directory, 'config-home'), OPENCODE_DB: path.join(entry.directory, 'opencode.db'), OPENCODE_SERVER_PASSWORD: password },
		});
		entry.child = child;
		// A shared server never keeps its parent alive on its own: the process exit handler above stops it.
		child.unref?.();
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4_096); });
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`pooled OpenCode did not start within ${this.#startupTimeoutMs} ms`)), this.#startupTimeoutMs);
			child.stdout.on('data', (chunk) => {
				if (entry.url !== null) return;
				stdout = (stdout + chunk).slice(-4_096);
				const match = LISTENING.exec(stdout);
				if (match !== null) { entry.url = match[1]; clearTimeout(timer); child.stdout.unref?.(); child.stderr.unref?.(); resolve(); }
			});
			child.once('error', (error) => { clearTimeout(timer); reject(error); });
			child.once('close', (code, signal) => {
				clearTimeout(timer);
				entry.exited = true;
				if (this.#servers.get(entry.key) === entry) this.#servers.delete(entry.key);
				reject(new Error(`pooled OpenCode exited with code ${code} and signal ${signal}: ${stderr.replace(/[0-9a-f]{40,}/gi, '<redacted>').slice(-400)}`));
				// Every sample still on this process sees its server exit, as it would have seen its own process exit.
				for (const lease of entry.leases) lease.exit(code, signal);
				entry.leases.clear();
				void rm(entry.directory, { recursive: true, force: true }).catch(() => {});
			});
		}).catch(async (error) => { await this.#terminate(child).catch(() => {}); throw error; });
	}

	/**
	 * OpenCodeProviderService dependencies that run each agent's server as an instance of a pooled process. `request` is
	 * the build's own httpJsonRequest, so every call the agent makes is sent by its own code, to its own directory.
	 */
	playerDependencies({ request }) {
		const leaseOf = (state) => this.#leases.get(state?.child) ?? null;
		const target = (state) => {
			const lease = leaseOf(state);
			return lease === null ? { state, directory: null } : { state: { ...state, url: lease.server.url, auth: lease.server.auth }, directory: lease.directory };
		};
		return {
			spawn: (command, args, options) => {
				const child = new EventEmitter();
				child.stdout = new PassThrough();
				child.stderr = new PassThrough();
				child.stdin = null;
				child.exitCode = null;
				child.signalCode = null;
				const lease = {
					child, directory: options.cwd, server: null, closed: false,
					exit: (code, signal) => {
						if (lease.closed) return;
						lease.closed = true;
						this.#leases.delete(child);
						child.exitCode = code;
						child.signalCode = signal;
						child.emit('close', code, signal);
					},
				};
				this.#leases.set(child, lease);
				this.stats.leases += 1;
				const foreign = projectFilesAbove(options.cwd, { claude: options.env?.OPENCODE_DISABLE_CLAUDE_CODE !== '1' });
				if (foreign !== null) {
					setImmediate(() => child.emit('error', new Error(`pooled OpenCode would also read ${foreign}; run with DECISION_EVAL_OPENCODE_POOL=off`)));
					return child;
				}
				this.server({ command, args, env: options.env }).then((server) => {
					if (lease.closed) return;
					lease.server = server;
					server.leases.add(lease);
					child.pid = server.child.pid;
					child.stdout.write(`opencode server listening on ${server.url}\n`);
				}, (error) => { if (!lease.closed) child.emit('error', error); });
				return child;
			},
			terminate: async (child) => {
				const lease = this.#leases.get(child);
				if (lease === undefined) return this.#terminate(child);
				// The instance ends with its sample: its sessions, MCP connection and watchers close; the process stays.
				if (lease.server !== null && !lease.server.exited) {
					await request({ url: lease.server.url, auth: lease.server.auth }, 'POST', withDirectory('/instance/dispose', lease.directory), {}, { timeoutMs: 10_000 }).catch(() => {});
					lease.server.leases.delete(lease);
				}
				lease.exit(0, null);
			},
			request: (state, method, pathname, body, options) => {
				const { state: routed, directory } = target(state);
				return request(routed, method, directory === null ? pathname : withDirectory(pathname, directory), body, options);
			},
			openEvents: (state, onEvent) => {
				const { state: routed, directory } = target(state);
				return openInstanceEvents(routed, directory, onEvent, () => state.exited);
			},
		};
	}

	async stop() {
		const servers = [...this.#servers.values()];
		this.#servers.clear();
		await Promise.allSettled(servers.map(async (server) => {
			await server.ready?.catch(() => {});
			if (server.child !== null && !server.exited) await this.#terminate(server.child).catch(() => {});
			if (server.directory !== null) await rm(server.directory, { recursive: true, force: true }).catch(() => {});
		}));
		process.removeListener('exit', this.#onExit);
		for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, this.#onSignal);
	}
}

/** The first file above a sample directory that OpenCode's project config would add to that instance, or null (CLAUDE.md only without OPENCODE_DISABLE_CLAUDE_CODE). */
export function projectFilesAbove(directory, { claude = true } = {}) {
	const names = ['AGENTS.md', 'opencode.json', 'opencode.jsonc', '.opencode', ...(claude ? ['CLAUDE.md'] : [])];
	for (let dir = path.dirname(path.resolve(directory)); ; dir = path.dirname(dir)) {
		for (const name of names) if (existsSync(path.join(dir, name))) return path.join(dir, name);
		if (path.dirname(dir) === dir) return null;
	}
}

export function withDirectory(pathname, directory) {
	if (directory === null || directory === undefined) return pathname;
	return `${pathname}${pathname.includes('?') ? '&' : '?'}directory=${encodeURIComponent(directory)}`;
}

/** opencode-service.mjs openEventStream for one instance of a shared server: the same parsing and reconnects. */
export function openInstanceEvents(server, directory, onEvent, exited = () => false) {
	let closed = false;
	let request = null;
	const connect = () => {
		if (closed || exited()) return;
		request = http.get(new URL(withDirectory('/event', directory), server.url), { agent: false, headers: { authorization: server.auth, accept: 'text/event-stream' } }, (response) => {
			response.setEncoding('utf8');
			let buffer = '';
			response.on('data', (chunk) => {
				buffer += chunk;
				let boundary;
				while ((boundary = buffer.indexOf('\n\n')) >= 0) {
					const block = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
					if (data.length === 0) continue;
					let event;
					try { event = JSON.parse(data); } catch { continue; }
					try { onEvent(event); } catch { /* one bad event cannot stop the stream */ }
				}
			});
			response.on('end', () => { if (!closed) setTimeout(connect, 250).unref?.(); });
			response.on('error', () => {});
		});
		request.on('error', () => { if (!closed) setTimeout(connect, 500).unref?.(); });
	};
	connect();
	return { close() { closed = true; request?.destroy(); } };
}
