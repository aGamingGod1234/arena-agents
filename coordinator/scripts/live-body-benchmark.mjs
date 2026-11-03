#!/usr/bin/env node
// Provider-free live body benchmark. A real Fabric server (scripts/live-server.py --hold) runs Arena Agents with its
// coordinator off; this script connects as the coordinator, summons one agent body, installs a reflex set, and stages
// dangers with operator commands. It never drives the body: only the mod's reflex engine and vanilla act. It measures
// how often the body dies and how much health it loses with the 4 original default reflexes (lava, fire, air, edge)
// against the 10 current defaults, in alternating trials on the same world.
//
//   node coordinator/scripts/live-body-benchmark.mjs [--target 26.3] [--trials 6] [--out build/live-body-benchmark.json]
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { HeadlessRconClient } from '../src/headless-rcon.mjs';
import { MultiplexedServerBridge } from '../src/protocol-v2.mjs';
import { DEFAULT_REFLEXES } from '../src/reflexes.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const { values: options } = parseArgs({ options: {
	target: { type: 'string' }, trials: { type: 'string', default: '6' },
	out: { type: 'string', default: path.join(root, 'build', 'live-body-benchmark.json') },
	scenarios: { type: 'string' },
} });
const trials = Number(options.trials);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const AGENT = 'Bench';
const MODEL = 'gpt-6.1-sol';
const X = 100.5, Y = -60, Z = 100.5;

// The arms: the default set before the fast-danger reflexes were added, and the current one.
const ARMS = {
	original4: DEFAULT_REFLEXES.filter((rule) => ['default-lava', 'default-fire', 'default-air', 'default-edge'].includes(rule.id)),
	current10: DEFAULT_REFLEXES,
};

// Each scenario stages one danger on a fresh, full-health survival body and watches it for durationMs.
export const SCENARIOS = {
	creeper: {
		about: 'A creeper 3 blocks away walks in and lights its 1.5 s fuse.',
		durationMs: 8000,
		setup: [`summon minecraft:creeper ${X + 3} ${Y} ${Z} {PersistenceRequired:1b}`],
	},
	skeleton_arrows: {
		about: 'A skeleton 10 blocks away shoots; the body holds a shield in its offhand.',
		durationMs: 10000,
		setup: [`item replace entity ${AGENT} weapon.offhand with minecraft:shield`, `summon minecraft:skeleton ${X + 10} ${Y} ${Z} {PersistenceRequired:1b}`],
	},
	hungry: {
		about: 'Hunger drained below 14 of 20 with cooked beef in the hotbar and no hostile near.',
		durationMs: 12000,
		setup: [`item replace entity ${AGENT} hotbar.0 with minecraft:cooked_beef 8`, `effect give ${AGENT} minecraft:hunger 6 250 true`],
		settleMs: 6500,
		measureFood: true,
	},
	low_health_zombie: {
		about: 'The body is at 6 HP (3 hearts), with no saturation left to heal fast, beside a zombie 2.5 blocks away.',
		durationMs: 10000,
		// A short strong hunger burns the saturation (and some food), so neither arm out-heals the zombie for free.
		setup: [`effect give ${AGENT} minecraft:hunger 2 250 true`, 2500, `damage ${AGENT} 14 minecraft:generic`,
			`summon minecraft:zombie ${X + 2.5} ${Y} ${Z} {PersistenceRequired:1b}`],
	},
};
// Suffocation is not staged: a fake player sealed in stone took 1 HP and then no more, with or without reflexes,
// so it measured nothing. The zombie runs last because it kills, and every trial must start from a live body.
const chosen = options.scenarios ? options.scenarios.split(',') : Object.keys(SCENARIOS);

