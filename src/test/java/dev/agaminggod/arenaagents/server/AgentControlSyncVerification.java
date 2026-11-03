package dev.agaminggod.arenaagents.server;

import dev.agaminggod.arenaagents.agent.AgentEntityLocation;
import dev.agaminggod.arenaagents.agent.AgentRegistry;
import dev.agaminggod.arenaagents.control.AgentControlActions;
import dev.agaminggod.arenaagents.control.AgentControlCatalog;
import dev.agaminggod.arenaagents.control.AgentControlGroup;
import dev.agaminggod.arenaagents.control.AgentControlRedaction;
import dev.agaminggod.arenaagents.control.AgentControlSnapshotPayload;
import dev.agaminggod.arenaagents.scenario.presentation.ScenarioBuildProgress;
import dev.agaminggod.arenaagents.scenario.presentation.ScenarioPresentationExpiry;
import java.util.UUID;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import net.minecraft.server.level.ServerPlayer;

public final class AgentControlSyncVerification {
	private AgentControlSyncVerification() {
	}

	public static void main(String[] args) {
		var out = System.out;
		var err = System.err;
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		System.setOut(out);
		System.setErr(err);
		System.out.println("PASS: " + verify() + " control sync assertions");
		System.out.println("PASS: " + AgentRecoverySpawnPolicyVerification.verify() + " recovery policy assertions");
	}

	public static int verify() {
		AtomicInteger actions = new AtomicInteger();
		assertTrue(!AgentControlSync.executeAuthorizedControlAction(false, actions::incrementAndGet),
				"non-operator control request is rejected");
		assertEquals(0, actions.get(), "non-operator rejection happens before snapshot or action work");
		assertTrue(AgentControlSync.executeAuthorizedControlAction(true, actions::incrementAndGet),
				"operator control request is accepted");
		assertEquals(1, actions.get(), "operator snapshot or action work runs exactly once");

		AtomicInteger denials = new AtomicInteger();
		assertTrue(!AgentControlSync.executeAuthorizedControlAction(
				false, actions::incrementAndGet, denials::incrementAndGet),
				"denied mutation returns an explicit rejection result");
		assertEquals(1, denials.get(), "denied mutation publishes one rejection");
		assertTrue(AgentControlSync.executeAuthorizedControlAction(
				true, actions::incrementAndGet, denials::incrementAndGet),
				"authorized mutation does not use its rejection path");
		assertEquals(1, denials.get(), "authorized mutation leaves the rejection count unchanged");
		assertEquals(2, actions.get(), "authorized mutation still runs exactly once");

		assertEquals("Arena launch", AgentControlSync.rejectedBuildTitle(
				new dev.agaminggod.arenaagents.scenario.ScenarioLaunchPayload("{not json")),
				"a malformed launch body still produces a bounded rejection title");

		AgentControlSync.SpectatorPublication publication = new AgentControlSync.SpectatorPublication();
		UUID playerId = UUID.fromString("11111111-2222-3333-4444-555555555555");
		ScenarioBuildProgress rejection = ScenarioBuildProgress.rejected(
				"rejected-a", "The Last Valley", 0, 70, 0, "Launch rejected");
		publication.rememberDirectBuild(playerId, rejection, 100L);
		assertEquals(rejection, publication.directBuild(playerId, 100L).orElseThrow(),
				"direct launch rejection is retained after publication");
		assertEquals(rejection, publication.directBuild(
				playerId, 100L + ScenarioPresentationExpiry.BUILD_TERMINAL_TTL_TICKS - 1L).orElseThrow(),
				"direct launch rejection remains visible until the terminal TTL boundary");
		assertTrue(publication.directBuild(
				playerId, 100L + ScenarioPresentationExpiry.BUILD_TERMINAL_TTL_TICKS).isEmpty(),
				"direct launch rejection expires exactly at the terminal TTL boundary");
		publication.rememberDirectBuild(playerId, rejection, 500L);
		assertTrue(publication.directBuild(
				playerId, 500L + ScenarioPresentationExpiry.BUILD_TERMINAL_TTL_TICKS - 1L).isPresent(),
				"a repeated direct rejection starts a fresh terminal TTL");
		publication.forgetBuild(playerId);
		assertTrue(publication.directBuild(playerId, 500L).isEmpty(),
				"build tombstone cleanup removes the direct rejection clock and payload");
		return 14 + verifyObservedPresence() + verifySnapshotRequestLimit() + verifySnapshotRedaction();
	}

