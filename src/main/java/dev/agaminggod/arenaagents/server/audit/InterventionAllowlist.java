package dev.agaminggod.arenaagents.server.audit;

import java.util.List;
import java.util.Set;

/**
 * The only commands a run can see and still be autonomous, identified by the parsed Brigadier node path: one token
 * per parsed node, a literal as its text and an argument as {@code <name:raw text>}. Everything else that parses, by
 * anyone, is an intervention. This is deliberately not an attempt to work out who a command helped.
 */
public final class InterventionAllowlist {
	/**
	 * SETUP_ONLY: before any agent exists (world rules, the runner's temporary spawn ticket); AGENT_CREATE: the first and
	 * only agent; GOAL_START: the first and only goal; TICKET_RELEASE: releasing a setup ticket before any goal starts.
	 */
	public enum Verdict { ALLOWED, SETUP_ONLY, AGENT_CREATE, GOAL_START, TICKET_RELEASE, INTERVENTION }

	/** Read-only queries and the coordinator's own agent operations, allowed at any time. */
	private static final List<String> ALWAYS = List.of(
			"seed", "list", "list uuids", "difficulty", "tick query",
			"time query gametime", "time query *",
			"data get entity * **", "data get block * **", "data get storage * **",
			"attribute * * get **", "attribute * * base get **", "attribute * * modifier value get * **",
			"experience query * levels", "experience query * points",
			"forceload query **", "codex list", "codex status **", "codex audit *",
			// Ending a run: stopping or removing the agent changes nothing it could still use.
			"codex stop *", "codex remove *");
	/** gamerule <rule> reads; the rule is a literal node. */
	private static final List<String> READ_RULE = List.of("gamerule ?");
	private static final Set<String> EXECUTE_MODIFIERS = Set.of(
			"in", "positioned", "at", "as", "facing", "rotated", "align", "anchored", "on", "if", "unless",
			"entity", "items", "block", "blocks", "loaded", "dimension", "biome", "score", "matches", "data", "storage",
			"predicate", "all", "masked", "eyes", "feet", "over", "attacker", "controller", "leasher", "origin", "owner",
			"passengers", "target", "vehicle");

	private InterventionAllowlist() {
	}

	/** path is null when the input did not parse to an executable command (it then runs nothing). */
	public static Verdict classify(List<String> path) {
		if (path == null || path.isEmpty()) return Verdict.ALLOWED;
		List<String> tokens = path.getFirst().equals("xp") ? concat("experience", path.subList(1, path.size())) : path;
		if (tokens.getFirst().equals("execute")) return classifyExecute(tokens);
		if (matchesAny(READ_RULE, tokens)) return Verdict.ALLOWED;
		if (matchesAny(ALWAYS, tokens)) return Verdict.ALLOWED;
		if (tokens.size() == 3 && tokens.getFirst().equals("gamerule") && isLiteral(tokens.get(1)) && !isLiteral(tokens.get(2))) return Verdict.SETUP_ONLY;
		if (matches(List.of("forceload", "add", "*"), tokens)) return Verdict.SETUP_ONLY;
		if (matches(List.of("forceload", "remove", "*"), tokens)) return Verdict.TICKET_RELEASE;
		if (matches(List.of("codex", "summon-configured", "*", "*", "*", "*", "<game_mode:survival>", "*"), tokens)) return Verdict.AGENT_CREATE;
		if (matches(List.of("codex", "start", "*", "*"), tokens)) return Verdict.GOAL_START;
		return Verdict.INTERVENTION;
	}

	private static Verdict classifyExecute(List<String> tokens) {
		for (int index = 1; index < tokens.size(); index++) {
			String token = tokens.get(index);
			if (token.equals("run")) return classify(tokens.subList(index + 1, tokens.size()));
			// store writes, summon creates, and if/unless function runs a function: none are queries.
			if (isLiteral(token) && !EXECUTE_MODIFIERS.contains(token)) return Verdict.INTERVENTION;
		}
		return Verdict.ALLOWED;
	}

	static boolean matchesAny(List<String> patterns, List<String> tokens) {
		for (String pattern : patterns) if (matches(List.of(pattern.split(" ")), tokens)) return true;
		return false;
	}

	/** '*' one argument, '**' any number of trailing arguments, '?' one literal, else an exact token. */
	static boolean matches(List<String> pattern, List<String> tokens) {
		int index = 0;
		for (int position = 0; position < pattern.size(); position++) {
			String expected = pattern.get(position);
			if (expected.equals("**")) {
				for (; index < tokens.size(); index++) if (isLiteral(tokens.get(index))) return false;
				return true;
			}
			if (index >= tokens.size()) return false;
			String actual = tokens.get(index++);
			boolean ok = switch (expected) {
				case "*" -> !isLiteral(actual);
				case "?" -> isLiteral(actual);
				default -> expected.equals(actual);
			};
			if (!ok) return false;
		}
		return index == tokens.size();
	}

	static boolean isLiteral(String token) {
		return !token.startsWith("<");
	}

	private static List<String> concat(String head, List<String> tail) {
		java.util.ArrayList<String> joined = new java.util.ArrayList<>(tail.size() + 1);
		joined.add(head);
		joined.addAll(tail);
		return joined;
	}
}
