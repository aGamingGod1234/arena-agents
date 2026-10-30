import test from 'node:test';
import assert from 'node:assert/strict';
import { compactProjectileObservation } from '../src/projectile-attention.mjs';
import { validateProtocolV2Payload } from '../src/protocol-v2.mjs';
import { adaptObservation } from '../src/observation-adapter.mjs';
import { DangerSteerCoalescer } from '../src/danger-steer-coalescer.mjs';
import { buildNativeEventInput, classifyObservationTrigger, nativeSteerInterruption } from '../src/dynamic-main.mjs';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { FakePlanner, eventually, start, factToWireObservation } from './fixtures/dynamic-main-fixture.mjs';
import { toolResultContent } from '../src/native-minecraft-tools.mjs';
const row = { uuid: 'arrow', type: 'minecraft:arrow', bearing: 0, etaSeconds: 0.4, damaging: true };
const request = (entry) => ({ nativeEvent: { observation: { player: { incomingProjectiles: [entry] } } } });
test('damaging projectile warnings return a blocking tool to the model', () => {
	for (const entry of [row, { ...row, etaSeconds: 0 }, { ...row, etaSeconds: 1 }, { ...row, damaging: false }]) {
		assert.equal(nativeSteerInterruption({ ...request(entry), trigger: 'projectile' }), entry.damaging === false ? null : 'danger');
	}
	assert.equal(nativeSteerInterruption({ observation: { incomingProjectiles: [row] } }), null);
});

// A11 C1/D1/F1: ghast and blaze fireballs and skeleton arrows were ordinary, so a blocking wait sat through them.
test('a new damaging flight of any kind is urgent attention; harmless or already-reported flights stay ordinary', () => {
	for (const type of ['minecraft:arrow', 'minecraft:fireball', 'minecraft:small_fireball', 'minecraft:trident']) {
		for (const fresh of [{ new: true }, { imminentNew: true }]) {
			assert.deepEqual(classifyObservationTrigger({ changedFacts: ['projectile'] }, { player: { incomingProjectiles: [{ ...row, type, etaSeconds: 1.5, ...fresh }] } }),
				{ attention: true, priority: 'urgent', trigger: 'projectile' });
		}
	}
	assert.deepEqual(classifyObservationTrigger({ changedFacts: ['projectile'] }, { player: { incomingProjectiles: [{ ...row, damaging: false, new: true }] } }),
		{ attention: true, priority: 'ordinary', trigger: 'projectile' });
	assert.equal(classifyObservationTrigger({ changedFacts: ['projectile'] }, { incomingProjectiles: [row] }).priority, 'ordinary');
	assert.equal(classifyObservationTrigger({ trigger: 'projectile', priority: 'urgent' }, { incomingProjectiles: [{ ...row, etaSeconds: 1 }] }).priority, 'ordinary');
	assert.equal(nativeSteerInterruption({ trigger: 'projectile', observation: { player: { incomingProjectiles: [{ ...row, type: 'minecraft:fireball' }] } } }), 'danger', 'a ghast fireball explodes past a shield');
	assert.equal(nativeSteerInterruption({ trigger: 'projectile', observation: { player: { incomingProjectiles: [{ ...row, new: true }] } } }), 'danger', 'an arrow returns control before impact');
});

test('damage steering folds volley identities and imminence repeats, but warns at once for a new flight kind', () => {
	const coalescer = new DangerSteerCoalescer();
	const flight = (uuid, type = 'minecraft:arrow', etaSeconds = 0.4) => ({ trigger: 'damage', observation: { player: { health: 20, incomingProjectiles: [{ ...row, uuid, type, etaSeconds }] } } });
	assert.equal(coalescer.offer(flight('one'), 0).action, 'deliver');
	assert.equal(coalescer.offer(flight('two'), 100).action, 'fold');
	assert.equal(coalescer.offer(flight('three', 'minecraft:arrow', 0.1), 200).action, 'fold');
	assert.equal(coalescer.offer(flight('ghast', 'minecraft:fireball', 0.4), 300).action, 'deliver');
	assert.equal(coalescer.offer(flight('ghast2', 'minecraft:fireball'), 400).action, 'fold');
	const flushed = coalescer.flush(2300);
	assert.equal(flushed.dangerSummary.foldedEvents, 1);
	assert.equal(flushed.observation.player.incomingProjectiles[0].uuid, 'ghast2');
});

