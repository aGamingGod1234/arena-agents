package dev.agaminggod.arenaagents.server.watch;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;

/** Watcher episode state machine, outcome rules, diagnosis precedence, schema and isolation, without a server. */
public final class WatchVerification {
	private static int assertions;
	private static final Set<String> VOCABULARY = Set.of("creeper_fusing", "hostile_near", "lava_near", "in_lava", "on_fire", "edge_near",
			"falling", "incoming_projectile", "air_below", "health_below");

	private WatchVerification() {
	}

	public static int verify() {
		assertions = 0;
		opensBelowThresholdAndMergesSameSource();
		closesAfterGrace();
		outcomes();
		damageAttribution();
		deathClosesEverything();
		diagnosisPrecedence();
		heardDragon();
		schema();
		isolation();
		harmUnderAnotherCommand();
		return assertions;
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError("WatchVerification: " + message);
		assertions++;
	}

	private static Danger mob(String uuid, double eta) {
		return new Danger(uuid, "mob", "minecraft:zombie", uuid, null, eta, 3.0D);
	}

	private static void opensBelowThresholdAndMergesSameSource() {
		EpisodeTracker tracker = new EpisodeTracker("a");
		tracker.observe(List.of(mob("z1", 5.0D)), 0L, 0L, 20.0F, false);
		check(!tracker.hasOpen(), "a danger 5 s away opens nothing");
		tracker.observe(List.of(mob("z1", 2.5D)), 1L, 50L, 20.0F, false);
		check(tracker.hasOpen(), "a danger under 3 s opens an episode");
		check(tracker.takeOpened().size() == 1, "one episode opened");
		tracker.observe(List.of(mob("z1", 1.5D), new Danger("z1", "projectile", "minecraft:skeleton", "z1", null, 0.4D, 9.0D)), 2L, 100L, 20.0F, false);
		check(tracker.takeOpened().isEmpty(), "the same source keeps its episode");
		Episode episode = tracker.open().iterator().next();
		check(episode.minEtaS == 0.4D, "the minimum time-to-harm is kept");
		tracker.observe(List.of(mob("z2", 1.0D)), 3L, 150L, 20.0F, false);
		check(tracker.takeOpened().size() == 1, "another source opens its own episode");
	}

	private static void closesAfterGrace() {
		EpisodeTracker tracker = new EpisodeTracker("a");
		tracker.observe(List.of(mob("z1", 2.0D)), 0L, 0L, 20.0F, false);
		// Still present but no longer active (6 s away): only the grace period keeps it.
		check(tracker.observe(List.of(mob("z1", 6.0D)), EpisodeTracker.GRACE_TICKS - 1L, 1_000L, 20.0F, false).isEmpty(),
				"inside the grace period the episode stays open");
		tracker.observe(List.of(mob("z1", 2.0D)), EpisodeTracker.GRACE_TICKS - 1L, 1_000L, 20.0F, false);
		check(tracker.observe(List.of(), EpisodeTracker.GRACE_TICKS * 2L - 2L, 2_000L, 20.0F, false).isEmpty(), "renewed activity resets the grace");
		List<Episode> closed = tracker.observe(List.of(), EpisodeTracker.GRACE_TICKS * 2L, 3_000L, 20.0F, false);
		check(closed.size() == 1 && closed.get(0).closed(), "the episode closes once the grace has passed");
		check(closed.get(0).outcome().equals("avoided"), "2 s away at best and no harm is avoided");
		check(!tracker.hasOpen(), "nothing left open");
	}

	private static String outcomeOf(double minEta, float minHealth, boolean burning, float damage, boolean died) {
		Episode episode = new Episode("e", "a", mob("z", minEta), 0L, 0L);
		episode.minEtaS = minEta;
		episode.minHealth = minHealth;
		episode.burnedOrInLava = burning;
		episode.damage = damage;
		episode.died = died;
		return EpisodeTracker.outcome(episode);
	}

	private static void outcomes() {
		check(outcomeOf(0.0D, 0.0F, true, 5.0F, true).equals("death"), "death wins");
		check(outcomeOf(0.0D, 10.0F, false, 2.0F, false).equals("damage"), "damage without death");
		check(outcomeOf(0.8D, 20.0F, false, 0.0F, false).equals("close_call"), "under a second is a close call");
		check(outcomeOf(2.0D, 6.0F, false, 0.0F, false).equals("close_call"), "health at 6 is a close call");
		check(outcomeOf(2.0D, 20.0F, true, 0.0F, false).equals("close_call"), "burning or in lava is a close call");
		check(outcomeOf(1.0D, 6.5F, false, 0.0F, false).equals("avoided"), "a second away and healthy is avoided");
	}

