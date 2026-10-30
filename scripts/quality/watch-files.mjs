// Watcher files (arena-watch/<agentId>-episodes.jsonl and -forecasts.jsonl, schema v1) written by the mod into the
// Minecraft server run directory. The runner copies them into the run's artifact directory during and after play,
// because finished runs lose their server directory to pruning.
import { cp, readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const WATCH_DIR = 'arena-watch';

/** Copies <serverDir>/arena-watch (default <runDir>/server) into <dest>/arena-watch. Returns the number of files copied (0 when there are none). */
export async function collectWatchFiles(runDir, dest = runDir, serverDir = path.join(runDir, 'server')) {
	const source = path.join(serverDir, WATCH_DIR);
	let names;
	try { names = (await readdir(source)).filter(name => name.endsWith('.jsonl')); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
	const target = path.join(dest, WATCH_DIR);
	for (const name of names) await cp(path.join(source, name), path.join(target, name), { force: true });
	return names.length;
}

/** The arena-watch directories under the given paths: the dir itself, <dir>/arena-watch, <dir>/server/arena-watch (only when no copy exists), or deeper. */
export async function findWatchDirs(dir, depth = 6) {
	if (path.basename(dir) === WATCH_DIR) return [dir];
	const own = path.join(dir, WATCH_DIR), live = path.join(dir, 'server', WATCH_DIR);
	// The live server copy is newer while a run plays; once it is gone the artifact copy is the record.
	if (existsSync(own) || existsSync(live)) return [await newest(own, live)];
	if (depth <= 0) return [];
	const found = [];
	for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
		if (!entry.isDirectory() || ['server', 'provider-workspaces', 'node_modules', 'world'].includes(entry.name)) continue;
		found.push(...await findWatchDirs(path.join(dir, entry.name), depth - 1));
	}
	return found;
}

async function newest(own, live) {
	const time = async dir => { try { return Math.max(0, ...await Promise.all((await readdir(dir)).map(async name => (await stat(path.join(dir, name))).mtimeMs))); } catch { return -1; } };
	return await time(live) > await time(own) ? live : own;
}

/** Parses JSONL text, skipping blank and unreadable lines (a copy taken mid-write can end in half a line). */
export function parseWatchLines(text) {
	const rows = [];
	let dropped = 0;
	for (const line of String(text).split('\n')) {
		if (!line.trim()) continue;
		try { rows.push(JSON.parse(line)); } catch { dropped++; }
	}
	return { rows, dropped };
}

/** Episodes and forecasts of one arena-watch directory; the run is the directory that holds it. */
export async function readWatchDir(watchDir) {
	const episodes = [], forecasts = [];
	let dropped = 0;
	for (const name of (await readdir(watchDir).catch(() => [])).sort()) {
		if (!name.endsWith('.jsonl')) continue;
		const parsed = parseWatchLines(await readFile(path.join(watchDir, name), 'utf8'));
		dropped += parsed.dropped;
		for (const row of parsed.rows) {
			if (row.type === 'episode' || name.endsWith('-episodes.jsonl') && row.type === undefined) episodes.push(row);
			else if (row.type === 'forecast' || name.endsWith('-forecasts.jsonl') && row.type === undefined) forecasts.push(row);
		}
	}
	let run = path.dirname(watchDir);
	if (path.basename(run) === 'server') run = path.dirname(run);
	return { run, watchDir, episodes, forecasts, dropped };
}