test('projectile warnings preserve stronger threat and hazard attention, including explicit projectile triggers', () => {
	for (const [fact, trigger] of [['threats.creeper.swelling', 'threat'], ['threats.creeper.creeper_close', 'threat'], ['player.inLava', 'lava'], ['player.fire', 'fire'], ['player.air', 'suffocation'], ['player.fallDistance', 'fall']]) {
		for (const explicit of [{}, { trigger: 'projectile', priority: 'urgent' }]) {
			assert.deepEqual(classifyObservationTrigger({ ...explicit, changedFacts: ['projectile', fact] }, { player: { incomingProjectiles: [row] } }),
				{ attention: true, priority: 'urgent', trigger });
		}
	}
});

test('ordinary flights bypass danger folding while real hits retain their interval', () => {
	const flight = { trigger: 'projectile', observation: { player: { health: 20, incomingProjectiles: [row] } } };
	const damage = { ...flight, trigger: 'damage' };
	const coalescer = new DangerSteerCoalescer();
	assert.equal(coalescer.offer(damage, 0).action, 'deliver');
	assert.equal(coalescer.offer(damage, 100).action, 'fold');
	assert.equal(coalescer.offer(flight, 200).action, 'deliver');
	assert.equal(coalescer.hasFolded(), false);
	assert.equal(coalescer.offer(damage, 300).action, 'fold');
	assert.equal(coalescer.offer(damage, 2000).action, 'deliver');
});

test('creeper and imminent threat signals interrupt for every trigger kind', () => {
	for (const trigger of ['projectile', 'threat', 'chat', 'observation']) {
		for (const signal of ['swelling', 'creeper_close', 'imminent']) {
			assert.equal(nativeSteerInterruption({ trigger, observation: { player: { incomingProjectiles: [row], threats: [{ type: 'minecraft:creeper', signals: [signal] }] } } }), 'danger');
		}
		assert.equal(nativeSteerInterruption({ trigger, observation: { player: { threats: [{ type: 'minecraft:creeper', swelling: true }] } } }), 'danger');
	}
});

test('a drawn bow interrupts only as its own threat edge, not inside every later steer', () => {
	const aiming = { player: { incomingProjectiles: [row], threats: [{ type: 'minecraft:skeleton', signals: ['ranged_aiming'] }] } };
	assert.equal(nativeSteerInterruption({ trigger: 'threat', observation: aiming }), 'danger');
	assert.equal(nativeSteerInterruption({ trigger: 'projectile', observation: aiming }), 'danger', 'the incoming arrow independently interrupts');
	for (const trigger of ['chat', 'observation']) assert.equal(nativeSteerInterruption({ trigger, observation: aiming }), null);
});

test('visible projectile facts reach the model and disappear quietly with no always-sent bytes', () => {
	const wire = { ready: true, position: { x:0,y:0,z:0 }, view: { yaw:0,pitch:0 }, player:{}, inventory:{items:[],selectedItem:'minecraft:air'}, entities:[], blocks:[], incomingProjectiles: [row] };
	assert.deepEqual(adaptObservation(wire).player.incomingProjectiles, [row]);
	delete wire.incomingProjectiles;
	assert.equal(Object.hasOwn(adaptObservation(wire).player, 'incomingProjectiles'), false);
});

