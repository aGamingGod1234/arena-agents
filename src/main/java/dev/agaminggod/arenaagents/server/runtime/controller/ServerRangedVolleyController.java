package dev.agaminggod.arenaagents.server.runtime.controller;

import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.agent.AgentDomainException;
import dev.agaminggod.arenaagents.server.perception.ObservationVisibility;
import dev.agaminggod.arenaagents.server.perception.ObservedDrops;
import dev.agaminggod.arenaagents.server.runtime.ElapsedTimeAccumulator;
import dev.agaminggod.arenaagents.server.runtime.ServerProtectionPolicy;
import dev.agaminggod.arenaagents.server.runtime.transaction.ServerTransactionAdapter;
import dev.agaminggod.arenaagents.server.runtime.transaction.ServerTransactionAdapter.TickResult;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.ArrowItem;

/**
 * use_ranged with {@code untilDead:true}: the model's one named target is shot again and again, as a player holds
 * right-click, re-aims and looses, each arrow a normal {@link ServerRangedUseController} shot (same aim, draw, hold and
 * arrow watch). It stops when the target dies, at the model's timeout, when the target stays out of sight (or every
 * shot is refused) for {@link #SIGHT_LOSS_MS}, at the model's fleeAtHealth, on newly entering lava or fire (the
 * {@link HazardEntry} rule every action uses), when arrows run out, or when the model cancels. The result lists every
 * arrow and the kill; with {@code collect:true} a kill is followed by {@link KillDropCollector}.
 */
public final class ServerRangedVolleyController implements ServerTransactionAdapter.ActiveTransaction {
	public static final long DEFAULT_TIMEOUT_MS = 20_000L;
	public static final long MAX_TIMEOUT_MS = 60_000L;
	static final long SIGHT_LOSS_MS = 3_000L;
	/** One shot's own limit inside the volley; a shot held for a hidden target ends at the sight-loss limit first. */
	private static final long SHOT_TIMEOUT_MS = 8_000L;
	/** Shots in a row that loosed nothing before the volley hands back with the last reason. */
	private static final int MAX_DRY_SHOTS = 3;

	private final ServerPlayer player;
	private final JsonObject arguments;
	private final ServerProtectionPolicy protection;
	private final Entity target;
	private final String targetType;
	private final long timeoutMs;
	private final Float fleeAtHealth;
	private final boolean collect;
	private final ElapsedTimeAccumulator elapsedTime;
	private final HazardEntry hazard = new HazardEntry();
	private final ServerTransactionAdapter.TerminalGate terminal = new ServerTransactionAdapter.TerminalGate();
	private final List<String> arrows = new ArrayList<>();
	private final Set<UUID> drops = new LinkedHashSet<>();
	private ServerRangedUseController shot;
	private int loosed;
	private int struck;
	private int dryShots;
	private long lastSeenMs;
	private long lastVisibleTick;
	private long refusedSinceMs = -1L;
	private String refusal;
	private KillDropCollector collector;
	private String killNote;

	public ServerRangedVolleyController(ServerPlayer player, JsonObject arguments, ServerProtectionPolicy protection) {
		this.player = Objects.requireNonNull(player, "player must not be null");
		this.arguments = Objects.requireNonNull(arguments, "arguments must not be null").deepCopy();
		this.protection = Objects.requireNonNull(protection, "protection must not be null");
		this.timeoutMs = Math.min(MAX_TIMEOUT_MS, arguments.has("timeoutMs") ? arguments.get("timeoutMs").getAsLong() : DEFAULT_TIMEOUT_MS);
		this.fleeAtHealth = arguments.has("fleeAtHealth") ? arguments.get("fleeAtHealth").getAsFloat() : null;
		this.collect = arguments.has("collect") && arguments.get("collect").getAsBoolean();
		this.elapsedTime = new ElapsedTimeAccumulator(System.currentTimeMillis());
		// The first arrow is accepted or refused now, with the single shot's own reasons (no bow, no arrow, obstructed).
		this.shot = new ServerRangedUseController(player, shotArguments(0L), protection);
		this.target = shot.target();
		this.targetType = BuiltInRegistries.ENTITY_TYPE.getKey(target.getType()).toString();
		this.hazard.observe(player);
		this.lastVisibleTick = player.level().getGameTime();
	}

