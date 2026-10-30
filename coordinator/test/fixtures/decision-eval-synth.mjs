// Synthetic decision-eval case in the recorded protocol observation shape, shared by the decision-eval tests.
export const CREEPER = '11111111-1111-4111-8111-111111111111';
export const ZOMBIE = '22222222-2222-4222-8222-222222222222';
export const PIG = '33333333-3333-4333-8333-333333333333';

export function synthCase(overrides = {}) {
	return {
		id: 'creeper-near-01', family: 'creeper-near', causeClass: 'threat-close', split: 'train',
		state: {
			observation: { envelope: { type: 'observation', payload: {
				position: { x: 0, y: 64, z: 0 },
				player: { health: 14, maxHealth: 20, foodLevel: 9, saturation: 0, air: 300, onFire: false, inLava: false },
				inventory: { selectedItem: 'minecraft:stone_sword', selectedSlot: 0, items: [
					{ itemId: 'minecraft:stone_sword', count: 1, slot: 'mainhand', tags: ['#minecraft:swords'] },
					{ itemId: 'minecraft:bread', count: 3, slot: 'hotbar.1', tags: ['#c:foods', '#c:foods/bread'] },
					{ itemId: 'minecraft:cobblestone', count: 20, slot: 'hotbar.2', tags: ['#minecraft:stone_crafting_materials'] },
				] },
				entities: [
					{ uuid: CREEPER, type: 'minecraft:creeper', hostile: true, distance: 3, position: { x: 3, y: 64, z: 0 } },
					{ uuid: ZOMBIE, type: 'minecraft:zombie', hostile: true, distance: 11.2, position: { x: -10, y: 64, z: 5 } },
					{ uuid: PIG, type: 'minecraft:pig', hostile: false, distance: 20, position: { x: 0, y: 64, z: 20 } },
				],
			} } },
			agent: { goal: 'collect 10 oak logs' },
		},
		expect: {
			good: [{ normalized: { actionType: 'flee_from' }, targetsEntity: 'minecraft:creeper' }, { awayFrom: { position: 'threat', minDistance: 4 } }],
			bad: [{ targetsEntity: 'minecraft:creeper', normalized: { actionType: { in: ['attack', 'fight_target'] } } }],
			threshold: 0.67,
		},
		...overrides,
	};
}
