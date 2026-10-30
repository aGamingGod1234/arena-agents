package dev.agaminggod.arenaagents.server.runtime.controller;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * d41 review 3: count mode keeps the model's explicit fight options (F2), every engagement passes fight_target's target
 * gates (F3), cover is weighed from the first tick (F6), and the combat input lease never outlives the call (F7).
 */
public final class CountFightVerification {
	private static int assertions;

	private CountFightVerification() {
	}

	public static void main(String[] args) {
		System.out.println("CountFightVerification: " + verify() + " assertions passed");
	}

	public static int verify() {
		assertions = 0;
		verifyExplicitChoicesSurvive();
		verifyDefaultsUnchanged();
		verifyEngagementGates();
		verifyCoverSentinel();
		verifyTerminalLeaseRelease();
		verifyTargetingChoicesSurvive();
		verifyStationaryStance();
		verifyRound3Gates();
		return assertions;
	}

	private static void verifyExplicitChoicesSurvive() {
		JsonObject call = JsonParser.parseString("{\"targetId\":\"b\",\"untilItem\":\"minecraft:blaze_rod\",\"untilCount\":6,"
				+ "\"pursue\":false,\"shield\":true,\"sneak\":true,\"desiredRange\":4.0}").getAsJsonObject();
		JsonObject until = new JsonObject();
		CountFightChoices.copy(call, until);
		for (String field : new String[] { "pursue", "shield", "sneak", "desiredRange" })
			check(until.has(field) && until.get(field).equals(call.get(field)), "count mode carries the model's " + field);
		CountFightChoices kept = CountFightChoices.from(until);
		check(!kept.mayMove() && !kept.meleePursue(false), "pursue:false fights in place (no closing in, cover, backing off or ledge trips)");
		check(kept.meleeShield(true, false), "shield:true shields against every mob, not only blazes");
		check(kept.sneak() && kept.desiredRange() == 4.0D, "sneak and desiredRange reach every melee engagement");

		JsonObject down = new JsonObject();
		CountFightChoices.copy(JsonParser.parseString("{\"shield\":false}").getAsJsonObject(), down);
		CountFightChoices noShield = CountFightChoices.from(down);
		check(!noShield.meleeShield(true, true) && !noShield.guardShield(true), "shield:false keeps the shield down, blazes included");

		JsonObject bow = new JsonObject();
		CountFightChoices.copy(JsonParser.parseString("{\"drawDurationMs\":1500,\"trackTarget\":false}").getAsJsonObject(), bow);
		CountFightChoices volley = CountFightChoices.from(bow);
		check(volley.draw() == 1500 && !volley.track(), "use_ranged count mode keeps the model's draw and tracking");
	}

	private static void verifyDefaultsUnchanged() {
		CountFightChoices none = CountFightChoices.from(new JsonObject());
		check(none.mayMove() && none.meleePursue(false) && !none.meleePursue(true), "no pursue given: pursue outside a roof, in place under it");
		check(none.meleeShield(true, true) && !none.meleeShield(true, false) && !none.meleeShield(false, true), "no shield given: melee shield against blazes only, with one in the offhand");
		check(none.guardShield(true) && !none.guardShield(false), "no shield given: the shot guard runs with an offhand shield");
		check(!none.sneak() && none.desiredRange() == null && none.draw() == 1000 && none.track(), "engine defaults otherwise");
	}

	private static void verifyEngagementGates() {
		check(ServerFightUntilController.engageable(true, false, true), "a living target the policy allows is engaged");
		check(!ServerFightUntilController.engageable(true, false, false), "a target the protection policy denies is never engaged");
		check(!ServerFightUntilController.engageable(true, true, true), "creative or spectator players are never engaged");
		check(!ServerFightUntilController.engageable(false, false, true), "a dead target is never engaged");
	}

	private static void verifyCoverSentinel() {
		long tick = 123_456L;
		check(tick - ServerFightUntilController.COVER_NEVER < ServerFightUntilController.COVER_EVERY_TICKS,
				"the old check overflowed: gameTick - Long.MIN_VALUE is negative, so cover never ran");
		check(ServerFightUntilController.coverDue(tick, ServerFightUntilController.COVER_NEVER), "cover is weighed on the first check");
		check(!ServerFightUntilController.COVER, "cover steps stay off by default (they raised floor-fixture deaths once they ran)");
		check(!ServerFightUntilController.coverDue(tick + 10L, tick), "then not again within 40 ticks");
		check(ServerFightUntilController.coverDue(tick + ServerFightUntilController.COVER_EVERY_TICKS, tick), "and again after 40 ticks");
		check(ServerFightUntilController.coverDue(0L, ServerFightUntilController.COVER_NEVER), "also at game tick 0");
		// Cover now runs, so its walk can sit un-ticked while no target is seen: it is put down before the 40-tick lease expiry.
		check(!ServerFightUntilController.stepIdle(tick + 1L, tick), "a walk ticked last tick is kept");
		check(ServerFightUntilController.stepIdle(tick + 21L, tick), "a walk idle for over a second is put down");
		check(21L < dev.agaminggod.arenaagents.server.runtime.input.LeasedServerInputController.LEASE_TIMEOUT_TICKS, "before its input lease expires");
	}

	private static void verifyTerminalLeaseRelease() {
		check(ServerFightUntilController.holdsGuardLease(false, true, false, false), "between ticks of backing off the raised shield's lease is kept");
		check(!ServerFightUntilController.holdsGuardLease(true, true, false, false), "a stop or cancel while backing off releases the combat input");
		check(!ServerFightUntilController.holdsGuardLease(true, false, true, true), "the call's end releases it in every state");
		check(!ServerFightUntilController.holdsGuardLease(false, false, false, false), "outside recovery it is released as before");
	}

