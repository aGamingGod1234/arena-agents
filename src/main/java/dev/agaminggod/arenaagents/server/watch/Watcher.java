package dev.agaminggod.arenaagents.server.watch;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.agent.AgentId;
import dev.agaminggod.arenaagents.agent.AgentRecord;
import dev.agaminggod.arenaagents.protocol.ActionType;
import dev.agaminggod.arenaagents.server.CodexAgentManager;
import dev.agaminggod.arenaagents.server.bridge.BridgeTap;
import dev.agaminggod.arenaagents.server.perception.ObservationVisibility;
import dev.agaminggod.arenaagents.server.runtime.ServerActionExecutor;
import dev.agaminggod.arenaagents.server.runtime.ServerActionRequest;
import dev.agaminggod.arenaagents.server.runtime.reflex.ReflexEngine;
import dev.agaminggod.arenaagents.server.runtime.reflex.ReflexScheduler;
import dev.agaminggod.arenaagents.server.runtime.reflex.ReflexSpec;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.WeakHashMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import net.fabricmc.fabric.api.entity.event.v1.ServerLivingEntityEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.DamageTypeTags;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.damagesource.DamageTypes;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.boss.enderdragon.EnderDragon;
import net.minecraft.world.entity.monster.Ghast;
import net.minecraft.world.entity.projectile.Projectile;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The server-side Watcher: per agent, tracks real dangers every tick ({@link TruthScan}), records each dangerous
 * episode ({@link EpisodeTracker}) with what the agent's observation, reflexes, body and model knew, labels which part
 * of the system failed ({@link Diagnosis}), and forecasts hazards on body actions as they start ({@link Forecasts}).
 *
 * <p>It never acts and nothing it learns reaches the model: it only reads the world and the runtime, and writes
 * {@code arena-watch/<agentId>-episodes.jsonl}, {@code -forecasts.jsonl} and {@code -progress.jsonl} (progress truth for
 * the time audit, {@link ProgressWatch}) under the server's working directory.
 * Disable with {@code -Darenaagents.watch=false}.
 */
public final class Watcher {
	private static final Logger LOGGER = LoggerFactory.getLogger(Watcher.class);
	public static final String DIRECTORY = "arena-watch";
	static final int ENTITY_EVERY_TICKS = 2;
	static final int BLOCK_EVERY_TICKS = 5;
	static final int KNOWLEDGE_EVERY_TICKS = 5;
	static final long COST_REPORT_TICKS = 1_200L;
	static final long FORECAST_LINK_MS = 120_000L;
	static final int ROUTE_WAIT_TICKS = 40;
	/** Body actions whose movement the body (not the model) steers. */
	static final Set<ActionType> BODY_MOVES = Set.of(ActionType.MOVE_TO, ActionType.NAVIGATE_TO, ActionType.TRAVEL_TO, ActionType.FLEE_FROM,
			ActionType.FOLLOW_ENTITY, ActionType.FIGHT_TARGET, ActionType.FIGHT_UNTIL, ActionType.PICK_UP_ITEM);
	private static final Pattern UUID_TEXT = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");

	private static final Map<MinecraftServer, Watcher> WATCHERS = new WeakHashMap<>();
	private static boolean registered;

	/** What the coordinator was last given, per agent (written from the bridge's delivery path). */
	record Delivered(Set<String> uuids, Set<String> threats, boolean heardLava, boolean edgeFacts, long epochMs,
			Map<String, Long> heardTypes) {
	}

	/**
	 * Entity types a sound identifies without a uuid: one per fight, so a heard sound names the episode's source. The
	 * dragon is also left out of threat rows by design (ThreatPerception); its rows feed the coordinator's dragon facts.
	 */
	/** Terrain hazard kinds (not body states). */
	static final Set<String> TERRAIN = Set.of("lava", "lava_hidden", "fire", "drop", "void");
	static final Set<String> UNIQUE_HEARD_TYPES = Set.of("minecraft:ender_dragon", "minecraft:wither");
	/** A sound event this recent still tells the agent where the source is. */
	static final long HEARD_FRESH_MS = 5_000L;

	private static final Map<AgentId, Delivered> DELIVERED = new ConcurrentHashMap<>();
	/** Per agent, entity UUID to the first delivery of its current continuous presence in observations. */
	private static final Map<AgentId, Map<String, Long>> FIRST_SEEN = new ConcurrentHashMap<>();
	private static final Map<AgentId, Long> LAST_ATTENTION = new ConcurrentHashMap<>();
	private static final Map<AgentId, Long> LAST_MODEL = new ConcurrentHashMap<>();
	private static final Map<AgentId, String> LAST_PROGRAM = new ConcurrentHashMap<>();

