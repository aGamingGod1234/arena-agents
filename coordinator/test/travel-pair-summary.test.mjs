import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCourses, compareCoursePair } from '../../scripts/quality/summarize-travel-pairs.mjs';
const row = result => ({ result: { id: 'course', deaths: 0, fireSamples: 0, lavaSamples: 0, ...result } });
test('weights wall and game pace by their durations and subtracts retreats', () => {
 const summary = summarizeCourses([row({ progressBlocks: 20, wallSeconds: 60, gameTicks: 600 }), row({ progressBlocks: -10, wallSeconds: 60, gameTicks: 600 })]);
 assert.equal(summary.pace, 5); assert.equal(summary.gamePace, 10); assert.equal(summary.observedTPS, 10);
});
test('excludes initially-visible course from pace while retaining its safety evidence', () => {
 const summary = summarizeCourses([row({ progressBlocks: 20, wallSeconds: 60, gameTicks: 600 }), row({ id: 'gold2-seen', progressBlocks: 1000, wallSeconds: 1, gameTicks: 20, deaths: 1, lavaSamples: 1 })]);
 assert.equal(summary.pace, 20); assert.equal(summary.gamePace, 40); assert.equal(summary.deaths, 1); assert.equal(summary.lava, 1);
 assert.equal(summarizeCourses([row({ progressBlocks: 20, wallSeconds: 60, gameTicks: null })]).gamePace, null);
});
test('identifies a wall comparison that reverses after observed TPS adjustment', () => {
 const base = summarizeCourses([row({ progressBlocks: 100, wallSeconds: 60, gameTicks: 1200 })]);
 const candidate = summarizeCourses([row({ progressBlocks: 120, wallSeconds: 120, gameTicks: 1200 })]);
 const comparison = compareCoursePair(base, candidate);
 assert.equal(comparison.wallRatio, 0.6); assert.equal(comparison.gameRatio, 1.2); assert.equal(comparison.orderFlipsAfterTPSAdjustment, true);
});

test('retains action-reported damage missed between samples without counting the same hit twice', () => {
 const stops = [{ message: 'Took 1.0 damage (hotFloor); health 19.0' }, { message: 'Took 1.0 damage (hotFloor); health 19.0' }];
 const summary = summarizeCourses([row({ damage: 0, stops }), row({ damage: 3, actionDamage: 2, damageLowerBound: 3 })]);
 assert.equal(summary.damage, 5); assert.equal(summary.sampledDamage, 3);
});
