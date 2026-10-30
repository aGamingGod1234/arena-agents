import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'acorn';

const JAVA = new URL('../../src/main/java/dev/agaminggod/arenaagents/', import.meta.url);

// Pair serializer objects with their actual exactKeys call, rather than a second copy of the allowlist.
const CONTRACTS = {
	'server/perception/ThreatPerception.java': [
		['toJson', 'json', 'threatsObservation/value'],
		['toJson', 'value', 'threatsObservation/entry'],
		['toJson', 'weapon', 'threatsObservation/value.bestWeapon'],
	],
	'server/perception/ProjectilePerception.java': [['toJson', 'row', 'incomingProjectileObservation/row']],
	'server/perception/SurvivalPerception.java': [
		['toJson', 'json', 'survivalObservation/value'], ['toJson', 'food', 'survivalObservation/food'],
	],
	'server/perception/FoodObservation.java': [
		['toJson', 'json', 'inventoryFoodObservation/value'], ['toJson', 'row', 'inventoryFoodObservation/row'],
	],
	'server/perception/HearingPerception.java': [['top', 'json', 'heardObservation/entry']],
	'server/perception/FurnaceMemory.java': [
		['sample', 'row', 'furnaceObservation/value'], ['json', 'row', 'furnaceObservation/value[key]'],
	],
	'server/perception/ServerObservationCollector.java': [
		['collect', 'observation', 'normalizeObservation/value'],
		['collect', 'player', 'playerObservation/value'],
		['collect', 'threat', 'playerObservation/value.lastAttacker'],
		['collect', 'world', 'worldObservation/value'],
		['spatialObservation', 'value', 'normalizeObservation/value'],
		['currentAction', 'json', 'currentActionObservation/value'],
		['lastResult', 'json', 'lastResultObservation/value'],
		['interaction', 'interaction', 'interactionObservation/value'],
		['interaction', 'inputJson', 'interactionObservation/value.input'],
		['interaction', 'menu', 'interactionObservation/value.menu'],
		['menuIdentity', 'menu', 'interactionObservation/value.menu'],
		['menuSlot', 'item', 'interactionObservation/slot'],
		['compactItem', 'item', 'interactionObservation/value.menu.cursor'],
		['rayTarget', 'rayTarget', 'interactionObservation/value.rayTarget'],
		['crosshair', 'result', 'interactionObservation/value.rayTarget'],
		['effects', 'json', 'playerObservation/effect'],
		['inventory', 'inventory', 'inventoryObservation/value'],
		['inventory', 'item', 'inventoryObservation/item', ['entry.getKey()']],
		['item', 'item', 'inventoryObservation/item'],
		['entities', 'json', 'entityObservation/value'],
		['entityDetails', 'json', 'entityObservation/value'],
		['blocks', 'json', 'blockObservation/value'],
		['blockDetails', 'block', 'blockObservation/value'],
		['landmarks', 'json', 'landmarkObservation/value'],
		['nearbyTransactionTargets', 'json', 'nearbyContainerObservation/value'],
		['addDangerFooting', 'player', 'playerObservation/value'],
	],
	'server/perception/ObservationDetails.java': [
		['item', 'item', 'inventoryObservation/item'],
		['item', 'item', 'interactionObservation/value.menu.cursor'],
		['item', 'item', 'interactionObservation/slot'],
		['entity', 'target', 'entityObservation/value'], ['combat', 'target', 'entityObservation/value'],
		['block', 'target', 'blockObservation/value'],
	],
	'server/perception/HazardFacts.java': [
		['addPlayerFacts', 'player', 'playerObservation/value'], ['rememberLava', 'player', 'playerObservation/value'],
	],
	'server/perception/WaterAirFacts.java': [['add', 'player', 'playerObservation/value']],
	'server/perception/PlayerObservationEvents.java': [
		['snapshot', 'value', 'perceptionObservation/value'],
		['snapshot', 'compact', 'perceptionObservation/bar'],
		['snapshot', 'event', 'perceptionEvent/value'],
		['record', 'owned', 'perceptionEvent/value'],
		['text', 'event', 'perceptionEvent/value'],
		['soundEvent', 'event', 'perceptionEvent/value'],
		['boss', 'bar', 'perceptionObservation/bar'], ['boss', 'event', 'perceptionEvent/value'],
	],
	'server/perception/EyeFlightObservation.java': [
		['event', 'event', 'perceptionEvent/value'], ['event', 'result', 'perceptionEvent/value'],
		['publish', 'event', 'perceptionEvent/value'],
	],
	'server/bridge/MultiplexedServerBridge.java': [
		['acceptAuthChallenge', 'payload', 'normalizeProtocolV2Payload:auth_response/value'],
		['acceptHello', 'payload', 'normalizeProtocolV2Payload:hello_ack/value'],
		['onRemoved', 'payload', 'normalizeProtocolV2Payload:agent_removed/value'],
		['onServerStopping', 'payload', 'normalizeProtocolV2Payload:shutdown/value'],
		['verboseControlEnvelope', 'payload', 'normalizeProtocolV2Payload:verbose_control/value'],
		['sendGoalSpecResult', 'result', 'normalizeProtocolV2Payload:goal_spec_result/value'],
		['acceptInspectionRequest', 'reply', 'normalizeProtocolV2Payload:inspection_result/value'],
		['requestTaskView', 'payload', 'normalizeProtocolV2Payload:task_view_request/value'],
		['completionResultPayload', 'result', 'normalizeProtocolV2Payload:goal_completion_result/value'],
		['publishKnownProgress', 'payload', 'normalizeProtocolV2Payload:plan_facts/value'],
		['conversationEventPayload', 'payload', 'normalizeConversationEvent/value'],
		['conversationWakePayload', 'payload', 'normalizeConversationWake/value'],
		['conversationWakePayload', 'control', 'normalizeGoalControl/value'],
		['goalControlPayload', 'payload', 'normalizeGoalControl/value'],
		['deathFacts', 'facts', 'normalizeDeath/value'],
		['registeredPayload', 'payload', 'normalizeRegisteredAgent/value'],
		['registeredPayload', 'error', 'normalizeRegisteredAgent/value.lastError'],
		['sendRejectedAction', 'result', 'normalizeActionResult/value'],
		['actionResultPayload', 'payload', 'normalizeActionResult/value'],
		['actionResultPayload', 'timing', 'normalizeActionTiming/value'],
		['sendActionProgress', 'payload', 'normalizeActionProgress/value'],
		['actionObservationPayload', 'payload', 'normalizeActionObservation/value'],
		['actionObservationPayload', 'collision', 'normalizeActionObservation/value.collision'],
		['actionObservationPayload', 'look', 'normalizeActionLookTarget/value'],
		['actionObservationPayload', 'value:0', 'normalizeActionObservation/value.reach'],
		['actionObservationPayload', 'value:1', 'normalizeActionTarget/value'],
		['actionObservationPayload', 'value:2', 'normalizeActionObservation/value.progress'],
		['actionObservationPayload', 'value:3', 'normalizeActionObservation/block'],
		['attachDelta', 'observation', 'normalizeObservation/value'],
	],
	'server/bridge/DurableActionJournal.java': [['encodeBreakOutcome', 'encoded', 'normalizeBreakOutcome/value']],
	'server/bridge/ModelTaskRequestHandler.java': [['handle', 'result', 'normalizeProtocolV2Payload:task_request_result/value']],
	'server/runtime/GoalCompletionVerifier.java': [
		['toJson', 'result', 'normalizeProtocolV2Payload:goal_completion_result/value'],
		['toJson', 'entry', 'normalizeCompletionFact/value'],
	],
};