test('protocol validates projectile rows and factual attention path', () => {
	const wire = { goalRevision:1,observedAtEpochMs:1,ready:true,status:'READY',eventSequence:1,attention:true,changedFacts:['projectile'],position:{x:0,y:0,z:0},velocity:{x:0,y:0,z:0},view:{yaw:0,pitch:0},player:{health:20,maxHealth:20,armor:0,foodLevel:20,saturation:5,gameMode:'survival',onGround:true,inWater:false,onFire:false,air:300,maxAir:300,suffocating:false,fallDistance:0,effects:[]},inventory:{items:[],selectedItem:'minecraft:air'},entities:[],blocks:[],nearbyContainers:[],world:{dimension:'minecraft:overworld',gameTime:0,dayTime:0,raining:false,thundering:false},currentAction:{active:false},lastResult:{present:false},incomingProjectiles:[row] };
	assert.deepEqual(validateProtocolV2Payload('observation', wire).incomingProjectiles, [row]);
	assert.throws(() => validateProtocolV2Payload('observation', { ...wire, incomingProjectiles: [{ ...row, etaSeconds:NaN }] }));
	assert.throws(() => validateProtocolV2Payload('observation', { ...wire, incomingProjectiles: [{ ...row, secret:1 }] }));
});

test('model projection pays for flight facts and preserves trajectory and program observations', () => {
	const entity = { stableId:'arrow',type:'minecraft:arrow',x:0.2,y:65.125,z:5.721,velocity:{x:0,y:0,z:-1},name:'Arrow',distance:5.8,yaw:180,pitch:-20,pose:'standing',pickable:false,perceivedBy:'sight',bounds:{minX:-0.04999999999999999,minY:65.125,minZ:5.471,maxX:0.45,maxY:65.625,maxZ:5.971} };
	const original = { player:{ incomingProjectiles:[{...row,new:true}] }, entities:[entity] };
	const compact = compactProjectileObservation(original);
	assert.deepEqual(compact.entities[0], {stableId:'arrow',type:'minecraft:arrow',x:0.2,y:65.125,z:5.721,velocity:{x:0,y:0,z:-1}});
	assert.equal(original.entities[0], entity);
	assert.equal(original.player.incomingProjectiles[0].new, true);
	assert.equal(compact.player.incomingProjectiles[0].new, undefined);
	const before = JSON.stringify({player:{},entities:[entity]});
	assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= Buffer.byteLength(before), 'new warning bytes paid by rendering fields');
	const event = buildNativeEventInput({}, {observation:original,trigger:'projectile'});
	assert.equal(event.includes('minX'), false);
	assert.equal(event.includes('incomingProjectiles'), true);
	const content = toolResultContent({observation:original}).contentItems[0].text;
	assert.equal(content.includes('minX'), false);
	assert.equal(content.includes('incomingProjectiles'), true);
	assert.equal(entity.bounds.minX, -0.04999999999999999);
});

test('imminent volley returns the blocking tool for a model decision before impact; a creeper also interrupts', async () => {
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	const steers = [];
	let bodyResult;
	planner.requestNativeTurn = async request => {
		planner.requests.push(request);
		bodyResult = await request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision,
			turnId: 'projectile-wait', callId: 'wait', tool: { kind: 'action', actionType: 'wait', arguments: { durationMs: 30000 } } });
		await gate;
		return { toolCalls: 1 };
	};
	planner.steerNativeTurn = async request => { request.onInterrupt?.(); steers.push(request); return { turnId: 'projectile-wait' }; };
	const timers = [];
	const holds = [];
	const run = await start({ registry, planner, controlNow: () => 100,
		setSteerTimeout: (callback, delayMs) => { const timer = { callback, delayMs }; timers.push(timer); return timer; },
		clearSteerTimeout: () => {},
		setWakeHoldTimeout: (callback, delayMs) => { const timer = { callback, delayMs }; holds.push(timer); return timer; },
		clearWakeHoldTimeout: () => {},
		config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
	const emit = (sequence, incomingProjectiles = [], threats = [], facts = incomingProjectiles.length ? ['projectile'] : []) => {
		const payload = factToWireObservation({ player: { x: 0, y: 64, z: 0, health: 20 }, inventory: { items: [] } }, 1, sequence,
			incomingProjectiles.length > 0, sequence, facts);
		payload.incomingProjectiles = incomingProjectiles;
		payload.threats = { entries: threats };
		run.bridge.emit('observation', { agentId: 'agent-a', payload });
	};
	try {
		run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Wait.' } });
		emit(1);
		await eventually(() => run.bridge.sent.some(message => message.type === 'action_command'));
		emit(2, [row]);
		await eventually(() => steers.length === 1);
		assert.equal(holds.length, 0, 'protected facts do not wait behind the ordinary action hold');
		emit(3, [{ ...row, uuid: 'second' }]);
		await eventually(() => steers.length === 2);
		assert.equal(timers.length, 0);
		assert.equal(bodyResult.interruptedBy, 'danger', 'the warning returns control to the model');
		assert.equal(planner.requests.length, 1);
		emit(4, [row], [{ uuid: 'creeper', type: 'minecraft:creeper', distance: 4, bearing: 0, targeting: true, swelling: true, lineOfSight: true, signals: ['swelling'] }], ['projectile', 'threats.creeper.swelling']);
		await eventually(() => steers.length === 3);
		assert.equal(steers.length, 3);
		assert.equal(bodyResult.interruptedBy, 'danger');
		const command = run.bridge.sent.find(message => message.type === 'action_command');
		run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: command.payload.actionId,
			state: 'SUCCEEDED', reasonCode: 'WAITED', executionStarted: true, eventSequence: 4 } });
		release();
	} finally { release(); await run.coordinator.stop(); }
});

