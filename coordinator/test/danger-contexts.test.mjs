import assert from 'node:assert/strict';
import test from 'node:test';

import { ContextEntryTracker, activeContexts, coveringRule, currentDangers, lifetimeEnded, lifetimeStart, uncoveredDangers } from '../src/danger-contexts.mjs';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { ReflexBook, normalizeReflexEntries } from '../src/reflexes.mjs';

const OVERWORLD = 'minecraft:overworld', NETHER = 'minecraft:the_nether', END = 'minecraft:the_end';
const view = ({ dimension = OVERWORLD, dayTime = 1_000, skyOpen = true, y = 70, health = 20, threats = [], entities = [], blocks = [], dead = false, structures } = {}) => ({
	world: { dimension, dayTime, gameTime: dayTime },
	player: { x: 0, y, z: 0, health, maxHealth: 20, skyOpen, dead, threats },
	entities, blocks, ...(structures === undefined ? {} : { sighted: { structures } }),
});
const rule = (id, when, type = 'sprint_away') => normalizeReflexEntries([{ id, when, do: { type } }])[0];

test('contexts hold from what the player sees: dusk sky, lava in view, the dimension, a fortress, low health near hostiles', () => {
	assert.deepEqual([...activeContexts(view({ dayTime: 13_000 }))], ['night']);
	assert.deepEqual([...activeContexts(view({ dayTime: 13_000, skyOpen: false, y: 20 }))], [], 'underground at night is not the surface');
	assert.deepEqual([...activeContexts(view({ dayTime: 6_000 }))], []);
	assert.deepEqual([...activeContexts(view({ blocks: [{ blockId: 'minecraft:lava', distance: 5 }] }))], ['lava']);
	assert.deepEqual([...activeContexts(view({ blocks: [{ blockId: 'minecraft:lava', distance: 20 }] }))], []);
	assert.deepEqual([...activeContexts(view({ blocks: [{ blockId: 'minecraft:lava', x: 3, y: 69, z: 2 }] }))], ['lava'], 'an adapted row without distance');
	assert.deepEqual([...activeContexts({ ...view(), player: { ...view().player, heardLava: { distance: 6 } } })], ['lava'], 'heard lava');
	assert.deepEqual([...activeContexts(view({ dimension: NETHER, entities: [{ type: 'minecraft:blaze', distance: 18, hostile: true }] }))], ['nether', 'fortress']);
	assert.deepEqual([...activeContexts(view({ dimension: NETHER, structures: [{ structure: 'nether fortress', distance: 30 }] }))], ['nether', 'fortress']);
	assert.deepEqual([...activeContexts(view({ dimension: END }))], ['end']);
	assert.deepEqual([...activeContexts(view({ health: 6, threats: [{ type: 'minecraft:zombie', distance: 4 }] }))], ['low_health']);
	assert.deepEqual([...activeContexts(view({ health: 6 }))], [], 'low health alone is no hostile context');
});

test('a rule covers a danger when its condition senses it; a mob filter must name a mob of that danger', () => {
	const melee = { kind: 'melee', mobs: ['zombie'] }, creeper = { kind: 'creeper', mobs: ['creeper'] };
	assert.equal(coveringRule(melee, [rule('near', { type: 'hostile_near', within: 4 }, 'attack')]), 'near');
	assert.equal(coveringRule(melee, [rule('near', { type: 'hostile_near', within: 4, mobs: ['skeleton'] }, 'attack')]), null);
	assert.equal(coveringRule(creeper, [rule('near', { type: 'hostile_near', within: 4 }, 'attack')]), null, 'an unfiltered hostile rule is not a creeper rule');
	assert.equal(coveringRule(creeper, [rule('fuse', { type: 'creeper_fusing', within: 5 })]), 'fuse');
	assert.equal(coveringRule(creeper, [rule('boom', { type: 'hostile_near', within: 6, mobs: ['creeper'] })]), 'boom');
	assert.equal(coveringRule({ kind: 'lava', mobs: [] }, [{ ...rule('lava', { type: 'in_lava' }, 'leave_lava'), state: 'disabled' }]), null, 'a disabled rule covers nothing');
	assert.equal(coveringRule({ kind: 'fireballs', mobs: ['ghast'] }, [rule('arrows', { type: 'incoming_projectile', projectiles: ['arrow'] }, 'shield')]), null);
	const night = view({ dayTime: 14_000, threats: [{ type: 'minecraft:creeper', distance: 9 }] });
	assert.deepEqual(currentDangers(night).map((row) => row.kind).sort(), ['creeper', 'melee', 'ranged']);
	assert.deepEqual(uncoveredDangers(night, [rule('fuse', { type: 'creeper_fusing', within: 5 })]), ['melee hits (spider, zombie)', 'arrows and shots (skeleton)']);
});