	private static int verifySnapshotRequestLimit() {
		UUID spammer = UUID.fromString("00000000-0000-4000-8000-00000000000a");
		UUID console = UUID.fromString("00000000-0000-4000-8000-00000000000b");
		SnapshotRequestLimiter limiter = new SnapshotRequestLimiter();
		// A modded client firing 1000 requests at once gets a burst now and the rest deferred or dropped.
		int sent = 0, deferred = 0, dropped = 0;
		for (int request = 0; request < 1000; request++) {
			switch (limiter.request(spammer, 10_000L)) {
				case SEND -> sent++;
				case DEFERRED -> deferred++;
				case DROPPED -> dropped++;
			}
		}
		assertEquals(SnapshotRequestLimiter.BURST, sent, "a burst is answered at once");
		assertEquals(SnapshotRequestLimiter.MAX_DEFERRED, deferred, "a bounded number wait for tokens");
		assertEquals(1000 - SnapshotRequestLimiter.BURST - SnapshotRequestLimiter.MAX_DEFERRED, dropped, "the rest are dropped");
		assertEquals(dropped, (int) limiter.dropped(spammer), "drops are counted per requester");
		int builtInFirstSecond = sent;
		for (long now = 10_000L; now <= 11_000L; now += 50L) builtInFirstSecond += limiter.due(now).getOrDefault(spammer, 0);
		assertEquals(SnapshotRequestLimiter.BURST + 4, builtInFirstSecond, "1000 requests build 8 snapshots in their first second");
		int lateAnswers = 0;
		for (long now = 11_050L; now <= 13_000L; now += 50L) lateAnswers += limiter.due(now).getOrDefault(spammer, 0);
		assertEquals(SnapshotRequestLimiter.MAX_DEFERRED - 4, lateAnswers, "every deferred request is answered once");

		// The Field Console (one request a second, a few more after a command) is never deferred.
		for (long now = 20_000L; now < 80_000L; now += 1_000L) {
			assertEquals(SnapshotRequestLimiter.Decision.SEND, limiter.request(console, now), "periodic refresh is answered at once");
			if (now % 10_000L == 0L) {
				assertEquals(SnapshotRequestLimiter.Decision.SEND, limiter.request(console, now + 5L), "post-command refresh is answered at once");
				assertEquals(SnapshotRequestLimiter.Decision.SEND, limiter.request(console, now + 10L), "director result refresh is answered at once");
			}
			assertEquals(0, (int) limiter.due(now + 20L).getOrDefault(console, 0), "nothing was deferred");
		}
		// A burst above the bucket is answered one for one, so the console's request/response pairing holds.
		int answered = 0;
		for (int request = 0; request < 6; request++) if (limiter.request(console, 90_000L) == SnapshotRequestLimiter.Decision.SEND) answered++;
		for (long now = 90_000L; now <= 91_000L; now += 50L) answered += limiter.due(now).getOrDefault(console, 0);
		assertEquals(6, answered, "an over-burst request is deferred, not lost");
		assertEquals(0, (int) limiter.dropped(console), "the console never loses a request");
		limiter.request(spammer, 100_000L);
		limiter.retain(java.util.Set.of(console));
		assertEquals(0, (int) limiter.dropped(spammer), "a disconnected requester is forgotten");
		limiter.due(200_000L);
		assertEquals(0, limiter.tracked(), "idle full buckets are forgotten");
		return 6 + 60 * 2 + 6 * 2 + 4;
	}

