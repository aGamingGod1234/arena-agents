import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const MAX_SUMMARY_REPORT_BYTES = 262_144;
const encode = value => JSON.stringify(value);
const bytes = value => Buffer.byteLength(value, 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const structuralArrays = new Set(['runs', 'scenarios', 'firstAttemptRuns', 'history', 'sequence']);
const isReference = value => value?.reportArtifact?.version === 1;
/** Strings longer than this are detail text (logs, diagnostics, NBT); shorter ones are scalar fields such as ids. */
export const SHORT_STRING_BYTES = 256;
const isObject = value => value !== null && typeof value === 'object' && !isReference(value);
const isRecord = value => isObject(value) && !Array.isArray(value);
// Classified by the string's own UTF-8 bytes; quotes and JSON escaping count only toward serialized sizes.
const isLongString = value => typeof value === 'string' && bytes(value) > SHORT_STRING_BYTES;
export const isScalar = value => !isObject(value) && !isReference(value) && !isLongString(value);
const structured = new WeakMap(), scalarFree = new WeakMap();
const holdsStructure = (value, key) => {
	if (!isObject(value)) return false;
	if (Array.isArray(value)) return structuralArrays.has(key);
	if (!structured.has(value)) structured.set(value, Object.entries(value).some(([name, child]) => holdsStructure(child, name)));
	return structured.get(value);
};
// Scalars reachable through records stay inline; a record holding none of them is itself a movable detail.
const holdsNoScalars = value => {
	if (!scalarFree.has(value)) scalarFree.set(value, Object.entries(value).every(([key, child]) => isReference(child) || isLongString(child) || Array.isArray(child) && !structuralArrays.has(key) || isRecord(child) && holdsNoScalars(child)));
	return scalarFree.get(value);
};
const isDetail = (value, key) => isLongString(value) || Array.isArray(value) && !structuralArrays.has(key) || isRecord(value) && !holdsStructure(value, key) && holdsNoScalars(value);

/** Keep summaries small without discarding measurements. References are relative to the summary. */
export async function writeArtifactReport(file, value, { write = writeFile, makeDirectory = mkdir } = {}) {
	const directory = path.dirname(path.resolve(file));
	await makeDirectory(directory, { recursive: true });
	// Content addressing makes repeated details (identical runs) one file. Artifact writes are batched in parallel because
	// small details can mean hundreds of files; every artifact is on disk before the summary that references it.
	const written = new Set();
	let pending = [], artifactDirectory = null;
	const flush = async () => {
		while (pending.length) {
			const batch = pending.splice(0, 32);
			artifactDirectory ??= makeDirectory(path.join(directory, 'report-artifacts'), { recursive: true });
			await artifactDirectory;
			await Promise.all(batch.map(([target, text]) => write(target, text, { encoding: 'utf8' })));
		}
	};
	// Synchronous: queues the artifact and returns its reference; flush() writes the queue.
	const externalize = detail => {
		const text = encode(detail), sha256 = hash(text);
		const relative = `report-artifacts/${sha256}.json`;
		if (!written.has(relative)) {
			written.add(relative);
			pending.push([path.join(directory, relative), text]);
		}
		return { reportArtifact: { version: 1, path: relative, sha256, bytes: bytes(text), ...(Array.isArray(detail) ? { count: detail.length } : {}) } };
	};
	const compact = (detail, key = '') => {
		if (!detail || typeof detail !== 'object' || isReference(detail)) return detail;
		if (Array.isArray(detail) && !structuralArrays.has(key) && bytes(encode(detail)) > 4096) return externalize(detail);
		if (Array.isArray(detail)) return detail.map(child => compact(child));
		return Object.fromEntries(Object.entries(detail).map(([name, child]) => [name, compact(child, name)]));
	};
	// A JSON clone also gives the persisted representation of undefined/nonfinite values.
	let summary = compact(JSON.parse(encode(value)));
	let total = bytes(encode(summary));
	const fits = () => total + 1 <= MAX_SUMMARY_REPORT_BYTES;
	// Exact reference size for a detail of `size` bytes: a move is made only when it saves bytes.
	const referenceBytes = (size, count) => bytes(encode({ reportArtifact: { version: 1, path: `report-artifacts/${'0'.repeat(64)}.json`, sha256: '0'.repeat(64), bytes: size, ...(count === undefined ? {} : { count }) } }));
	const move = async ({ parent, key, child, size }, scalarFallback = false) => {
		const reference = externalize(child);
		if (pending.length >= 32) await flush();
		if (scalarFallback) reference.reportArtifact.scalarFallback = true;
		parent[key] = reference;
		total += bytes(encode(reference)) - size;
		if (fits()) total = bytes(encode(summary));
	};
	const saves = candidate => candidate.size > referenceBytes(candidate.size, Array.isArray(candidate.child) ? candidate.child.length : undefined);
	if (!fits()) {
		// Invariant: scalars (numbers, booleans, null, short strings such as ids, statuses and terminations) never move while
		// any non-scalar detail that saves bytes is still inline. Details are non-structural arrays, long strings and records
		// holding no scalars; they are disjoint, so one size-ordered greedy pass spills the largest first.
		const details = [];
		const visit = parent => {
			for (const [key, child] of Object.entries(parent)) {
				if (child === null || child === undefined || isReference(child)) continue;
				if (isDetail(child, key)) details.push({ parent, key, child, size: bytes(encode(child)) });
				else if (Array.isArray(child)) child.forEach((item, index) => isRecord(item) ? visit(item) : isDetail(item, '') && details.push({ parent: child, key: index, child: item, size: bytes(encode(item)) }));
				else if (isRecord(child)) visit(child);
			}
		};
		visit(summary);
		for (const candidate of details.filter(saves).sort((a, b) => b.size - a.size)) {
			if (fits()) break;
			await move(candidate);
		}
	}
	// Scalars alone exceed the bound: records holding scalars move, first those nested below an entry's direct records (never
	// an entry's id or status fields), then an entry's direct records, then whole top-level collections, each marked scalarFallback.
	// Candidates within one step are disjoint and unchanged by each other's moves, so each step is one sorted greedy pass.
	for (const step of ['nested', 'entry', 'collection']) {
		if (fits()) break;
		const candidates = [];
		const consider = (parent, key, child) => candidates.push({ parent, key, child, size: bytes(encode(child)) });
		const visit = (parent, entry) => {
			for (const [key, child] of Object.entries(parent)) {
				if (!isObject(child)) continue;
				if (holdsStructure(child, key)) {
					if (Array.isArray(child)) child.forEach(item => isRecord(item) && visit(item, true));
					else visit(child, false);
				} else if (isRecord(child) && (step === 'entry' || !entry)) consider(parent, key, child);
				else if (isRecord(child)) visit(child, false);
			}
		};
		if (step === 'collection') for (const [key, child] of Object.entries(summary)) { if (isObject(child)) consider(summary, key, child); }
		else visit(summary, true);
		for (const candidate of candidates.filter(saves).sort((a, b) => b.size - a.size)) {
			if (fits()) break;
			await move(candidate, true);
		}
	}
	if (!fits()) {
		summary = externalize(summary);
		summary.reportArtifact.scalarFallback = true;
	}
	await flush();
	await write(file, encode(summary) + '\n', { encoding: 'utf8' });
	return summary;
}

export async function hydrateArtifactReport(value, file, { read = readFile } = {}) {
	const directory = path.dirname(path.resolve(file)), loads = new Map(), loaded = new Map();
	// Collect references synchronously, load and verify each artifact once (in parallel), then rebuild synchronously.
	const references = (detail, out = []) => {
		if (!detail || typeof detail !== 'object') return out;
		if (isReference(detail)) out.push(detail.reportArtifact);
		else for (const child of Object.values(detail)) references(child, out);
		return out;
	};
	const load = ref => {
		if (!/^report-artifacts\/[a-f0-9]{64}\.json$/.test(ref.path) || ref.path !== `report-artifacts/${ref.sha256}.json`) throw new Error('Invalid report artifact path');
		if (!loads.has(ref.path)) loads.set(ref.path, (async () => {
			const text = await read(path.join(directory, ref.path), 'utf8');
			if (bytes(text) !== ref.bytes || hash(text) !== ref.sha256) throw new Error(`Report artifact integrity mismatch: ${ref.path}`);
			const parsed = JSON.parse(text);
			if (ref.count !== undefined && (!Array.isArray(parsed) || parsed.length !== ref.count)) throw new Error('Report artifact count mismatch');
			await Promise.all(references(parsed).map(load));
			loaded.set(ref.path, parsed);
		})());
		return loads.get(ref.path);
	};
	await Promise.all(references(value).map(load));
	// Rebuilding creates fresh objects, so repeated artifacts never share structure in the result.
	const build = detail => {
		if (!detail || typeof detail !== 'object') return detail;
		if (isReference(detail)) return build(loaded.get(detail.reportArtifact.path));
		if (Array.isArray(detail)) return detail.map(build);
		return Object.fromEntries(Object.entries(detail).map(([key, child]) => [key, build(child)]));
	};
	return build(value);
}

export async function readArtifactReport(file) {
	return hydrateArtifactReport(JSON.parse(await readFile(file, 'utf8')), file);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const reading = process.argv[2] === '--read';
	if (process.argv.length !== (reading ? 5 : 4)) throw new Error('Usage: report-artifacts.mjs INPUT.json OUTPUT.json | --read INPUT.json HYDRATED.json');
	if (reading) await writeFile(process.argv[4], JSON.stringify(await readArtifactReport(process.argv[3])) + '\n', { encoding: 'utf8' });
	else await writeArtifactReport(process.argv[3], await readArtifactReport(process.argv[2]));
}
