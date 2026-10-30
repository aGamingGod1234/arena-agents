/**
 * Named standing-guard templates the model can install in one call. A template is text the model selects: its
 * condition and source read only facts the observation already reports (breathable target, reported exits, cloud
 * exits, incoming projectiles, the drop ahead, the urgent threat, food) plus the model's own parameters. Every branch
 * can be switched off or tuned through parameters, and the only positions it ever moves to besides reported cells are
 * the model's own escape/water parameters. Nothing here installs a guard.
 */
const S = 'player.state()';
const C = 'program.parameters()';

// The model selects these branches together; optional parameters can narrow them without rewriting the trigger.
const SURVIVAL_WHEN = [
	`(${C}.air && ${S}.underWater && ${S}.airSecondsLeft < ${C}.airBelowS)`,
	`((${C}.lava && ${S}.inLava) || (${C}.fire && ${S}.fire))`,
	`(${C}.clouds && ${S}.cloudDanger)`,
	`(${C}.projectiles && ${S}.incomingProjectiles.length > 0)`,
	`(${C}.fall && ${S}.dropAhead && ${S}.dropAhead.at <= ${C}.fallWithin && (${S}.dropAhead.drop >= ${C}.fallDepth || ${S}.dropAhead.into === "lava"))`,
	`(${C}.threats && ${S}.threat && ${S}.threat.visible && ${S}.threat.targetable && (!!${S}.safeExit || !!${C}.escape || (${S}.threat.meleeCandidate && ${S}.health > ${C}.fightAtHealth)))`,
	`(${S}.health < ${C}.healBelow && ((${S}.canHealNow && ${S}.bestFood !== null) || (!${S}.threat && !!${C}.escape)))`,
].map(row => row.slice(1, -1)).join('||').replaceAll(' ', '');

const frame = (fields) => `player.control({forward:${fields.forward ?? 0},strafe:${fields.strafe ?? 0},jump:${fields.jump ?? false},sneak:${fields.sneak ?? false},sprint:${fields.sprint ?? false},attack:false,use:false,yaw:p.yaw,pitch:${fields.pitch ?? 'p.pitch'},selectedSlot:s,hand:"main",ticks:${fields.ticks}})`;
const moveTo = (target) => `await tryResult(player.moveTo({x:${target}.x,y:${target}.y,z:${target}.z,tolerance:0.5}));`;

const SURVIVAL_SOURCE = [
	'program.onUnhandledAttention("continue_and_notify",{survival:"continue_and_notify"});',
	'const c=program.parameters(); const p=player.state(); const t=p.threat; const s=inventory.state().selectedSlot;',
	'let exit=null; for(const e of p.exitCells){if(exit===null && e.safe){exit=e;}}',
	// Crouch in place before other branches can carry the body over a reported edge.
	`if(c.fall && p.dropAhead!==null && p.dropAhead.at<=c.fallWithin && (p.dropAhead.drop>=c.fallDepth || p.dropAhead.into==="lava")){await tryResult(${frame({ sneak: true, ticks: 6 })});}`,
	// Air: reach the reported cell, then hold space to refill instead of immediately sinking again.
	`else if(c.air && p.underWater && p.airSecondsLeft<c.airBelowS){if(p.breathable!==null){const b=p.breathable; const r=await tryResult(player.moveTo({x:b.x,y:b.y,z:b.z,tolerance:0.5})); if(r.succeeded && c.airHoldTicks>0 && player.state().inWater){await tryResult(${frame({ jump: true, pitch: 0, ticks: 'c.airHoldTicks' })});}} else {await tryResult(${frame({ jump: true, pitch: -60, ticks: 20 })});}}`,
	// Fire/lava: a reported exit, then the model's water (never in the Nether, where it evaporates), then its escape.
	`else if((c.lava && p.inLava) || (c.fire && p.fire)){const wet=c.water!==null && (world.state().dimension==="minecraft:overworld" || world.state().dimension==="minecraft:the_end"); let d=exit; if(wet && (d===null || !p.inLava)){d=c.water;} if(d===null){d=c.escape;} if(d!==null){${moveTo('d')}} else if(p.inLava){await tryResult(${frame({ jump: true, pitch: 0, ticks: 10 })});}}`,
	// Harmful cloud: the cloud's reported nearest exit.
	`else if(c.clouds && p.cloudDanger){if(p.cloudExit!==null && (p.cloudExit.route==="verified" || p.cloudExit.route==="walkable")){const d=p.cloudExit; ${moveTo('d')}} else if(c.escape!==null){const d=c.escape; ${moveTo('d')}} else {program.checkpoint("cloud exit route unverified; choose escape");}}`,
	// Incoming damaging projectile: a held shield if one blocks, else a sideways sprint step.
	`else if(c.projectiles && p.incomingProjectiles.length>0){let hit=null; for(const r of p.incomingProjectiles){if(hit===null && r.damaging){hit=r;}} if(hit!==null){let held=false; if(hit.shieldBlockable===true && inventory.count("minecraft:shield")>0){const b=await tryResult(player.blockWithShield({durationMs:math.ceil(hit.etaSeconds*20+6)*50})); held=b.succeeded;} if(!held){await tryResult(${frame({ strafe: 'hit.bearing>=0?1:-1', sprint: true, ticks: 8 })});}}}`,
	// Combat bails at <= fleeAtHealth, so this authored template must engage strictly above that shared threshold.
	// Threat: only a visible, targetable mob is actionable. Use reported safe exits or the model's own escape.
	`else if(c.threats && t!==null && t.visible && t.targetable){if(t.type!=="minecraft:creeper" && t.distance<=3 && p.health>c.fightAtHealth){await tryResult(player.fightTarget({targetId:t.uuid,timeoutMs:6000,fleeAtHealth:c.fightAtHealth}));} if(player.state().threat!==null){let d=player.state().safeExit; if(d===null){d=c.escape;} if(d!==null){${moveTo('d')}} else {program.checkpoint("threat escape skipped: no reported safe exit or model escape; route reachability unverified");}}}`,
	// Low health without a threat: retreat to the model's escape.
	`else if(p.health<c.healBelow && t===null && c.escape!==null){const d=c.escape; ${moveTo('d')}}`,
	'const f=player.state().bestFood; if(player.state().health<c.healBelow && player.state().canHealNow && f!==null){await player.selectItem({itemId:f.itemId}); await player.useItem({durationMs:2000});}',
].join(' ');