	private JsonObject shotArguments(long elapsed) {
		JsonObject copy = arguments.deepCopy();
		copy.addProperty("timeoutMs", Math.max(1L, Math.min(SHOT_TIMEOUT_MS, timeoutMs - elapsed)));
		return copy;
	}

	@Override
	public TickResult tick(long nowEpochMs) {
		TickResult existing = terminal.terminalResult();
		if (existing != null) return existing;
		long elapsed = elapsedTime.advance(nowEpochMs);
		if (!player.isAlive()) return stop(TickResult.failed("AGENT_DEAD", "Agent player died during the volley"));
		String hazardCode = hazard.observe(player);
		if (hazardCode != null) return stop(TickResult.failed(hazardCode, CombatMoveText.hazardStop(hazardCode, player, "use_ranged")));
		if (collector != null) {
			String collected = collector.tick(player, nowEpochMs);
			return collected == null ? TickResult.running() : stop(TickResult.succeeded("TARGET_KILLED", killNote + "; collect: " + collected));
		}
		boolean sees = target.level() == player.level() && ObservationVisibility.frame(player.level(), player).hasLineOfSight(target);
		if (sees) {
			lastSeenMs = elapsed;
			lastVisibleTick = player.level().getGameTime();
		}
		if (shot != null) {
			TickResult result = shot.tick(nowEpochMs);
			if (result.state() != ServerTransactionAdapter.TickState.RUNNING) {
				record(result);
				shot.cleanup();
				shot = null;
			}
		}
		if (target instanceof LivingEntity living && living.isDeadOrDying()) return killed(nowEpochMs);
		if (!target.isAlive() || target.isRemoved() || target.level() != player.level())
			return stop(TickResult.failed("TARGET_GONE", targetType + " is gone without a kill seen"));
		if (fleeAtHealth != null && CombatPlanning.shouldBailOut(player.getHealth(), fleeAtHealth))
			return stop(TickResult.failed("LOW_HEALTH_BAILOUT", String.format(Locale.ROOT,
					"Health %.1f reached fleeAtHealth %.1f; body idle, no retreat performed", player.getHealth(), fleeAtHealth)));
		if (elapsed >= timeoutMs)
			return stop(TickResult.timedOut("RANGED_VOLLEY_TIMED_OUT", String.format(Locale.ROOT, "%s still alive at the %.0f s timeout", targetType, timeoutMs / 1000.0D)));
		if (elapsed - lastSeenMs > SIGHT_LOSS_MS)
			return stop(TickResult.failed("TARGET_NOT_VISIBLE", String.format(Locale.ROOT,
					"%s out of sight for %.0f s; last seen %.1f s ago", targetType, SIGHT_LOSS_MS / 1000.0D, (elapsed - lastSeenMs) / 1000.0D)));
		if (dryShots >= MAX_DRY_SHOTS)
			return stop(TickResult.failed(refusal == null ? "RANGED_USE_NOT_STARTED" : refusal, dryShots + " shots in a row loosed no arrow"));
		if (shot == null) {
			try {
				shot = new ServerRangedUseController(player, shotArguments(elapsed), protection);
				refusedSinceMs = -1L;
			} catch (AgentDomainException refused) {
				String code = refused.code();
				if ("PROJECTILE_REQUIRED".equals(code)) return stop(TickResult.failed("OUT_OF_ARROWS", "No arrow left to loose"));
				if ("BOW_NOT_EQUIPPED".equals(code) || "RANGED_TARGET_DENIED".equals(code)) return stop(TickResult.failed(code, refused.getMessage()));
				// A target behind cover or past reach for now: hold the turn, as a player waits for it to show again.
				if (refusedSinceMs < 0L) refusedSinceMs = elapsed;
				refusal = code;
				if (elapsed - refusedSinceMs > SIGHT_LOSS_MS)
					return stop(TickResult.failed(code, String.format(Locale.ROOT, "every shot refused for %.0f s: %s", SIGHT_LOSS_MS / 1000.0D, refused.getMessage())));
			}
		}
		return TickResult.running();
	}

