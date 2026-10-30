import assert from 'node:assert/strict';
import test from 'node:test';
import { BodyPace, PACE_WINDOW_MS } from '../src/body-pace.mjs';

function paced() {
	let now = 1_000_000;
	const pace = new BodyPace({ now: () => now });
	return { pace, at: ms => { now = ms; }, now: () => now };
}

test('pace reports body action time and the time it stood still while the model decided', () => {
	const { pace, at } = paced();
	const start = 1_000_000;
	pace.note('native_decision_timing', { agentId: 'a', segmentDurationMs: 1 });
	// Three rounds: the model decides 40 s, then one 20 s action runs while it does not.
	for (let round = 0; round < 3; round++) {
		const t = start + round * 60_000;
		at(t + 40_000); pace.note('native_decision_timing', { agentId: 'a', segmentDurationMs: 40_000 });
		pace.note('native_tool_dispatch_started', { agentId: 'a', actionId: `x${round}`, actionType: 'break_block' });
		at(t + 60_000); pace.note('native_tool_action_completed', { agentId: 'a', actionId: `x${round}`, state: 'SUCCEEDED' });
	}
	const summary = pace.summary('a');
	assert.equal(summary.windowMs, 180_000);
	assert.equal(summary.actedMs, 60_000);
	assert.equal(summary.decidingMs, 120_000);
	assert.equal(summary.medianDecisionMs, 40_000);
	assert.equal(pace.line('a'), 'last 3.0 min: body acted 1.0 min, stood still 2.0 min while you decided (median decision 40 s)');
});

test('pace says nothing early, counts deciding during an action as acting, and treats wait as standing still', () => {
	const { pace, at } = paced();
	pace.note('native_decision_timing', { agentId: 'a', segmentDurationMs: 1 });
	at(1_060_000);
	assert.equal(pace.line('a'), null, 'one minute of play is too little to report');
	pace.note('native_tool_dispatch_started', { agentId: 'a', actionId: 'w', actionType: 'wait' });
	pace.note('native_tool_dispatch_started', { agentId: 'a', actionId: 'm', actionType: 'move_to' });
	at(1_240_000);
	pace.note('native_decision_timing', { agentId: 'a', segmentDurationMs: 60_000 });
	pace.note('native_tool_action_completed', { agentId: 'a', actionId: 'w', state: 'SUCCEEDED' });
	const summary = pace.summary('a');
	assert.equal(summary.actedMs, 180_000, 'the move still running counts to now');
	assert.equal(summary.decidingMs, 0, 'deciding while the body moves is not standing still');
	pace.note('native_tool_action_completed', { agentId: 'a', actionId: 'm', state: 'SUCCEEDED' });
	at(1_240_000 + PACE_WINDOW_MS);
	assert.equal(pace.summary('a').actedMs, 0, 'only the last window counts');
	assert.equal(pace.summary('other'), null);
});
