package dev.agaminggod.arenaagents.server.goal;

import dev.agaminggod.arenaagents.agent.AgentId;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/** Bounded server-owned attribution ledger for kills made by agent players. */
public final class AgentKillLedger {
	static final int SCHEMA_VERSION = 4;
	static final int MAX_EVENTS = 4_096;
	static final int MAX_PROGRESS_ENTRIES = 16_384;
	private final Deque<Kill> kills = new ArrayDeque<>();
	private final Map<KillKey, OrderedLongSeries> killTimesByAgentAndType = new HashMap<>();
	private final Map<KillKey, OrderedLongSeries> killSequencesByAgentAndType = new HashMap<>();
	private final Map<ProgressKey, Progress> progress = new HashMap<>();
	private final Map<KillKey, List<ProgressKey>> progressByAgentAndType = new HashMap<>();
	// The ledger sequence when each active goal became active: plan receipts count only later kills,
	// which a millisecond timestamp cannot tell apart from a kill just before activation.
	private final Map<ActivationKey, Activation> activations = new HashMap<>();
	private boolean legacyActivationMigration;
	private final Runnable mutationListener;
	private long lastSequence;
	private boolean legacyTimestampProgressMigration;
	private int lastLookupProbeCount;

	public AgentKillLedger() {
		this(emptySnapshot(), () -> { });
	}

	public AgentKillLedger(Snapshot snapshot, Runnable mutationListener) {
		this.mutationListener = Objects.requireNonNull(mutationListener, "mutationListener must not be null");
		Snapshot persisted = Objects.requireNonNull(snapshot, "snapshot must not be null");
		lastSequence = persisted.lastSequence();
		legacyTimestampProgressMigration = persisted.legacyTimestampProgressMigration();
		legacyActivationMigration = persisted.legacyActivationMigration();
		for (ActivationFence fence : persisted.activations()) {
			if (activations.put(new ActivationKey(fence.goalId(), fence.agentId()),
					new Activation(fence.afterSequenceExclusive(), fence.creditedTypes())) != null) {
				throw new IllegalArgumentException("Kill ledger contains duplicate goal activations");
			}
		}
		long previousSequence = 0L;
		for (KillEvent event : persisted.events()) {
			if (event.sequence() <= previousSequence || event.sequence() > lastSequence) {
				throw new IllegalArgumentException("Kill ledger event sequence is outside persisted ordering");
			}
			append(event.agentId(), event.entityType(), event.occurredAtEpochMs(), event.sequence());
			previousSequence = event.sequence();
		}
		for (ProgressEvent event : persisted.progress()) {
			ProgressKey key = new ProgressKey(
					event.goalId(), event.agentId(), event.entityType(), event.afterGoalStart());
			Progress value = new Progress(
					event.requiredCount(), event.evictedCount(), event.afterSequenceExclusive());
			if (progress.putIfAbsent(key, value) != null) {
				throw new IllegalArgumentException("Kill ledger contains duplicate goal progress");
			}
		}
		rebuildProgressIndex();
	}

	public synchronized void record(AgentId agentId, String entityType, long occurredAt) {
		long sequence = Math.incrementExact(lastSequence);
		append(agentId, entityType, occurredAt, sequence);
		lastSequence = sequence;
		mutationListener.run();
	}

	private void append(AgentId agentId, String entityType, long occurredAt, long sequence) {
		Objects.requireNonNull(agentId, "agentId must not be null");
		String type = Objects.requireNonNull(entityType, "entityType must not be null");
		if (!type.matches("[a-z0-9_.-]+:[a-z0-9_./-]+")) throw new IllegalArgumentException("entityType must be namespaced");
		if (occurredAt < 0L) throw new IllegalArgumentException("occurredAt must be nonnegative");
		if (sequence <= 0L) throw new IllegalArgumentException("sequence must be positive");
		KillKey key = new KillKey(agentId, type);
		kills.addLast(new Kill(key, occurredAt, sequence));
		killTimesByAgentAndType.computeIfAbsent(key, ignored -> new OrderedLongSeries()).add(occurredAt);
		killSequencesByAgentAndType.computeIfAbsent(key, ignored -> new OrderedLongSeries()).add(sequence);
		while (kills.size() > MAX_EVENTS) {
			Kill removed = kills.removeFirst();
			for (ProgressKey progressKey : progressByAgentAndType.getOrDefault(removed.key(), List.of())) {
				Progress tracked = progress.get(progressKey);
				if (tracked != null && removed.sequence() > tracked.afterSequenceExclusive()) {
					progress.put(progressKey, tracked.creditEvicted());
				}
			}
			removeIndexed(killTimesByAgentAndType, removed.key(), removed.occurredAt());
			removeIndexed(killSequencesByAgentAndType, removed.key(), removed.sequence());
		}
	}

