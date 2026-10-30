import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ArenaScriptInterpreter } from '../src/arena-script/interpreter.mjs';
import { parseArenaScript } from '../src/arena-script/parser.mjs';
import { createInterpreterFacts } from '../src/arena-script/facts.mjs';
import { SCRIPT_BINDINGS, PLAYER_MEMBER_PRIMITIVES } from '../src/arena-script/minecraft-api.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { validateAction } from '../src/schema.mjs';
import { ARENA_SCRIPT_API_REFERENCE } from '../src/prompts.mjs';
import { ArenaScriptEngine } from '../src/arena-script/program-engine.mjs';

const prefix = 'program.onUnhandledAttention("continue_and_notify");';
const observation = {
	player: { x: 0, y: 64, z: 0, health: 20, velocity: { x: 1, y: 0, z: 0 }, heard: [], heardLava: false },
	items: [{ stableId: 'drop', itemId: 'minecraft:oak_log', count: 2, x: 2, y: 64, z: 0, tags: ['#minecraft:logs'] }],
	entities: [{ stableId: 'pig', type: 'minecraft:pig', x: 3, y: 64, z: 0 }, { stableId: 'pig-far', type: 'minecraft:pig', x: 7, y: 64, z: 0 }],
	blocks: [{ stableId: 'block', blockId: 'minecraft:oak_log', x: 1, y: 64, z: 0, tags: ['#minecraft:logs'] }],
	inventory: { items: [{ slot: 0, itemId: 'minecraft:oak_log', count: 5, tags: ['#minecraft:logs'] }], tagCounts: { '#minecraft:logs': 5 }, occupiedSlots: 1 },
	coverage: { inventory: { complete: false, hasMore: true } },
	dimension: 'minecraft:overworld',
	landmarks: [{ type: 'visible_structure' }],
	interaction: { menu: { menuId: 7, slots: [{ slot: 2, itemId: 'minecraft:stone', count: 1 }] } },
};

function vm(body, options = {}) {
	return new ArenaScriptInterpreter(parseArenaScript(`${prefix} ${body}`), SCRIPT_BINDINGS, options);
}
function done(command, overrides = {}) {
	return { stateToken: command.stateToken, state: 'SUCCEEDED', reasonCode: 'DONE', ...overrides };
}

test('contract: every documented math method executes finite arithmetic and rejects nonfinite inputs', () => {
	const cases = [
		['abs', [-3], 3], ['floor', [1.8], 1], ['ceil', [1.2], 2], ['round', [1.6], 2],
		['sqrt', [9], 3], ['sin', [0], 0], ['cos', [0], 1], ['atan2', [0, 1], 0],
		['min', [3, 2], 2], ['max', [2, 3], 3], ['hypot', [3, 4], 5],
	];
	for (const [method, args, expected] of cases) {
		assert.equal(vm(`await player.wait(math.${method}(${args}));`).start(createInterpreterFacts(observation)).call.arguments, expected);
		assert.throws(() => vm(`await player.wait(math.${method}(${args.map(() => '"bad"')}));`).start(createInterpreterFacts(observation)), error => error.code === 'INVALID_ARGUMENT');
		assert.throws(() => vm(`await player.wait(math.${method}(${args.map(() => '1 / 0')}));`).start(createInterpreterFacts(observation)), error => ['INVALID_ARGUMENT', 'INVALID_OPERAND'].includes(error.code));
	}
	assert.throws(() => vm('await player.wait(math.sqrt(-1));').start(createInterpreterFacts(observation)), error => error.code === 'INVALID_OPERAND');
});

test('contract: all factual APIs preserve observed values, coverage, menu and chosen candidate origin', () => {
	const run = vm(`
		const self = player.state();
		const state = world.state();
		const menu = world.menu();
		const slot = world.nearest(world.blocks({tag:"#minecraft:logs"}));
		const farOrigin = {x:10,y:64,z:0};
		const pig = world.nearest(world.entities({type:"minecraft:pig"}), farOrigin);
		const drop = world.nearest(world.items({itemId:"minecraft:oak_log"}));
		let slots = 0;
		for (const item of inventory.slots({itemId:"minecraft:oak_log"})) slots += item.count;
		if (self.velocity.x === 1 && self.heard.length === 0 && self.heardLava === false && state.dimension === "minecraft:overworld"
			&& state.landmarks.length === 1
			&& state.coverage.inventory.hasMore && menu.menuId === 7 && inventory.state().occupiedSlots === 1
			&& slot.stableId === "block" && pig.stableId === "pig-far" && drop.stableId === "drop"
			&& slots === 5 && inventory.count("minecraft:oak_log") === 5 && inventory.countTag("#minecraft:logs") === 5)
			program.finish("observed");
		else program.checkpoint("facts changed");
	`);
	assert.equal(run.start(createInterpreterFacts(observation)).summary, 'observed');
	const absent = vm('if (world.menu() === null && world.nearest(world.blocks()) === null) program.finish("absent");');
	assert.equal(absent.start(createInterpreterFacts({ player: observation.player })).summary, 'absent');
});

