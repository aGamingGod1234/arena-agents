package dev.agaminggod.arenaagents.server.goal;

import dev.agaminggod.arenaagents.agent.AgentId;
import java.util.List;

public final class PlanProgressFactsVerification {
	private PlanProgressFactsVerification() { }

	public static int verify() {
		check(!PlanProgressFacts.advancementCompleted(false, false, true), "recipe unlocks have no visible receipt");
		check(!PlanProgressFacts.advancementCompleted(true, false, false), "partial criteria have no receipt");
		check(PlanProgressFacts.advancementCompleted(true, false, true), "completion publishes once");
		check(!PlanProgressFacts.advancementCompleted(true, true, true), "additional criteria after completion do not repeat it");
		check(!PlanProgressFacts.advancementCompleted(true, true, false), "revocation does not publish completion");
		check(PlanProgressFacts.advancementCompleted(true, false, true), "a newly completed revoked advancement publishes again");
		AgentId agent = AgentId.parse("00000000-0000-0000-0000-000000000001");
		AgentId other = AgentId.parse("00000000-0000-0000-0000-000000000002");
		AgentKillLedger ledger = new AgentKillLedger();
		ledger.record(agent, "minecraft:zombie", 99L);
		ledger.record(other, "minecraft:skeleton", 101L);
		check(PlanProgressFacts.verifiedKills(ledger.snapshot(), agent, 100L).isEmpty(), "a new goal starts without old kills or another player's kills");
		ledger.record(agent, "minecraft:zombie", 100L);
		ledger.record(agent, "minecraft:zombie", 101L);
		check(PlanProgressFacts.verifiedKills(ledger.snapshot(), agent, 100L).equals(List.of("minecraft:zombie")), "current goal kills are attributed and deduplicated");
		AgentKillLedger restored = new AgentKillLedger(ledger.snapshot(), () -> { });
		check(PlanProgressFacts.verifiedKills(restored.snapshot(), agent, 100L).equals(List.of("minecraft:zombie")), "the goal boundary survives ledger persistence");
		check(PlanProgressFacts.verifiedKills(restored.snapshot(), agent, 102L).isEmpty(), "starting another goal resets kill receipts");
		return 10 + verifyActivationFence(agent, other);
	}

	private static int verifyActivationFence(AgentId agent, AgentId other) {
		java.util.UUID goal = java.util.UUID.fromString("00000000-0000-0000-0000-0000000000a1");
		java.util.UUID next = java.util.UUID.fromString("00000000-0000-0000-0000-0000000000a2");
		AgentKillLedger ledger = new AgentKillLedger();
		ledger.record(agent, "minecraft:zombie", 100L);
		ledger.synchronizeProgress(List.of(), List.of(new AgentKillLedger.GoalActivation(goal, agent, 100L)));
		ledger.record(agent, "minecraft:skeleton", 100L);
		ledger.record(other, "minecraft:creeper", 100L);
		check(PlanProgressFacts.verifiedKills(ledger.snapshot(), agent, 100L).equals(List.of("minecraft:zombie", "minecraft:skeleton")),
				"control: the timestamp boundary used before activation fences credits the pre-activation kill");
		check(PlanProgressFacts.verifiedKills(ledger.snapshot(), agent, goal, 100L).equals(List.of("minecraft:skeleton")),
				"a kill in the activation millisecond but before activation is not this goal's, even for a goal without kill leaves");
		ledger.synchronizeProgress(List.of(), List.of(new AgentKillLedger.GoalActivation(goal, agent, 100L)));
		check(PlanProgressFacts.verifiedKills(ledger.snapshot(), agent, goal, 100L).equals(List.of("minecraft:skeleton")),
				"a reconnect or resume keeps the original activation fence");
		AgentKillLedger restored = new AgentKillLedger(new AgentKillLedgerCodec().decode(new AgentKillLedgerCodec().encode(ledger.snapshot())), () -> { });
		check(PlanProgressFacts.verifiedKills(restored.snapshot(), agent, goal, 100L).equals(List.of("minecraft:skeleton")),
				"the activation fence survives persistence");
		restored.synchronizeProgress(List.of(), List.of(new AgentKillLedger.GoalActivation(next, agent, 100L)));
		check(PlanProgressFacts.verifiedKills(restored.snapshot(), agent, next, 100L).isEmpty(), "a replacement goal starts its own fence");
		String version3 = "{\"schema_version\":3,\"last_sequence\":2,\"events\":["
				+ "{\"agent_id\":\"" + agent + "\",\"entity_type\":\"minecraft:zombie\",\"occurred_at_epoch_ms\":99,\"sequence\":1},"
				+ "{\"agent_id\":\"" + agent + "\",\"entity_type\":\"minecraft:skeleton\",\"occurred_at_epoch_ms\":101,\"sequence\":2}],\"progress\":[]}";
		AgentKillLedger migrated = new AgentKillLedger(new AgentKillLedgerCodec().decode(version3), () -> { });
		migrated.synchronizeProgress(List.of(), List.of(new AgentKillLedger.GoalActivation(goal, agent, 100L)));
		check(PlanProgressFacts.verifiedKills(migrated.snapshot(), agent, goal, 100L).equals(List.of("minecraft:skeleton")),
				"a goal active in an older save keeps its timestamp boundary as its fence");
		migrated.record(agent, "minecraft:spider", 102L);
		migrated.synchronizeProgress(List.of(), List.of(new AgentKillLedger.GoalActivation(goal, agent, 100L), new AgentKillLedger.GoalActivation(next, other, 102L)));
		check(PlanProgressFacts.verifiedKills(migrated.snapshot(), agent, goal, 100L).equals(List.of("minecraft:skeleton", "minecraft:spider")),
				"after migration later kills still count");
		check(PlanProgressFacts.verifiedKills(migrated.snapshot(), other, next, 102L).isEmpty(), "a goal activated after migration is fenced at activation");
		return 8 + verifyNonmonotonicMigration(agent, goal);
	}