test('a movement loop closed in a sample with a flight still wakes the model as a loop', () => {
	assert.deepEqual(classifyObservationTrigger({ changedFacts: ['projectile'] }, { player: { incomingProjectiles: [row] } }, { movementLoop: true }),
		{ attention: true, priority: 'urgent', trigger: 'movement_loop' });
});

test('dragon fireball warnings are urgent and interrupt before the breath cloud lands', () => {
	const flight = { ...row, type: 'minecraft:dragon_fireball', new: true };
	const observation = { player: { incomingProjectiles: [flight] } };
	assert.deepEqual(classifyObservationTrigger({ changedFacts: ['projectile'] }, observation),
		{ attention: true, priority: 'urgent', trigger: 'projectile' });
	assert.equal(nativeSteerInterruption({ trigger: 'projectile', observation }), 'danger');
	assert.equal(classifyObservationTrigger({ changedFacts: ['projectile'] }, { player: { incomingProjectiles: [{ ...flight, damaging: false }] } }).priority, 'ordinary');
});

test('cloud bounds, ongoing breath and nearest exit reach the model as urgent attention', () => {
	const cloud = { uuid: 'breath', source: 'dragon_breath', harmful: true, contact: true, radius: 3,
		bounds: { minX: -3, minY: 0, minZ: -3, maxX: 3, maxY: 0.5, maxZ: 3 },
		nearestExit: { x: 4, y: 0, z: 0 }, exitRoute: 'unverified' };
	const harm = { source: 'minecraft:dragon_breath', ongoing: true, options: ['leave_cloud', 'healing'] };
	const wire = factToWireObservation({ player: { x: 0, y: 0, z: 0, health: 20, clouds: [cloud], harm } }, 1, 1, true, 1000, ['player.clouds']);
	wire.player.clouds = [cloud]; wire.player.harm = harm;
	const validated = validateProtocolV2Payload('observation', { ...wire, eventSequence: 1, attention: true, changedFacts: ['player.clouds'] });
	const facts = adaptObservation(validated);
	assert.deepEqual(facts.player.clouds, [cloud]);
	assert.deepEqual(facts.player.harm, harm);
	assert.deepEqual(classifyObservationTrigger(validated, facts), { attention: true, priority: 'urgent', trigger: 'cloud' });
	assert.equal(nativeSteerInterruption({ trigger: 'cloud', observation: facts }), 'danger');
	const input = buildNativeEventInput({}, { event: 'observation', trigger: 'cloud', observation: facts });
	assert.match(JSON.stringify(input), /nearestExit/);
	assert.match(JSON.stringify(input), /dragon_breath/);
});