test('contract: counts cover observed inventory only and omitted metadata does not become an item', () => {
	const facts = createInterpreterFacts({ ...observation, inventory: { ...observation.inventory, resourceCount: 99 } });
	const run = vm(`
		if (inventory.count("minecraft:stone") === 0 && inventory.countTag("#unknown") === 0
			&& inventory.count("minecraft:oak_log") === 5 && inventory.state().resourceCount === 99
			&& world.state().coverage.inventory.complete === false)
			program.finish("observed count");
	`);
	assert.equal(run.start(facts).summary, 'observed count');
	assert.throws(() => vm('await player.wait(player.state().missing + 1);').start(facts), error => error.code === 'UNKNOWN_MEMBER');
});

test('contract: for-of retains its snapshot while new reads after an action see fresh facts', () => {
	const run = vm(`
		let total = 0;
		for (const item of world.items()) {
			await player.wait(item.count);
			total += item.count;
		}
		const fresh = world.nearest(world.items());
		await player.wait(total + fresh.count);
	`);
	const before = createInterpreterFacts(observation);
	const first = run.start(before);
	assert.equal(first.call.arguments, 2);
	const next = run.resume(done(first), createInterpreterFacts({ ...observation, items: [{ ...observation.items[0], count: 7 }] }));
	assert.equal(next.call.arguments, 9);
});

test('contract: stale observed candidates cannot supply nearest targets after a fresh action observation', () => {
	const run = vm('const old = world.items(); await player.wait(1); const target = world.nearest(old);');
	const first = run.start(createInterpreterFacts(observation));
	assert.throws(() => run.resume(done(first), createInterpreterFacts({ ...observation, items: [] })), error => error.code === 'EXECUTION_ERROR' && /current observation/.test(error.cause?.message));
});

test('contract: inspection and each memory operation yield a read request and preserve the real result', () => {
	for (const [operation, args] of [
		['inspect', { section: 'inventory', offset: 0, limit: 16 }],
		['remember', { key: 'place', text: 'observed place' }],
		['queryMemory', { kind: 'notes', offset: 0, limit: 16 }],
		['taskMemory', { operation: 'query', query: { kind: 'places' } }],
	]) {
		const run = vm(`const result = await world.${operation}(${JSON.stringify(args)}); await player.wait(result.count);`);
		const query = run.start(createInterpreterFacts(observation));
		assert.equal(query.kind, 'query');
		assert.equal(query.operation, operation);
		assert.deepEqual(JSON.parse(JSON.stringify(query.query)), args);
		const next = run.resume(done(query, { value: { count: 7 } }), createInterpreterFacts(observation));
		assert.equal(next.call.arguments, 7);
	}
});

test('contract: reads consume the same command budget as physical actions', () => {
	const run = vm('await world.inspect({section:"inventory"}); await player.wait(1);', { limits: { commandsPerProgram: 1 } });
	const query = run.start(createInterpreterFacts(observation));
	assert.throws(() => run.resume(done(query, { value: {} }), createInterpreterFacts(observation)), error => error.code === 'COMMAND_LIMIT');
});

