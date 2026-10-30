import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { discoverContracts, contractSnapshot } from '../test/helpers/contract-inventory.mjs';

// Refresh locations without granting behavioral approval. Changed snapshots
// keep their old witnesses for review, but CI rejects review-required entries.
export function refreshClaims(table, current) {
	const previous = new Map(table.claims.map(entry => [entry.id, entry]));
	const changes = { changed: [], added: [], removed: [] };
	const details = [];
	const claims = current.map(entry => {
		const old = previous.get(entry.id);
		previous.delete(entry.id);
		const contract = contractSnapshot(entry);
		if (old && !old.removed && JSON.stringify(contractSnapshot(old.contract)) === JSON.stringify(contract)) {
			return { ...old, contract, location: entry.location };
		}
		changes[old ? 'changed' : 'added'].push(entry.id);
		details.push({ kind: old ? 'changed' : 'added', id: entry.id, before: old?.contract.claim, after: entry.claim });
		return {
			...(old ?? { predicate: 'Review the actual behavior of this new advertised contract.', checks: [] }),
			id: entry.id, contract, location: entry.location,
			status: 'review-required', reason: 'Contract changed or added; inspect behavior and update its predicate and witnesses before approving.',
		};
	});
	for (const old of previous.values()) {
		if (!old.removed) {
			changes.removed.push(old.id);
			details.push({ kind: 'removed', id: old.id, before: old.contract.claim });
		}
		claims.push({ ...old, removed: true, status: 'review-required', reason: 'Contract removed; explicitly review its removal and delete this retired entry.' });
	}
	const locations = new Map(current.map(entry => [entry.id, entry.location]));
	// An atomic predicate whose parent contract disappeared keeps its evidence for review; it is never approved or deleted here.
	const atomicPredicates = (table.atomicPredicates ?? []).map(entry => {
		if (locations.has(entry.parent)) return { ...entry, location: locations.get(entry.parent) };
		if (entry.status !== 'review-required') details.push({ kind: 'atomic-orphaned', id: entry.id, before: entry.predicate });
		return { ...entry, status: 'review-required', reason: 'Parent contract retired or absent; reparent this predicate to the contract it describes or delete it.' };
	});
	return { table: { ...table, claims, atomicPredicates }, changes, details };
}

export function main() {
	const file = new URL('../test/contracts/claims.json', import.meta.url);
	const result = refreshClaims(JSON.parse(readFileSync(file, 'utf8')), discoverContracts());
	writeFileSync(file, JSON.stringify(result.table, null, 2) + '\n');
	for (const detail of result.details) {
		console.log(`${detail.kind}: ${detail.id}`);
		if (detail.before !== undefined) console.log(`  Before: ${detail.before}`);
		if (detail.after !== undefined) console.log(`  After: ${detail.after}`);
	}
	if (!Object.values(result.changes).some(ids => ids.length)) console.log('No contract changes; current locations refreshed.');
	const pending = [...result.table.claims, ...result.table.atomicPredicates].filter(entry => entry.status === 'review-required');
	if (pending.length) {
		console.log(`Review required for ${pending.length} entries. Refresh never approves evidence.`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
