import { isDeepStrictEqual } from 'node:util';

// A dead body has no live state: everything a player knows about it is where it died and that it is dead.
const DEAD_PLAYER_FIELDS = ['dead', 'health', 'maxHealth', 'x', 'y', 'z', 'yaw', 'pitch', 'gameMode'];
// What the adapter fills in when the server sent no survival section (full health, nothing to report).
const SURVIVAL_UNOBSERVED = { canHealNow: false, bestFood: null, healOpportunity: false, lowHealthNoFood: false };

// safe, canHealNow and healOpportunity are verdicts computed from facts the wake already shows (health, burning,
// lava, threats, carried food); a player sees those facts, not a label, and a stale label can contradict them.
const VERDICT_LABELS = ['safe', 'canHealNow', 'healOpportunity'];

/** Wake healing facts without the verdict labels; scripts and observe keep them. */
export function presentEventHealing(healing) {
 if (healing === null || typeof healing !== 'object') return healing;
 const result = { ...healing };
 for (const field of VERDICT_LABELS) delete result[field];
 return result;
}

// Wake presentation only. Runtime observations and inspect retain every original fact.
export function presentEventObservation(observation, { inventoryLimit = 32 } = {}) {
 const dead = observation.player?.dead === true || observation.continuity?.phase === 'dead';
 const player = dead
  // The last live sample's armour, hunger, burning, food in hand and threats are not facts about a corpse.
  ? Object.fromEntries(DEAD_PLAYER_FIELDS.filter(field => Object.hasOwn(observation.player ?? {}, field)).map(field => [field, observation.player[field]]))
  : { ...observation.player };
 if (dead) {
  player.dead = true;
  if (Object.hasOwn(player, 'health')) player.health = 0;
 }
 for (const [alias, canonical] of [['hunger', 'foodLevel'], ['fire', 'onFire']]) {
  if (Object.hasOwn(player, canonical) && isDeepStrictEqual(player[alias], player[canonical])) delete player[alias];
 }
 // Without a server survival section these are defaults, not observations; "bestFood: null" beside carried food misleads.
 if (!Object.hasOwn(player, 'safe') && Object.entries(SURVIVAL_UNOBSERVED).every(([field, value]) => isDeepStrictEqual(player[field], value))) {
  for (const field of Object.keys(SURVIVAL_UNOBSERVED)) delete player[field];
 }
 for (const field of VERDICT_LABELS) delete player[field];
 if (player.heardLava && player.heard?.some(row => isDeepStrictEqual(row, player.heardLava))) delete player.heardLava;
 if (player.highestRiskThreat && isDeepStrictEqual(player.highestRiskThreat, player.threats?.[0])) delete player.highestRiskThreat;
 if (Array.isArray(player.threats)) player.threats = player.threats.map(row => {
  const copy = { ...row };
  if (copy.stableId === copy.uuid) delete copy.stableId;
  return copy;
 });
 let interaction = observation.interaction;
 if (interaction?.input) {
  const input = { ...interaction.input };
  for (const field of ['yaw', 'pitch']) if (Object.hasOwn(player, field) && input[field] === player[field]) delete input[field];
  interaction = { ...interaction, input };
 }
 const result = { ...observation, player, ...(interaction === undefined ? {} : { interaction }) };
 if (dead) {
  // Omit the historical inventory only when recovery supplies all of its stack counts.
  // Sounds the body heard before dying are stale too.
  const lost = observation.recovery?.lastLostInventory;
  const counts = rows => {
   const totals = new Map();
   for (const row of rows) totals.set(row.itemId, (totals.get(row.itemId) ?? 0) + row.count);
   return [...totals].sort(([a], [b]) => a.localeCompare(b));
  };
  if (Array.isArray(lost) && Array.isArray(result.lastLiveInventory?.items)
   && isDeepStrictEqual(counts(lost), counts(result.lastLiveInventory.items))) delete result.lastLiveInventory;
  if (Array.isArray(result.perception?.events)) result.perception = { ...result.perception, events: result.perception.events.filter(row => row?.type !== 'sound') };
 }
 const recovery = observation.recovery;
 const ids = [...new Set((observation.inventory?.items ?? []).map(row => row.itemId))];
 // Inventory-only recovery repeats held stacks. Keep every historical, placed, dropped or unfamiliar fact.
 const restatedRow = row => row?.kind === 'inventory' && row.remembered !== true
  && Object.keys(row).every(key => ['kind', 'itemId', 'count'].includes(key))
  && (observation.inventory?.items ?? []).filter(item => item.itemId === row.itemId).reduce((n, item) => n + item.count, 0) === row.count;
 const currentInventory = observation.inventory !== undefined && (observation.inventory.items?.length ?? 0) <= inventoryLimit && !observation.continuity?.rememberedSections?.includes('inventory');
 const haveMatches = recovery && isDeepStrictEqual(recovery.alreadyHave, ids)
  && (recovery.doNotRedo === undefined || Array.isArray(recovery.doNotRedo) && recovery.doNotRedo.length === 0);
 const rowsMatch = Array.isArray(recovery?.alreadyHaveFacts) && recovery.alreadyHaveFacts.every(restatedRow);
 if (currentInventory && haveMatches && rowsMatch
  && Object.keys(recovery).every(key => ['alreadyHave', 'alreadyHaveFacts', 'doNotRedo', 'facts', 'lastDeath', 'lastLostInventory'].includes(key))) {
  const copy = { ...recovery };
  delete copy.alreadyHave;
  delete copy.alreadyHaveFacts;
  delete copy.doNotRedo;
  if (typeof copy.facts === 'string') {
   const inventoryFact = ids.length === 0 ? 'Current inventory is empty.' : `Current inventory: ${ids.join(', ')}.`;
   const haveFact = `Currently evidenced: ${ids.join(', ')}.`;
   copy.facts = copy.facts.replace(inventoryFact, '').replace(haveFact, '').replace(/ {2,}/g, ' ').trim();
   if (copy.facts.length === 0) delete copy.facts;
  }
  if (Object.keys(copy).length === 0) delete result.recovery;
  else result.recovery = copy;
 } else if (currentInventory && !observation.death && recovery && Object.keys(recovery).every(key => ['alreadyHave', 'facts'].includes(key))
  && isDeepStrictEqual(recovery.alreadyHave, ids) && recovery.facts === `Currently evidenced: ${ids.join(', ')}.`) delete result.recovery;
 return result;
}
