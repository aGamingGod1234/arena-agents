const BOUNDS = ['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'];
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));
function rowSelector(indices) {
 const runs = [];
 for (let i = 0; i < indices.length; i++) {
  const start = indices[i];
  let end = start;
  while (indices[i + 1] === end + 1) end = indices[++i];
  runs.push(end === start ? String(start) : `${start}-${end}`);
 }
 return runs.join(',');
}
function packAppearanceRows(rows) {
 const indices = Object.keys(rows).map(Number);
 const allTrue = Object.values(rows).every(value => value === true);
 let packed = allTrue ? indices : { ...rows };
 if (allTrue) {
  const selector = rowSelector(indices);
  if (jsonBytes(selector) < jsonBytes(packed)) packed = selector;
 } else {
  const groups = new Map();
  for (const index of indices) {
   const key = JSON.stringify(rows[index]);
   if (!groups.has(key)) groups.set(key, [rows[index], []]);
   groups.get(key)[1].push(index);
  }
  const grouped = [...groups.values()].map(([value, members]) => [value, rowSelector(members)]);
  if (jsonBytes(grouped) < jsonBytes(packed)) packed = grouped;
 }
 return packed;
}

// Separate stable visual detail from geometry so an appearance change does not resend whole entity/block rows.
// Indices refer to the retained arrays after trimming. Provider tools and wakes share this layout for view reuse.
export function presentAppearanceWake(payload) {
	const observation = payload.observation;
	if (observation === null || typeof observation !== 'object') return payload;
	const result = { ...observation };
	// Effect countdowns can change every wake. Tuple cells retain every value
	// without repeating field names when the whole player section is replaced.
	if (Array.isArray(observation.player?.effects)) {
		const fields = ['effectId', 'amplifier', 'seconds'];
		result.player = { ...observation.player, effects: observation.player.effects.map(effect =>
			effect && !Array.isArray(effect) && Object.keys(effect).length === fields.length
			&& fields.every(field => Object.hasOwn(effect, field))
				? fields.map(field => effect[field]) : effect) };
	}
	for (const [section, field] of [['entities', 'entityAppearance'], ['blocks', 'blockAppearance']]) {
		if (!Array.isArray(observation[section])) continue;
		const appearances = Object.create(null);
		result[section] = observation[section].map((value, row) => {
			if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
			const { appearance, ...facts } = value;
			if (appearance && typeof appearance === 'object' && !Array.isArray(appearance)) {
				for (const [key, fact] of Object.entries(appearance).sort(([a], [b]) => a.localeCompare(b))) {
					(appearances[key] ??= Object.create(null))[row] = fact;
				}
			} else if (Object.hasOwn(value, 'appearance')) facts.appearance = appearance;
			if (section === 'entities') {
				if (facts.bounds && Object.keys(facts.bounds).length === BOUNDS.length && BOUNDS.every(key => Number.isFinite(facts.bounds[key]))) {
					facts.bounds = BOUNDS.map(key => facts.bounds[key]);
				}
				const defaultName = typeof facts.type === 'string' && facts.type.startsWith('minecraft:')
					? facts.type.slice(10).split('_').map(word => word[0]?.toUpperCase() + word.slice(1)).join(' ') : null;
				if (facts.name === defaultName) delete facts.name;
			}
			return facts;
		});
		if (Object.keys(appearances).length) result[field] = Object.fromEntries(
			Object.entries(appearances).sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => [key,
				packAppearanceRows(rows)]));
	}
	// Delivery cursors belong to the runtime's unread reservation, not the model's response.
	const conversation = payload.conversation;
	const wake = { ...payload, observation: result };
	if (Array.isArray(conversation?.entries)) {
		if (conversation.entries.length === 0 && conversation.omittedEntries === 0) delete wake.conversation;
		else wake.conversation = { entries: conversation.entries, ...(conversation.omittedEntries > 0 ? { omittedEntries: conversation.omittedEntries } : {}) };
	}
	return wake;
}