function startServer() {
	const args = ['scripts/live-server.py', '--hold', ...(options.target ? ['--target', options.target] : [])];
	const child = spawn('python3', args, { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
	return new Promise((resolve, reject) => {
		const lines = createInterface({ input: child.stdout });
		lines.on('line', (line) => { if (line.startsWith('{')) resolve({ child, info: JSON.parse(line) }); });
		child.once('exit', (code) => reject(new Error(`live server exited with ${code} before it was ready`)));
	});
}

class Inbox {
	events = []; waiters = [];
	constructor(bridge) { bridge.on('message', (event) => this.accept(event)); bridge.on('ready', (event) => this.accept({ type: 'ready', ...event })); }
	accept(event) {
		const index = this.waiters.findIndex((waiter) => waiter.type === event.type && waiter.match(event));
		if (index >= 0) this.waiters.splice(index, 1)[0].done(event);
		else { this.events.push(event); if (this.events.length > 512) this.events.shift(); }
	}
	wait(type, match = () => true, ms = 60000) {
		const index = this.events.findIndex((event) => event.type === type && match(event));
		if (index >= 0) return Promise.resolve(this.events.splice(index, 1)[0]);
		return new Promise((resolve, reject) => {
			const waiter = { type, match, done: (event) => { clearTimeout(timer); resolve(event); } };
			const timer = setTimeout(() => { this.waiters = this.waiters.filter((other) => other !== waiter); reject(new Error(`timed out waiting for ${type}`)); }, ms);
			this.waiters.push(waiter);
		});
	}
}

// Server snapshots contain a bounded, cumulative event window, including older rule sets.
// Keep every received event for this install; the staging sequence excludes pre-trial history.
export function trackBenchmarkReflexes({ bridge, inbox, record }) {
	let revision = 0, seen = 0;
	const events = new Map();
	bridge.on('observation', (event) => {
		if (event.agentId !== record.agentId) return;
		const observation = event.payload;
		seen = Math.max(seen, observation.eventSequence ?? 0);
		if (observation.reflexes?.revision !== revision) return;
		// Terminal observations may carry final events even when ready is false.
		for (const event of observation.reflexes.events ?? []) events.set(event.seq, event);
	});
	return {
		begin(nextRevision) { revision = nextRevision; events.clear(); },
		async status({ died = false } = {}) {
			if (died) return null;
			const after = seen;
			const next = inbox.wait('observation', (event) => event.agentId === record.agentId
				&& event.payload.eventSequence > after
				&& (!event.payload.ready || event.payload.reflexes?.revision === revision), 10000).catch(() => null);
			await bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision });
			const status = (await next)?.payload?.reflexes;
			return status?.revision === revision ? status : null;
		},
		firings(seqBefore) {
			return [...events.values()].filter((event) => (event.seq ?? 0) > seqBefore)
				.sort((a, b) => a.seq - b.seq).map((event) => `${event.id}:${event.outcome}`);
		},
	};
}

const number = (text) => { const match = /(-?[0-9.]+)[fdbs]?\s*$/.exec(text ?? ''); return match ? Number(match[1]) : null; };

// Retry only setup failures, never gameplay outcomes. Three attempts bound a broken staging run.
export async function stageBenchmarkTrial({ scenario, rules, reset, install, reflexStatus, command, sleep, onRejected }) {
	for (let attempt = 1; attempt <= 3; attempt++) {
		await reset();
		await install(rules);
		const status = await reflexStatus();
		const seqBefore = Math.max(0, ...(status?.events ?? []).map((event) => event.seq ?? 0));
		await sleep(500);
		const startHealth = number(await command(`data get entity ${AGENT} Health`));
		let reason = startHealth === 20 ? null : 'Reset must produce a live body at 20 HP';
		if (!reason && !status) reason = 'Installed reflex status must be observed before staging';
		let startFood = null, stagedSaturation = null, stagedHealth = null;
		if (!reason) {
			for (const step of scenario.setup) await (typeof step === 'number' ? sleep(step) : command(step));
			if (scenario.settleMs) await sleep(scenario.settleMs);
			startFood = number(await command(`data get entity ${AGENT} foodLevel`));
			if (scenario === SCENARIOS.low_health_zombie) {
				stagedSaturation = number(await command(`data get entity ${AGENT} foodSaturationLevel`));
			}
			// Read health last, immediately before the caller starts the survival timer.
			stagedHealth = number(await command(`data get entity ${AGENT} Health`));
			if (!Number.isFinite(stagedHealth) || stagedHealth <= 0) reason = 'Staged body must be alive';
			if (scenario === SCENARIOS.low_health_zombie) {
				if (stagedHealth !== 6) reason = 'Zombie setup must start at 6 HP';
				else if (stagedSaturation !== 0) reason = 'Zombie setup must have zero saturation';
			}
			if (scenario.measureFood && (!Number.isFinite(startFood) || startFood >= 14 || startFood < 0)) {
				reason = 'Hungry setup must start with food below 14';
			}
		}
		const state = { startHealth, startFood, stagedHealth, stagedSaturation, seqBefore };
		if (!reason) return state;
		onRejected({ attempt, ...state, reason });
	}
	return null;
}