	private static void removeIndexed(Map<KillKey, OrderedLongSeries> index, KillKey key, long value) {
		OrderedLongSeries series = index.get(key);
		series.remove(value);
		if (series.isEmpty()) index.remove(key);
	}

	public synchronized Snapshot snapshot() {
		List<ProgressEvent> persistedProgress = progress.entrySet().stream()
				.sorted(Comparator.comparing((Map.Entry<ProgressKey, Progress> entry) -> entry.getKey().goalId().toString())
						.thenComparing(entry -> entry.getKey().agentId().toString())
						.thenComparing(entry -> entry.getKey().entityType())
						.thenComparing(entry -> entry.getKey().afterGoalStart()))
				.map(entry -> new ProgressEvent(
						entry.getKey().goalId(), entry.getKey().agentId(), entry.getKey().entityType(),
						entry.getKey().afterGoalStart(), entry.getValue().afterSequenceExclusive(),
						entry.getValue().requiredCount(), entry.getValue().evictedCount()))
				.toList();
		List<ActivationFence> persistedActivations = activations.entrySet().stream()
				.sorted(Comparator.comparing((Map.Entry<ActivationKey, Activation> entry) -> entry.getKey().goalId().toString())
						.thenComparing(entry -> entry.getKey().agentId().toString()))
				.map(entry -> new ActivationFence(entry.getKey().goalId(), entry.getKey().agentId(),
						entry.getValue().afterSequenceExclusive(), entry.getValue().creditedTypes()))
				.toList();
		return new Snapshot(
				SCHEMA_VERSION,
				lastSequence,
				kills.stream().map(kill -> new KillEvent(
						kill.key().agentId(), kill.key().entityType(), kill.occurredAt(), kill.sequence())).toList(),
				persistedProgress,
				legacyTimestampProgressMigration,
				persistedActivations,
				legacyActivationMigration
		);
	}

	public static Snapshot emptySnapshot() {
		return new Snapshot(SCHEMA_VERSION, 0L, List.of(), List.of());
	}

	public synchronized void synchronizeProgress(List<KillProgressRequirement> requirements) {
		synchronizeProgress(requirements, null);
	}

	/**
	 * Also fences every active goal, kill leaves or not, at its first synchronization (its activation): advisory plan
	 * steps may name a kill. Reconnects and resumes keep the existing fence. {@code activeGoals} null leaves fences alone.
	 */
	public synchronized void synchronizeProgress(List<KillProgressRequirement> requirements, List<GoalActivation> activeGoals) {
		Objects.requireNonNull(requirements, "requirements must not be null");
		if (activeGoals != null) synchronizeActivations(activeGoals);
		Map<ProgressKey, KillProgressRequirement> desired = new HashMap<>();
		for (KillProgressRequirement requirement : requirements) {
			ProgressKey key = new ProgressKey(
					requirement.goalId(), requirement.agentId(), requirement.entityType(), requirement.afterGoalStart());
			desired.merge(key, requirement, (left, right) -> left.requiredCount() >= right.requiredCount() ? left : right);
		}
		if (desired.size() > MAX_PROGRESS_ENTRIES) {
			throw new IllegalArgumentException("Active kill-goal progress exceeds the bounded limit");
		}
		Map<ProgressKey, Progress> next = new HashMap<>();
		for (Map.Entry<ProgressKey, KillProgressRequirement> entry : desired.entrySet()) {
			Progress previous = progress.get(entry.getKey());
			if (previous == null) {
				next.put(entry.getKey(), initialProgress(entry.getKey(), entry.getValue()));
				continue;
			}
			int requiredCount = entry.getValue().requiredCount();
			next.put(entry.getKey(), new Progress(
					requiredCount,
					Math.min(previous.evictedCount(), requiredCount),
					previous.afterSequenceExclusive()));
		}
		boolean completedLegacyMigration = legacyTimestampProgressMigration;
		legacyTimestampProgressMigration = false;
		if (!next.equals(progress) || completedLegacyMigration) {
			progress.clear();
			progress.putAll(next);
			rebuildProgressIndex();
			mutationListener.run();
		}
	}

