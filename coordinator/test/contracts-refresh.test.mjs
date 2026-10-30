import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { discoverContracts, contractSnapshot, contractChanges, CONTROL_FILE } from './helpers/contract-inventory.mjs';
import { refreshClaims } from '../scripts/contracts-refresh.mjs';
import { MINECRAFT_DYNAMIC_TOOLS } from '../src/native-minecraft-tools.mjs';

const root = new URL('../', import.meta.url);
const current = discoverContracts();
const reviewed = { claims: current.map(entry => ({ id: entry.id, contract: contractSnapshot(entry), location: entry.location, predicate: 'Existing behavior witness.', status: 'checked', checks: [{ file: 'fixture.mjs', test: 'actual witness', type: 'node-behavior' }] })) };

test('a top-of-file native comment changes locations without invalidating any contract', () => {
	const native = readFileSync(new URL('src/native-minecraft-tools.mjs', root), 'utf8');
	const moved = discoverContracts({ sources: { 'src/native-minecraft-tools.mjs': '// implementation comment\n' + native } });
	assert.deepEqual(contractChanges(moved, reviewed.claims), []);
	assert.notDeepEqual(moved.find(entry => entry.kind === 'schema').location, current.find(entry => entry.kind === 'schema').location);
	const result = refreshClaims(reviewed, moved);
	assert.deepEqual(result.changes, { changed: [], added: [], removed: [] });
	assert.deepEqual(result.table.claims.map(entry => entry.checks), reviewed.claims.map(entry => entry.checks));
});

test('an inserted control paragraph adds exactly itself without renumbering existing contracts', () => {
	const source = readFileSync(new URL(CONTROL_FILE, root), 'utf8').replace(/\r\n/g, '\n');
	const moved = discoverContracts({ sources: { [CONTROL_FILE]: source.replace('### Live advisory plan\n\n', '### Live advisory plan\n\nA newly documented behavior requires its own review.\n\n') } });
	const changes = contractChanges(moved, reviewed.claims);
	assert.equal(changes.length, 1);
	assert.equal(moved.find(entry => entry.id === changes[0]).claim, 'A newly documented behavior requires its own review.');
	const result = refreshClaims(reviewed, moved);
	assert.deepEqual(result.changes, { changed: [], added: changes, removed: [] });
	assert.equal(result.table.claims.find(entry => entry.id === changes[0]).status, 'review-required');
	for (const old of reviewed.claims) assert.deepEqual(result.table.claims.find(entry => entry.id === old.id).checks, old.checks);
});

test('a top-of-file prompt comment updates locations without invalidating API claims', () => {
	const prompts = readFileSync(new URL('src/prompts.mjs', root), 'utf8');
	const moved = discoverContracts({ sources: { 'src/prompts.mjs': '// implementation comment\n' + prompts } });
	assert.deepEqual(contractChanges(moved, reviewed.claims), []);
	assert.notDeepEqual(moved.find(entry => entry.kind === 'program-reference').location, current.find(entry => entry.kind === 'program-reference').location);
});

test('the merged howto description differs from the knowledge text only in its own paragraph, independently of its enum', () => {
	const compact = JSON.parse(readFileSync(new URL('src/tool-descriptions.json', root), 'utf8'));
	const before = compact.toolDescriptions.capabilities[0].claim;
	compact.toolDescriptions.capabilities[0].claim = before.replace('strategy: mechanics incl ores; no topic lists all. howto: topic <item>: sources vs what you have.', 'strategy: Minecraft mechanics (ores, tools, mobs, survival); no topic lists all.');
	assert.equal(Buffer.byteLength(before), 368);
	assert.equal(Buffer.byteLength(compact.toolDescriptions.capabilities[0].claim), 351);
	const changed = discoverContracts({ sources: { 'src/tool-descriptions.json': JSON.stringify(compact) } });
	const changes = contractChanges(changed, reviewed.claims);
	assert.equal(changes.length, 2);
	assert.ok(changes.every(id => id.replace(/^removed:/, '').startsWith('tool:capabilities:description:')));
	const original = structuredClone(MINECRAFT_DYNAMIC_TOOLS);
	const baseline = structuredClone(original);
	baseline.find(tool => tool.name === 'capabilities').inputSchema.properties.section.enum = baseline.find(tool => tool.name === 'capabilities').inputSchema.properties.section.enum.filter(value => value !== 'howto');
	const tools = structuredClone(baseline);
	tools.find(tool => tool.name === 'capabilities').inputSchema.properties.section.enum.push('howto');
	const baselineReviewed = discoverContracts({ tools: baseline }).map(contract => ({ id: contract.id, contract }));
	const enumChanges = contractChanges(discoverContracts({ tools }), baselineReviewed);
	assert.deepEqual(enumChanges, ['tool:capabilities:enum:section:howto']);
	assert.deepEqual(MINECRAFT_DYNAMIC_TOOLS, original);
});

