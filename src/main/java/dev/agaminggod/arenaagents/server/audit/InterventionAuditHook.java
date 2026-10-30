package dev.agaminggod.arenaagents.server.audit;

import com.mojang.brigadier.ParseResults;
import com.mojang.brigadier.context.CommandContextBuilder;
import com.mojang.brigadier.context.ParsedCommandNode;
import com.mojang.brigadier.tree.LiteralCommandNode;
import dev.agaminggod.arenaagents.agent.AgentLifecycleState;
import dev.agaminggod.arenaagents.agent.AgentRecord;
import dev.agaminggod.arenaagents.agent.goal.GoalStatus;
import dev.agaminggod.arenaagents.server.CodexAgentManager;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.WeakHashMap;
import net.minecraft.commands.CommandSourceStack;
import java.util.stream.Stream;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.storage.LevelResource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Server side of the audit. It only observes: no command, function or takeover behaves differently. */
public final class InterventionAuditHook {
	private static final Logger LOGGER = LoggerFactory.getLogger(InterventionAuditHook.class);
	private static final Map<MinecraftServer, AgentInterventionAudit> AUDITS = new WeakHashMap<>();

	private InterventionAuditHook() {
	}

	/**
	 * Fabric SERVER_STARTING. Freshness comes from the world directory observed at mod initialization, before Minecraft's
	 * Main opened it: it must have held no saved state, be the directory this server uses, and since then gained only
	 * what Main writes for a new world (the session lock and the first level.dat). Anything else, or no observation,
	 * is not fresh.
	 */
	public static synchronized void serverStarting(MinecraftServer server) {
		AgentInterventionAudit.World world;
		try {
			Path root = server.getWorldPath(LevelResource.ROOT).toAbsolutePath().normalize();
			List<String> files = List.of();
			if (Files.isDirectory(root)) {
				try (Stream<Path> walk = Files.walk(root)) {
					files = walk.filter(Files::isRegularFile).map(path -> root.relativize(path).toString().replace('\\', '/')).toList();
				}
			}
			world = StartupWorldProvenance.decide(StartupWorldProvenance.observed(), root, files, server.getWorldData().overworldData().isInitialized());
		} catch (IOException | RuntimeException exception) {
			LOGGER.warn("Intervention audit could not inspect the world directory", exception);
			world = AgentInterventionAudit.World.UNKNOWN;
		}
		AUDITS.put(server, new AgentInterventionAudit(System.currentTimeMillis(), world));
	}

	/** Fabric SERVER_STARTED: mods, selected data packs and overworld generation must be the certified baseline. */
	public static void serverStarted(MinecraftServer server) {
		guard(server, "check the content baseline", () -> {
			java.util.Map<String, java.util.Optional<String>> mods = new java.util.HashMap<>();
			for (var mod : net.fabricmc.loader.api.FabricLoader.getInstance().getAllMods()) {
				mods.put(mod.getMetadata().getId(), mod.getContainingMod().map(parent -> parent.getMetadata().getId()));
			}
			List<String> gaps = new ArrayList<>(ContentBaseline.modGaps(mods));
			gaps.addAll(ContentBaseline.packGaps(server.getPackRepository().getSelectedIds(), ContentBaseline.allowedMods(mods)));
			var generator = server.overworld().getChunkSource().getGenerator();
			gaps.addAll(ContentBaseline.generatorGaps(
					generator instanceof net.minecraft.world.level.levelgen.NoiseBasedChunkGenerator noise && noise.generatorSettings().is(net.minecraft.world.level.levelgen.NoiseGeneratorSettings.OVERWORLD),
					generator.getBiomeSource() instanceof net.minecraft.world.level.biome.MultiNoiseBiomeSource));
			audit(server).baseline(gaps);
		});
	}

	public static synchronized AgentInterventionAudit audit(MinecraftServer server) {
		return AUDITS.computeIfAbsent(server, ignored -> new AgentInterventionAudit(System.currentTimeMillis(), AgentInterventionAudit.World.UNKNOWN));
	}

	public static void beforeCommand(ParseResults<CommandSourceStack> parse, String command) {
		CommandSourceStack source = parse.getContext().getSource();
		guard(source.getServer(), "classify a command", () -> {
			MinecraftServer server = source.getServer();
			AgentInterventionAudit audit = audit(server);
			observe(server);
			List<String> path = nodePath(parse, command);
			boolean allowed = audit.permits(InterventionAllowlist.classify(path), path);
			if (!allowed) audit.intervention(new AgentInterventionAudit.Intervention(System.currentTimeMillis(), source.getTextName(), command));
		});
	}

	public static void afterCommand(CommandSourceStack source) {
		guard(source.getServer(), "observe agent goals", () -> observe(source.getServer()));
	}

