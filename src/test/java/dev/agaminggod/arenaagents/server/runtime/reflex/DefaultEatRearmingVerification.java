package dev.agaminggod.arenaagents.server.runtime.reflex;

import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/** Real scheduler and default payload; food consumption and sensor samples are simulated, without Minecraft. */
public final class DefaultEatRearmingVerification {
	private static final String EAT = "default-eat";
	private static final ReflexScheduler.ActionStatus RUNNING = ReflexScheduler.ActionStatus.RUNNING;
	private static final ReflexScheduler.ActionStatus DONE = ReflexScheduler.ActionStatus.DONE;

	private DefaultEatRearmingVerification() { }

	public static void main(String[] args) throws IOException {
		System.out.println("Default eat rearming: " + verify() + " scenarios passed");
	}

	public static int verify() throws IOException {
		var payload = JsonParser.parseString(Files.readString(Path.of("src/test/resources/default-reflex-rules.json"))).getAsJsonArray();
		List<ReflexSpec.Rule> rules = ReflexSpec.parseRules(payload);
		var eat = rules.stream().filter(rule -> EAT.equals(rule.id())).findFirst().orElseThrow();
		long cooldown = eat.cooldownMs() / 50L;

		var scheduler = new ReflexScheduler();
		scheduler.replace(rules, 0L);
		int hunger = 1, carrots = 10, consumed = 0;
		long finishAt = -1L;
		for (long tick = 0; tick < 2000; tick++) {
			boolean finished = tick == finishAt;
			if (finished) {
				hunger += 3;
				carrots--;
				consumed++;
			}
			var decision = step(scheduler, tick, hunger, carrots, false, finished ? DONE : RUNNING);
			if (EAT.equals(decision.started())) finishAt = tick + 33L;
			if (tick == 33L) check(hunger == 4 && carrots == 9, "one carrot leaves hunger below 14 with food available");
		}
		check(consumed == 5 && hunger == 16 && carrots == 5 && scheduler.current() == null,
				"must keep nourishing until threshold clears: consumed=" + consumed + ", hunger=" + hunger + ", carrots=" + carrots);

		System.out.println("100 s simulated nourishment: consumed=" + consumed + ", hunger=" + hunger + ", carrots=" + carrots);

		// A hostile at 7 blocks clears the safe-eating condition without triggering the 6-block retreat.
		scheduler = new ReflexScheduler();
		scheduler.replace(rules, 0L);
		check(EAT.equals(step(scheduler, 0L, 1, 10, false, RUNNING).started()), "safe eat starts");
		step(scheduler, 33L, 4, 9, false, DONE);
		long secondMeal = 33L + cooldown;
		check(EAT.equals(step(scheduler, secondMeal, 4, 9, false, RUNNING).started()), "second carrot starts with hunger still low");
		long dangerTick = secondMeal + 10L;
		var danger = step(scheduler, dangerTick, 4, 9, true, RUNNING);
		check(danger.ended() != null && scheduler.current() == null, "danger cancels continued eating mid-consumption without another ready rule");
		for (long tick = dangerTick + 1; tick <= dangerTick + cooldown; tick++) {
			check(step(scheduler, tick, 4, 9, true, RUNNING).started() == null, "no eating while danger persists");
		}
		check(EAT.equals(step(scheduler, dangerTick + cooldown + 1, 4, 9, false, RUNNING).started()), "safe again: retry interrupted meal");

		// Preemption can happen while hunger and safety remain continuously true (e.g. an incoming arrow).
		scheduler = new ReflexScheduler();
		scheduler.replace(rules, 0L);
		step(scheduler, 0L, 1, 10, false, RUNNING);
		var interrupted = scheduler.step(10L, Map.of(EAT, sense(true), "default-arrow", sense(true)), RUNNING, "", false);
		check(interrupted.endOutcome() == ReflexScheduler.Outcome.PREEMPTED, "arrow interrupts eating");
		scheduler.step(20L, Map.of(EAT, sense(true)), DONE, "arrow passed", false);
		for (long tick = 21; tick < 10 + cooldown; tick++) {
			check(step(scheduler, tick, 1, 10, false, RUNNING).started() == null, "existing cooldown is honored");
		}
		check(EAT.equals(step(scheduler, 10 + cooldown, 1, 10, false, RUNNING).started()), "preempted meal rearms without a new hunger edge");

		scheduler = new ReflexScheduler();
		scheduler.replace(rules, 0L);
		check(step(scheduler, 0L, 14, 10, false, RUNNING).started() == null, "no eating at hunger threshold");
		check(step(scheduler, 1L, 1, 0, false, RUNNING).started() == null, "missing food keeps default asleep");
		check(EAT.equals(step(scheduler, 2L, 1, 10, false, RUNNING).started()), "food availability wakes hungry default");

		// A model-authored one-shot eat rule still needs another condition edge.
		var own = payload.deepCopy();
		own.forEach(entry -> {
			if (EAT.equals(entry.getAsJsonObject().get("id").getAsString())) {
				entry.getAsJsonObject().addProperty("kind", "trigger");
				entry.getAsJsonObject().addProperty("id", "own-eat");
			}
		});
		scheduler = new ReflexScheduler();
		scheduler.replace(ReflexSpec.parseRules(own), 0L);
		scheduler.step(0L, Map.of("own-eat", sense(true)), RUNNING, "", false);
		scheduler.step(33L, Map.of("own-eat", sense(true)), DONE, "ate carrot", false);
		for (long tick = 34; tick <= 1000; tick++) {
			check(scheduler.step(tick, Map.of("own-eat", sense(true)), RUNNING, "", false).started() == null, "generic trigger remains one-shot");
		}
		return 5;
	}

	private static ReflexScheduler.Decision step(ReflexScheduler scheduler, long tick, int hunger, int food, boolean hostile,
			ReflexScheduler.ActionStatus status) {
		return scheduler.step(tick, Map.of(EAT, sense(hunger < 14 && food > 0 && !hostile)), status, "simulated carrot consumption", false);
	}

	private static ReflexScheduler.Sense sense(boolean truth) {
		return new ReflexScheduler.Sense(truth, false);
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
