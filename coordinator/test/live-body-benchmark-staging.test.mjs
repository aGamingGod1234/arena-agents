import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { stageBenchmarkTrial, SCENARIOS } from '../scripts/live-body-benchmark.mjs';

function fixture(stagedHealth, { startHealth = 20, saturation = 0, food = 10 } = {}) {
	let attempt = 0, healthReads = 0;
	const commands = [], rejected = [];
	return {
		commands, rejected,
		get attempts() { return attempt; },
		args: {
			scenario: SCENARIOS.low_health_zombie, rules: [],
			reset: async () => { attempt++; healthReads = 0; },
			install: async () => {}, reflexStatus: async () => ({ events: [{ seq: 7 }] }),
			sleep: async () => {}, onRejected: (failure) => rejected.push(failure),
			command: async (command) => {
				commands.push(command);
				if (command.endsWith(' Health')) return `Bench has the following entity data: ${++healthReads === 1 ? startHealth : stagedHealth[Math.min(attempt - 1, stagedHealth.length - 1)]}f`;
				if (command.endsWith(' foodLevel')) return `Bench has the following entity data: ${food}`;
				if (command.endsWith(' foodSaturationLevel')) return `Bench has the following entity data: ${saturation}f`;
				return '';
			},
		},
	};
}

test('dead historical setup is rejected and retried before a trial can be measured', async () => {
	const f = fixture([0, 6]);
	const staged = await stageBenchmarkTrial(f.args);
	assert.equal(f.attempts, 2);
	assert.equal(f.rejected[0].stagedHealth, 0);
	assert.match(f.rejected[0].reason, /6 HP/);
	assert.equal(staged.stagedHealth, 6);
	assert.equal(staged.seqBefore, 7);
});

test('off-target historical zombie health exhausts bounded setup attempts', async () => {
	for (const health of [2.833334, 3.5, null]) {
		const f = fixture([health]);
		assert.equal(await stageBenchmarkTrial(f.args), null);
		assert.equal(f.attempts, 3);
		assert.equal(f.rejected.length, 3);
	}
});

test('requires a full-health reset, depleted zombie saturation, and hungry food below 14', async () => {
	for (const overrides of [{ startHealth: 0 }, { startHealth: 19 }, { saturation: 1 }]) {
		const f = fixture([6], overrides);
		assert.equal(await stageBenchmarkTrial(f.args), null);
		assert.equal(f.attempts, 3);
	}
	const f = fixture([20], { food: 14 });
	assert.equal(await stageBenchmarkTrial({ ...f.args, scenario: SCENARIOS.hungry }), null);
});

test('valid starts pass once; dead non-zombie starts cannot enter results', async () => {
	const f = fixture([6]);
	assert.equal((await stageBenchmarkTrial(f.args)).stagedHealth, 6);
	assert.equal(f.attempts, 1);
	const dead = fixture([0]);
	assert.equal(await stageBenchmarkTrial({ ...dead.args, scenario: SCENARIOS.creeper }), null);
});

test('historical observations stay intact and zombie claims are explicitly invalidated', async () => {
	const report = JSON.parse(await readFile(new URL('../../reports/live-body-benchmark-26.3-2026-11-01.json', import.meta.url)));
	const dead = report.results.find((r) => r.scenario === 'low_health_zombie' && r.arm === 'original4' && r.trial === 5);
	assert.equal(dead.stagedHealth, 0);
	assert.equal(dead.survivedMs, 252);
	assert.equal(dead.healthLost, 0);
	assert.equal(report.results.length, 48);
	for (const arm of ['original4', 'current10']) {
		assert.equal(report.summary[`low_health_zombie/${arm}`].validity, 'invalid');
	}
	assert.equal(report.validity.freshTrialsRun, false);
});