test('contract: the shared command budget reports reads, queries and the default 2048 / 2049 / inspect+2048 outcomes', () => {
	const pure = vm('const s = player.state(); const n = inventory.count("minecraft:dirt"); await player.wait(1);');
	assert.deepEqual({ ...pure.budget() }, { commandsUsed: 0, commandsRemaining: 2048, queriesUsed: 0 });
	const first = pure.start(createInterpreterFacts(observation));
	assert.equal(first.kind, 'command');
	assert.deepEqual({ ...pure.budget() }, { commandsUsed: 1, commandsRemaining: 2047, queriesUsed: 0 });

	const inspected = vm('await world.inspect({section:"inventory"}); await player.wait(1);');
	const query = inspected.start(createInterpreterFacts(observation));
	assert.deepEqual({ ...inspected.budget() }, { commandsUsed: 1, commandsRemaining: 2047, queriesUsed: 1 });
	inspected.resume(done(query, { value: {} }), createInterpreterFacts(observation));
	assert.deepEqual({ ...inspected.budget() }, { commandsUsed: 2, commandsRemaining: 2046, queriesUsed: 1 });

	const drive = (source) => {
		const run = vm(source);
		let step = run.start(createInterpreterFacts(observation)), physical = 0, queries = 0;
		try {
			while (step.kind === 'command' || step.kind === 'query') {
				if (step.kind === 'command') physical += 1; else queries += 1;
				step = run.resume(step.kind === 'query' ? done(step, { value: {} }) : done(step), createInterpreterFacts(observation));
			}
			return { end: step.kind, physical, queries, budget: { ...run.budget() } };
		} catch (error) { return { end: error.code, physical, queries, budget: { ...run.budget() } }; }
	};
	const loop = (n) => `for (let i=0;i<${n};i++) await player.wait(1);`;
	assert.deepEqual(drive(`${loop(1024)} ${loop(1024)}`), { end: 'idle', physical: 2048, queries: 0, budget: { commandsUsed: 2048, commandsRemaining: 0, queriesUsed: 0 } });
	assert.deepEqual(drive(`${loop(1024)} ${loop(1024)} await player.wait(1);`), { end: 'COMMAND_LIMIT', physical: 2048, queries: 0, budget: { commandsUsed: 2048, commandsRemaining: 0, queriesUsed: 0 } });
	assert.deepEqual(drive(`await world.inspect({section:"inventory"}); ${loop(1024)} ${loop(1024)}`), { end: 'COMMAND_LIMIT', physical: 2047, queries: 1, budget: { commandsUsed: 2048, commandsRemaining: 0, queriesUsed: 1 } });
});

test('contract: default resume budgets enforce 128 iterations and 1024 operations separately', () => {
	const values = Array(128).fill(1).join(',');
	const loop = vm(`let sum = 0; for (const n of [${values}]) sum += n; await player.wait(sum);`, { limits: { operationsPerResume: 100000 } });
	assert.equal(loop.start(createInterpreterFacts(observation)).call.arguments, 128);
	const tooMany = vm(`for (const n of [${values},1]) {}`, { limits: { operationsPerResume: 100000 } });
	assert.throws(() => tooMany.start(createInterpreterFacts(observation)), error => error.code === 'LOOP_LIMIT' && /128/.test(error.message));
	const operations = vm(`let sum = 0; ${Array(600).fill('sum += 1;').join(' ')}`);
	assert.throws(() => operations.start(createInterpreterFacts(observation)), error => error.code === 'OPERATION_LIMIT' && /1024/.test(error.message));
});

test('contract: concatenation accepts strings only and authored strings respect the 4 KiB byte limit', () => {
	assert.equal(vm('program.finish("a" + "b");').start(createInterpreterFacts(observation)).summary, 'ab');
	assert.throws(() => vm('program.finish("a" + 1);').start(createInterpreterFacts(observation)), error => error.code === 'INVALID_OPERAND');
	assert.equal(vm(`program.finish("${'x'.repeat(4096)}");`).start(createInterpreterFacts(observation)).summary.length, 4096);
	assert.throws(() => vm(`program.finish("${'x'.repeat(4097)}");`).start(createInterpreterFacts(observation)), error => error.code === 'OUTPUT_LIMIT');
	assert.throws(() => vm(`program.finish("${'😀'.repeat(1025)}");`).start(createInterpreterFacts(observation)), error => error.code === 'OUTPUT_LIMIT');
});

test('contract: undocumented ambient, computed, optional, array-method and parallel physical access is rejected', () => {
	for (const body of [
		'Math.abs(1);', 'globalThis.x;', 'const rows = world.items(); rows[0];',
		'player.state()?.health;', 'world.items().map(() => 1);', '"abc".slice(0);',
		'await Promise.all([player.wait(1), player.wait(2)]);',
	]) assert.throws(() => vm(body), error => error.name === 'ArenaScriptError');
});

