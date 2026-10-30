package dev.agaminggod.arenaagents.server;

import dev.agaminggod.arenaagents.agent.AgentRecord;
import dev.agaminggod.arenaagents.server.runtime.ServerActionRequest;
import dev.agaminggod.arenaagents.server.runtime.ServerActionResult;
import dev.agaminggod.arenaagents.agent.goal.GoalEvidence;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.server.MinecraftServer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class AgentChatReporter {
	public static final Set<String> NOTICE_SEVERITIES = Set.of("error", "warning", "info");
	public static final int MAX_NOTICE_LENGTH = 2_048;
	private static final Logger LOGGER = LoggerFactory.getLogger(AgentChatReporter.class);
	private static final java.util.Map<MinecraftServer, AgentFeedPolicy> FEEDS = java.util.Collections.synchronizedMap(new java.util.WeakHashMap<>());

	private static AgentFeedPolicy feed(CodexAgentManager manager) { return feed(manager.server()); }

	private static AgentFeedPolicy feed(MinecraftServer server) {
		if (!server.isSameThread()) throw new IllegalStateException("Feed state requires the server thread");
		return FEEDS.computeIfAbsent(server, ignored -> new AgentFeedPolicy());
	}

	private static boolean defer(MinecraftServer server, Runnable task) {
		if (server == null) return true;
		if (server.isSameThread()) return false;
		server.execute(task);
		return true;
	}

	static void release(MinecraftServer server) {
		if (defer(server, () -> release(server))) return;
		FEEDS.remove(server);
	}

	/** Feed sends pass through the same packet hook, so exclude them from vanilla overlay protection. */
	public static void observeOverlay(net.minecraft.server.level.ServerPlayer player, net.minecraft.network.protocol.Packet<?> packet) {
		boolean overlay = packet instanceof net.minecraft.network.protocol.game.ClientboundSetActionBarTextPacket
				|| packet instanceof net.minecraft.network.protocol.game.ClientboundSystemChatPacket chat && chat.overlay();
		if (!overlay || player instanceof carpet.patches.EntityPlayerMPFake) return;
		MinecraftServer server = player.level().getServer();
		if (defer(server, () -> observeOverlay(player, packet))) return;
		AgentFeedPolicy feed = feed(server);
		if (!feed.sendingOverlay) feed.externalOverlay(player.getUUID().toString(), System.currentTimeMillis());
	}

	/** A single shared action bar keeps simultaneous agents from overwriting each other. */
	static void tick(CodexAgentManager manager) {
		MinecraftServer server = manager.server();
		if (defer(server, () -> tick(manager))) return;
		if (server.getTickCount() % 10 != 0) return;
		AgentFeedPolicy feed = feed(manager);
		long now = System.currentTimeMillis();
		java.util.Set<String> ids = new java.util.HashSet<>();
		java.util.Set<java.util.UUID> agentPlayers = new java.util.HashSet<>();
		java.util.List<Component> statuses = new java.util.ArrayList<>();
		for (AgentRecord record : manager.records().stream().sorted(java.util.Comparator.comparing(record -> record.agentId().toString())).toList()) {
			String id = record.agentId().toString();
			ids.add(id);
			record.entityUuid().ifPresent(agentPlayers::add);
			manager.findAgentPlayer(record.agentId()).ifPresent(player -> {
				for (String warning : feed.danger(id, player.getHealth(), player.getFoodData().getFoodLevel(), player.isAlive())) {
					report(manager, record, warning, ChatFormatting.RED);
				}
				if (server.getTickCount() % 20 == 0) {
					java.util.Set<String> inventory = new java.util.HashSet<>();
					for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
						var stack = player.getInventory().getItem(slot);
						if (!stack.isEmpty()) inventory.add(net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
					}
					for (String item : feed.items(id, inventory)) {
						report(manager, record, "Obtained " + item.substring(item.indexOf(':') + 1).replace('_', ' ') + ".", ChatFormatting.GREEN);
					}
					String dimension = feed.dimension(id, player.level().dimension().identifier().toString());
					if (dimension != null) {
						String place = switch (dimension) {
							case "minecraft:the_nether" -> "the Nether";
							case "minecraft:the_end" -> "the End";
							case "minecraft:overworld" -> "the Overworld";
							default -> dimension.substring(dimension.indexOf(':') + 1).replace('_', ' ');
						};
						report(manager, record, "Entered " + place + ".", ChatFormatting.LIGHT_PURPLE);
					}
				}
				String status = feed.status(id, now);
				if (manager.automaticProgress(record.agentId()) && record.state().isActive() && player.isAlive() && !status.isBlank()) {
					statuses.add(noticeLine(manager.displayName(record), record.profile().provider(), "info", status));
				}
			});
		}
		feed.retain(ids);
		java.util.Set<String> viewers = new java.util.HashSet<>();
		for (var viewer : server.getPlayerList().getPlayers()) viewers.add(viewer.getUUID().toString());
		feed.retainViewers(viewers);
		if (statuses.isEmpty()) return;
		MutableComponent line = Component.empty();
		for (int index : AgentFeedPolicy.statusIndices(statuses.size(), now)) {
			if (!line.getString().isEmpty()) line.append(Component.literal("  |  ").withStyle(ChatFormatting.DARK_GRAY));
			line.append(statuses.get(index));
		}
		for (var viewer : server.getPlayerList().getPlayers()) {
			boolean agentBody = agentPlayers.contains(viewer.getUUID()) || viewer instanceof carpet.patches.EntityPlayerMPFake;
			boolean operatorOrOwner = GoalControl.mayControl(viewer.createCommandSourceStack())
					|| server.isSingleplayerOwner(new net.minecraft.server.players.NameAndId(viewer.getGameProfile()));
			if (feed.overlay(viewer.getUUID().toString(), operatorOrOwner, agentBody, line.getString(), now)) {
				feed.sendingOverlay = true;
				try { viewer.sendSystemMessage(line, true); }
				finally { feed.sendingOverlay = false; }
			}
		}
	}

	private AgentChatReporter() {
	}

	/**
	 * Operator-facing notice that must always reach chat: it bypasses automatic-progress,
	 * verbose and reason-code filtering because it tells players why an agent cannot think
	 * at all (provider CLI missing, broken or signed out). Unknown agents are logged only.
	 */
	public static void notice(CodexAgentManager manager, AgentRecord record, String severity, String code, String message) {
		Objects.requireNonNull(manager, "manager must not be null");
		if (manager.server() != null && defer(manager.server(), () -> notice(manager, record, severity, code, message))) return;
		String level = NOTICE_SEVERITIES.contains(severity) ? severity : "info";
		String body = readableNotice(message);
		if (record == null) {
			log(level, "[agent notice] " + code + ": " + body);
			return;
		}
		String displayName = manager.displayName(record);
		log(level, "[" + displayName + "] " + code + ": " + body);
		MinecraftServer server = manager.server();
		if (server == null) return;
		try {
			server.getPlayerList().broadcastSystemMessage(
					noticeLine(displayName, record.profile().provider(), level, body), false);
		} catch (RuntimeException exception) {
			LOGGER.warn("Could not broadcast agent notice {} for {}", code, record.agentId(), exception);
		}
	}

	public static Component noticeLine(String displayName, String provider, String severity, String message) {
		MutableComponent prefix = Component.literal("[" + displayName + "]").withStyle(familyColor(provider));
		MutableComponent body = Component.literal(" " + message).withStyle(noticeColor(severity));
		return prefix.append(body);
	}

	public static ChatFormatting noticeColor(String severity) {
		return switch (severity) {
			case "error" -> ChatFormatting.RED;
			case "warning" -> ChatFormatting.YELLOW;
			default -> ChatFormatting.GRAY;
		};
	}

	private static void log(String severity, String text) {
		if ("info".equals(severity)) LOGGER.info(text);
		else LOGGER.warn(text);
	}

	private static String readableNotice(String message) {
		if (message == null || message.isBlank()) return "No details.";
		String compact = message.replace('\n', ' ').replace('\r', ' ').trim();
		return compact.length() <= MAX_NOTICE_LENGTH ? compact : compact.substring(0, MAX_NOTICE_LENGTH - 3) + "...";
	}

	public static void planning(CodexAgentManager manager, AgentRecord record) {
		// Public agent summaries describe intent. Generic planner state stays in the field console.
	}

	public static void stillPlanning(CodexAgentManager manager, AgentRecord record) {
		// Periodic planner heartbeats do not belong in player chat.
	}

	public static void acting(CodexAgentManager manager, AgentRecord record, ServerActionRequest request) {
		if (defer(manager.server(), () -> acting(manager, record, request))) return;
		// Speech can run alongside a body action and must not replace its status.
		if (request.type() != dev.agaminggod.arenaagents.protocol.ActionType.CHAT) {
			feed(manager).acting(record.agentId().toString(), request.actionId(), AgentActivityPresentation.status(request.type(), request.arguments()), System.currentTimeMillis());
		}
		AgentVerboseState verbose = verboseState(manager);
		if (verbose != null && verbose.beginAction(request)) {
			AgentVerboseChat.report(
					manager, verbose, record, "action", AgentActivityPresentation.actionStart(request.type()));
		}
	}

	public static void decision(CodexAgentManager manager, AgentRecord record, String summary) {
		if (defer(manager.server(), () -> decision(manager, record, summary))) return;
		if (summary == null || summary.isBlank() || summary.equals("Plan accepted.")) return;
		if (manager.records().stream().noneMatch(current -> current.agentId().equals(record.agentId()) && current.goalRevision() == record.goalRevision())) return;
		String safe = AgentVerboseChat.sanitizeMessage(record, summary);
		if (safe.endsWith("redacted.") || safe.equals("Technical details hidden.") || safe.equals("No details.")) return;
		AgentVerboseState verbose = verboseState(manager);
		if (!manager.automaticProgress(record.agentId()) && (verbose == null || !verbose.enabled())) return;
		if (!feed(manager).decision(record.agentId().toString(), record.goalRevision(), safe)) return;
		if (verbose != null && verbose.enabled()) AgentVerboseChat.report(manager, verbose, record, "decision", safe);
		else report(manager, record, safe, ChatFormatting.WHITE);
	}

	public static void result(CodexAgentManager manager, AgentRecord record, ServerActionResult result) {
		if (defer(manager.server(), () -> result(manager, record, result))) return;
		AgentFeedPolicy feed = feed(manager);
		feed.result(record.agentId().toString(), result.actionId(), result.state() == dev.agaminggod.arenaagents.server.runtime.ServerActionState.SUCCEEDED, System.currentTimeMillis());
		AgentVerboseState verbose = verboseState(manager);
		if (verbose != null && !verbose.standardActivityEnabled()) return;
		AgentActivityPresentation.result(result)
				.filter(message -> feed.problem(record.agentId().toString(), result.reasonCode(), message, System.currentTimeMillis()))
				.ifPresent(message -> report(manager, record, message, ChatFormatting.RED));
	}

	public static void completed(CodexAgentManager manager, AgentRecord record, String summary) {
		if (defer(manager.server(), () -> completed(manager, record, summary))) return;
		AgentVerboseState verbose = verboseState(manager);
		if (verbose != null && !verbose.standardActivityEnabled()) return;
		report(manager, record, summary == null || summary.isBlank() ? "Task complete" : summary, ChatFormatting.GREEN);
	}

	public static void goalVerified(CodexAgentManager manager, AgentRecord record, java.util.List<GoalEvidence.Fact> facts) {
		if (defer(manager.server(), () -> goalVerified(manager, record, facts))) return;
		AgentVerboseState verbose = verboseState(manager);
		if (verbose != null && !verbose.standardActivityEnabled()) return;
		GoalEvidence.Fact fact = firstFact(facts, true);
		String detail = fact == null ? "server-observed requirements satisfied" : fact.expectedValue();
		report(manager, record, "Goal verified: " + detail + ".", ChatFormatting.GREEN);
	}

	public static void goalNotComplete(CodexAgentManager manager, AgentRecord record, java.util.List<GoalEvidence.Fact> facts) {
		if (defer(manager.server(), () -> goalNotComplete(manager, record, facts))) return;
		AgentVerboseState verbose = verboseState(manager);
		if (verbose != null && !verbose.standardActivityEnabled()) return;
		report(manager, record, AgentActivityPresentation.goalNotComplete(facts), ChatFormatting.YELLOW);
	}

	private static GoalEvidence.Fact firstFact(java.util.List<GoalEvidence.Fact> facts, boolean fallbackToFirst) {
		if (facts == null || facts.isEmpty()) return null;
		return facts.stream().filter(fact -> !fact.satisfied()).findFirst()
				.orElse(fallbackToFirst ? facts.getFirst() : null);
	}

	public static void failed(CodexAgentManager manager, AgentRecord record, String error) {
		failed(manager, record, null, error);
	}

	public static void failed(CodexAgentManager manager, AgentRecord record, String reasonCode, String error) {
		if (defer(manager.server(), () -> failed(manager, record, reasonCode, error))) return;
		String safe = AgentVerboseChat.sanitizeMessage(record, error == null ? "" : error);
		String message = failureMessage(reasonCode, safe);
		if (AgentFeedPolicy.severe(reasonCode)) {
			notice(manager, record, "error", reasonCode, message);
			return;
		}
		AgentVerboseState verbose = verboseState(manager);
		if (verbose != null && !verbose.standardActivityEnabled()) {
			AgentVerboseChat.report(manager, verbose, record, "error", message);
			return;
		}
		AgentFeedPolicy.problem("continue", reasonCode, "")
				.filter(ignored -> feed(manager).problem(record.agentId().toString(), message, System.currentTimeMillis()))
				.ifPresent(ignored -> report(manager, record, message, ChatFormatting.RED));
	}

	static String failureMessage(String reasonCode, String safeError) {
		if (safeError != null && !safeError.isBlank() && !safeError.endsWith("redacted.")
				&& !safeError.equals("Technical details hidden.") && !safeError.equals("No details.")) {
			String shortReason = safeError.replaceAll("\\s+", " ").strip();
			if (shortReason.length() > 160) shortReason = shortReason.substring(0, 157) + "...";
			return "Can't continue: " + shortReason;
		}
		return "Can't continue: " + AgentFeedPolicy.plainReason(AgentFeedPolicy.normalize(reasonCode)) + ".";
	}

	public static void disconnected(CodexAgentManager manager, AgentRecord record) {
		if (defer(manager.server(), () -> disconnected(manager, record))) return;
		notice(manager, record, "error", "DISCONNECTED", "Connection lost. Reconnect the coordinator, then resume or restart this task.");
	}

	public static void respawnDisconnected(CodexAgentManager manager, AgentRecord record) {
		if (defer(manager.server(), () -> respawnDisconnected(manager, record))) return;
		AgentVerboseState verbose = verboseState(manager);
		if (verbose == null || verbose.standardActivityEnabled()) return;
		AgentVerboseChat.report(manager, verbose, record, "error", AgentActivityPresentation.respawnDisconnected());
	}

	private static AgentVerboseState verboseState(CodexAgentManager manager) {
		var server = manager.server();
		return server == null ? null : AgentVerboseState.forServer(server);
	}

	private static void report(
			CodexAgentManager manager,
			AgentRecord record,
			String message,
			ChatFormatting messageColor
	) {
		if (!manager.automaticProgress(record.agentId())) return;
		MutableComponent prefix = Component.literal("[" + manager.displayName(record) + "]")
				.withStyle(familyColor(record.profile().provider()));
		MutableComponent body = Component.literal(" " + (message == null || message.isBlank() ? "No details." : message))
				.withStyle(messageColor);
		manager.server().getPlayerList().broadcastSystemMessage(prefix.append(body), false);
	}

	private static ChatFormatting familyColor(String provider) {
		return switch (provider.toLowerCase(Locale.ROOT)) {
			case "codex" -> ChatFormatting.AQUA;
			case "gemini", "antigravity" -> ChatFormatting.LIGHT_PURPLE;
			case "claude" -> ChatFormatting.GOLD;
			default -> ChatFormatting.WHITE;
		};
	}

}
