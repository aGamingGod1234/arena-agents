#!/usr/bin/env node
import { readArtifactReport } from '../../coordinator/src/benchmark/report-artifacts.mjs';
import { compareQualityReports, pairedTokenConfidence, firstAttemptQualityRuns } from '../../coordinator/src/benchmark/quality-metrics.mjs';
if (![3, 4].includes(process.argv.length)) { console.error('Usage: node scripts/quality/compare-scenarios.mjs paired/results.json OR base.json after.json'); process.exitCode = 1; }
else {
	const reports = await Promise.all(process.argv.slice(2).map(readArtifactReport));
	const [base, after] = reports.length === 1 ? [reports[0].arms?.A, reports[0].arms?.B] : reports;
	if (!base || !after) throw new Error('Both A and B reports are required');
	const scenarios = compareQualityReports(base, after);
	const firstAttempts = (report, arm) => report.firstAttemptRuns ?? firstAttemptQualityRuns(report.runs,
		(reports.length === 1 ? reports[0].history ?? [] : []).filter(run => run.arm === arm),
		(reports.length === 1 ? reports[0].sequence ?? [] : []).filter(row => row.arm === arm));
	const overall = pairedTokenConfidence(base.runs, after.runs, { firstAttemptsBefore: firstAttempts(base, 'A'), firstAttemptsAfter: firstAttempts(after, 'B') });
	if (reports.length === 1 && !reports[0].complete || scenarios.some(s => s.conditions.status !== 'MATCHED')) overall.verdict = 'INCONCLUSIVE';
	console.log(JSON.stringify({ overall, scenarios }, null, 2));
}