async function main() {
	const { child, info } = await startServer();
	const rcon = new HeadlessRconClient({ host: '127.0.0.1', port: info.rconPort, password: info.rconPassword, commandTimeoutMs: 10000 });
	await rcon.connect();
	const command = async (text) => (await rcon.command(text)).text;
	const bridge = new MultiplexedServerBridge({ port: info.bridgePort, secret: info.bridgeSecret }, {});
	const inbox = new Inbox(bridge);
	let record;
	bridge.on('goal_spec_request', (event) => {
		bridge.send('goal_spec_proposal', event.agentId, { requestId: event.payload.requestId, summary: 'Live body benchmark', predicate: { type: 'survive_duration', ticks: 1_200_000 } }).catch(() => {});
	});
	const results = [], setupFailures = [];
	let incomplete = false;
	try {
		const ready = inbox.wait('ready', () => true, 120000);
		bridge.start();
		await ready;
		await bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: MODEL, id: MODEL, displayName: 'Provider-free benchmark body', reasoningEfforts: ['low'], serviceTiers: ['priority'] }] });
		for (const setup of ['gamerule minecraft:send_command_feedback false', 'gamerule minecraft:spawn_mobs false', 'gamerule minecraft:advance_time false',
			'difficulty normal', 'time set 18000', 'weather clear', `forceload add ${X - 48} ${Z - 48} ${X + 48} ${Z + 48}`]) await command(setup);
		await sleep(2000);
		const registered = inbox.wait('agent_registered');
		await command(`execute positioned ${X} ${Y} ${Z} run codex summon ${MODEL} low ${AGENT}`);
		const event = await registered;
		record = { ...(event.payload.record ?? event.payload), agentId: event.agentId };
		// No goal: reflex rules are not tied to a goal revision, and an idle body is the fair baseline for both arms.
		await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
		await command(`gamemode survival ${AGENT}`);
		await sleep(4000); // spawn invulnerability

		let revision = 0;
		const reflexHistory = trackBenchmarkReflexes({ bridge, inbox, record });
		const install = async (rules) => {
			reflexHistory.begin(++revision);
			await bridge.send('reflex_update', record.agentId, { revision, rules: structuredClone(rules), yield: false });
		};
		const reflexStatus = () => reflexHistory.status();
		const alive = async () => { const health = number(await command(`data get entity ${AGENT} Health`)); return health !== null && health > 0; };
		const reset = async () => {
			if (!(await alive())) {
				await command(`codex respawn ${AGENT}`);
				for (let i = 0; i < 40 && !(await alive()); i++) await sleep(500);
				await command(`gamemode survival ${AGENT}`);
				await sleep(3500); // spawn invulnerability
			}
			await command(`kill @e[type=!minecraft:player,distance=..64,x=${X},y=${Y},z=${Z}]`);
			// Rebuild the generated flat-world layers, including the approach/escape area.
			// Clearing air alone leaves earlier creeper craters below the body's feet.
			const x0 = Math.floor(X) - 48, x1 = Math.floor(X) + 48;
			const z0 = Math.floor(Z) - 48, z1 = Math.floor(Z) + 48;
			for (const [bottom, top, block] of [[Y - 4, Y - 4, 'bedrock'], [Y - 3, Y - 2, 'dirt'], [Y - 1, Y - 1, 'grass_block'],
				[Y, Y + 2, 'air'], [Y + 3, Y + 4, 'air']]) {
				// Split headroom fills to stay below the vanilla 32,768-block command limit.
				await command(`fill ${x0} ${bottom} ${z0} ${x1} ${top} ${z1} minecraft:${block}`);
			}
			await command(`tp ${AGENT} ${X} ${Y} ${Z} 90 0`);
			await command(`clear ${AGENT}`);
			await command(`effect clear ${AGENT}`);
			await command(`effect give ${AGENT} minecraft:instant_health 1 10 true`);
			await command(`effect give ${AGENT} minecraft:saturation 1 20 true`);
			await sleep(1500);
			const supportedY = number(await command(`execute positioned ${X} ${Y} ${Z} if entity @a[name=${AGENT},distance=..0.01] if block ~ ~-1 ~ minecraft:grass_block if block ~ ~ ~ minecraft:air if block ~ ~1 ~ minecraft:air run data get entity ${AGENT} Pos[1]`));
			if (supportedY !== Y) throw new Error('Reset must produce the supported benchmark position before staging');
		};
		scenarios: for (const name of chosen) {
			const scenario = SCENARIOS[name];
			for (let trial = 0; trial < trials; trial++) {
				for (const arm of trial % 2 === 0 ? ['original4', 'current10'] : ['current10', 'original4']) {
					const staged = await stageBenchmarkTrial({ scenario, rules: ARMS[arm], reset, install, reflexStatus, command, sleep,
						onRejected: (failure) => {
							const row = { scenario: name, arm, trial, ...failure };
							setupFailures.push(row);
							console.error(JSON.stringify({ setupFailure: row }));
						} });
					if (!staged) { incomplete = true; break scenarios; }
					const { startHealth, startFood, stagedHealth, stagedSaturation, seqBefore } = staged;
					let minHealth = stagedHealth, died = false, survivedMs = scenario.durationMs;
					const began = Date.now(), deadline = began + scenario.durationMs;
					while (Date.now() < deadline) {
						await sleep(250);
						const health = number(await command(`data get entity ${AGENT} Health`));
						if (health === null || health <= 0) { died = true; survivedMs = Date.now() - began; break; }
						minHealth = Math.min(minHealth, health);
					}
					const endHealth = died ? 0 : number(await command(`data get entity ${AGENT} Health`));
					const endFood = died ? null : number(await command(`data get entity ${AGENT} foodLevel`));
					const row = { scenario: name, arm, trial, died, survivedMs, startHealth, stagedHealth, minHealth: died ? 0 : minHealth, endHealth,
						healthLost: Math.max(0, (stagedHealth ?? 20) - (died ? 0 : endHealth ?? 0)), ...(scenario.measureFood ? { startFood, endFood } : {}),
						...(scenario === SCENARIOS.low_health_zombie ? { stagedSaturation } : {}) };
					await reflexHistory.status({ died });
					row.firings = reflexHistory.firings(seqBefore);
					results.push(row);
					console.log(JSON.stringify(row));
				}
			}
		}
	} finally {
		try { await command('stop'); } catch {}
		bridge.stop(); await rcon.close().catch(() => {});
		child.stdin.end();
		await new Promise((resolve) => child.once('exit', resolve));
	}
	const summary = {};
	for (const name of chosen) for (const arm of Object.keys(ARMS)) {
		const rows = results.filter((row) => row.scenario === name && row.arm === arm);
		const mean = (values) => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10 : null;
		summary[`${name}/${arm}`] = { trials: rows.length, deaths: rows.filter((row) => row.died).length, meanHealthLost: mean(rows.map((row) => row.healthLost)),
			...(SCENARIOS[name].measureFood ? { meanEndFood: mean(rows.filter((row) => !row.died).map((row) => row.endFood)),
				eats: rows.reduce((count, row) => count + row.firings.filter((firing) => firing === 'default-eat:done').length, 0) } : {}),
			meanSurvivedS: mean(rows.map((row) => row.survivedMs / 1000)) };
	}
	const report = { kind: 'provider-free live body benchmark', status: incomplete ? 'incomplete-invalid-setup' : 'complete', setupFailures, minecraftVersion: info.minecraftVersion, target: info.target, trialsPerArm: trials,
		arms: Object.fromEntries(Object.entries(ARMS).map(([name, rules]) => [name, rules.map((rule) => rule.id)])),
		scenarios: Object.fromEntries(chosen.map((name) => [name, SCENARIOS[name].about])), summary, results };
	await mkdir(path.dirname(options.out), { recursive: true });
	await writeFile(options.out, JSON.stringify(report, null, 2));
	console.table(summary);
	if (incomplete) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
