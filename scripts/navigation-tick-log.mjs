/**
 * Parses NAV_TICK diagnostics from a server log. Every emitted row counts, including preparation/search ticks the
 * controller logs with traversal=- (no active plan); dropping them undercounted navigation CPU and coverage.
 */
export function parseNavigationTicks(text) {
	const rows = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.includes('NAV_TICK ')) continue;
		const match = /NAV_TICK tick=(\d+) elapsedMs=(\d+) durationUs=(\d+) pos=([^, ]+),([^, ]+),([^ ]+) dpos=([^ ]+) vel=([^ ]+) ground=(true|false) hcoll=(true|false).*?traversal=([A-Z_]+|-)/.exec(line);
		if (!match) continue;
		rows.push({ tick: Number(match[1]), elapsedMs: Number(match[2]), durationUs: Number(match[3]),
			position: [Number(match[4]), Number(match[5]), Number(match[6])], ground: match[9] === 'true',
			horizontalCollision: match[10] === 'true', traversal: match[11] === '-' ? null : match[11] });
	}
	return rows;
}
