package dev.agaminggod.arenaagents.server.runtime.reflex;

import com.google.gson.JsonArray;
import com.google.gson.JsonParser;
import dev.agaminggod.arenaagents.agent.AgentId;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputState;
import dev.agaminggod.arenaagents.server.runtime.input.InputLease;
import dev.agaminggod.arenaagents.server.runtime.input.InputOwner;
import dev.agaminggod.arenaagents.server.runtime.input.InputStateSink;
import dev.agaminggod.arenaagents.server.runtime.input.LeasedServerInputController;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.world.InteractionHand;

/** Reflex rule validation, scheduling semantics and the input hand-back, without a server. */
public final class ReflexVerification {
	private static final ReflexScheduler.ActionStatus RUNNING = ReflexScheduler.ActionStatus.RUNNING;
	private static int assertions;

	private ReflexVerification() {
	}

	public static void main(String[] args) {
		int passed = verify() + ReflexBodyVerification.verify() + ReflexShieldVerification.verify()
				+ dev.agaminggod.arenaagents.server.runtime.input.VanillaMoveInputVerification.verify();
		System.out.println("PASS: " + passed + " shipping controller and reflex assertions");
	}

	public static int verify() {
		assertions = 0;
		shippingClassOrigins();
		validation();
		triggerFiresOnceOnRisingEdge();
		triggerEdgeDuringAnotherFiringFiresAfterIt();
		stanceHoldsWhileTrueAndIsBounded();
		priorityPreemptsAndHandsBack();
		settledHoldYieldsAndEndsDone();
		debounceAndLoopProtection();
		flappingDisables();
		expiry();
		yieldSuppressesStanceUntilConditionClears();
		replaceKeepsUnchangedState();
		leasesRenewAndRebase();
		workVocabulary();
		pausedTimeIsNotActionTime();
		combatVocabulary();
		harmedStanceIsNotProgress();
		heldStanceWakesOnce();
		heldActionReleaseGrace();
		heldShieldComposesWithMovingCommands();
		yieldedStanceReturnsAfterTheCommand();
		yieldedTriggerReturnsAfterTheCommand();
		bailoutHandsBodyToReflexes();
		shieldWalkKeepsCourse();
		shieldReservesHandCommands();
		swimDetourMakesProgress();
		heldInputPassesThrough();
		diggingVocabulary();
		fireVocabulary();
		return assertions;
	}

