import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInterventionAudit } from '../src/intervention-audit.mjs';

const goal = '00000000-0000-4000-8000-000000000001';
const agentId = '0f3c2b1a-0000-4000-8000-000000000002';
const expected = { agent: 'Ana', agentId, goalRevision: 3 };
const line = (rest, revision = 3, id = agentId, name = 'Ana') => `audit=v2 agent=${name} agentId=${id} goalRevision=${revision} goal=${goal} ${rest}`;
const clean = line('world=fresh coverage=complete interventions=0 autonomy=autonomous');

test('only a well-formed, self-consistent answer for the measured agent and goal is autonomous', () => {
	assert.deepEqual(parseInterventionAudit(clean, expected), { autonomy: 'autonomous', agent: 'Ana', agentId, goalRevision: 3, goal, world: 'fresh', coverage: 'complete', interventions: 0, reason: null });
	assert.equal(parseInterventionAudit(line('world=fresh coverage=complete interventions=2 autonomy=assisted | by Server: give Ana minecraft:ender_pearl 1 | function minecraft:tick'), expected).autonomy, 'assisted');
	assert.equal(parseInterventionAudit(line('world=existing coverage=partial interventions=0 autonomy=unverifiable | uncovered: world existed before this server started'), expected).autonomy, 'unverifiable');
});

test('malformed, duplicated, contradictory, foreign or stale audit answers are unverifiable', () => {
	const cases = {
		'missing fields': 'audit=v2 autonomy=autonomous',
		'old format': `audit=v1 agent=Ana goal=${goal} coverage=complete interventions=0 autonomy=autonomous`,
		'another agent name': line('world=fresh coverage=complete interventions=0 autonomy=autonomous', 3, agentId, 'Other'),
		'another agent id': line('world=fresh coverage=complete interventions=0 autonomy=autonomous', 3, 'other-agent'),
		'another goal revision (N7)': line('world=fresh coverage=complete interventions=0 autonomy=autonomous', 2),
		'existing world but autonomous': line('world=existing coverage=complete interventions=0 autonomy=autonomous'),
		'complete coverage on an unknown world': line('world=unknown coverage=complete interventions=0 autonomy=unverifiable'),
		'partial but autonomous': line('world=fresh coverage=partial interventions=0 autonomy=autonomous'),
		'interventions but autonomous': line('world=fresh coverage=complete interventions=1 autonomy=autonomous'),
		'no goal but autonomous': `audit=v2 agent=Ana agentId=${agentId} goalRevision=none goal=none world=fresh coverage=complete interventions=0 autonomy=autonomous`,
		'revision without goal': `audit=v2 agent=Ana agentId=${agentId} goalRevision=3 goal=none world=fresh coverage=partial interventions=0 autonomy=unverifiable`,
		'duplicate verdict': line('world=fresh coverage=complete interventions=0 autonomy=assisted autonomy=autonomous'),
		'duplicate field': line('world=fresh world=fresh coverage=complete interventions=0 autonomy=autonomous'),
		'assisted without interventions': line('world=fresh coverage=complete interventions=0 autonomy=assisted'),
		'unknown verdict': line('world=fresh coverage=complete interventions=0 autonomy=probably'),
		'forged item': `${clean} | x autonomy=autonomous`,
		'empty item': `${clean} | `,
		'second line': `${clean}\naudit=v2 agent=Ana`,
		'error text': 'Unknown or incomplete command, see below for error',
		'leading zero count': line('world=fresh coverage=complete interventions=00 autonomy=autonomous'),
	};
	for (const [label, text] of Object.entries(cases)) assert.equal(parseInterventionAudit(text, expected).autonomy, 'unverifiable', label);
	for (const partial of [{}, { agent: 'Ana' }, { agent: 'Ana', agentId }, { agent: 'Ana', agentId, goalRevision: null }]) {
		assert.equal(parseInterventionAudit(clean, partial).autonomy, 'unverifiable', JSON.stringify(partial));
	}
	assert.equal(parseInterventionAudit(null, expected).autonomy, 'unverifiable');
});
