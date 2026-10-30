// Additive definitions leave the original benchmark fields and acceptance gates reproducible.
const combat = type => /fight|attack/.test(type ?? '');
const unreachableCode = code => /NO_(?:STANDABLE_)?PATH|UNREACHABLE|PATH_NOT_FOUND|APPROACH_BLOCKED|TARGET_NOT_VISIBLE|NO_SEEN_ROUTE/.test(code ?? '');
const food = id => /(?:^|:)(?:cooked_\w+|beef|porkchop|mutton|chicken|rabbit|salmon|cod|bread|\w*apple|\w*carrot|\w*potato|\w*stew|\w*soup|\w*berries|melon_slice|cookie|pumpkin_pie|rotten_flesh|beetroot|dried_kelp|tropical_fish|pufferfish|honey_bottle|chorus_fruit|spider_eye)$/.test(id ?? '');
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
	? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const countBy = (rows, key) => { const counts = {}; for (const r of rows) { const k = key(r); counts[k] = (counts[k] ?? 0) + 1; } return counts; };
const time = r => r?.payload?.observation?.observedAtEpochMs ?? r?.payload?.observedAtEpochMs ?? r?.payload?.updatedAtEpochMs ?? r?.at ?? r?.timestamp ?? r?.observedAtMs;

export const FIRST_RESPONSE_MAX_BYTES = 8192;
export const INITIAL_PLAN_MAX_BYTES = 32768;
export function boundQualityText(value, maxBytes = FIRST_RESPONSE_MAX_BYTES) {
	const bytes = Buffer.from(String(value ?? ''), 'utf8');
	let end = Math.min(bytes.length, maxBytes);
	while (end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return { text: bytes.subarray(0, end).toString('utf8'), truncated: bytes.length > end, originalBytes: bytes.length, maxBytes };
}

export function firstResponseEvidence(providerRows) {
	const rows = providerRows.filter(r => r.executionSettings?.controlProtocol === 'native_tools' || r.traceId).sort((a, b) => time(a) - time(b));
	const first = rows.find(r => typeof r.output === 'string' && r.output.length > 0);
	if (!first) return { captured: false, text: null, source: null, initialResponseVerified: false };
	return { captured: true, ...boundQualityText(first.output), source: first.traceId === 'quality-first-message' ? 'provider-first-message' : 'provider-turn-output',
		at: time(first) ?? null, goalRevision: first.goalRevision ?? null,
		initialResponseVerified: first.traceId === 'quality-first-message' && !rows.some(r => time(r) < time(first) && r.traceId !== 'quality-first-message') };
}

export function initialPlanEvidence(providerRows, snapshot = null) {
	// The translator's original plan survives a quick death even if the live view is overwritten on respawn.
	for (const r of providerRows.filter(r => r.executionSettings?.controlProtocol === 'goal_spec').sort((a, b) => time(a) - time(b))) {
		try {
			const proposal = JSON.parse(r.output);
			if (proposal.plan?.steps?.length) return { ...boundQualityText(JSON.stringify(proposal.plan), INITIAL_PLAN_MAX_BYTES), source: 'goal-spec-output', at: time(r) ?? null };
		} catch { /* absent or truncated legacy output remains unknown */ }
	}
	return snapshot ? { ...boundQualityText(JSON.stringify(snapshot.plan ?? snapshot), INITIAL_PLAN_MAX_BYTES), source: 'first-plan-snapshot', at: snapshot.updatedAt ?? null } : null;
}

export function classifyHazardDeath(cause) {
	if (cause === null || cause === undefined || cause === '') return 'unknown';
	const text = typeof cause === 'string' ? cause : JSON.stringify(cause);
	if (/lava/i.test(text)) return 'lava';
	if (/fireball/i.test(text)) return 'mob';
	if (/fire|burned|burnt|flames|incinerat/i.test(text)) return 'fire';
	if (/fell out of the world|squashed by|falling (?:anvil|block)/i.test(text)) return 'other';
	if (/fall|fell|hit the ground|high place|doomed to|stalagmite/i.test(text)) return 'fall';
	if (/mob_(?:attack|projectile)|slain by|shot by|stung by|wither|finished off by|blown up by|impaled by|killed by .+ using magic|spitted by|pummeled by|sonically.charged shriek/i.test(text)) return 'mob';
	return 'other';
}

export function extractQualityMetricsV2({ actions, protocolRows, samples, targetSamples, providerRows, initialPlan, initialPlanCapture, startedAt, endedAt, stopCancelled }) {
	const inWindow = at => Number.isFinite(at) && (startedAt === null || at >= startedAt) && (endedAt === null || at <= endedAt);
	const list = actions.filter(a => inWindow(a.start));
	const raw = protocolRows.filter(r => r.type === 'observation' && inWindow(time(r))).map(r => {
		const p = r.payload?.observation ?? r.payload ?? {};
		return { at: time(r), position: p.position, dimension: p.world?.dimension, health: p.player?.health,
			input: p.interaction?.input, interaction: p.interaction, inventory: p.inventory, source: 'raw-observation' };
	}).sort((a, b) => a.at - b.at);
	const points = [...samples.filter(s => inWindow(s.at)).map(s => ({ ...s, source: 'server-sample' })), ...raw].sort((a, b) => a.at - b.at);
	const rawPositions = raw.filter(s => s.position && ['x', 'y', 'z'].every(k => Number.isFinite(s.position[k])));
	const positions = points.filter(s => s.position && ['x', 'y', 'z'].every(k => Number.isFinite(s.position[k])));
	const nearest = at => { let found = null; for (const s of points) { if (s.at > at) break; if (Number.isFinite(s.health)) found = s; } return found; };
	const positionAt = at => { let found = null; for (const s of positions) { if (s.at > at) break; found = s; } return found && at - found.at <= 2000 ? found : null; };
	const deaths = protocolRows.filter(r => r.type === 'goal_control' && r.payload?.operation === 'dead')
		.map(r => ({ at: r.payload.death?.diedAtEpochMs ?? time(r), cause: r.payload.death?.cause ?? null, source: 'goal-control' })).filter(d => inWindow(d.at));
	const counters = samples.filter(s => inWindow(s.at) && Number.isFinite(s.deathCounter)).sort((a, b) => a.at - b.at);
	const respawns = protocolRows.filter(r => r.type === 'goal_control' && r.payload?.operation === 'respawn' && inWindow(time(r))).sort((a, b) => time(a) - time(b));
	for (let i = 1; i < counters.length; i++) {
		const prev = counters[i - 1], s = counters[i];
		const missing = Math.max(0, s.deathCounter - prev.deathCounter - deaths.filter(d => d.at > prev.at && d.at <= s.at).length);
		for (let n = 0; n < missing; n++) deaths.push({ at: s.at, intervalStart: prev.at, cause: null, source: 'death-counter', timeIsUpperBound: true });
	}
	let lifeStart = startedAt ?? -Infinity;
	const pairedDeaths = new Set();
	for (const r of respawns) {
		const at = time(r);
		const candidate = deaths.filter(d => !pairedDeaths.has(d) && d.at >= lifeStart && (d.at <= at || d.intervalStart < at)).sort((a, b) => a.at - b.at)[0];
		if (candidate) {
			pairedDeaths.add(candidate);
			if (candidate.at > at) candidate.at = at;
			if (candidate.source === 'death-counter') candidate.intervalStart = Math.max(candidate.intervalStart, lifeStart);
			candidate.respawnAt = at;
		}
		else deaths.push({ at, respawnAt: at, cause: null, source: 'respawn', timeIsUpperBound: true });
		lifeStart = at + 1;
	}
	// A counter proves a death inside its sampling interval. A health rise there cannot prove healing.
	let previousInferredDeath = -Infinity;
	for (const d of deaths.filter(d => d.source === 'death-counter').sort((a, b) => a.at - b.at)) {
		d.intervalStart = Math.max(d.intervalStart, previousInferredDeath + 1);
		let low = false;
		for (const p of points.filter(p => p.at >= d.intervalStart && p.at <= d.at && Number.isFinite(p.health))) {
			if (p.health <= 8) low = true;
			else if (low) { d.at = p.at; d.timingMethod = 'First recovery inside proven-death interval; conservative upper bound.'; break; }
		}
		previousInferredDeath = d.at;
	}
	deaths.sort((a, b) => a.at - b.at);
	const crossedDeath = (a, b) => deaths.some(d => d.at > a && d.at <= b);
	const fights = list.filter(a => combat(a.type));
	const failed = a => ['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(a.state) && !stopCancelled(a);
	const failedFights = fights.filter(failed);
	const unreachable = fights.filter(a => failed(a) && (unreachableCode(a.code) || targetSamples.some(t => t.actionId === a.actionId && t.verticalDelta > 3)));
	const repeatedGroups = [], prior = new Map();
	let missingFailurePositions = 0;
	for (const a of list) {
		const signature = JSON.stringify([a.type, canonical(a.args ?? {})]);
		if (a.state === 'SUCCEEDED') { for (const key of prior.keys()) if (key.startsWith(signature + '|')) prior.delete(key); continue; }
		if (!failed(a)) continue;
		const s = positionAt(a.start), key = `${signature}|${a.code ?? a.state}`;
		if (!s) { missingFailurePositions++; prior.delete(key); continue; }
		const previous = prior.get(key);
		const same = previous && previous.dimension === s.dimension && !crossedDeath(previous.lastAt, a.start)
			&& dist(previous.position, s.position) <= .4
			&& !positions.some(p => p.at > previous.lastAt && p.at <= a.start && (p.dimension !== s.dimension || dist(previous.position, p.position) > .4));
		if (same) {
			if (previous.requests === 1) repeatedGroups.push(previous);
			previous.requests++; previous.lastAt = a.start; previous.actionIds.push(a.actionId);
		} else prior.set(key, { at: a.start, lastAt: a.start, tool: a.type, arguments: a.args ?? {}, resultCode: a.code ?? a.state,
			position: s.position, dimension: s.dimension ?? null, requests: 1, actionIds: [a.actionId] });
	}
	const sprintStreaks = [];
	let streak = null;
	const finishSprint = () => { if (streak && streak.lastAt - streak.at >= 3000) sprintStreaks.push({ ...streak, durationMs: streak.lastAt - streak.at }); streak = null; };
	for (const s of rawPositions) {
		const sprint = s.input?.active === true && s.input.sprint === true && (Math.abs(s.input.forward ?? 0) > 0 || Math.abs(s.input.strafe ?? 0) > 0) && s.health !== 0;
		if (!sprint) { finishSprint(); continue; }
		if (streak && (s.at - streak.lastAt > 2000 || s.dimension !== streak.dimension || crossedDeath(streak.lastAt, s.at)
			|| Math.hypot(s.position.x - streak.position.x, s.position.z - streak.position.z) > .4)) finishSprint();
		if (!streak) streak = { at: s.at, lastAt: s.at, position: s.position, dimension: s.dimension ?? null };
		else streak.lastAt = s.at;
	}
	finishSprint();
	const foodUses = [];
	let selectedItem = null, selectedAt = -Infinity, lastActionAt = -Infinity;
	for (const a of list) {
		if (crossedDeath(lastActionAt, a.start)) { selectedItem = null; selectedAt = -Infinity; }
		lastActionAt = a.start;
		if (a.type === 'select_item' && a.state === 'SUCCEEDED') { selectedItem = a.args?.itemId; selectedAt = a.end ?? a.start; }
		const latest = raw.filter(r => r.at <= a.start).at(-1);
		const observation = latest && a.start - latest.at <= 2000 && !crossedDeath(latest.at, a.start) ? latest : null;
		const offhand = ['off', 'off_hand'].includes(a.args?.hand);
		const handItem = offhand ? observation?.interaction?.offHandItemId : observation?.interaction?.mainHandItemId;
		let item = a.args?.itemId ?? (!offhand && selectedAt > (observation?.at ?? -Infinity) ? selectedItem : handItem);
		if (a.type === 'control' && !offhand && Number.isInteger(a.args?.selectedSlot)) {
			item = observation?.inventory?.items?.find(i => i.slot === a.args.selectedSlot)?.itemId
				?? (observation?.input?.selectedSlot === a.args.selectedSlot ? handItem : null);
			selectedItem = null; selectedAt = -Infinity;
		}
		if (/eat|consume/.test(a.type) || a.type === 'use_item' && food(item) || a.type === 'control' && a.args?.use === true && food(item)) {
			const s = nearest(a.start), health = s && !crossedDeath(s.at, a.start) && a.start - s.at <= 2000 ? s.health : null;
			foodUses.push({ at: a.start, actionId: a.actionId, health, completed: a.state === 'SUCCEEDED', source: 'action', itemId: item ?? null });
		}
	}
	for (const s of raw) {
		const interaction = s.interaction;
		const offhand = ['off', 'off_hand'].includes(interaction?.input?.hand) || interaction?.activeHand === 'off_hand';
		const item = offhand ? interaction?.offHandItemId : interaction?.mainHandItemId;
		if (food(item) && (interaction.usingItem === true || interaction.input?.active === true && interaction.input?.use === true))
			foodUses.push({ at: s.at, health: s.health ?? null, completed: false, source: 'raw-use', itemId: item });
	}
	foodUses.sort((a, b) => a.at - b.at);
	const episodes = [];
	let episode = null, awaitingRespawn = false;
	const events = [...points.filter(s => Number.isFinite(s.health)).map(s => ({ ...s, kind: 'health' })), ...deaths.map(d => ({ ...d, kind: 'death' }))]
		.sort((a, b) => a.at - b.at || (a.kind === 'death' ? -1 : 1));
	for (const s of events) {
		if (s.kind === 'death') {
			if (episode) { episodes.push({ ...episode, outcome: 'died', endedAt: s.at }); episode = null; }
			awaitingRespawn = true;
			continue;
		}
		if (awaitingRespawn && s.health <= 0) continue;
		awaitingRespawn = false;
		if (s.health <= 8 && !episode) episode = { lowHealthAt: s.at, minimumHealth: s.health };
		if (episode) episode.minimumHealth = Math.min(episode.minimumHealth, s.health);
		if (s.health > 8 && episode) {
			const uses = foodUses.filter(u => u.at >= episode.lowHealthAt && u.at <= s.at);
			episodes.push({ ...episode, outcome: uses.length ? 'recoveredByHealing' : 'recoveredWithoutEating', endedAt: s.at }); episode = null;
		}
	}
	if (episode) episodes.push({ ...episode, outcome: 'censored', endedAt });
	for (const e of episodes) e.foodUses = foodUses.filter(u => u.at >= e.lowHealthAt && (e.endedAt === null || u.at <= e.endedAt));
	lifeStart = startedAt ?? -Infinity;
	const foodBeforeDeaths = deaths.map(d => {
		const lifeHealth = points.filter(s => s.at >= lifeStart && s.at < d.at && Number.isFinite(s.health));
		const uses = foodUses.filter(u => u.at >= lifeStart && u.at < d.at && Number.isFinite(u.health) && u.health < 6);
		lifeStart = d.at;
		return { deathAt: d.at, cause: d.cause, used: uses.length ? true : lifeHealth.length ? false : null,
			completed: uses.some(u => u.completed), below6HpObserved: lifeHealth.some(s => s.health < 6), evidence: uses };
	});
	const hazards = { lava: 0, fire: 0, fall: 0, mob: 0, other: 0, unknown: 0 };
	for (const d of deaths) { d.hazardType = classifyHazardDeath(d.cause); hazards[d.hazardType]++; }
	return { version: 2, failedFightRequests: failedFights.length, failedFightRequestsByCode: countBy(failedFights, a => a.code ?? a.state),
		attacksOnUnreachableTargets: unreachable.length, unreachableAttacks: unreachable.map(a => ({ actionId: a.actionId, at: a.start, resultCode: a.code ?? null,
			verticalDelta: targetSamples.find(t => t.actionId === a.actionId)?.verticalDelta ?? null })),
		combatActionsWithoutTargetSample: fights.filter(a => !targetSamples.some(t => t.actionId === a.actionId)).length,
		lowHealthEpisodes: episodes, lowHealthEpisodeCount: points.some(s => Number.isFinite(s.health)) ? episodes.length : null,
		lowHealthOutcomes: points.some(s => Number.isFinite(s.health)) ? { recoveredByHealing: 0, recoveredWithoutEating: 0, died: 0, censored: 0, ...countBy(episodes, e => e.outcome) } : null,
		repeatedIdenticalFailingRequests: repeatedGroups.reduce((n, g) => n + g.requests - 1, 0), repeatedFailureGroups: repeatedGroups,
		stationarySprintSeconds: rawPositions.length > 1 ? sprintStreaks.reduce((n, s) => n + s.durationMs / 1000, 0) : null, stationarySprintStreaks: sprintStreaks,
		foodUsedBelow6HpBeforeDeath: foodBeforeDeaths, hazardDeathsByType: hazards, deathEvents: deaths,
		firstResponse: firstResponseEvidence(providerRows), initialPlan: initialPlanCapture ?? initialPlanEvidence(providerRows, initialPlan),
		coverage: { rawObservations: raw.length, rawPositions: rawPositions.length, missingFailurePositions, inferredDeaths: deaths.filter(d => d.source !== 'goal-control').length },
		definitions: { legacy: 'Top-level metric definitions are unchanged. Use qualityV2 for corrected behaviour metrics.',
			lowHealth: 'Finite HP <=8 opens an episode; HP >8 closes recovery; death/counter/respawn closes death. Healing recovery means food use observed before HP recovery, not proven causal healing.',
			food: 'Below 6 HP is strict. Used means a food-use request or raw held-food use, not selection alone; completed records successful requests, not proven consumption. No health evidence yields null.',
			repeatedFailures: 'Excess requests with equal tool, full canonical arguments and failure code, within 0.4m in 3D with no intervening movement, death or successful equal request. Position evidence must be <=2s old.',
			stationarySprint: 'Raw active sprint movement input, horizontal displacement <=0.4m from streak start, streak >=3s, observation gap <=2s; no dimension/death crossing. Sum qualifying observed streak durations.',
			hazards: 'Authoritative death cause text classified as lava, fire, fall, mob, other or unknown; stale last-attacker evidence is not a death cause.' } };
}
