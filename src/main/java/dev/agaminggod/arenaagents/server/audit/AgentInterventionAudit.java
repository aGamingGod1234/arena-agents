package dev.agaminggod.arenaagents.server.audit;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * Server-lifetime intervention audit. Any non-allowlisted command, function, command block or takeover anywhere on
 * the server is an intervention for every agent: the audit never tries to decide whom it helped. A run is autonomous
 * only when this server started on a freshly created world, created the agent itself, and saw no intervention before
 * the measured goal ended. A goal's report is frozen when it ends.
 */
public final class AgentInterventionAudit {
	public static final int MAX_RETAINED = 32;
	static final int MAX_COMMAND_LENGTH = 256;

	public enum Autonomy { AUTONOMOUS, ASSISTED, UNVERIFIABLE }

	/** fresh: this server created the world; existing: it loaded a world; unknown: the audit missed server start. */
	public enum World { FRESH, EXISTING, UNKNOWN }

	public record Intervention(long epochMs, String source, String command) {
		public Intervention {
			source = bounded(source, 64);
			command = bounded(command, MAX_COMMAND_LENGTH);
		}
	}

	public record Report(Autonomy autonomy, UUID agentId, long goalRevision, UUID goalId, World world, boolean coverageComplete,
			int count, List<Intervention> retained, List<String> gaps) {
		public Report {
			retained = List.copyOf(retained);
			gaps = List.copyOf(gaps);
		}
	}

	private final long startedAtEpochMs;
	private final World world;
	private final Set<String> setupTickets = new HashSet<>();
	private final Set<String> otherPlayers = new HashSet<>();
	private List<String> baselineGaps = List.of("content baseline not checked at server start");
	private boolean goalStarted;
	private int count;
	private final List<Intervention> retained = new ArrayList<>();
	private final Map<UUID, AgentState> agents = new HashMap<>();

	public AgentInterventionAudit(long startedAtEpochMs, World world) {
		this.startedAtEpochMs = startedAtEpochMs;
		this.world = Objects.requireNonNull(world, "world must not be null");
	}

	/** True until the first agent exists: the runner's world configuration happens in this window. */
	public synchronized boolean beforeAnyAgent() {
		return agents.isEmpty();
	}

	/** Mods, data packs and generation found at server start that are not the certified baseline. */
	public synchronized void baseline(List<String> gaps) {
		baselineGaps = List.copyOf(gaps);
	}

	/** True once any goal has been observed: the single permitted goal start has been used. */
	public synchronized boolean goalStarted() {
		return goalStarted;
	}

	/** Applies the runner's one-agent, one-goal lifecycle to a classified command; false means it was an intervention. */
	public synchronized boolean permits(InterventionAllowlist.Verdict verdict, List<String> path) {
		return switch (verdict) {
			case ALLOWED -> true;
			case SETUP_ONLY -> {
				boolean setup = beforeAnyAgent();
				if (setup && path != null && path.contains("forceload")) setupTickets.add(String.join(" ", path));
				yield setup;
			}
			// The runner creates exactly one agent and starts exactly one goal; any further one is operator control.
			case AGENT_CREATE -> beforeAnyAgent();
			case GOAL_START -> !goalStarted;
			case TICKET_RELEASE -> !goalStarted && path != null && setupTickets.remove(String.join(" ", path).replace(" remove ", " add "));
			case INTERVENTION -> false;
		};
	}

	/** A player who is not an agent body was online: it could help without any command. */
	public synchronized void otherPlayer(String name) {
		if (otherPlayers.add(name)) intervention(new Intervention(System.currentTimeMillis(), "audit", "player " + name + " online"));
	}

	public synchronized void intervention(Intervention intervention) {
		count++;
		if (retained.size() < MAX_RETAINED) retained.add(intervention);
	}