const toggle = { type: 'boolean', default: true };
const position = { type: 'position', default: null };

export const STANDING_TEMPLATES = Object.freeze({
	survival: Object.freeze({
		when: SURVIVAL_WHEN,
		source: SURVIVAL_SOURCE,
		maxActions: 8,
		timeoutMs: 20_000,
		// Branch switches, thresholds and the model's own destinations; omitted ones take these defaults.
		parameters: Object.freeze({
			airHoldTicks: { type: 'integer', default: 80, minimum: 0, maximum: 200 },
			air: toggle, airBelowS: { type: 'number', default: 10, minimum: 1, maximum: 15 },
			fire: toggle, lava: toggle, water: position, escape: position,
			clouds: toggle, projectiles: toggle, fall: toggle,
			fallDepth: { type: 'number', default: 4, minimum: 1, maximum: 16 },
			fallWithin: { type: 'number', default: 3, minimum: 0, maximum: 8 },
			threats: toggle, fightAtHealth: { type: 'number', default: 10, minimum: 1, maximum: 20 },
			healBelow: { type: 'number', default: 10, minimum: 0, maximum: 20 },
		}),
	}),
});

const COVERAGE = [
	['air', /\b(?:air|airSecondsLeft|airBubbles|underWater|drown)\b/, 'air'],
	['fire', /\b(?:fire|onFire)\b/, 'fire'],
	['lava', /\b(?:inLava|lava)\b/, 'lava'],
	['projectile', /\b(?:incomingProjectiles|projectile)\b/, 'projectiles'],
	['cloud', /\b(?:clouds|cloudExit|cloudDanger|dragon_breath)\b/, 'clouds'],
	['fall', /\b(?:dropAhead|fallDistance|fallDamage|void)\b/, 'fall'],
	['threat', /\b(?:threat|threats|highestRiskThreat)\b/, 'threats'],
];

/** A lexical coverage hint, not proof: both trigger and response must name the hazard. */
export function standingGuardCoverage({ id, when, source, parameters }) {
	const missing = COVERAGE.filter(([, pattern, toggle]) => !pattern.test(when) || !pattern.test(source) || parameters?.[toggle] === false).map(([name]) => name);
	return missing.length ? `${id} missing: ${missing.join(',')}` : `${id} covers ${COVERAGE.map(([name]) => name).join(',')}`;
}

/** Explain the opt-in template's threat eligibility, including skipped threats, without installing or firing it. */
export function survivalThreatFeedback(player, parameters = {}) {
	return (player.threats ?? []).map(t => {
		const fight = t.visible === true && t.targetable === true && t.type !== 'minecraft:creeper' && t.distance <= 3 && player.health > (parameters.fightAtHealth ?? 10);
		const escape = player.safeExit != null ? 'reported_safe_exit' : parameters.escape != null ? 'model_escape' : null;
		const response = parameters.threats === false ? 'disabled' : t.visible !== true || t.targetable !== true ? 'skipped_unseen_or_untargetable' : fight ? 'fight_then_escape_if_available' : escape ?? 'skipped_no_supported_escape';
		return { uuid: t.uuid, visible: t.visible, targetable: t.targetable, reachable: t.reachable, perception: t.perception, response, escape };
	});
}
