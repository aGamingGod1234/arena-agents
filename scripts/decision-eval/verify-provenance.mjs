#!/usr/bin/env node
// Verify decision-eval case provenance against the recorded traces.
//
//   node scripts/decision-eval/verify-provenance.mjs --root <dir holding the traces> <case file or dir>...
//
// For every case: the recorded observation at source.trace/protocolFile line source.line (or, for a derived case,
// at source.derived.from) must hash to the recorded observation hash, and a real case's state.observation must be
// that recorded observation unchanged. Every canned multi-step reply must equal the action_result recorded at its
// `recorded.line`, answering the command recorded at `recorded.commandLine`. Each earlier observation added for a
// recent result (source.resultObservationLines) must be the recorded observation at that line: unchanged in a real
// case, the same moment (observedAtEpochMs and result) in a derived one. source.sourceMomentId, when present, must be
// "sm-" + the first 16 hex of SHA-256(trace, a newline, the recorded observation hash) of the recorded source moment (for a
// derived case, the moment it was derived from). Exit 1 on any mismatch or missing trace.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { canonicalJson, observationSha256, rawObservation } from '../../coordinator/src/decision-eval/capture.mjs';
import { validateCaseFile } from '../../coordinator/src/decision-eval/schema.mjs';

export function loadCases(target) {
	const files = fs.statSync(target).isDirectory()
		? fs.readdirSync(target).filter((name) => name.endsWith('.json')).map((name) => path.join(target, name))
		: [target];
	return files.flatMap((file) => {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (!Array.isArray(parsed) && !Array.isArray(parsed?.cases)) return [];
		return validateCaseFile(parsed, file).map((testCase) => ({ file, testCase }));
	});
}

function traceFile(root, trace, protocolFile) {
	return trace.endsWith('.jsonl') ? path.join(root, trace) : path.join(root, trace, protocolFile ?? 'quality-protocol.jsonl');
}

/** Reads the requested 1-based lines of a file in one pass. */
async function readLines(file, wanted) {
	const found = new Map();
	const max = Math.max(...wanted);
	const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
	let line = 0;
	for await (const text of lines) {
		line++;
		if (wanted.has(line)) found.set(line, text);
		if (line >= max) break;
	}
	lines.close();
	return found;
}

