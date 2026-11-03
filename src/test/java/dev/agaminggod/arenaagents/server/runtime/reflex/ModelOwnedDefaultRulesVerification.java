package dev.agaminggod.arenaagents.server.runtime.reflex;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/** Ownership crosses the real coordinator payload/parser and the gate used by the engine before scheduler failure reporting. */
public final class ModelOwnedDefaultRulesVerification {
	private static int assertions;

	public static void main(String[] args) throws Exception {
		System.out.println("PASS: " + verify(args.length == 0 ? null : args[0]) + " model-owned default assertions");
	}

	public static int verify() throws Exception {
		return verify(null);
	}

	private static int verify(String payloadPath) throws Exception {
		assertions = 0;
		List<ReflexSpec.Rule> defaults = ReflexSpec.parseRules(JsonParser.parseString(Files.readString(
				Path.of("src/test/resources/default-reflex-rules.json"))).getAsJsonArray());
		for (ReflexSpec.Rule rule : defaults) check(rule.coordinatorDefault(), "fixture carries actual ownership");
		for (String id : List.of("default-fire", "default-custom", "model-fire")) {
			ReflexSpec.Rule model = rule("""
					{"id":"%s","when":{"type":"in_fire"},"do":{"type":"place","item":"water_bucket","where":"below"},"wake":true}
					""".formatted(id));
			failsWithRequestedWake(model);
		}
		ReflexSpec.Rule arrow = defaults.stream().filter(rule -> rule.id().equals("default-arrow")).findFirst().orElseThrow();
		ReflexSpec.Rule eat = defaults.stream().filter(rule -> rule.id().equals("default-eat")).findFirst().orElseThrow();
		for (ReflexSpec.Rule owned : List.of(arrow, eat)) {
			String lacks = missing(owned);
			check(lacks != null, "default lacks its item");
			check(owned.sleepsWithoutItem(lacks), "actual default sleeps");
			ReflexScheduler scheduler = new ReflexScheduler();
			scheduler.replace(List.of(owned), 0);
			check(scheduler.step(1, Map.of(owned.id(), new ReflexScheduler.Sense(false, false)),
					ReflexScheduler.ActionStatus.RUNNING, "", false).started() == null, "sleeping default does not fire");
			check(scheduler.events().isEmpty(), "sleeping default has no failure event");
			check(!owned.sleepsWithoutItem(null), "item availability wakes default");
			check(owned.id().equals(scheduler.step(2, Map.of(owned.id(), new ReflexScheduler.Sense(true, false)),
					ReflexScheduler.ActionStatus.RUNNING, "", false).started()), "default fires when its item returns");
		}
		// Even an identical model-authored replacement belongs to the model and must report missing items.
		JsonObject identical = JsonParser.parseString(Files.readString(Path.of("src/test/resources/default-reflex-rules.json")))
				.getAsJsonArray().asList().stream().map(value -> value.getAsJsonObject())
				.filter(value -> value.get("id").getAsString().equals("default-arrow")).findFirst().orElseThrow().deepCopy();
		identical.remove("coordinatorDefault");
		failsWithRequestedWake(ReflexSpec.parseRule(identical, "replacement"));
		identical.addProperty("coordinatorDefault", false);
		failsWithRequestedWake(ReflexSpec.parseRule(identical, "explicit-model"));
		identical.addProperty("coordinatorDefault", "true");
		try {
			ReflexSpec.parseRule(identical, "invalid-owner");
			throw new AssertionError("ownership must be boolean");
		} catch (ReflexSpec.InvalidRuleException expected) {
			check(expected.getMessage().contains("coordinatorDefault"), "ownership type validation");
		}
		if (payloadPath != null) {
			List<ReflexSpec.Rule> wire = ReflexSpec.parseRules(JsonParser.parseString(Files.readString(Path.of(payloadPath))).getAsJsonArray());
			for (ReflexSpec.Rule model : wire) {
				if (List.of("default-fire", "default-custom", "default-arrow").contains(model.id())) failsWithRequestedWake(model);
				else check(model.coordinatorDefault(), "untouched wire default keeps ownership");
			}
		}
		return assertions;
	}

	private static ReflexSpec.Rule rule(String json) {
		return ReflexSpec.parseRule(JsonParser.parseString(json).getAsJsonObject(), "rule");
	}

	private static String missing(ReflexSpec.Rule rule) {
		// These are the existing action failure details; this pure scheduling test supplies the action result.
		return switch (rule.action().type()) {
			case "place" -> "no " + rule.action().text("item") + " in hotbar or offhand";
			case "shield" -> "no shield in either hand";
			case "eat" -> "no food in hotbar or offhand";
			default -> throw new AssertionError("unexpected fixture action");
		};
	}

	private static void failsWithRequestedWake(ReflexSpec.Rule model) {
		String lacks = missing(model);
		check(lacks != null, "model action lacks its required item");
		boolean truth = !model.sleepsWithoutItem(lacks);
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(model), 0);
		Map<String, ReflexScheduler.Sense> senses = Map.of(model.id(), new ReflexScheduler.Sense(truth, false));
		check(model.id().equals(scheduler.step(1, senses, ReflexScheduler.ActionStatus.RUNNING, "", false).started()),
				model.id() + " fires despite its missing item");
		// Supply the missing-item result the action returns; no Minecraft player/world is constructed.
		scheduler.step(2, senses, ReflexScheduler.ActionStatus.FAILED, lacks, false);
		check(scheduler.events().size() == 1, "one failure event");
		ReflexScheduler.Event event = scheduler.events().getFirst();
		check(event.outcome() == ReflexScheduler.Outcome.FAILED && event.wake() == model.wake() && event.detail().equals(lacks),
				"failure preserves detail and wake");
		System.out.println(model.id() + " " + event.outcome() + " wake=" + event.wake() + " detail=" + event.detail());
	}

	private static void check(boolean condition, String message) {
		assertions++;
		if (!condition) throw new AssertionError(message);
	}
}
