import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyKnown, evaluatePlanCheck, parsePlanCheck } from '../src/plan-checks.mjs';
import { recoveryPreparation, respawnLead } from '../src/respawn-recovery.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
const dimension = 'minecraft:overworld';
const death = { x: 30, y: -54, z: 0, dimensionId: dimension, cause: 'Probe was slain by Zombie', diedAtEpochMs: 1000 };
const o = { ready: true, position: { x: 0, y: -54, z: 0 }, world: { dimension }, inventory: { items: [] } };
test('distance recovery checks produce monotonic progress and never count another dimension or a corpse', () => {
 const check = 'near:minecraft:overworld@30,-54,0*4';
 assert.equal(parsePlanCheck(check).terms[0].radius, 4);
 const read = sample => evaluatePlanCheck(check, sample, emptyKnown()).terms[0];
 assert.equal(read(o).metric, 30);
 assert.equal(read({ ...o, position: { x: 20,y:-54,z:0 } }).metric,10);
 assert.equal(read({ ...o, position: { x: 28,y:-54,z:0 } }).ok,true);
 assert.equal(read({ ...o, world: { dimension: 'minecraft:the_end' } }).ok,false);
 assert.equal(read({ ...o, player: { dead: true } }).ok,false);
 for(const invalid of ['near:minecraft:overworld@0,0,0*0','near:minecraft:overworld@0,9999,0*4']) assert.throws(()=>parsePlanCheck(invalid));
});
test('retrace arguments cross the native action contract and require a height', () => {
 const good = { x:30,y:-54,z:0,retrace:true,dimension };
 assert.equal(normalizeMinecraftToolCall('travelTo',good).actionType,'travel_to');
 assert.throws(()=>normalizeMinecraftToolCall('travelTo',{x:30,z:0,retrace:true}));
 assert.throws(()=>normalizeMinecraftToolCall('travelTo',{yaw:0,distance:30,retrace:true}));
 assert.throws(()=>normalizeMinecraftToolCall('travelTo',{x:30,y:-54,z:0,dimension}));
});
test('respawn facts keep unloaded drops after ten minutes, distinguish route gaps and surface resource evidence', () => {
 const recovery={lastDeath:death,lastLostInventory:[{itemId:'minecraft:iron_pickaxe',count:1}],dropTicking:{tickedSeconds:20,tickingNow:false,simulationDistance:6}};
 assert.match(respawnLead(recovery,{...o,observedAtEpochMs:1801000}),/Your drops wait/);
 assert.doesNotMatch(recoveryPreparation(death,o),/No connected walked route/);
 assert.match(recoveryPreparation(death,{...o,routeMemory:{connected:false}}),/No connected walked route/);
 assert.doesNotMatch(recoveryPreparation(death,{...o,routeMemory:{connected:false}}),/No ascent was walked/);
 const memory={connected:true,length:62,waypoints:18,hazards:['seen lava nearby'],seenResources:[{kind:'planks',blockId:'minecraft:oak_planks',x:4,y:-54,z:0,dimension}]};
 const facts=recoveryPreparation(death,{...o,routeMemory:memory});
 assert.match(facts,/62 blocks/);assert.match(facts,/seen lava nearby/);assert.match(facts,/planks oak_planks @4,-54,0/);
 assert.match(facts,/bare-hand stone drops no cobblestone/);
});
test('Nether and End recovery expose the missing equipment without claiming a lost helmet is worn', () => {
 assert.match(recoveryPreparation({...death,dimensionId:'minecraft:the_nether'},o),/no gold armour worn/);
 assert.doesNotMatch(recoveryPreparation({...death,dimensionId:'minecraft:the_nether'},{...o,inventory:{items:[{itemId:'minecraft:golden_helmet',count:1,slot:'head'}]}}),/no gold armour worn/);
 const end=recoveryPreparation({...death,dimensionId:'minecraft:the_end'},o);
 assert.match(end,/blocks or a pearl/);assert.match(end,/bookshelves drop books, not wood/);
});
