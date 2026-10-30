const flight = event => event?.type === 'eye_of_ender_flight';
const xyz = point => [point.x, point.y, point.z].map(Math.round).join(',');
const dropPosition = (from, point) => {
	const absolute = `@${xyz(point)}`;
	// Both forms recover the same rounded block, even after the player moves.
	const relative = `+${['x', 'y', 'z'].map(axis => Math.round(point[axis]) - Math.round(from[axis])).join(',')}`;
	return relative.length < absolute.length ? relative : absolute;
};

// Only flight evidence changes presentation. Every other section stays reusable across tools and wakes.
export function presentEyeFlightWake(observation) {
	if (!Array.isArray(observation.perception?.events) || !observation.perception.events.some(flight)) return observation;
	const result = { ...observation, perception: { ...observation.perception, events: observation.perception.events.filter(event => !flight(event)) } };
	for (const event of observation.perception.events.filter(flight)) {
		const { flightId, sequence, from, to, droppedAt, yaw, vertical, outcome, dimension } = event;
		const id = flightId ?? sequence ?? 'unknown';
		// A flight lost from view has an unknown length; its seen part is not how far the eye went.
		const distance = event.lostFromView === true ? undefined : event.flewBlocks ?? (to ? Math.hypot(to.x - from.x, to.z - from.z) : undefined);
		const motion = vertical === 'rose' ? 'up' : vertical === 'sank' ? 'down' : vertical;
		const height = Number.isFinite(to?.y) ? Math.round(to.y) : null;
		result[`eye${id}`] = [
			dimension === undefined || dimension === observation.world?.dimension ? null : dimension,
			`${xyz(from)}`, yaw === undefined && distance === undefined ? null : `${yaw === undefined ? '?' : Math.round(yaw)}/${distance === undefined ? '?' : Math.round(distance)}`,
			height === null ? motion : motion ? `${motion}@${height}` : `y${height}`,
			droppedAt === undefined ? (outcome === 'shattered' ? 'broke' : outcome) : `drop${dropPosition(from, droppedAt)}`,
			event.cross === undefined ? null : `cross@${Math.round(event.cross.x)},${Math.round(event.cross.z)} ${event.crossBlocks} from throw`,
		].filter(value => value != null).join(' ');
	}
	return result;
}
