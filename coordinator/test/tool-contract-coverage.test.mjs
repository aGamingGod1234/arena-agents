import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { discoverContracts, contractChanges } from './helpers/contract-inventory.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { MINECRAFT_DYNAMIC_TOOLS, NATIVE_AGENT_INSTRUCTIONS } from '../src/native-minecraft-tools.mjs';
import { ARENA_SCRIPT_API_REFERENCE } from '../src/prompts.mjs';
import { parse } from 'acorn';

const table = JSON.parse(readFileSync(new URL('contracts/claims.json', import.meta.url), 'utf8'));
const descriptions = JSON.parse(readFileSync(new URL('../src/tool-descriptions.json', import.meta.url), 'utf8'));
const discovered = discoverContracts();
const root = new URL('../../', import.meta.url);

test('tool descriptions are generated from the canonical claim table without inline copies', () => {
	assert.deepEqual(Object.keys(descriptions.toolDescriptions).sort(), MINECRAFT_DYNAMIC_TOOLS.map(tool => tool.name).sort());
	for (const tool of MINECRAFT_DYNAMIC_TOOLS) assert.equal(tool.description, descriptions.toolDescriptions[tool.name].map(entry => entry.claim).join(' '));
	const ast = parse(readFileSync(new URL('coordinator/src/native-minecraft-tools.mjs', root), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
	const visit = node => {
		if (!node || typeof node !== 'object') return;
		if (node.type === 'CallExpression' && node.callee.name === 'tool') assert.equal(node.arguments.length, 2, 'A tool must use its canonical description, not inline prose');
		for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === 'object') visit(child);
	};
	visit(ast);
});

test('model-facing contract bytes remain within the pinned baseline budgets', () => {
	// 26,440 -> 28,572: the four bounded actionType enums cost 533-560 bytes each.
	// 28,572 -> 28,667: taskPlan intent text fields now state their maxLength (step 48, others 100).
	// place_block adds the optional faceMode signature; pin the current serialized size.
	// runProgram adds the bounded reflexes array (per-tick reflex rules).
	// 28,666 -> 29,069: act and sequence carry the same reflexes array, so the call answering a danger also arms rules.
	// 29,069 -> 29,105: the taskPlan check description names the stage terms (y<=N, lava:N, frame:N, crystals<=N).
	// moveTo/act/sequence inspectAfter (one model call fewer per follow-up read) is paid for by a tighter observe description.
	// 29,105 -> 29,116: the check description names spawn:bed (a respawn set by using a bed).
	// 29,116 -> 29,395: the dig_to action (enums, signature, one act sentence) replaces one break_block call per block.
	// 29,395 -> 30,904: travelTo (a whole trip in one call instead of a decision every few blocks) and its actionType enum entries.
	// d38 retrace arguments, tool description and near check: exactly +317 tool bytes, +22 reference bytes.
	// d38-blaze3: build_shelter adds exactly 116 serialized tool bytes and 69 program-reference bytes.
	// d41-portal: use_item and interact_block accept acceptLavaRisk (LAVA_POUR_AT_BODY override): exactly +32 tool bytes.
	// d41-ranged-loop: use_ranged untilDead?/fleeAtHealth?/collect? (timeoutMs? with untilDead) and fight_target collect?: exactly +44 tool bytes.
	// d41-resume: travelTo fightThrough (fight hostiles on the route instead of stopping): exactly +226 tool bytes.
	// d41-fight-until: the fight_until action (actionType enum entries and its act signature): exactly +153 tool bytes.
	// 14,847 -> 14,895: player.useRanged gains timeoutMs?/untilDead?/fleeAtHealth?/collect? and player.fightTarget collect? (d41-ranged-loop).
	// d41-cast-barter: cast_obsidian and barter_until (actionType enums, signatures, one act sentence each): exactly +673 tool bytes.
	// d41-fight-count: fight_target/use_ranged untilItem?/untilCount? (+roof? on fight_target, fight_until) and one act sentence: exactly +245 tool bytes.
	// d41-blaze-survive: fight_target/use_ranged single? and the plan-count act sentence: exactly +128 tool bytes.
	assert.ok(Buffer.byteLength(JSON.stringify(MINECRAFT_DYNAMIC_TOOLS)) <= 32_863);
	assert.ok(Buffer.byteLength(NATIVE_AGENT_INSTRUCTIONS) <= 1_500);
	// 14,586 -> 14,695: the generated player.travelTo signature.
	// 14,813 -> 14,847: player.useItem and player.interactBlock signatures gain acceptLavaRisk? (d41-portal).
	// 14,847 -> 15,028: player.useRanged gains timeoutMs?/untilDead?/fleeAtHealth?/collect? and player.fightTarget collect? (d41-ranged-loop); +15: travelTo fightThrough? (d41-resume); +118: player.fightUntil (d41-fight-until); +118: castObsidian/barterUntil (d41-cast-barter).
	// +64: fightTarget/useRanged untilItem?/untilCount?, fightTarget/fightUntil roof? (d41-fight-count).
	// +18: fightTarget/useRanged single? (d41-blaze-survive).
	assert.ok(Buffer.byteLength(ARENA_SCRIPT_API_REFERENCE) <= 15_228);
});

test('every model-facing contract change requires its reviewed claim-table entry to change', () => {
	assert.deepEqual(contractChanges(discovered, table.claims), [], 'Run npm run contracts:refresh, then review only listed claims in test/contracts/claims.json');
	assert.deepEqual(table.claims.filter(entry => entry.status === 'review-required').map(entry => entry.id), [], 'Refresh does not approve changed contracts; review their predicates and checks');
});

test('the contract guard catches additions, removals, description, reference and schema edits', () => {
	const reviewed = discovered.map(contract => ({ id: contract.id, contract }));
	for (const kind of ['description', 'parameter', 'schema', 'enum', 'program-reference', 'control-reference', 'strategy-reference', 'result-code']) {
		const changed = structuredClone(discovered), entry = changed.find(entry => entry.kind === kind);
		entry.claim += ' changed';
		assert.deepEqual(contractChanges(changed, reviewed), [entry.id]);
	}
	assert.equal(contractChanges([...discovered, { id: 'new-claim' }], reviewed).at(-1), 'new-claim');
	assert.deepEqual(contractChanges(discovered.slice(1), reviewed), [`removed:${discovered[0].id}`]);
});

test('every atomic predicate belongs to a current, non-retired claim', () => {
	const current = new Map(table.claims.filter(entry => !entry.removed).map(entry => [entry.id, entry]));
	for (const entry of table.atomicPredicates) {
		assert.ok(current.has(entry.parent), `${entry.id}: parent ${entry.parent} is retired or absent; reparent or delete it`);
		assert.notEqual(entry.status, 'review-required', `${entry.id}: review its predicate and witnesses`);
	}
});

test('every inventoried claim has a concrete predicate and executable evidence or an explicit exception', () => {
	for (const entry of [...table.claims, ...table.atomicPredicates]) {
		assert.equal(typeof entry.predicate, 'string', entry.id);
		assert.ok(entry.predicate.length > 10, entry.id);
		assert.ok(['checked', 'partial', 'pending', 'advisory', 'out-of-scope'].includes(entry.status), entry.id);
		if (entry.status !== 'checked') assert.ok(entry.reason?.length > 10, `${entry.id} needs an honest reason`);
		if (['checked', 'partial'].includes(entry.status)) assert.ok(entry.checks?.length > 0, `${entry.id} needs behavioral evidence`);
		for (const check of entry.checks ?? []) {
			assert.ok(['node-behavior', 'java-behavior', 'live-behavior'].includes(check.type), `${entry.id}: static text checks are not behavioral proof`);
			if (check.type === 'live-behavior') { assert.ok(check.command && check.predicate); continue; }
			const source = readFileSync(new URL(check.file, root), 'utf8');
			assert.ok(check.test && source.length, `${entry.id}: missing executable check`);
			if (check.type === 'node-behavior' && !/^contract (?:schema|enum|example) /.test(check.test)) {
				assert.ok(source.includes(check.test), `${entry.id}: missing Node witness ${check.test}`);
			}
		}
		for (const check of entry.documentationChecks ?? []) {
			const source = readFileSync(new URL(check.file, root), 'utf8');
			assert.ok(source.includes(check.test), `${entry.id}: missing documentation check ${check.test}`);
		}
	}
});

test('every Java behavioral witness is reachable from the CI verification entry point', () => {
	const files = readdirSync(new URL('src/test/java/', root), { recursive: true }).filter(file => file.endsWith('.java'));
	const classes = new Map(files.map(file => [file.split(/[\\/]/).at(-1).replace(/\.java$/, ''), { file, source: readFileSync(new URL(`src/test/java/${file.replaceAll('\\', '/')}`, root), 'utf8') }]));
	const reachable = new Set(), pending = ['VerificationMain'];
	while (pending.length) {
		const name = pending.pop();
		if (reachable.has(name)) continue;
		reachable.add(name);
		const source = classes.get(name)?.source ?? '';
		for (const target of classes.keys()) if (!reachable.has(target) && new RegExp(`\\b${target}\\s*(?:\\.|::|\\()`).test(source)) pending.push(target);
	}
	for (const entry of [...table.claims, ...table.atomicPredicates]) for (const check of entry.checks ?? []) {
		if (check.type !== 'java-behavior') continue;
		const name = check.file.split('/').at(-1).replace(/\.java$/, '');
		assert.ok(reachable.has(name), `${entry.id}: ${name} is documented as evidence but verifyCore never invokes it`);
		for (const method of check.test.split(/\s*\+\s*/)) {
			assert.match(classes.get(name).source, new RegExp(`\\b${method}\\s*\\(`), `${entry.id}: missing Java witness ${name}.${method}`);
		}
	}
});

for (const claim of discovered.filter(entry => entry.kind === 'example' && /^```json executor-/.test(entry.claim))) {
	test(`contract example ${claim.id}`, () => {
		const [, label, source] = claim.claim.match(/^```json (executor-[\w-]+)\r?\n([\s\S]*?)```$/);
		const payload = JSON.parse(source);
		for (const call of payload.calls ?? [payload]) {
			const execute = () => normalizeMinecraftToolCall(call.tool, call.arguments);
			if (label === 'executor-bad-call') assert.throws(execute, { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
			else assert.doesNotThrow(execute);
		}
	});
}
