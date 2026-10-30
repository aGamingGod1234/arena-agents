package dev.agaminggod.arenaagents.scenario.runtime;

import dev.agaminggod.arenaagents.scenario.ScenarioParticipant;
import dev.agaminggod.arenaagents.scenario.ScenarioScoreChange;
import dev.agaminggod.arenaagents.scenario.ScenarioScoreRule;
import dev.agaminggod.arenaagents.scenario.ScenarioSession;
import dev.agaminggod.arenaagents.scenario.ScenarioSessionState;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * The bounded set of score rules the server can measure itself: parkour checkpoint progress and completion
 * time, and PvP eliminations seen on the server. Every other preset rule is labelled unscored.
 *
 * <p>Each rule's weight is the most a participant can earn from it. Checkpoint points telescope, so a
 * participant who reaches the finish holds exactly the rule weight however many ticks it took. Awards only
 * follow new evidence: checkpoint progress is monotonic and persisted in the same snapshot as the scores,
 * and a death event is never replayed after recovery, so nothing is awarded twice.
 */
public final class ScenarioRuntimeScorer {
	public static final String CHECKPOINT_RULE = "checkpoint";
	public static final String COMPLETION_TIME_RULE = "completion-time";
	public static final String ELIMINATION_RULE = "kills-assists";
	public static final Set<String> SCORED_RULES = Set.of(CHECKPOINT_RULE, COMPLETION_TIME_RULE, ELIMINATION_RULE);

	private ScenarioRuntimeScorer() {
	}

	public static boolean scored(ScenarioScoreRule rule) {
		return SCORED_RULES.contains(Objects.requireNonNull(rule, "rule must not be null").id());
	}

	/** Awards newly reached checkpoints and, on first reaching the finish, the remaining-time bonus. */
	public static List<ScenarioScoreChange> checkpointProgress(
			ScenarioSession session,
			long elapsedTick,
			String participantId,
			int previousCheckpoint,
			int currentCheckpoint,
			int finishCheckpoint
	) {
		Objects.requireNonNull(session, "session must not be null");
		if (finishCheckpoint <= 0 || currentCheckpoint <= previousCheckpoint || !active(session)) return List.of();
		int previous = Math.max(0, Math.min(previousCheckpoint, finishCheckpoint));
		int current = Math.min(currentCheckpoint, finishCheckpoint);
		if (current <= previous) return List.of();
		ArrayList<ScenarioScoreChange> changes = new ArrayList<>(2);
		Optional<ScenarioScoreRule> checkpoint = rule(session, CHECKPOINT_RULE);
		if (checkpoint.isPresent()) {
			double weight = checkpoint.get().weight();
			double points = points(weight * current / finishCheckpoint) - points(weight * previous / finishCheckpoint);
			if (points > 0.0D) {
				changes.add(session.award(elapsedTick, participantId, CHECKPOINT_RULE, points,
						"Reached checkpoint " + current + " of " + finishCheckpoint,
						Map.of("checkpoint", Integer.toString(current), "finish", Integer.toString(finishCheckpoint))));
			}
		}
		Optional<ScenarioScoreRule> completion = rule(session, COMPLETION_TIME_RULE);
		if (current == finishCheckpoint && completion.isPresent()) {
			long duration = session.config().durationTicks();
			double remaining = Math.max(0.0D, 1.0D - (double) elapsedTick / duration);
			double points = points(completion.get().weight() * remaining);
			if (points > 0.0D) {
				changes.add(session.award(elapsedTick, participantId, COMPLETION_TIME_RULE, points,
						"Finished the course at tick " + elapsedTick + " of " + duration,
						Map.of("finishTick", Long.toString(elapsedTick))));
			}
		}
		return List.copyOf(changes);
	}

	/**
	 * Credits one elimination of an opposing participant. Self-kills and same-team kills earn nothing.
	 * Eliminating every opponent earns the full rule weight, and repeated kills (a respawned opponent) never take a
	 * participant past it, including across a restored session.
	 */
	public static Optional<ScenarioScoreChange> elimination(
			ScenarioSession session,
			long elapsedTick,
			String killerParticipantId,
			String victimParticipantId
	) {
		Objects.requireNonNull(session, "session must not be null");
		if (!active(session) || Objects.equals(killerParticipantId, victimParticipantId)) return Optional.empty();
		Optional<ScenarioScoreRule> rule = rule(session, ELIMINATION_RULE);
		if (rule.isEmpty()) return Optional.empty();
		ScenarioParticipant killer = session.config().requireParticipant(killerParticipantId);
		ScenarioParticipant victim = session.config().requireParticipant(victimParticipantId);
		if (!opposing(killer, victim)) return Optional.empty();
		long opponents = session.config().participants().stream().filter(other -> opposing(killer, other)).count();
		double remaining = points(rule.get().weight() - eliminationEarned(session, killer.id()));
		double points = Math.min(points(rule.get().weight() / opponents), remaining);
		if (points <= 0.0D) return Optional.empty();
		return Optional.of(session.award(elapsedTick, killer.id(), ELIMINATION_RULE, points,
				"Eliminated " + victim.id(), Map.of("victim", victim.id())));
	}

	/**
	 * Elimination points a participant already holds. When elimination is the preset's only scored rule its persisted
	 * total score is exactly that (and survives restore, unlike the in-memory audit); otherwise the audit is summed.
	 */
	private static double eliminationEarned(ScenarioSession session, String participantId) {
		boolean onlyScoredRule = session.config().preset().scoreRules().stream()
				.filter(ScenarioRuntimeScorer::scored).allMatch(rule -> rule.id().equals(ELIMINATION_RULE));
		if (onlyScoredRule) return session.scores().getOrDefault(participantId, 0.0D);
		return session.scoreAudit().stream()
				.filter(change -> change.participantId().equals(participantId) && change.ruleId().equals(ELIMINATION_RULE))
				.mapToDouble(ScenarioScoreChange::points).sum();
	}

	private static boolean opposing(ScenarioParticipant first, ScenarioParticipant second) {
		if (first.id().equals(second.id())) return false;
		return first.team().isEmpty() || second.team().isEmpty() || !first.team().equals(second.team());
	}

	private static boolean active(ScenarioSession session) {
		ScenarioSessionState state = session.state();
		return state == ScenarioSessionState.RUNNING || state == ScenarioSessionState.PAUSED;
	}

	private static Optional<ScenarioScoreRule> rule(ScenarioSession session, String ruleId) {
		return session.config().preset().scoreRules().stream().filter(rule -> rule.id().equals(ruleId)).findFirst();
	}

	/** Two decimals keep spectator standings readable without losing ordering between contestants. */
	private static double points(double value) {
		return Math.round(value * 100.0D) / 100.0D;
	}
}
