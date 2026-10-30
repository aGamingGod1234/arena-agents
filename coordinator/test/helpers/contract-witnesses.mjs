import { readFileSync } from 'node:fs';
import { CONTROL_FILE } from './contract-inventory.mjs';
import { normalizeMinecraftToolCall } from '../../src/native-minecraft-tools.mjs';

export function contractWitnesses() {
	const text = readFileSync(new URL(`../../${CONTROL_FILE}`, import.meta.url), 'utf8');
	const calls = [...text.matchAll(/```json executor-call\r?\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]));
	const id = '550e8400-e29b-41d4-a716-446655440000';
	const source = 'program.onUnhandledAttention("pause_and_notify"); await player.wait(1);';
	const action = { actionType: 'wait', arguments: { durationMs: 1 } };
	const evidence = { itemIds: ['minecraft:stone'], count: 1, dimension: 'minecraft:overworld', x: 0, y: 64, z: 0, blockId: 'minecraft:stone' };
	const entry = { kind: 'route', key: 'route', label: 'Route', summary: 'Observed route', from: 'a', to: 'b', position: { x: 0, y: 64, z: 0 }, waypoints: [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }], status: 'active', shared: true };
	const more = {
		taskMemory: [{ operation: 'remember', entry }, { operation: 'query', query: { kind: 'all', dimension: 'minecraft:overworld', text: 'route', offset: 0, limit: 20 } }],
		observe: [{ view: 'changes', afterObservationId: 'observation-1' }],
		capabilities: [{ section: 'control', topic: 'all', offset: 0 }, { section: 'all' }, { section: 'program' }, { section: 'strategy', topic: 'resources' }],
		inspect: [{ section: 'survey', include: ['structures'], exclude: ['built'], limit: 1 }, { section: 'item', slot: 0 }, { section: 'block', x: 0, y: 64, z: 0 }, { section: 'events', afterSequence: 1 }, { section: 'entities', entityType: 'minecraft:zombie' }, { section: 'recipes', outputItemId: 'minecraft:stick' }, { section: 'recipes', recipeId: 'minecraft:stick' }],
		actionStatus: [{ actionId: 'action-1' }], cancelAction: [{ actionId: 'action-1', goalRevision: 1 }],
		replaceAction: [{ actionId: 'action-1', goalRevision: 1, ...action }], startAction: [action],
		queryMemory: [{ kind: 'unresolved', text: 'wait', offset: 0, limit: 64 }],
		runProgram: [{ reflexes: [{ id: 'schema-witness', when: { type: 'tool_broke', tool: 'pickaxe' }, do: { type: 'select', tool: 'pickaxe' }, ttlS: 60 }] }, { source, background: true, parameters: {}, observationIntervalMs: 100, maxActions: 64, timeoutMs: 30000, expectedDurationMs: 1 }, { noteKey: 'wait' }, { standing: { id: 'test', when: 'false', guard: true }, source: 'program.onUnhandledAttention("continue_and_notify", {survival:"continue_and_notify"});' }],
		queueProgram: [{ afterProgramId: 'program-1', goalRevision: 1, programVersion: 1, precondition: 'true', source, parameters: {}, observationIntervalMs: 100, maxActions: 64, timeoutMs: 30000, expectedDurationMs: 1 }, { afterProgramId: 'program-1', goalRevision: 1, programVersion: 1, precondition: 'true', noteKey: 'wait' }],
		cancelQueuedProgram: [{ afterProgramId: 'program-1', goalRevision: 1, queueId: 'queue-1' }],
		programStatus: [{ programId: 'program-1' }], cancelProgram: [{ programId: 'program-1', goalRevision: 1 }],
		respondProgram: [{ programId: 'program-1', goalRevision: 1, decisionId: 'decision-1', eventSequence: 1, directive: 'replace', source }],
		lookAround: [{ centerYaw: 0, pitch: 0, steps: 2, ticksPerStep: 1, survey: { include: ['blocks:minecraft:stone'], exclude: ['built'], limit: 1 } }],
		survey: [{ include: ['structures'], exclude: ['built'], limit: 1 }],
		control: [{ forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, attack: false, use: false, yaw: 0, pitch: 0, selectedSlot: 0, hand: 'main', ticks: 1, instantLook: true }],
		moveTo: [{ x: 0, y: 64, z: 0, tolerance: 1, sprint: true, timeoutMs: 1, view: 'changes', afterObservationId: 'observation-1' }],
		travelTo: [{ x: 0, y: 64, z: 100, retrace: true, dimension: 'minecraft:overworld', tolerance: 3, build: true, stopWhenSeen: 'minecraft:nether_bricks', minHealth: 8, timeoutMs: 1, view: 'changes', afterObservationId: 'observation-1' }, { yaw: 90, distance: 200 }],
		exploreFrontier: [{ radius: 16, limit: 1, offset: 0, blockId: 'minecraft:stone' }],
		mine: [{ x: 0, y: 64, z: 0, expectedBlockId: 'minecraft:stone', timeoutMs: 1, autoAim: true, acceptLavaRisk: true, view: 'changes', afterObservationId: 'observation-1' }],
		say: [{ message: 'Hello', audience: 'direct', recipientId: id }],
		act: [{ ...action, view: 'changes', afterObservationId: 'observation-1' }, { ...action, reflexes: [{ id: 'schema-witness', when: { type: 'on_fire' }, do: { type: 'take_cover', within: 4 }, ttlS: 60 }] }],
		sequence: [{ actions: [action, action], finish: { summary: 'Verify the goal.' }, view: 'changes', afterObservationId: 'observation-1' }, { actions: [action, action], reflexes: [{ id: 'schema-witness', when: { type: 'on_fire' }, do: { type: 'take_cover', within: 4 }, ttlS: 60 }] }],
		taskPlan: [{ operation: 'replace', plan: { steps: [{ id: 'step', label: 'Stone', kind: 'inventory', status: 'pending', dependsOn: [], detail: '', evidence, check: 'has:minecraft:stone*1' }] } }, { operation: 'replace', plan: { steps: [{ id: 'child', label: 'Child', kind: 'manual', status: 'pending', dependsOn: ['root'], detail: '', evidence: null, check: null }, { id: 'root', label: 'Root', kind: 'manual', status: 'pending', dependsOn: [], detail: '', evidence: null, check: null }] } }],
		takeTask: [{ request: 'Collect stone', requesterId: id, resume: true }],
	};
	more.taskPlan.push({ operation: 'intent', intent: { step: 'step', why: 'Stone for tools', via: 'mine visible stone', until: 'has stone', unless: 'a threat appears', next: 'craft pickaxe' } });
	const inspectAfter = { section: 'blocks', offset: 0, limit: 12 };
	more.moveTo.push({ x: 0, y: 64, z: 0, inspectAfter });
	more.travelTo.push({ x: 0, z: 100, inspectAfter });
	more.act.push({ ...action, inspectAfter });
	more.sequence.push({ actions: [action, action], inspectAfter });
	for (const [tool, values] of Object.entries(more)) for (const args of values) calls.push({ tool, arguments: args });
	for (const call of calls) normalizeMinecraftToolCall(call.tool, call.arguments);
	return calls;
}

export function pathKeys(path) { return path.replaceAll('[]', '.0').split('.').filter(Boolean); }
export function readPath(object, path) { for (const key of pathKeys(path)) { if (object === undefined || object === null || !Object.hasOwn(object, key)) return undefined; object = object[key]; } return object; }
export function mutatePath(object, path, value, remove = false) {
	const copy = structuredClone(object), keys = pathKeys(path), leaf = keys.pop();
	let parent = copy;
	for (const key of keys) parent = parent[key];
	if (leaf === undefined) return value;
	if (remove) delete parent[leaf]; else parent[leaf] = value;
	return copy;
}
