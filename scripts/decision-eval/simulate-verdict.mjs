#!/usr/bin/env node
// Simulates the decision-eval CI rule on synthetic results with known truth and prints its error rates.
//   node scripts/decision-eval/simulate-verdict.mjs [--trials 2000] [--json out.json]
// Each scenario draws per-case true good-rates from the default mix (55% easy 0.85-1.0, 30% borderline 0.55-0.85,
// 15% hard 0.15-0.55), samples both builds, applies the screen and, when INCONCLUSIVE, a confirm run on fresh samples.
import { readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERDICT_RULE, simulateVerdicts } from '../../coordinator/src/decision-eval/stats.mjs';

// Shapes come from the committed corpus: the train families and their mean case count, and the quick list.
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'coordinator', 'test', 'fixtures', 'decision-eval');
const train = readdirSync(path.join(fixtures, 'train')).filter((name) => name.endsWith('.json'))
	.map((name) => JSON.parse(readFileSync(path.join(fixtures, 'train', name), 'utf8')));
const familyOf = new Map(train.flatMap((file) => file.cases.map((c) => [c.id, c.family])));
const quickIds = JSON.parse(readFileSync(path.join(fixtures, 'quick.json'), 'utf8')).ids;
export const SHAPES = Object.freeze({
	full: { families: train.length, casesPerFamily: Math.round(familyOf.size / train.length) },
	quick: { families: new Set(quickIds.map((id) => familyOf.get(id))).size, casesPerFamily: Math.round(quickIds.length / new Set(quickIds.map((id) => familyOf.get(id))).size) },
});
const full = SHAPES.full, quick = SHAPES.quick;
const label = (shape, n, c) => `${shape.families}x${shape.casesPerFamily}, n=${n}, confirm ${c}`;
const dropOne = (amount) => (p, f) => (f === 0 ? p - amount : p);

export const SCENARIOS = Object.freeze([
	{ name: `no change, full (${label(full, 3, 3)})`, truth: 'null', options: { ...full, samples: 3, confirmSamples: 3 } },
	{ name: 'no change, 5% errored samples', truth: 'null', options: { ...full, samples: 3, confirmSamples: 3, errorRate: 0.05 } },
	{ name: 'one family -50 pts', truth: 'drop', options: { ...full, samples: 3, confirmSamples: 3, candidateRate: dropOne(0.5) } },
	{ name: 'one family -30 pts', truth: 'drop', options: { ...full, samples: 3, confirmSamples: 3, candidateRate: dropOne(0.3) } },
	{ name: 'one family -30 pts, confirm n=6', truth: 'drop', options: { ...full, samples: 3, confirmSamples: 6, candidateRate: dropOne(0.3) } },
	{ name: 'every case -10 pts', truth: 'drop', options: { ...full, samples: 3, confirmSamples: 3, candidateRate: p => p - 0.1 } },
	{ name: 'every case -5 pts', truth: 'drop', options: { ...full, samples: 3, confirmSamples: 3, candidateRate: p => p - 0.05 } },
	{ name: 'one case to 0', truth: 'drop', options: { ...full, samples: 3, confirmSamples: 3, candidateRate: (p, f, c) => (f === 0 && c === 0 ? 0 : p) } },
	{ name: 'one family +30 pts (improvement)', truth: 'null', options: { ...full, samples: 3, confirmSamples: 3, candidateRate: (p, f) => (f === 0 ? p + 0.3 : p) } },
	// The quick check (default: 6 screen samples, 6 confirmation samples) and the low-power 2-sample smoke option.
	{ name: `no change, quick (${label(quick, 6, 6)})`, truth: 'null', options: { ...quick, samples: 6, confirmSamples: 6 } },
	{ name: `quick (${label(quick, 6, 6)}), one family -50 pts`, truth: 'drop', options: { ...quick, samples: 6, confirmSamples: 6, candidateRate: dropOne(0.5) } },
	{ name: `quick (${label(quick, 6, 6)}), every case -10 pts`, truth: 'drop', options: { ...quick, samples: 6, confirmSamples: 6, candidateRate: p => p - 0.1 } },
	{ name: `quick (${label(quick, 6, 3)}), one family -50 pts`, truth: 'drop', options: { ...quick, samples: 6, confirmSamples: 3, candidateRate: dropOne(0.5) } },
	// The per-push preflight (--preflight: 4 screen samples, 6 confirmation samples), explicitly weaker than quick.
	{ name: `no change, preflight (${label(quick, 4, 6)})`, truth: 'null', options: { ...quick, samples: 4, confirmSamples: 6 } },
	{ name: `preflight (${label(quick, 4, 6)}), one family -50 pts`, truth: 'drop', options: { ...quick, samples: 4, confirmSamples: 6, candidateRate: dropOne(0.5) } },
	{ name: `preflight (${label(quick, 4, 6)}), every case -10 pts`, truth: 'drop', options: { ...quick, samples: 4, confirmSamples: 6, candidateRate: p => p - 0.1 } },
	{ name: `no change, quick (${label(quick, 2, 3)})`, truth: 'null', options: { ...quick, samples: 2, confirmSamples: 3 } },
	{ name: `quick (${label(quick, 2, 3)}), one family -50 pts`, truth: 'drop', options: { ...quick, samples: 2, confirmSamples: 3, candidateRate: dropOne(0.5) } },
]);

export function runSimulations({ trials = 2000, seed = 1 } = {}) {
	return SCENARIOS.map((scenario, i) => ({ name: scenario.name, truth: scenario.truth, ...simulateVerdicts({ trials, seed: seed + i * 7919, ...scenario.options }) }));
}

async function main(argv) {
	const trials = Number(argv[argv.indexOf('--trials') + 1]) || 2000;
	const rows = runSimulations({ trials });
	const pct = v => `${(v * 100).toFixed(1)}%`;
	const lines = ['| scenario | screen PASS / INC / FAIL | final PASS / FAIL | extra confirm calls |', '|---|---|---|---:|'];
	for (const r of rows) lines.push(`| ${r.name} | ${pct(r.screen.PASS)} / ${pct(r.screen.INCONCLUSIVE)} / ${pct(r.screen.FAIL)} | ${pct(r.final.PASS)} / ${pct(r.final.FAIL)} | ${r.meanConfirmCalls.toFixed(1)} |`);
	process.stdout.write(`Rule ${JSON.stringify(VERDICT_RULE)}; ${trials} trials per scenario.\n\n${lines.join('\n')}\n`);
	if (argv.includes('--json')) await writeFile(argv[argv.indexOf('--json') + 1], JSON.stringify({ rule: VERDICT_RULE, trials, rows }, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
