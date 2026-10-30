#!/usr/bin/env node
// Provider-free check of the combat and hazard reflex vocabulary (rx-combat) in a real server: this script stands in for
// the coordinator, installs rules over the bridge (as a model's runProgram({reflexes}) would) and checks what the mod does:
// deflect a ghast fireball, sprint from a fusing creeper, sneak at a drop, step away from lava, look away from an
// enderman, wall off a skeleton, take cover behind a wall, walk to a named cell, turn on a mob attacking from behind,
// and keep a raised shield up when an arrow trigger takes over from a shield stance. rx-fight adds: walk behind a held shield,
// a shield stance riding on a fight, a yielded stance returning after the model's command, and a fight bail-out handing the
// body to the model's rules. airYield: a yielded air trigger fires again once the model's short command ends underwater.
// Always launch under slot.sh live; ports come from SLOT_PORT_BASE. Operator commands build fixtures and spawn mobs only.
import { readFile, writeFile, mkdir, cp, readdir, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { normalizeReflexEntries } from '../../coordinator/src/reflexes.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = resolve(process.argv[2] ?? 'runtime/reflex-combat-live');
const template = process.env.ARENA_HEADLESS_SERVER_TEMPLATE;
if (!template || !process.env.SLOT_PORT_BASE) throw new Error('Set ARENA_HEADLESS_SERVER_TEMPLATE and launch under slot.sh live');
const jar = resolve(process.env.ARENA_JAR ?? join(root, 'build/libs/arena-agents-0.2.0.jar'));
const port = Number(process.env.SLOT_PORT_BASE), server = join(out, 'server');
await mkdir(out, { recursive: true });
if ((await readdir(out)).length) throw new Error('Use a fresh output directory');
await writeFile(join(out, 'manifest.json'), JSON.stringify({ kind: 'provider-free live mechanics', aiPerformanceMeasured: false, fixtureSetupUsesOperatorCommands: true,
	jarSha256: createHash('sha256').update(await readFile(jar)).digest('hex'), node: process.version }, null, 2));
await cp(template, server, { recursive: true });
for (const name of await readdir(join(server, 'mods'))) if (name.startsWith('arena-agents-')) await unlink(join(server, 'mods', name));
await cp(jar, join(server, 'mods/arena-agents-0.2.0.jar'));
const secret = randomBytes(32).toString('hex');
await writeFile(join(out, 'secret.txt'), secret, { mode: 0o600 });
await writeFile(join(server, 'server.properties'), `online-mode=false\nserver-ip=127.0.0.1\nserver-port=${port + 2}\nenable-rcon=true\nrcon.ip=127.0.0.1\nrcon.port=${port + 1}\nrcon.password=${secret}\nlevel-name=world\nlevel-seed=20261018\nlevel-type=minecraft:flat\ngenerator-settings={"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":3}],"biome":"minecraft:plains"}\nspawn-protection=0\nview-distance=5\nsimulation-distance=5\npause-when-empty-seconds=-1\nmax-players=4\nspawn-monsters=false\n`);
const log = await open(join(out, 'server.log'), 'a');
const child = spawn(`${process.env.JAVA_HOME}/bin/java`, [`-Darenaagents.bridgePort=${port}`, '-Darenaagents.coordinatorAutoStart=false', `-Darenaagents.bridgeSecretFile=${join(out, 'secret.txt')}`, '-Xms512M', '-Xmx2G', '-jar', 'fabric-server-launch.jar', 'nogui'], { cwd: server, stdio: ['ignore', log.fd, log.fd] });
await writeFile(join(out, 'server.pid'), String(child.pid));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

class Inbox {
	events = []; waiters = [];
	constructor(bridge) { bridge.on('message', (event) => this.accept(event)); bridge.on('ready', (event) => this.accept({ type: 'ready', ...event })); }
	accept(event) { const index = this.waiters.findIndex((waiter) => waiter.type === event.type && waiter.match(event)); if (index >= 0) this.waiters.splice(index, 1)[0].done(event); else { this.events.push(event); if (this.events.length > 1024) this.events.shift(); } }
	wait(type, match = () => true, ms = 30000) {
		const index = this.events.findIndex((event) => event.type === type && match(event));
		if (index >= 0) return Promise.resolve(this.events.splice(index, 1)[0]);
		return new Promise((resolveWait, reject) => { const waiter = { type, match, done: (event) => { clearTimeout(timer); resolveWait(event); } }; const timer = setTimeout(() => { this.waiters = this.waiters.filter((entry) => entry !== waiter); reject(new Error(`TIMEOUT ${type}`)); }, ms); this.waiters.push(waiter); });
	}
}

let rcon, bridge, record, observation, inbox, revision = 0, ordinal = 0, armed = [];
const agent = 'Reflex';
const timeline = [];
const command = async (text) => {
	if (rcon.state === 'closed') { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, commandTimeoutMs: 5000 }); await rcon.connect(); }
	return (await rcon.command(text)).text;
};
async function observe() {
	const sequence = observation?.eventSequence ?? 0;
	const next = inbox.wait('observation', (event) => event.agentId === record.agentId && event.payload.ready && event.payload.eventSequence > sequence);
	await bridge.send('request_observation', record.agentId, { goalRevision: record.goalRevision });
	return (await next).payload;
}
/** As the coordinator sends a model's rules: normalized by reflexes.mjs, the complete set, a new revision. */
async function setReflexes(rules) {
	revision += 1;
	armed = rules;
	await bridge.send('reflex_update', record.agentId, { revision, rules: normalizeReflexEntries(rules), yield: false });
	for (let index = 0; index < 40; index += 1) { const o = await observe(); if (o.reflexes?.revision === revision) return o; await sleep(100); }
	throw new Error(`reflex revision ${revision} never echoed`);
}
/** What the coordinator sends before a direct model body command while a reflex fires: the same rules, yield set. */
async function yieldReflexes() {
	revision += 1;
	await bridge.send('reflex_update', record.agentId, { revision, rules: normalizeReflexEntries(armed), yield: true });
}
function startAction(type, args) {
	const id = `reflex-${++ordinal}`;
	const payload = { actionId: id, traceId: id, goalRevision: record.goalRevision, actionType: type, arguments: args,
		provenance: { provider: record.provider, model: record.model, reasoningEffort: record.reasoningEffort, serviceTier: record.serviceTier, traceId: id, programId: 'reflex-fixture', programVersion: 1, sourceStepId: id, eventSequence: observation?.eventSequence ?? 0 } };
	const result = inbox.wait('action_result', (event) => event.payload.actionId === id && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(event.payload.state), 90000)
		.then(async (event) => { await bridge.send('action_result_ack', record.agentId, { actionId: id, goalRevision: record.goalRevision }); return event.payload; });
	return bridge.send('action_command', record.agentId, payload).then(() => ({ id, result }));
}
const events = (o, id) => (o.reflexes?.events ?? []).filter((event) => event.id === id);
const health = (o) => o.player?.health;

