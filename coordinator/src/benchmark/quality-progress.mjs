const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const position = p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k]));
const time = r => r.at ?? r.payload?.observedAtEpochMs ?? r.payload?.updatedAtEpochMs ?? r.timestamp ?? r.observedAtMs;
const stationItems = ['minecraft:crafting_table', 'minecraft:furnace'];
const resources = ['stone_pickaxe', 'iron_ingot', 'iron_pickaxe', 'bucket'];

/** PAIR1 trace proxies, scoped to play and kept separate from legacy metrics. */
export function extractQualityProgress({ protocolRows, traceRows, samples, startedAt, endedAt, countItems }) {
	const inWindow = at => Number.isFinite(at) && (startedAt === null || at >= startedAt) && (endedAt === null || at <= endedAt);
	const elapsed = at => Number.isFinite(at) && startedAt !== null ? at - startedAt : null;
	const map = new Map();
	const merge = (id, fields) => { if (id) map.set(id, { ...map.get(id), ...fields, actionId: id }); };
	for (const row of traceRows) {
		if (row.event === 'native_tool_dispatch_started') merge(row.actionId, { type: row.actionType, start: time(row) });
		if (row.event === 'native_tool_action_completed') merge(row.actionId, { end: row.javaEndedAtEpochMs ?? time(row), state: row.state, code: row.reasonCode });
	}
	for (const row of protocolRows) {
		const p = row.payload ?? {};
		if (row.type === 'action_command') merge(p.actionId, { type: p.actionType, args: p.arguments ?? p.args ?? {}, start: map.get(p.actionId)?.start ?? time(row) });
		if (row.type === 'action_result') merge(p.actionId, { type: p.actionType ?? map.get(p.actionId)?.type, state: p.state, code: p.reasonCode,
			end: p.endedAtEpochMs ?? p.observedAtEpochMs ?? map.get(p.actionId)?.end ?? time(row), observation: p.actionObservation });
	}
	const actions = [...map.values()].filter(a => inWindow(a.start)).sort((a, b) => a.start - b.start);
	const succeeded = actions.filter(a => a.state === 'SUCCEEDED' && inWindow(a.end));
	const observations = protocolRows.filter(r => r.type === 'observation').map(r => ({ ...r.payload, dimension: r.payload?.dimension ?? r.payload?.world?.dimension ?? null, at: r.payload?.observedAtEpochMs ?? time(r) }))
		.filter(r => inWindow(r.at)).sort((a, b) => a.at - b.at);
	const points = samples.filter(s => inWindow(s.at)).sort((a, b) => a.at - b.at);
	const nearest = at => observations.findLast(o => o.at <= at);
	const first = Object.fromEntries(resources.map(id => {
		const candidates = [...observations.filter(o => (o.inventory?.items ?? []).some(i => i.itemId === `minecraft:${id}` && i.count > 0)).map(o => o.at),
			...points.filter(s => countItems(s.inventoryNbt, new RegExp(`:${id}$`)) > 0).map(s => s.at)];
		const at = candidates.length ? Math.min(...candidates) : null;
		return [id, { at, elapsedMs: elapsed(at) }];
	}));
	const furnaceActions = succeeded.filter(a => a.type === 'furnace_transaction');
	first.furnace_use = { at: furnaceActions[0]?.end ?? null, elapsedMs: elapsed(furnaceActions[0]?.end), actionId: furnaceActions[0]?.actionId ?? null };
	const ironAt = first.iron_ingot.at;
	// Inventory can update just before the transaction's terminal receipt arrives.
	const acquisition = ironAt === null ? null : succeeded.findLast(a => a.start <= ironAt && a.end >= ironAt - 2000 && a.end <= ironAt + 1000 && a.args?.expectedItemId === 'minecraft:iron_ingot'
		&& (a.type === 'furnace_transaction' && a.args.operation === 'take_output'
			|| a.type === 'menu_click' && a.args.clickType === 'QUICK_MOVE' && /^minecraft:generic_9x[1-6]$/.test(a.args.menuId ?? '') && Number.isInteger(a.args.slot) && a.args.slot >= 0 && a.args.slot < Number(a.args.menuId.at(-1)) * 9));
	first.iron_ingot.source = acquisition ? acquisition.type === 'furnace_transaction' ? 'smelted' : 'looted' : 'unknown';
	first.iron_ingot.sourceActionId = acquisition?.actionId ?? null;
	const stationPoints = observations.filter(o => position(o.position));
	const stations = succeeded.filter(a => /place/.test(a.type ?? '') && stationItems.includes(a.observation?.target?.afterId ?? a.args?.blockId ?? a.args?.itemId))
		.map(a => ({ actionId: a.actionId, item: a.observation?.target?.afterId ?? a.args.blockId ?? a.args.itemId,
			position: a.observation?.target?.position ?? { x: a.args.x, y: a.args.y, z: a.args.z }, dimension: nearest(a.end)?.dimension ?? null, at: a.end }));
	for (const s of stations) {
		const after = position(s.position) ? stationPoints.filter(o => o.at > s.at && o.dimension === s.dimension) : [];
		const left = after.find(o => distance(o.position, s.position) > 8);
		s.leftAt = left?.at ?? null;
		s.revisitedAt = left ? after.find(o => o.at > left.at && distance(o.position, s.position) <= 4)?.at ?? null : null;
		s.reclaimedAt = succeeded.find(a => a.start > s.at && /break|mine/.test(a.type ?? '') && a.observation?.target?.beforeId === s.item
			&& position(a.observation.target.position) && distance(a.observation.target.position, s.position) < .1 && nearest(a.end)?.dimension === s.dimension)?.end ?? null;
		s.unrevisited = Boolean(s.leftAt && !s.revisitedAt && !s.reclaimedAt);
		s.positionCovered = after.length > 0;
	}
	const camps = [];
	for (const s of stations.filter(s => position(s.position))) if (!camps.length || s.dimension !== camps.at(-1).dimension || distance(camps.at(-1).position, s.position) > 16) camps.push({ position: s.position, dimension: s.dimension, at: s.at });
	const transitions = protocolRows.filter(r => r.type === 'goal_control' && ['dead', 'respawn'].includes(r.payload?.operation))
		.map(r => r.payload?.death?.diedAtEpochMs ?? r.payload?.updatedAtEpochMs ?? time(r));
	const campTravel = camps.slice(1).map((camp, i) => {
		const previous = camps[i], between = points.filter(p => position(p.position) && p.at >= previous.at && p.at <= camp.at);
		let travelled = 0;
		for (let k = 1; k < between.length; k++) {
			const a = between[k - 1], b = between[k];
			if (a.dimension === b.dimension && !transitions.some(at => at > a.at && at <= b.at) && !(b.deathCounter > a.deathCounter)) travelled += distance(a.position, b.position);
		}
		return { from: previous, to: camp, straightDistance: previous.dimension === camp.dimension ? distance(previous.position, camp.position) : null, sampledDistance: between.length > 1 ? travelled : null };
	});
	const controls = [];
	for (let i = 0; i < actions.length; i++) {
		const a = actions[i];
		if (!['FAILED', 'TIMED_OUT'].includes(a.state) || !['NO_PATH', 'NO_STANDABLE_PATH', 'NO_SEEN_ROUTE'].includes(a.code)) continue;
		const nextIndex = actions.findIndex((b, j) => j > i && /control|navigate|explore|survey/.test(b.type ?? ''));
		if (nextIndex < 0) continue;
		const next = actions[nextIndex], end = a.end ?? a.start;
		const repaired = actions.slice(i + 1, nextIndex).some(b => b.state === 'SUCCEEDED' && /place|break|mine/.test(b.type ?? '') && b.end <= next.start);
		if (/control/.test(next.type) && (next.args?.forward || next.args?.strafe || next.args?.jump) && !repaired && next.start >= end && next.start - end <= 30000
			&& !transitions.some(at => at > end && at <= next.start)) controls.push({ failedActionId: a.actionId, code: a.code, controlActionId: next.actionId, elapsedMs: elapsed(a.start), delayMs: next.start - end });
	}
	return { version: 1, first, stationCounts: Object.fromEntries(stationItems.map(id => [id, stations.filter(s => s.item === id).length])),
		stationsLeftUnrevisited: stations.filter(s => s.unrevisited).length, stations, camps, campTravel,
		campTravelSampledDistance: campTravel.length && campTravel.every(c => c.sampledDistance !== null) ? campTravel.reduce((n, c) => n + c.sampledDistance, 0) : null,
		noPathThenMovementControl: controls.filter(c => c.code === 'NO_PATH').length, pathFailureThenMovementControl: controls.length, pathFailureControls: controls,
		definitions: { first: 'Earliest positive inventory observation or RCON sample in the play window, across deaths; furnace use is the first successful transaction. Iron source requires a nearby confirmed output retrieval or container QUICK_MOVE, otherwise unknown.',
			station: 'Successful placement; left by >8 blocks, no return within 4 blocks, and no confirmed reclamation before cutoff. Terminal camps not left are excluded. This does not prove permanent abandonment.',
			control: 'Failed NO_PATH (literal) or NO_STANDABLE_PATH/NO_SEEN_ROUTE (broader) followed within 30s by movement control before navigation/exploration/survey, without successful intervening route repair or death/respawn. Trace proxy, not a judgment of the model.',
			travel: 'Successive station sites >16 blocks apart, with sampled 3D movement excluding dimension and death/respawn jumps. Null means insufficient samples; cross-dimension straight distance is unknown.' } };
}
