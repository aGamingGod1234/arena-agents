package dev.agaminggod.arenaagents.server.watch;

import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.function.Predicate;

/**
 * The single place where an episode gets its one label. {@link #RULES} is checked in order and the first that holds
 * wins; tune labels here. BODY_CAUSED needs real harm: a body move that only came close is recorded on the
 * episode ({@code body.causedByAction}) but labelled by the next rule. Precedence: BODY_CAUSED > REFLEX_FAILED > REFLEX_SLOW > UNPERCEIVABLE > PERCEPTION_GAP >
 * NO_PRIMITIVE > FACT_GAP > MODEL_CHOICE (the fallback: the system had what it needed).
 */
public final class Diagnosis {
	/** Danger kinds that are terrain or body hazards a body action can walk or dig into. */
	static final Set<String> ENVIRONMENT = Set.of("lava", "lava_hidden", "fire", "drop", "void", "fall");

	/**
	 * Reflex condition types whose trigger covers each danger kind. A kind with no entry has no reflex vocabulary
	 * (NO_PRIMITIVE). Rules with any of these in their {@code when} count as covering the danger.
	 */
	static final Map<String, Set<String>> COVERAGE = Map.ofEntries(
			Map.entry("creeper", Set.of("creeper_fusing", "hostile_near", "exposed", "target_in_reach", "attacked_from_behind")),
			Map.entry("mob", Set.of("hostile_near", "target_in_reach", "exposed", "attacked_from_behind", "health_below")),
			Map.entry("ranged_mob", Set.of("incoming_projectile", "hostile_near", "exposed", "target_in_reach", "health_below")),
			Map.entry("blaze", Set.of("fireball_incoming", "incoming_projectile", "hostile_near", "exposed", "target_in_reach", "on_fire")),
			Map.entry("ghast", Set.of("fireball_incoming", "incoming_projectile", "hostile_near", "exposed")),
			Map.entry("piglin", Set.of("hostile_near", "target_in_reach", "exposed", "incoming_projectile", "attacked_from_behind")),
			Map.entry("enderman", Set.of("enderman_gaze", "enderman_provoked", "hostile_near", "target_in_reach", "attacked_from_behind")),
			Map.entry("wither_skeleton", Set.of("hostile_near", "target_in_reach", "exposed", "attacked_from_behind")),
			Map.entry("dragon", Set.of("hostile_near", "exposed", "fireball_incoming", "health_below")),
			Map.entry("dragon_breath", Set.of("cloud_near")),
			Map.entry("projectile", Set.of("incoming_projectile", "fireball_incoming", "health_below")),
			Map.entry("lava", Set.of("lava_near", "lava_flowing", "in_lava", "on_fire")),
			Map.entry("fire", Set.of("in_fire", "on_fire")),
			Map.entry("burning", Set.of("on_fire", "in_fire", "in_lava")),
			Map.entry("drop", Set.of("edge_near", "falling")),
			Map.entry("void", Set.of("edge_near", "falling")),
			Map.entry("fall", Set.of("falling")),
			Map.entry("drowning", Set.of("air_below")),
			Map.entry("low_health", Set.of("health_below")),
			Map.entry("starving", Set.of("hunger_below", "health_below")));

	/** Harm from the model's own deliberate act (a thrown pearl hurts only its thrower); no reflex should stop it. */
	static final Set<String> SELF_INFLICTED = Set.of("ender_pearl");

	/** Mob kinds a threat row describes (signals, trend, expected hit); projectiles and clouds have their own sections. */
	static final Set<String> THREAT_ROW_KINDS = Set.of("creeper", "mob", "ranged_mob", "blaze", "ghast", "piglin", "enderman",
			"wither_skeleton", "dragon");

	/** What the rules read: one closed episode plus whether the reflex vocabulary has any covering condition. */
	public record Inputs(Episode episode, boolean primitiveExists) {
		boolean harmed() { return episode.died || episode.damage > 0.0F; }
	}

	public record Rule(String label, Predicate<Inputs> holds, Function<Inputs, String> evidence) {
	}

