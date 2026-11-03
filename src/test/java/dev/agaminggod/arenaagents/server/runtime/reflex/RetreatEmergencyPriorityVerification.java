package dev.agaminggod.arenaagents.server.runtime.reflex;

import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/** Exercises the shipping scheduler with the coordinator's shared default payload, without a server. */
public final class RetreatEmergencyPriorityVerification {
	private static final ReflexScheduler.Sense TRUE = new ReflexScheduler.Sense(true, false);
	private static final ReflexScheduler.ActionStatus RUNNING = ReflexScheduler.ActionStatus.RUNNING;

	private RetreatEmergencyPriorityVerification() {
	}

	public static void main(String[] args) throws IOException {
		System.out.println("Retreat emergency priority: " + verify() + " scenarios passed");
	}

	public static int verify() throws IOException {
		List<ReflexSpec.Rule> rules = ReflexSpec.parseRules(JsonParser.parseString(Files.readString(
				Path.of("src/test/resources/default-reflex-rules.json"))).getAsJsonArray());
		int scenarios = 0;
		for (String emergency : List.of("default-air", "default-fire")) {
			for (long dangerTick : new long[] { 1L, 40L }) {
				var scheduler = new ReflexScheduler();
				scheduler.replace(rules, 0L);
				check("default-retreat".equals(step(scheduler, 0L, Map.of("default-retreat", TRUE)).started()), "retreat starts alone");
				for (long tick = 1L; tick < dangerTick; tick++) {
					check(!step(scheduler, tick, Map.of("default-retreat", TRUE)).changed(), "retreat keeps running before danger");
				}
				var decision = step(scheduler, dangerTick, Map.of("default-retreat", TRUE, emergency, TRUE));
				check(emergency.equals(decision.started()), emergency + " must interrupt retreat at tick " + dangerTick);
				check(decision.ended() != null && "default-retreat".equals(decision.ended().ruleId())
						&& decision.endOutcome() == ReflexScheduler.Outcome.PREEMPTED, "retreat ends by preemption");
				check(emergency.equals(scheduler.current().ruleId()), "emergency owns the body immediately");
				scenarios++;
			}
			var scheduler = new ReflexScheduler();
			scheduler.replace(rules, 0L);
			check(emergency.equals(step(scheduler, 0L, Map.of(emergency, TRUE)).started()), "emergency starts alone");
			check(!step(scheduler, 1L, Map.of(emergency, TRUE, "default-retreat", TRUE)).changed(), "later retreat cannot preempt emergency");
			check(emergency.equals(scheduler.current().ruleId()), "emergency retains the body");
			scenarios++;
		}
		return scenarios;
	}

	private static ReflexScheduler.Decision step(ReflexScheduler scheduler, long tick, Map<String, ReflexScheduler.Sense> senses) {
		return scheduler.step(tick, senses, RUNNING, "", false);
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