	private void synchronizeActivations(List<GoalActivation> activeGoals) {
		if (activeGoals.size() > MAX_PROGRESS_ENTRIES) throw new IllegalArgumentException("Active goals exceed the bounded limit");
		Map<ActivationKey, Activation> next = new HashMap<>();
		for (GoalActivation goal : activeGoals) {
			ActivationKey key = new ActivationKey(goal.goalId(), goal.agentId());
			Activation previous = activations.get(key);
			next.put(key, previous != null ? previous : legacyActivationMigration
					? legacyActivation(goal) : new Activation(lastSequence, List.of()));
		}
		boolean completedMigration = legacyActivationMigration;
		legacyActivationMigration = false;
		if (!next.equals(activations) || completedMigration) {
			activations.clear();
			activations.putAll(next);
			mutationListener.run();
		}
	}

	/**
	 * A save from before activation fences selected a goal's kills by timestamp. Saved timestamps need not increase with
	 * sequence, so no single sequence cutoff reproduces that set: keep the kill types it credited, and fence later kills
	 * at the migration point.
	 */
	private Activation legacyActivation(GoalActivation goal) {
		List<String> credited = kills.stream()
				.filter(kill -> kill.key().agentId().equals(goal.agentId()) && kill.occurredAt() >= goal.goalStartedAtEpochMs())
				.map(kill -> kill.key().entityType()).distinct().limit(MAX_CREDITED_TYPES).toList();
		return new Activation(lastSequence, credited);
	}

	private Progress initialProgress(ProgressKey key, KillProgressRequirement requirement) {
		int requiredCount = requirement.requiredCount();
		if (!key.afterGoalStart()) return new Progress(requiredCount, 0, 0L);
		if (!legacyTimestampProgressMigration) return new Progress(requiredCount, 0, lastSequence);
		OrderedLongSeries legacyTimes = killTimesByAgentAndType.get(
				new KillKey(key.agentId(), key.entityType()));
		int qualifying = legacyTimes == null
				? 0
				: legacyTimes.countAfter(requirement.goalStartedAtEpochMs()).count();
		return new Progress(requiredCount, Math.min(qualifying, requiredCount), lastSequence);
	}

	private void rebuildProgressIndex() {
		progressByAgentAndType.clear();
		for (ProgressKey key : progress.keySet()) {
			KillKey killKey = new KillKey(key.agentId(), key.entityType());
			progressByAgentAndType.computeIfAbsent(killKey, ignored -> new ArrayList<>()).add(key);
		}
	}

	/** Timestamp query retained for diagnostics and compatibility. Goal verification uses persisted sequence fences. */
	public synchronized int count(AgentId agentId, String entityType, long afterExclusive) {
		Objects.requireNonNull(agentId, "agentId must not be null");
		Objects.requireNonNull(entityType, "entityType must not be null");
		OrderedLongSeries series = killTimesByAgentAndType.get(new KillKey(agentId, entityType));
		return countAfter(series, afterExclusive);
	}

	public synchronized int count(
			UUID goalId, AgentId agentId, String entityType, boolean afterGoalStart
	) {
		Objects.requireNonNull(goalId, "goalId must not be null");
		Objects.requireNonNull(agentId, "agentId must not be null");
		Objects.requireNonNull(entityType, "entityType must not be null");
		Progress tracked = progress.get(new ProgressKey(goalId, agentId, entityType, afterGoalStart));
		if (tracked == null) {
			lastLookupProbeCount = 0;
			return 0;
		}
		OrderedLongSeries series = killSequencesByAgentAndType.get(new KillKey(agentId, entityType));
		int recent = countAfter(series, tracked.afterSequenceExclusive());
		return recent + tracked.evictedCount();
	}

	private int countAfter(OrderedLongSeries series, long afterExclusive) {
		if (series == null) {
			lastLookupProbeCount = 0;
			return 0;
		}
		OrderedLongSeries.Lookup lookup = series.countAfter(afterExclusive);
		lastLookupProbeCount = lookup.probes();
		return lookup.count();
	}