	private static void damageAttribution() {
		EpisodeTracker tracker = new EpisodeTracker("a");
		tracker.observe(List.of(mob("skel", 1.2D), new Danger("lava", "lava", "minecraft:lava", null, new int[] {1, 2, 3}, 0.5D, 0.4D)),
				0L, 0L, 20.0F, false);
		tracker.takeOpened();
		Episode shot = tracker.damage("skel", "projectile", "minecraft:skeleton", "skel", null, 3.0F, 17.0F, 1L, 50L);
		check(shot.key().equals("skel") && shot.damage() == 3.0F, "a shooter's arrow joins the shooter's episode");
		Episode burn = tracker.damage(null, "burning", "minecraft:on_fire", null, null, 1.0F, 16.0F, 2L, 100L);
		check(burn.kind().equals("lava"), "fire damage joins the open lava episode");
		check(tracker.takeOpened().isEmpty(), "attributed damage opens nothing");
		Episode fall = tracker.damage(null, "fall", "minecraft:fall", null, new int[] {0, 60, 0}, 4.0F, 12.0F, 3L, 150L);
		check(fall.kind().equals("fall") && tracker.takeOpened().size() == 1, "unforeseen damage opens its own episode");
		check(fall.firstHarmEpochMs() == 150L && fall.minEtaS() == 0.0D, "harm sets the first-harm time and contact");
	}

	private static void deathClosesEverything() {
		EpisodeTracker tracker = new EpisodeTracker("a");
		tracker.observe(List.of(mob("z1", 1.0D), mob("z2", 2.5D)), 0L, 0L, 20.0F, false);
		List<Episode> closed = tracker.death("z1", "mob", "minecraft:zombie", "z1", null, "a was slain by Zombie", 5L, 250L);
		check(closed.size() == 2 && !tracker.hasOpen(), "death closes every open episode");
		Episode killer = closed.stream().filter(episode -> episode.key().equals("z1")).findFirst().orElseThrow();
		Episode other = closed.stream().filter(episode -> episode.key().equals("z2")).findFirst().orElseThrow();
		check(killer.outcome().equals("death") && "a was slain by Zombie".equals(killer.deathMessage), "the killer's episode records the death");
		check(other.outcome().equals("avoided"), "the bystander's episode keeps its own outcome");
	}

	private static Episode harmed(String kind, String entityId) {
		Episode episode = new Episode("e", "a", new Danger("k", kind, "minecraft:x", entityId, null, 0.0D, 0.0D), 0L, 1_000L);
		episode.damage = 4.0F;
		episode.firstHarmEpochMs = 2_000L;
		episode.closedEpochMs = 3_000L;
		episode.outcome = "damage";
		episode.perceivable = true;
		episode.inObservation = true;
		episode.inThreatFacts = true;
		return episode;
	}

	private static String label(Episode episode) {
		Diagnosis.diagnose(episode, VOCABULARY);
		check(episode.evidence() != null && !episode.evidence().isEmpty(), "every label carries evidence");
		return episode.diagnosis();
	}

