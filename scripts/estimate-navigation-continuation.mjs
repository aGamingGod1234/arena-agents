import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// Message/position evidence identifies candidates, never unseen route safety.
async function summarize(file) {
	const dispatches = new Map();
	const frontier = [];
	const otherStops = {};
	for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
		if (!line.trim()) continue;
		const row = JSON.parse(line);
		if (row.event === 'native_tool_dispatch_started') dispatches.set(row.actionId, row.actionType);
		if (row.event !== 'native_tool_action_completed') continue;
		if (['NO_SEEN_ROUTE', 'NO_STANDABLE_PATH'].includes(row.reasonCode)) otherStops[row.reasonCode] = (otherStops[row.reasonCode] ?? 0) + 1;
		if (row.reasonCode !== 'REACHED_FRONTIER') continue;
		const body = row.actionObservation?.position;
		const target = row.actionObservation?.target;
		const point = target?.position;
		const remaining = body && point ? Math.hypot(body.x - point.x, body.y - point.y, body.z - point.z) : null;
		const dy = body && point ? Math.abs(body.y - point.y) : null;
		const noCloser = row.message.startsWith('Selected frontier no closer');
		const obstruction = row.message.includes('Seen obstruction:');
		const nearEnvelope = remaining !== null && remaining <= Math.max(target.tolerance, Math.min(2.5, target.tolerance + 1.5)) && dy <= 0.5;
		frontier.push({ agent: row.agentId.slice(0, 8), actionType: dispatches.get(row.actionId) ?? null, remaining, dy, tolerance: target?.tolerance,
			elapsedMs: row.javaElapsedMs, noCloser, obstruction, nearEnvelope, message: row.message });
	}
	const noCloser = frontier.filter(row => row.noCloser).length;
	return {
		frontierCases: frontier.length,
		byAgent: Object.fromEntries([...new Set(frontier.map(row => row.agent))].map(agent => [agent, frontier.filter(row => row.agent === agent).length])),
		byAction: Object.fromEntries([...new Set(frontier.map(row => row.actionType))].map(type => [type, frontier.filter(row => row.actionType === type).length])),
		noCloser, seenPathEnds: frontier.length - noCloser,
		nearEnvelope: frontier.filter(row => row.nearEnvelope).length,
		nearWithoutReportedObstruction: frontier.filter(row => row.nearEnvelope && !row.obstruction).length,
		otherStops,
		estimate: { primaryContinuationCandidates: noCloser, conditionalRoundsSaved: noCloser, conditionalModelWaitSecondsSaved: [noCloser * 4, noCloser * 10],
			provenRoundsSaved: 0, inActionRecheckEligible: frontier.length,
			limitations: 'No-closer messages identify the removed gate, not a proven safe alternative. The other sight-boundary cases can continue only if reobservation finds one. Near candidates still require stable verified dry footing and the acquired-cell checks. No live replay was performed; geometry and turn latency are not reconstructible from these receipts.' },
		cases: frontier,
	};
}

const [run2, run1] = process.argv.slice(2);
if (!run2) throw new Error('Usage: node scripts/estimate-navigation-continuation.mjs RUN2_COORDINATOR_JSONL [RUN1_ALL_JSONL]');
console.log(JSON.stringify({ run2: await summarize(run2), ...(run1 ? { run1: await summarize(run1) } : {}) }, null, 2));