test('contract: every advertised player API member executes its declared physical primitive with accepted arguments', () => {
	const fixtures = new Map();
	for (const example of JSON.parse(readFileSync(new URL('../../src/test/resources/player-action-schema-cases.json', import.meta.url), 'utf8'))) {
		if (example.valid && !fixtures.has(example.action.type)) fixtures.set(example.action.type, example.action);
	}
	const reference = readFileSync(new URL('../config/minecraft-agent/.codex/skills/minecraft-control/references/control-reference.md', import.meta.url), 'utf8');
	for (const match of reference.matchAll(/```json executor-call\r?\n([\s\S]*?)\r?\n```/g)) {
		const example = JSON.parse(match[1]);
		const normalized = normalizeMinecraftToolCall(example.tool, example.arguments);
		const actions = normalized.kind === 'action' ? [normalized] : normalized.kind === 'sequence' ? normalized.actions : [];
		for (const action of actions) if (!fixtures.has(action.actionType)) fixtures.set(action.actionType, { type: action.actionType, ...action.arguments });
	}
	// moveTo's native wrapper uses navigate_to, while the program member preserves move_to.
	fixtures.set('move_to', { type: 'move_to', x: 1, y: 64, z: 0, tolerance: 1, sprint: true });
	for (const [member, primitive] of Object.entries(PLAYER_MEMBER_PRIMITIVES)) {
		assert.ok(fixtures.has(primitive), `no real accepted fixture for player.${member}`);
		const { type: _type, ...args } = fixtures.get(primitive);
		const sourceArgs = primitive === 'wait' ? args.durationMs : args;
		const run = vm(`const receipt = await player.${member}(${Object.keys(args).length ? JSON.stringify(sourceArgs) : ''}); if (receipt.succeeded) program.finish("${member}");`);
		const command = run.start(createInterpreterFacts(observation));
		assert.equal(command.call.primitive, primitive, member);
		const emitted = primitive === 'wait' ? { durationMs: command.call.arguments } : command.call.arguments;
		assert.deepEqual(validateAction({ type: primitive, ...emitted }), validateAction(fixtures.get(primitive)), member);
		assert.equal(run.resume(done(command), createInterpreterFacts(observation)).summary, member);
	}
});

test('contract: the published collection example mines and picks observed drops before checking real inventory', () => {
	const source = ARENA_SCRIPT_API_REFERENCE.split('Multi-tree collection example:\n')[1].split('\n\nWatcher example.')[0];
	const run = new ArenaScriptInterpreter(parseArenaScript(source), SCRIPT_BINDINGS);
	const first = run.start(createInterpreterFacts({ ...observation, inventory: { items: [], tagCounts: {} } }));
	assert.equal(first.call.primitive, 'break_block');
	assert.equal(first.call.arguments.expectedBlockId, undefined);
	const picked = run.resume(done(first), createInterpreterFacts({ ...observation, blocks: [], inventory: { items: [], tagCounts: {} } }));
	assert.equal(picked.call.primitive, 'pick_up_item');
	assert.equal(picked.call.arguments.targetSelector, 'drop');
	const terminal = run.resume(done(picked), createInterpreterFacts({ ...observation, blocks: [], items: [], inventory: { items: [{ itemId: 'minecraft:oak_log', count: 8 }], tagCounts: { '#minecraft:logs': 8 } } }));
	assert.equal(terminal.kind, 'finish');
	assert.equal(terminal.summary, 'Done');
	const failed = new ArenaScriptInterpreter(parseArenaScript(source), SCRIPT_BINDINGS);
	const command = failed.start(createInterpreterFacts({ ...observation, items: [], inventory: { items: [], tagCounts: {} } }));
	assert.equal(failed.resume(done(command, { state: 'FAILED', reasonCode: 'TARGET_NOT_VISIBLE' }), createInterpreterFacts({ ...observation, items: [], inventory: { items: [], tagCounts: {} } })).kind, 'idle');
});

test('contract: the published reconsider watcher executes its authored shield when the threat is initially visible', () => {
	const source = ARENA_SCRIPT_API_REFERENCE.split('Handlers cannot speak or change lifecycle:\n')[1].split('\ntryResult:')[0];
	const commands = [], decisions = [];
	const engine = new ArenaScriptEngine({ dispatch: command => commands.push(command), cancel: () => {}, requestModel: decision => decisions.push(decision) });
	engine.install({ agentId: 'contract', goalRevision: 1, modelIdentity: 'chosen-model', programId: 'contract-example', version: 1,
		compiled: parseArenaScript(source), parameters: { threatId: 'pig' }, observation, eventSequence: 1 });
	assert.equal(commands.length, 1);
	assert.equal(commands[0].action.type, 'block_with_shield');
	assert.equal(commands[0].action.arguments.durationMs, 750);
	engine.ingestActionResult({ actionId: commands[0].actionId, state: 'SUCCEEDED', reasonCode: 'DONE', eventSequence: 1 });
	assert.equal(commands.length, 1, 'only the model may authorize unrelated work after the handler');
	assert.equal(decisions.at(-1).trigger, 'defensive_handler_completed');
});