	private static void diagnosisPrecedence() {
		Episode all = harmed("lava", null);
		all.causedByAction = true;
		all.action = "navigate_to";
		all.fired.add(new Episode.Firing("lava", 1_500L, "failed"));
		all.perceivable = false;
		check(label(all).equals("BODY_CAUSED"), "body walking into it outranks everything");
		Episode nearMiss = harmed("drop", null);
		nearMiss.damage = 0.0F;
		nearMiss.firstHarmEpochMs = -1L;
		nearMiss.outcome = "close_call";
		nearMiss.causedByAction = true;
		nearMiss.action = "navigate_to";
		check(!label(nearMiss).equals("BODY_CAUSED"), "a body action that only came near is not blamed");

		Episode failed = harmed("lava", null);
		failed.fired.add(new Episode.Firing("lava", 1_500L, "failed: no exit"));
		failed.perceivable = false;
		check(label(failed).equals("REFLEX_FAILED"), "a covering reflex that fired before the harm failed");

		Episode slow = harmed("mob", "z");
		slow.fired.add(new Episode.Firing("flee", 2_400L, "done"));
		slow.armed.add("flee:hostile_near");
		check(label(slow).equals("REFLEX_SLOW"), "a covering reflex that fired after the harm was slow");
		Episode late = harmed("mob", "z");
		late.fired.add(new Episode.Firing("flee", 10_000L, "done"));
		check(label(late).equals("MODEL_CHOICE") && late.evidence().contains("armed later"),
				"a covering rule armed only after the harm began was missing, not slow: " + late.evidence());

		Episode hidden = harmed("lava_hidden", null);
		hidden.perceivable = false;
		hidden.inObservation = false;
		check(label(hidden).equals("UNPERCEIVABLE"), "nothing a player could perceive");

		Episode gap = harmed("creeper", "c");
		gap.inObservation = false;
		check(label(gap).equals("PERCEPTION_GAP"), "perceivable but missing from the observation");

		Episode noPrimitive = harmed("dragon_breath", "cloud");
		check(label(noPrimitive).equals("NO_PRIMITIVE"), "no vocabulary covers the kind (cloud_near absent here)");

		Episode fact = harmed("mob", "z");
		fact.inThreatFacts = false;
		check(label(fact).equals("FACT_GAP"), "seen but not described as a threat");

		Episode choice = harmed("mob", "z");
		check(label(choice).equals("MODEL_CHOICE"), "everything was there: the model's choice");

		Episode escaped = harmed("mob", "z");
		escaped.damage = 0.0F;
		escaped.firstHarmEpochMs = -1L;
		escaped.outcome = "avoided";
		escaped.fired.add(new Episode.Firing("flee", 1_200L, "done"));
		check(label(escaped).equals("MODEL_CHOICE"), "a reflex that worked is not a reflex failure");

		check(Diagnosis.RULES.get(0).label().equals("BODY_CAUSED") && Diagnosis.RULES.get(Diagnosis.RULES.size() - 1).label().equals("MODEL_CHOICE"),
				"the rule table is ordered by precedence with MODEL_CHOICE last");
		check(Diagnosis.RULES.size() == 8, "exactly eight labels");
	}

	private static void schema() {
		Episode episode = harmed("creeper", "c-1");
		episode.dim = "minecraft:overworld";
		episode.armed.add("boom:creeper_fusing");
		episode.lastReplyAgoS = 4.25D;
		Diagnosis.diagnose(episode, VOCABULARY);
		JsonObject row = JsonParser.parseString(WatchJson.line(WatchJson.episode(episode))).getAsJsonObject();
		for (String key : List.of("v", "type", "id", "agentId", "dim", "pos", "kind", "source", "openedAt", "closedAt", "minEtaS", "minHealth",
				"outcome", "damage", "deathMessage", "perceived", "cover", "body", "model", "forecastId", "diagnosis", "evidence")) {
			check(row.has(key), "episode line has " + key);
		}
		check(row.keySet().size() == 22, "episode line has no extra fields");
		check(row.get("v").getAsInt() == 1 && row.get("type").getAsString().equals("episode"), "schema v1 episode");
		check(row.getAsJsonObject("source").get("block").isJsonNull() && row.getAsJsonObject("source").get("entityId").getAsString().equals("c-1"),
				"entity source has an id and a null block");
		check(row.getAsJsonObject("source").has("pos") && row.getAsJsonObject("body").get("action").isJsonNull(),
				"source.pos and a null body.action are present");
		episode.action = "navigate_to";
		episode.actionArguments = JsonParser.parseString("{\"x\":1,\"y\":64,\"z\":2}").getAsJsonObject();
		episode.sourcePos = new double[] {1.0D, 2.0D, 3.0D};
		JsonObject withAction = WatchJson.episode(episode);
		check(withAction.getAsJsonObject("body").getAsJsonObject("action").get("actionType").getAsString().equals("navigate_to")
				&& withAction.getAsJsonObject("body").getAsJsonObject("action").getAsJsonObject("arguments").get("y").getAsInt() == 64,
				"body.action is {actionType, arguments}");
		check(withAction.getAsJsonObject("source").getAsJsonObject("pos").get("z").getAsDouble() == 3.0D, "source.pos carries the position");
		check(row.get("deathMessage").isJsonNull() && row.get("forecastId").isJsonNull(), "unfilled fields are written as null");
		JsonObject forecast = JsonParser.parseString(WatchJson.line(WatchJson.forecast(new WatchJson.Forecast("f1", "a", 5L, "navigate_to", "lava",
				new int[] {1, 2, 3}, 4.5D, "route crosses lava")))).getAsJsonObject();
		check(forecast.keySet().equals(Set.of("v", "type", "id", "agentId", "atMs", "action", "hazard", "detail")), "forecast line fields");
		check(forecast.getAsJsonObject("hazard").keySet().equals(Set.of("kind", "block", "distance")), "forecast hazard fields");
		check(Forecasts.matches("lava", new int[] {1, 2, 3}, "lava", new int[] {2, 2, 4}), "an episode next to a forecast hazard links");
		check(!Forecasts.matches("lava", new int[] {1, 2, 3}, "lava", new int[] {9, 2, 9}), "a distant one does not");
	}

