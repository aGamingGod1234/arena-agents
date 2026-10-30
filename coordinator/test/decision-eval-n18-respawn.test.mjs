import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { validateCaseFile } from '../src/decision-eval/schema.mjs';
import { observationSha256 } from '../src/decision-eval/capture.mjs';
import { renderWake } from '../src/decision-eval/render.mjs';

const { cases } = JSON.parse(fs.readFileSync(new URL('./fixtures/decision-eval/extra/n18-respawn.json', import.meta.url)));

test('respawn drop cases keep capture provenance and replay the recorded death', () => {
	validateCaseFile(cases);
	assert.equal(cases.length, 3);
	for (const c of cases) {
		const source = c.source.derived.from;
		assert.equal(c.source.observationSha256, observationSha256(c.state.observation));
		assert.equal(c.source.sourceMomentId, `sm-${createHash('sha256').update(`${source.trace}\n${source.observationSha256}`).digest('hex').slice(0, 16)}`);
		assert.equal(c.state.observation.world.simulationDistance, 6);
		assert.deepEqual(c.state.lifecycle.map((entry) => entry.payload.operation), ['dead', 'respawn']);
		for (const section of ['Good:', 'Bad:', 'Neutral:']) assert.ok(c.expect.judge.rubric.includes(section));
	}
});

test('the wake states the drop clock and offers the death drops as a source of the unmet gear', async () => {
	const expected = [/paused while you are away/, /paused while you are away/, /ageing\)/];
	for (const [index, c] of cases.entries()) {
		const { encodedInput } = await renderWake(c, { provider: 'codex', model: 'gpt-6.1-sol' });
		const payload = JSON.parse(encodedInput.slice(encodedInput.indexOf('\n') + 1));
		assert.match(payload.data.observation.recovery.facts, /Drops age only in entity-ticking chunks, within 6 chunks/);
		assert.match(payload.data.now.options, /^death drops \d+m E dy-\d+ @119,37,-76: iron_pickaxe/);
		assert.match(payload.data.now.options, expected[index]);
		assert.doesNotMatch(encodedInput, /dropTicking/);
	}
});