test('each context is entered once per visit, a respawn after a death, and an entry stays owed until delivered', () => {
	const tracker = new ContextEntryTracker();
	assert.deepEqual(tracker.observe(view({ dayTime: 6_000 }), 0), []);
	assert.deepEqual(tracker.observe(view({ dayTime: 12_100 }), 1_000), ['night']);
	assert.deepEqual(tracker.observe(view({ dayTime: 12_200, skyOpen: false, y: 50 }), 2_000), [], 'under a tree');
	assert.deepEqual(tracker.observe(view({ dayTime: 12_300 }), 3_000), [], 'the same night again');
	const built = tracker.line(view({ dayTime: 12_300 }), [rule('fuse', { type: 'creeper_fusing', within: 5 })]);
	assert.deepEqual(built.value, [{ entered: 'night on the surface', lasts: 'night', dangers: {
		'melee hits (spider, zombie)': 'no rule: target_in_reach|hostile_near|attacked_from_behind -> attack|step_back|shield|take_cover|sprint_away',
		'creeper blast': 'rule fuse',
		'arrows and shots (skeleton)': 'no rule: incoming_projectile|exposed -> shield|take_cover' } }]);
	tracker.settle(built.token, false);
	assert.equal(tracker.owed(), true, 'a failed delivery keeps it owed');
	tracker.settle(tracker.line(view({ dayTime: 12_300 }), []).token, true);
	assert.equal(tracker.owed(), false);
	assert.deepEqual(tracker.observe(view({ dayTime: 12_400, dead: true }), 4_000), []);
	assert.deepEqual(tracker.observe(view({ dayTime: 12_500 }), 5_000), ['respawn']);
	const lava = [{ blockId: 'minecraft:lava', distance: 3 }];
	assert.deepEqual(tracker.observe(view({ dayTime: 1_000, blocks: lava }), 10_000), ['lava']);
	tracker.observe(view({ dayTime: 1_000 }), 20_000);
	assert.deepEqual(tracker.observe(view({ dayTime: 1_000, blocks: lava }), 60_000), [], 'lava flickering in and out of view is one visit');
	tracker.observe(view({ dayTime: 1_000 }), 70_000);
	assert.deepEqual(tracker.observe(view({ dayTime: 1_000, blocks: lava }), 400_000), ['lava']);
});