	private void record(TickResult result) {
		String outcome = shot.arrowOutcome();
		if ("OWNED_PROJECTILE_CONFIRMED".equals(result.reasonCode())) {
			loosed++;
			dryShots = 0;
			if (outcome != null && outcome.startsWith("it struck the target")) struck++;
			arrows.add(loosed + ": " + (outcome == null ? "loosed" : outcome));
		} else {
			dryShots++;
			refusal = result.reasonCode();
			arrows.add("no arrow: " + result.reasonCode());
		}
	}

	private TickResult killed(long nowEpochMs) {
		if (shot != null) {
			shot.cancel("target died");
			shot = null;
		}
		witnessDrops();
		killNote = String.format(Locale.ROOT, "Killed %s", targetType);
		if (!collect || drops.isEmpty()) {
			return stop(TickResult.succeeded("TARGET_KILLED", killNote + (collect ? "; collect: no drop was seen to collect" : "")));
		}
		collector = new KillDropCollector(drops, protection::mayTakeEntity, nowEpochMs);
		String collected = collector.tick(player, nowEpochMs);
		return collected == null ? TickResult.running() : stop(TickResult.succeeded("TARGET_KILLED", killNote + "; collect: " + collected));
	}

	/** The drops that appeared at the body, seen as a player watching the kill sees them (as fight_target notes them). */
	private void witnessDrops() {
		ObservationVisibility.Frame sight = ObservationVisibility.frame(player.level(), player);
		for (ItemEntity item : player.level().getEntitiesOfClass(ItemEntity.class, target.getBoundingBox().inflate(ServerFightController.DROP_SEARCH_BLOCKS),
				item -> item.isAlive() && !item.getItem().isEmpty() && item.getAge() <= ServerFightController.DROP_AGE_TICKS)) {
			boolean witnessed = player.level().getGameTime() - lastVisibleTick <= 2L && sight.hasLineOfSight(item);
			if (!sight.canSeeEntity(item) && !witnessed) continue;
			ObservedDrops.remember(player, item);
			drops.add(item.getUUID());
		}
	}

	private int arrowsLeft() {
		if (player.hasInfiniteMaterials()) return -1;
		int count = 0;
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
			var stack = player.getInventory().getItem(slot);
			if (stack.getItem() instanceof ArrowItem) count += stack.getCount();
		}
		return count;
	}

	private String report(String message) {
		long seconds = Math.round(elapsedTime.advance(System.currentTimeMillis()) / 100.0D);
		StringBuilder text = new StringBuilder(message).append(String.format(Locale.ROOT,
				"; volley %.1f s: %d arrow%s loosed, %d struck the target", seconds / 10.0D, loosed, loosed == 1 ? "" : "s", struck));
		int left = arrowsLeft();
		if (left >= 0) text.append("; ").append(left).append(" arrows left");
		if (!arrows.isEmpty()) text.append("; arrows: ").append(String.join(" | ", arrows));
		for (UUID id : drops) if (collector == null) text.append("; drop: ").append(ObservedDrops.describe(player, id));
		return text.toString();
	}

	private TickResult stop(TickResult result) {
		if (shot != null) {
			shot.cancel(result.reasonCode());
			shot = null;
		}
		if (collector != null && collector.walking()) collector.cancel(player);
		return terminal.finish(new TickResult(result.state(), result.reasonCode(), report(result.message())));
	}

	@Override
	public void cancel(String reason) {
		stop(TickResult.cancelled(reason == null ? "Ranged volley cancelled" : reason));
		cleanup();
	}

	@Override
	public void cleanup() {
		terminal.cleanupOnce(() -> ServerTransactionAdapter.runBestEffort(
				() -> { if (shot != null) shot.cleanup(); },
				() -> { if (collector != null) collector.cancel(player); },
				() -> { if (player.isUsingItem()) player.stopUsingItem(); }
		));
	}
}