function walk(node, visit, ancestors = []) {
	if (!node || typeof node.type !== 'string') return;
	visit(node, ancestors);
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) for (const child of value) walk(child, visit, [...ancestors, node]);
		else if (value && typeof value.type === 'string') walk(value, visit, [...ancestors, node]);
	}
}

function nodeAllowlists(source) {
	const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
	const bindings = new Map(), calls = new Map();
	walk(tree, (node, ancestors) => {
		if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
			const scope = ancestors.findLast(parent => ['Program', 'BlockStatement', 'SwitchCase'].includes(parent.type));
			if (!bindings.has(scope)) bindings.set(scope, new Map());
			bindings.get(scope).set(node.id.name, node.init);
		}
		if (node.type !== 'CallExpression' || node.callee.name !== 'exactKeys') return;
		const fn = ancestors.findLast(parent => parent.type === 'FunctionDeclaration');
		const branch = ancestors.findLast(parent => parent.type === 'SwitchCase');
		const object = source.slice(node.arguments[0].start, node.arguments[0].end).replace(/\s/g, '');
		const key = `${fn.id.name}${branch?.test?.type === 'Literal' ? `:${branch.test.value}` : ''}/${object}`;
		if (!calls.has(key)) calls.set(key, []);
		calls.get(key).push({ expression: node.arguments[1], ancestors });
	});
	function resolve(node, ancestors) {
		if (node.type === 'Literal') return [node.value];
		if (node.type === 'ArrayExpression') return node.elements.flatMap(entry => resolve(entry, ancestors));
		if (node.type === 'SpreadElement') return resolve(node.argument, ancestors);
		if (node.type === 'Identifier') {
			const scope = ancestors.findLast(parent => bindings.get(parent)?.has(node.name));
			assert.ok(scope, `Cannot resolve allowlist ${node.name}; update the source guard`);
			const expression = bindings.get(scope).get(node.name);
			// Resolve a binding in its declaration scope, so another function's local names cannot shadow it.
			return resolve(expression, ancestors.slice(0, ancestors.indexOf(scope) + 1));
		}
		throw new Error(`Unsupported allowlist expression ${source.slice(node.start, node.end)}; update the source guard`);
	}
	return key => {
		const entries = calls.get(key);
		assert.ok(entries?.length, `Missing Node exactKeys contract ${key}`);
		// perceptionEvent intentionally selects a different detail array for each event type.
		if (key === 'perceptionEvent/value') {
			const fn = entries[0].ancestors.findLast(node => node.type === 'FunctionDeclaration');
			const details = [];
			walk(fn, node => {
				if (node.type === 'AssignmentExpression' && node.left.name === 'detail') details.push(...resolve(node.right, entries[0].ancestors));
			});
			const base = entries[0].ancestors.findLast(scope => bindings.get(scope)?.has('base'));
			return new Set([...resolve(bindings.get(base).get('base'), entries[0].ancestors), ...details]);
		}
		return new Set(entries.flatMap(entry => resolve(entry.expression, entry.ancestors)));
	};
}

