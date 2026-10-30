import assert from 'node:assert/strict';
import test from 'node:test';
import { HandoffBudget, CONTEXT_PRICE_USD as price } from '../src/handoff-budget.mjs';

test('paid reads fund a measured write; turn boundaries do not create credit', () => {
	const budget = new HandoffBudget();
	assert.equal(budget.quote(1000).allowed, false);
	budget.startSession(1000);
	budget.noteUsage({ cacheWrite: 20_000, cacheRead: 10_000 });
	for (let turn = 0; turn < 7; turn++) budget.noteUsage({ cacheRead: 100_000 });
	assert.equal(budget.reserve(1000), false);
	budget.noteUsage({ cacheRead: 100_000 });
	assert.equal(budget.reserve(1000), true);
	assert.equal(budget.snapshot.creditUsd, 0, 'surplus cannot fund another reset');
	assert.equal(budget.reserve(1000), false, 'one purchase waits for its measured settlement');
});

test('payload growth raises the quote and a cache miss becomes debt before the next reset', () => {
	const budget = new HandoffBudget();
	budget.startSession(1000);
	budget.noteUsage({ cacheWrite: 1000, cacheRead: 100_000 });
	assert.equal(budget.quote(1000).allowed, true);
	assert.equal(budget.quote(10_000).allowed, false);
	assert.equal(budget.reserve(1000), true);
	budget.startSession(1000);
	budget.noteUsage({ cacheWrite: 10_000, cacheRead: 0 });
	assert.ok(Math.abs(budget.snapshot.creditUsd + 9000 * price.cacheWrite) < 1e-12);
	budget.noteUsage({ cacheRead: 500_000 });
	assert.equal(budget.reserve(1000), false, 'repaying old debt leaves too little to buy again');
	budget.noteUsage({ cacheRead: 500_000 });
	assert.equal(budget.reserve(1000), true);
});

test('every prefix obeys write <= paid reads + unpaid debt with variable writes and forced restarts', () => {
	const budget = new HandoffBudget();
	budget.startSession(1000);
	let pending = false;
	for (let i = 0; i < 1000; i++) {
		budget.noteUsage({ cacheRead: 1000 + (i * 7919) % 200_000, cacheWrite: pending ? 1000 + (i * 719) % 60_000 : 1000, input: 2 });
		pending = false;
		const state = budget.snapshot;
		assert.ok(state.totalElectiveWriteUsd <= state.totalReadUsd + state.unsettledDebtUsd + 1e-9);
		assert.ok(state.unsettledDebtUsd <= state.lastElectiveWriteUsd + 1e-9);
		if (i % 37 === 0) budget.startSession(1000); // forced, not charged as an elective write
		else if (budget.reserve(1000 + (i % 4) * 500)) {
			budget.startSession(1000 + (i % 4) * 500);
			pending = true;
		}
	}
	assert.ok(budget.snapshot.totalElectiveWriteUsd > 0);
});
