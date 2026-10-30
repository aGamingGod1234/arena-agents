import assert from 'node:assert/strict';
import test from 'node:test';
import { MODEL_FACT_FORMAT, decodeModelFacts, encodeModelFacts } from '../src/model-fact-encoding.mjs';
import { presentNativeToolResult } from '../src/codex-service.mjs';
import { MINECRAFT_DYNAMIC_TOOLS } from '../src/native-minecraft-tools.mjs';

const serialized = value => JSON.parse(JSON.stringify(value));
test('table defaults retain every repeated fact while reducing the serialized rows', () => {
 const rows = Array.from({ length: 32 }, (_, slot) => ({ slot, itemId: 'minecraft:netherrack', count: slot + 1,
  available: false, damage: 0, maxDamage: 0, state: {}, tags: [], unknown: null, distance: 1.1234567891234567 }));
 const source = { rows }, before = serialized(source), encoded = encodeModelFacts(source);
 assert.equal(encoded.format, MODEL_FACT_FORMAT);
 assert.ok(Object.keys(encoded.data.rows.$rows).indexOf('defaults') < Object.keys(encoded.data.rows.$rows).indexOf('rows'),
  'shared facts must appear before the row values they describe');
 assert.ok(Buffer.byteLength(JSON.stringify(encoded)) < 1_000, 'constant columns must be sent once');
 assert.deepEqual(decodeModelFacts(serialized(encoded)), before);
 assert.deepEqual(source, before);
});

test('table defaults preserve absence, null and literal marker values in mixed records', () => {
 const rows = Array.from({ length: 32 }, (_, x) => ({ x, repeated: { $ref: 0 }, empty: [], knownNull: null,
  ...(x % 2 ? { sometimesNull: null } : {}), ...(x % 3 ? { sometimesFalse: false } : {}),
  ...JSON.parse('{"__proto__":{"fact":true}}') }));
 assert.deepEqual(decodeModelFacts(serialized(encodeModelFacts({ rows }))), { rows });
 const value = { format: MODEL_FACT_FORMAT, values: [], data: { $rows: {
  columns: ['x'], rows: [[1], [2]], defaults: { absentFromColumns: null, alwaysFalse: false, alwaysZero: 0 } } } };
 assert.deepEqual(decodeModelFacts(value), [{ absentFromColumns: null, alwaysFalse: false, alwaysZero: 0, x: 1 },
  { absentFromColumns: null, alwaysFalse: false, alwaysZero: 0, x: 2 }]);
});

test('malformed or overlapping table defaults are rejected', () => {
 for (const defaults of [null, [], 1, { x: 0 }]) {
  const value = { format: MODEL_FACT_FORMAT, values: [], data: { $rows: { columns: ['x'], rows: [[1]], defaults } } };
  assert.throws(() => decodeModelFacts(value), /Invalid fact defaults/);
 }
});

test('provider tool presentation keeps complete facts under its byte cap and defaults are detached per row', () => {
 const blocks = Array.from({ length: 32 }, (_, x) => ({ x, y: 64, z: 0, blockId: 'minecraft:stone',
  state: { facing: 'north' }, bounds: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }] }));
 const source = { state: 'SUCCEEDED', observation: { world: { worldId: 'test', dimension: 'minecraft:overworld' }, blocks } };
 const result = presentNativeToolResult(source, { kind: 'observe' });
 const decoded = decodeModelFacts(JSON.parse(result.response.contentItems[0].text));
 delete decoded.observationView;
 assert.deepEqual(decoded, source);
 decoded.observation.blocks[0].state.facing = 'south';
 assert.equal(decoded.observation.blocks[1].state.facing, 'north');
 assert.equal(source.observation.blocks[0].state.facing, 'north');
 assert.ok(Buffer.byteLength(result.response.contentItems[0].text) < 1_000);
});

test('short repeated Minecraft identifiers remain literal when their row columns vary', () => {
 const rows = Array.from({ length: 72 }, (_, x) => ({ x, type: x % 2 ? 'minecraft:zombie' : 'minecraft:skeleton' }));
 const encoded = encodeModelFacts({ rows });
 assert.deepEqual(decodeModelFacts(serialized(encoded)), { rows });
 assert.equal(encoded.format, MODEL_FACT_FORMAT);
 assert.ok(!encoded.values.includes('minecraft:zombie'));
 assert.ok(!encoded.values.includes('minecraft:skeleton'));
 assert.deepEqual(encoded.data.rows.$rows.rows.map(row => row[1]), rows.map(row => row.type));
});

test('long repeated identifiers still use exact shared values', () => {
 const identifier = 'minecraft:a_long_repeated_identifier';
 const source = { rows: Array.from({ length: 72 }, (_, x) => ({ x, type: x % 2 ? identifier : 'minecraft:stone' })) };
 const encoded = encodeModelFacts(source);
 assert.ok(encoded.values.includes(identifier));
 assert.deepEqual(decodeModelFacts(serialized(encoded)), source);
});

for (const [name, patterns] of [
 ['takeTask', [/No task: adopt delivered operator words/, /request must match exactly; omitted uses latest/, /resume:true resumes paused work/, /requesterId selects operator/, /Minecraft starts, validates \(PENDING\), or refuses/, /success starts a task turn/]],
 ['programStatus', [/Program completion does not complete the goal/]],
 ['mine', [/instant-break grass\/flowers via vanilla attacks/, /reports it; solids fail/]],
 ['capabilities', [/program: read before writing ArenaScript/i, /Read each topic once/, /topic all is complete/, /no topic lists all/]],
 ['queueProgram', [/Queue one authored successor/, /Replaces pending successor/, /Only successful natural PROGRAM_EXHAUSTED/]],
 ['cancelQueuedProgram', [/exact pending successor/]],
]) {
 test(`${name} description keeps its operational constraints explicit`, () => {
  const description = MINECRAFT_DYNAMIC_TOOLS.find(tool => tool.name === name).description;
  for (const pattern of patterns) assert.match(description, pattern);
 });
}

test('a constant reserved-key column is literal data, not a dictionary reference', () => {
 for (const key of ['$ref', '$rows', '$object']) {
  const source = { rows: Array.from({ length: 32 }, () => ({ [key]: 777 })), padding: 'x'.repeat(1_100) };
  assert.deepEqual(decodeModelFacts(serialized(encodeModelFacts(source))), source, key);
 }
});

test('500 seeded pages with constant and optional fields round-trip every JSON value', () => {
 let seed = 0x92fe;
 const next = () => (seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0);
 const values = [null, false, 0, [], {}, { $ref: 9 }, { $object: [['x', 1]] }, 'minecraft:zombie', 1.1234567891234567];
 for (let index = 0; index < 500; index++) {
  const constant = values[next() % values.length];
  const rows = Array.from({ length: 24 }, (_, x) => ({ x, constant,
   ...(next() % 3 ? { optional: false } : {}),
   ...(index % 2 ? { $ref: 777 } : JSON.parse('{"__proto__":{"factual":true}}')) }));
  const source = serialized({ rows });
  const before = serialized(source);
  assert.deepEqual(decodeModelFacts(serialized(encodeModelFacts(source))), before, `fixture ${index}`);
  assert.deepEqual(source, before, `mutation ${index}`);
 }
 assert.equal(Object.prototype.factual, undefined);
});
