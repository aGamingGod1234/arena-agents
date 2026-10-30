import { createReadStream } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

/** Bound allocation to one record, including when the capture exceeds V8's string limit. */
export async function readJsonl(file, accept, { notebook = false } = {}) {
	const input = createReadStream(file, { encoding: 'utf8' });
	const lines = createInterface({ input, crlfDelay: Infinity });
	let droppedLines = 0, rows = 0;
	try {
		for await (const line of lines) {
			if (!line.trim()) continue;
			let row;
			try { row = JSON.parse(notebook ? line.slice(line.indexOf(' ') + 1) : line); }
			catch { droppedLines++; continue; }
			await accept(row); rows++;
		}
	} finally { lines.close(); input.destroy(); }
	return { rows, droppedLines };
}

export async function rotatedJsonlFiles(file) {
	const base = path.basename(file);
	const entries = await readdir(path.dirname(file));
	return entries.filter(n => n === base || n.startsWith(base + '.') && /^\d+$/.test(n.slice(base.length + 1)))
		.sort((a, b) => Number(b.slice(base.length + 1) || 0) - Number(a.slice(base.length + 1) || 0))
		.map(n => path.join(path.dirname(file), n));
}

export async function writeJsonl(file, rows, { append = false } = {}) {
	const handle = await open(file, append ? 'a' : 'w');
	try { for (const row of rows) await handle.writeFile(JSON.stringify(row) + '\n'); }
	finally { await handle.close(); }
}
