package dev.agaminggod.arenaagents.server;

import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * Per-player token bucket for control snapshot requests. Building a snapshot walks every agent record and the model
 * catalog, and any connected client (operator or not) can ask for one, so one requester gets at most {@link #BURST}
 * at once and then one per {@link #REFILL_INTERVAL_MS}. The Field Console pairs each snapshot with the request that
 * asked for it, so an over-rate request is deferred and answered later rather than dropped; only past
 * {@link #MAX_DEFERRED} waiting requests (far more than the console ever sends) are they dropped.
 */
final class SnapshotRequestLimiter {
	enum Decision { SEND, DEFERRED, DROPPED }

	static final int BURST = 4;
	static final long REFILL_INTERVAL_MS = 250L;
	static final int MAX_DEFERRED = 8;

	private final Map<UUID, Bucket> buckets = new HashMap<>();

	synchronized Decision request(UUID requester, long nowMs) {
		Bucket bucket = buckets.computeIfAbsent(Objects.requireNonNull(requester, "requester must not be null"),
				ignored -> new Bucket(nowMs));
		bucket.refill(nowMs);
		if (bucket.deferred == 0 && bucket.tokens > 0) {
			bucket.tokens--;
			return Decision.SEND;
		}
		if (bucket.deferred < MAX_DEFERRED) {
			bucket.deferred++;
			return Decision.DEFERRED;
		}
		bucket.dropped++;
		return Decision.DROPPED;
	}

	/** Deferred snapshots now due, per requester; their tokens are spent. Idle full buckets are forgotten. */
	synchronized Map<UUID, Integer> due(long nowMs) {
		Map<UUID, Integer> due = new LinkedHashMap<>();
		for (Iterator<Map.Entry<UUID, Bucket>> iterator = buckets.entrySet().iterator(); iterator.hasNext(); ) {
			Map.Entry<UUID, Bucket> entry = iterator.next();
			Bucket bucket = entry.getValue();
			bucket.refill(nowMs);
			int sendable = Math.min(bucket.deferred, bucket.tokens);
			if (sendable > 0) {
				bucket.deferred -= sendable;
				bucket.tokens -= sendable;
				due.put(entry.getKey(), sendable);
			}
			if (bucket.deferred == 0 && bucket.tokens == BURST) iterator.remove();
		}
		return due;
	}

	/** Forgets requesters who are no longer connected. */
	synchronized void retain(Set<UUID> connected) {
		Objects.requireNonNull(connected, "connected must not be null");
		buckets.keySet().retainAll(connected);
	}

	synchronized long dropped(UUID requester) {
		Bucket bucket = buckets.get(requester);
		return bucket == null ? 0L : bucket.dropped;
	}

	synchronized int tracked() {
		return buckets.size();
	}

	private static final class Bucket {
		private int tokens = BURST;
		private int deferred;
		private long dropped;
		private long refilledAtMs;

		private Bucket(long nowMs) {
			refilledAtMs = nowMs;
		}

		private void refill(long nowMs) {
			if (nowMs <= refilledAtMs) return;
			long earned = (nowMs - refilledAtMs) / REFILL_INTERVAL_MS;
			if (earned <= 0L) return;
			if (tokens + earned >= BURST) {
				tokens = BURST;
				refilledAtMs = nowMs;
			} else {
				tokens += (int) earned;
				refilledAtMs += earned * REFILL_INTERVAL_MS;
			}
		}
	}
}