	/**
	 * Called for every agent before any audit event: creation time, goal revision, current goal (or null), whether that
	 * goal has ended, and whether anyone steered it. A second agent, a second goal or any steering is an intervention.
	 */
	public synchronized void observeAgent(UUID agentId, long createdAtEpochMs, long goalRevision, UUID goalId, boolean goalEnded, boolean steered) {
		if (!agents.containsKey(agentId) && !agents.isEmpty()) intervention(new Intervention(System.currentTimeMillis(), "audit", "additional agent " + agentId));
		AgentState state = agents.computeIfAbsent(agentId, ignored -> new AgentState(createdAtEpochMs >= startedAtEpochMs));
		if (goalId != null && state.firstGoal == null) state.firstGoal = goalId;
		if (goalId != null && !goalId.equals(state.firstGoal) && state.changedGoals.add(goalId)) intervention(new Intervention(System.currentTimeMillis(), "audit", "goal changed to " + goalId));
		if (goalId != null && steered && state.steeredGoals.add(goalId)) intervention(new Intervention(System.currentTimeMillis(), "audit", "goal steered " + goalId));
		if (goalId != null && !goalStarted) {
			goalStarted = true;
			// Setup tickets keep chunks entity-ticking; one still held when play starts changes the world the run uses.
			if (!setupTickets.isEmpty()) intervention(new Intervention(System.currentTimeMillis(), "audit", "forceload ticket kept into play"));
		}
		if (state.openGoal != null && !state.openGoal.equals(goalId)) state.freeze(this, agentId, state.openGoal, state.openRevision);
		if (goalId == null) { state.openGoal = null; return; }
		state.lastGoal = goalId;
		state.lastRevision = goalRevision;
		if (goalEnded) { state.freeze(this, agentId, goalId, goalRevision); state.openGoal = null; }
		else if (!state.frozen.containsKey(goalId)) { state.openGoal = goalId; state.openRevision = goalRevision; }
	}

	/** The agent's open goal, or its last ended goal. */
	public synchronized Report report(UUID agentId) {
		AgentState state = agents.get(agentId);
		if (state == null) return live(agentId, false, 0L, null);
		if (state.openGoal == null && state.lastGoal != null && state.frozen.containsKey(state.lastGoal)) return state.frozen.get(state.lastGoal);
		return live(agentId, state.observedFromCreation, state.lastRevision, state.lastGoal);
	}

	private Report live(UUID agentId, boolean observedFromCreation, long goalRevision, UUID goalId) {
		List<String> gaps = new ArrayList<>(baselineGaps);
		if (world == World.EXISTING) gaps.add("world state existed before this server started");
		if (world == World.UNKNOWN) gaps.add("audit did not observe server start");
		if (!observedFromCreation) gaps.add("agent not created during this audit");
		boolean complete = gaps.isEmpty();
		Autonomy autonomy = count > 0 ? Autonomy.ASSISTED : complete && goalId != null ? Autonomy.AUTONOMOUS : Autonomy.UNVERIFIABLE;
		return new Report(autonomy, agentId, goalRevision, goalId, world, complete, count, retained, gaps);
	}

	/** One line: an exact header of key=value fields in fixed order, then retained items after " | ". */
	public static String format(String agentName, Report report) {
		StringBuilder line = new StringBuilder("audit=v2 agent=").append(bounded(agentName, 64).replace(' ', '_'))
				.append(" agentId=").append(report.agentId())
				.append(" goalRevision=").append(report.goalId() == null ? "none" : Long.toString(report.goalRevision()))
				.append(" goal=").append(report.goalId() == null ? "none" : report.goalId())
				.append(" world=").append(report.world().name().toLowerCase(Locale.ROOT))
				.append(" coverage=").append(report.coverageComplete() ? "complete" : "partial")
				.append(" interventions=").append(report.count())
				.append(" autonomy=").append(report.autonomy().name().toLowerCase(Locale.ROOT));
		for (Intervention intervention : report.retained()) line.append(" | by ").append(intervention.source()).append(": ").append(intervention.command());
		for (String gap : report.gaps()) line.append(" | uncovered: ").append(bounded(gap, 128));
		return line.toString();
	}

	// Retained text cannot contain '=' or '|', so it can never forge a header field such as autonomy=autonomous.
	static String bounded(String value, int limit) {
		String text = value == null ? "" : value.replaceAll("[\\p{Cntrl}|]", " ").replace('=', '~');
		return text.length() <= limit ? text : text.substring(0, limit);
	}

	private static final class AgentState {
		final boolean observedFromCreation;
		final Map<UUID, Report> frozen = new HashMap<>();
		final Set<UUID> changedGoals = new HashSet<>();
		final Set<UUID> steeredGoals = new HashSet<>();
		UUID firstGoal;
		UUID openGoal;
		long openRevision;
		UUID lastGoal;
		long lastRevision;

		AgentState(boolean observedFromCreation) {
			this.observedFromCreation = observedFromCreation;
		}

		void freeze(AgentInterventionAudit audit, UUID agentId, UUID goalId, long revision) {
			frozen.putIfAbsent(goalId, audit.live(agentId, observedFromCreation, revision, goalId));
		}
	}
}