test('contract: a frontier receipt does not satisfy a scripted arrival guard', () => {
	const run = vm(`
		const arrived = await tryResult(player.navigateTo({x:10,y:64,z:0,tolerance:1,sprint:true,timeoutMs:30000}));
		if (arrived.succeeded) await player.mine({x:11,y:64,z:0,expectedBlockId:"minecraft:stone",timeoutMs:15000});
		await player.wait(1);
	`);
	const travel = run.start(createInterpreterFacts(observation));
	assert.equal(travel.call.primitive, 'navigate_to');
	const next = run.resume(done(travel, { state:'FAILED', reasonCode:'REACHED_FRONTIER' }), createInterpreterFacts(observation));
	assert.equal(next.call.primitive, 'wait', 'partial travel cannot enter the arrival-dependent mining branch');
});

test('contract: furnace load and take all execute exact authored calls and correlate receipts', () => {
	for (const args of [
		{ x: 1, y: 64, z: 2, operation: 'load', inventorySlot: 9, count: 8, expectedItemId: 'minecraft:raw_iron', fuelSlot: 10, fuelCount: 1, expectedFuelItemId: 'minecraft:coal', timeoutMs: 5000 },
		{ x: 1, y: 64, z: 2, operation: 'take_output', timeoutMs: 5000 },
	]) {
		const run = vm(`const receipt = await player.furnaceTransaction(${JSON.stringify(args)}); if (receipt.succeeded) program.finish("furnace");`);
		const command = run.start(createInterpreterFacts(observation));
		assert.equal(command.call.primitive, 'furnace_transaction');
		assert.deepEqual(JSON.parse(JSON.stringify(command.call.arguments)), args);
		assert.deepEqual(validateAction({ type: 'furnace_transaction', ...args }), { type: 'furnace_transaction', ...args });
		assert.equal(run.resume(done(command), createInterpreterFacts(observation)).summary, 'furnace');
	}
});

test('contract: remembered furnace counts and estimates are immutable script world facts', () => {
	const furnaces = [{ x: 1, y: 64, z: 2, state: 'estimate', input: { count: 8 }, fuel: { count: 1 }, output: { count: 0 }, estimatedReadyAtEpochMs: 81000 }];
	const facts = createInterpreterFacts({ ...observation, furnaces });
	assert.deepEqual(JSON.parse(JSON.stringify(facts.world.state.furnaces)), furnaces);
	assert.ok(Object.isFrozen(facts.world.state.furnaces));
	assert.ok(Object.isFrozen(facts.world.state.furnaces[0].input));
});

test('contract: authored placement modes and factual causes survive correlated program results', () => {
	for (const member of ['placeBlock', 'place']) {
		for (const faceMode of ['preferred', 'strict']) {
			const run = vm(`const receipt = await tryResult(player.${member}({x:1,y:64,z:0,face:"east",itemId:"minecraft:obsidian",faceMode:"${faceMode}"}));
				if (!receipt.succeeded && receipt.reasonCode === "NO_PLACEMENT_SUPPORT" && receipt.cause === "SUPPORT_FACE_HIDDEN") program.finish("factual");`);
			const command = run.start(createInterpreterFacts(observation));
			assert.equal(validateAction({ type: command.call.primitive, ...command.call.arguments }).faceMode, faceMode);
			assert.equal(run.resume(done(command, { state: 'FAILED', reasonCode: 'NO_PLACEMENT_SUPPORT', cause: 'SUPPORT_FACE_HIDDEN' }), createInterpreterFacts(observation)).summary, 'factual');
		}
	}
	const legacy = vm('const r = await player.wait(1); if (r.cause === null) program.finish("absent");');
	const command = legacy.start(createInterpreterFacts(observation));
	assert.equal(legacy.resume(done(command), createInterpreterFacts(observation)).summary, 'absent');
});
