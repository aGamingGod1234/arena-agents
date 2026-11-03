package dev.agaminggod.arenaagents.control;

import java.util.List;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * What a control snapshot may show the player who asked for it. Free text (goals, summaries, errors, status) comes
 * from prompts and provider diagnostics, so it is scrubbed of credentials, environment values and home-directory
 * paths for everyone. A player who cannot control agents also gets no goal, summary or error text at all.
 */
public final class AgentControlRedaction {
	public static final String REDACTED = "[REDACTED]";
	private static final String HOME = "~";
	private static final List<Rule> RULES = List.of(
			// Authorization schemes first, so the key rule below cannot leave the credential after "Bearer".
			new Rule(Pattern.compile("(?i)\\b(bearer|basic)\\s+[A-Za-z0-9._~+/=-]{8,}"), "$1 " + REDACTED),
			// Environment assignments: VALUE of NAME=VALUE, for upper-case names with an underscore or well-known ones.
			new Rule(Pattern.compile("\\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|PATH|HOME|USER|USERNAME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR)=(\"[^\"]*\"|'[^']*'|[^\\s;&|,]+)"),
					"$1=" + REDACTED),
			new Rule(Pattern.compile("(?i)\\b(authorization|x-api-key|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|auth[-_ ]?token|token|secret|password|passwd)(\\s*[:=]\\s*)(?!(?i:bearer|basic)\\s)(\"[^\"]*\"|'[^']*'|[^\\s,;]+)"),
					"$1$2" + REDACTED),
			// Provider credential shapes.
			new Rule(Pattern.compile("\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}"), REDACTED),
			new Rule(Pattern.compile("\\bAIza[0-9A-Za-z_-]{30,}"), REDACTED),
			new Rule(Pattern.compile("\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})"), REDACTED),
			new Rule(Pattern.compile("\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}"), REDACTED),
			// Any other long opaque run of letters and digits (not a UUID, which has short hyphenated groups).
			new Rule(Pattern.compile("\\b(?=[A-Za-z0-9_+-]*[0-9])(?=[A-Za-z0-9_+-]*[A-Za-z])[A-Za-z0-9_+-]{40,}={0,2}"), REDACTED),
			// Home directories name the machine's user; keep the rest of the path.
			new Rule(Pattern.compile("(?i)\\b[A-Z]:[\\\\/]+(?:Users|Documents and Settings)[\\\\/]+[^\\\\/\\s\"':;]+"), HOME),
			new Rule(Pattern.compile("(?<![A-Za-z0-9._-])/(?:home|Users)/[^/\\s\"':;]+"), HOME),
			new Rule(Pattern.compile("(?<![A-Za-z0-9._-])/root(?=/|\\b)"), HOME)
	);

	private AgentControlRedaction() {
	}

	/** Scrubs one free-text field and keeps it within {@code maximumLength} characters. */
	public static String redactText(String value, int maximumLength) {
		String text = Objects.requireNonNull(value, "value must not be null");
		if (maximumLength < 0) throw new IllegalArgumentException("maximumLength must not be negative");
		for (Rule rule : RULES) text = rule.pattern().matcher(text).replaceAll(rule.replacement());
		return AgentControlAgent.truncate(text, maximumLength);
	}

	/** The snapshot as its requester may see it, keyed on the snapshot's own {@code canControl}. */
	public static AgentControlSnapshot forViewer(AgentControlSnapshot snapshot) {
		Objects.requireNonNull(snapshot, "snapshot must not be null");
		String status = redactText(snapshot.automationStatus(), 160);
		return new AgentControlSnapshot(
				snapshot.schemaVersion(), snapshot.canControl(), snapshot.automationAvailable(),
				status.isBlank() ? REDACTED : status, snapshot.generatedAtEpochMs(),
				snapshot.agents().stream().map(agent -> forViewer(agent, snapshot.canControl())).toList(),
				snapshot.groups(), snapshot.catalog(), snapshot.providers()
		);
	}

	static AgentControlAgent forViewer(AgentControlAgent agent, boolean canControl) {
		return new AgentControlAgent(
				agent.agentId(), agent.shortId(), agent.displayName(), agent.friendlyName(), agent.provider(),
				agent.model(), agent.reasoning(), agent.playerName(), agent.skinVariant(), agent.state(),
				canControl ? redactText(agent.currentGoal(), AgentControlAgent.MAX_CURRENT_GOAL_LENGTH) : "",
				agent.queuedGoalCount(),
				canControl ? redactText(agent.lastSummary(), AgentControlAgent.MAX_LAST_SUMMARY_LENGTH) : "",
				canControl ? redactText(agent.lastError(), AgentControlAgent.MAX_LAST_ERROR_LENGTH) : "",
				agent.automaticProgress(), agent.entityPresent()
		);
	}

	/** {@code replacement} uses {@link java.util.regex.Matcher} group syntax ({@code $1}). */
	private record Rule(Pattern pattern, String replacement) {
	}
}
