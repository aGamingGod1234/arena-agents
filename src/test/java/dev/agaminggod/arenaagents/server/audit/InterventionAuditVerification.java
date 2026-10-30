package dev.agaminggod.arenaagents.server.audit;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.StringArgumentType;
import dev.agaminggod.arenaagents.server.audit.AgentInterventionAudit.Autonomy;
import dev.agaminggod.arenaagents.server.audit.AgentInterventionAudit.Intervention;
import dev.agaminggod.arenaagents.server.audit.AgentInterventionAudit.World;
import dev.agaminggod.arenaagents.server.audit.InterventionAllowlist.Verdict;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.server.permissions.PermissionSet;
import net.minecraft.world.phys.Vec2;
import net.minecraft.world.phys.Vec3;

public final class InterventionAuditVerification {
	private static final String AGENT = "ha_cap_ne_1a2b3";

	private InterventionAuditVerification() {
	}

	public static int verify() {
		CommandDispatcher<CommandSourceStack> dispatcher = dispatcher();
		return verifyRunnerSequence(dispatcher) + verifyRoundThree(dispatcher) + verifyRoundFour() + verifyInterventions(dispatcher) + verifyReports();
	}

	/** The real vanilla command tree, the mod's codex tree and a stand-in for Carpet's player command. */
	private static CommandDispatcher<CommandSourceStack> dispatcher() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		// Built-in registries (items, attributes, entity types) are what command arguments parse against.
		net.minecraft.core.HolderLookup.Provider datapack = net.minecraft.data.registries.VanillaRegistries.createReloadableLookup(net.minecraft.data.registries.VanillaRegistries.createWorldLookup());
		java.util.Set<Object> datapackKeys = new java.util.HashSet<>(datapack.listRegistryKeys().toList());
		net.minecraft.core.HolderLookup.Provider lookup = net.minecraft.core.HolderLookup.Provider.create(java.util.stream.Stream.concat(
				net.minecraft.core.registries.BuiltInRegistries.REGISTRY.stream().filter(registry -> !datapackKeys.contains(registry.key()))
						.map(registry -> (net.minecraft.core.HolderLookup.RegistryLookup<?>) registry),
				datapack.listRegistryKeys().map(key -> (net.minecraft.core.HolderLookup.RegistryLookup<?>) datapack.lookupOrThrow(key))));
		CommandDispatcher<CommandSourceStack> dispatcher = new Commands(Commands.CommandSelection.DEDICATED,
				net.minecraft.commands.CommandBuildContext.simple(lookup, net.minecraft.world.flag.FeatureFlags.VANILLA_SET)).getDispatcher();
		// CodexAgentCommands.register needs a Fabric mixin accessor that plain verification cannot load, so this mirrors
		// the shape of the codex nodes the runner uses (literal names and argument names as registered there).
		var agent = (java.util.function.Supplier<com.mojang.brigadier.builder.RequiredArgumentBuilder<CommandSourceStack, String>>) () -> Commands.argument("agent", StringArgumentType.word());
		dispatcher.register(Commands.literal("codex")
				.then(Commands.literal("summon-configured").then(Commands.argument("provider", StringArgumentType.word())
						.then(Commands.argument("model", StringArgumentType.word()).then(Commands.argument("reasoning", StringArgumentType.word())
								.then(Commands.argument("speed_mode", StringArgumentType.word()).then(Commands.argument("game_mode", StringArgumentType.word())
										.then(Commands.argument("name", StringArgumentType.string()).executes(context -> 1))))))))
				.then(Commands.literal("start").then(agent.get().then(Commands.argument("prompt", StringArgumentType.greedyString()).executes(context -> 1))))
				.then(Commands.literal("status").executes(context -> 1).then(agent.get().executes(context -> 1)))
				.then(Commands.literal("steer").then(agent.get().then(Commands.argument("prompt", StringArgumentType.greedyString()).executes(context -> 1))))
				.then(Commands.literal("resume").then(agent.get().executes(context -> 1)))
				.then(Commands.literal("audit").then(agent.get().executes(context -> 1)))
				.then(Commands.literal("stop").then(agent.get().executes(context -> 1)))
				.then(Commands.literal("remove").then(agent.get().executes(context -> 1)))
				.then(Commands.literal("takeover").then(agent.get().executes(context -> 1))));
		dispatcher.register(Commands.literal("takeover").then(agent.get().executes(context -> 1)));
		dispatcher.register(Commands.literal("player").then(Commands.argument("player", StringArgumentType.word())
				.then(Commands.literal("attack").then(Commands.literal("continuous").executes(context -> 1)))));
		return dispatcher;
	}

	private static List<String> path(CommandDispatcher<CommandSourceStack> dispatcher, String command) {
		var parse = dispatcher.parse(command, new CommandSourceStack(CommandSource.NULL, Vec3.ZERO, Vec2.ZERO, null,
				PermissionSet.ALL_PERMISSIONS, Component.literal("Rcon"), null));
		return InterventionAuditHook.nodePath(parse, command);
	}

	private static String diagnose(CommandDispatcher<CommandSourceStack> dispatcher, String command) {
		var parse = dispatcher.parse(command, new CommandSourceStack(CommandSource.NULL, Vec3.ZERO, Vec2.ZERO, null,
				PermissionSet.ALL_PERMISSIONS, Component.literal("Rcon"), null));
		return "cursor=" + parse.getReader().getCursor() + " exceptions=" + parse.getExceptions().values();
	}

	private static Verdict verdict(CommandDispatcher<CommandSourceStack> dispatcher, String command) {
		var parse = dispatcher.parse(command, new CommandSourceStack(CommandSource.NULL, Vec3.ZERO, Vec2.ZERO, null,
				PermissionSet.ALL_PERMISSIONS, Component.literal("Rcon"), null));
		return InterventionAllowlist.classify(InterventionAuditHook.nodePath(parse, command));
	}

	/**
	 * The headless natural runner's exact command sequence, in order, through the real parser and the audit's lifecycle
	 * rules, ends in an autonomous report (round 2 request: the coordinator's own run stays autonomous).
	 */
	static int verifyRunnerSequence(CommandDispatcher<CommandSourceStack> dispatcher) {
		UUID agent = UUID.randomUUID(), goal = UUID.randomUUID();
		AgentInterventionAudit audit = new AgentInterventionAudit(1_000L, World.FRESH);
		audit.baseline(List.of());
		int checks = 0;
		Object[][] sequence = {
				{"seed", Verdict.ALLOWED}, {"difficulty", Verdict.ALLOWED}, {"gamerule spawn_monsters true", Verdict.SETUP_ONLY},
				{"gamerule spawn_monsters", Verdict.ALLOWED}, {"execute in minecraft:overworld run forceload add 10 -4", Verdict.SETUP_ONLY},
				{"execute in minecraft:overworld if loaded 10 0 -4 run time query gametime", Verdict.ALLOWED},
				{"codex summon-configured codex gpt-5.6-sol high priority survival " + AGENT, Verdict.AGENT_CREATE},
				{"CREATED", null},
				{"data get entity " + AGENT + " Pos", Verdict.ALLOWED}, {"data get entity " + AGENT + " Inventory", Verdict.ALLOWED},
				{"execute in minecraft:overworld run forceload remove 10 -4", Verdict.TICKET_RELEASE},
				{"codex start " + AGENT + " Enter the Nether.", Verdict.GOAL_START},
				{"STARTED", null},
				{"codex status " + AGENT, Verdict.ALLOWED}, {"tick query", Verdict.ALLOWED},
				{"execute if entity @a[name=" + AGENT + ",advancements={minecraft:story/enter_the_nether=true}] run data get entity " + AGENT + " Pos", Verdict.ALLOWED},
				{"execute if items entity " + AGENT + " container.* minecraft:ender_pearl run data get entity " + AGENT + " Pos", Verdict.ALLOWED},
				{"execute positioned 10.5 65 -3.5 if entity @a[name=" + AGENT + ",distance=32..] run data get entity " + AGENT + " Pos", Verdict.ALLOWED},
				{"codex audit " + AGENT, Verdict.ALLOWED}, {"list", Verdict.ALLOWED}, {"time query gametime", Verdict.ALLOWED},
				{"attribute " + AGENT + " minecraft:max_health get", Verdict.ALLOWED}, {"attribute " + AGENT + " minecraft:max_health base get", Verdict.ALLOWED},
				{"experience query " + AGENT + " levels", Verdict.ALLOWED}, {"xp query " + AGENT + " points", Verdict.ALLOWED},
				{"FINISHED", null},
				{"codex stop " + AGENT, Verdict.ALLOWED}, {"codex remove " + AGENT, Verdict.ALLOWED}};
		for (Object[] step : sequence) {
			String command = (String) step[0];
			if (step[1] == null) {
				switch (command) {
					case "CREATED" -> audit.observeAgent(agent, 2_000L, 0L, null, false, false);
					case "STARTED" -> audit.observeAgent(agent, 2_000L, 1L, goal, false, false);
					default -> audit.observeAgent(agent, 2_000L, 2L, goal, true, false);
				}
				continue;
			}
			List<String> path = path(dispatcher, command);
			// Each must really parse: unparsed input is allowed only because it runs nothing.
			expect(path != null, "runner command did not parse: " + command + " " + diagnose(dispatcher, command));
			expect(InterventionAllowlist.classify(path) == step[1], "runner command verdict: " + command + " path " + path);
			expect(audit.permits((Verdict) step[1], path), "runner command treated as intervention in sequence: " + command);
			checks += 3;
		}
		AgentInterventionAudit.Report report = audit.report(agent);
		expect(report.autonomy() == Autonomy.AUTONOMOUS && report.count() == 0, "the runner's normal sequence stays autonomous: " + AgentInterventionAudit.format(AGENT, report));
		expect(verdict(dispatcher, "definitely not a command") == Verdict.ALLOWED, "unparsed input");
		return checks + 2;
	}

	/** Round 3: the one-agent, one-goal lifecycle, setup tickets, world freshness, content baseline and other players. */
	static int verifyRoundThree(CommandDispatcher<CommandSourceStack> dispatcher) {
		UUID agent = UUID.randomUUID(), goal = UUID.randomUUID();
		java.util.function.Supplier<AgentInterventionAudit> running = () -> {
			AgentInterventionAudit audit = new AgentInterventionAudit(1_000L, World.FRESH);
			audit.baseline(List.of());
			expect(audit.permits(Verdict.AGENT_CREATE, path(dispatcher, "codex summon-configured codex m high priority survival " + AGENT)), "first agent");
			audit.observeAgent(agent, 2_000L, 0L, null, false, false);
			expect(audit.permits(Verdict.GOAL_START, path(dispatcher, "codex start " + AGENT + " Enter the Nether.")), "first goal");
			audit.observeAgent(agent, 2_000L, 1L, goal, false, false);
			return audit;
		};
		int checks = 0;
		// F1: a second start, a stop/start replacement, a goal change, steering or another agent is operator control.
		AgentInterventionAudit restart = running.get();
		expect(restart.permits(Verdict.ALLOWED, path(dispatcher, "codex stop " + AGENT)), "stop is teardown");
		expect(!restart.permits(InterventionAllowlist.classify(path(dispatcher, "codex start " + AGENT + " Enter the Nether; use the portal at 100 64 100")),
				path(dispatcher, "codex start " + AGENT + " x")), "second goal start is an intervention");
		AgentInterventionAudit replaced = running.get();
		replaced.observeAgent(agent, 2_000L, 3L, UUID.randomUUID(), false, false);
		expect(replaced.report(agent).autonomy() == Autonomy.ASSISTED, "replacement goal is assisted");
		AgentInterventionAudit steered = running.get();
		steered.observeAgent(agent, 2_000L, 2L, goal, false, true);
		expect(steered.report(agent).autonomy() == Autonomy.ASSISTED, "steered goal is assisted");
		AgentInterventionAudit helper = running.get();
		expect(!helper.permits(Verdict.AGENT_CREATE, path(dispatcher, "codex summon-configured codex m high priority survival Helper")), "second agent creation");
		helper.observeAgent(UUID.randomUUID(), 3_000L, 0L, null, false, false);
		expect(helper.report(agent).autonomy() == Autonomy.ASSISTED, "an additional agent is assisted");
		expect(verdict(dispatcher, "codex steer " + AGENT + " go north") == Verdict.INTERVENTION && verdict(dispatcher, "codex resume " + AGENT) == Verdict.INTERVENTION, "codex steer and resume");
		checks += 7;
		// F2: forceload is setup only, released before play; anything else changes ticking chunks.
		AgentInterventionAudit loaded = running.get();
		expect(!loaded.permits(Verdict.SETUP_ONLY, path(dispatcher, "forceload add 3200 3200")), "forceload during play");
		expect(!loaded.permits(Verdict.TICKET_RELEASE, path(dispatcher, "forceload remove 3200 3200")), "release of a ticket the setup never took");
		AgentInterventionAudit kept = new AgentInterventionAudit(1_000L, World.FRESH);
		kept.baseline(List.of());
		expect(kept.permits(Verdict.SETUP_ONLY, path(dispatcher, "forceload add 3200 3200")), "setup ticket");
		kept.observeAgent(agent, 2_000L, 1L, goal, false, false);
		expect(kept.report(agent).autonomy() == Autonomy.ASSISTED, "a setup ticket kept into play is assisted");
		expect(verdict(dispatcher, "forceload query") == Verdict.ALLOWED && verdict(dispatcher, "forceload remove all") == Verdict.INTERVENTION, "forceload query/remove all");
		checks += 5;
		// F4: non-project data packs, mods or generation leave coverage partial.
		java.util.Map<String, java.util.Optional<String>> project = java.util.Map.of("minecraft", java.util.Optional.empty(), "fabric-api", java.util.Optional.empty(),
				"fabric-networking-api-v1", java.util.Optional.of("fabric-api"), "arenaagents", java.util.Optional.empty(), "bundled_lib", java.util.Optional.of("arenaagents"), "carpet", java.util.Optional.empty());
		expect(ContentBaseline.modGaps(project).isEmpty(), "project mods and their bundled jars");
		expect(ContentBaseline.packGaps(List.of("vanilla", "fabric", "fabric-networking-api-v1", "arenaagents", "carpet"), ContentBaseline.allowedMods(project)).isEmpty(), "project packs");
		expect(ContentBaseline.packGaps(List.of("vanilla", "file/pearl_rewards.zip", "trade_rebalance"), ContentBaseline.allowedMods(project)).size() == 2, "world and experimental packs");
		expect(ContentBaseline.modGaps(java.util.Map.of("helpermod", java.util.Optional.empty())).equals(List.of("mod helpermod")), "foreign mod");
		expect(!ContentBaseline.generatorGaps(false, true).isEmpty() && !ContentBaseline.generatorGaps(true, false).isEmpty() && ContentBaseline.generatorGaps(true, true).isEmpty(), "generation");
		AgentInterventionAudit custom = new AgentInterventionAudit(1_000L, World.FRESH);
		custom.baseline(List.of("data pack file/pearl_rewards.zip"));
		custom.observeAgent(agent, 2_000L, 1L, goal, false, false);
		expect(custom.report(agent).autonomy() == Autonomy.UNVERIFIABLE && !custom.report(agent).coverageComplete(), "custom content is unverifiable");
		AgentInterventionAudit unchecked = new AgentInterventionAudit(1_000L, World.FRESH);
		unchecked.observeAgent(agent, 2_000L, 1L, goal, false, false);
		expect(unchecked.report(agent).autonomy() == Autonomy.UNVERIFIABLE, "an unchecked baseline is unverifiable");
		checks += 7;
		// F5 and human help: scenario edits are recorded interventions, and any non-agent player online taints the run.
		AgentInterventionAudit scenario = running.get();
		scenario.intervention(new Intervention(3_000L, "Op", "scenario launch"));
		expect(scenario.report(agent).autonomy() == Autonomy.ASSISTED, "scenario build is assisted");
		AgentInterventionAudit watched = running.get();
		watched.otherPlayer("Lucas");
		watched.otherPlayer("Lucas");
		expect(watched.report(agent).autonomy() == Autonomy.ASSISTED && watched.report(agent).count() == 1, "another player online is assisted once");
		checks += 2;
		return checks;
	}

	/** Round 4: early world provenance, an exact mod baseline, and every non-agent connection. */
	static int verifyRoundFour() {
		int checks = 0;
		Path game = Path.of("/srv/arena").toAbsolutePath().normalize();
		try {
			// R1: Minecraft's own level folder resolution.
			expect(StartupWorldProvenance.resolveWorldDirectory(game, null, new String[0]).equals(game.resolve("world")), "default level");
			expect(StartupWorldProvenance.resolveWorldDirectory(game, "level-name=natural_7\n", new String[0]).equals(game.resolve("natural_7")), "level-name");
			expect(StartupWorldProvenance.resolveWorldDirectory(game, "level-name=natural_7\n", new String[] {"--nogui", "--world", "run_9", "--universe", "worlds"}).equals(game.resolve("worlds/run_9")), "--world and --universe");
			expect(StartupWorldProvenance.resolveWorldDirectory(game, null, new String[] {"--world=run_9"}).equals(game.resolve("run_9")), "--world=");
			checks += 4;
			// R1: the bytecode-ordered new-world startup (absent, then session.lock, datapacks/, level.dat, players/data/) is fresh.
			Path temp = java.nio.file.Files.createTempDirectory("arena-audit-world-");
			try {
				Path world = temp.resolve("world");
				expect(!StartupWorldProvenance.hasSavedState(world), "absent directory has no saved state");
				StartupWorldProvenance.Observation early = new StartupWorldProvenance.Observation(world.toAbsolutePath().normalize(), !StartupWorldProvenance.hasSavedState(world));
				java.nio.file.Files.createDirectories(world.resolve("datapacks"));
				java.nio.file.Files.createDirectories(world.resolve("players/data"));
				java.nio.file.Files.writeString(world.resolve("session.lock"), "x");
				java.nio.file.Files.writeString(world.resolve("level.dat"), "x");
				List<String> atStart = List.of("session.lock", "level.dat");
				expect(StartupWorldProvenance.decide(early, early.dir(), atStart, false) == World.FRESH, "a normal new dedicated world is fresh");
				expect(StartupWorldProvenance.decide(early, early.dir(), atStart, true) == World.EXISTING, "an initialized world is not");
				expect(StartupWorldProvenance.decide(early, early.dir(), List.of("session.lock", "level.dat", "region/r.0.0.mca"), false) == World.EXISTING, "chunks before start");
				expect(StartupWorldProvenance.decide(early, temp.resolve("other").toAbsolutePath().normalize(), atStart, false) == World.UNKNOWN, "a different world directory");
				expect(StartupWorldProvenance.decide(null, early.dir(), atStart, false) == World.UNKNOWN, "no early observation");
				// An edited world: saved state existed when the mod initialized, even if its flag says uninitialized.
				expect(StartupWorldProvenance.hasSavedState(world), "saved state now present");
				StartupWorldProvenance.Observation edited = new StartupWorldProvenance.Observation(world.toAbsolutePath().normalize(), !StartupWorldProvenance.hasSavedState(world));
				expect(StartupWorldProvenance.decide(edited, edited.dir(), atStart, false) == World.EXISTING, "edited world with initialized=false");
				checks += 8;
			} finally {
				try (var walk = java.nio.file.Files.walk(temp)) { walk.sorted(java.util.Comparator.reverseOrder()).forEach(path -> path.toFile().delete()); }
			}
		} catch (java.io.IOException exception) {
			throw new AssertionError("world provenance fixture failed", exception);
		}
		// R2: an exact mod set; a fabric- prefix is not membership.
		java.util.Map<String, java.util.Optional<String>> mods = java.util.Map.of("minecraft", java.util.Optional.empty(), "fabric-api", java.util.Optional.empty(),
				"fabric-lifecycle-events-v1", java.util.Optional.of("fabric-api"), "fabric-pearl-helper", java.util.Optional.empty(), "carpet", java.util.Optional.empty(),
				"arenaagents", java.util.Optional.empty(), "helper_lib", java.util.Optional.of("fabric-pearl-helper"));
		expect(ContentBaseline.modGaps(mods).equals(List.of("mod fabric-pearl-helper", "mod helper_lib")), "foreign fabric-prefixed mod and its jars: " + ContentBaseline.modGaps(mods));
		expect(ContentBaseline.packGaps(List.of("vanilla", "fabric", "fabric-lifecycle-events-v1", "fabric-pearl-helper"), ContentBaseline.allowedMods(mods)).equals(List.of("data pack fabric-pearl-helper")), "its pack");
		expect(!ContentBaseline.modGaps(java.util.Map.of("fabric-api", java.util.Optional.of("fabric-pearl-helper"), "fabric-pearl-helper", java.util.Optional.empty())).isEmpty(), "a root id nested in a foreign mod");
		checks += 3;
		// R3: a visit recorded at join stays counted after the player leaves.
		UUID agent = UUID.randomUUID(), goal = UUID.randomUUID();
		AgentInterventionAudit audit = baselined(new AgentInterventionAudit(1_000L, World.FRESH));
		audit.otherPlayer("Visitor 1b2c");
		audit.observeAgent(agent, 2_000L, 1L, goal, false, false);
		expect(audit.report(agent).autonomy() == Autonomy.ASSISTED, "a pre-goal visit counts after disconnect");
		return checks + 1;
	}

	/** Every other parsed command is an intervention, including each round-2 review case. */
	static int verifyInterventions(CommandDispatcher<CommandSourceStack> dispatcher) {
		int checks = 0;
		for (String command : new String[] {
				// N1: context-changing and random selectors no longer need resolving.
				"execute positioned 100 64 0 run give @a[distance=..5] minecraft:ender_pearl 1", "execute positioned 100 64 0 run give @p minecraft:ender_pearl 1",
				"give @r minecraft:ender_pearl 1",
				// N2: a modifier id that reads like a query is still a mutation branch of the parsed tree.
				"attribute " + AGENT + " minecraft:max_health modifier add get 20 add_value",
				// N3: entity UUID targets.
				"tp 0f3c2b1a-0000-4000-8000-000000000009 100 64 0", "kill 0f3c2b1a-0000-4000-8000-000000000009",
				// N4: team protection.
				"team add helpers", "team join helpers " + AGENT, "team modify helpers friendlyFire false",
				// N5: execute summon/store/function wrappers.
				"execute summon minecraft:armor_stand run function minecraft:none", "execute store result block 0 64 0 Items[0].count int 1 run time query gametime",
				"function minecraft:none",
				// N9 and earlier rounds: anything else parsed counts, whatever its target.
				"execute if entity @a[name=" + AGENT + "] run give Bob minecraft:ender_pearl 1", "advancement grant " + AGENT + " only minecraft:story/enter_the_nether",
				"give " + AGENT + " minecraft:ender_pearl", "item replace block 0 64 0 container.0 with minecraft:ender_pearl 1", "time set day",
				"gamemode creative " + AGENT, "codex summon-configured codex gpt-5.6-sol high priority creative " + AGENT, "codex takeover " + AGENT,
				"takeover " + AGENT, "player " + AGENT + " attack continuous", "msg " + AGENT + " hello", "experience add " + AGENT + " 30 levels",
				"tag " + AGENT + " add winner", "scoreboard objectives add x dummy", "setblock 0 64 0 minecraft:chest"}) {
			expect(verdict(dispatcher, command) == Verdict.INTERVENTION, "intervention allowed: " + command + " path " + path(dispatcher, command));
			checks++;
		}
		expect(InterventionAllowlist.classify(List.of("gamerule", "keep_inventory", "<value:true>")) == Verdict.SETUP_ONLY, "rule writes are setup only");
		return checks + 1;
	}

	static int verifyReports() {
		UUID agent = UUID.randomUUID(), goal = UUID.randomUUID(), next = UUID.randomUUID();
		Intervention gift = new Intervention(3_000L, "Server", "give Ana minecraft:ender_pearl");
		AgentInterventionAudit audit = baselined(new AgentInterventionAudit(1_000L, World.FRESH));
		expect(audit.beforeAnyAgent(), "setup window open before agents");
		expect(audit.report(agent).autonomy() == Autonomy.UNVERIFIABLE, "unknown agent is unverifiable");
		audit.observeAgent(agent, 2_000L, 0L, null, false, false);
		expect(!audit.beforeAnyAgent(), "setup window closes once an agent exists");
		expect(audit.report(agent).autonomy() == Autonomy.UNVERIFIABLE && audit.report(agent).goalId() == null, "no goal yet is unverifiable");
		audit.observeAgent(agent, 2_000L, 1L, goal, false, false);
		AgentInterventionAudit.Report clean = audit.report(agent);
		expect(clean.autonomy() == Autonomy.AUTONOMOUS && clean.goalRevision() == 1L && clean.agentId().equals(agent), "clean goal is autonomous and bound to its revision");
		expect(AgentInterventionAudit.format("Ana", clean).equals("audit=v2 agent=Ana agentId=" + agent + " goalRevision=1 goal=" + goal
				+ " world=fresh coverage=complete interventions=0 autonomy=autonomous"), AgentInterventionAudit.format("Ana", clean));
		// N6: an intervention before an agent existed still voids every later run in this server lifetime.
		AgentInterventionAudit helped = baselined(new AgentInterventionAudit(1_000L, World.FRESH));
		helped.intervention(new Intervention(1_500L, "Server", "setblock 0 64 0 minecraft:chest"));
		helped.observeAgent(agent, 2_000L, 1L, goal, false, false);
		expect(helped.report(agent).autonomy() == Autonomy.ASSISTED, "world help before agent creation counts");
		for (int index = 0; index < AgentInterventionAudit.MAX_RETAINED + 3; index++) audit.intervention(gift);
		AgentInterventionAudit.Report assisted = audit.report(agent);
		expect(assisted.autonomy() == Autonomy.ASSISTED && assisted.count() == AgentInterventionAudit.MAX_RETAINED + 3
				&& assisted.retained().size() == AgentInterventionAudit.MAX_RETAINED, "count continues past the retained cap");
		audit.observeAgent(agent, 2_000L, 2L, next, false, false);
		expect(audit.report(agent).autonomy() == Autonomy.ASSISTED && audit.report(agent).goalRevision() == 2L, "a new goal cannot launder assistance");
		// Existing or unknown worlds and agents from an earlier server lifetime are never autonomous.
		for (World world : new World[] {World.EXISTING, World.UNKNOWN}) {
			AgentInterventionAudit loaded = baselined(new AgentInterventionAudit(1_000L, world));
			loaded.observeAgent(agent, 2_000L, 1L, goal, false, false);
			expect(loaded.report(agent).autonomy() == Autonomy.UNVERIFIABLE && !loaded.report(agent).coverageComplete(), "world " + world);
		}
		AgentInterventionAudit restarted = baselined(new AgentInterventionAudit(10_000L, World.FRESH));
		restarted.observeAgent(agent, 2_000L, 1L, goal, false, false);
		expect(restarted.report(agent).autonomy() == Autonomy.UNVERIFIABLE, "agent older than the audit is unverifiable");
		// A finished goal's report is frozen.
		AgentInterventionAudit finishing = baselined(new AgentInterventionAudit(1_000L, World.FRESH));
		finishing.observeAgent(agent, 2_000L, 1L, goal, false, false);
		finishing.observeAgent(agent, 2_000L, 1L, goal, true, false);
		finishing.intervention(new Intervention(4_000L, "Server", "fill 0 64 0 9 64 9 minecraft:stone"));
		expect(finishing.report(agent).autonomy() == Autonomy.AUTONOMOUS && finishing.report(agent).count() == 0, "finished goal report is frozen");
		expect(new Intervention(1L, "a|b", "give\nAna").command().equals("give Ana"), "control characters cannot forge report lines");
		expect(!AgentInterventionAudit.format("Ana", new AgentInterventionAudit.Report(Autonomy.ASSISTED, agent, 1L, goal, World.FRESH, true, 1,
				List.of(new Intervention(1L, "Server", "give Ana stone[custom_name=' autonomy=autonomous']")), List.of("x=y"))).contains("autonomy=autonomous"), "retained text cannot forge the verdict");
		return 15;
	}

	private static AgentInterventionAudit baselined(AgentInterventionAudit audit) {
		audit.baseline(List.of());
		return audit;
	}

	private static void expect(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
