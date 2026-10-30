/** The model gets flight facts once; programs retain every observed rendering field. */
export function compactProjectileObservation(observation) {
	const incoming = observation?.player?.incomingProjectiles ?? observation?.incomingProjectiles;
	if (!Array.isArray(incoming) || incoming.length === 0) return observation;
	const ids = new Set(incoming.map((row) => row.uuid));
	const rows = incoming.map(({ new: fresh, imminentNew, ...row }) => row);
	const entities = Array.isArray(observation.entities) ? observation.entities.map((entity) => {
		if (!ids.has(entity.stableId ?? entity.uuid)) return entity;
		const { name, distance, yaw, pitch, pose, bounds, pickable, perceivedBy, ...flight } = entity;
		return flight;
	}) : observation.entities;
	return { ...observation, ...(entities === undefined ? {} : { entities }),
		...(observation.player?.incomingProjectiles === undefined ? { incomingProjectiles: rows } : { player: { ...observation.player, incomingProjectiles: rows } }) };
}

export function compactProjectileToolResult(value) {
	if (value === null || typeof value !== 'object') return value;
	if (value.observation !== undefined) {
		const observation = compactProjectileObservation(value.observation);
		return observation === value.observation ? value : { ...value, observation };
	}
	return compactProjectileObservation(value);
}