test('a rule can last until dawn, the dimension stay or the lava visit; the book ends it there and reports why', () => {
	let now = 0;
	const book = new ReflexBook({ now: () => now, defaults: [] });
	book.observeContext('a', view({ dayTime: 13_000 }));
	book.apply('a', normalizeReflexEntries([
		{ id: 'zombies', when: { type: 'hostile_near', within: 4 }, do: { type: 'attack' }, lasts: 'night' },
		{ id: 'fuse', when: { type: 'creeper_fusing', within: 5 }, do: { type: 'sprint_away' } },
	]));
	assert.throws(() => normalizeReflexEntries([{ id: 'x', when: { type: 'night' }, do: { type: 'stop' }, lasts: 'forever' }]), /lasts must be one of night, dimension, lava/);
	const sent = book.payload('a').rules;
	assert.equal(sent[0].ttlMs, 3_600_000, 'the mod gets the longest ttl for a scoped rule');
	assert.equal('lasts' in sent[0], false, 'the mod never sees lasts');
	assert.equal(sent[1].ttlMs, undefined);
	assert.equal(book.observeContext('a', view({ dayTime: 20_000 })), false);
	assert.equal(book.observeContext('a', view({ dayTime: 24_100 })), true, 'dawn');
	book.observe('a', { revision: 2, rules: [{ id: 'fuse', kind: 'trigger', state: 'armed', fired: 0, expiresInS: 40 }], events: [] });
	assert.equal(book.takeReport('a').split('; rules:')[0], 'armed fuse(expires in 40 s); expired: zombies (dawn)');
	const nether = lifetimeStart('dimension', view({ dimension: NETHER }), 0);
	assert.equal(lifetimeEnded(nether, view({ dimension: NETHER }), 1), null);
	assert.equal(lifetimeEnded(nether, view({ dimension: OVERWORLD }), 2), 'left the_nether');
	const lava = lifetimeStart('lava', view({ blocks: [{ blockId: 'minecraft:lava', distance: 2 }] }), 0);
	assert.equal(lifetimeEnded(lava, view(), 30_000), null);
	assert.equal(lifetimeEnded(lava, view(), 61_000), 'away from lava');
});

test('a context wake leads with the entry and lists dangers; a danger wake names the dangers no rule senses', () => {
	const record = { agentId: 'a', currentGoal: 'Beat the game.', goalRevision: 1 };
	const observation = { ...view({ dayTime: 14_000 }), inventory: { items: [] }, items: [] };
	const contexts = [{ entered: 'night on the surface', lasts: 'night', dangers: { 'creeper blast': 'rule fuse' } }];
	const entry = buildNativeEventInput(record, { event: 'observation', trigger: 'context_entry', observation, contexts, uncovered: ['melee hits (spider, zombie)'] });
	const [line, json] = [entry.slice(0, entry.indexOf('\n')), JSON.parse(entry.slice(entry.indexOf('\n') + 1))];
	assert.match(line, /^entered night on the surface\. contexts lists each danger there/);
	assert.deepEqual(json.contexts, contexts);
	assert.equal(json.noRuleFor, undefined, 'not a danger wake');
	const danger = JSON.parse(buildNativeEventInput(record, { event: 'observation', trigger: 'damage', observation, uncovered: ['melee hits (spider, zombie)'] }).split('\n')[1]);
	assert.deepEqual(danger.noRuleFor, ['melee hits (spider, zombie)']);
});

test('an in_lava rule leaves the flow before contact uncovered; lava_flowing covers it, at a pool and in the Nether', () => {
	// d24 q-km92y2: Sol armed in_lava alone at a pool and died to a flow player.lavaFlow showed 3 s before contact.
	const pool = view({ blocks: [{ blockId: 'minecraft:lava', distance: 3 }] });
	const inLava = rule('escape', { type: 'in_lava' }, 'leave_lava');
	assert.deepEqual(uncoveredDangers(pool, [inLava]), ['lava flow before contact', 'burning']);
	assert.deepEqual(uncoveredDangers(pool, [inLava, rule('flow', { type: 'lava_flowing', withinS: 3 }, 'leave_lava')]), ['burning']);
	assert.ok(currentDangers(view({ dimension: NETHER })).some((row) => row.kind === 'flow'));
	const tracker = new ContextEntryTracker();
	tracker.observe(view(), 0);
	tracker.observe(pool, 1_000);
	assert.deepEqual(tracker.line(pool, [inLava]).value[0].dangers['lava flow before contact'], 'no rule: lava_flowing -> leave_lava|place_block');
});
