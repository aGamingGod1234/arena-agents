import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Windows cannot rename over a file while another handle has it open: a read or
// a second replacing rename of the same path makes the rename fail with EPERM.
// Every read and replace of one path in this process therefore takes its turn.
//
// Contract: a task must not take a turn on the same path from inside its own
// turn, awaited or not. The inner turn would queue behind the task that waits
// for it, so it is rejected with FILE_TURN_REENTRY instead. Do the whole
// operation inside one turn. Turns on other paths may nest freely.
const turns = new Map();
const held = new AsyncLocalStorage();

// \\?\C:\dir, \\.\C:\dir and \\?\UNC\server\share name the same files as C:\dir
// and \\server\share, and Node resolves the prefixed forms as their own roots.
const WINDOWS_PREFIX = /^\\\\[?.]\\(UNC\\)?/i;

export function fileTurnKey(file) {
	if (process.platform !== 'win32') return path.resolve(file);
	return path.resolve(file.replace(WINDOWS_PREFIX, (_, unc) => (unc ? '\\\\' : ''))).toLowerCase();
}

export function fileTurn(file, task) {
	const key = fileTurnKey(file), holding = held.getStore();
	if (holding?.has(key)) return Promise.reject(Object.assign(new Error(`A turn for ${file} is already held by the calling task; take one turn for the whole operation`), { code: 'FILE_TURN_REENTRY' }));
	const run = (turns.get(key) ?? Promise.resolve()).then(() => held.run(new Set(holding).add(key), task));
	const settled = run.then(() => {}, () => {});
	turns.set(key, settled);
	void settled.then(() => { if (turns.get(key) === settled) turns.delete(key); });
	return run;
}

export function readFileInTurn(file, encoding) {
	return fileTurn(file, () => readFile(file, encoding));
}

/** Publishes content through a unique temporary file so readers see the old or the new file whole. */
export function replaceFile(file, content, options) {
	return fileTurn(file, async () => {
		const temporary = `${file}.${randomUUID()}.tmp`;
		try { await writeFile(temporary, content, options); await rename(temporary, file); }
		catch (error) { await unlink(temporary).catch(() => {}); throw error; }
	});
}