	public synchronized int size() {
		return kills.size();
	}

	synchronized int lastLookupProbeCount() {
		return lastLookupProbeCount;
	}

	private record KillKey(AgentId agentId, String entityType) { }
	private record Kill(KillKey key, long occurredAt, long sequence) { }
	private record ProgressKey(UUID goalId, AgentId agentId, String entityType, boolean afterGoalStart) { }
	private record ActivationKey(UUID goalId, AgentId agentId) { }
	private record Activation(long afterSequenceExclusive, List<String> creditedTypes) { }
	static final int MAX_CREDITED_TYPES = 256;

	public record GoalActivation(UUID goalId, AgentId agentId, long goalStartedAtEpochMs) {
		public GoalActivation {
			Objects.requireNonNull(goalId, "goalId must not be null");
			Objects.requireNonNull(agentId, "agentId must not be null");
		}
	}

	/** {@code creditedTypes}: kill types a pre-fence save had already credited to this goal (migration only). */
	public record ActivationFence(UUID goalId, AgentId agentId, long afterSequenceExclusive, List<String> creditedTypes) {
		public ActivationFence(UUID goalId, AgentId agentId, long afterSequenceExclusive) {
			this(goalId, agentId, afterSequenceExclusive, List.of());
		}

		public ActivationFence {
			Objects.requireNonNull(goalId, "goalId must not be null");
			Objects.requireNonNull(agentId, "agentId must not be null");
			if (afterSequenceExclusive < 0L) throw new IllegalArgumentException("afterSequenceExclusive must be nonnegative");
			creditedTypes = List.copyOf(Objects.requireNonNull(creditedTypes, "creditedTypes must not be null"));
			if (creditedTypes.size() > MAX_CREDITED_TYPES || creditedTypes.stream().anyMatch(type -> !type.matches("[a-z0-9_.-]+:[a-z0-9_./-]+"))) {
				throw new IllegalArgumentException("creditedTypes must be bounded namespaced entity types");
			}
		}
	}
	private record Progress(int requiredCount, int evictedCount, long afterSequenceExclusive) {
		private Progress creditEvicted() {
			return evictedCount >= requiredCount
					? this
					: new Progress(requiredCount, evictedCount + 1, afterSequenceExclusive);
		}
	}

	public record Snapshot(
			int schemaVersion,
			long lastSequence,
			List<KillEvent> events,
			List<ProgressEvent> progress,
			boolean legacyTimestampProgressMigration,
			List<ActivationFence> activations,
			boolean legacyActivationMigration
	) {
		public Snapshot(int schemaVersion, long lastSequence, List<KillEvent> events, List<ProgressEvent> progress) {
			this(schemaVersion, lastSequence, events, progress, false);
		}

		public Snapshot(int schemaVersion, long lastSequence, List<KillEvent> events, List<ProgressEvent> progress,
				boolean legacyTimestampProgressMigration) {
			this(schemaVersion, lastSequence, events, progress, legacyTimestampProgressMigration, List.of(), legacyTimestampProgressMigration);
		}

		/** The fence for this goal and agent, or empty when the goal has not been synchronized as active. */
		public java.util.Optional<ActivationFence> activationFence(UUID goalId, AgentId agentId) {
			return activations.stream().filter(fence -> fence.goalId().equals(goalId) && fence.agentId().equals(agentId)).findFirst();
		}

		public Snapshot {
			if (schemaVersion != SCHEMA_VERSION) {
				throw new IllegalArgumentException("Unsupported kill ledger schema: " + schemaVersion);
			}
			if (lastSequence < 0L) throw new IllegalArgumentException("lastSequence must be nonnegative");
			events = List.copyOf(Objects.requireNonNull(events, "events must not be null"));
			progress = List.copyOf(Objects.requireNonNull(progress, "progress must not be null"));
			activations = List.copyOf(Objects.requireNonNull(activations, "activations must not be null"));
			if (activations.size() > MAX_PROGRESS_ENTRIES || activations.stream().anyMatch(fence -> fence.afterSequenceExclusive() > lastSequence)) {
				throw new IllegalArgumentException("Kill ledger activations exceed their bounds");
			}
			if (events.size() > MAX_EVENTS) {
				throw new IllegalArgumentException("Kill ledger exceeds the bounded event limit");
			}
			if (progress.size() > MAX_PROGRESS_ENTRIES) {
				throw new IllegalArgumentException("Kill ledger exceeds the bounded progress limit");
			}
			if (legacyTimestampProgressMigration && !progress.isEmpty()) {
				throw new IllegalArgumentException("Legacy timestamp migration cannot contain compacted progress");
			}
			if (events.stream().anyMatch(event -> event.sequence() > lastSequence)
					|| progress.stream().anyMatch(entry -> entry.afterSequenceExclusive() > lastSequence)) {
				throw new IllegalArgumentException("Kill ledger ordering exceeds lastSequence");
			}
		}
	}