	public static final List<Rule> RULES = List.of(
			new Rule("BODY_CAUSED", in -> in.episode().causedByAction && in.harmed(),
					in -> "body action " + in.episode().action + " moved toward the " + in.episode().kind + " while no reflex fired"),
			new Rule("REFLEX_FAILED", in -> in.harmed() && !in.episode().fired.isEmpty() && firstFiring(in) <= harmAt(in),
					in -> "covering reflex " + firings(in) + " fired in time but " + harmText(in) + " followed"),
			// Slow only for a rule armed when the danger opened: one armed after the harm began (live run d19-iron-a: the
			// model armed in_fire 9 s into a burn with only in_lava armed) was missing, not slow.
			new Rule("REFLEX_SLOW", in -> in.harmed() && !in.episode().fired.isEmpty() && !in.episode().armed.isEmpty(),
					in -> "covering reflex " + firings(in) + " first fired " + (firstFiring(in) - harmAt(in)) + " ms after the first harm"),
			new Rule("UNPERCEIVABLE", in -> !in.episode().perceivable,
					in -> "no line of sight or sound a player would have for the " + in.episode().kind),
			new Rule("PERCEPTION_GAP", in -> !in.episode().inObservation,
					in -> "perceivable " + in.episode().kind + " was not in the agent's last observation"),
			new Rule("NO_PRIMITIVE", in -> !in.primitiveExists() && !SELF_INFLICTED.contains(in.episode().kind),
					in -> "no reflex condition covers kind " + in.episode().kind),
			new Rule("FACT_GAP", in -> THREAT_ROW_KINDS.contains(in.episode().kind) && !in.episode().inThreatFacts,
					in -> "the " + in.episode().sourceType + (in.episode().seenRow ? " was in the observation but not listed as a threat"
							: " was only heard (a sound's direction and range): no row and no threat facts")),
			new Rule("MODEL_CHOICE", in -> true,
					in -> "observed" + (in.episode().firstObservedAt == null ? "" : " since " + in.episode().firstObservedAt)
							+ "; covering rules armed " + (in.episode().armed.isEmpty() ? "none" : String.join(",", in.episode().armed))
							+ (in.harmed() && !in.episode().fired.isEmpty() ? "; covering reflex armed later, " + firings(in) + " first fired "
									+ (firstFiring(in) - harmAt(in)) + " ms after the first harm" : "")
							+ "; last model reply " + (in.episode().lastReplyAgoS == null ? "unknown"
							: String.format(Locale.ROOT, "%.1f s", in.episode().lastReplyAgoS)) + " before; outcome " + in.episode().outcome));

	private Diagnosis() {
	}

	public static boolean primitiveExists(String kind, Set<String> vocabulary) {
		Set<String> covering = COVERAGE.get(kind);
		if (covering == null) return false;
		for (String type : covering) if (vocabulary.contains(type)) return true;
		return false;
	}

	/** Labels the episode (sets {@code diagnosis} and {@code evidence}). */
	public static void diagnose(Episode episode, Set<String> vocabulary) {
		Inputs inputs = new Inputs(episode, primitiveExists(episode.kind, vocabulary));
		for (Rule rule : RULES) {
			if (!rule.holds().test(inputs)) continue;
			episode.diagnosis = rule.label();
			episode.evidence = rule.evidence().apply(inputs);
			return;
		}
	}

	private static long firstFiring(Inputs in) {
		long first = Long.MAX_VALUE;
		for (Episode.Firing firing : in.episode().fired) first = Math.min(first, firing.atMs());
		return first;
	}

	private static long harmAt(Inputs in) {
		return in.episode().firstHarmEpochMs < 0L ? in.episode().closedEpochMs : in.episode().firstHarmEpochMs;
	}

	private static String firings(Inputs in) {
		StringBuilder text = new StringBuilder();
		for (Episode.Firing firing : in.episode().fired) {
			if (!text.isEmpty()) text.append(',');
			text.append(firing.rule()).append('=').append(firing.result());
		}
		return text.toString();
	}

	private static String harmText(Inputs in) {
		return in.episode().died ? "death" : String.format(Locale.ROOT, "%.1f damage", in.episode().damage);
	}
}
