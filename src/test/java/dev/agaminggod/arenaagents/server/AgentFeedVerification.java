package dev.agaminggod.arenaagents.server;

import java.util.Set;

public final class AgentFeedVerification {
	public static int verify() {
		AgentFeedPolicy feed = new AgentFeedPolicy();
		check(feed.decision("sol", 1, "Heading south for exposed iron"), "first authored decision");
		check(!feed.decision("sol", 1, "Heading south  for exposed iron"), "unchanged intent is quiet");
		check(feed.decision("sol", 1, "Returning for food"), "changed intent is visible");
		check(feed.decision("opus", 1, "Returning for food"), "agents deduplicate independently");
		check(feed.decision("sol", 2, "Returning for food"), "new task may repeat intent");
		for (int i = 0; i < 16; i++) {
			feed.acting("sol", "mine-" + i, "Mining a block", i * 1000L);
			feed.result("sol", "mine-" + i, true, i * 1000L);
			feed.result("sol", "mine-" + i, true, i * 1000L);
		}
		check(feed.status("sol", 16_000).equals("Mining a block ×16"), "one status counts successful actions once");
		feed.acting("opus", "move", "Moving to the next position", 16_000);
		check(feed.status("sol", 16_000).endsWith("×16") && !feed.status("opus", 16_000).isEmpty(), "simultaneous agents keep independent status");
		check(feed.status("sol", 20_000).isEmpty(), "completed activity expires");
		check(!feed.status("opus", 45_999).isEmpty(), "running activity lasts up to thirty seconds");
		check(feed.status("opus", 46_000).isEmpty(), "missing result cannot leave permanent status");
		feed.acting("opus", "move", "Moving to the next position", 50_000);
		check(feed.status("opus", 50_000).isEmpty(), "duplicate acting cannot extend stale status");
		feed.acting("opus", "move-again", "Moving to the next position", 50_000);
		check(!feed.status("opus", 50_000).isEmpty(), "new action restores expired status");
		feed.acting("sol", "place", "Placing a block", 21_000);
		feed.result("sol", "old-result", true, 21_000);
		feed.result("sol", "place", false, 21_000);
		check(feed.status("sol", 21_000).equals("Placing a block"), "failed and stale results never inflate counts");
		check(feed.problem("sol", "Blocked by leaves", 0), "genuine first problem shown");
		check(!feed.problem("sol", "Blocked by gravel", 1000), "alternating errors share a limit");
		check(feed.problem("opus", "Blocked by leaves", 1000), "another agent has its own limit");
		check(feed.problem("sol", "Blocked by gravel", 30_000), "new window admits a problem");
		check(AgentFeedPolicy.problem("ITEM_PICKUP_TIMED_OUT", "Collected 1 item but target not reached").isPresent(), "partial collection cannot hide a real failure");
		check(AgentFeedPolicy.problem("craft an item", "FURNACE_UNAVAILABLE", "raw technical evidence").orElseThrow()
				.equals("Couldn't craft an item: furnace unavailable."), "unmapped announceable failure has a plain fallback");
		check(AgentFeedPolicy.problem("", "raw technical evidence").orElseThrow().equals("Couldn't complete this action: the action failed."), "missing reason also remains visible");
		check(AgentFeedPolicy.problem("NO_PROGRESS", "Selected frontier no closer; walked 7, left 2.5").isEmpty(), "route diagnostics stay out of chat");
		check(AgentFeedPolicy.problem("NO_PROGRESS", "Seen path ends; Seen obstruction: minecraft:oak_leaves at 1,2,3; other routes unverified").orElseThrow().equals("Can't reach the target: blocked by oak leaves."), "observed obstruction is plain language");
		check(feed.items("sol", Set.of()).isEmpty(), "inventory baseline is quiet");
		check(feed.items("sol", Set.of("minecraft:raw_iron")).equals(java.util.List.of("minecraft:raw_iron")), "first iron is notable");
		feed.items("sol", Set.of());
		check(feed.items("sol", Set.of("minecraft:raw_iron")).isEmpty(), "reacquisition is quiet");
		check(feed.items("opus", Set.of("minecraft:diamond")).isEmpty(), "existing inventory on connection is not a new find");
		check(feed.dimension("sol", "minecraft:overworld") == null, "dimension baseline is quiet");
		check(feed.dimension("sol", "minecraft:the_nether").equals("minecraft:the_nether"), "dimension change is notable");
		check(feed.dimension("sol", "minecraft:the_nether") == null, "dimension doesn't repeat");
		feed.retain(Set.of("opus"));
		check(feed.status("sol", 22_000).isEmpty(), "removed agents release status");
		check(feed.problem("sol", "DISCONNECTED", "Connection lost", 30_001), "disconnect bypasses previous problem");
		check(feed.problem("sol", "PROVIDER_FAILED", "Provider unavailable", 30_002), "provider failure bypasses previous problem");
		check(feed.problem("sol", "AGENT_DEAD", "Died", 30_003), "death bypasses previous problem");
		check(feed.problem("sol", "CRITICAL_FAILURE", "Critical failure", 30_004), "critical failure bypasses previous problem");
		check(!feed.problem("sol", "Another ordinary error", 30_005), "severe events do not consume or reset ordinary throttle");
		check(feed.danger("opus", 20, 20, true).isEmpty(), "healthy baseline is quiet");
		check(feed.danger("opus", 6, 6, true).size() == 2, "health and hunger crossings both warn");
		check(feed.danger("opus", 2, 1, true).isEmpty(), "persistent danger warns once per episode");
		check(feed.danger("opus", 20, 20, true).isEmpty(), "recovery resets danger episodes quietly");
		check(feed.danger("opus", 4, 20, true).equals(java.util.List.of("Health is dangerously low.")), "new danger episode warns again");
		check(feed.danger("opus", 0, 0, false).isEmpty(), "death keeps vanilla announcement without danger duplicates");
		check(AgentFeedPolicy.problem("AGENT_DEAD", "Seen obstruction: minecraft:stone").isEmpty(), "death never turns into a path problem");
		check(feed.overlay("owner", true, false, "Mining", 0), "singleplayer owner gets status with owner eligibility");
		check(!feed.overlay("visitor", false, false, "Mining", 0), "visitors do not receive agent overlays");
		check(!feed.overlay("body", true, true, "Mining", 0), "agent bodies never receive feed overlays");
		check(!feed.overlay("op", true, false, "", 0), "empty overlay never clears vanilla messages");
		check(feed.overlay("op", true, false, "Mining", 0), "operator gets changed status");
		check(!feed.overlay("op", true, false, "Mining", 1_000), "unchanged status is not sent each second");
		check(feed.overlay("op", true, false, "Mining ×2", 1_500), "changed status sends immediately");
		check(!feed.overlay("op", true, false, "Mining ×2", 3_999), "refresh waits two and a half seconds");
		check(feed.overlay("op", true, false, "Mining ×2", 4_000), "active status gets slow refresh");
		feed.externalOverlay("op", 4_100);
		check(!feed.overlay("op", true, false, "Crafting", 4_500), "vanilla overlay has priority over changed status");
		check(!feed.overlay("op", true, false, "Crafting", 7_099), "vanilla overlay protected for three seconds");
		check(feed.overlay("op", true, false, "Crafting", 7_100), "feed resumes after vanilla overlay expires");
		for (int size = 3; size <= 8; size++) {
			Set<Integer> shown = new java.util.HashSet<>();
			for (int frame = 0; frame < size; frame++) shown.addAll(AgentFeedPolicy.statusIndices(size, frame * 2_500L));
			check(shown.size() == size, "rotation reaches every agent in roster of " + size);
		}
		check(AgentChatReporter.failureMessage("PROVIDER_FAILED", "Sign in to Claude again.").equals("Can't continue: Sign in to Claude again."), "fatal error retains short reason");
		check(AgentChatReporter.failureMessage("PROVIDER_FAILED", "Sensitive details redacted.").equals("Can't continue: provider failed."), "fatal reason survives privacy redaction");
		return 62 + verifyServerThreadHop() + verifyReplay();
	}