	private static int verifySnapshotRedaction() {
		int assertions = 0;
		String secrets = "Run with OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx and Authorization: Bearer abcdefgh12345678"
				+ " from /home/lucas/.codex/config.toml or C:\\Users\\Lucas\\AppData\\Roaming\\npm (token=hunter2xyz, AIzaSyA1234567890abcdefghijklmnopqrstuv)";
		String redacted = AgentControlRedaction.redactText(secrets, 512);
		for (String leaked : List.of("sk-proj", "abcdefgh12345678", "lucas", "Lucas", "hunter2", "AIzaSy")) {
			assertTrue(!redacted.contains(leaked), "redacted text drops " + leaked + ": " + redacted);
			assertions++;
		}
		for (String kept : List.of("OPENAI_API_KEY=[REDACTED]", "Bearer [REDACTED]", "~/.codex/config.toml", "~\\AppData\\Roaming\\npm", "token=[REDACTED]")) {
			assertTrue(redacted.contains(kept), "redacted text keeps " + kept + ": " + redacted);
			assertions++;
		}
		for (String ordinary : List.of("Mine 12 oak logs near 120 64 -30, then craft a table",
				"Agent 01234567-89ab-cdef-0123-456789abcdef used tokens: 4096", "PATH not found", "https://example.com/home/page")) {
			assertEquals(ordinary, AgentControlRedaction.redactText(ordinary, 512), "ordinary text is unchanged");
			assertions++;
		}
		assertEquals(256, AgentControlRedaction.redactText("A_B=x ".repeat(100), 256).length(), "redaction stays within the field bound");
		assertions++;

		AgentRegistry registry = AgentRegistry.createDefault(() -> { }, ignored -> { });
		var agent = registry.create("gpt-6.1-sol", "low", Optional.empty(), 100L);
		registry.attachEntity(agent.agentId(), UUID.randomUUID(), AgentEntityLocation.exact("minecraft:the_nether", 7, -3, 115, 42, -40, 90, 5), 101L);
		registry.start(agent.agentId(), "Build a base. Use GEMINI_API_KEY=AIzaSyA1234567890abcdefghijklmnopqrstuv from /home/lucas/keys", 102L);
		var groups = List.<AgentControlGroup>of();
		var catalog = AgentControlCatalog.currentOptions();
		var operator = AgentControlSync.controlSnapshot(true, true, "Automation ready", 103L, registry.records(), groups, catalog, ignored -> Optional.empty()).agents().getFirst();
		assertEquals("Build a base. Use GEMINI_API_KEY=[REDACTED] from ~/keys", operator.currentGoal(), "an operator sees the goal without secrets or home paths");
		var viewer = AgentControlSync.controlSnapshot(false, true, "Automation ready", 104L, registry.records(), groups, catalog, ignored -> Optional.empty());
		assertTrue(!viewer.canControl(), "a non-operator snapshot says so");
		assertEquals("", viewer.agents().getFirst().currentGoal(), "a non-operator gets no goal text");
		assertEquals("", viewer.agents().getFirst().lastSummary(), "a non-operator gets no summary text");
		assertEquals("", viewer.agents().getFirst().lastError(), "a non-operator gets no error text");
		assertEquals(operator.displayName(), viewer.agents().getFirst().displayName(), "a non-operator still sees the roster");
		assertEquals(viewer, new AgentControlSnapshotPayload(AgentControlSnapshotPayload.fromSnapshot(viewer).encodedSnapshot()).snapshot(),
				"the redacted snapshot survives the payload codec");
		assertions += 7;

		var voice = new dev.agaminggod.arenaagents.server.voice.VoiceProfile("voice.custom.lucas", "warm", 1.25D, 24);
		var actor = new dev.agaminggod.arenaagents.control.DirectorSnapshotPayload.Actor(agent.agentId().toString(), "Sol", "Sol", "default", false, true,
				"Speech failed: C:\\Users\\Lucas\\voice\\model.bin", voice);
		var operatorActor = AgentControlSync.directorActor(actor, true);
		assertEquals(voice, operatorActor.voiceProfile(), "an operator keeps the voice settings");
		assertEquals("Speech failed: ~\\voice\\model.bin", operatorActor.speechStatus(), "speech status loses the home directory");
		assertEquals(dev.agaminggod.arenaagents.server.voice.VoiceProfile.defaults(), AgentControlSync.directorActor(actor, false).voiceProfile(),
				"a non-operator gets no voice settings");
		assertions += 3;
		return assertions;
	}