const results = {};
const only = (process.env.REFLEX_ONLY ?? '').split(',').filter(Boolean);
let o;
try {
	for (let attempt = 0; attempt < 150; attempt += 1) { try { rcon = new HeadlessRconClient({ host: '127.0.0.1', port: port + 1, password: secret, connectTimeoutMs: 500, commandTimeoutMs: 5000 }); await rcon.connect(); break; } catch (error) { await rcon?.close(); if (attempt === 149) throw error; await sleep(1000); } }
	bridge = new MultiplexedServerBridge({ port, secret }, {}); inbox = new Inbox(bridge);
	bridge.on('observation', (event) => {
		if (event.agentId !== record?.agentId || !event.payload.ready) return;
		observation = event.payload;
		const firing = event.payload.reflexes?.firing;
		timeline.push({ at: Date.now(), firing: firing?.id ?? null, detail: firing?.detail ?? null, using: event.payload.interaction?.usingItem ?? null, x: event.payload.position?.x, action: event.payload.currentAction?.active ? event.payload.currentAction.actionId ?? true : false, health: event.payload.player?.health, incoming: (event.payload.incomingProjectiles ?? []).map((row) => `${row.type}@${row.etaSeconds}`), yaw: event.payload.view?.yaw, air: event.payload.player?.air, y: event.payload.position?.y });
	});
	// Follow goal revisions (the accepted goal spec bumps it); reflex rules are not tied to a revision.
	bridge.on('message', (event) => {
		if (!['observation', 'action_progress', 'heartbeat'].includes(event.type)) console.log(`[in] ${event.type} ${JSON.stringify(event.payload).slice(0, 160)}`);
		const registered = ['agent_registered', 'registry_entry'].includes(event.type) ? { goalRevision: event.payload.goalRevision ?? event.payload.record?.goalRevision, operation: 'registered' } : null;
		const control = registered ?? (event.type === 'goal_control' ? event.payload : event.type === 'conversation_wake' ? event.payload.control : null);
		if (control == null || event.agentId !== record?.agentId || !Number.isSafeInteger(control.goalRevision) || control.goalRevision <= record.goalRevision) return;
		if (['queue', 'dequeue'].includes(control.operation)) return;
		record.goalRevision = control.goalRevision;
		bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false }).catch(() => {});
	});
	bridge.on('goal_spec_request', (event) => { bridge.send('goal_spec_proposal', event.agentId, { requestId: event.payload.requestId, summary: 'Controlled live reflex fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
	const ready = inbox.wait('ready'); bridge.start(); await ready;
	await bridge.send('catalog_snapshot', 'server', { refreshedAtEpochMs: Date.now(), models: [{ provider: 'codex', model: 'gpt-6.1-sol', id: 'gpt-6.1-sol', displayName: 'Provider-free reflex fixture', reasoningEfforts: ['low'], serviceTiers: ['default'] }] });
	await command('difficulty normal'); await command('gamerule minecraft:send_command_feedback false'); await command('gamerule minecraft:spawn_mobs false');
	await command('time set noon'); await command('forceload add -32 -32 48 48'); await sleep(2000);
	await command('fill -24 75 -24 40 95 40 minecraft:air'); await command('fill -24 79 -24 40 79 40 minecraft:stone');
	const registered = inbox.wait('agent_registered'); console.log(await command(`execute positioned 0.5 80 0.5 run codex summon gpt-6.1-sol low ${agent}`));
	const summoned = await registered; record = { ...(summoned.payload.record ?? summoned.payload), agentId: summoned.agentId };
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	const started = inbox.wait('goal_control', (event) => event.payload.operation === 'start'); await command(`codex start ${agent} Survive for 1200 seconds.`); record.goalRevision = (await started).payload.goalRevision;
	await bridge.send('agent_ready', record.agentId, { goalRevision: record.goalRevision, reconciled: false });
	await sleep(2000); await observe();
	await command(`gamemode survival ${agent}`); await command(`clear ${agent}`);
	await command(`effect give ${agent} minecraft:saturation 5 10 true`);


	const reset = async () => {
		await command('kill @e[type=!minecraft:player]');
		// Each fill stays under vanilla's 32,768-block limit (a larger one is refused and leaves the last fixture standing).
		for (const fill of ['-12 80 -12 20 90 24 minecraft:air', '-12 79 -12 20 79 24 minecraft:stone', '-2 70 -1 2 78 6 minecraft:stone']) {
			const reply = await command(`fill ${fill}`);
			if (/too many|cannot|error/i.test(reply)) throw new Error(`reset fill refused: ${reply}`);
		}
		await command(`effect give ${agent} minecraft:instant_health 1 5 true`); await command(`effect give ${agent} minecraft:saturation 2 10 true`);
		await command(`clear ${agent}`); await command(`tp ${agent} 0.5 80 0.5 0 0`);
		await setReflexes([]);
		await sleep(1000);
	};
	const selected = (name) => only.length === 0 || only.includes(name);
	// Each scenario runs on its own: a failure is recorded and the next one still runs; results are saved as they come.
	const scenarios = [];
	const want = (name) => selected(name) && (scenarios.push(name), true);
	const settle = async (name, error) => {
		if (error) results[name] = { ...(results[name] ?? {}), pass: false, error: String(error?.stack ?? error).slice(0, 400) };
		await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
		await writeFile(join(out, 'timeline.json'), JSON.stringify(timeline, null, 1));
		console.log(`[scenario] ${name}: ${results[name]?.pass ? 'PASS' : 'FAIL'}`);
	};
	const debug = process.env.REFLEX_DEBUG === '1';
	const until = async (ms, test) => { const end = Date.now() + ms; while (Date.now() < end) { o = await observe(); if (debug) console.log(`[debug] ${JSON.stringify({ rules: o.reflexes?.rules, firing: o.reflexes?.firing, error: o.reflexes?.error, pos: o.position })}`); if (test(o)) return true; await sleep(debug ? 1000 : 250); } return false; };
	const block = async (x, y, z) => (await command(`execute if block ${x} ${y} ${z} minecraft:air`)).includes('passed') ? 'air' : 'solid';
	const firingSeen = (id) => timeline.some((row) => row.firing === id);

	// Ghast fireball: punch it back (vanilla deflection along the view).
	if (want('deflect')) {
		try {
			await reset();
			await command(`item replace entity ${agent} weapon.mainhand with minecraft:iron_sword`);
			o = await setReflexes([{ id: 'punch', priority: 8, when: { type: 'fireball_incoming', withinS: 2, deflectable: true }, do: { type: 'deflect' }, maxS: 3, cooldownS: 0.25 }]);
			const before = health(o);
			await command('summon minecraft:ghast 0.5 82 22.5');
			await until(45000, (now) => events(now, 'punch').filter((row) => row.outcome === 'done').length >= 2);
			results.deflect = { events: events(o, 'punch'), healthBefore: before, health: health(o) };
			results.deflect.pass = events(o, 'punch').some((row) => row.outcome === 'done' && /deflected/.test(row.detail ?? ''));
			await settle('deflect');
		} catch (error) { await settle('deflect', error); }
	}
	// Creeper fuse: sprint away before it blows.
	if (want('creeper')) {
		try {
			await reset();
			o = await setReflexes([{ id: 'fuse', priority: 9, when: { type: 'creeper_fusing', within: 5 }, do: { type: 'sprint_away', blocks: 8 }, maxS: 4 }]);
			const before = health(o);
			await command('summon minecraft:creeper 0.5 80 5.5');
			await until(20000, (now) => events(now, 'fuse').some((row) => row.outcome === 'done'));
			await sleep(3000); o = await observe();
			results.creeper = { events: events(o, 'fuse'), healthBefore: before, health: health(o), creeperAlive: (await command('execute if entity @e[type=minecraft:creeper]')).includes('passed') };
			results.creeper.pass = events(o, 'fuse').some((row) => row.outcome === 'done' && /ran/.test(row.detail ?? '')) && health(o) >= before - 2;
			await settle('creeper');
		} catch (error) { await settle('creeper', error); }
	}
	// rx-diag (R-CREEPER): on a cliff edge with the creeper coming from inland, sprint_away runs along the edge. Before, the
	// knockback margin refused every heading once the creeper was within 3 blocks, so the body stood still and the blast
	// threw it off.
	if (want('creeperEdge')) {
		try {
			await reset();
			await command('fill 0 80 -6 12 87 6 minecraft:stone');
			await command(`tp ${agent} 6.5 88 6.5 180 20`);
			await sleep(1500); await observe();
			o = await setReflexes([{ id: 'fuse', priority: 9, when: { type: 'creeper_fusing', within: 5 }, do: { type: 'sprint_away', blocks: 8 }, maxS: 4 },
				{ id: 'close', priority: 8, when: { type: 'hostile_near', within: 4, mobs: ['creeper'] }, do: { type: 'sprint_away', blocks: 8 }, maxS: 3 }]);
			const before = health(o);
			// Reports outlive a rule set; count only this scenario's firings.
			const since = Math.max(0, ...(o.reflexes?.events ?? []).map((row) => row.seq ?? 0));
			const mine = (now) => [...events(now, 'fuse'), ...events(now, 'close')].filter((row) => (row.seq ?? 0) > since);
			await command('summon minecraft:creeper 6.5 88 1.5');
			// Until a firing has ended and none runs (the creeper gave up or blew), or the body fell.
			await until(20000, (now) => (!now.reflexes?.firing && mine(now).length > 0) || (now.position?.y ?? 88) < 87);
			await sleep(4000); o = await observe();
			const all = mine(o);
			results.creeperEdge = { events: all, healthBefore: before, health: health(o), y: o.position?.y, x: o.position?.x, z: o.position?.z };
			results.creeperEdge.pass = all.some((row) => row.outcome === 'done' && /ran/.test(row.detail ?? '')) && !all.some((row) => /no safe heading away/.test(row.detail ?? ''))
				&& (o.position?.y ?? 0) >= 87.9;
			await settle('creeperEdge');
		} catch (error) { await settle('creeperEdge', error); }
	}
	// rx-diag (R-FLOOD): low air in a flooded 1-wide staircase whose only air is a chimney at the top step. swim_up follows
	// the seen route there; before, it held jump against the stone ceiling until the body drowned.
	if (want('floodTunnel')) {
		try {
			await reset();
			const at = 'execute positioned 14.31 81 18.69 run';
			for (const fill of ['fill ~-3 ~-2 ~-7 ~3 ~9 ~3 minecraft:stone', 'fill ~0 ~0 ~0 ~0 ~2 ~0 minecraft:water', 'fill ~0 ~1 ~-1 ~0 ~3 ~-1 minecraft:water',
				'fill ~0 ~2 ~-2 ~0 ~4 ~-2 minecraft:water', 'fill ~0 ~3 ~-3 ~0 ~5 ~-3 minecraft:water', 'fill ~0 ~4 ~-4 ~0 ~6 ~-4 minecraft:water',
				'fill ~0 ~5 ~-5 ~0 ~7 ~-5 minecraft:water', 'fill ~0 ~7 ~-5 ~0 ~8 ~-5 minecraft:air']) await command(`${at} ${fill}`);
			await command(`tp ${agent} 14.31 81 18.69 180 0`);
			o = await setReflexes([{ id: 'air', priority: 9, when: { type: 'air_below', bubbles: 6 }, do: { type: 'swim_up' }, maxS: 12 }]);
			const since = Math.max(0, ...(o.reflexes?.events ?? []).map((row) => row.seq ?? 0));
			let lowestAir = 300;
			const deadline = Date.now() + 30000;
			while (Date.now() < deadline) {
				o = await observe();
				lowestAir = Math.min(lowestAir, o.player?.air ?? 300);
				if (events(o, 'air').some((row) => row.seq > since && ['done', 'failed', 'timeout'].includes(row.outcome))) break;
				await sleep(250);
			}
			await sleep(1500); o = await observe();
			results.floodTunnel = { events: events(o, 'air').filter((row) => row.seq > since), lowestAir, position: o.position, air: o.player?.air, health: health(o) };
			results.floodTunnel.pass = results.floodTunnel.events.some((row) => row.outcome === 'done' && /surfaced/.test(row.detail ?? '')) && (o.player?.air ?? 0) > lowestAir
				&& health(o) > 0;
			await command(`tp ${agent} 0.5 80 0.5 0 0`);
			await settle('floodTunnel');
		} catch (error) { await settle('floodTunnel', error); }
	}
	// A drop ahead: sneak (stand still, cannot walk off) while it is there.
	if (want('edge')) {
		try {
			await reset();
			await command('fill -1 70 2 1 79 4 minecraft:air');
			await command(`tp ${agent} 0.5 80 1.6 0 0`);
			o = await setReflexes([{ id: 'edge', kind: 'stance', priority: 8, when: { type: 'edge_near', within: 1, direction: 'ahead', drop: 4 }, do: { type: 'sneak' }, maxS: 2 }]);
			const seen = await until(5000, (now) => now.reflexes?.firing?.id === 'edge' || events(now, 'edge').length > 0);
			await command(`tp ${agent} 0.5 80 -6.5 0 0`);
			await until(4000, (now) => now.reflexes?.firing == null);
			results.edge = { seen, events: events(o, 'edge'), firingAfterMove: o.reflexes?.firing ?? null };
			results.edge.pass = seen && o.reflexes?.firing == null;
			await settle('edge');
		} catch (error) { await settle('edge', error); }
	}
	// Lava beside the feet: step away from it.
	if (want('lava')) {
		try {
			await reset();
			await command('setblock 0 79 2 minecraft:lava');
			await command(`tp ${agent} 0.5 80 0.8 0 0`);
			o = await setReflexes([{ id: 'lava', priority: 9, when: { type: 'lava_near', within: 2 }, do: { type: 'sprint_away', blocks: 3 }, maxS: 3 }]);
			await until(8000, (now) => events(now, 'lava').some((row) => ['done', 'failed'].includes(row.outcome)));
			results.lava = { events: events(o, 'lava'), z: o.position?.z };
			results.lava.pass = events(o, 'lava').some((row) => row.outcome === 'done') && (o.position?.z ?? 9) < 0;
			await settle('lava');
		} catch (error) { await settle('lava', error); }
	}
	// Enderman stare: look away before it is provoked.
	if (want('enderman')) {
		try {
			await reset();
			await command('summon minecraft:enderman 0.5 80 8.5 {NoAI:1b,Rotation:[180f,0f]}');
			await command(`tp ${agent} 0.5 80 0.5 0 -6.6`);
			o = await setReflexes([{ id: 'stare', priority: 8, when: { type: 'enderman_gaze', within: 32 }, do: { type: 'look_away' }, maxS: 2 }]);
			await until(6000, (now) => events(now, 'stare').some((row) => row.outcome === 'done'));
			results.enderman = { events: events(o, 'stare'), pitch: o.view?.pitch };
			results.enderman.pass = events(o, 'stare').some((row) => row.outcome === 'done' && /looked away/.test(row.detail ?? ''));
			await settle('enderman');
		} catch (error) { await settle('enderman', error); }
	}
	// Skeleton in the open: wall it off with two blocks from the hotbar.
	if (want('wall')) {
		try {
			await reset();
			await command(`item replace entity ${agent} hotbar.0 with minecraft:iron_sword`);
			await command(`item replace entity ${agent} hotbar.4 with minecraft:cobblestone 16`);
			await command('time set midnight');
			o = await setReflexes([{ id: 'wall', priority: 7, when: { type: 'exposed', within: 24, mobs: ['skeleton'] }, do: { type: 'place_block', count: 2 }, maxS: 4, maxFirings: 1 }]);
			await command('summon minecraft:skeleton 0.5 80 12.5');
			await until(10000, (now) => events(now, 'wall').some((row) => ['done', 'failed'].includes(row.outcome)));
			results.wall = { events: events(o, 'wall'), feet: await block(0, 80, 1), head: await block(0, 81, 1), selected: o.inventory?.selectedSlot };
			results.wall.pass = results.wall.feet === 'solid' && results.wall.head === 'solid' && results.wall.selected === 0;
			await command('time set noon');
			await settle('wall');
		} catch (error) { await settle('wall', error); }
	}
	// Skeleton in the open with a wall to the side: back off out of its sight.
	if (want('cover')) {
		try {
			await reset();
			await command('fill -5 80 4 -2 82 4 minecraft:stone');
			await command('time set midnight');
			o = await setReflexes([{ id: 'hide', priority: 7, when: { type: 'exposed', within: 24, mobs: ['skeleton'] }, do: { type: 'take_cover', within: 8 }, maxS: 6, maxFirings: 1 }]);
			await command('summon minecraft:skeleton 0.5 80 14.5 {NoAI:1b}');
			await until(12000, (now) => events(now, 'hide').some((row) => ['done', 'failed', 'timeout'].includes(row.outcome)));
			results.cover = { events: events(o, 'hide'), position: o.position, skeleton: await command('data get entity @e[type=minecraft:skeleton,limit=1] Pos'), entities: (o.entities ?? o.nearbyEntities ?? []).slice(0, 4) };
			results.cover.pass = events(o, 'hide').some((row) => row.outcome === 'done' && /in cover at/.test(row.detail ?? ''));
			await command('time set noon');
			await settle('cover');
		} catch (error) { await settle('cover', error); }
	}
	// Low health names no mob: cover from every hostile that can see the player.
	if (want('coverLow')) {
		try {
			await reset();
			await command('fill -5 80 4 -2 82 4 minecraft:stone');
			await command('time set midnight');
			await command('summon minecraft:skeleton 0.5 80 14.5 {NoAI:1b}');
			o = await setReflexes([{ id: 'low', priority: 9, when: { type: 'health_below', value: 20 }, do: { type: 'take_cover', within: 8 }, maxS: 6, maxFirings: 1 }]);
			await command(`damage ${agent} 2 minecraft:generic`);
			await until(12000, (now) => events(now, 'low').some((row) => ['done', 'failed', 'timeout'].includes(row.outcome)));
			results.coverLow = { events: events(o, 'low'), position: o.position };
			results.coverLow.pass = events(o, 'low').some((row) => row.outcome === 'done' && /in cover at/.test(row.detail ?? ''));
			await command('time set noon');
			await settle('coverLow');
		} catch (error) { await settle('coverLow', error); }
	}
	// A named cell: walk a short safe path to it.
	if (want('cell')) {
		try {
			await reset();
			await command('fill -1 80 3 1 80 3 minecraft:stone');
			o = await setReflexes([{ id: 'go', priority: 5, when: { type: 'health_below', value: 20 }, do: { type: 'move_to_cell', x: 0, y: 80, z: 6 }, maxS: 8, maxFirings: 1 }]);
			await command(`damage ${agent} 2 minecraft:generic`);
			await until(12000, (now) => events(now, 'go').some((row) => ['done', 'failed', 'timeout'].includes(row.outcome)));
			results.cell = { events: events(o, 'go'), position: o.position };
			results.cell.pass = events(o, 'go').some((row) => row.outcome === 'done' && /reached 0,80,6/.test(row.detail ?? ''));
			await settle('cell');
		} catch (error) { await settle('cell', error); }
	}
	// A zombie hitting from behind: turn and hit it.
	if (want('behind')) {
		try {
			await reset();
			await command(`item replace entity ${agent} weapon.mainhand with minecraft:iron_sword`);
			o = await setReflexes([{ id: 'rear', priority: 7, when: { type: 'attacked_from_behind', within: 4 }, do: { type: 'attack' }, maxS: 2 }]);
			await command(`effect give ${agent} minecraft:resistance 30 3 true`);
			await command('summon minecraft:zombie 0.5 80 -2.5');
			await until(15000, (now) => events(now, 'rear').some((row) => row.outcome === 'done'));
			results.behind = { events: events(o, 'rear') };
			results.behind.pass = events(o, 'rear').some((row) => row.outcome === 'done' && /hit minecraft:zombie/.test(row.detail ?? ''));
			await settle('behind');
		} catch (error) { await settle('behind', error); }
	}
	// A shield stance with an arrow trigger above it: the trigger takes over without lowering the shield.
	if (want('handover')) {
		try {
			await reset();
			await command('time set midnight');
			await command(`item replace entity ${agent} weapon.offhand with minecraft:shield`);
			o = await setReflexes([
				{ id: 'skeleton-shield', kind: 'stance', priority: 6, when: { type: 'exposed', within: 20, mobs: ['skeleton'] }, do: { type: 'shield' }, maxS: 20 },
				{ id: 'arrow-shield', priority: 8, when: { type: 'incoming_projectile', withinS: 2, projectiles: ['arrow'] }, do: { type: 'shield' }, maxS: 3 },
			]);
			const before = health(o);
			await command('summon minecraft:skeleton 0.5 80 14.5');
			await until(15000, () => false);
			const rows = [...events(o, 'skeleton-shield'), ...events(o, 'arrow-shield'), ...(o.reflexes?.firing ? [o.reflexes.firing] : [])];
			results.handover = { rows, healthBefore: before, health: health(o), skeleton: await command('data get entity @e[type=minecraft:skeleton,limit=1] Pos') };
			results.handover.pass = rows.some((row) => /blocked [1-9]/.test(row.detail ?? '')) && health(o) >= before - 1;
			await command('time set noon');
			await settle('handover');
		} catch (error) { await settle('handover', error); }
	}
	const during = (from, to) => timeline.filter((row) => row.at >= from && row.at <= to);
	// A held shield stance and a model command that only walks: the body walks behind the raised shield, slowed.
	if (want('shieldWalk')) {
		try {
			await reset();
			await command('time set midnight');
			await command(`item replace entity ${agent} weapon.offhand with minecraft:shield`);
			await command('summon minecraft:skeleton 0.5 80 14.5 {NoAI:1b}');
			o = await setReflexes([{ id: 'guard', kind: 'stance', priority: 6, when: { type: 'hostile_near', within: 20, mobs: ['skeleton'] }, do: { type: 'shield' }, maxS: 20 }]);
			await until(5000, (now) => now.reflexes?.firing?.id === 'guard');
			const startX = o.position?.x, from = Date.now();
			await yieldReflexes();
			const walk = await startAction('move_to', { x: 8.5, y: 80, z: 0.5, tolerance: 0.6, sprint: true });
			const done = await walk.result;
			const seconds = (Date.now() - from) / 1000;
			o = await observe();
			const rows = during(from, Date.now());
			results.shieldWalk = { result: done.reasonCode, seconds, startX, endX: o.position?.x, events: events(o, 'guard'), firing: o.reflexes?.firing ?? null,
				shieldedWalking: rows.filter((row) => row.firing === 'guard' && row.using).length, samples: rows.length };
			// Facing the skeleton, the view sees less of the ground ahead: the walk may end at its seen frontier beside the goal.
			results.shieldWalk.pass = ['DESTINATION_REACHED', 'REACHED_FRONTIER'].includes(done.reasonCode) && (o.position?.x ?? 0) >= 7.5 && !events(o, 'guard').some((row) => row.outcome === 'yielded')
				&& o.reflexes?.firing?.id === 'guard' && results.shieldWalk.shieldedWalking >= rows.length * 0.8 && seconds > 4;
			await command('time set noon');
			await settle('shieldWalk');
		} catch (error) { await settle('shieldWalk', error); }
	}
	// A held shield stance and a model fight: the fight keeps going, raising the shield between its swings.
	if (want('fightShield')) {
		try {
			await reset();
			await command(`item replace entity ${agent} weapon.mainhand with minecraft:iron_sword`);
			await command(`item replace entity ${agent} weapon.offhand with minecraft:shield`);
			await command(`effect give ${agent} minecraft:resistance 60 4 true`);
			await command('summon minecraft:zombie 0.5 80 6.5 {UUID:[I;1,2,3,4],PersistenceRequired:1b}');
			o = await setReflexes([{ id: 'guard', kind: 'stance', priority: 6, when: { type: 'hostile_near', within: 12, mobs: ['zombie'] }, do: { type: 'shield' }, maxS: 20 }]);
			await until(5000, (now) => now.reflexes?.firing?.id === 'guard');
			const from = Date.now();
			await yieldReflexes();
			const fight = await startAction('fight_target', { targetId: '00000001-0000-0002-0000-000300000004', timeoutMs: 30000 });
			const done = await fight.result;
			await sleep(500); o = await observe();
			const rows = during(from, Date.now());
			results.fightShield = { result: done.reasonCode, message: done.message?.slice(0, 160), events: events(o, 'guard'),
				fightDetail: rows.some((row) => /\(fight\)/.test(row.detail ?? '')), shieldUp: rows.filter((row) => row.using).length, samples: rows.length };
			results.fightShield.pass = done.reasonCode === 'TARGET_KILLED' && results.fightShield.fightDetail && results.fightShield.shieldUp > 0
				&& !events(o, 'guard').some((row) => row.outcome === 'yielded');
			await settle('fightShield');
		} catch (error) { await settle('fightShield', error); }
	}
	// The model eats while its shield stance holds: the stance yields, then comes back once eating ends.
	if (want('yieldReturn')) {
		try {
			await reset();
			await command('time set midnight');
			await command(`item replace entity ${agent} weapon.offhand with minecraft:shield`);
			await command(`item replace entity ${agent} hotbar.0 with minecraft:cooked_beef 8`);
			await command(`effect give ${agent} minecraft:hunger 4 255 true`); await sleep(4500);
			await command('summon minecraft:skeleton 0.5 80 14.5 {NoAI:1b}');
			o = await setReflexes([{ id: 'guard', kind: 'stance', priority: 6, when: { type: 'hostile_near', within: 20, mobs: ['skeleton'] }, do: { type: 'shield' }, maxS: 20 }]);
			await until(5000, (now) => now.reflexes?.firing?.id === 'guard');
			const food = o.player?.food;
			await yieldReflexes();
			const eat = await startAction('use_item', { durationMs: 1800, expectedItemId: 'minecraft:cooked_beef' });
			const done = await eat.result;
			const ended = Date.now();
			const back = await until(4000, (now) => now.reflexes?.firing?.id === 'guard');
			results.yieldReturn = { result: done.reasonCode, foodBefore: food, food: o.player?.food, events: events(o, 'guard'), back,
				backAfterMs: back ? (timeline.find((row) => row.at >= ended && row.firing === 'guard')?.at ?? Date.now()) - ended : null };
			results.yieldReturn.pass = events(o, 'guard').some((row) => row.outcome === 'yielded') && back;
			await command('time set noon');
			await settle('yieldReturn');
		} catch (error) { await settle('yieldReturn', error); }
	}
	// A fight that bails out at the model's fleeAtHealth hands the body to the model's low-health rule at once.
	if (want('bailout')) {
		try {
			await reset();
			await command(`effect clear ${agent}`);
			await command(`item replace entity ${agent} weapon.mainhand with minecraft:wooden_sword`);
			await command('summon minecraft:zombie 0.5 80 4.5 {UUID:[I;1,2,3,5],NoAI:1b,Health:200f,attributes:[{id:"minecraft:max_health",base:200}]}');
			o = await setReflexes([{ id: 'hurt', priority: 8, when: { type: 'health_below', value: 19 }, do: { type: 'step_back', blocks: 2 }, maxS: 2, cooldownS: 0.25 }]);
			const fight = await startAction('fight_target', { targetId: '00000001-0000-0002-0000-000300000005', fleeAtHealth: 16, timeoutMs: 30000 });
			await sleep(1500);
			await command(`damage ${agent} 10 minecraft:generic`);
			const done = await fight.result;
			const ended = Date.now();
			await until(3000, (now) => events(now, 'hurt').length >= 2 && now.reflexes?.firing == null);
			const after = timeline.filter((row) => row.at >= ended - 100 && row.firing === 'hurt');
			results.bailout = { result: done.reasonCode, events: events(o, 'hurt'), firedAfterBailout: after.length > 0, firstAfterMs: after[0] ? after[0].at - ended : null };
			results.bailout.pass = done.reasonCode === 'LOW_HEALTH_BAILOUT' && after.length > 0 && events(o, 'hurt').length >= 2;
			await settle('bailout');
		} catch (error) { await settle('bailout', error); }
	}
	// Live drownings 2026-10-20: the air rule fired, a short model command took the body, and once it ended the air stayed
	// low (no new edge), so the rule never fired again and the body sank between turns. It must fire again.
	if (want('airYield')) {
		try {
			await reset();
			await command('fill 9 79 13 15 93 19 minecraft:stone');
			await command('fill 12 80 16 12 90 16 minecraft:water');
			await command('fill 12 91 16 12 93 16 minecraft:air');
			await command(`tp ${agent} 12.5 80 16.5 0 0`);
			await sleep(1000);
			o = await setReflexes([{ id: 'air', priority: 9, when: { type: 'air_below', bubbles: 6 }, do: { type: 'swim_up' }, maxS: 12 }]);
			const since = Math.max(0, ...(o.reflexes?.events ?? []).map((row) => row.seq ?? 0));
			const fired = await until(30000, (now) => now.reflexes?.firing?.id === 'air');
			await yieldReflexes();
			const sink = await startAction('control', { forward: 0, strafe: 0, jump: false, sneak: true, sprint: false, attack: false, use: false,
				yaw: 0, pitch: 0, selectedSlot: 0, hand: 'main', ticks: 10 });
			const done = await sink.result;
			const ended = Date.now();
			const back = await until(6000, (now) => now.reflexes?.firing?.id === 'air');
			await until(15000, (now) => !now.reflexes?.firing);
			await sleep(1500); o = await observe();
			const mine = events(o, 'air').filter((row) => (row.seq ?? 0) > since);
			results.airYield = { firedFirst: fired, command: done.reasonCode, events: mine, back,
				backAfterMs: back ? (timeline.find((row) => row.at >= ended && row.firing === 'air')?.at ?? Date.now()) - ended : null,
				air: o.player?.air, health: health(o), y: o.position?.y };
			results.airYield.pass = fired && mine.some((row) => row.outcome === 'yielded') && back && health(o) > 0;
			await command(`tp ${agent} 0.5 80 0.5 0 0`);
			await settle('airYield');
		} catch (error) { await settle('airYield', error); }
	}
	results.status = o?.reflexes;
	await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
	await writeFile(join(out, 'timeline.json'), JSON.stringify(timeline, null, 1));
	console.log(JSON.stringify(Object.fromEntries(Object.entries(results).filter(([key]) => key !== 'status').map(([key, value]) => [key, value.pass]))));
	const failed = Object.entries(results).filter(([key, value]) => key !== 'status' && !value.pass).map(([key]) => key);
	if (failed.length > 0) { console.log(JSON.stringify(results, null, 2)); process.exitCode = 1; }
	else console.log('Reflex core mechanics verified');
} finally {
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise((done) => child.once('exit', done)), sleep(10000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
