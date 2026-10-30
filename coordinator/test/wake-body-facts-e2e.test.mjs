import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { decodeModelFacts, encodeNativeEventInput, ModelObservationViews } from '../src/model-fact-encoding.mjs';
import { LIGHT_LINE_BYTES, TOOLS_LINE_BYTES } from '../src/wake-body-facts.mjs';
import { FakePlanner, RecordingGoalSupervisor, eventually, factToWireObservation, start } from './fixtures/dynamic-main-fixture.mjs';

const CONFIG = { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } };
const item = (id, count, damage = 0, maxDamage = 0) => ({ itemId: `minecraft:${id}`, count, damage, maxDamage });
function wire(sequence, { dayTime = 9_600, dimension = 'minecraft:overworld', skyOpen = true,
	items = [item('stone_pickaxe', 1, 119, 131), item('cobblestone', 3), item('stick', 2)] } = {}) {
	return { agentId: 'agent-a', payload: factToWireObservation({ player: { x: 10, y: 64, z: 10, skyOpen }, inventory: { items, selectedSlot: 0, selectedItem: items[0]?.itemId ?? 'minecraft:air' },
		world: { worldId: 'feel-world', dimension, dayTime, gameTime: 30_000 + sequence, raining: false, thundering: false } }, 1, sequence * 10, true, sequence * 1_000, ['inventory', 'world']) };
}

async function coordinator(t) {
	const registry = new AgentRegistry(), planner = new FakePlanner(registry), rows = [];
	planner.getExecutionSettings = () => ({ provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' });
	planner.requestNativeTurn = async request => { planner.requests.push(request); return { toolCalls: 0 }; };
	const run = await start({ registry, planner, goalSupervisor: new RecordingGoalSupervisor(), config: CONFIG,
		traceWriter: { write(event, fields) { rows.push({ event, ...fields }); } } });
	t.after(() => run.coordinator.stop());
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'beat the game.' } });
	return { run, planner, async wake(sample) {
		const before = planner.requests.length;
		await eventually(() => rows.filter(row => row.event === 'native_turn_completed').length >= before);
		run.bridge.emit('observation', sample);
		await eventually(() => planner.requests.length > before);
		assert.equal(rows.some(row => row.event === 'task_view_observation_error'), false);
		return JSON.parse(planner.requests.at(-1).input.split('\n')[1]);
	} };
}

test('production ingress carries dusk and worn-tool facts without a plan, and only per-event data changes', async t => {
	const { wake, planner } = await coordinator(t);
	const dusk = await wake(wire(1));
	assert.equal(dusk.now.light, 'dusk in ~2m (day 1); night lasts ~8m; mobs spawn in darkness; sky-exposed');
	assert.equal(dusk.now.tools, 'stone_pickaxe 12 uses left (no spare pickaxe; replacement materials held: 3 cobblestone + 2 stick; crafting_table not held/seen)');
	assert.equal(dusk.observation.world.dayTime, undefined, 'world clock is stripped from the model observation but the header survives');
	assert.equal(dusk.observation.inventory.items[0].usesLeft, 12, 'real adaptation preserves slot wear');
	const night = await wake(wire(2, { dayTime: 16_000, skyOpen: false,
		items: [item('stone_pickaxe', 1, 120, 131), item('wooden_pickaxe', 1, 55, 59)] }));
	assert.match(night.now.light, /^night \(day 1\); sunrise in ~6m; mobs spawn in darkness; sky covered$/);
	assert.match(night.now.tools, /^stone_pickaxe 11 uses left \(1 spare pickaxe held: wooden_pickaxe 4 uses; replacement materials not all held\)$/);
	assert.ok(Buffer.byteLength(dusk.now.light) <= LIGHT_LINE_BYTES);
	assert.ok(Buffer.byteLength(dusk.now.tools) <= TOOLS_LINE_BYTES);
	assert.equal(night.goal, dusk.goal);
	// The actual provider encoding can delta these new header fields just like known/options/mining. A context
	// rotation replays them; stable system instructions and tool schemas never acquire a clock or wear reading.
	const model = new ModelObservationViews();
	const encoded = input => decodeModelFacts(JSON.parse(encodeNativeEventInput(input, model).split('\n')[1]));
	assert.equal(encoded(planner.requests[0].input).now.light, dusk.now.light);
	assert.equal(encoded(planner.requests[1].input).now.tools, night.now.tools);
	const repeated = encoded(planner.requests[1].input);
	assert.equal(repeated.now.guard, 'none installed', 'guard absence repeats on every wake');
	assert.ok(repeated.now.same.includes('light') && repeated.now.same.includes('tools'), 'unchanged daylight and wear remain retained');
	model.reset();
	assert.equal(encoded(planner.requests[1].input).now.light, night.now.light);
});

test('production ingress omits irrelevant daylight and wear, then restores facts on a later relevant sample', async t => {
	const { wake } = await coordinator(t);
	const day = await wake(wire(1, { dayTime: 1_000, items: [item('stone_pickaxe', 1, 0, 131)] }));
	assert.equal(day.now?.light, undefined);
	assert.equal(day.now?.tools, undefined);
	const nether = await wake(wire(2, { dayTime: 16_000, dimension: 'minecraft:the_nether', items: [item('iron_sword', 1, 0, 250)] }));
	assert.equal(nether.now?.light, undefined);
	assert.equal(nether.now?.tools, undefined);
	const relevant = await wake(wire(3, { dayTime: 24_000 + 13_188, items: [item('iron_shovel', 1, 225, 250)] }));
	assert.match(relevant.now.light, /^night \(day 2\)/);
	assert.match(relevant.now.tools, /^iron_shovel 25 uses left/);
	const fresh = await wake(wire(4, { dayTime: 48_000, items: [item('iron_shovel', 1, 0, 250)] }));
	assert.equal(fresh.now?.light, undefined);
	assert.equal(fresh.now?.tools, undefined);
});

test('sleep rules cross strict wire validation and adaptation into the actual provider wake', async t => {
 const {validateProtocolV2Payload}=await import('../src/protocol-v2.mjs');
 const {wake,planner}=await coordinator(t);
 const sample=wire(1,{dayTime:14000,items:[item('white_bed',1)]});
 sample.payload.world.sleep={bedExplodes:false,timeAllowsSleep:false};
 const strictPayload=structuredClone(sample.payload);
 sample.payload=validateProtocolV2Payload('observation',sample.payload);
 const event=await wake(sample);
 assert.match(event.now.sleep,/white_bed; sleep time closed/,'actual environment rule overrides nominal archived timing');
 const model=new ModelObservationViews();
 const encoded=decodeModelFacts(JSON.parse(encodeNativeEventInput(planner.requests[0].input,model).split('\n')[1]));
 assert.equal(encoded.now.sleep,event.now.sleep);
 assert.throws(()=>validateProtocolV2Payload('observation',{...strictPayload,world:{...strictPayload.world,sleep:{bedExplodes:'false',timeAllowsSleep:true}}}),/boolean/);
 assert.throws(()=>validateProtocolV2Payload('observation',{...strictPayload,world:{...strictPayload.world,sleep:{bedExplodes:false,timeAllowsSleep:true,hiddenMonsters:0}}}),/field/i);
});
