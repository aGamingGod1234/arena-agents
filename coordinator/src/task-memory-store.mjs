import { codePointLength } from './text-length.mjs';
import { createHash } from 'node:crypto';
import { AtomicAgentStore } from './observed-memory-store.mjs';
import { headingOf } from './search-coverage.mjs';
import { recoveryPosition, observedPortalTransition } from './recovery-progress-wrap.mjs';
import { bodyClock, clockPrecedes, createLifecycleBook, deadSample, directBlockEvidence, evidenceClock, freshEvidence, laterClock, lifecycleFor, provenance } from './fact-provenance.mjs';

const STATIONS = new Set(['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'trapped_chest', 'ender_chest', 'barrel', 'brewing_stand', 'enchanting_table', 'anvil', 'chipped_anvil', 'damaged_anvil', 'smithing_table', 'stonecutter', 'grindstone', 'loom', 'cartography_table', 'fletching_table', 'composter', 'beacon', 'respawn_anchor', 'bed'].map(id => `minecraft:${id}`));
const KINDS = new Set(['place', 'route', 'progress', 'lesson']);
const MAX_ENTRIES = 256;
const MAX_TRAIL = 128;

// A world retains shared lookup semantics, but an agent's recovery history and
// authored capacity belong in its own atomic record. Stable partition keys avoid
// snapshot garbage; the small manifest publishes new owners after their writes.
const taskPartitions = {
	split(state) {
		const parts = new Map();
		const owner = (agentId) => {
			if (!parts.has(agentId)) parts.set(agentId, { version: 1, worldId: state.worldId, dimension: state.dimension, agentId,
				agent: state.agents[agentId] ?? null, entries: [] });
			return parts.get(agentId);
		};
		for (const agentId of Object.keys(state.agents)) owner(agentId);
		for (const entry of state.entries) owner(entry.agentId).entries.push(entry);
		return { manifest: { version: 2, worldId: state.worldId, dimension: state.dimension, revision: state.revision,
			owners: [...parts.keys()], assets: state.assets }, parts };
	},
	keys(manifest) {
		if (manifest.version !== 2) return null; // Read legacy files without rewriting on load.
		if (!Array.isArray(manifest.owners) || new Set(manifest.owners).size !== manifest.owners.length) throw new Error('INVALID_TASK_MEMORY');
		for (const agentId of manifest.owners) requireAgent({ agentId });
		return manifest.owners;
	},
	join(manifest, parts) {
		const state = { version: 1, worldId: manifest.worldId, dimension: manifest.dimension, revision: manifest.revision,
			agents: {}, entries: [], assets: manifest.assets };
		for (const [agentId, part] of parts) {
			if (!part || part.version !== 1 || part.worldId !== state.worldId || part.dimension !== state.dimension || part.agentId !== agentId
				|| !Array.isArray(part.entries) || part.entries.some(entry => entry.agentId !== agentId || !Number.isSafeInteger(entry.order) || !Number.isSafeInteger(entry.updatedRevision))) throw new Error('INVALID_TASK_MEMORY');
			if (part.agent !== null) state.agents[agentId] = part.agent;
			state.entries.push(...part.entries);
		}
		state.entries.sort((a, b) => a.order - b.order);
		// An interrupted manifest replacement may leave an existing owner's newer
		// atomic file. Keep update ordering monotonic when that record is recovered.
		state.revision = state.entries.reduce((revision, entry) => Math.max(revision, entry.updatedRevision), state.revision);
		return state;
	},
};

/** Durable task evidence. It describes options; it never selects or executes gameplay. */
export class TaskMemoryStore {
	#disk; #worlds = new Map(); #loads = new Map(); #writes = new Map(); #errors = new Map(); #dirty = new Set(); #authored = new Map(); #receipts = new Map();
	// Where each agent last died this session, so a respawn in another dimension still sees that death in its summary.
	#lastDeathScopes = new Map();
	#livePositions = new Map(); #portals = new Map();
	// Each agent's body lifecycle book (per world: newest death and living clocks, producer epoch), shared by every
	// dimension partition and saved in its own record so a fence survives reload whichever partition it came from.
	#lifecycleDisk; #books = new Map(); #bookLoads = new Map(); #bookWrites = new Map(); #bookDirty = new Set(); #bookUrgent = new Set(); #bookErrors = new Map();
	// Each agent's latest sample clock: the "now" that summary ages are measured against.
	#clocks = new Map();
	constructor({ directory = null } = {}) {
		this.#disk = new AtomicAgentStore({ directory, namespace: 'task-world', partition: taskPartitions });
		this.#lifecycleDisk = new AtomicAgentStore({ directory, namespace: 'task-lifecycle' });
	}
	async #book(agentId) {
		if (this.#books.has(agentId)) return this.#books.get(agentId);
		if (!this.#bookLoads.has(agentId)) {
			const pending = this.#lifecycleDisk.read(agentId).then((saved) => {
				const book = validLifecycleBook(saved?.book) ? saved.book : createLifecycleBook();
				if (!this.#books.has(agentId)) this.#books.set(agentId, book);
				return this.#books.get(agentId);
			}).finally(() => { if (this.#bookLoads.get(agentId) === pending) this.#bookLoads.delete(agentId); });
			this.#bookLoads.set(agentId, pending);
		}
		return this.#bookLoads.get(agentId);
	}
	/** Death boundaries, revivals and epoch changes are written at once; other living-clock advances wait for flush(). */
	#saveBook(agentId, urgent) {
		// A book without any clock fences nothing yet; writing it would only cost I/O.
		if (!Object.values(this.#books.get(agentId)?.worlds ?? {}).some((entry) => entry.deathClock !== null || entry.liveClock !== null || entry.epochStartMs !== null)) return;
		this.#bookDirty.add(agentId);
		if (!urgent) return;
		// An update after an in-flight write's snapshot needs its own write; the completing write schedules it.
		this.#bookUrgent.add(agentId);
		if (this.#bookWrites.has(agentId)) return;
		const write = new Promise((resolve) => setImmediate(resolve)).then(async () => {
			this.#bookDirty.delete(agentId); this.#bookUrgent.delete(agentId);
			try { await this.#lifecycleDisk.write(agentId, { version: 1, agentId, book: this.#books.get(agentId) }); this.#bookErrors.delete(agentId); }
			catch (error) { this.#bookErrors.set(agentId, error.message); }
		}).finally(() => {
			this.#bookWrites.delete(agentId);
			if (this.#bookUrgent.has(agentId)) this.#saveBook(agentId, true);
		});
		this.#bookWrites.set(agentId, write);
	}
	/** A partition's remembered living body that is older than a newer death in its world is the previous body. */
	#retireStaleBody(state, agentId) {
		const agent = state.agents[agentId];
		const fence = this.#books.get(agentId)?.worlds[state.worldId]?.deathClock;
		if (!agent?.lastLive || agent.lastLive.dead === true || !clockPrecedes(fence, { lastSeenTick: agent.lastLive.tick, observedAtEpochMs: agent.lastLive.observedAtEpochMs })) return false;
		agent.deathInventory ??= { items: agent.lastLive.inventory ?? [], revivedAt: null };
		agent.lastLive = { ...agent.lastLive, inventory: [], dead: true };
		agent.trail = []; agent.omittedWaypoints = 0;
		return true;
	}
	async #world(scope) {
		const key = scopeKey(scope);
		if (this.#worlds.has(key)) return this.#worlds.get(key);
		if (!this.#loads.has(key)) {
			const pending = this.#disk.read(key).then((saved) => {
				if (saved !== null) validateSavedState(saved, scope);
				const state = saved ?? { version: 1, revision: 0, worldId: scope.worldId, dimension: scope.dimension, agents: {}, entries: [], assets: [] };
				// Legacy records used insertion order. Preserve it for pagination while
				// giving replacements a separate durable summary-selection revision.
				state.entries.forEach((entry, index) => { entry.order ??= index; entry.updatedRevision ??= 0; });
				this.#worlds.set(key, state); return state;
			}).finally(() => { if (this.#loads.get(key) === pending) this.#loads.delete(key); });
			this.#loads.set(key, pending);
		}
		return this.#loads.get(key);
	}
	#save(scope, state) {
		const key = scopeKey(scope);
		state.revision++;
		this.#dirty.add(key);
		// Coalesce discoveries from one observation batch without delaying actions on disk I/O.
		if (!this.#writes.has(key)) {
			const write = new Promise((resolve) => setImmediate(resolve)).then(async () => {
				this.#dirty.delete(key);
				// AtomicAgentStore captures state synchronously at write(). Only these
				// exact authored values depend on this snapshot's outcome.
				const authored = state.entries.filter((value) => this.#authored.has(value));
				const receipts = this.#receipts.get(key) ?? [];
				this.#receipts.delete(key);
				let failure;
				try { await this.#disk.write(key, state); this.#errors.delete(key); }
				catch (error) { this.#errors.set(key, error.message); failure = new Error(`TASK_MEMORY_WRITE_FAILED: ${error.message}`); }
				for (const pending of receipts) { if (failure) pending.reject(failure); else pending.resolve(); }
				for (const value of authored) {
					const pending = this.#authored.get(value);
					this.#authored.delete(value);
					if (failure) pending.reject(failure); else pending.resolve();
				}
			})
				.finally(() => {
					this.#writes.delete(key);
					// Mutations arriving after the disk snapshot must persist without
					// relying on another observation or an orderly shutdown.
					if (this.#dirty.has(key)) this.#save(scope, state);
				});
			this.#writes.set(key, write);
		}
	}
	async flush() {
		await Promise.all([...this.#loads.values(), ...this.#bookLoads.values()]);
		// Everything dirty when flush was called is written, through a successor if a write is already in flight; then
		// wait for in-flight writes and the urgent successors they chain. A heartbeat arriving after this point waits for
		// the next flush like any heartbeat, so a steady observation stream cannot keep flush from returning.
		for (const agentId of [...this.#bookDirty]) this.#saveBook(agentId, true);
		// Lifecycle and partition writes drain together: a boundary admitted while partitions are written starts its own
		// urgent write, which this flush must also wait for and report.
		while (this.#bookWrites.size > 0 || this.#writes.size > 0) {
			await Promise.all([...this.#bookWrites.values(), ...this.#writes.values()]);
		}
		if (this.#bookErrors.size) throw new Error(`TASK_MEMORY_WRITE_FAILED: ${[...this.#bookErrors.values()][0]}`);
		if (this.#errors.size) throw new Error(`TASK_MEMORY_WRITE_FAILED: ${[...this.#errors.values()][0]}`);
	}
	async observe(scope, observation = {}) {
		requireAgent(scope);
		const state = await this.#world(scope);
		const agent = state.agents[scope.agentId] ??= { trail: [], omittedWaypoints: 0, deaths: [], lastLive: null };
		const death = observation.death;
		const position = vector(death ?? observation.position ?? observation.player?.position ?? observation.player);
		const tick = observation.world?.gameTime ?? observation.worldTick ?? null;
		const at = observation.observedAtEpochMs ?? death?.diedAtEpochMs ?? null;
		const recoveryKey = JSON.stringify([scope.worldId, scope.agentId]);
		if (Number.isFinite(at) || Number.isFinite(tick)) this.#clocks.set(scope.agentId, { observedAtEpochMs: at, tick });
		let changed = false;
		// The body crosses dimensions, so its lifecycle does too: one book per agent, per world inside it.
		// Synchronous once loaded, so ingestion keeps its ordering against concurrent writes.
		const book = this.#books.get(scope.agentId) ?? await this.#book(scope.agentId);
		const priorActive = book.active;
		const prior = structuredClone(book.worlds[scope.worldId] ?? null);
		const clock = bodyClock(observation);
		const lifecycle = lifecycleFor(book, scope.worldId, clock);
		// A sample from a retired world or producer epoch describes nothing current.
		if (lifecycle === null) return;
		if (this.#retireStaleBody(state, scope.agentId)) changed = true;
		const died = Boolean(death) || deadSample(observation);
		// A death sample older than the newest living sample describes an earlier death: it may add history, never end this body.
		const earlierDeath = died && clockPrecedes(lifecycle.liveClock, clock);
		if (died && !earlierDeath) {
			lifecycle.deathClock = laterClock(lifecycle.deathClock, clock);
			// Possession ends with the body in every dimension it was carried through, not only where it died.
			for (const other of this.#worlds.values()) {
				const otherAgent = other === state || other.worldId !== scope.worldId ? null : other.agents[scope.agentId];
				if (!otherAgent?.lastLive || otherAgent.lastLive.dead === true) continue;
				otherAgent.lastLive = { ...otherAgent.lastLive, inventory: [], dead: true };
				this.#save({ worldId: other.worldId, dimension: other.dimension }, other);
			}
		}
		if (earlierDeath && death && position) {
			const key = `${death.diedAtEpochMs ?? ''}:${position.x},${position.y},${position.z}:${death.cause ?? ''}`;
			if (!agent.deaths.some((d) => d.key === key)) {
				agent.deaths.push({ key, position, cause: death.cause ?? 'unknown', diedAtEpochMs: death.diedAtEpochMs ?? at,
					lostInventory: stacks(observation.lastLiveInventory ?? deathInventory(agent, death)), outboundTrail: [], omittedWaypoints: 0,
					...(agent.lastLive?.position ? { respawnedAt: { dimension: scope.dimension, ...agent.lastLive.position } } : {}),
					reverseVerified: false, availability: 'unverified', source: 'observed_death' });
				agent.deaths.sort((a, b) => (a.diedAtEpochMs ?? 0) - (b.diedAtEpochMs ?? 0));
				if (agent.deaths.length > 32) agent.deaths.splice(0, agent.deaths.length - 32);
				changed = true;
			}
		}
		if (death && position && !earlierDeath) {
			const key = `${death.diedAtEpochMs ?? ''}:${position.x},${position.y},${position.z}:${death.cause ?? ''}`;
			const existing = agent.deaths.find((d) => d.key === key);
			if (!existing) {
				agent.deaths.push({ key, position, cause: death.cause ?? 'unknown', diedAtEpochMs: death.diedAtEpochMs ?? at,
					...(this.#portals.has(recoveryKey) ? { portal: this.#portals.get(recoveryKey) } : {}),
					lostInventory: stacks(observation.lastLiveInventory ?? deathInventory(agent, death) ?? agent.lastLive?.inventory),
					outboundTrail: agent.trail.map((p) => ({ ...p })), omittedWaypoints: agent.omittedWaypoints,
					reverseVerified: false, availability: 'unverified', source: 'observed_death' });
				if (agent.deaths.length > 32) agent.deaths.splice(0, agent.deaths.length - 32);
				agent.trail = []; agent.omittedWaypoints = 0; agent.lastLive = null; delete agent.diedIn; delete agent.deathInventory; changed = true;
				// The active trail belongs to the body, not the dimension: end this body's trails in every loaded dimension
				// so a later death's outbound route never starts on a route walked before this death.
				for (const other of this.#worlds.values()) {
					const otherAgent = other === state || other.worldId !== scope.worldId ? null : other.agents[scope.agentId];
					if (!otherAgent?.trail.length) continue;
					otherAgent.trail = []; otherAgent.omittedWaypoints = 0;
					this.#save({ worldId: other.worldId, dimension: other.dimension }, other);
				}
				this.#lastDeathScopes.set(recoveryKey, { worldId: scope.worldId, dimension: scope.dimension });
				this.#livePositions.delete(recoveryKey); this.#portals.delete(recoveryKey);
			} else if (!existing.lostInventory.length && stacks(observation.lastLiveInventory).length) {
				existing.lostInventory = stacks(observation.lastLiveInventory); changed = true;
			}
		}
		// Carried facts end with the body (LIFECYCLE_BINDINGS.carried) whatever shape the death sample has. The last live
		// inventory moves to a private loss record for death details that may arrive later; after death, only a fresh
		// inventory sample establishes possession again. Runs after the death record, which reads that loss record.
		if (died && !earlierDeath && agent.lastLive && agent.lastLive.dead !== true) {
			agent.deathInventory = { items: agent.lastLive.inventory ?? [], revivedAt: null };
			agent.lastLive = { ...agent.lastLive, inventory: [], dead: true }; changed = true;
		}
		// Possession and position are ordered against the newest death, not only the last live sample, so a delayed
		// pre-death sample cannot hand the lost inventory back to the next body.
		// A body remembered from before a producer rollback is no clock reference for the new epoch.
		const lastLiveClock = !agent.lastLive || (Number.isFinite(lifecycle.epochStartMs) && !(agent.lastLive.observedAtEpochMs >= lifecycle.epochStartMs))
			? null : { lastSeenTick: agent.lastLive.tick, observedAtEpochMs: agent.lastLive.observedAtEpochMs };
		if (!died && observation.ready !== false && position && !clockPrecedes(lifecycle.deathClock, clock) && freshEvidence(lastLiveClock, { lastSeenTick: tick, observedAtEpochMs: at })) {
			const live = recoveryPosition({ ...observation, world: { ...observation.world, worldId: scope.worldId, dimension: scope.dimension } });
			const previousLive = this.#livePositions.get(recoveryKey);
			if (live && previousLive && previousLive.dimension !== live.dimension) {
				const portal = observedPortalTransition(previousLive, live);
				if (portal) this.#portals.set(recoveryKey, portal); else this.#portals.delete(recoveryKey);
			}
			if (live) this.#livePositions.set(recoveryKey, live);
			const deathScope = this.#lastDeathScopes.get(recoveryKey);
			if (deathScope) {
				const deathState = await this.#world({ ...scope, ...deathScope });
				const latest = deathState.agents[scope.agentId]?.deaths.at(-1);
				if (latest && !latest.respawnedAt) {
					latest.respawnedAt = { dimension: scope.dimension, ...position };
					// A respawn scope not loaded at the death (e.g. after a restart) still holds the previous body's trail.
					if (agent.trail.length) { agent.trail = []; agent.omittedWaypoints = 0; changed = true; }
					this.#save({ ...scope, ...deathScope }, deathState);
					// Kept on the respawn side as well, so a restarted coordinator still recalls a death in another dimension.
					if (deathScope.dimension !== scope.dimension && agent.diedIn !== deathScope.dimension) { agent.diedIn = deathScope.dimension; changed = true; }
				}
			}
			const freshInventory = !observation.continuity?.rememberedSections?.includes('inventory') && Array.isArray(observation.inventory?.items);
			const inventory = freshInventory ? stacks(observation.inventory) : agent.lastLive?.inventory ?? [];
			const inventoryTick = freshInventory ? tick : (agent.lastLive && Object.hasOwn(agent.lastLive, 'inventoryTick') ? agent.lastLive.inventoryTick : agent.lastLive?.tick ?? null);
			const inventoryAtEpochMs = freshInventory ? at : (agent.lastLive && Object.hasOwn(agent.lastLive, 'inventoryAtEpochMs') ? agent.lastLive.inventoryAtEpochMs : agent.lastLive?.observedAtEpochMs ?? null);
			if (JSON.stringify(agent.lastLive?.inventory) !== JSON.stringify(inventory)) changed = true;
			agent.lastLive = { position, inventory, tick, observedAtEpochMs: at, inventoryTick, inventoryAtEpochMs };
			// The revival boundary is saved: after a restart, later death details must still not be charged with this loss.
			if (agent.deathInventory && agent.deathInventory.revivedAt === null) { agent.deathInventory = { ...agent.deathInventory, revivedAt: at ?? Number.MAX_SAFE_INTEGER }; changed = true; }
			lifecycle.liveClock = laterClock(lifecycle.liveClock, clock);
			const previous = agent.trail.at(-1);
			if (!previous || distanceSquared(previous, position) >= 4) {
				agent.trail.push({ ...position, tick }); changed = true;
				if (agent.trail.length > MAX_TRAIL) { agent.trail.splice(1, 1); agent.omittedWaypoints++; }
			}
		}
		const awaitingRevival = prior?.deathClock != null && (prior.liveClock === null || clockPrecedes(prior.deathClock, prior.liveClock));
		// Only fences that protect facts are written at once: a new death, a revival after it, or a producer epoch change.
		const boundaryMoved = JSON.stringify(prior?.deathClock ?? null) !== JSON.stringify(lifecycle.deathClock)
			|| (prior?.epochStartMs ?? null) !== lifecycle.epochStartMs;
		const revived = awaitingRevival && JSON.stringify(prior.liveClock) !== JSON.stringify(lifecycle.liveClock);
		if (boundaryMoved || revived) this.#saveBook(scope.agentId, true);
		else if (book.active !== priorActive || JSON.stringify(prior?.liveClock ?? null) !== JSON.stringify(lifecycle.liveClock)) this.#saveBook(scope.agentId, false);
		for (const block of directBlockEvidence(observation).values()) {
			const position = vector(block);
			if (!position) continue;
			const evidence = evidenceClock(block, observation);
			const key = assetKey(scope, position);
			const asset = state.assets.find(a => a.key === key);
			if (!freshEvidence(asset, evidence)) continue;
			if (!station(block.blockId)) {
				if (asset) {
					if (assetState(asset) === 'placed') {
						// Keep how the station was known, so the model reads both the claim and the sighting that disproved it.
						const origin = { source: asset.source, lastSeenTick: asset.lastSeenTick, observedAtEpochMs: asset.observedAtEpochMs };
						Object.assign(asset, { origin, availability: 'observed_changed', state: 'missing', source: 'observed_block' }); changed = true;
					}
					Object.assign(asset, evidence);
				}
				continue;
			}
			const value = { key, blockId: block.blockId, position, seenBy: [scope.agentId], source: 'observed_block', availability: 'last_observed', state: 'placed', ...evidence };
			if (!asset || asset.blockId !== block.blockId || assetState(asset) !== 'placed') { putAsset(state, value); changed = true; }
			// A later sighting is what now supports the station, so its age and source describe that sighting.
			else Object.assign(asset, evidence, { source: 'observed_block' });
		}
		if (changed) this.#save(scope, state);
	}
	async recordReceipt(scope, receipt) {
		requireAgent(scope);
		if (receipt.state !== 'SUCCEEDED') return false;
		const placed = receipt.actionType === 'place_block' && receipt.reasonCode === 'BLOCK_PLACED';
		const broken = receipt.actionType === 'break_block' && receipt.reasonCode === 'BLOCK_BROKEN';
		if (!placed && !broken) return false;
		const position = vector(receipt.arguments);
		const blockId = placed ? receipt.arguments?.itemId : receipt.arguments?.expectedBlockId;
		if (!position || !station(blockId)) return false;
		const state = await this.#world(scope), key = assetKey(scope, position);
		const asset = state.assets.find(a => a.key === key);
		const evidence = { lastSeenTick: receipt.actionObservation?.worldTick ?? receipt.tick ?? null,
			observedAtEpochMs: receipt.actionObservation?.observedAtEpochMs ?? receipt.observedAtEpochMs ?? null };
		if (asset?.actionId === receipt.actionId || !freshEvidence(asset, evidence)) {
			if (this.#errors.has(scopeKey(scope))) await this.#persistReceipt(scope, state);
			return false;
		}
		const value = { key, blockId, position, seenBy: [scope.agentId], state: placed ? 'placed' : 'destroyed',
			availability: placed ? 'last_observed' : 'destroyed', source: 'action_receipt', actionId: receipt.actionId, ...evidence };
		putAsset(state, value);
		await this.#persistReceipt(scope, state);
		return true;
	}
	async #persistReceipt(scope, state) {
		// The receipt ACK must not outlive its asset update. Wait only for the snapshot containing this fact.
		const pending = Promise.withResolvers();
		const writes = this.#receipts.get(scopeKey(scope)) ?? [];
		writes.push(pending); this.#receipts.set(scopeKey(scope), writes); this.#save(scope, state);
		await pending.promise;
	}

	async remember(scope, entry) {
		requireAgent(scope);
		entry = validateTaskEntry(entry);
		const state = await this.#world(scope);
		const clock = this.#clocks.get(scope.agentId);
		const value = { ...entry, agentId: scope.agentId, goalRevision: scope.goalRevision, source: 'model_authored', historical: true,
			...(Number.isFinite(clock?.observedAtEpochMs) ? { writtenAtEpochMs: clock.observedAtEpochMs } : {}) };
		for (;;) {
			const index = state.entries.findIndex((e) => e.agentId === scope.agentId && e.key === entry.key);
			const full = state.entries.filter((e) => e.agentId === scope.agentId).length >= MAX_ENTRIES;
			const retired = index < 0 && full
				? state.entries.findIndex((e) => e.agentId === scope.agentId && e.status === 'retired') : -1;
			if (index < 0 && full && retired < 0) throw new Error('TASK_MEMORY_FULL: replace or retire an existing entry');
			// Do not overwrite (or evict) an authored version before its snapshot
			// settles. Recheck after waiting: another same-key caller may go first.
			const previous = this.#authored.get(state.entries[index < 0 ? retired : index]);
			if (previous) { await previous.promise.catch(() => {}); continue; }
			value.order = index < 0 ? state.entries.reduce((maximum, entry) => Math.max(maximum, entry.order), -1) + 1 : state.entries[index].order;
			value.updatedRevision = state.revision + 1;
			if (retired >= 0) state.entries.splice(retired, 1);
			if (index < 0) state.entries.push(value); else state.entries[index] = value;
			break;
		}
		const pending = Promise.withResolvers();
		this.#authored.set(value, pending);
		this.#save(scope, state);
		await pending.promise;
		return structuredClone(publicEntry(value));
	}
	async query(scope, { kind = 'all', text = '', offset = 0, limit = 20, dimension = scope.dimension } = {}) {
		requireAgent(scope);
		// A mental lookup may recall another dimension in this same world. It
		// grants no observation or travel, and never writes outside the live scope.
		scope = { ...scope, dimension };
		if (!['all', 'deaths', 'assets', 'trail', ...KINDS].includes(kind) || typeof text !== 'string' || codePointLength(text) > 256 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new TypeError('Invalid task memory query');
		const state = await this.#world(scope);
		if (!this.#books.has(scope.agentId)) await this.#book(scope.agentId);
		if (this.#retireStaleBody(state, scope.agentId)) this.#save(scope, state);
		const own = state.agents[scope.agentId];
		const records = [...state.entries.filter((e) => e.agentId === scope.agentId || e.shared === true).map(publicEntry),
			...knownAssets(state, scope).map(a => ({ kind: 'assets', ...a })),
			...(own?.deaths ?? []).map((d) => ({ kind: 'deaths', ...d })),
			...(kind === 'trail' ? [{ kind: 'trail', waypoints: own?.trail ?? [], omittedWaypoints: own?.omittedWaypoints ?? 0, reverseVerified: false, source: 'observed_positions' }] : [])]
			.filter((e) => (kind === 'all' || e.kind === kind) && JSON.stringify(e).toLowerCase().includes(text.toLowerCase()));
		return { worldId: scope.worldId, dimension: scope.dimension, historical: true, offset, entries: structuredClone(records.slice(offset, offset + limit)), total: records.length, nextOffset: offset + limit < records.length ? offset + limit : null };
	}
	async summary(scope, { recoveryDeath = null } = {}) {
		requireAgent(scope);
		const state = await this.#world(scope);
		if (!this.#books.has(scope.agentId)) await this.#book(scope.agentId);
		if (this.#retireStaleBody(state, scope.agentId)) this.#save(scope, state);
		const own = state.agents[scope.agentId];
		const entries = state.entries.filter((e) => (e.agentId === scope.agentId || e.shared === true) && e.status !== 'retired')
			.sort((a, b) => a.updatedRevision - b.updatedRevision || a.order - b.order);
		const assets = knownAssets(state, scope);
		const rankedAssets = assets.map(asset => ({ asset, relevance: relevance(asset, own?.lastLive) }))
			.sort((a, b) => a.relevance - b.relevance || verification(b.asset) - verification(a.asset) || a.asset.key.localeCompare(b.asset.key));
		const deaths = own?.deaths ?? [];
		// Keep earlier equipment losses alongside the latest death, rather than
		// letting repeated empty-handed deaths hide the first useful recovery site.
		const duplicatesRecovery = (d, dimension) => recoveryDeath !== null && recoveryDeath.dimensionId === dimension
			&& recoveryDeath.diedAtEpochMs === d.diedAtEpochMs && recoveryDeath.cause === d.cause
			&& ['x', 'y', 'z'].every((axis) => recoveryDeath[axis] === d.position[axis]);
		const selectedDeaths = [...new Map([...deaths.filter((d) => d.lostInventory.length).slice(-3), ...deaths.slice(-2)].map((d) => [d.key, d])).values()]
			.filter((d) => !duplicatesRecovery(d, scope.dimension));
		// A player who died in the Nether and woke at the Overworld spawn still knows where they died. Records stay in
		// the death's own dimension; the latest one is read across so the summary names it with its dimension.
		const elsewhere = this.#lastDeathScopes.get(JSON.stringify([scope.worldId, scope.agentId]))
			?? (typeof own?.diedIn === 'string' && own.diedIn.length <= 128 ? { worldId: scope.worldId, dimension: own.diedIn } : undefined);
		let recalledDeathCount = 0;
		if (elsewhere && elsewhere.worldId === scope.worldId && elsewhere.dimension !== scope.dimension) {
			const latest = (await this.#world({ ...scope, dimension: elsewhere.dimension })).agents[scope.agentId]?.deaths.at(-1);
			if (latest) {
				if (!duplicatesRecovery(latest, elsewhere.dimension)) selectedDeaths.push({ ...latest, dimension: elsewhere.dimension });
				recalledDeathCount = 1;
			}
		}
		const recentDeaths = nearbyRecentDeaths(deaths, own?.lastLive);
		// Every remembered row carries src (source, age, and a later disproof), measured against the agent's latest sample.
		const now = this.#clocks.get(scope.agentId) ?? own?.lastLive ?? null;
		const entry = (e) => compactEntry(e, now, own?.lastLive);
		const result = { worldId: scope.worldId, dimension: scope.dimension, revision: state.revision, currentGoalRevision: scope.goalRevision,
			progress: entries.filter((e) => e.kind === 'progress').sort((a,b) => Number(a.goalRevision === scope.goalRevision) - Number(b.goalRevision === scope.goalRevision)).slice(-2).map(entry),
			routes: entries.filter((e) => e.kind === 'route').slice(-4).map(entry),
			places: entries.filter((e) => e.kind === 'place').slice(-4).map(entry),
			lessons: entries.filter((e) => e.kind === 'lesson').slice(-3).map(entry),
			assets: rankedAssets.slice(0, 6).map(({ asset }) => compactAsset(asset, own?.lastLive, now)),
			deaths: selectedDeaths.map(({ outboundTrail, lostInventory, key, source, diedAtEpochMs, ...d }) => ({ ...d, cause: d.cause.slice(0, 128), src: provenance('seen', { observedAtEpochMs: diedAtEpochMs }, now),
				// What was lost is derived from the last live inventory, not seen dropping.
				...(lostInventory.length ? { lostSrc: 'inferred' } : {}), lostInventory: lostInventory.slice(0, 8), omittedInventoryStacks: Math.max(0, lostInventory.length - 8), outboundWaypointCount: outboundTrail.length })),
			...(recentDeaths === null ? {} : { recentDeaths }),
			totals: { entries: entries.length, assets: assets.length, deaths: deaths.length + recalledDeathCount },
			query: 'taskMemory query: waypoints, earlier records, pages.' };
		while (Buffer.byteLength(JSON.stringify(result)) > 6000) {
			const longest = ['lessons', 'places', 'routes', 'assets', 'progress', 'deaths'].find((k) => result[k].length > 1);
			if (!longest) {
				const remaining = ['lessons', 'places', 'routes', 'assets', 'progress', 'deaths'].find((k) => result[k].length);
				if (!remaining) break; result[remaining].shift();
			} else if (longest === 'assets') result.assets.pop(); else result[longest].shift();
		}
		return result;
	}
}

function nearbyRecentDeaths(deaths, live) {
	if (!live?.position || !Number.isFinite(live.observedAtEpochMs)) return null;
	const countsByCause = Object.create(null);
	for (const death of deaths) {
		const age = live.observedAtEpochMs - death.diedAtEpochMs;
		if (!Number.isFinite(death.diedAtEpochMs) || age < 0 || age > 300000 || distanceSquared(death.position, live.position) > 16 ** 2) continue;
		countsByCause[death.cause] = (countsByCause[death.cause] ?? 0) + 1;
	}
	return Object.keys(countsByCause).length ? { withinBlocks: 16, windowSeconds: 300, countsByCause: { ...countsByCause } } : null;
}

export function validateTaskEntry(entry) {
	if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('Task entry must be an object');
	const allowed = ['kind', 'key', 'label', 'summary', 'position', 'from', 'to', 'waypoints', 'status', 'shared'];
	if (Object.keys(entry).some((k) => !allowed.includes(k)) || !KINDS.has(entry.kind)) throw new TypeError('Unsupported task entry');
	for (const [key, max] of [['key', 128], ['label', 128], ['summary', 1024]]) {
		if (typeof entry[key] !== 'string' || !entry[key].trim() || codePointLength(entry[key]) > max) throw new TypeError(`Task entry requires ${key} up to ${max} characters`);
	}
	if (entry.shared !== undefined && typeof entry.shared !== 'boolean') throw new TypeError('shared must be boolean');
	if (entry.status !== undefined && !['active', 'retired'].includes(entry.status)) throw new TypeError('status must be active or retired');
	for (const key of ['from', 'to']) if (entry[key] !== undefined && (typeof entry[key] !== 'string' || !entry[key].trim() || codePointLength(entry[key]) > 128)) throw new TypeError(`Invalid route ${key}`);
	if (entry.position !== undefined && !vector(entry.position)) throw new TypeError('Invalid task position');
	if (entry.waypoints !== undefined && (!Array.isArray(entry.waypoints) || entry.waypoints.length > 64 || entry.waypoints.some((p) => !vector(p)))) throw new TypeError('Invalid task waypoints');
	if (entry.kind === 'place' && !vector(entry.position)) throw new TypeError('Places require a position');
	if (entry.kind === 'route' && (!['from', 'to'].every((k) => typeof entry[k] === 'string' && entry[k].trim() && codePointLength(entry[k]) <= 128)
		|| !Array.isArray(entry.waypoints) || entry.waypoints.length < 2 || entry.waypoints.length > 64 || entry.waypoints.some((p) => !vector(p)))) throw new TypeError('Routes require from, to and 2..64 waypoints');
	return { ...entry, ...(entry.position ? { position: vector(entry.position) } : {}), ...(entry.waypoints ? { waypoints: entry.waypoints.map(vector) } : {}) };
}

function scopeKey(scope) {
	if (!scope || ![scope.worldId, scope.dimension].every((v) => typeof v === 'string' && v.length > 0 && v.length <= 256)
		|| scope.agentId !== undefined && (typeof scope.agentId !== 'string' || !scope.agentId || ['__proto__', 'constructor', 'prototype'].includes(scope.agentId))) throw new TypeError('Task memory requires an observed world and dimension');
	return createHash('sha256').update(JSON.stringify([scope.worldId, scope.dimension])).digest('hex');
}
function vector(p) { return p && ['x', 'y', 'z'].every((k) => typeof p[k] === 'number' && Number.isFinite(p[k]) && Math.abs(p[k]) <= (k === 'y' ? 2048 : 30_000_000)) ? { x: p.x, y: p.y, z: p.z } : null; }
function stacks(inventory) { return (Array.isArray(inventory) ? inventory : inventory?.items ?? []).filter((i) => typeof i?.itemId === 'string' && i.itemId.length <= 256 && Number.isSafeInteger(i.count) && i.count > 0).slice(0, 64).map(({ itemId, count }) => ({ itemId, count })); }
function requireAgent(scope) { if (typeof scope?.agentId !== 'string' || !scope.agentId || scope.agentId.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(scope.agentId)) throw new TypeError('Task memory requires an agent identity'); }
function publicEntry({ order, updatedRevision, ...entry }) { return entry; }
// A model-authored entry is told: only its author retires it, so it carries its age and no verification.
function compactEntry({ waypoints, summary, order, updatedRevision, source, historical, writtenAtEpochMs, ...entry }, now = null, live = null) {
	const at = entry.kind === 'place' ? entry.position : null;
	const from = live?.dead ? null : live?.position;
	const offset = at && from ? { distance: Math.round(Math.hypot(at.x - from.x, at.z - from.z)),
		...(at.x === from.x && at.z === from.z ? {} : { heading: headingOf(at.x - from.x, at.z - from.z) }), dy: Math.round(at.y - from.y) } : {};
	return { ...entry, ...offset, summary: summary.slice(0, 256), ...(waypoints ? { waypointCount: waypoints.length } : {}), src: provenance('told', { observedAtEpochMs: writtenAtEpochMs }, now) };
}
function validateSavedState(saved, scope) {
	if (saved.version !== 1 || saved.worldId !== scope.worldId || saved.dimension !== scope.dimension || !Number.isSafeInteger(saved.revision) || saved.revision < 0 || !Array.isArray(saved.entries) || !Array.isArray(saved.assets) || saved.assets.length > 128 || !saved.agents || typeof saved.agents !== 'object' || Array.isArray(saved.agents)) throw new Error('INVALID_TASK_MEMORY');
	const counts = new Map();
	for (const e of saved.entries) {
		const { agentId, goalRevision, source, historical, order, updatedRevision, writtenAtEpochMs, ...entry } = e;
		requireAgent({ agentId }); validateTaskEntry(entry);
		if ([order, updatedRevision, writtenAtEpochMs].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) throw new Error('INVALID_TASK_MEMORY');
		counts.set(agentId, (counts.get(agentId) ?? 0) + 1);
		if (counts.get(agentId) > MAX_ENTRIES) throw new Error('INVALID_TASK_MEMORY');
	}
	for (const a of saved.assets) if (!vector(a.position) || typeof a.blockId !== 'string' || !Array.isArray(a.seenBy) || a.seenBy.some((agentId) => { try { requireAgent({ agentId }); return false; } catch { return true; } })) throw new Error('INVALID_TASK_MEMORY');
	for (const [agentId, agent] of Object.entries(saved.agents)) {
		requireAgent({ agentId });
		if (!Array.isArray(agent.trail) || agent.trail.length > MAX_TRAIL || agent.trail.some((p) => !vector(p)) || !Array.isArray(agent.deaths) || agent.deaths.length > 32 || agent.deaths.some((d) => !vector(d.position) || typeof d.key !== 'string' || typeof d.cause !== 'string' || !Array.isArray(d.outboundTrail) || d.outboundTrail.length > MAX_TRAIL || d.outboundTrail.some((p) => !vector(p)) || !Array.isArray(d.lostInventory) || d.lostInventory.length > 64)) throw new Error('INVALID_TASK_MEMORY');
	}
}
// The corpse's inventory belongs to this death unless the body came back before it.
function deathInventory(agent, death) {
	const held = agent.deathInventory;
	if (!held || !Array.isArray(held.items)) return undefined;
	return held.revivedAt === null || Number.isFinite(death?.diedAtEpochMs) && death.diedAtEpochMs <= held.revivedAt ? held.items : undefined;
}
function validLifecycleBook(book) {
	return book !== null && typeof book === 'object' && (book.active === null || typeof book.active === 'string')
		&& book.worlds !== null && typeof book.worlds === 'object' && !Array.isArray(book.worlds)
		&& Object.values(book.worlds).every((entry) => entry !== null && typeof entry === 'object' && 'deathClock' in entry && 'liveClock' in entry);
}
function distanceSquared(a, b) { return ['x', 'y', 'z'].reduce((n, k) => n + (a[k] - b[k]) ** 2, 0); }

function station(id) { return typeof id === 'string' && (STATIONS.has(id) || /^minecraft:[a-z_]+_bed$/.test(id)); }
function assetKey(scope, p) { return `${scope.agentId}:${p.x},${p.y},${p.z}`; }
function assetState(a) { return a.state ?? (a.availability === 'observed_changed' ? 'missing' : a.availability === 'destroyed' ? 'destroyed' : 'placed'); }
function putAsset(state, value) {
	const index = state.assets.findIndex(a => a.key === value.key);
	if (index < 0) state.assets.push(value); else state.assets[index] = value;
	if (state.assets.length > 128) state.assets.shift();
}
function knownAssets(state, scope) {
	const live = state.agents[scope.agentId]?.lastLive, held = new Map();
	if (live?.dead !== true) for (const { itemId, count } of live?.inventory ?? []) if (station(itemId)) held.set(itemId, (held.get(itemId) ?? 0) + count);
	return [...state.assets.filter(a => a.seenBy.includes(scope.agentId)).map(a => ({ ...a, state: assetState(a) })),
		...[...held].map(([blockId, count]) => ({ key: `${scope.agentId}:carried:${blockId}`, blockId, count, state: 'carried',
			source: 'observed_inventory', lastSeenTick: Object.hasOwn(live, 'inventoryTick') ? live.inventoryTick : live.tick, observedAtEpochMs: Object.hasOwn(live, 'inventoryAtEpochMs') ? live.inventoryAtEpochMs : live.observedAtEpochMs }))];
}
function verification(a) { return a.observedAtEpochMs ?? a.lastSeenTick ?? 0; }
function relevance(a, live) {
	if (a.state === 'carried') return -1;
	const distance = live?.position ? Math.sqrt(distanceSquared(a.position, live.position)) : 0;
	const height = live?.position ? Math.abs(a.position.y - live.position.y) : 0;
	return (a.state === 'placed' ? 0 : 1e9) + distance + height;
}
const ASSET_SOURCES = { action_receipt: 'did', observed_block: 'seen', observed_inventory: 'seen' };
function compactAsset(a, live, now = live) {
	const origin = a.state === 'missing' && ASSET_SOURCES[a.origin?.source] ? a.origin : null;
	const src = origin === null ? provenance(ASSET_SOURCES[a.source] ?? 'seen', a, now) : provenance(ASSET_SOURCES[origin.source], origin, now, a);
	return { blockId: a.blockId, state: a.state,
		...(a.state === 'carried' ? { count: a.count } : { position: a.position,
			...(live?.position ? { distance: Math.round(Math.sqrt(distanceSquared(a.position, live.position))), dy: Math.round(a.position.y - live.position.y) } : {}) }),
		src };
}