	/** The work-interruption terms parse with their bounds and reject what a player could not do or see. */
	private static void workVocabulary() {
		List<ReflexSpec.Rule> parsed = rules("""
				[{"id":"fresh-pick","when":{"type":"tool_low","uses":3,"tool":"pickaxe"},"do":{"type":"select","tool":"pickaxe"}},
				 {"id":"loot","priority":2,"when":[{"type":"item_nearby","within":4,"items":["cobblestone"]},{"type":"inventory_full","not":true}],"do":{"type":"pickup","within":4}},
				 {"id":"mlg","priority":9,"when":{"type":"falling","blocks":5},"do":{"type":"place","item":"water_bucket","where":"below"}},
				 {"id":"dusk","when":{"type":"night"},"do":{"type":"stop"},"wake":true},
				 {"id":"refill","when":{"type":"stack_used_up","item":"torch"},"do":{"type":"select","item":"torch"}},
				 {"id":"jitter","when":{"type":"saturation_empty"},"do":{"type":"eat"}}]""");
		check(parsed.size() == 6, "work rules parse");
		check(parsed.get(1).when().get(0).focus(), "a dropped item is the focus a pickup walks to");
		check("minecraft:water_bucket".equals(parsed.get(2).action().text("item")) && "below".equals(parsed.get(2).action().text("where")), "place keeps item and where");
		check("minecraft:torch".equals(parsed.get(4).when().get(0).text("item")), "stack_used_up item gains the namespace");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"tool_low\"},\"do\":{\"type\":\"eat\"}}]", "uses is required");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"item_nearby\",\"within\":20},\"do\":{\"type\":\"pickup\"}}]", "between 1 and 8");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"falling\",\"blocks\":4},\"do\":{\"type\":\"place\",\"item\":\"dirt\",\"where\":\"behind\"}}]", "below");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"falling\",\"blocks\":4},\"do\":{\"type\":\"place\",\"where\":\"below\"}}]", "item is required");
		check(ReflexSpec.conditionTypes().containsAll(List.of("inventory_full", "item_nearby", "tool_low", "falling", "saturation_empty", "night", "stack_used_up"))
				&& ReflexSpec.actionTypes().containsAll(List.of("pickup", "place", "stop")), "work vocabulary registered");
	}

	/** Falling sand or gravel in the head cell: the in-wall view is a condition, mining out of it an action. */
	private static void diggingVocabulary() {
		List<ReflexSpec.Rule> parsed = rules("""
				[{"id":"gravel","priority":9,"when":{"type":"suffocating"},"do":{"type":"dig_out"},"maxMs":6000}]""");
		check(parsed.size() == 1 && "suffocating".equals(parsed.get(0).when().get(0).type()) && "dig_out".equals(parsed.get(0).action().type()), "suffocating -> dig_out parses");
		check(!parsed.get(0).when().get(0).focus(), "suffocating names no entity");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"suffocating\",\"within\":2},\"do\":{\"type\":\"dig_out\"}}]", "within");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"suffocating\"},\"do\":{\"type\":\"dig_out\",\"tool\":\"shovel\"}}]", "tool");
	}

	/** A fire block at the feet (a blaze fireball's): its contact is a condition, stepping out of the flames an action. */
	private static void fireVocabulary() {
		List<ReflexSpec.Rule> parsed = rules("""
				[{"id":"flames","priority":9,"when":{"type":"in_fire"},"do":{"type":"leave_fire"},"maxMs":3000}]""");
		check(parsed.size() == 1 && "in_fire".equals(parsed.get(0).when().get(0).type()) && "leave_fire".equals(parsed.get(0).action().type()), "in_fire -> leave_fire parses");
		check(!parsed.get(0).when().get(0).focus(), "in_fire names no entity");
		List<ReflexSpec.Rule> hot = rules("""
				[{"id":"magma","priority":9,"when":{"type":"on_hot_floor"},"do":{"type":"leave_fire"},"maxMs":3000}]""");
		check(hot.size() == 1 && "on_hot_floor".equals(hot.get(0).when().get(0).type()), "hot-floor contact is distinct from burning");

		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"in_fire\",\"within\":2},\"do\":{\"type\":\"leave_fire\"}}]", "within");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"in_fire\"},\"do\":{\"type\":\"leave_fire\",\"blocks\":3}}]", "blocks");
		List<ReflexSpec.Rule> lava = rules("""
				[{"id":"lava","priority":9,"when":{"type":"in_lava"},"do":{"type":"leave_lava"},"maxMs":4000}]""");
		check(lava.size() == 1 && "leave_lava".equals(lava.get(0).action().type()), "in_lava -> leave_lava parses");
		// The coordinator's default edge rule (ruling 16): a stance whose brace never takes the body.
		List<ReflexSpec.Rule> brace = rules("""
				[{"id":"default-edge","kind":"stance","priority":7,"when":[{"type":"edge_near","within":2,"direction":"any","drop":4}],"do":{"type":"brace"},"ttlMs":3600000}]""");
		check(brace.size() == 1 && "brace".equals(brace.get(0).action().type()), "edge_near -> brace parses");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"edge_near\"},\"do\":{\"type\":\"brace\",\"blocks\":2}}]", "blocks");
	}

	/** Time an action waits paused under a firing is skipped by its accumulators, including ones created while paused. */
	private static void pausedTimeIsNotActionTime() {
		var timeout = new dev.agaminggod.arenaagents.server.runtime.ElapsedTimeAccumulator(1_000L);
		long restore = dev.agaminggod.arenaagents.server.runtime.ElapsedTimeAccumulator.pausedFor(0L);
		check(timeout.advance(2_000L) == 1_000L, "unpaused time counts");
		// A 5 s firing: the next tick of the action happens at 7_000 with 5_000 paused.
		dev.agaminggod.arenaagents.server.runtime.ElapsedTimeAccumulator.pausedFor(5_000L);
		check(timeout.advance(7_000L) == 1_000L, "paused time does not count");
		var stall = new dev.agaminggod.arenaagents.server.runtime.ElapsedTimeAccumulator(7_000L);
		check(timeout.advance(7_500L) == 1_500L && stall.advance(7_500L) == 500L, "accumulators made after the pause keep counting run time");
		dev.agaminggod.arenaagents.server.runtime.ElapsedTimeAccumulator.pausedFor(restore);
	}

	private static List<ReflexSpec.Rule> rules(String json) {
		return ReflexSpec.parseRules(JsonParser.parseString(json).getAsJsonArray());
	}

	private static void validation() {
		List<ReflexSpec.Rule> parsed = rules("""
				[{"id":"blaze-shield","kind":"stance","priority":7,"when":[{"type":"hostile_near","within":12,"mobs":["blaze"]},{"type":"incoming_projectile","not":true}],"do":{"type":"shield"}},
				 {"id":"tool-swap","when":{"type":"tool_broke","tool":"pickaxe"},"do":{"type":"select","tool":"pickaxe"}}]""");
		check(parsed.size() == 2, "two rules parse");
		check(parsed.get(0).when().get(0).ids("mobs").contains("minecraft:blaze"), "bare mob ids gain the minecraft namespace");
		check(parsed.get(0).maxMs() == ReflexSpec.MAX_SHIELD_STANCE_MS, "stance default bound");
		check(parsed.get(1).kind() == ReflexSpec.Kind.TRIGGER && parsed.get(1).priority() == 5, "trigger and priority defaults");
		check(parsed.get(0).when().get(0).focus() && !parsed.get(0).when().get(1).focus(), "negated conditions supply no focus");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"teleport_home\"},\"do\":{\"type\":\"eat\"}}]", "is not a reflex condition");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"health_below\"},\"do\":{\"type\":\"eat\"}}]", "value is required");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"health_below\",\"value\":99},\"do\":{\"type\":\"eat\"}}]", "between 1 and 40");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"on_fire\",\"not\":true},\"do\":{\"type\":\"eat\"}}]", "not negated");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"on_fire\"},\"do\":{\"type\":\"select\"}}]", "exactly one of tool or item");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"on_fire\"},\"do\":{\"type\":\"eat\"},\"maxMs\":60000}]", "maxMs");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"on_fire\"},\"do\":{\"type\":\"eat\"}},{\"id\":\"a\",\"when\":{\"type\":\"on_fire\"},\"do\":{\"type\":\"eat\"}}]", "duplicate");
		StringBuilder many = new StringBuilder("[");
		for (int index = 0; index <= ReflexSpec.MAX_RULES; index++) {
			if (index > 0) many.append(',');
			many.append("{\"id\":\"r").append(index).append("\",\"when\":{\"type\":\"on_fire\"},\"do\":{\"type\":\"eat\"}}");
		}
		rejects(many.append(']').toString(), "at most " + ReflexSpec.MAX_RULES);
	}

	private static void rejects(String json, String fragment) {
		try {
			rules(json);
			throw new AssertionError("expected rejection containing " + fragment);
		} catch (ReflexSpec.InvalidRuleException expected) {
			check(expected.getMessage().contains(fragment), "rejection names " + fragment + ": " + expected.getMessage());
		}
	}

	private static Map<String, ReflexScheduler.Sense> sense(Object... pairs) {
		Map<String, ReflexScheduler.Sense> map = new HashMap<>();
		for (int index = 0; index < pairs.length; index += 2) map.put((String) pairs[index], new ReflexScheduler.Sense((Boolean) pairs[index + 1], false));
		return map;
	}

	private static void triggerFiresOnceOnRisingEdge() {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(rules("[{\"id\":\"swap\",\"when\":{\"type\":\"tool_broke\"},\"do\":{\"type\":\"select\",\"tool\":\"any\"}}]"), 0);
		ReflexScheduler.Decision first = scheduler.step(1, sense("swap", true), RUNNING, "", false);
		check("swap".equals(first.started()), "a trigger fires on its rising edge");
		ReflexScheduler.Decision done = scheduler.step(2, sense("swap", true), ReflexScheduler.ActionStatus.DONE, "selected", false);
		check(done.endOutcome() == ReflexScheduler.Outcome.DONE && done.started() == null, "a finished trigger ends");
		for (long tick = 3; tick < 60; tick++) {
			check(scheduler.step(tick, sense("swap", true), RUNNING, "", false).started() == null, "a held condition does not refire a trigger");
		}
		scheduler.step(60, sense("swap", false), RUNNING, "", false);
		check("swap".equals(scheduler.step(61, sense("swap", true), RUNNING, "", false).started()), "a new edge fires again");
		check(scheduler.events().get(0).outcome() == ReflexScheduler.Outcome.DONE && "selected".equals(scheduler.events().get(0).detail()),
				"the firing is reported with its detail");
	}

	private static void triggerEdgeDuringAnotherFiringFiresAfterIt() {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(rules("""
				[{"id":"fire","priority":9,"when":{"type":"fireball_incoming","withinS":3},"do":{"type":"sprint_away","blocks":12},"maxMs":4000},
				 {"id":"cloud","priority":9,"when":{"type":"cloud_near","within":4},"do":{"type":"sprint_away","blocks":8},"maxMs":3000}]"""), 0);
		check("fire".equals(scheduler.step(1, sense("fire", true, "cloud", false), RUNNING, "", false).started()), "the fireball dodge fires");
		for (long tick = 2; tick < 50; tick++) {
			check(!scheduler.step(tick, sense("fire", true, "cloud", true), RUNNING, "", false).changed(), "an equal rule waits while the dodge runs");
		}
		ReflexScheduler.Decision after = scheduler.step(50, sense("fire", false, "cloud", true), ReflexScheduler.ActionStatus.DONE, "ran", false);
		check(after.endOutcome() == ReflexScheduler.Outcome.DONE && "cloud".equals(after.started()),
				"a trigger that rose during a long firing and still holds fires when the body is free");
		ReflexScheduler.Decision done = scheduler.step(51, sense("fire", false, "cloud", true), ReflexScheduler.ActionStatus.DONE, "out", false);
		check(done.started() == null, "it fires once, not again while the condition holds");
	}

	private static void stanceHoldsWhileTrueAndIsBounded() {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(rules("[{\"id\":\"shield\",\"kind\":\"stance\",\"when\":{\"type\":\"hostile_near\",\"within\":12},\"do\":{\"type\":\"shield\"},\"maxMs\":1000,\"cooldownMs\":500}]"), 0);
		check("shield".equals(scheduler.step(1, sense("shield", true), RUNNING, "", true).started()), "a stance starts while true");
		for (long tick = 2; tick < 21; tick++) check(!scheduler.step(tick, sense("shield", true), RUNNING, "", true).changed(), "a stance holds");
		ReflexScheduler.Decision bounded = scheduler.step(21, sense("shield", true), RUNNING, "blocked 2 hit(s)", true);
		check(bounded.endOutcome() == ReflexScheduler.Outcome.TIMEOUT, "a stance ends at its bound");
		// Its condition still holds: the stance is held on in the same tick, with no cooldown gap that would drop the shield.
		check("shield".equals(bounded.started()), "the stance is held on across its bound");
		check(!scheduler.step(25, sense("shield", true), RUNNING, "", true).changed(), "the held-on stance keeps holding");
		check(scheduler.step(32, sense("shield", false), RUNNING, "", true).endOutcome() == ReflexScheduler.Outcome.DONE, "a stance releases when false");
		check(scheduler.step(33, sense("shield", true), RUNNING, "", true).started() == null, "cooldown follows a release");
	}

	private static void priorityPreemptsAndHandsBack() {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(rules("""
				[{"id":"work","kind":"stance","priority":2,"when":{"type":"hostile_near","within":4},"do":{"type":"attack"}},
				 {"id":"air","priority":9,"when":{"type":"air_below","bubbles":3},"do":{"type":"swim_up"}}]"""), 0);
		check("work".equals(scheduler.step(1, sense("work", true, "air", false), RUNNING, "", false).started()), "low rule fires");
		ReflexScheduler.Decision preempt = scheduler.step(2, sense("work", true, "air", true), RUNNING, "", false);
		check(preempt.endOutcome() == ReflexScheduler.Outcome.PREEMPTED && "air".equals(preempt.started()), "survival preempts combat");
		check(scheduler.step(3, sense("work", true, "air", true), RUNNING, "", false).ended() == null, "a lower rule cannot preempt");
		ReflexScheduler.Decision back = scheduler.step(4, sense("work", true, "air", false), ReflexScheduler.ActionStatus.DONE, "surfaced", false);
		check(back.endOutcome() == ReflexScheduler.Outcome.DONE && back.started() == null, "the preempted rule waits for its cooldown");
		check("work".equals(scheduler.step(20, sense("work", true, "air", false), RUNNING, "", false).started()), "then fires again");
	}

	/** Decision 13: a lava rule holding on through the afterburn yields to any ready rule and ends done at its maxS. */
	private static void settledHoldYieldsAndEndsDone() {
		ReflexScheduler.ActionStatus DONE = ReflexScheduler.ActionStatus.DONE;
		check(ReflexScheduler.settledStatus(RUNNING, true, 100, 100) == DONE, "a settled hold at its maxS ends done");
		check(ReflexScheduler.settledStatus(RUNNING, true, 99, 100) == RUNNING, "a settled hold before its maxS keeps running");
		check(ReflexScheduler.settledStatus(RUNNING, false, 100, 100) == RUNNING, "an unsettled firing at its maxS is left to time out");
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(rules("""
				[{"id":"lava","priority":9,"when":{"type":"in_lava"},"do":{"type":"leave_fire"},"maxMs":1000},
				 {"id":"guard","kind":"stance","priority":2,"when":{"type":"hostile_near","within":6},"do":{"type":"shield"}}]"""), 0);
		check("lava".equals(scheduler.step(1, sense("lava", true, "guard", false), RUNNING, "", false).started()), "the lava rule fires");
		check(scheduler.step(2, sense("lava", false, "guard", true), RUNNING, "", false).ended() == null,
				"a lower rule cannot take the body while the lava rule is still getting out");
		scheduler.settled(true);
		ReflexScheduler.Decision taken = scheduler.step(3, sense("lava", false, "guard", true), RUNNING, "holding until the fire is out", false);
		check(taken.endOutcome() == ReflexScheduler.Outcome.PREEMPTED && "guard".equals(taken.started()),
				"a lower ready rule takes the body from a settled afterburn hold");
		scheduler.settled(false);
		ReflexScheduler timed = new ReflexScheduler();
		timed.replace(rules("[{\"id\":\"lava\",\"priority\":9,\"when\":{\"type\":\"in_lava\"},\"do\":{\"type\":\"leave_fire\"},\"maxMs\":1000}]"), 0);
		timed.step(1, sense("lava", true), RUNNING, "", false);
		ReflexScheduler.Decision end = timed.step(21, sense("lava", false), ReflexScheduler.settledStatus(RUNNING, true, 20, 20), "burn held", false);
		check(end.endOutcome() == ReflexScheduler.Outcome.DONE, "the settled hold's end is reported done, not timeout");
		check(timed.events().stream().noneMatch(event -> event.outcome() == ReflexScheduler.Outcome.TIMEOUT), "no timeout is counted for it");
	}

	private static void debounceAndLoopProtection() {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(rules("[{\"id\":\"eat\",\"when\":{\"type\":\"health_below\",\"value\":8},\"do\":{\"type\":\"eat\"},\"wake\":true}]"), 0);
		long tick = 0;
		for (int firing = 0; firing < ReflexScheduler.MAX_FAILURES_IN_A_ROW; firing++) {
			scheduler.step(++tick, sense("eat", false), RUNNING, "", false);
			check("eat".equals(scheduler.step(++tick, sense("eat", true), RUNNING, "", false).started()), "fires on each edge");
			check(scheduler.step(++tick, sense("eat", true), ReflexScheduler.ActionStatus.FAILED, "no food in hotbar or offhand", false).endOutcome()
					== ReflexScheduler.Outcome.FAILED, "the failure is reported");
			tick += 20;
		}
		ReflexScheduler.Event disabled = scheduler.events().getLast();
		check(disabled.outcome() == ReflexScheduler.Outcome.DISABLED && disabled.wake() && disabled.detail().contains("no food"),
				"four failures in a row disable the rule and wake the model with the reason");
		check(scheduler.statuses(tick).get(0).state().equals("disabled"), "status shows the rule disabled");
		scheduler.step(++tick, sense("eat", false), RUNNING, "", false);
		check(scheduler.step(++tick, sense("eat", true), RUNNING, "", false).started() == null, "a disabled rule never fires");
		check(scheduler.events().stream().filter(event -> event.outcome() == ReflexScheduler.Outcome.FAILED).allMatch(ReflexScheduler.Event::wake),
				"wake:true rules wake on each firing end");
	}

	private static void flappingDisables() {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(rules("[{\"id\":\"flap\",\"when\":{\"type\":\"on_fire\"},\"do\":{\"type\":\"eat\"},\"cooldownMs\":250}]"), 0);
		long tick = 0;
		for (int firing = 0; firing <= ReflexScheduler.MAX_FIRINGS_PER_MINUTE; firing++) {
			scheduler.step(++tick, sense("flap", false), RUNNING, "", false);
			scheduler.step(++tick, sense("flap", true), RUNNING, "", false);
			scheduler.step(++tick, sense("flap", true), ReflexScheduler.ActionStatus.DONE, "", false);
			tick += 5;
		}
		check(scheduler.events().getLast().outcome() == ReflexScheduler.Outcome.DISABLED, "more than forty firings a minute disable a rule");
	}

	private static void expiry() {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(rules("""
				[{"id":"ttl","kind":"stance","when":{"type":"on_fire"},"do":{"type":"eat"},"ttlMs":1000},
				 {"id":"once","when":{"type":"in_lava"},"do":{"type":"swim_up"},"maxFirings":1},
				 {"id":"until","kind":"stance","when":{"type":"hostile_near","within":8},"do":{"type":"shield"},"until":{"type":"health_below","value":4}}]"""), 0);
		check("ttl".equals(scheduler.step(1, sense("ttl", true), RUNNING, "", false).started()), "fires before its ttl");
		ReflexScheduler.Decision expired = scheduler.step(20, sense("ttl", true), RUNNING, "", false);
		check(expired.endOutcome() == ReflexScheduler.Outcome.EXPIRED && scheduler.rule("ttl") == null, "ttl ends the firing and removes the rule");
		scheduler.step(21, sense("once", true), RUNNING, "", false);
		scheduler.step(22, sense("once", true), ReflexScheduler.ActionStatus.DONE, "", false);
		scheduler.step(23, sense("once", false), RUNNING, "", false);
		check(scheduler.rule("once") == null, "maxFirings removes a spent rule");
		Map<String, ReflexScheduler.Sense> until = new HashMap<>();
		until.put("until", new ReflexScheduler.Sense(true, true));
		scheduler.step(24, until, RUNNING, "", false);
		check(scheduler.rule("until") == null, "an until condition removes the rule");
		check(scheduler.events().stream().filter(event -> event.outcome() == ReflexScheduler.Outcome.EXPIRED).count() == 3, "expiry is reported");
	}

	private static void yieldSuppressesStanceUntilConditionClears() {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(rules("[{\"id\":\"s\",\"kind\":\"stance\",\"when\":{\"type\":\"hostile_near\",\"within\":8},\"do\":{\"type\":\"shield\"}}]"), 0);
		scheduler.step(1, sense("s", true), RUNNING, "", true);
		check(scheduler.yield(2).endOutcome() == ReflexScheduler.Outcome.YIELDED, "a model command ends the firing");
		check(scheduler.step(40, sense("s", true), RUNNING, "", true).started() == null, "the stance stays down while its situation persists");
		scheduler.step(41, sense("s", false), RUNNING, "", true);
		check("s".equals(scheduler.step(52, sense("s", true), RUNNING, "", true).started()), "and re-arms once it clears");
	}

	private static void replaceKeepsUnchangedState() {
		ReflexScheduler scheduler = new ReflexScheduler();
		String shield = "{\"id\":\"s\",\"kind\":\"stance\",\"when\":{\"type\":\"hostile_near\",\"within\":8},\"do\":{\"type\":\"shield\"}}";
		scheduler.replace(rules("[" + shield + "]"), 0);
		scheduler.step(1, sense("s", true), RUNNING, "", true);
		check(!scheduler.replace(rules("[" + shield + ",{\"id\":\"e\",\"when\":{\"type\":\"on_fire\"},\"do\":{\"type\":\"eat\"}}]"), 2).changed(),
				"adding a rule keeps an unchanged firing");
		check(scheduler.replace(rules("[{\"id\":\"e\",\"when\":{\"type\":\"on_fire\"},\"do\":{\"type\":\"eat\"}}]"), 3).endOutcome()
				== ReflexScheduler.Outcome.REMOVED, "removing the firing rule ends it");
	}

	private static void leasesRenewAndRebase() {
		AgentId agent = new AgentId(UUID.fromString("00000000-0000-0000-0000-000000000099"));
		List<AgentInputState> applied = new java.util.ArrayList<>();
		LeasedServerInputController controller = new LeasedServerInputController(new InputStateSink() {
			@Override public void apply(AgentId agentId, AgentInputState previous, AgentInputState state) { applied.add(state); }
			@Override public void clear(AgentId agentId, AgentInputState previous) { }
		});
		InputLease action = controller.acquire(agent, InputOwner.NAVIGATION, 100);
		controller.apply(action, new AgentInputState(1.0F, 0.0F, false, false, false, false, false, 10.0F, 0.0F, 2, InteractionHand.MAIN_HAND));
		InputLease reflex = controller.acquire(agent, InputOwner.REFLEX, ReflexEngine.INPUT_PRIORITY);
		controller.apply(reflex, new AgentInputState(0.0F, 0.0F, false, false, false, false, true, 90.0F, -10.0F, 4, InteractionHand.OFF_HAND));
		check(controller.currentState(agent).orElseThrow().use(), "the reflex lease wins over the action");
		for (int tick = 0; tick < 2 * LeasedServerInputController.LEASE_TIMEOUT_TICKS; tick++) {
			controller.renew(agent);
			controller.apply(reflex, controller.currentState(agent).orElseThrow());
			controller.tick();
		}
		controller.rebase(reflex, 90.0F, -10.0F, 4);
		controller.release(reflex);
		AgentInputState resumed = controller.currentState(agent).orElseThrow();
		check(resumed.forward() == 1.0F && !resumed.use(), "the paused action's lease survives the firing and wins again");
		check(resumed.yaw() == 90.0F && resumed.pitch() == -10.0F && resumed.selectedSlot() == 4, "it resumes from the current view and kept hotbar slot");
		check(applied.getLast().equals(resumed), "the hand-back applies the rebased state, without a view snap");
	}

	private static void combatVocabulary() {
		List<ReflexSpec.Rule> parsed = rules("""
				[{"id":"punch","priority":8,"when":{"type":"fireball_incoming","withinS":1.5,"deflectable":true},"do":{"type":"deflect"}},
				 {"id":"fuse","priority":9,"when":{"type":"creeper_fusing","within":5},"do":{"type":"sprint_away","blocks":8}},
				 {"id":"stare","when":{"type":"enderman_gaze"},"do":{"type":"look_away"}},
				 {"id":"angry","when":{"type":"enderman_provoked","within":12},"do":{"type":"move_to_cell","x":10,"y":64,"z":-3,"sprint":true}},
				 {"id":"edge","kind":"stance","when":{"type":"edge_near","within":1,"direction":"moving","drop":4},"do":{"type":"sneak"}},
				 {"id":"lava","when":{"type":"lava_near","within":2},"do":{"type":"step_back"}},
				 {"id":"rear","when":{"type":"attacked_from_behind","within":4},"do":{"type":"attack"}},
				 {"id":"wall","when":{"type":"exposed","within":24,"mobs":["skeleton"]},"do":{"type":"place_block","count":2}},
				 {"id":"hide","when":[{"type":"exposed","within":24},{"type":"health_below","value":10}],"do":{"type":"take_cover","within":6}},
				 {"id":"breath","kind":"stance","priority":9,"when":{"type":"cloud_near","within":0},"do":{"type":"sprint_away","blocks":5}}]""");
		check(parsed.size() == 10, "every combat and hazard term parses");
		check(parsed.get(9).when().get(0).focus() && parsed.get(9).when().get(0).number("within", 1.0D) == 0.0D, "cloud_near accepts within 0 (standing in it) and supplies a point to run from");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"cloud_near\",\"within\":5},\"do\":{\"type\":\"sprint_away\"}}]", "between 0 and 4");
		check(parsed.get(0).when().get(0).flag("deflectable") && parsed.get(0).when().get(0).focus(), "fireball_incoming keeps its flag and names a focus");
		check("moving".equals(parsed.get(4).when().get(0).text("direction")), "edge direction is kept");
		check(parsed.get(3).action().flag("sprint") && parsed.get(3).action().number("z", 0.0D) == -3.0D, "move_to_cell keeps its cell");
		check(parsed.get(7).when().get(0).ids("mobs").contains("minecraft:skeleton"), "exposed lists mob ids");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"edge_near\",\"direction\":\"up\"},\"do\":{\"type\":\"sneak\"}}]", "must be one of ahead, behind");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"fireball_incoming\",\"deflectable\":\"yes\"},\"do\":{\"type\":\"deflect\"}}]", "must be boolean");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"on_fire\"},\"do\":{\"type\":\"move_to_cell\",\"x\":1,\"y\":2}}]", "z is required");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"exposed\"},\"do\":{\"type\":\"take_cover\"}}]", "within is required");
		rejects("[{\"id\":\"a\",\"when\":{\"type\":\"on_fire\"},\"do\":{\"type\":\"place_block\",\"count\":3}}]", "between 1 and 2");
	}

	private static void harmedStanceIsNotProgress() {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(rules("[{\"id\":\"hold\",\"kind\":\"stance\",\"when\":{\"type\":\"hostile_near\",\"within\":12},\"do\":{\"type\":\"shield\"},\"maxMs\":500,\"cooldownMs\":250}]"), 0);
		long tick = 1;
		check("hold".equals(scheduler.step(tick, sense("hold", true), RUNNING, "", true, false).started()), "the stance fires");
		for (int span = 0; span < ReflexScheduler.MAX_FAILURES_IN_A_ROW; span++) {
			tick += 10;
			ReflexScheduler.Decision end = scheduler.step(tick, sense("hold", true), RUNNING, "shield raised; lost 3.0 health", true, true);
			check(end.endOutcome() == ReflexScheduler.Outcome.TIMEOUT, "it hits its bound");
			ReflexScheduler.Event event = scheduler.events().stream().filter(row -> row.outcome() == ReflexScheduler.Outcome.TIMEOUT).reduce((a, b) -> b).orElseThrow();
			check(event.wake(), "a stance that loses health while holding wakes the model");
		}
		check(scheduler.events().stream().anyMatch(row -> row.outcome() == ReflexScheduler.Outcome.DISABLED), "holding while losing health counts toward loop protection");
	}

	private static void heldStanceWakesOnce() {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(rules("[{\"id\":\"hold\",\"kind\":\"stance\",\"when\":{\"type\":\"hostile_near\",\"within\":12},\"do\":{\"type\":\"shield\"},\"maxMs\":500,\"cooldownMs\":250}]"), 0);
		long tick = 1;
		int wakes = 0;
		// A stance whose condition holds is held on across its bound: one span ends every 10 ticks.
		scheduler.step(tick, sense("hold", true), RUNNING, "", true, false);
		for (int span = 0; span < 5; span++) {
			tick += 10;
			scheduler.step(tick, sense("hold", true), RUNNING, "blocked 1 hit(s)", true, false);
			ReflexScheduler.Event event = scheduler.events().getLast();
			check(event.outcome() == ReflexScheduler.Outcome.TIMEOUT, "an unharmed hold times out as progress");
			if (event.wake()) {
				wakes++;
				check(span + 1 == ReflexScheduler.HELD_SPANS_BEFORE_WAKE && event.detail().contains("has not cleared"), "the third span in a row wakes the model");
			}
		}
		check(wakes == 1, "a long hold wakes the model once");
		check(scheduler.events().stream().noneMatch(row -> row.outcome() == ReflexScheduler.Outcome.DISABLED), "an unharmed hold is never disabled");
		scheduler.step(++tick, sense("hold", false), RUNNING, "", true, false);
		tick += 20;
		scheduler.step(tick, sense("hold", true), RUNNING, "", true, false);
		for (int span = 0; span < ReflexScheduler.HELD_SPANS_BEFORE_WAKE; span++) {
			tick += 10;
			scheduler.step(tick, sense("hold", true), RUNNING, "", true, false);
		}
		check(scheduler.events().getLast().wake(), "the count restarts once the condition clears");
	}

	private static void heldActionReleaseGrace() {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(rules("[{\"id\":\"volley\",\"when\":{\"type\":\"fireball_incoming\"},\"do\":{\"type\":\"shield\"}}]"), 0);
		long grace = ReflexActions.SHIELD_GRACE_TICKS;
		check("volley".equals(scheduler.step(1, sense("volley", true), RUNNING, "", true, false, grace).started()), "the shield trigger fires");
		for (long tick = 2; tick < 2 + grace - 1; tick++) {
			check(!scheduler.step(tick, sense("volley", false), RUNNING, "", true, false, grace).changed(), "the shield stays up between shots");
		}
		check(!scheduler.step(2 + grace - 1, sense("volley", true), RUNNING, "", true, false, grace).changed(), "the next shot keeps the same firing");
		long cleared = 2 + grace;
		for (long tick = cleared; tick < cleared + grace; tick++) scheduler.step(tick, sense("volley", false), RUNNING, "", true, false, grace);
		check(scheduler.step(cleared + grace, sense("volley", false), RUNNING, "", true, false, grace).endOutcome() == ReflexScheduler.Outcome.DONE,
				"the shield drops once the grace passes with nothing incoming");
	}

	private static final dev.agaminggod.arenaagents.protocol.ActionType MOVE = dev.agaminggod.arenaagents.protocol.ActionType.MOVE_TO;
	private static final dev.agaminggod.arenaagents.protocol.ActionType EAT = dev.agaminggod.arenaagents.protocol.ActionType.USE_ITEM;
	private static final dev.agaminggod.arenaagents.protocol.ActionType FIGHT = dev.agaminggod.arenaagents.protocol.ActionType.FIGHT_TARGET;

	private static ReflexScheduler shieldStance(long now) {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(rules("[{\"id\":\"s\",\"kind\":\"stance\",\"when\":{\"type\":\"hostile_near\",\"within\":12},\"do\":{\"type\":\"shield\"}},"
				+ "{\"id\":\"fire\",\"priority\":8,\"when\":{\"type\":\"on_fire\"},\"do\":{\"type\":\"step_back\"}}]"), now);
		check("s".equals(scheduler.step(now + 1, sense("s", true, "fire", false), RUNNING, "", true).started()), "the shield stance fires");
		return scheduler;
	}

	private static void heldShieldComposesWithMovingCommands() {
		ReflexScheduler scheduler = shieldStance(0);
		CommandFollower command = new CommandFollower();
		command.observe(scheduler, true, "old", MOVE, null, null, 1);
		check(!command.requestYield(true, 2), "a yield asked of a held shield waits for the command");
		check(!command.observe(scheduler, true, "old", MOVE, null, null, 3).yieldNow(), "the paused action is not the new command");
		check(!command.observe(scheduler, true, "walk", MOVE, "old", "ACTION_CANCELLED", 4).yieldNow(), "a walking command composes with the shield");
		check(!command.observe(scheduler, true, "walk", MOVE, "old", "ACTION_CANCELLED", 30).yieldNow(), "and keeps composing");
		check(!command.requestYield(true, 31), "a fight is asked too");
		check(!command.observe(scheduler, true, "fight", FIGHT, "walk", "ACTION_CANCELLED", 32).yieldNow(), "a fight composes (it shields between swings)");
		check(!command.requestYield(true, 40), "eating is asked too");
		check(command.observe(scheduler, true, "eat", EAT, "fight", "ACTION_CANCELLED", 41).yieldNow(), "an action that needs the hands yields the shield");
		check(command.requestYield(false, 50), "a firing that does not hold movement yields at once");
	}

	private static void yieldedStanceReturnsAfterTheCommand() {
		ReflexScheduler scheduler = shieldStance(0);
		CommandFollower command = new CommandFollower();
		check(scheduler.yield(2).endOutcome() == ReflexScheduler.Outcome.YIELDED, "the model's eat command takes the body");
		command.yielded(2);
		command.observe(scheduler, false, null, null, null, null, 3);
		command.observe(scheduler, false, "eat", EAT, null, null, 4);
		check(scheduler.step(5, sense("s", true, "fire", false), RUNNING, "", true).started() == null, "the stance stays down while the command runs");
		for (long tick = 6; tick < 40; tick++) command.observe(scheduler, false, "eat", EAT, null, null, tick);
		check(scheduler.step(40, sense("s", true, "fire", false), RUNNING, "", true).started() == null, "even when the command runs long");
		long done = 41;
		for (long tick = done; tick < done + CommandFollower.IDLE_RESUME_TICKS; tick++) {
			command.observe(scheduler, false, null, null, "eat", "USE_INPUT_CONFIRMED", tick);
			check(scheduler.step(tick, sense("s", true, "fire", false), RUNNING, "", true).started() == null, "not between two quick commands");
		}
		command.observe(scheduler, false, null, null, "eat", "USE_INPUT_CONFIRMED", done + CommandFollower.IDLE_RESUME_TICKS);
		check("s".equals(scheduler.step(done + CommandFollower.IDLE_RESUME_TICKS, sense("s", true, "fire", false), RUNNING, "", true).started()),
				"the stance comes back once the command is over, its condition never having cleared");
	}

	/**
	 * Live drownings 2026-10-20: the air rule fired, a short jump command took the body, and once it ended the air stayed
	 * low with no new edge, so the rule never fired again and the body sank between turns.
	 */
	private static void yieldedTriggerReturnsAfterTheCommand() {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(rules("[{\"id\":\"air\",\"priority\":9,\"when\":{\"type\":\"air_below\",\"bubbles\":6},\"do\":{\"type\":\"swim_up\"}}]"), 0);
		check("air".equals(scheduler.step(1, sense("air", true), RUNNING, "", false).started()), "the air rule fires on its edge");
		CommandFollower command = new CommandFollower();
		check(scheduler.yield(2).endOutcome() == ReflexScheduler.Outcome.YIELDED, "the model's jump command takes the body");
		command.yielded(2);
		for (long tick = 3; tick < 20; tick++) {
			command.observe(scheduler, false, "jump", dev.agaminggod.arenaagents.protocol.ActionType.CONTROL, null, null, tick);
			check(scheduler.step(tick, sense("air", true), RUNNING, "", false).started() == null, "the rule waits while the command runs");
		}
		long done = 20;
		for (long tick = done; tick < done + CommandFollower.IDLE_RESUME_TICKS; tick++) {
			command.observe(scheduler, false, null, null, "jump", "CONTROL_SEGMENT_COMPLETED", tick);
			check(scheduler.step(tick, sense("air", true), RUNNING, "", false).started() == null, "not between two quick commands");
		}
		command.observe(scheduler, false, null, null, "jump", "CONTROL_SEGMENT_COMPLETED", done + CommandFollower.IDLE_RESUME_TICKS);
		check("air".equals(scheduler.step(done + CommandFollower.IDLE_RESUME_TICKS, sense("air", true), RUNNING, "", false).started()),
				"the trigger fires again once the command is over, its condition never having cleared");
		scheduler.step(40, sense("air", true), ReflexScheduler.ActionStatus.DONE, "surfaced", false);
		for (long tick = 41; tick < 80; tick++) {
			check(scheduler.step(tick, sense("air", true), RUNNING, "", false).started() == null, "a finished firing still needs a new edge");
		}

		ReflexScheduler cleared = new ReflexScheduler();
		cleared.replace(rules("[{\"id\":\"air\",\"when\":{\"type\":\"air_below\",\"bubbles\":6},\"do\":{\"type\":\"swim_up\"}}]"), 0);
		cleared.step(1, sense("air", true), RUNNING, "", false);
		CommandFollower other = new CommandFollower();
		cleared.yield(2);
		other.yielded(2);
		other.observe(cleared, false, "jump", dev.agaminggod.arenaagents.protocol.ActionType.CONTROL, null, null, 3);
		cleared.step(3, sense("air", false), RUNNING, "", false);
		for (long tick = 4; tick < 40; tick++) {
			other.observe(cleared, false, null, null, "jump", "CONTROL_SEGMENT_COMPLETED", tick);
			check(cleared.step(tick, sense("air", tick >= 30), RUNNING, "", false).started() == null || tick == 30,
					"a condition that cleared during the command waits for its own edge");
		}
	}

	private static void bailoutHandsBodyToReflexes() {
		ReflexScheduler scheduler = shieldStance(0);
		CommandFollower command = new CommandFollower();
		scheduler.yield(2);
		command.yielded(2);
		command.observe(scheduler, false, "fight", FIGHT, null, null, 3);
		// During the fight the fire trigger fires on its edge and finishes; the fight then bails out, still burning.
		scheduler.step(4, sense("s", true, "fire", true), RUNNING, "", true);
		for (long tick = 5; tick < 60; tick++) scheduler.step(tick, sense("s", true, "fire", true), RUNNING, "", true);
		check(scheduler.current() != null && "fire".equals(scheduler.current().ruleId()), "the fire trigger fired on its edge");
		scheduler.step(60, sense("s", true, "fire", true), ReflexScheduler.ActionStatus.DONE, "", false);
		check(scheduler.current() == null || !"fire".equals(scheduler.current().ruleId()), "and finished");
		while (scheduler.current() != null) scheduler.yield(61);
		for (long tick = 62; tick < 100; tick++) {
			command.observe(scheduler, false, "fight", FIGHT, null, null, tick);
			scheduler.step(tick, sense("s", true, "fire", true), RUNNING, "", true);
		}
		check(scheduler.current() == null, "nothing fires while the fight still runs");
		CommandFollower.Result ended = command.observe(scheduler, false, null, null, "fight", "ON_FIRE", 100);
		check(ended.handedOff(), "a fight that bails out on fire hands off");
		check("fire".equals(scheduler.step(100, sense("s", true, "fire", true), RUNNING, "", true).started()),
				"the model's own fire rule takes the body at once, still burning");
		check(!command.observe(scheduler, false, null, null, "fight", "ON_FIRE", 101).handedOff(), "one hand-off per ending");
		CommandFollower plain = new CommandFollower();
		plain.observe(scheduler, false, "walk", MOVE, null, null, 200);
		check(!plain.observe(scheduler, false, null, null, "walk", "DESTINATION_REACHED", 201).handedOff(), "an ordinary ending hands nothing off");
	}

	private static void shippingClassOrigins() {
		String shipping = System.getProperty("arenaagents.verification.jar");
		if (shipping == null) return;
		try {
			var expected = java.nio.file.Path.of(shipping).toRealPath();
			for (Class<?> type : List.of(CommandFollower.class, ReflexActions.class, ReflexEngine.class, SwimAirProgress.class,
					dev.agaminggod.arenaagents.server.runtime.controller.ServerRangedUseController.class,
					dev.agaminggod.arenaagents.server.runtime.controller.ArrowImpactReceipt.class,
					AgentInputState.class, dev.agaminggod.arenaagents.server.runtime.input.VanillaMoveInput.class,
					dev.agaminggod.arenaagents.server.runtime.input.ModelPlayerInputBridge.class)) {
				var actual = java.nio.file.Path.of(type.getProtectionDomain().getCodeSource().getLocation().toURI()).toRealPath();
				check(expected.equals(actual), type.getSimpleName() + " must be loaded from the shipping jar");
			}
			System.out.println("SHIPPING_CONTROLLER_CONTRACTS: nine production classes loaded from " + expected.getFileName());
		} catch (Exception error) { throw new AssertionError("shipping jar class origin", error); }
	}

	private static void swimDetourMakesProgress() {
		var route = List.of(new net.minecraft.core.BlockPos(0, 1, 0), new net.minecraft.core.BlockPos(-1, 1, 0),
				new net.minecraft.core.BlockPos(-2, 1, 0), new net.minecraft.core.BlockPos(-2, 1, 1),
				new net.minecraft.core.BlockPos(-1, 1, 1), new net.minecraft.core.BlockPos(0, 1, 1), new net.minecraft.core.BlockPos(1, 1, 1));
		var goal = route.getLast(); var guard = new SwimAirProgress();
		var start = net.minecraft.world.phys.Vec3.atCenterOf(route.getFirst());
		for (int tick = 0; tick <= 60; tick++) {
			var eye = start.add(-tick / 30.0D, 0, 0);
			double remaining = SwimAirProgress.remaining(eye, route.subList(Math.min(tick / 30, 2), route.size()));
			check(!guard.stalled(goal, remaining, tick), "a two-second detour away from air makes route progress");
		}
		check(start.distanceTo(net.minecraft.world.phys.Vec3.atCenterOf(goal))
				< start.add(-2, 0, 0).distanceTo(net.minecraft.world.phys.Vec3.atCenterOf(goal)), "the detour initially increases endpoint distance");
		check(guard.stalled(goal, 4.0D, 110), "stationary swimmer still stops after forty ticks without progress");
		check(!guard.stalled(new net.minecraft.core.BlockPos(2, 3, 2), 20.0D, 111), "a changed air destination rebases progress");
	}

	private static void shieldReservesHandCommands() {
		var agent = new AgentId(UUID.fromString("00000000-0000-0000-0000-000000000099"));
		var origin = new dev.agaminggod.arenaagents.server.runtime.ActionProvenance("codex", "gpt-6.1-sol", "low", "default", "test", 1, "frame", 0);
		var follower = new CommandFollower();
		var scheduler = new ReflexScheduler();
		check(!follower.requestYield(true, 1), "a held shield waits to classify the incoming command");
		check(follower.observe(scheduler, true, "hand", null, null, null, 2).yieldNow(),
				"a reserved hand command yields the shield without passing a null type to the movement set");
		for (String hand : List.of("attack", "use")) {
			var args = JsonParser.parseString("{\"forward\":0.15,\"" + hand + "\":true}").getAsJsonObject();
			var control = new dev.agaminggod.arenaagents.server.runtime.ServerActionRequest(agent, 0, "hand", dev.agaminggod.arenaagents.protocol.ActionType.CONTROL, args, origin);
			check(!CommandFollower.movesUnderHold(control), "raw " + hand + " reserves hands instead of ticking behind a shield");
			var frames = new com.google.gson.JsonObject();
			var list = new JsonArray(); list.add(JsonParser.parseString("{\"forward\":0.15}")); list.add(args); frames.add("frames", list);
			var sequence = new dev.agaminggod.arenaagents.server.runtime.ServerActionRequest(agent, 0, "sequence", dev.agaminggod.arenaagents.protocol.ActionType.CONTROL_SEQUENCE, frames, origin);
			check(!CommandFollower.movesUnderHold(sequence), "a later " + hand + " frame reserves the whole sequence");
			args.addProperty(hand, false);
			var walk = new dev.agaminggod.arenaagents.server.runtime.ServerActionRequest(agent, 0, "walk", dev.agaminggod.arenaagents.protocol.ActionType.CONTROL, args, origin);
			check(CommandFollower.movesUnderHold(walk), "movement-only controls still compose with shielding");
		}
	}

	private static void shieldWalkKeepsCourse() {
		for (float forward : new float[]{0.0F, 0.05F, 0.15F, 0.6F, 1.0F, -0.8F}) {
			for (float strafe : new float[]{0.0F, 0.1F, -0.7F, 1.0F}) {
				for (float yaw = -180.0F; yaw <= 180.0F; yaw += 2.5F) {
					float[] rotated = ReflexActions.keysFor(forward, strafe, 17.0F, yaw);
					double length = Math.min(1.0D, Math.hypot(forward, strafe));
					check(Math.abs(Math.hypot(rotated[0], rotated[1]) - length) < 1e-6, "rotation retains analog length");
					check(Math.abs(rotated[0]) <= 1.0F && Math.abs(rotated[1]) <= 1.0F, "rotated axes fit input bounds");
					float[] back = ReflexActions.keysFor(rotated[0], rotated[1], yaw, 17.0F);
					double scale = Math.max(1.0D, Math.hypot(forward, strafe));
					check(Math.abs(back[0] - forward / scale) < 1e-6 && Math.abs(back[1] - strafe / scale) < 1e-6,
							"rotation retains continuous world direction, including sector boundaries");
				}
			}
		}
	}

	private static void heldInputPassesThrough() {
		AgentId agent = new AgentId(UUID.fromString("00000000-0000-0000-0000-000000000098"));
		LeasedServerInputController controller = new LeasedServerInputController(new InputStateSink() {
			@Override public void apply(AgentId agentId, AgentInputState previous, AgentInputState state) { }
			@Override public void clear(AgentId agentId, AgentInputState previous) { }
		});
		check(controller.stateBelow(agent, ReflexEngine.INPUT_PRIORITY).isEmpty(), "no action, nothing below");
		InputLease walk = controller.acquire(agent, InputOwner.NAVIGATION, 100);
		AgentInputState walking = new AgentInputState(1.0F, 0.0F, true, false, true, false, false, 10.0F, 0.0F, 2, InteractionHand.MAIN_HAND);
		controller.apply(walk, walking);
		InputLease reflex = controller.acquire(agent, InputOwner.REFLEX, ReflexEngine.INPUT_PRIORITY);
		controller.apply(reflex, new AgentInputState(0.0F, 1.0F, false, false, false, false, true, 90.0F, 0.0F, 2, InteractionHand.OFF_HAND));
		check(controller.stateBelow(agent, ReflexEngine.INPUT_PRIORITY).orElseThrow().equals(walking), "the walking action's keys are read under the shield");
		check(controller.currentState(agent).orElseThrow().use(), "while the shield lease wins");
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
