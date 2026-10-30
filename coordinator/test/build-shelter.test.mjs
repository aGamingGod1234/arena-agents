import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { combatFacts } from '../src/combat-facts.mjs';
import { minecraftControlReference } from '../src/minecraft-control-reference.mjs';

test('shelter is available through the production action boundary with a body timeout', () => {
 const args = { x: 83, y: 73, z: 91, opening: 'east', itemId: 'minecraft:cobblestone' };
 const call = normalizeMinecraftToolCall('act', { actionType: 'build_shelter', arguments: args });
 assert.equal(call.arguments.timeoutMs, 120000);
 for (const bad of [{opening:'up'}, {x:83.5}, {roof:'yes'}]) assert.throws(() => normalizeMinecraftToolCall('act', {actionType:'build_shelter', arguments:{...args,...bad}}));
 const reference = minecraftControlReference({topic:'action:build_shelter'}).reference;
 assert.match(reference,/one-high opening/);
 assert.match(reference,/pursue:false/);
});
test('blaze facts explain enclosure ownership and hold-ground fighting', () => {
 const facts = combatFacts({ready:true,player:{health:20},world:{dimension:'minecraft:the_nether'},inventory:{items:[]},entities:[{type:'minecraft:blaze'}]});
 assert.match(facts,/build_shelter/);
 assert.match(facts,/The model chooses whether and where/);
 assert.match(facts,/fight_target pursue:false/);
});