	/** A dragon sound reaches the agent without a uuid; the dragon is one per fight, so it counts as heard while fresh. */
	private static void heardDragon() {
		JsonObject delivery = JsonParser.parseString("{\"perception\":{\"events\":["
				+ "{\"type\":\"sound\",\"soundId\":\"minecraft:entity.ender_dragon.ambient\",\"observedAtEpochMs\":1000},"
				+ "{\"type\":\"sound\",\"soundId\":\"minecraft:entity.ender_dragon.ambient\",\"observedAtEpochMs\":4000},"
				+ "{\"type\":\"sound\",\"soundId\":\"minecraft:entity.zombie.ambient\",\"observedAtEpochMs\":4000},"
				+ "{\"type\":\"sound\",\"soundId\":\"minecraft:block.lava.pop\",\"observedAtEpochMs\":4000}]}}").getAsJsonObject();
		java.util.Map<String, Long> heard = Watcher.heardTypes(delivery);
		check(heard.get("minecraft:ender_dragon") == 4000L && heard.get("minecraft:zombie") == 4000L && heard.size() == 2,
				"entity sounds are keyed by type with their latest time");
		Watcher.Delivered delivered = new Watcher.Delivered(Set.of(), Set.of(), false, false, 4000L, heard);
		check(Watcher.heardFresh(delivered, "minecraft:ender_dragon", 9000L), "a dragon heard 5 s ago is still placed");
		check(!Watcher.heardFresh(delivered, "minecraft:ender_dragon", 9001L), "an older dragon sound is not");
		check(!Watcher.heardFresh(delivered, "minecraft:zombie", 4500L), "a zombie sound names no particular zombie");
		Episode heardOnly = new Episode("h", "a", new Danger("d", "dragon", "minecraft:ender_dragon", "d", null, 0.3D, 12.0D), 0L, 0L);
		heardOnly.perceivable = true;
		heardOnly.inObservation = true;
		Diagnosis.diagnose(heardOnly, Set.of("hostile_near"));
		check(heardOnly.diagnosis().equals("FACT_GAP") && heardOnly.evidence().contains("only heard"), "a dragon only heard has no facts");
		heardOnly.inThreatFacts = true;
		heardOnly.seenRow = true;
		Diagnosis.diagnose(heardOnly, Set.of("hostile_near"));
		check(heardOnly.diagnosis().equals("MODEL_CHOICE"), "a dragon row reaching the model carries its fight facts");
		Episode pearl = new Episode("p", "a", new Danger("pearl", "ender_pearl", "minecraft:ender_pearl", null, new int[] {0, 64, 0}, 0.0D, 0.0D), 0L, 0L);
		pearl.perceivable = true;
		pearl.inObservation = true;
		pearl.inThreatFacts = true;
		pearl.damage = 5.0F;
		Diagnosis.diagnose(pearl, VOCABULARY);
		check(pearl.diagnosis().equals("MODEL_CHOICE"), "the model's own pearl throw is its choice, not a missing reflex");
		// Client-only sounds (wing flaps) reach the agent only as heard rows; their age is the delivery time less secondsAgo.
		JsonObject rows = JsonParser.parseString("{\"observedAtEpochMs\":20000,\"heard\":["
				+ "{\"sound\":\"entity.ender_dragon.flap\",\"direction\":\"back\",\"elevation\":\"above\",\"distance\":15,\"count\":4},"
				+ "{\"sound\":\"entity.wither.ambient\",\"direction\":\"left\",\"elevation\":\"level\",\"distance\":30,\"secondsAgo\":7},"
				+ "{\"sound\":\"block.lava.pop\",\"direction\":\"front\",\"elevation\":\"below\",\"distance\":6}]}").getAsJsonObject();
		java.util.Map<String, Long> fromRows = Watcher.heardTypes(rows);
		check(fromRows.get("minecraft:ender_dragon") == 20000L && fromRows.get("minecraft:wither") == 13000L && fromRows.size() == 2,
				"heard rows name their entity type, aged by secondsAgo");
		// The lava check reads the delivered observation's top-level heard rows, the field the collector writes.
		dev.agaminggod.arenaagents.agent.AgentId agent = dev.agaminggod.arenaagents.agent.AgentId.parse("00000000-0000-0000-0000-00000000d190");
		Watcher.delivered(agent, rows, 20000L);
		check(Watcher.deliveredTo(agent).heardLava() && Watcher.heardFresh(Watcher.deliveredTo(agent), "minecraft:ender_dragon", 24000L),
				"a delivery with a heard lava pop and a heard flap counts both");
		Watcher.delivered(agent, JsonParser.parseString("{\"observedAtEpochMs\":21000}").getAsJsonObject(), 21000L);
		check(!Watcher.deliveredTo(agent).heardLava(), "silence is not heard lava");
	}

