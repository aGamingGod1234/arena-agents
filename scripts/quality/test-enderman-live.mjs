#!/usr/bin/env node
// Provider-free check of enderman provocation and defence (End deaths d9-end-b and end-r2, 2026-10-21: a look_at at a
// pearl landing 2.5 blocks behind a calm enderman stared at it; the pearl then landed beside it and it killed the agent
// in five seconds, faster than a model turn). This script stands in for the coordinator (operator commands build
// fixtures only) and checks: look_at past a calm enderman settles off its eyes and leaves it calm, while a look at its
// head provokes it (the fixture's control); the pearl preview marks an angry enderman near the landing; and an angry
// enderman against no defence, an armed shield stance and an armed water-at-feet reflex; pearl hunting with fight_target
// on open ground and from inside 2-high tunnels with thin and thick walls (ENDER_FIGHTS each), and the drop rate over salted kills
// (ENDER_KILLS). REFLEX_ONLY=a,b runs named scenarios only. Launch under slot.sh live.
import { readFile, writeFile, mkdir, cp, readdir, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { MultiplexedServerBridge } from '../../coordinator/src/protocol-v2.mjs';
import { HeadlessRconClient } from '../../coordinator/src/headless-rcon.mjs';
import { normalizeReflexEntries } from '../../coordinator/src/reflexes.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = resolve(process.argv[2] ?? 'runtime/enderman-live');
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
const agent = 'Ender';
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
	bridge.on('goal_spec_request', (event) => { bridge.send('goal_spec_proposal', event.agentId, { requestId: event.payload.requestId, summary: 'Controlled live enderman fixture', predicate: { type: 'survive_duration', ticks: 24000 } }).catch(() => {}); });
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


	await command('gamerule minecraft:mob_griefing false');
	const reset = async () => {
		await command('kill @e[type=!minecraft:player]');
		for (const fill of ['-16 80 -8 16 92 40 minecraft:air', '-16 79 -8 16 79 40 minecraft:stone']) {
			const reply = await command(`fill ${fill}`);
			if (/too many|cannot|error/i.test(reply)) throw new Error(`reset fill refused: ${reply}`);
		}
		await command('time set midnight');
		await command(`effect give ${agent} minecraft:instant_health 1 5 true`); await command(`effect give ${agent} minecraft:saturation 2 10 true`);
		await command(`clear ${agent}`); await command(`tp ${agent} 0.5 80 0.5 180 0`);
		await command(`item replace entity ${agent} armor.chest with minecraft:iron_chestplate`);
		await command(`item replace entity ${agent} armor.legs with minecraft:iron_leggings`);
		await setReflexes([]);
		await sleep(1000);
	};
	const selected = (name) => only.length === 0 || only.includes(name);
	const scenarios = [];
	const want = (name) => selected(name) && (scenarios.push(name), true);
	const settle = async (name, error) => {
		if (error) results[name] = { ...(results[name] ?? {}), pass: false, error: String(error?.stack ?? error).slice(0, 400) };
		await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
		await writeFile(join(out, 'timeline.json'), JSON.stringify(timeline, null, 1));
		console.log(`[scenario] ${name}: ${results[name]?.pass ? 'PASS' : 'FAIL'}`);
	};
	const until = async (ms, test) => { const end = Date.now() + ms; while (Date.now() < end) { o = await observe(); if (test(o)) return true; await sleep(250); } return false; };
	const endermen = (now) => (now.entities ?? []).filter((row) => row.type === 'minecraft:enderman');
	const angry = (now) => endermen(now).some((row) => row.appearance?.screaming === true || row.targetingAgent === true);
	// A calm enderman in a fence pen 20 blocks south, its eyes above the fence: it cannot wander off or walk over.
	const pen = async (z) => {
		await command(`fill -1 80 ${z - 1} 1 80 ${z + 1} minecraft:oak_fence`); await command(`setblock 0 80 ${z} minecraft:air`);
		await command(`summon minecraft:enderman 0.5 80 ${z + 0.5}`);
		await sleep(1500);
	};
	let died = false;
	bridge.on('message', (event) => { if (event.type === 'goal_control' && event.payload?.operation === 'dead') died = true; });
	const stand = async (ms, rows) => { const end = Date.now() + ms; while (Date.now() < end && !died) { try { o = await Promise.race([observe(), sleep(3000).then(() => { throw new Error('no observation'); })]); } catch { if (died) break; continue; } rows.push({ t: Date.now(), health: health(o), angry: angry(o), firing: o.reflexes?.firing?.id ?? null, using: o.interaction?.usingItem ?? null }); await sleep(250); } };

	// look_at a point 2.5 blocks behind a calm enderman at its eye height (run d9-end-b's pearl aim): no provocation.
	if (want('look-past')) {
		try {
			await reset(); await pen(20);
			const look = await (await startAction('look_at', { x: 0.5, y: 82.6, z: 23 })).result;
			await sleep(4000); o = await observe();
			results['look-past'] = { state: look.state, message: look.message, view: o.view, angry: angry(o), endermen: endermen(o).map((row) => ({ d: row.distance, appearance: row.appearance ?? null, targeting: row.targetingAgent })) };
			results['look-past'].pass = look.state === 'SUCCEEDED' && /calm enderman .* eyes/.test(look.message ?? '') && !angry(o);
			await settle('look-past');
		} catch (error) { await settle('look-past', error); }
	}
	// Control: a look on its head is the model's own choice and is not moved; the stare provokes it.
	if (want('look-at-head')) {
		try {
			await reset(); await pen(20);
			const look = await (await startAction('look_at', { x: 0.5, y: 82.55, z: 20.5 })).result;
			const provoked = await until(6000, angry);
			results['look-at-head'] = { state: look.state, message: look.message, view: o.view, provoked };
			results['look-at-head'].pass = look.state === 'SUCCEEDED' && provoked;
			await settle('look-at-head');
		} catch (error) { await settle('look-at-head', error); }
	}
	// The pearl preview names who waits at the landing and whether it is after you.
	if (want('pearl-preview')) {
		try {
			await reset(); await pen(20);
			await command(`item replace entity ${agent} weapon.mainhand with minecraft:ender_pearl 4`);
			const calm = await (await startAction('use_item', { durationMs: 1, mode: 'inspect', expectedItemId: 'minecraft:ender_pearl', aimX: 0.5, aimY: 82.55, aimZ: 20.5 })).result;
			await (await startAction('look_at', { x: 0.5, y: 82.55, z: 20.5 })).result;
			const provoked = await until(6000, angry);
			const hot = await (await startAction('use_item', { durationMs: 1, mode: 'inspect', expectedItemId: 'minecraft:ender_pearl', aimX: 0.5, aimY: 82, aimZ: 18 })).result;
			results['pearl-preview'] = { calm: calm.message, provoked, angry: hot.message };
			results['pearl-preview'].pass = provoked && /viewMeetsEndermanEyes/.test(calm.message ?? '') && /"angry":true/.test(hot.message ?? '');
			await settle('pearl-preview');
		} catch (error) { await settle('pearl-preview', error); }
	}
	// An angry enderman 6 blocks away against each defence, 12 s each; health is topped up first.
	const defend = async (name, rules, kit) => {
		try {
			await reset();
			for (const line of kit) await command(line);
			await command('summon minecraft:enderman 0.5 80 6.5'); await sleep(1500);
			if (rules.length) o = await setReflexes(rules);
			// The agent provokes it on purpose (a look at its head), as in the runs.
			await (await startAction('look_at', { x: 0.5, y: 82.55, z: 6.5 })).result;
			const provoked = await until(6000, angry);
			// Then look away, as the agents did: a provoked enderman freezes while stared at and attacks once you look off.
			await (await startAction('look_at', { x: 0.5, y: 80, z: -6 })).result;
			const rows = []; const before = health(o); const started = Date.now();
			await stand(12000, rows);
			const diedAfterMs = died ? Date.now() - started : null;
			const water = (await command('execute if block 0 80 0 minecraft:water')).includes('passed');
			const dead = died;
			if (died) { await command('kill @e[type=minecraft:enderman]'); await (await startAction('respawn', {})).result.catch(() => null); died = false; await sleep(2000); }
			results[name] = { provoked, healthBefore: before, health: dead ? 0 : health(o), lowest: dead ? 0 : Math.min(...rows.map((row) => row.health)), dead, diedAfterMs,
				waterAtFeet: water, events: (o.reflexes?.events ?? []).slice(-4), samples: rows.filter((_, index) => index % 4 === 0) };
			return results[name];
		} catch (error) { await settle(name, error); return null; }
	};
	if (want('angry-none')) {
		const row = await defend('angry-none', [], []);
		if (row) { row.pass = row.provoked && row.lowest < row.healthBefore - 6; await settle('angry-none'); }
	}
	if (want('angry-shield')) {
		const row = await defend('angry-shield', [{ id: 'block', kind: 'stance', priority: 6, when: { type: 'enderman_provoked', within: 4 }, do: { type: 'shield' }, maxS: 3 }],
			[`item replace entity ${agent} weapon.offhand with minecraft:shield`]);
		if (row) { row.pass = row.provoked; await settle('angry-shield'); }
	}
	if (want('angry-water')) {
		const row = await defend('angry-water', [{ id: 'puddle', priority: 9, when: { type: 'enderman_provoked', within: 16 }, do: { type: 'place', item: 'minecraft:water_bucket', where: 'feet' }, maxS: 3 }],
			[`item replace entity ${agent} hotbar.0 with minecraft:water_bucket`]);
		if (row) { row.pass = row.provoked && row.waterAtFeet && row.events.some((event) => event.id === 'puddle' && /at feet/.test(event.detail ?? '')); await settle('angry-water'); }
	}
	// Pearl hunting with the body: a provoked enderman fought with fight_target pursue:false and an iron sword, on open
	// ground or from two cells inside a 1-wide, 2-high tunnel it cannot enter (the instructions' rule). Each fight
	// reseeds the enderman drop sequence (minecraft:entities/enderman) so the drops vary like separate games.
	const pearlsOnGround = async () => Number(/count: (\d+)/i.exec(await command('execute if items entity @e[type=minecraft:item] contents minecraft:ender_pearl'))?.[1] ?? 0);
	let fightOrdinal = 0;
	// tunnel: false (open ground), 'wall' (a 3-wide, 3-high block: 1-thick walls) or 'hill' (a 7-wide, 5-high block, so
	// the tunnel mouth is the reachable cell nearest the player).
	const fight = async (name, tunnel, salt) => {
		const id = 4200 + ++fightOrdinal, uuid = `00000000-0000-0000-0000-${id.toString(16).padStart(12, '0')}`;
		await reset();
		await command(`item replace entity ${agent} weapon.mainhand with minecraft:iron_sword`);
		if (tunnel) {
			await command(tunnel === 'hill' ? 'fill -3 80 -6 3 84 0 minecraft:stone' : 'fill -1 80 -4 1 82 0 minecraft:stone'); await command('fill 0 80 -3 0 81 0 minecraft:air');
			await command(`tp ${agent} 0.5 80 -1.5 0 0`);
		} else await command(`tp ${agent} 0.5 80 0.5 0 0`);
		await command(`random reset minecraft:entities/enderman ${salt}`);
		// Penned while provoked so the look meets its eyes, then released to come at the player.
		await command('fill -1 80 5 1 80 7 minecraft:oak_fence'); await command('setblock 0 80 6 minecraft:air');
		await command(`summon minecraft:enderman 0.5 80 6.5 {UUID:[I;0,0,0,${id}]}`); await sleep(1500);
		await (await startAction('look_at', { x: 0.5, y: 82.55, z: 6.5 })).result;
		const provoked = await until(6000, angry);
		await command('fill -1 80 5 1 80 7 minecraft:air');
		const before = health(o), started = Date.now(), trail = [];
		const action = await startAction('fight_target', { targetId: uuid, pursue: false, timeoutMs: 30000 });
		let lowest = before, killedAfterMs = null;
		const watch = (async () => { while (Date.now() - started < 32000 && !died) { try { o = await Promise.race([observe(), sleep(3000).then(() => { throw new Error('no observation'); })]); } catch { continue; } lowest = Math.min(lowest, health(o) ?? lowest);
			const at = /\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/.exec(await command(`data get entity ${uuid} Pos`));
			if (!at) { killedAfterMs = Date.now() - started; return; }
			const row = endermen(o).find((e) => e.uuid === uuid);
			trail.push({ t: Date.now() - started, at: at.slice(1).map((n) => Math.round(Number(n) * 10) / 10), inView: row !== undefined, angry: row?.appearance?.screaming === true || row?.targetingAgent === true, health: health(o) });
			await sleep(250); } })();
		const outcome = await action.result; await watch;
		await sleep(1500);
		const pearls = await pearlsOnGround();
		const dead = died;
		if (died) { await command('kill @e[type=minecraft:enderman]'); await (await startAction('respawn', {})).result.catch(() => null); died = false; await sleep(2000); }
		return { name, tunnel, salt, provoked, fight: outcome.state, reasonCode: outcome.reasonCode ?? null, message: String(outcome.message ?? '').slice(0, 200), healthBefore: before, lost: dead ? before : +(before - lowest).toFixed(1), dead, killed: killedAfterMs !== null, killedAfterMs, pearls, trail: trail.filter((_, index) => index % 4 === 0) };
	};
	const fights = Number(process.env.ENDER_FIGHTS ?? 3);
	for (const [name, tunnel, base] of [['fight-open', false, 500], ['fight-tunnel', 'wall', 600], ['fight-hillside', 'hill', 700]]) {
		if (!want(name)) continue;
		try {
			const rows = [];
			for (let index = 0; index < fights; index++) rows.push(await fight(name, tunnel, base + index));
			results[name] = { rows, killed: rows.filter(row => row.killed).length, meanLost: +(rows.reduce((sum, row) => sum + row.lost, 0) / rows.length).toFixed(1), deaths: rows.filter(row => row.dead).length, pearls: rows.reduce((sum, row) => sum + row.pearls, 0),
				meanKillS: rows.some(row => row.killed) ? +(rows.filter(row => row.killed).reduce((sum, row) => sum + row.killedAfterMs, 0) / rows.filter(row => row.killed).length / 1000).toFixed(1) : null };
			// Open ground must kill; a tunnel must keep the body unhurt (whether it also kills is the measurement).
			results[name].pass = rows.every(row => row.provoked) && results[name].deaths === 0 && (tunnel ? results[name].meanLost === 0 : results[name].killed === rows.length);
			await settle(name);
		} catch (error) { await settle(name, error); }
	}
	// Drop odds: vanilla minecraft:entities/enderman gives 0-1 pearl (uniform), +0-1 per looting level. A player kill per
	// salt; the unsalted world-default sequence repeats the same drops, which is what one save point does to every game.
	if (want('drop-odds')) {
		try {
			await reset(); await command(`tp ${agent} 0.5 80 0.5 0 0`);
			const kills = async (salts) => {
				const drops = [];
				for (const salt of salts) {
					await command('kill @e[type=minecraft:item]');
					if (salt === null) await command('random reset minecraft:entities/enderman'); else if (salt !== undefined) await command(`random reset minecraft:entities/enderman ${salt}`);
					await command('summon minecraft:enderman 0.5 80 4.5 {NoAI:1b,Tags:["odds"]}');
					await command(`damage @e[type=minecraft:enderman,tag=odds,limit=1] 200 minecraft:player_attack by ${agent}`);
					await sleep(400);
					drops.push(await pearlsOnGround());
				}
				return drops;
			};
			const defaultRun = [null, ...Array(5).fill(undefined)];
			const control = [await kills(defaultRun), await kills(defaultRun)];
			const salted = await kills(Array.from({ length: Number(process.env.ENDER_KILLS ?? 40) }, (_, index) => 9000 + index));
			await command('kill @e[type=minecraft:item]');
			results['drop-odds'] = { control, kills: salted.length, pearls: salted.reduce((a, b) => a + b, 0), rate: +(salted.reduce((a, b) => a + b, 0) / salted.length).toFixed(3) };
			results['drop-odds'].pass = control[0].join() === control[1].join() && salted.length > 0 && results['drop-odds'].rate > 0.2 && results['drop-odds'].rate < 0.8;
			await settle('drop-odds');
		} catch (error) { await settle('drop-odds', error); }
	}
	if (results['angry-none'] && results['angry-water']) results.comparison = { lostNone: results['angry-none'].healthBefore - results['angry-none'].lowest,
		lostShield: results['angry-shield'] ? results['angry-shield'].healthBefore - results['angry-shield'].lowest : null,
		lostWater: results['angry-water'].healthBefore - results['angry-water'].lowest, pass: true };
	results.status = o?.reflexes;
	await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
	await writeFile(join(out, 'timeline.json'), JSON.stringify(timeline, null, 1));
	console.log(JSON.stringify(Object.fromEntries(Object.entries(results).filter(([key]) => key !== 'status').map(([key, value]) => [key, value.pass]))));
	const failed = Object.entries(results).filter(([key, value]) => key !== 'status' && !value.pass).map(([key]) => key);
	if (failed.length > 0) { console.log(JSON.stringify(results, null, 2)); process.exitCode = 1; }
	else console.log('Enderman mechanics verified');
} finally {
	if (rcon) await command('stop').catch(() => {});
	bridge?.stop(); await rcon?.close();
	await Promise.race([new Promise((done) => child.once('exit', done)), sleep(10000)]); if (child.exitCode === null) child.kill('SIGTERM'); await log.close();
}