	/** Uses the reporter entry points and Minecraft's real task queue, with no live world or network. */
	@SuppressWarnings("unchecked")
	private static int verifyServerThreadHop() {
		try {
			var field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
			field.setAccessible(true);
			var unsafe = (sun.misc.Unsafe) field.get(null);
			var server = (net.minecraft.server.dedicated.DedicatedServer) unsafe.allocateInstance(net.minecraft.server.dedicated.DedicatedServer.class);
			var queue = new java.util.concurrent.ConcurrentLinkedQueue<Runnable>();
			put(unsafe, server, net.minecraft.server.MinecraftServer.class, "serverThread", Thread.currentThread());
			put(unsafe, server, net.minecraft.util.thread.BlockableEventLoop.class, "pendingRunnables", queue);
			var players = (FeedPlayers) unsafe.allocateInstance(FeedPlayers.class);
			players.lines = new java.util.ArrayList<>();
			put(unsafe, server, net.minecraft.server.MinecraftServer.class, "playerList", players);
			var manager = (CodexAgentManager) unsafe.allocateInstance(CodexAgentManager.class);
			put(unsafe, manager, CodexAgentManager.class, "server", server);
			put(unsafe, manager, CodexAgentManager.class, "savedData", new AgentSavedData());
			var record = manager.registry().create("gpt-6.1-sol", "high", java.util.Optional.of("FeedTest"), 1_000L);
			var request = new dev.agaminggod.arenaagents.server.runtime.ServerActionRequest(record.agentId(), 0, "mine",
					dev.agaminggod.arenaagents.protocol.ActionType.BREAK_BLOCK, new com.google.gson.JsonObject(),
					new dev.agaminggod.arenaagents.server.runtime.ActionProvenance("codex", "gpt-6.1-sol", "high", "priority", "feed", 1, "mine", 0));
			var result = new dev.agaminggod.arenaagents.server.runtime.ServerActionResult(record.agentId(), 0, "mine",
					request.type(), dev.agaminggod.arenaagents.server.runtime.ServerActionState.FAILED, "PATH_BLOCKED", "technical evidence", 1, 1);
			var errors = new java.util.concurrent.atomic.AtomicReference<Throwable>();
			var workers = new java.util.ArrayList<Thread>();
			for (int index = 0; index < 8; index++) {
				Thread worker = new Thread(() -> {
					try { AgentChatReporter.decision(manager, record, "Heading south for exposed iron."); }
					catch (Throwable error) { errors.set(error); }
				});
				workers.add(worker);
				worker.start();
			}
			for (Thread worker : workers) worker.join();
			Thread executorWorker = new Thread(() -> {
				try {
					AgentChatReporter.acting(manager, record, request);
					AgentChatReporter.result(manager, record, result);
					AgentChatReporter.failed(manager, record, "PROVIDER_FAILED", "Sign in to Claude again.");
					AgentChatReporter.disconnected(manager, record);
				} catch (Throwable error) { errors.set(error); }
			});
			executorWorker.start();
			executorWorker.join();
			check(errors.get() == null, "bridge/executor callers queue without touching unsafe state: " + errors.get());
			check(players.lines.isEmpty() && queue.size() == 12, "all off-thread reports defer before mutation or delivery");
			for (Runnable task; (task = queue.poll()) != null;) task.run();
			check(players.lines.size() == 4, "queued decisions deduplicate; action problem, provider failure and disconnect all arrive");
			check(players.lines.stream().anyMatch(line -> line.contains("Sign in to Claude again.")), "provider reason reaches chat despite recent action problem");
			check(players.lines.stream().anyMatch(line -> line.contains("Connection lost.")), "disconnect bypasses the same throttle");
			var feeds = AgentChatReporter.class.getDeclaredField("FEEDS");
			feeds.setAccessible(true);
			var feed = ((java.util.Map<net.minecraft.server.MinecraftServer, AgentFeedPolicy>) feeds.get(null)).get(server);
			check(feed.status(record.agentId().toString(), System.currentTimeMillis()).equals("Mining a block"), "executor status mutated on server queue");
			var viewer = (net.minecraft.server.level.ServerPlayer) unsafe.allocateInstance(net.minecraft.server.level.ServerPlayer.class);
			viewer.setId(1002); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			var level = (net.minecraft.server.level.ServerLevel) unsafe.allocateInstance(net.minecraft.server.level.ServerLevel.class);
			put(unsafe, level, net.minecraft.server.level.ServerLevel.class, "server", server);
			put(unsafe, viewer, net.minecraft.world.entity.Entity.class, "level", level);
			java.util.UUID uuid = java.util.UUID.randomUUID();
			put(unsafe, viewer, net.minecraft.world.entity.Entity.class, "uuid", uuid);
			AgentChatReporter.observeOverlay(viewer, new net.minecraft.network.protocol.game.ClientboundSetActionBarTextPacket(net.minecraft.network.chat.Component.literal("You may not rest now")));
			check(!feed.overlay(uuid.toString(), true, false, "Mining", System.currentTimeMillis()), "real vanilla packet hook suppresses feed delivery");
			feed.retainViewers(Set.of());
			feed.sendingOverlay = true;
			AgentChatReporter.observeOverlay(viewer, new net.minecraft.network.protocol.game.ClientboundSystemChatPacket(net.minecraft.network.chat.Component.literal("Mining"), true));
			feed.sendingOverlay = false;
			check(feed.overlay(uuid.toString(), true, false, "Mining ×2", System.currentTimeMillis()), "feed's own packet cannot suppress the next feed change");
			Thread staleDecision = new Thread(() -> AgentChatReporter.decision(manager, record, "Old goal intent."));
			staleDecision.start();
			staleDecision.join();
			manager.registry().start(record.agentId(), "New goal", 2_000L);
			queue.remove().run();
			check(players.lines.size() == 4, "queued intent from an obsolete goal revision is discarded");
			AgentChatReporter.release(server);
			AgentVerboseState.release(server);
			return 9;
		} catch (ReflectiveOperationException | InterruptedException exception) {
			throw new AssertionError("could not exercise reporter server-thread dispatch", exception);
		}
	}

