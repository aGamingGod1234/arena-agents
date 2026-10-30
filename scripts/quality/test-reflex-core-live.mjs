#!/usr/bin/env node
// Provider-free check of the reflex core in a real server: this script stands in for the coordinator, installs reflex
// rules over the bridge (as a model's runProgram({reflexes}) would), and verifies what the mod does with them:
//   1. a shield stance raised toward a blaze blocks its fireballs;
//   2. a shield trigger on an incoming skeleton arrow;
//   3. a pickaxe that breaks mid-mining triggers a hotbar swap to the other pickaxe, and the next break uses it;
//   4. low air underwater triggers swim up;
//   5. a running action pauses under a firing (eat) and resumes to success instead of being cancelled;
//   6. a worn pickaxe (tool_low) is swapped for a fresh one from the main inventory through the inventory screen;
//   7. mined drops in view are walked to and picked up between and during break actions;
//   8. a full inventory fires a stop rule mid-walk: the body holds, the walk is cancelled (as the coordinator does), and
//      the report asks to wake the model.
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
const out = resolve(process.argv[2] ?? 'runtime/reflex-core-live');
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

let rcon, bridge, record, observation, inbox, revision = 0, ordinal = 0;
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
	await bridge.send('reflex_update', record.agentId, { revision, rules: normalizeReflexEntries(rules), yield: false });
	for (let index = 0; index < 40; index += 1) { const o = await observe(); if (o.reflexes?.revision === revision) return o; await sleep(100); }
	throw new Error(`reflex revision ${revision} never echoed`);
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
		timeline.push({ at: Date.now(), firing: firing?.id ?? null, action: event.payload.currentAction?.active ? event.payload.currentAction.actionId ?? true : false, health: event.payload.player?.health, incoming: (event.payload.incomingProjectiles ?? []).map((row) => `${row.type}@${row.etaSeconds}`), yaw: event.payload.view?.yaw, air: event.payload.player?.air, y: event.payload.position?.y });
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

	// 1. Shield stance toward a blaze: the shield is raised while the blaze is near and wears with each blocked fireball.
	if (only.length === 0 || only.includes('blazeShield')) {
		await command(`tp ${agent} 0.5 80 0.5 0 0`); await command(`item replace entity ${agent} weapon.offhand with minecraft:shield`);
		await observe();
		o = await setReflexes([{ id: 'blaze-shield', kind: 'stance', priority: 7, when: { type: 'hostile_near', within: 16, mobs: ['blaze'] }, do: { type: 'shield' }, maxS: 20 }]);
		const healthBefore = health(o);
		await command('summon minecraft:blaze 0.5 81 9.5');
		await sleep(15000);
		o = await observe();
		const shieldRows = events(o, 'blaze-shield');
		results.blazeShield = { firingNow: o.reflexes?.firing ?? null, events: shieldRows, healthBefore, healthAfter: health(o) };
		await command('kill @e[type=minecraft:blaze]'); await command('kill @e[type=minecraft:small_fireball]'); await sleep(1500);
		o = await observe();
		const blazeReports = [...events(o, 'blaze-shield'), ...(o.reflexes?.firing?.id === 'blaze-shield' ? [o.reflexes.firing] : [])];
		results.blazeShield.after = events(o, 'blaze-shield');
		results.blazeShield.pass = blazeReports.some((row) => /blocked [1-9]/.test(row.detail ?? '')) || results.blazeShield.firingNow?.detail?.startsWith('blocked');
		await command(`effect give ${agent} minecraft:instant_health 1 3 true`); await command('fill -24 80 -24 40 95 40 minecraft:air');

	}
	// 1b. The nearest blaze in front does not shoot; another behind does. The raised shield turns to each incoming fireball
	// (as a player does) instead of staying on the nearest mob, so the shots from behind are blocked.
	if (only.length === 0 || only.includes('blazeBehindShield')) {
		await command(`tp ${agent} 0.5 80 0.5 0 0`); await command(`item replace entity ${agent} weapon.offhand with minecraft:shield`);
		await observe();
		o = await setReflexes([{ id: 'blaze-shield', kind: 'stance', priority: 7, when: { type: 'hostile_near', within: 16, mobs: ['blaze'] }, do: { type: 'shield' }, maxS: 20 }]);
		const healthBefore = health(o);
		const from = timeline.length;
		const lastSeq = Math.max(0, ...(o.reflexes?.events ?? []).map((row) => row.seq ?? 0));
		await command('summon minecraft:blaze 0.5 81 6.5 {NoAI:1b}');
		await command('summon minecraft:blaze 0.5 81 -11.5');
		// Prove the rear blaze fired: sample live fireballs north of the body (the side it shoots from).
		let shotSamples = 0;
		for (const end = Date.now() + 15000; Date.now() < end; await sleep(250)) {
			if (/passed/i.test(await command('execute if entity @e[type=minecraft:small_fireball,z=-16,dz=16.4,x=-8,dx=16,y=72,dy=16]'))) shotSamples += 1;
		}
		o = await observe();
		const lowest = Math.min(healthBefore, ...timeline.slice(from).map((row) => row.health).filter(Number.isFinite));
		const rows = [...events(o, 'blaze-shield').filter((row) => row.seq > lastSeq), ...(o.reflexes?.firing?.id === 'blaze-shield' ? [o.reflexes.firing] : [])];
		const blocked = rows.reduce((sum, row) => sum + Number(/blocked (\d+)/.exec(row.detail ?? '')?.[1] ?? 0), 0);
		results.blazeBehindShield = { rows, blocked, shotSamples, healthBefore, lowest, healthAfter: health(o) };
		results.blazeBehindShield.pass = shotSamples > 0 && blocked > 0 && lowest >= healthBefore;
		await command('kill @e[type=minecraft:blaze]'); await command('kill @e[type=minecraft:small_fireball]'); await sleep(1500);
		await command(`effect give ${agent} minecraft:instant_health 1 3 true`);
		await setReflexes([]);
	}
	// 2. Skeleton: a shield stance while it is near (an arrow from 14 blocks lands about 6 ticks after release, and a vanilla
	// shield needs 5 ticks to come up, so a player raises it beforehand), with an arrow trigger installed beside it.
	if (only.length === 0 || only.includes('arrowShield')) {
		await command('time set midnight');
		await command(`tp ${agent} 0.5 80 0.5 0 0`); await command(`item replace entity ${agent} weapon.offhand with minecraft:shield`);
		o = await setReflexes([
			{ id: 'skeleton-shield', kind: 'stance', priority: 6, when: { type: 'hostile_near', within: 16, mobs: ['skeleton'] }, do: { type: 'shield' }, maxS: 20 },
			{ id: 'arrow-shield', priority: 8, when: { type: 'incoming_projectile', withinS: 2, projectiles: ['arrow'] }, do: { type: 'shield' }, maxS: 3 },
		]);
		const before = health(o);
		await command('summon minecraft:skeleton 0.5 80 14.5');
		await sleep(15000);
		o = await observe();
		const current = o.reflexes?.firing;
		results.arrowShield = { firingNow: current ?? null, events: [...events(o, 'skeleton-shield'), ...events(o, 'arrow-shield')], healthBefore: before, health: health(o) };
		await command('kill @e[type=minecraft:skeleton]'); await command('kill @e[type=minecraft:arrow]'); await sleep(1000);
		o = await observe();
		const rows = [...events(o, 'skeleton-shield'), ...events(o, 'arrow-shield'), ...(current ? [current] : [])];
		results.arrowShield.after = rows;
		results.arrowShield.pass = rows.some((row) => /blocked [1-9]/.test(row.detail ?? ''));
		await command('time set noon');
		await command(`effect give ${agent} minecraft:instant_health 1 3 true`);
		await command(`item replace entity ${agent} weapon.offhand with minecraft:air`);
	}

	// 3. A pickaxe with one use left breaks mid-mining; the trigger swaps to the other pickaxe and the next break uses it.
	if (only.length === 0 || only.includes('toolSwap')) {
		await command(`tp ${agent} 0.5 80 0.5 0 30`);
		await command(`item replace entity ${agent} hotbar.0 with minecraft:wooden_pickaxe[damage=58]`);
		await command(`item replace entity ${agent} hotbar.3 with minecraft:stone_pickaxe`);
		await command(`item replace entity ${agent} hotbar.1 with minecraft:dirt 4`);
		await command('setblock 0 80 2 minecraft:stone'); await command('setblock 0 81 2 minecraft:stone');
		o = await setReflexes([{ id: 'tool-swap', when: { type: 'tool_broke', tool: 'pickaxe' }, do: { type: 'select', tool: 'pickaxe' } }]);
		if (o.inventory?.selectedSlot !== 0) throw new Error(`expected hotbar 0 selected, got ${o.inventory?.selectedSlot}`);
		const first = await (await startAction('break_block', { x: 0, y: 81, z: 2, timeoutMs: 15000 })).result;
		await sleep(400);
		o = await observe();
		const afterBreak = o.inventory?.selectedSlot;
		const second = await (await startAction('break_block', { x: 0, y: 80, z: 2, timeoutMs: 15000 })).result;
		o = await observe();
		results.toolSwap = { firstBreak: first.state, selectedAfterBreak: afterBreak, secondBreak: second.state, events: events(o, 'tool-swap'), held: o.inventory?.selectedItem };
		results.toolSwap.pass = first.state === 'SUCCEEDED' && afterBreak === 3 && second.state === 'SUCCEEDED' && events(o, 'tool-swap').some((row) => row.outcome === 'done');

	}
	// 4. Low air underwater triggers swim up.
	if (only.length === 0 || only.includes('swimUp')) {
		await command('fill 6 76 6 8 79 8 minecraft:air'); await command('fill 5 75 5 9 75 9 minecraft:stone');
		await command('fill 5 76 5 9 80 5 minecraft:stone'); await command('fill 5 76 9 9 80 9 minecraft:stone'); await command('fill 5 76 5 5 80 9 minecraft:stone'); await command('fill 9 76 5 9 80 9 minecraft:stone');
		await command('fill 6 76 6 8 80 8 minecraft:water');
		o = await setReflexes([{ id: 'air', priority: 9, when: { type: 'air_below', bubbles: 4 }, do: { type: 'swim_up' }, maxS: 8 }]);
		await command(`tp ${agent} 7.5 76 7.5 0 0`);
		const deadline = Date.now() + 25000;
		let lowestAir = 300;
		while (Date.now() < deadline) {
			o = await observe();
			lowestAir = Math.min(lowestAir, o.player?.air ?? 300);
			if (events(o, 'air').some((row) => row.outcome === 'done')) break;
			await sleep(500);
		}
		await sleep(1500); o = await observe();
		results.swimUp = { events: events(o, 'air'), lowestAir, y: o.position?.y, air: o.player?.air, health: health(o) };
		results.swimUp.pass = events(o, 'air').some((row) => row.outcome === 'done' && /surfaced/.test(row.detail ?? '')) && (o.player?.air ?? 0) > lowestAir;
		await command(`tp ${agent} 0.5 80 0.5 0 0`); await command(`effect give ${agent} minecraft:instant_health 1 3 true`);

	}
	// 5. A running action pauses under a firing and resumes: walk 30 blocks; hunger drops mid-walk and the eat trigger fires.
	if (only.length === 0 || only.includes('resume')) {
		await command('fill -2 80 -2 2 82 34 minecraft:air'); await command('fill -2 79 -2 2 79 34 minecraft:stone');
		await command(`item replace entity ${agent} hotbar.2 with minecraft:bread 4`);
		o = await setReflexes([{ id: 'snack', priority: 4, when: { type: 'hunger_below', value: 17 }, do: { type: 'eat' }, maxS: 4 }]);
		await command(`tp ${agent} 0.5 80 0.5 0 0`); await sleep(500); await observe();
		const walk = await startAction('move_to', { x: 0.5, y: 80, z: 32.5, tolerance: 0.8, sprint: false });
		await sleep(1500);
		await command(`effect give ${agent} minecraft:hunger 6 255 true`);
		const walked = await walk.result;
		o = await observe();
		const firingSamples = timeline.filter((row) => row.firing === 'snack');
		results.resume = { moveResult: walked.state, reasonCode: walked.reasonCode, events: events(o, 'snack'), z: o.position?.z,
			firingSamples: firingSamples.length, actionActiveWhileFiring: firingSamples.every((row) => row.action !== false) && firingSamples.length > 0 };
		results.resume.pass = walked.state === 'SUCCEEDED' && events(o, 'snack').some((row) => row.outcome === 'done' && /ate minecraft:bread/.test(row.detail ?? '')) && results.resume.actionActiveWhileFiring;

	}
	const slotItem = (o, slot) => (o.inventory?.items ?? []).find((row) => row.slot === slot);
	const countOf = (o, itemId) => (o.inventory?.items ?? []).filter((row) => row.itemId === itemId).reduce((sum, row) => sum + (row.count ?? 0), 0);
	// 6. Tool wear: a wooden pickaxe with 4 uses left in the hand, a stone pickaxe only in the main inventory (slot 20).
	if (only.length === 0 || only.includes('toolWear')) {
		await command(`clear ${agent}`); await command('time set noon');
		await command('fill 9 80 1 12 82 4 minecraft:air');
		for (const [x, y] of [[10, 81], [10, 80], [11, 81], [11, 80]]) await command(`setblock ${x} ${y} 2 minecraft:stone`);
		await command(`tp ${agent} 10.5 80 0.5 0 30`);
		// Earlier checks leave another hotbar slot selected; the worn pickaxe goes into whichever slot is held.
		const held = (await observe()).inventory?.selectedSlot ?? 0;
		await command(`item replace entity ${agent} hotbar.${held} with minecraft:wooden_pickaxe[damage=55]`);
		await command(`item replace entity ${agent} inventory.11 with minecraft:stone_pickaxe`);
		o = await setReflexes([{ id: 'fresh-pick', priority: 4, when: { type: 'tool_low', uses: 3, tool: 'pickaxe' }, do: { type: 'select', tool: 'pickaxe' } }]);
		const breaks = [];
		for (const [x, y] of [[10, 81], [10, 80], [11, 81], [11, 80]]) breaks.push((await (await startAction('break_block', { x, y, z: 2, timeoutMs: 15000 })).result).state);
		await sleep(500); o = await observe();
		const wooden = (o.inventory?.items ?? []).find((row) => row.itemId === 'minecraft:wooden_pickaxe');
		results.toolWear = { breaks, events: events(o, 'fresh-pick'), selectedSlot: o.inventory?.selectedSlot, held: o.inventory?.selectedItem, wooden, slot20: slotItem(o, 20) };
		results.toolWear.pass = breaks.every((state) => state === 'SUCCEEDED') && o.inventory?.selectedItem === 'minecraft:stone_pickaxe'
			&& wooden !== undefined && events(o, 'fresh-pick').some((row) => row.outcome === 'done' && /from inventory slot 20/.test(row.detail ?? ''));
	}
	// 7. Drops: each mined block's drop lands about 3 blocks away; an item_nearby trigger walks to it, also while the next
	// break action is already waiting (it pauses and resumes).
	if (only.length === 0 || only.includes('dropPickup')) {
		await command(`clear ${agent}`);
		await command('fill -12 80 -1 -8 82 5 minecraft:air');
		await command('setblock -10 80 3 minecraft:stone'); await command('setblock -9 80 3 minecraft:stone');
		await command(`tp ${agent} -9.5 80 0.5 0 20`);
		await command(`item replace entity ${agent} hotbar.${(await observe()).inventory?.selectedSlot ?? 0} with minecraft:stone_pickaxe`);
		o = await setReflexes([{ id: 'loot', priority: 3, when: { type: 'item_nearby', within: 5, items: ['cobblestone'] }, do: { type: 'pickup', within: 5 }, cooldownS: 0.5 }]);
		const first = await (await startAction('break_block', { x: -10, y: 80, z: 3, timeoutMs: 15000 })).result;
		const second = await (await startAction('break_block', { x: -9, y: 80, z: 3, timeoutMs: 15000 })).result;
		const deadline = Date.now() + 10000;
		while (Date.now() < deadline) { o = await observe(); if (countOf(o, 'minecraft:cobblestone') >= 2 && !o.reflexes?.firing) break; await sleep(300); }
		results.dropPickup = { first: first.state, second: second.state, cobblestone: countOf(o, 'minecraft:cobblestone'), events: events(o, 'loot'), position: o.position };
		results.dropPickup.pass = first.state === 'SUCCEEDED' && second.state === 'SUCCEEDED' && countOf(o, 'minecraft:cobblestone') >= 2
			&& events(o, 'loot').some((row) => row.outcome === 'done' && /picked up/.test(row.detail ?? ''));
	}
	// 8. Inventory full: 35 slots hold dirt; mid-walk one more item fills the last slot and the stop rule fires.
	if (only.length === 0 || only.includes('inventoryFull')) {
		await command(`clear ${agent}`);
		await command('fill -2 80 -2 2 82 34 minecraft:air'); await command('fill -2 79 -2 2 79 34 minecraft:stone');
		for (let slot = 0; slot < 35; slot += 1) await command(`item replace entity ${agent} ${slot < 9 ? `hotbar.${slot}` : `inventory.${slot - 9}`} with minecraft:dirt 64`);
		o = await setReflexes([{ id: 'full-stop', priority: 6, when: { type: 'inventory_full' }, do: { type: 'stop' } }]);
		await command(`tp ${agent} 0.5 80 0.5 0 0`); await sleep(500); await observe();
		const walk = await startAction('move_to', { x: 0.5, y: 80, z: 32.5, tolerance: 0.8, sprint: false });
		await sleep(1500);
		await command(`give ${agent} minecraft:cobblestone 1`);
		// As the coordinator does for a firing stop rule: cancel the running action while the mod holds the body.
		let cancelled = false;
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline && !cancelled) {
			o = await observe();
			if (o.reflexes?.firing?.id === 'full-stop') { await bridge.send('action_cancel', record.agentId, { goalRevision: record.goalRevision, actionId: walk.id }); cancelled = true; }
			else await sleep(100);
		}
		const walked = await walk.result;
		await sleep(800); o = await observe();
		results.inventoryFull = { cancelSent: cancelled, moveResult: walked.state, reasonCode: walked.reasonCode, z: o.position?.z, events: events(o, 'full-stop') };
		results.inventoryFull.pass = cancelled && walked.state === 'CANCELLED' && (o.position?.z ?? 99) < 30
			&& events(o, 'full-stop').some((row) => row.outcome === 'done' && row.wake === true && /stopped the running action/.test(row.detail ?? ''));
		await command(`clear ${agent}`);
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
