import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { discoverContracts } from './helpers/contract-inventory.mjs';
import { contractWitnesses, readPath, mutatePath } from './helpers/contract-witnesses.mjs';
import { ADJUSTED_SCHEMA_FIELDS, MAXIMUM_ADJUSTED_SCHEMA_FIELDS, normalizeMinecraftToolCall, toolAdjustments } from '../src/native-minecraft-tools.mjs';

const witnesses = contractWitnesses();
const actionCases = JSON.parse(readFileSync(new URL('../../src/test/resources/player-action-schema-cases.json', import.meta.url), 'utf8'));
const actionArguments = new Map();
for (const row of actionCases.filter(row => row.valid)) {
	const { type, ...args } = row.action;
	if (!actionArguments.has(type)) actionArguments.set(type, args);
}
for (const call of witnesses.filter(call => call.tool === 'act')) actionArguments.set(call.arguments.actionType, call.arguments.arguments);

function witness(claim) {
	const call = witnesses.find(call => call.tool === claim.tool && readPath(call.arguments, claim.path) !== undefined);
	assert.ok(call, `No real accepted witness for ${claim.id}`);
	return call.arguments;
}

// An out-of-range value for these fields is bounded and reported in the tool result instead of rejected.
function adjusted(claim, args, value) {
	const tool = normalizeMinecraftToolCall(claim.tool, mutatePath(args, claim.path, value));
	assert.ok(toolAdjustments(tool), `${claim.id} accepted ${JSON.stringify(value).slice(0, 100)} without reporting an adjustment`);
}

function rejected(claim, args, value) {
	assert.throws(() => normalizeMinecraftToolCall(claim.tool, mutatePath(args, claim.path, value)),
		{ code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' }, `${claim.id} admitted ${JSON.stringify(value).slice(0, 100)}`);
}

for (const claim of discoverContracts().filter(row => row.kind === 'schema')) {
	test(`contract schema ${claim.id}`, () => {
		const args = witness(claim), contract = claim.contract, sample = readPath(args, claim.path);
		assert.doesNotThrow(() => normalizeMinecraftToolCall(claim.tool, args));
		const bounded = ADJUSTED_SCHEMA_FIELDS.includes(`${claim.tool}.${claim.path}`);
		if (contract.type !== undefined) {
			const types = [contract.type].flat();
			for (const [type, value] of [['null', null], ['boolean', true], ['number', 1.5], ['string', 'wrong'], ['array', []]]) {
				if (!types.includes(type) && !(type === 'number' && types.includes('integer'))) rejected(claim, args, value);
			}
			if (types.includes('integer')) (bounded && contract.minimum !== undefined ? adjusted : rejected)(claim, args, 0.5);
		}
		for (const [key, delta] of [['minimum', -1], ['maximum', 1]]) if (contract[key] !== undefined && Number.isSafeInteger(contract[key] + delta)) (bounded || key === 'maximum' && MAXIMUM_ADJUSTED_SCHEMA_FIELDS.includes(`${claim.tool}.${claim.path}`) ? adjusted : rejected)(claim, args, contract[key] + delta);
		if (contract.minLength > 0) rejected(claim, args, '');
		if (contract.maxLength !== undefined) (bounded ? adjusted : rejected)(claim, args, `${'word '.repeat(contract.maxLength)}`);
		if (contract.pattern) rejected(claim, args, 'not a valid identifier !');
		if (contract.minItems > 0) rejected(claim, args, []);
		if (contract.maxItems !== undefined) rejected(claim, args, Array.from({ length: contract.maxItems + 1 }, () => structuredClone(sample[0] ?? 'x')));
		if (contract.additionalProperties === false) rejected(claim, args, { ...sample, contractUnknownField: true });
		for (const required of contract.required ?? []) {
			const value = structuredClone(sample);
			delete value[required];
			rejected(claim, args, value);
		}
	});
}

function enumCall(claim) {
	let args = mutatePath(witness(claim), claim.path, claim.value);
	if (claim.path === 'view' && claim.value === 'full') delete args.afterObservationId;
	if (claim.path === 'actionType' || claim.path === 'actions[].actionType') {
		const action = { actionType: claim.value, arguments: actionArguments.get(claim.value) };
		assert.ok(action.arguments, `No real action witness for ${claim.value}`);
		if (claim.tool === 'sequence') args.actions[0] = action;
		else Object.assign(args, action);
	}
	if (claim.tool === 'capabilities' && claim.path === 'section') args = claim.value === 'howto' ? { section: claim.value, topic: 'iron_pickaxe' } : { section: claim.value };
	if (claim.tool === 'inspect' && claim.path === 'section') {
		args = { section: claim.value };
		if (claim.value === 'item') args.slot = 0;
		if (claim.value === 'block') Object.assign(args, { x: 0, y: 64, z: 0 });
	}
	if (claim.tool === 'say' && claim.path === 'audience' && claim.value !== 'direct') delete args.recipientId;
	if (claim.tool === 'say' && claim.path === 'audience' && claim.value === 'direct') args.recipientId = '550e8400-e29b-41d4-a716-446655440000';
	if (claim.tool === 'respondProgram' && claim.path === 'directive' && claim.value !== 'replace') delete args.source;
	if (claim.tool === 'respondProgram' && claim.path === 'directive' && claim.value === 'replace') args.source = 'program.onUnhandledAttention("pause_and_notify"); await player.wait(1);';
	if (claim.tool === 'taskMemory' && claim.path === 'entry.kind' && claim.value === 'route') args.entry = witnesses.find(row => row.tool === 'taskMemory' && row.arguments.entry?.kind === 'route').arguments.entry;
	if (claim.tool === 'taskMemory' && claim.path === 'operation') args = claim.value === 'remember' ? { operation: 'remember', entry: witnesses.find(row => row.tool === 'taskMemory' && row.arguments.entry).arguments.entry } : { operation: 'query' };
	if (claim.tool === 'taskPlan' && claim.path === 'operation' && claim.value === 'read') args = { operation: 'read' };
	if (claim.tool === 'taskPlan' && claim.path === 'operation' && claim.value === 'intent') args = witnesses.find(row => row.tool === 'taskPlan' && row.arguments.intent).arguments;
	if (claim.tool === 'taskPlan' && claim.path === 'operation' && claim.value === 'replace') args = witnesses.find(row => row.tool === 'taskPlan' && row.arguments.plan).arguments;
	return args;
}

for (const claim of discoverContracts().filter(row => row.kind === 'enum')) {
	test(`contract enum ${claim.id}`, () => {
		const args = enumCall(claim);
		assert.doesNotThrow(() => normalizeMinecraftToolCall(claim.tool, args));
		rejected(claim, args, 'contract_unknown_enum');
	});
}