// Mask comments and literals for balanced braces, but retain offsets into the original source.
function javaMask(source, keepStrings = false) {
	return source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
		value => keepStrings && /^["']/.test(value) ? value : value.replace(/[^\n]/g, ' '));
}

function javaKeys(source, method, receiverSelector, dynamicKeys = []) {
	const mask = javaMask(source), bodies = [];
	const declaration = new RegExp(`^[\\t ]+(?:(?:public|private|protected|static|final|synchronized)\\s+)*[\\w<>,.?\\[\\]]+\\s+${method}\\s*\\([^;{}]*\\)\\s*\\{`, 'gm');
	for (const match of mask.matchAll(declaration)) {
		let end = match.index + match[0].length, depth = 1;
		const start = end;
		while (depth && end < mask.length) { depth += Number(mask[end] === '{') - Number(mask[end] === '}'); end++; }
		assert.equal(depth, 0, `Unbalanced Java method ${method}`);
		bodies.push(javaMask(source.slice(start, end - 1), true));
	}
	assert.ok(bodies.length, `Missing Java method ${method}`);
	let body = bodies.join('\n');
	const [receiver, occurrence] = receiverSelector.split(':');
	if (occurrence !== undefined) {
		const declarations = [...body.matchAll(new RegExp(`JsonObject\\s+${receiver}\\s*=`, 'g'))];
		assert.ok(declarations[Number(occurrence)], `Missing ${method} ${receiverSelector}`);
		body = body.slice(declarations[Number(occurrence)].index, declarations[Number(occurrence) + 1]?.index);
	}
	const keys = [];
	for (const match of body.matchAll(new RegExp(`\\b${receiver}\\s*\\.\\s*add(?:Property)?\\s*\\(\\s*([^,\\n]+)\\s*,`, 'g'))) {
		const argument = match[1].trim();
		if (dynamicKeys.includes(argument)) continue;
		assert.match(argument, /^"\w+"$/, `${method} ${receiver}: computed key ${argument} needs an explicit contract`);
		keys.push(JSON.parse(argument));
	}
	for (const match of body.matchAll(new RegExp(`\\baddPosition\\s*\\(\\s*${receiver}\\s*,\\s*"(\\w+)"`, 'g'))) keys.push(match[1]);
	assert.ok(keys.length, `No emitted keys found for ${method} ${receiverSelector}`);
	return new Set(keys);
}

function assertAllowed(keys, allowed, context) {
	for (const key of keys) assert.ok(allowed.has(key), `${context} emits '${key}', rejected by the Node wire schema`);
}

test('Java observation, perception and receipt serializers emit only keys allowed by the Node wire schema', () => {
	const allowedKeys = nodeAllowlists(readFileSync(new URL('../src/protocol-v2.mjs', import.meta.url), 'utf8'));
	for (const [file, contracts] of Object.entries(CONTRACTS)) {
		const source = readFileSync(new URL(file, JAVA), 'utf8');
		for (const [method, receiver, schema, dynamic] of contracts) {
			assertAllowed(javaKeys(source, method, receiver, dynamic), allowedKeys(schema), `${file} ${method} ${receiver} -> ${schema}`);
		}
	}
	// Prove the same guard catches both historical failures, independently of hand-written JSON fixtures.
	for (const [file, receiver, schema, key] of [
		['ThreatPerception.java', 'value', 'threatsObservation/entry', 'targetable'],
		['ProjectilePerception.java', 'row', 'incomingProjectileObservation/row', 'shieldBlockable'],
	]) {
		const source = readFileSync(new URL(`server/perception/${file}`, JAVA), 'utf8');
		const keys = javaKeys(source, 'toJson', receiver);
		assert.ok(keys.has(key), `The source guard must discover ${file} ${key}`);
		const historicalAllowlist = allowedKeys(schema);
		historicalAllowlist.delete(key);
		assert.throws(() => assertAllowed(keys, historicalAllowlist, file), new RegExp(`emits '${key}', rejected`));
	}
});