	private static int verifyObservedPresence() {
		AgentRegistry registry = AgentRegistry.createDefault(() -> { }, ignored -> { });
		var active = registry.create("gpt-6.1-sol", "low", Optional.empty(), 100L);
		var idle = registry.create("gpt-6.1-sol", "low", Optional.empty(), 101L);
		var location = AgentEntityLocation.exact("minecraft:the_nether", 7, -3, 115, 42, -40, 90, 5);
		UUID attachment = UUID.randomUUID();
		registry.attachEntity(active.agentId(), attachment, location, 102L);
		registry.attachEntity(idle.agentId(), UUID.randomUUID(), location, 102L);
		registry.start(active.agentId(), "continue mining", 103L);
		CodexAgentManager.prepareMissingPlayer(registry, registry.require(active.agentId()), true,
				new java.util.LinkedHashSet<>(), 104L);
		var groups = List.of(new AgentControlGroup("Recovery", List.of(active.agentId().toString(), idle.agentId().toString())));
		var catalog = AgentControlCatalog.currentOptions();
		var absent = AgentControlSync.controlSnapshot(true, true, "Automation ready", 105L,
				registry.records(), groups, catalog, ignored -> Optional.empty());
		int assertions = 0;
		for (var control : absent.agents()) {
			assertTrue(!control.entityPresent(), "absent active and idle agents have no live body");
			assertTrue(!AgentControlActions.supports(control, "start"), "absent body disables Start");
			assertTrue(!AgentControlActions.supports(control, "resume"), "absent body disables Resume");
			assertions += 3;
		}
		assertEquals(groups, absent.groups(), "presence projection retains saved groups");
		assertEquals(catalog, absent.catalog(), "presence projection retains the runtime model catalog");
		assertEquals(absent, new AgentControlSnapshotPayload(
				AgentControlSnapshotPayload.fromSnapshot(absent).encodedSnapshot()).snapshot(),
				"missing-body control flag survives the actual payload codec");
		assertEquals(Optional.of(attachment), registry.require(active.agentId()).entityUuid(), "projection retains the exact UUID");
		assertEquals(Optional.of(location), registry.require(active.agentId()).entityLocation(), "projection retains exact recovery coordinates");
		assertions += 5;
		FixturePlayer body = fixturePlayer();
		for (boolean alive : List.of(false, true)) {
			body.alive = alive;
			var snapshot = AgentControlSync.controlSnapshot(true, true, "Automation ready", 106L,
					registry.records(), groups, catalog, ignored -> Optional.of(body));
			for (var control : snapshot.agents()) {
				assertEquals(alive, control.entityPresent(), "only an observed living replacement projects present");
				assertEquals(alive, AgentControlActions.supports(control, "start"), "living body restores Start eligibility");
				assertEquals(alive && control.agentId().equals(active.agentId().toString()),
						AgentControlActions.supports(control, "resume"), "Resume also requires the retained goal");
				assertions += 3;
			}
		}
		// Detached negative control: removing the attachment also loses the location, so it is not the fix.
		registry.detachEntity(active.agentId(), 107L);
		var detached = AgentControlSync.controlSnapshot(true, true, "Automation ready", 108L,
				List.of(registry.require(active.agentId())), groups, catalog, ignored -> Optional.empty()).agents().getFirst();
		assertTrue(!detached.entityPresent(), "detached absent body remains unavailable");
		assertTrue(!AgentControlActions.supports(detached, "start"), "detached negative control disables Start");
		assertTrue(!AgentControlActions.supports(detached, "resume"), "detached negative control disables Resume");
		assertEquals(Optional.empty(), registry.require(active.agentId()).entityLocation(), "detachment loses durable recovery coordinates");
		assertions += 4;
		return assertions;
	}

	private static FixturePlayer fixturePlayer() {
		try {
			Class<?> type = Class.forName("sun.misc.Unsafe");
			var field = type.getDeclaredField("theUnsafe");
			field.setAccessible(true);
			return (FixturePlayer) type.getMethod("allocateInstance", Class.class).invoke(field.get(null), FixturePlayer.class);
		} catch (ReflectiveOperationException exception) {
			throw new AssertionError("Could not allocate headless presence fixture", exception);
		}
	}

	private static final class FixturePlayer extends ServerPlayer {
		private boolean alive;
		private FixturePlayer() { super(null, null, null, null); }
		@Override public boolean isAlive() { return alive; }
	}

	private static void assertTrue(boolean value, String label) {
		if (!value) throw new AssertionError(label);
	}

	private static void assertEquals(int expected, int actual, String label) {
		if (expected != actual) {
			throw new AssertionError(label + ": expected <" + expected + "> but was <" + actual + ">");
		}
	}

	private static void assertEquals(Object expected, Object actual, String label) {
		if (!expected.equals(actual)) {
			throw new AssertionError(label + ": expected <" + expected + "> but was <" + actual + ">");
		}
	}
}