	public record KillEvent(AgentId agentId, String entityType, long occurredAtEpochMs, long sequence) {
		public KillEvent {
			Objects.requireNonNull(agentId, "agentId must not be null");
			Objects.requireNonNull(entityType, "entityType must not be null");
			if (!entityType.matches("[a-z0-9_.-]+:[a-z0-9_./-]+")) {
				throw new IllegalArgumentException("entityType must be namespaced");
			}
			if (occurredAtEpochMs < 0L) throw new IllegalArgumentException("occurredAtEpochMs must be nonnegative");
			if (sequence <= 0L) throw new IllegalArgumentException("sequence must be positive");
		}
	}

	public record KillProgressRequirement(
			UUID goalId,
			AgentId agentId,
			String entityType,
			boolean afterGoalStart,
			long goalStartedAtEpochMs,
			int requiredCount
	) {
		public KillProgressRequirement {
			validateProgressIdentity(goalId, agentId, entityType, requiredCount);
			if (goalStartedAtEpochMs < 0L || afterGoalStart && goalStartedAtEpochMs == 0L) {
				throw new IllegalArgumentException("goalStartedAtEpochMs must identify a positive active-goal boundary");
			}
		}
	}

	public record ProgressEvent(
			UUID goalId, AgentId agentId, String entityType, boolean afterGoalStart,
			long afterSequenceExclusive, int requiredCount, int evictedCount
	) {
		public ProgressEvent {
			validateProgressIdentity(goalId, agentId, entityType, requiredCount);
			if (afterSequenceExclusive < 0L) {
				throw new IllegalArgumentException("afterSequenceExclusive must be nonnegative");
			}
			if (!afterGoalStart && afterSequenceExclusive != 0L) {
				throw new IllegalArgumentException("unfenced progress must start at sequence zero");
			}
			if (evictedCount < 0 || evictedCount > requiredCount) {
				throw new IllegalArgumentException("evictedCount must be between zero and requiredCount");
			}
		}
	}

	private static void validateProgressIdentity(
			UUID goalId, AgentId agentId, String entityType, int requiredCount
	) {
		Objects.requireNonNull(goalId, "goalId must not be null");
		Objects.requireNonNull(agentId, "agentId must not be null");
		Objects.requireNonNull(entityType, "entityType must not be null");
		if (!entityType.matches("[a-z0-9_.-]+:[a-z0-9_./-]+")) {
			throw new IllegalArgumentException("entityType must be namespaced");
		}
		if (requiredCount <= 0 || requiredCount > 16) {
			throw new IllegalArgumentException("requiredCount must be between 1 and 16");
		}
	}

	private static final class OrderedLongSeries {
		private final ArrayList<Long> values = new ArrayList<>();

		private void add(long value) {
			int low = 0;
			int high = values.size();
			while (low < high) {
				int middle = (low + high) >>> 1;
				if (values.get(middle) <= value) low = middle + 1;
				else high = middle;
			}
			values.add(low, value);
		}

		private void remove(long expected) {
			int index = java.util.Collections.binarySearch(values, expected);
			if (index < 0) {
				throw new IllegalStateException("Kill index is inconsistent with its bounded event ledger");
			}
			values.remove(index);
		}

		private Lookup countAfter(long threshold) {
			int low = 0;
			int high = values.size();
			int probes = 0;
			while (low < high) {
				probes++;
				int middle = (low + high) >>> 1;
				if (values.get(middle) <= threshold) low = middle + 1;
				else high = middle;
			}
			return new Lookup(values.size() - low, probes);
		}

		private boolean isEmpty() {
			return values.isEmpty();
		}

		private record Lookup(int count, int probes) { }
	}
}
