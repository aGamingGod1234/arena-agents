package dev.agaminggod.arenaagents.server.goal;

import dev.agaminggod.arenaagents.agent.AgentId;
import java.util.List;

/** Player-visible receipts, with kills limited to the goal's start boundary. */
public final class PlanProgressFacts {
	private PlanProgressFacts() { }

	public static boolean advancementCompleted(boolean displayed, boolean wasDone, boolean isDone) {
		return displayed && !wasDone && isDone;
	}

	public static List<String> verifiedKills(AgentKillLedger.Snapshot ledger, AgentId agentId, long goalStartedAtEpochMs) {
		return ledger.events().stream()
				.filter(event -> event.agentId().equals(agentId) && event.occurredAtEpochMs() >= goalStartedAtEpochMs)
				.map(AgentKillLedger.KillEvent::entityType).distinct().toList();
	}

	/**
	 * Kills after this goal's persisted activation fence. A kill in the same millisecond as activation but before it
	 * is not this goal's. Before the goal is first synchronized, the timestamp boundary is the best available.
	 */
	public static List<String> verifiedKills(AgentKillLedger.Snapshot ledger, AgentId agentId, java.util.UUID goalId, long goalStartedAtEpochMs) {
		java.util.Optional<AgentKillLedger.ActivationFence> fence = ledger.activationFence(goalId, agentId);
		if (fence.isEmpty()) return verifiedKills(ledger, agentId, goalStartedAtEpochMs);
		long after = fence.get().afterSequenceExclusive();
		return java.util.stream.Stream.concat(fence.get().creditedTypes().stream(), ledger.events().stream()
						.filter(event -> event.agentId().equals(agentId) && event.sequence() > after)
						.map(AgentKillLedger.KillEvent::entityType))
				.distinct().toList();
	}
}
