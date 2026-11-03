import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ARMS } from '../scripts/live-body-benchmark.mjs';

test('live benchmark sends the same owned default rules as the real coordinator', () => {
	const canonical = JSON.parse(readFileSync(new URL('../../src/test/resources/default-reflex-rules.json', import.meta.url), 'utf8'));
	assert.deepEqual(ARMS.current10, canonical);
	assert.deepEqual(ARMS.original4, canonical.filter(({ id }) => ['default-lava', 'default-fire', 'default-air', 'default-edge'].includes(id)));
});