	/** Saved timestamps can go backwards (clock correction): migration keeps exactly the kills the old boundary credited. */
	private static int verifyNonmonotonicMigration(AgentId agent, java.util.UUID goal) {
		String zombie = "{\"agent_id\":\"" + agent + "\",\"entity_type\":\"minecraft:zombie\",\"occurred_at_epoch_ms\":110";
		String spider = "{\"agent_id\":\"" + agent + "\",\"entity_type\":\"minecraft:spider\",\"occurred_at_epoch_ms\":90";
		List<String> saves = List.of(
				"{\"schema_version\":1,\"events\":[" + zombie + "}," + spider + "}]}",
				"{\"schema_version\":2,\"events\":[" + zombie + "}," + spider + "}],\"progress\":[]}",
				"{\"schema_version\":3,\"last_sequence\":2,\"events\":[" + zombie + ",\"sequence\":1}," + spider + ",\"sequence\":2}],\"progress\":[]}");
		AgentKillLedgerCodec codec = new AgentKillLedgerCodec();
		for (String save : saves) {
			AgentKillLedger migrated = new AgentKillLedger(codec.decode(save), () -> { });
			migrated.synchronizeProgress(List.of(), List.of(new AgentKillLedger.GoalActivation(goal, agent, 100L)));
			check(PlanProgressFacts.verifiedKills(migrated.snapshot(), agent, goal, 100L).equals(List.of("minecraft:zombie")),
					"migration keeps the kill the timestamp boundary credited, even when a later sequence has an older timestamp");
			AgentKillLedger reloaded = new AgentKillLedger(codec.decode(codec.encode(migrated.snapshot())), () -> { });
			reloaded.synchronizeProgress(List.of(), List.of(new AgentKillLedger.GoalActivation(goal, agent, 100L)));
			check(PlanProgressFacts.verifiedKills(reloaded.snapshot(), agent, goal, 100L).equals(List.of("minecraft:zombie")),
					"the migrated credit survives another save and reload");
			reloaded.record(agent, "minecraft:skeleton", 95L);
			check(PlanProgressFacts.verifiedKills(reloaded.snapshot(), agent, goal, 100L).equals(List.of("minecraft:zombie", "minecraft:skeleton")),
					"kills after migration count by sequence whatever their timestamp");
		}
		return 9;
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