export async function verifyProvenance(cases, root) {
	const needs = new Map(); // file -> Set(line)
	const want = (file, line) => { if (!needs.has(file)) needs.set(file, new Set()); needs.get(file).add(line); };
	const checks = [];
	for (const { testCase } of cases) {
		const s = testCase.source ?? {};
		const from = s.derived?.from ?? s;
		const file = traceFile(root, from.trace, s.protocolFile);
		want(file, from.line);
		checks.push({ kind: 'observation', testCase, file, line: from.line, expected: from.observationSha256 });
		for (const line of s.resultObservationLines ?? []) {
			const resultFile = traceFile(root, s.trace, s.protocolFile);
			want(resultFile, line);
			checks.push({ kind: 'result-observation', testCase, file: resultFile, line });
		}
		for (const [stepIndex, step] of (testCase.steps ?? []).entries()) for (const [choiceIndex, choice] of step.canned.entries()) {
			const recorded = choice.recorded;
			if (!recorded) { checks.push({ kind: 'missing', testCase, message: `steps[${stepIndex}].canned[${choiceIndex}] has no recorded pointer` }); continue; }
			const cannedFile = traceFile(root, recorded.trace, recorded.protocolFile);
			want(cannedFile, recorded.line);
			want(cannedFile, recorded.commandLine);
			checks.push({ kind: 'canned', testCase, file: cannedFile, choice, stepIndex, choiceIndex });
		}
	}
	const texts = new Map();
	for (const [file, lines] of needs) {
		if (!fs.existsSync(file)) { texts.set(file, null); continue; }
		texts.set(file, await readLines(file, lines));
	}
	const failures = [];
	const envelopeAt = (file, line) => {
		const text = texts.get(file)?.get(line);
		return text === undefined ? null : JSON.parse(text).envelope;
	};
	for (const check of checks) {
		const id = check.testCase.id;
		if (check.kind === 'missing') { failures.push(`${id}: ${check.message}`); continue; }
		if (texts.get(check.file) === null) { failures.push(`${id}: trace not found ${check.file}`); continue; }
		if (check.kind === 'result-observation') {
			const envelope = envelopeAt(check.file, check.line);
			if (envelope?.type !== 'observation') { failures.push(`${id}: result observation line ${check.line} is not an observation`); continue; }
			const recorded = rawObservation(envelope.payload);
			const previous = check.testCase.state.previousObservations ?? [];
			const match = check.testCase.source.derived
				? previous.some((o) => o.observedAtEpochMs === recorded.observedAtEpochMs && o.lastResult?.actionId === recorded.lastResult?.actionId)
				: previous.some((o) => observationSha256(o) === observationSha256(recorded));
			if (!match) failures.push(`${id}: result observation at line ${check.line} is not among the previous observations`);
			continue;
		}
		if (check.kind === 'observation') {
			const envelope = envelopeAt(check.file, check.line);
			if (envelope?.type !== 'observation') { failures.push(`${id}: line ${check.line} is not an observation`); continue; }
			const recordedHash = observationSha256(rawObservation(envelope.payload));
			if (recordedHash !== check.expected) failures.push(`${id}: recorded observation hash ${recordedHash} != ${check.expected}`);
			const momentId = check.testCase.source.sourceMomentId;
			const from = check.testCase.source.derived?.from ?? check.testCase.source;
			const expectedMomentId = `sm-${createHash('sha256').update(`${from.trace}\n${recordedHash}`).digest('hex').slice(0, 16)}`;
			if (momentId !== undefined && momentId !== expectedMomentId) failures.push(`${id}: sourceMomentId ${momentId} is not the recorded source moment`);
			const stateHash = observationSha256(check.testCase.state.observation);
			if (!check.testCase.source.derived && stateHash !== recordedHash) failures.push(`${id}: real case observation differs from the recording`);
			// An agent-state derivation (for example a replaced plan) keeps the recorded observation unchanged.
			const scope = check.testCase.source.derived?.scope ?? 'observation';
			if (check.testCase.source.derived && scope === 'observation' && stateHash === recordedHash) failures.push(`${id}: derived case observation equals the recording (no edit)`);
			if (check.testCase.source.derived && scope === 'agent' && stateHash !== recordedHash) failures.push(`${id}: agent-state derivation changed the observation`);
			if (check.testCase.source.derived && stateHash !== check.testCase.source.observationSha256) failures.push(`${id}: derived observation hash not recorded in source`);
		} else {
			const { choice, stepIndex, choiceIndex } = check;
			const where = `${id} steps[${stepIndex}].canned[${choiceIndex}]`;
			const result = envelopeAt(check.file, choice.recorded.line);
			const command = envelopeAt(check.file, choice.recorded.commandLine);
			if (result?.type !== 'action_result') { failures.push(`${where}: line ${choice.recorded.line} is not an action_result`); continue; }
			if (canonicalJson(result.payload) !== canonicalJson(choice.result)) failures.push(`${where}: canned result differs from the recorded action_result`);
			if (command?.type !== 'action_command' || command.payload.actionId !== result.payload.actionId) failures.push(`${where}: recorded command does not match the result`);
			else if (canonicalJson(command.payload.arguments) !== canonicalJson(choice.recorded.command.arguments)) failures.push(`${where}: recorded command arguments differ`);
		}
	}
	return { cases: cases.length, checks: checks.length, failures };
}

async function main() {
	const args = process.argv.slice(2);
	const rootIndex = args.indexOf('--root');
	const root = rootIndex >= 0 ? args.splice(rootIndex, 2)[1] : process.cwd();
	if (args.length === 0) { process.stderr.write('usage: verify-provenance.mjs --root <dir> <case file or dir>...\n'); process.exit(2); }
	const cases = args.flatMap((target) => loadCases(target));
	const report = await verifyProvenance(cases, path.resolve(root));
	for (const failure of report.failures) process.stderr.write(`${failure}\n`);
	process.stdout.write(`${JSON.stringify({ cases: report.cases, checks: report.checks, failures: report.failures.length })}\n`);
	process.exit(report.failures.length === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