test('refresh preserves required review on repeated runs and makes removals explicit', () => {
	const changed = structuredClone(current);
	changed.find(entry => entry.kind === 'schema').claim += ' changed';
	const first = refreshClaims(reviewed, changed);
	assert.equal(first.changes.changed.length, 1);
	const second = refreshClaims(first.table, changed);
	assert.deepEqual(second.changes, { changed: [], added: [], removed: [] });
	assert.equal(second.table.claims.find(entry => entry.id === first.changes.changed[0]).status, 'review-required');
	assert.deepEqual(second.table.claims.find(entry => entry.id === first.changes.changed[0]).checks, reviewed.claims.find(entry => entry.id === first.changes.changed[0]).checks);
	const removed = refreshClaims(reviewed, current.slice(1));
	assert.deepEqual(removed.changes.removed, [current[0].id]);
	assert.equal(removed.table.claims.find(entry => entry.id === current[0].id).removed, true);
	assert.deepEqual(contractChanges(current.slice(1), removed.table.claims), [`removed:${current[0].id}`]);
	const repeatedRemoval = refreshClaims(removed.table, current.slice(1));
	assert.deepEqual(repeatedRemoval.changes, { changed: [], added: [], removed: [] });
	assert.deepEqual(repeatedRemoval.details, []);
	assert.equal(repeatedRemoval.table.claims.find(entry => entry.id === current[0].id).status, 'review-required');
});

test('refresh marks atomic predicates of a removed parent for review on every run without deleting them', () => {
	const atomic = { id: `${current[0].id}:program-predicate:0`, parent: current[0].id, claim: 'Atomic behavior.', predicate: 'Atomic behavior.', status: 'checked', checks: [{ file: 'fixture.mjs', test: 'actual witness', type: 'node-behavior' }], location: current[0].location };
	const kept = { ...atomic, id: `${current[1].id}:program-predicate:0`, parent: current[1].id, location: current[1].location };
	const withAtomics = { ...reviewed, atomicPredicates: [atomic, kept] };
	const first = refreshClaims(withAtomics, current.slice(1));
	const orphan = first.table.atomicPredicates.find(entry => entry.id === atomic.id);
	assert.equal(orphan.status, 'review-required');
	assert.deepEqual(orphan.checks, atomic.checks, 'old evidence is kept for review, not approved or deleted');
	assert.equal(first.table.atomicPredicates.find(entry => entry.id === kept.id).status, 'checked');
	assert.ok(first.details.some(detail => detail.kind === 'atomic-orphaned' && detail.id === atomic.id));
	assert.deepEqual(Object.keys(first.changes).sort(), ['added', 'changed', 'removed']);
	const second = refreshClaims(first.table, current.slice(1));
	assert.equal(second.table.atomicPredicates.find(entry => entry.id === atomic.id).status, 'review-required');
});

test('a reference text change invalidates only that paragraph and its own result-code meanings', () => {
	const source = readFileSync(new URL(CONTROL_FILE, root), 'utf8');
	const paragraph = current.find(entry => entry.kind === 'control-reference' && !/[A-Z][A-Z_]{3,}/.test(entry.claim));
	const moved = discoverContracts({ sources: { [CONTROL_FILE]: source.replace(paragraph.claim, paragraph.claim + ' Changed contract.') } });
	const changes = contractChanges(moved, reviewed.claims);
	assert.equal(changes.length, 2);
	assert.ok(changes.includes(`removed:${paragraph.id}`));
});

test('production packaging imports compact descriptions and leaves behavioral evidence under test', () => {
	const native = readFileSync(new URL('src/native-minecraft-tools.mjs', root), 'utf8');
	const runtime = JSON.parse(readFileSync(new URL('src/tool-descriptions.json', root), 'utf8'));
	assert.match(native, /import TOOL_CONTRACTS from '\.\/tool-descriptions\.json'/);
	assert.deepEqual(Object.keys(runtime).sort(), ['toolDescriptions', 'version']);
	assert.ok(Buffer.byteLength(JSON.stringify(runtime)) < 16_384);
	const gradle = readFileSync(new URL('../build.gradle', root), 'utf8');
	const includes = gradle.match(/def coordinatorRuntimeIncludes = \[([\s\S]*?)\]/)[1];
	assert.match(includes, /'src\/\*\*'/);
	assert.doesNotMatch(includes, /'test(?:\/|')|'\*\*'/);
	const evidence = JSON.parse(readFileSync(new URL('test/contracts/claims.json', root), 'utf8'));
	assert.deepEqual(Object.keys(evidence).sort(), ['atomicPredicates', 'claims', 'commonRules', 'version']);
	for (const entry of evidence.claims) {
		assert.equal(Object.hasOwn(entry.contract, 'source'), false);
		assert.equal(Object.hasOwn(entry.contract, 'location'), false);
		for (const check of entry.checks ?? []) {
			assert.equal(Object.hasOwn(check, 'execution'), false);
			assert.doesNotMatch(JSON.stringify(check), /parent-reported|session\d|verification\.log|live-evidence\.json|java-complete|[A-F0-9]{40,}/);
		}
	}
});
