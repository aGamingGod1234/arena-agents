#!/usr/bin/env node
import path from 'node:path';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Persist before signalling: the process tree may never reach its shutdown handler. */
export async function recordOperatorStop(directory, reason, { at = Date.now(), signal = null, requestedBy = 'operator' } = {}) {
	if (!String(reason ?? '').trim()) throw new Error('An operator stop reason is required');
	await mkdir(directory, { recursive: true });
	const record = { schemaVersion: 1, kind: 'operator-stop', status: 'stopped', at, stoppedAt: new Date(at).toISOString(), reason, signal, requestedBy,
		censoring: { remainder: 'unobserved', censored: true, preservesObservedFailures: true } };
	const file = path.join(directory, 'operator-stop.json'), temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify(record, null, 2) + '\n');
	await rename(temporary, file);
	return record;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await recordOperatorStop(process.argv[2], process.argv.slice(3).join(' '));
}
