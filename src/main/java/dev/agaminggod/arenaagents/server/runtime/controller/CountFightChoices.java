package dev.agaminggod.arenaagents.server.runtime.controller;

import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.agent.AgentDomainException;

/**
 * The model's explicit fight_target / use_ranged options carried into count mode (untilItem + untilCount), where the
 * fight_until engine runs every engagement. A field the model did not give is null and the engine keeps its default:
 * pursue on, the shield raised in melee only against blazes, no crouch, the default fight range, a 1 s draw, tracking,
 * the named target first and then the nearest mob of its type (attackers first), no other mob types, no players.
 */
public record CountFightChoices(Boolean pursue, Boolean shield, boolean sneak, Double desiredRange, Integer drawDurationMs, Boolean trackTarget,
		CombatPlanning.TargetPolicy targetPolicy, Boolean continueWithAttackers, boolean includePlayers) {
	static final CountFightChoices NONE = new CountFightChoices(null, null, false, null, null, null, CombatPlanning.TargetPolicy.NAMED, null, false);
	/** The options copied from the model's call into the engine's arguments, under these names. */
	static final String[] FIELDS = { "pursue", "shield", "sneak", "desiredRange", "drawDurationMs", "trackTarget",
			"targetPolicy", "continueWithAttackers", "includePlayers" };

	/**
	 * Copies every option the model gave (fight_target: pursue, shield, sneak, desiredRange, targetPolicy,
	 * continueWithAttackers, includePlayers; use_ranged: drawDurationMs, trackTarget).
	 */
	public static void copy(JsonObject call, JsonObject until) {
		for (String field : FIELDS) if (call.has(field) && !call.get(field).isJsonNull()) until.add(field, call.get(field).deepCopy());
	}

	public static CountFightChoices from(JsonObject until) {
		CombatPlanning.TargetPolicy policy;
		try {
			policy = CombatPlanning.TargetPolicy.parse(until.has("targetPolicy") ? until.get("targetPolicy").getAsString() : null);
		} catch (IllegalArgumentException unknown) {
			throw new AgentDomainException("INVALID_FIELD", "targetPolicy: " + unknown.getMessage());
		}
		return new CountFightChoices(
				until.has("pursue") ? until.get("pursue").getAsBoolean() : null,
				until.has("shield") ? until.get("shield").getAsBoolean() : null,
				until.has("sneak") && until.get("sneak").getAsBoolean(),
				until.has("desiredRange") ? until.get("desiredRange").getAsDouble() : null,
				until.has("drawDurationMs") ? until.get("drawDurationMs").getAsInt() : null,
				until.has("trackTarget") ? until.get("trackTarget").getAsBoolean() : null,
				policy,
				until.has("continueWithAttackers") ? until.get("continueWithAttackers").getAsBoolean() : null,
				until.has("includePlayers") && until.get("includePlayers").getAsBoolean());
	}

	/**
	 * pursue:false fights in place: no closing in, no cover moves, no backing off to heal, no ledge trips, no fire-exit
	 * steps and no pillar; where safety needs one of those the engine hands back instead.
	 */
	boolean mayMove() {
		return pursue == null || pursue;
	}

	/**
	 * The engine's own repositioning walks (backing off to cover, cover steps) run on navigation, which walks upright:
	 * with sneak:true the body keeps its crouch and stays where it is instead.
	 */
	boolean mayReposition() {
		return mayMove() && !sneak;
	}

	/** Drops are walked to by default unless the model chose to fight in place (pursue:false); an explicit collect wins. */
	boolean collectByDefault() {
		return mayMove();
	}

	/** Melee pursuit: the model's pursue (default on), never from inside a roof shelter. */
	boolean meleePursue(boolean roofed) {
		return !roofed && mayMove();
	}

	/** The shield between swings: the model's shield:true against every mob, shield:false never, by default blazes only. */
	boolean meleeShield(boolean shieldInOffhand, boolean blazes) {
		return shieldInOffhand && (shield != null ? shield : blazes);
	}

	/** The shot guard, charge guard and backing off with the shield up run unless the model said shield:false. */
	boolean guardShield(boolean shieldInOffhand) {
		return shieldInOffhand && (shield == null || shield);
	}

	int draw() {
		return drawDurationMs != null ? drawDurationMs : 1000;
	}

	boolean track() {
		return trackTarget == null || trackTarget;
	}

	/** fight_target's follow-through rule (CombatPlanning.followThrough): continueWithAttackers:true, or a targetPolicy. */
	boolean followThrough() {
		return CombatPlanning.followThrough(continueWithAttackers, targetPolicy);
	}

	/**
	 * Whether the engine may fight this entity (after fight_target's gates). The mob type the call counts drops from is
	 * always a candidate; another type only while it attacks the body and the model opted into follow-through, as
	 * fight_target follows through. Players (another of the named player's type included) only with includePlayers.
	 */
	boolean candidate(boolean ofMobType, boolean attacking, boolean player) {
		if (player && !CombatPlanning.switchableKind(true, includePlayers)) return false;
		return ofMobType || attacking && followThrough();
	}

	/**
	 * Whether a bow is put down for an attacker in sword reach: one of the mob type always; another type unless the
	 * model said continueWithAttackers:false (fight only the target's kind). Players are never turned to here.
	 */
	boolean reachTurn(boolean ofMobType) {
		return ofMobType || continueWithAttackers == null || continueWithAttackers;
	}
}