	private final MinecraftServer server;
	private final Path directory;
	private final Map<AgentId, AgentWatch> agents = new LinkedHashMap<>();
	private final Map<UUID, AgentId> byPlayer = new HashMap<>();
	private final ProgressWatch progress = new ProgressWatch();
	private long costNanos;
	private long costMaxNanos;
	private long costTicks;
	private long costAgentTicks;

	private static final class AgentWatch {
		final AgentId id;
		final String idText;
		final EpisodeTracker tracker;
		final int phase;
		String lastActionId;
		ActionType pendingRoute;
		int routeWait;
		String dim;
		final ArrayDeque<WatchJson.Forecast> forecasts = new ArrayDeque<>();
		long forecastSequence;
		String firingKey;
		long eventSequence = -1L;

		AgentWatch(AgentId id, int phase) {
			this.id = id;
			this.idText = id.toString();
			this.tracker = new EpisodeTracker(idText);
			this.phase = phase;
		}
	}

	private Watcher(MinecraftServer server) {
		this.server = server;
		this.directory = server.getServerDirectory().resolve(DIRECTORY);
	}

	public static boolean enabled() {
		return !"false".equalsIgnoreCase(System.getProperty("arenaagents.watch", "true"));
	}

	public static synchronized void register() {
		if (registered || !enabled()) return;
		registered = true;
		ServerTickEvents.END_SERVER_TICK.register(server -> of(server).tick());
		ServerLivingEntityEvents.AFTER_DAMAGE.register((entity, source, baseDamage, damageTaken, blocked) -> {
			if (entity instanceof ServerPlayer player && damageTaken > 0.0F) {
				Watcher watcher = existing(player.level().getServer());
				if (watcher != null) watcher.damaged(player, source, damageTaken);
			}
		});
		ServerLivingEntityEvents.AFTER_DEATH.register((entity, source) -> {
			if (entity instanceof ServerPlayer player) {
				Watcher watcher = existing(player.level().getServer());
				if (watcher != null) watcher.died(player, source);
			}
		});
		ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
			Watcher watcher;
			synchronized (Watcher.class) {
				watcher = WATCHERS.remove(server);
			}
			if (watcher != null) watcher.stop();
		});
		BridgeTap.listen(new BridgeTap.Listener() {
			@Override
			public void observationDelivered(AgentId agentId, JsonObject delivery) {
				long epochMs = System.currentTimeMillis();
				delivered(agentId, delivery, epochMs);
				ProgressWatch.delivered(agentId, delivery, epochMs);
			}

			@Override
			public void actionResult(AgentId agentId, String actionType, String state, String reasonCode) {
				ProgressWatch.result(agentId, actionType, state, reasonCode);
			}

			@Override
			public void modelMessage(AgentId agentId, String type, String programId, long programVersion) {
				String program = programId == null ? type + "#" + programVersion : programId + "#" + programVersion;
				if (!program.equals(LAST_PROGRAM.put(agentId, program))) LAST_MODEL.put(agentId, System.currentTimeMillis());
			}
		});
	}

	private static synchronized Watcher of(MinecraftServer server) {
		return WATCHERS.computeIfAbsent(server, Watcher::new);
	}

	private static synchronized Watcher existing(MinecraftServer server) {
		return server == null ? null : WATCHERS.get(server);
	}

	// ---- What the coordinator was given (bridge thread) ----

	/** The last delivery's summary for this agent, or null. */
	static Delivered deliveredTo(AgentId agentId) {
		return DELIVERED.get(agentId);
	}

	static void delivered(AgentId agentId, JsonObject delivery, long epochMs) {
		Set<String> uuids = new HashSet<>();
		Set<String> threats = new HashSet<>();
		collect(delivery, false, uuids, threats);
		JsonElement heard = delivery.get("heard");
		boolean heardLava = heard != null && heard.toString().contains("lava");
		JsonElement body = delivery.get("player");
		boolean edgeFacts = body != null && body.isJsonObject() && (body.getAsJsonObject().has("footing") || body.getAsJsonObject().has("dropAhead"));
		DELIVERED.put(agentId, new Delivered(Set.copyOf(uuids), Set.copyOf(threats), heardLava, edgeFacts, epochMs, heardTypes(delivery)));
		Map<String, Long> first = FIRST_SEEN.computeIfAbsent(agentId, ignored -> new ConcurrentHashMap<>());
		first.keySet().retainAll(uuids);
		for (String uuid : uuids) first.putIfAbsent(uuid, epochMs);
		JsonElement attention = delivery.get("attention");
		if (attention != null && attention.isJsonPrimitive() && attention.getAsBoolean()) LAST_ATTENTION.put(agentId, epochMs);
	}

	/**
	 * Latest time per entity type named by a delivered sound ({@code minecraft:entity.<type>.<sound>}): sound packets in
	 * perception events, and the heard rows, which alone carry client-only sounds such as the dragon's wing flaps.
	 */
	static Map<String, Long> heardTypes(JsonObject delivery) {
		Map<String, Long> heard = new HashMap<>();
		JsonElement perception = delivery.get("perception");
		JsonElement events = perception != null && perception.isJsonObject() ? perception.getAsJsonObject().get("events") : null;
		if (events != null && events.isJsonArray()) {
			for (JsonElement item : events.getAsJsonArray()) {
				if (!item.isJsonObject()) continue;
				JsonObject event = item.getAsJsonObject();
				JsonElement sound = event.get("soundId");
				JsonElement at = event.get("observedAtEpochMs");
				if (sound == null || !sound.isJsonPrimitive() || at == null || !at.isJsonPrimitive() || !at.getAsJsonPrimitive().isNumber()) continue;
				String type = soundEntityType(sound.getAsString());
				if (type != null) heard.merge(type, at.getAsLong(), Math::max);
			}
		}
		JsonElement rows = delivery.get("heard");
		JsonElement observedAt = delivery.get("observedAtEpochMs");
		if (rows != null && rows.isJsonArray() && observedAt != null && observedAt.isJsonPrimitive() && observedAt.getAsJsonPrimitive().isNumber()) {
			for (JsonElement item : rows.getAsJsonArray()) {
				if (!item.isJsonObject()) continue;
				JsonElement sound = item.getAsJsonObject().get("sound");
				if (sound == null || !sound.isJsonPrimitive()) continue;
				String type = soundEntityType("minecraft:" + sound.getAsString());
				if (type == null) continue;
				JsonElement ago = item.getAsJsonObject().get("secondsAgo");
				// Rows omit secondsAgo under 5 s; the age is at most that.
				long agoMs = ago != null && ago.isJsonPrimitive() && ago.getAsJsonPrimitive().isNumber() ? ago.getAsLong() * 1000L : 0L;
				heard.merge(type, observedAt.getAsLong() - agoMs, Math::max);
			}
		}
		return Map.copyOf(heard);
	}

	private static String soundEntityType(String id) {
		if (!id.startsWith("minecraft:entity.")) return null;
		int end = id.indexOf('.', "minecraft:entity.".length());
		return end < 0 ? null : "minecraft:" + id.substring("minecraft:entity.".length(), end);
	}

	private static void collect(JsonElement element, boolean threat, Set<String> uuids, Set<String> threats) {
		if (element == null || element.isJsonNull()) return;
		if (element.isJsonObject()) {
			for (Map.Entry<String, JsonElement> entry : element.getAsJsonObject().entrySet()) {
				// Threat rows and incoming projectiles are the facts that say what a seen entity is about to do.
				collect(entry.getValue(), threat || entry.getKey().equals("threats") || entry.getKey().equals("incomingProjectiles"), uuids, threats);
			}
		} else if (element.isJsonArray()) {
			JsonArray array = element.getAsJsonArray();
			for (JsonElement item : array) {
				if (item.isJsonPrimitive() && !item.getAsJsonPrimitive().isString()) return;
				collect(item, threat, uuids, threats);
			}
		} else if (element.isJsonPrimitive() && element.getAsJsonPrimitive().isString()) {
			String text = element.getAsString();
			if (text.length() == 36 && UUID_TEXT.matcher(text).matches()) {
				uuids.add(text);
				if (threat) threats.add(text);
			}
		}
	}

	// ---- Tick ----

	private void tick() {
		long started = System.nanoTime();
		CodexAgentManager manager = CodexAgentManager.get(server);
		ServerActionExecutor executor = BridgeTap.executor(server);
		ReflexEngine reflexes = ReflexEngine.existing(server).orElse(null);
		long tick = server.getTickCount();
		long epochMs = System.currentTimeMillis();
		List<AgentRecord> records = manager.registry().records();
		Set<AgentId> present = new HashSet<>();
		int scanned = 0;
		for (AgentRecord record : records) {
			AgentId agentId = record.agentId();
			present.add(agentId);
			ServerPlayer player;
			try {
				player = manager.findAgentPlayer(agentId).orElse(null);
			} catch (RuntimeException missing) {
				continue;
			}
			AgentWatch watch = agents.computeIfAbsent(agentId, id -> new AgentWatch(id, agents.size()));
			if (player == null || !player.isAlive() || player.isSpectator()) continue;
			byPlayer.put(player.getUUID(), agentId);
			try {
				tickAgent(watch, player, executor, reflexes, tick, epochMs);
			} catch (RuntimeException failure) {
				LOGGER.warn("Watcher tick failed for {}", agentId, failure);
			}
			scanned++;
		}
		agents.keySet().removeIf(agentId -> {
			if (present.contains(agentId)) return false;
			AgentWatch gone = agents.get(agentId);
			write(gone, gone.tracker.closeAll(serverGameTime(), epochMs), reflexes);
			ProgressWatch.forget(agentId);
			return true;
		});
		long spent = System.nanoTime() - started;
		costNanos += spent;
		costMaxNanos = Math.max(costMaxNanos, spent);
		costTicks++;
		costAgentTicks += scanned;
		if (costTicks >= COST_REPORT_TICKS) {
			LOGGER.info(String.format(Locale.ROOT, "Watcher cost: %.1f us/tick mean, %.1f us max, %.1f agents/tick over %d ticks",
					costNanos / 1_000.0D / costTicks, costMaxNanos / 1_000.0D, costAgentTicks / (double) costTicks, costTicks));
			if (progress.costLines > 0L) {
				LOGGER.info(String.format(Locale.ROOT, "Watcher progress cost: %.1f us/line mean, %.1f us max, %d lines (%.1f us/tick amortised)",
						progress.costNanos / 1_000.0D / progress.costLines, progress.costMaxNanos / 1_000.0D, progress.costLines,
						progress.costNanos / 1_000.0D / costTicks));
			}
			progress.costNanos = 0L;
			progress.costMaxNanos = 0L;
			progress.costLines = 0L;
			costNanos = 0L;
			costMaxNanos = 0L;
			costTicks = 0L;
			costAgentTicks = 0L;
		}
	}

	private long serverGameTime() {
		return server.overworld() == null ? server.getTickCount() : server.overworld().getGameTime();
	}

	private void tickAgent(AgentWatch watch, ServerPlayer player, ServerActionExecutor executor, ReflexEngine reflexes, long tick, long epochMs) {
		ServerLevel level = player.level();
		long gameTime = level.getGameTime();
		String dim = level.dimension().identifier().toString();
		ServerActionRequest active = executor == null ? null : executor.activeRequest(watch.id);
		// A portal sets the vanilla portal cooldown on arrival; a command teleport does not.
		boolean portal = watch.dim != null && !watch.dim.equals(dim) && player.isOnPortalCooldown();
		watch.dim = dim;
		progress.noteDimension(watch.id, dim);
		if (ProgressWatch.due(tick, watch.phase)) append(watch.idText + "-progress.jsonl", WatchJson.line(progress.line(watch.id, player, executor, epochMs)));
		List<Danger> dangers = new ArrayList<>();
		if ((tick + watch.phase) % ENTITY_EVERY_TICKS == 0) TruthScan.entities(player, dangers);
		if ((tick + watch.phase) % BLOCK_EVERY_TICKS == 0) {
			BlockPos breaking = active != null && active.type() == ActionType.BREAK_BLOCK ? executor.activeTarget(watch.id) : null;
			TruthScan.blocks(player, breaking, dangers);
		}
		TruthScan.body(player, dangers);
		forecasts(watch, player, executor, active, portal, epochMs);
		List<Episode> closed = watch.tracker.observe(dangers, gameTime, epochMs, player.getHealth(), player.isOnFire() || player.isInLava());
		for (Episode episode : watch.tracker.takeOpened()) opened(watch, episode, player, reflexes, active, epochMs);
		if (watch.tracker.hasOpen()) {
			Map<String, Danger> byKey = new HashMap<>();
			for (Danger danger : dangers) byKey.putIfAbsent(danger.key(), danger);
			boolean knowledge = (tick + watch.phase) % KNOWLEDGE_EVERY_TICKS == 0;
			ReflexEngine.View view = reflexes == null ? null : reflexes.view(watch.id);
			for (Episode episode : watch.tracker.open()) {
				follow(watch, episode, player, byKey.get(episode.key), active, active == null || executor == null ? null : executor.activeTarget(watch.id),
						view, knowledge, epochMs);
			}
			if (view != null) firings(watch, view, epochMs);
		}
		write(watch, closed, reflexes);
	}

	/** Fills what the system knew when an episode opens. */
	private void opened(AgentWatch watch, Episode episode, ServerPlayer player, ReflexEngine reflexes, ServerActionRequest active, long epochMs) {
		episode.dim = player.level().dimension().identifier().toString();
		episode.x = player.getX();
		episode.y = player.getY();
		episode.z = player.getZ();
		setAction(episode, active);
		if (episode.entityId != null) {
			try {
				Entity source = player.level().getEntity(UUID.fromString(episode.entityId));
				if (source != null) episode.sourcePos = new double[] {source.getX(), source.getY(), source.getZ()};
			} catch (IllegalArgumentException invalid) {
				// Not an entity UUID.
			}
		}
		Long lastModel = LAST_MODEL.get(watch.id);
		episode.lastReplyAgoS = lastModel == null ? null : Math.max(0L, epochMs - lastModel) / 1_000.0D;
		if (reflexes != null) {
			Set<String> covering = Diagnosis.COVERAGE.getOrDefault(episode.kind, Set.of());
			ReflexEngine.View view = reflexes.view(watch.id);
			ReflexScheduler.Firing current = view.current();
			if (current != null) {
				// Already firing for this danger before the episode opened (an earlier source of the same kind).
				for (ReflexEngine.RuleView rule : view.rules()) {
					if (rule.id().equals(current.ruleId()) && rule.when().stream().anyMatch(covering::contains)) {
						episode.fired.add(new Episode.Firing(current.ruleId(), epochMs - Math.max(0L, view.nowTick() - current.startTick()) * 50L, "running"));
					}
				}
			}
			for (ReflexEngine.RuleView rule : view.rules()) {
				if (rule.state().equals("disabled") || rule.state().equals("yielded")) continue;
				for (String type : rule.when()) {
					if (covering.contains(type)) {
						episode.armed.add(rule.id() + ":" + type);
						break;
					}
				}
			}
		}
		for (WatchJson.Forecast forecast : watch.forecasts) {
			if (epochMs - forecast.atMs() > FORECAST_LINK_MS) continue;
			if (Forecasts.matches(forecast.kind(), forecast.block(), episode.kind, episode.block)) episode.forecastId = forecast.id();
		}
		knowledge(watch, episode, player, epochMs);
	}

	/** Per-tick follow-up of an open episode: the body's part, and (every few ticks) what was perceived and observed. */
	private void follow(AgentWatch watch, Episode episode, ServerPlayer player, Danger danger, ServerActionRequest active, BlockPos target,
			ReflexEngine.View view, boolean knowledge, long epochMs) {
		boolean harmed = episode.firstHarmEpochMs >= 0L;
		if (danger != null && !harmed && danger.etaS() <= episode.minEtaS + 1.0E-9D) {
			setAction(episode, active);
			// Judged afresh at each closest approach: a near miss minutes earlier does not blame the action at the harm.
			episode.causedByAction = false;
			boolean firing = view != null && view.current() != null;
			if (!firing && active != null && BODY_MOVES.contains(active.type()) && Diagnosis.ENVIRONMENT.contains(episode.kind)
					&& danger.block() != null && danger.etaS() < 0.5D && speedToward(player, danger.block()) > 1.0D
					// A destination at the hazard itself was the model's choice, not the body's path.
					&& (target == null || target.distSqr(new net.minecraft.core.Vec3i(danger.block()[0], danger.block()[1], danger.block()[2])) > 2.25D)) {
				episode.causedByAction = true;
				episode.causedActionId = active.actionId();
			}
		}
		Long attention = LAST_ATTENTION.get(watch.id);
		if (attention != null && attention >= episode.openedEpochMs && (!harmed || attention <= episode.firstHarmEpochMs)) episode.wakeSent = true;
		// Terrain is judged while it threatens: after a fall the agent may see the drop from below.
		if (knowledge && !harmed && (danger != null || !TERRAIN.contains(episode.kind))) knowledge(watch, episode, player, epochMs);
	}

	/**
	 * The first harm of an episode the body's own movement approached: the body caused it only if that movement is still
	 * the running action. Harm under a later command is that command's (live run d18-iron-a: a pick-up walked to a tree-top
	 * edge, and 77 s later a break_block the model aimed at the log under the feet dropped the body 7 blocks; the episode
	 * read "break_block moved toward the drop").
	 */
	static void harmedUnder(Episode episode, ServerActionRequest active) {
		if (!episode.causedByAction || active != null && active.actionId().equals(episode.causedActionId)) return;
		episode.causedByAction = false;
		setAction(episode, active);
	}

	private static void setAction(Episode episode, ServerActionRequest active) {
		episode.action = active == null ? null : active.type().wireName();
		episode.actionArguments = active == null ? null : active.arguments();
	}

	private static double speedToward(ServerPlayer player, int[] block) {
		double dx = block[0] + 0.5D - player.getX();
		double dz = block[2] + 0.5D - player.getZ();
		double length = Math.hypot(dx, dz);
		if (length < 1.0E-6D) return 0.0D;
		return (player.getDeltaMovement().x * dx + player.getDeltaMovement().z * dz) / length * 20.0D;
	}

	/** Could a player have perceived it, and was it in the agent's observation (accumulated until the first harm). */
	private void knowledge(AgentWatch watch, Episode episode, ServerPlayer player, long epochMs) {
		switch (episode.kind) {
			case "burning", "drowning", "low_health", "fall", "starving", "ender_pearl" -> {
				// Body state a player feels and the observation's vitals always carry; pearl damage only hits the thrower.
				episode.perceivable = true;
				episode.inObservation = true;
				episode.inThreatFacts = true;
				if (episode.firstObservedAt == null) episode.firstObservedAt = epochMs;
				return;
			}
			case "lava", "fire", "lava_hidden", "drop", "void" -> {
				blockKnowledge(watch, episode, player, epochMs);
				return;
			}
			default -> entityKnowledge(watch, episode, player, epochMs);
		}
	}

	private void blockKnowledge(AgentWatch watch, Episode episode, ServerPlayer player, long epochMs) {
		boolean drop = episode.kind.equals("drop") || episode.kind.equals("void");
		Delivered delivered = DELIVERED.get(watch.id);
		// A player at an edge can look down it, unless walls hide the opening (a cave beside the corner of a dug shaft).
		if (drop && episode.block != null && openingInSight(player, episode.block)) episode.perceivable = true;
		int[] block = episode.block;
		if (block == null) return;
		boolean lava = !episode.kind.equals("fire") && !drop;
		// Known as terrain, or carried as a fact: lava heard, a footing or drop-ahead edge.
		boolean known = TruthScan.knows(player, block, lava)
				|| delivered != null && epochMs - delivered.epochMs() < 5_000L && (lava ? delivered.heardLava() : drop && delivered.edgeFacts());
		if (known) {
			episode.inObservation = true;
			episode.inThreatFacts = true;
			if (episode.firstObservedAt == null) episode.firstObservedAt = epochMs;
		}
		if (episode.perceivable) return;
		BlockPos cell = new BlockPos(block[0], block[1], block[2]);
		// Seen (any direction a player could turn to) or heard as the hearing model emits it (lava pops); sealed lava is neither.
		if (known || ObservationVisibility.frame(player.level(), player).hasLineOfSight(cell)) episode.perceivable = true;
	}

	private static boolean openingInSight(ServerPlayer player, int[] block) {
		net.minecraft.world.phys.Vec3 centre = net.minecraft.world.phys.Vec3.atCenterOf(new BlockPos(block[0], block[1], block[2]));
		return player.level().clip(new net.minecraft.world.level.ClipContext(player.getEyePosition(), centre,
				net.minecraft.world.level.ClipContext.Block.VISUAL, net.minecraft.world.level.ClipContext.Fluid.NONE, player)).getType()
				== net.minecraft.world.phys.HitResult.Type.MISS;
	}

	private void entityKnowledge(AgentWatch watch, Episode episode, ServerPlayer player, long epochMs) {
		if (episode.entityId == null) return;
		Delivered delivered = DELIVERED.get(watch.id);
		if (delivered != null && delivered.uuids().contains(episode.entityId)) {
			episode.inObservation = true;
			// Dragon rows (its parts carry parentId) are what the coordinator builds the dragon fight facts from.
			if (delivered.threats().contains(episode.entityId) || episode.kind.equals("dragon")) episode.inThreatFacts = true;
			episode.seenRow = true;
			Map<String, Long> first = FIRST_SEEN.get(watch.id);
			Long seen = first == null ? null : first.get(episode.entityId);
			if (episode.firstObservedAt == null && seen != null) episode.firstObservedAt = seen;
		} else if (delivered != null && heardFresh(delivered, episode.sourceType, epochMs)) {
			episode.inObservation = true;
			if (episode.firstObservedAt == null) episode.firstObservedAt = epochMs;
		}
		if (episode.perceivable) return;
		Entity entity;
		try {
			entity = player.level().getEntity(UUID.fromString(episode.entityId));
		} catch (IllegalArgumentException invalid) {
			return;
		}
		if (entity == null) return;
		double distance = player.distanceTo(entity);
		// Mobs make sound (steps, ambient calls, a creeper's hiss) within 16 blocks; a ghast's cry and the dragon carry.
		boolean heard = distance <= 16.0D || entity instanceof Ghast && distance <= 64.0D || entity instanceof EnderDragon;
		if (heard || ObservationVisibility.frame(player.level(), player).hasLineOfSight(entity)) episode.perceivable = true;
	}

	/** A fresh sound naming a one-per-fight type reached the agent: it knew roughly where the source was. */
	static boolean heardFresh(Delivered delivered, String sourceType, long epochMs) {
		if (sourceType == null || !UNIQUE_HEARD_TYPES.contains(sourceType)) return false;
		Long at = delivered.heardTypes().get(sourceType);
		return at != null && epochMs - at <= HEARD_FRESH_MS;
	}

	/** Covering reflex firings during open episodes: start time, then result once the scheduler reports its end. */
	private void firings(AgentWatch watch, ReflexEngine.View view, long epochMs) {
		ReflexScheduler.Firing current = view.current();
		if (current != null) {
			String key = current.ruleId() + "@" + current.startTick();
			if (!key.equals(watch.firingKey)) {
				watch.firingKey = key;
				long atMs = epochMs - Math.max(0L, view.nowTick() - current.startTick()) * 50L;
				Set<String> when = Set.of();
				for (ReflexEngine.RuleView rule : view.rules()) if (rule.id().equals(current.ruleId())) when = rule.when();
				for (Episode episode : watch.tracker.open()) {
					Set<String> covering = Diagnosis.COVERAGE.getOrDefault(episode.kind, Set.of());
					boolean known = episode.fired.stream().anyMatch(firing -> firing.rule().equals(current.ruleId()) && firing.atMs() == atMs);
					if (!known && when.stream().anyMatch(covering::contains)) episode.fired.add(new Episode.Firing(current.ruleId(), atMs, "running"));
				}
			}
		}
		for (ReflexScheduler.Event event : view.events()) {
			if (event.sequence() <= watch.eventSequence) continue;
			watch.eventSequence = event.sequence();
			for (Episode episode : watch.tracker.open()) {
				for (int index = episode.fired.size() - 1; index >= 0; index--) {
					Episode.Firing firing = episode.fired.get(index);
					if (!firing.rule().equals(event.ruleId()) || !firing.result().equals("running")) continue;
					String result = event.outcome().wire() + (event.detail().isEmpty() ? "" : ": " + event.detail());
					episode.fired.set(index, new Episode.Firing(firing.rule(), firing.atMs(), result.length() > 120 ? result.substring(0, 120) : result));
					break;
				}
			}
		}
	}

	// ---- Forecasts ----

	private void forecasts(AgentWatch watch, ServerPlayer player, ServerActionExecutor executor, ServerActionRequest active, boolean portal, long epochMs) {
		if (portal) emit(watch, "portal", Forecasts.arrival(player), epochMs);
		String actionId = active == null ? null : active.actionId();
		if (actionId != null && !actionId.equals(watch.lastActionId)) {
			watch.pendingRoute = null;
			switch (active.type()) {
				case NAVIGATE_TO, TRAVEL_TO, MOVE_TO, FLEE_FROM, FOLLOW_ENTITY -> {
					watch.pendingRoute = active.type();
					watch.routeWait = 0;
				}
				case BREAK_BLOCK -> {
					BlockPos target = executor.activeTarget(watch.id);
					if (target != null) emit(watch, active.type().wireName(), Forecasts.breaking(player, target), epochMs);
				}
				case PLACE_BLOCK -> {
					BlockPos target = executor.activeTarget(watch.id);
					if (target != null) emit(watch, active.type().wireName(), Forecasts.placing(player, target), epochMs);
				}
				default -> {
				}
			}
		}
		watch.lastActionId = actionId;
		if (watch.pendingRoute != null && executor != null) {
			var route = executor.activeRoute(watch.id);
			if (!route.isEmpty()) {
				emit(watch, watch.pendingRoute.wireName(), Forecasts.route(player, route), epochMs);
				watch.pendingRoute = null;
			} else if (++watch.routeWait > ROUTE_WAIT_TICKS) {
				watch.pendingRoute = null;
			}
		}
	}

	private void emit(AgentWatch watch, String action, List<Forecasts.Hazard> hazards, long epochMs) {
		for (Forecasts.Hazard hazard : hazards) {
			BlockPos cell = hazard.block();
			WatchJson.Forecast forecast = new WatchJson.Forecast(watch.idText + "-f" + epochMs + "-" + (++watch.forecastSequence), watch.idText,
					epochMs, action, hazard.kind(), cell == null ? null : new int[] {cell.getX(), cell.getY(), cell.getZ()}, hazard.distance(),
					hazard.detail());
			watch.forecasts.addLast(forecast);
			while (watch.forecasts.size() > 32) watch.forecasts.removeFirst();
			append(watch.idText + "-forecasts.jsonl", WatchJson.line(WatchJson.forecast(forecast)));
		}
	}

	// ---- Damage and death ----

	private record Attribution(String key, String kind, String sourceType, String entityId, int[] block) {
	}

	private static Attribution attribute(ServerPlayer player, DamageSource source) {
		Entity cause = source.getEntity();
		Entity direct = source.getDirectEntity();
		Entity origin = cause != null ? cause : direct;
		String key = origin == null || origin == player ? null : origin.getUUID().toString();
		String type = origin == null ? source.typeHolder().getRegisteredName() : TruthScan.typeId(origin);
		String kind;
		if (source.is(DamageTypes.LAVA)) kind = "lava";
		else if (source.is(DamageTypes.IN_FIRE) || source.is(DamageTypes.CAMPFIRE)) kind = "fire";
		else if (source.is(DamageTypes.FALL) || source.is(DamageTypes.FLY_INTO_WALL)) kind = "fall";
		else if (source.is(DamageTypes.FELL_OUT_OF_WORLD)) kind = "void";
		else if (source.is(DamageTypes.DROWN)) kind = "drowning";
		else if (source.is(DamageTypes.STARVE)) kind = "starving";
		else if (source.is(DamageTypes.DRAGON_BREATH)) kind = "dragon_breath";
		else if (direct instanceof Projectile || source.is(DamageTypeTags.IS_PROJECTILE)) kind = "projectile";
		// Burning (the fire tag after lava, flames and fireballs are matched above).
		else if (source.is(DamageTypeTags.IS_FIRE)) kind = "burning";
		else if (origin instanceof EnderDragon) kind = "dragon";
		else if (origin != null) kind = "mob";
		else kind = source.typeHolder().getRegisteredName().replace("minecraft:", "");
		if (kind.equals("dragon_breath") && direct != null) key = direct.getUUID().toString();
		BlockPos at = player.blockPosition();
		int[] block = origin == null ? new int[] {at.getX(), at.getY(), at.getZ()} : null;
		return new Attribution(key, kind, type, key, block);
	}

	private void damaged(ServerPlayer player, DamageSource source, float amount) {
		AgentId agentId = byPlayer.get(player.getUUID());
		AgentWatch watch = agentId == null ? null : agents.get(agentId);
		if (watch == null) return;
		long epochMs = System.currentTimeMillis();
		Attribution who = attribute(player, source);
		Episode harmed = watch.tracker.damage(who.key(), who.kind(), who.sourceType(), who.entityId(), who.block(), amount, player.getHealth(),
				player.level().getGameTime(), epochMs);
		ReflexEngine reflexes = ReflexEngine.existing(server).orElse(null);
		ServerActionRequest active = BridgeTap.executor(server) == null ? null : BridgeTap.executor(server).activeRequest(agentId);
		if (harmed != null && harmed.firstHarmEpochMs == epochMs) harmedUnder(harmed, active);
		for (Episode episode : watch.tracker.takeOpened()) opened(watch, episode, player, reflexes, active, epochMs);
	}

	private void died(ServerPlayer player, DamageSource source) {
		AgentId agentId = byPlayer.get(player.getUUID());
		AgentWatch watch = agentId == null ? null : agents.get(agentId);
		if (watch == null) return;
		long epochMs = System.currentTimeMillis();
		Attribution who = attribute(player, source);
		String message = player.getCombatTracker().getDeathMessage().getString();
		ReflexEngine reflexes = ReflexEngine.existing(server).orElse(null);
		ServerActionRequest active = BridgeTap.executor(server) == null ? null : BridgeTap.executor(server).activeRequest(agentId);
		for (Episode episode : watch.tracker.open()) if (episode.firstHarmEpochMs < 0L) harmedUnder(episode, active);
		List<Episode> closed = watch.tracker.death(who.key(), who.kind(), who.sourceType(), who.entityId(), who.block(), message,
				player.level().getGameTime(), epochMs);
		for (Episode episode : watch.tracker.takeOpened()) opened(watch, episode, player, reflexes, active, epochMs);
		if (reflexes != null) firings(watch, reflexes.view(agentId), epochMs);
		write(watch, closed, reflexes);
	}

	// ---- Output ----

	private void write(AgentWatch watch, List<Episode> closed, ReflexEngine reflexes) {
		if (closed.isEmpty()) return;
		Set<String> vocabulary = ReflexSpec.conditionTypes();
		StringBuilder lines = new StringBuilder();
		for (Episode episode : closed) {
			Diagnosis.diagnose(episode, vocabulary);
			lines.append(WatchJson.line(WatchJson.episode(episode))).append('\n');
		}
		appendRaw(watch.idText + "-episodes.jsonl", lines.toString());
	}

	private void append(String file, String line) {
		appendRaw(file, line + "\n");
	}

	private void appendRaw(String file, String text) {
		try {
			Files.createDirectories(directory);
			Files.writeString(directory.resolve(file), text, StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
		} catch (IOException failure) {
			LOGGER.warn("Watcher could not write {}: {}", file, failure.getMessage());
		}
	}

	private void stop() {
		long epochMs = System.currentTimeMillis();
		for (AgentWatch watch : agents.values()) write(watch, watch.tracker.closeAll(serverGameTime(), epochMs), null);
		agents.clear();
	}
}