	/** Review 3 round 2 MUST 1: targetPolicy, continueWithAttackers and includePlayers reach count-mode targeting. */
	private static void verifyTargetingChoicesSurvive() {
		JsonObject call = JsonParser.parseString("{\"targetId\":\"b\",\"untilItem\":\"minecraft:blaze_rod\",\"untilCount\":6,"
				+ "\"targetPolicy\":\"highest_risk\",\"continueWithAttackers\":true,\"includePlayers\":true}").getAsJsonObject();
		JsonObject until = new JsonObject();
		CountFightChoices.copy(call, until);
		for (String field : new String[] { "targetPolicy", "continueWithAttackers", "includePlayers" })
			check(until.has(field) && until.get(field).equals(call.get(field)), "count promotion carries the model's " + field);
		CountFightChoices kept = CountFightChoices.from(until);
		check(kept.targetPolicy() == CombatPlanning.TargetPolicy.HIGHEST_RISK, "targetPolicy reaches the engine");
		check(kept.followThrough() && kept.candidate(false, true, false), "continueWithAttackers:true: another kind attacking the body is a candidate");
		check(!kept.candidate(false, false, false), "but never one that is not attacking (a policy never starts a new fight)");
		check(kept.candidate(false, true, true) && kept.candidate(true, false, true), "includePlayers:true: players are candidates");

		CountFightChoices none = CountFightChoices.from(new JsonObject());
		check(none.targetPolicy() == CombatPlanning.TargetPolicy.NAMED && !none.followThrough(), "defaults: named target first, no follow-through");
		check(none.candidate(true, false, false) && !none.candidate(false, true, false), "defaults: the mob type only (unchanged)");
		check(!none.candidate(true, true, true) && !none.candidate(false, true, true), "defaults: never a player, attacking or not");
		check(none.reachTurn(true) && none.reachTurn(false), "defaults: the bow is put down for any attacker in sword reach (unchanged)");

		CountFightChoices policyOnly = CountFightChoices.from(JsonParser.parseString("{\"targetPolicy\":\"nearest_attacker\"}").getAsJsonObject());
		check(policyOnly.followThrough() && policyOnly.candidate(false, true, false), "a targetPolicy alone opts into follow-through, as in fight_target");
		CountFightChoices noFollow = CountFightChoices.from(JsonParser.parseString("{\"targetPolicy\":\"nearest_attacker\",\"continueWithAttackers\":false}").getAsJsonObject());
		check(!noFollow.followThrough() && !noFollow.candidate(false, true, false), "an explicit continueWithAttackers:false wins over the policy");
		check(noFollow.reachTurn(true) && !noFollow.reachTurn(false), "continueWithAttackers:false: the bow is put down only for the target's kind");
		try {
			CountFightChoices.from(JsonParser.parseString("{\"targetPolicy\":\"weakest\"}").getAsJsonObject());
			check(false, "an unknown targetPolicy is refused");
		} catch (dev.agaminggod.arenaagents.agent.AgentDomainException refused) {
			check("INVALID_FIELD".equals(refused.code()), "an unknown targetPolicy is refused with INVALID_FIELD before the run starts");
		}
		java.util.List<String> fields = java.util.List.of(CountFightChoices.FIELDS);
		check(fields.containsAll(java.util.List.of("targetPolicy", "continueWithAttackers", "includePlayers")), "the executor's copy list names the targeting fields");
	}

	/** Review 3 round 2 MUST 2: pursue:false and sneak:true hold outside melee (guard, recovery, perch, drops). */
	private static void verifyStationaryStance() {
		CountFightChoices still = CountFightChoices.from(JsonParser.parseString("{\"pursue\":false,\"sneak\":true}").getAsJsonObject());
		check(!still.mayMove(), "pursue:false: no fire-exit step, no pillar (the engine hands back ON_FIRE / LOW_HEALTH_BAILOUT instead)");
		check(!still.mayReposition(), "pursue:false: no cover or backing-off walk");
		check(!still.collectByDefault(), "pursue:false: drops are not walked to unless the model said collect:true");
		check(still.sneak(), "sneak:true reaches the guard, recovery and perch inputs");
		CountFightChoices crouched = CountFightChoices.from(JsonParser.parseString("{\"sneak\":true}").getAsJsonObject());
		check(crouched.mayMove() && !crouched.mayReposition(), "sneak:true: fire steps stay (crouched), upright navigation walks to cover do not");
		CountFightChoices none = CountFightChoices.from(new JsonObject());
		check(none.mayMove() && none.mayReposition() && none.collectByDefault() && !none.sneak(), "defaults unchanged");
	}

	/** Review 3 round 3: creepers only when named; the stance lease sits under every part that drives the keys. */
	private static void verifyRound3Gates() {
		check(ServerFightUntilController.followable(true, true), "a count fight the model aimed at creepers fights creepers");
		check(!ServerFightUntilController.followable(false, true), "another kind's creeper is never a follow-through, sword-turn or fallback target");
		check(ServerFightUntilController.followable(false, false), "other attacking kinds stay followable on the model's opt-in");
		check(ServerFightUntilController.STANCE_PRIORITY < 100 && 100 < CombatInputLease.PRIORITY,
				"the sneak:true stance lease is below navigation (100) and combat (200): it fills only ticks nobody drives");
		check(ServerFightUntilController.STILL_REACH_MS < ServerFightUntilController.DEFAULT_TIMEOUT_MS,
				"pursue:false hands back an out-of-reach target before the call's timeout");
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