	/** Tick, load, scheduled and reward functions; their lines bypass performCommand. */
	public static void functionExecuted(MinecraftServer server, String functionId) {
		intervention(server, "function", "function " + functionId);
	}

	/** Scenario builds, resets and cancellations edit terrain and stock containers through Java APIs. */
	public static void scenarioEdit(net.minecraft.server.level.ServerPlayer operator, String operation) {
		MinecraftServer server = operator.level().getServer();
		if (server == null) return;
		String name;
		try { name = operator.getScoreboardName(); } catch (RuntimeException unnamed) { name = String.valueOf(operator.getUUID()); }
		intervention(server, name, "scenario " + operation);
	}

	public static void commandBlock(MinecraftServer server, String command) {
		intervention(server, "command block", command);
	}

	public static void directorCommand(MinecraftServer server, String player, String command) {
		intervention(server, player, "director " + command);
	}

	/** Every operator takeover entry, whichever command or identifier selected the agent. */
	public static void takeover(MinecraftServer server, String operator, String agent) {
		intervention(server, operator, "takeover " + agent);
	}

	/** Fabric JOIN: every connection for the server lifetime, so a visit between audit samples still counts. */
	public static void playerJoined(MinecraftServer server, net.minecraft.server.level.ServerPlayer player) {
		guard(server, "record a player join", () -> checkPlayer(server, CodexAgentManager.get(server).records(), player));
	}

	/**
	 * Only a managed agent body (Carpet's fake-player class with the agent's own offline UUID and name) is not
	 * outside help; a real connection with the same name or UUID is.
	 */
	private static void checkPlayer(MinecraftServer server, List<AgentRecord> records, net.minecraft.server.level.ServerPlayer player) {
		for (AgentRecord record : records) {
			if (dev.agaminggod.arenaagents.server.OfflineAgentPlayers.isManagedFakePlayer(player, record.agentId(), record.profile())) return;
		}
		String name;
		try { name = player.getScoreboardName(); } catch (RuntimeException unnamed) { name = String.valueOf(player.getUUID()); }
		audit(server).otherPlayer(name + " " + player.getUUID());
	}

	public static String report(MinecraftServer server, AgentRecord record, String agentName) {
		observe(server);
		return AgentInterventionAudit.format(agentName, audit(server).report(record.agentId().value()));
	}

	private static void intervention(MinecraftServer server, String source, String command) {
		guard(server, "record an intervention", () -> {
			observe(server);
			audit(server).intervention(new AgentInterventionAudit.Intervention(System.currentTimeMillis(), source, command));
		});
	}

	private static void observe(MinecraftServer server) {
		AgentInterventionAudit audit = audit(server);
		List<AgentRecord> records = CodexAgentManager.get(server).records();
		for (var player : server.getPlayerList().getPlayers()) checkPlayer(server, records, player);
		for (AgentRecord record : records) {
			var goal = record.currentGoal().orElse(null);
			boolean ended = goal != null && (goal.status() == GoalStatus.SATISFIED || goal.status() == GoalStatus.CANCELLED)
					|| record.state() == AgentLifecycleState.COMPLETED || record.state() == AgentLifecycleState.ERROR;
			audit.observeAgent(record.agentId().value(), record.createdAtEpochMs(), record.goalRevision(), goal == null ? null : goal.goalId(), ended,
					goal != null && !goal.steeringInstructions().isEmpty());
		}
	}

	/**
	 * One token per parsed node across the context chain: a literal as its text, an argument as {@code <name:raw>}.
	 * Null when the input does not parse to an executable command, which then runs nothing.
	 */
	public static List<String> nodePath(ParseResults<CommandSourceStack> parse, String input) {
		if (parse.getReader().canRead() || !parse.getExceptions().isEmpty()) return null;
		String text = parse.getReader().getString();
		List<String> tokens = new ArrayList<>();
		CommandContextBuilder<CommandSourceStack> context = parse.getContext(), last = context;
		while (context != null) {
			for (ParsedCommandNode<CommandSourceStack> node : context.getNodes()) {
				tokens.add(node.getNode() instanceof LiteralCommandNode<?> literal ? literal.getLiteral()
						: "<" + node.getNode().getName() + ":" + node.getRange().get(text) + ">");
			}
			last = context;
			context = context.getChild();
		}
		return last.getCommand() == null ? null : tokens;
	}

	/** An audit failure must never read as a clean run: it counts as an intervention. */
	private static void guard(MinecraftServer server, String operation, Runnable body) {
		try { body.run(); }
		catch (RuntimeException exception) {
			LOGGER.warn("Intervention audit could not {}", operation, exception);
			try { audit(server).intervention(new AgentInterventionAudit.Intervention(System.currentTimeMillis(), "audit", "audit error: " + operation)); }
			catch (RuntimeException ignored) { /* nothing else can record it */ }
		}
	}
}
