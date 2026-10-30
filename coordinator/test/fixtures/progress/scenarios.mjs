export const record = { agentId: 'progress-fixture', currentGoal: 'beat the game', goalRevision: 1 };
const step = (id, label, check, dependsOn = []) => ({ id, label, check, dependsOn, kind: 'milestone', status: 'pending', evidence: null, detail: '' });
export const plan = { steps: [
 step('gear', 'Iron tools and armor', 'worn:iron+4 & tool:pickaxe:iron+'),
 step('nether', 'Enter Nether', 'visited:minecraft:the_nether', ['gear']),
 step('rods', 'Fortress blaze rods', 'has:minecraft:blaze_rod*7', ['nether']),
 step('pearls', 'Ender pearls', 'has:minecraft:ender_pearl*12', ['nether']),
 step('eyes', 'Eyes of ender', 'has:minecraft:ender_eye*12', ['rods', 'pearls']),
 step('stronghold', 'Locate stronghold', 'seen:minecraft:stronghold', ['eyes']),
 step('end', 'Enter the End', 'in:minecraft:the_end', ['stronghold']),
 step('crystals', 'Destroy End crystals', null, ['end']),
 step('dragon', 'Defeat dragon', 'killed:minecraft:ender_dragon', ['crystals']),
] };
export const armor = (tier, worn = true) => ['helmet', 'chestplate', 'leggings', 'boots'].map((piece, i) => ({ itemId: `minecraft:${tier}_${piece}`, count: 1, slot: worn ? ['head', 'chest', 'legs', 'feet'][i] : i }));
export const item = (id, count = 1) => ({ itemId: `minecraft:${id}`, count, slot: 10 });
const obs = (dimension, items, player = {}, world = {}) => ({ ready: true, observedAtEpochMs: 1000, freshness: { fresh: true }, player: { dead: false, health: 20, foodLevel: 20, x: 0, y: 64, z: 0, ...player }, world: { worldId: 'progress-world', dimension: `minecraft:${dimension}`, gameTime: 100, dayTime: 100, difficulty: 'normal', ...world }, inventory: { items }, blocks: [], items: [], entities: [], sighted: { structures: [] } });
export const scenarios = [
 { name: 'nether-diamond-carried', observation: obs('the_nether', [...armor('diamond', false), item('cooked_beef', 64)]) },
 { name: 'cave-stone', observation: obs('overworld', [item('stone_pickaxe')], { y: -20 }) },
 { name: 'night-zombies', observation: { ...obs('overworld', [], {}, { dayTime: 13000 }), entities: [1,2,3].map(i => ({ id: `zombie-${i}`, type: 'minecraft:zombie', hostile: true, distance: 6+i })) } },
 { name: 'midgame-eyes', observation: obs('overworld', [...armor('iron'), item('iron_pickaxe'), item('ender_eye', 12)]) },
 { name: 'end-diamond-bow', observation: obs('the_end', [...armor('diamond'), item('diamond_pickaxe'), item('bow')]) },
];