	private static int verifyReplay() {
		java.io.PrintStream original = System.out;
		java.nio.file.Path fixture = null;
		try {
			java.nio.file.Files.createDirectories(java.nio.file.Path.of("build/feel-feed"));
			fixture = java.nio.file.Files.createTempFile(java.nio.file.Path.of("build/feel-feed"), "routing-", ".log");
			java.nio.file.Files.writeString(fixture, """
					[13:40:00] [main/INFO]: [CHAT] [GPT-6.1 Sol] Mining a block
					[13:40:01] [main/INFO]: [CHAT] [GPT-6.1 Sol] Placing a block needs attention: unknown historical failure
					[13:40:02] [main/INFO]: [CHAT] [GPT-6.1 Sol] Picking up an item needs attention: Collected 1 minecraft:raw_iron
					[13:40:03] [main/INFO]: [CHAT] [GPT-6.1 Sol] Using a door needs attention: another unknown historical failure
					[13:40:31] [main/INFO]: [CHAT] [GPT-6.1 Sol] Crafting an item needs attention: still missing ingredients
					[13:40:32] [main/INFO]: [CHAT] [GPT-6.1 Sol] Connection lost.
					[13:40:33] [main/INFO]: [CHAT] [GPT-6.1 Sol] Connection lost.
					[13:41:00] [main/INFO]: [CHAT] GPT-6.1 Sol was slain by Zombie
					""");
			var output = new java.io.ByteArrayOutputStream();
			System.setOut(new java.io.PrintStream(output));
			AgentFeedReplay.main(new String[] { fixture.toString() });
			String replay = output.toString(java.nio.charset.StandardCharsets.UTF_8);
			check(replay.contains("8 -> 6 messages; 8.00 -> 6.00 lines/min; 2 problems from 3 failure candidates, 1 recovered first items."), "replay counts unknown failures conservatively, then applies real throttle");
			check(replay.substring(replay.indexOf("AFTER:")).contains("was slain by Zombie"), "replay retains vanilla deaths");
			return 2;
		} catch (Exception exception) {
			throw new AssertionError("could not replay recorded feed fixture", exception);
		} finally {
			System.setOut(original);
			if (fixture != null) {
				try { java.nio.file.Files.deleteIfExists(fixture); }
				catch (java.io.IOException exception) { throw new AssertionError(exception); }
			}
		}
	}

	private static void put(sun.misc.Unsafe unsafe, Object target, Class<?> owner, String name, Object value) throws ReflectiveOperationException {
		unsafe.putObject(target, unsafe.objectFieldOffset(owner.getDeclaredField(name)), value);
	}

	private static final class FeedPlayers extends net.minecraft.server.dedicated.DedicatedPlayerList {
		java.util.List<String> lines;
		private FeedPlayers() { super(null, null, null); }
		@Override public void broadcastSystemMessage(net.minecraft.network.chat.Component message, boolean overlay) {
			lines.add(message.getString());
		}
	}

	private static void check(boolean value, String message) {
		if (!value) throw new AssertionError(message);
	}
}