	/**
	 * Watcher data must never reach the model: outside its own package only the runtime's registration line names it,
	 * so no observation, perception, wake or tool-result code can read it; and the watch package never sends anything.
	 */
	private static void isolation() {
		Path root = Path.of("src/main/java/dev/agaminggod/arenaagents");
		try (Stream<Path> files = Files.walk(root)) {
			for (Path file : files.filter(path -> path.toString().endsWith(".java")).toList()) {
				String text = Files.readString(file);
				boolean inWatch = file.toString().replace('\\', '/').contains("/server/watch/");
				if (inWatch) {
					for (String forbidden : List.of("BridgeTap.delivered", "BridgeTap.model", "sendObservation", "queueUrgentObservation",
							"publishOwned", ".send(", "enqueue", "ServerObservationCollector", "addProperty(\"watch")) {
						check(!text.contains(forbidden), file + " must not use " + forbidden);
					}
					continue;
				}
				if (!text.contains("arenaagents.server.watch")) continue;
				check(file.getFileName().toString().equals("CodexAgentServerRuntime.java"), file + " must not reference the watch package");
				check(text.split("arenaagents\\.server\\.watch", -1).length == 2
						&& text.contains("dev.agaminggod.arenaagents.server.watch.Watcher.register();"),
						"the runtime only registers the Watcher");
			}
		} catch (IOException failure) {
			throw new UncheckedIOException(failure);
		}
	}

	/**
	 * A move that approached the drop marks the body as the cause only while it still runs at the first harm: a later
	 * command that drops the body (breaking the log under the feet) is not "the move moved toward the drop".
	 */
	private static void harmUnderAnotherCommand() {
		dev.agaminggod.arenaagents.agent.AgentId agent = dev.agaminggod.arenaagents.agent.AgentId.parse("00000000-0000-0000-0000-000000000601");
		var provenance = new dev.agaminggod.arenaagents.server.runtime.ActionProvenance("codex", "m", "low", "default", "tool", 1L, "step", 1L);
		var pickup = new dev.agaminggod.arenaagents.server.runtime.ServerActionRequest(agent, 1L, "pick", dev.agaminggod.arenaagents.protocol.ActionType.PICK_UP_ITEM,
				new com.google.gson.JsonObject(), provenance);
		var mine = new dev.agaminggod.arenaagents.server.runtime.ServerActionRequest(agent, 1L, "mine", dev.agaminggod.arenaagents.protocol.ActionType.BREAK_BLOCK,
				new com.google.gson.JsonObject(), provenance);
		Episode later = new Episode("e1", "a", mob("d", 0.3D), 0L, 0L);
		later.causedByAction = true;
		later.causedActionId = "pick";
		later.action = "pick_up_item";
		Watcher.harmedUnder(later, mine);
		check(!later.causedByAction && "break_block".equals(later.action), "harm under a later command is that command's");
		Episode same = new Episode("e2", "a", mob("d", 0.3D), 0L, 0L);
		same.causedByAction = true;
		same.causedActionId = "pick";
		same.action = "pick_up_item";
		Watcher.harmedUnder(same, pickup);
		check(same.causedByAction && "pick_up_item".equals(same.action), "harm while the move still runs stays the body's");
		Episode idle = new Episode("e3", "a", mob("d", 0.3D), 0L, 0L);
		idle.causedByAction = true;
		idle.causedActionId = "pick";
		Watcher.harmedUnder(idle, null);
		check(!idle.causedByAction, "harm after the move ended is not the move's");
	}
}
