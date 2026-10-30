package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.agent.AgentId;
import dev.agaminggod.arenaagents.server.runtime.controller.HazardExits;
import it.unimi.dsi.fastutil.longs.LongArrayList;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.Level;

/**
 * Hazard facts a player has without looking for them: what hazard block the body touches, how long they will burn,
 * the cells they could step out to, what last hurt them (the damage tint, sound and cause a player sees), and lava they
 * saw close by in the last 30 s that has since left the view. Exits are scanned only while the body touches a hazard.
 * Memory lasts across observations and actions; it resets on death, a dimension change or the agent leaving.
 */
final class HazardFacts {
	static final String LAVA_ID = "minecraft:lava";
	static final long LAVA_MEMORY_TICKS = 600L;
	static final double LAVA_RADIUS = 4.0D;
	static final int MAX_REMEMBERED = 16;
	static final int MAX_REPORTED = 3;
	private static final long EXIT_REUSE_TICKS = 10L;

	private final Map<AgentId, Memory> memories = new HashMap<>();
	private final PerceivedHarm harm;

	HazardFacts() { this(new PerceivedHarm()); }
	HazardFacts(PerceivedHarm harm) { this.harm = harm; }

	private static final class Memory {
		ResourceKey<Level> dimension;
		int entityId;
		final Map<Long, Long> lavaSeenAt = new HashMap<>();
		long exitCell = Long.MIN_VALUE;
		long exitView = Long.MIN_VALUE;
		long exitTick = Long.MIN_VALUE;
		JsonArray exits;
	}

	/** hazard, fireTicks, exits and hurtBy, each only while it applies. */
	synchronized void addPlayerFacts(AgentId agentId, ServerPlayer agent, ObservationVisibility.Frame visibility, JsonObject player) {
		Memory memory = memory(agentId, agent);
		JsonArray clouds = CloudDanger.sample(agent);
		if (!clouds.isEmpty()) player.add("clouds", clouds);
		if (agent.isOnFire() && agent.getRemainingFireTicks() > 0) player.addProperty("fireTicks", agent.getRemainingFireTicks());
		HazardExits.Contact contact = HazardExits.contact(agent);
		if (contact != null) player.addProperty("hazard", contact.wire);
		PerceivedHarm.Snapshot harmSnapshot = harm.sample(agentId, agent, contact);
		JsonObject harmFacts = PerceivedHarm.toJson(harmSnapshot);
		if (harmFacts != null && ("minecraft:dragon_breath".equals(harmSnapshot.source()) || "minecraft:lingering_potion".equals(harmSnapshot.source()))) {
			JsonArray exits = new JsonArray();
			for (var value : clouds) {
				JsonObject cloud = value.getAsJsonObject();
				if (cloud.has("nearestExit")) exits.add(cloud.get("nearestExit").deepCopy());
			}
			player.add("exits", exits); harmFacts.add("exits", exits.deepCopy());
			memory.exits = null;
		} else if (harmFacts != null && harmSnapshot.ongoing() && !"minecraft:drown".equals(harmSnapshot.source())) {
			long cell = agent.blockPosition().asLong();
			// Bearings and what is in view both follow the facing.
			long view = Math.round(agent.getYRot() / 10.0F) * 64L + Math.round(agent.getXRot() / 10.0F);
			long tick = agent.level().getGameTime();
			if (memory.exits == null || memory.exitCell != cell || memory.exitView != view || tick - memory.exitTick >= EXIT_REUSE_TICKS
					|| tick < memory.exitTick) {
				JsonArray exits = new JsonArray();
				for (HazardExits.Exit exit : HazardExits.scan(agent)) exits.add(HazardExits.describe(exit));
				memory.exits = exits;
				memory.exitCell = cell;
				memory.exitView = view;
				memory.exitTick = tick;
			}
			player.add("exits", memory.exits.deepCopy());
			harmFacts.add("exits", memory.exits.deepCopy());
		} else {
			memory.exits = null;
		}
		if (harmFacts != null) player.add("harm", harmFacts);
		DamageSource source = agent.getLastDamageSource();
		if (source != null) player.addProperty("hurtBy", damageCause(source, visibility));
		String cloudSource = CloudDanger.contactSource(agent);
		if (cloudSource != null && source != null && (source.getMsgId().contains("Magic") || source.getMsgId().contains("magic")))
			player.addProperty("hurtBy", cloudSource.substring("minecraft:".length()));
		JsonObject recentDamage = PlayerObservationEvents.recentDamage(agent);
		if (recentDamage != null) {
			if (cloudSource != null && recentDamage.has("cause") && recentDamage.get("cause").getAsString().contains("magic")) {
				recentDamage = recentDamage.deepCopy(); recentDamage.addProperty("cause", cloudSource);
			}
			player.add("recentDamage", recentDamage);
		}
	}

	static String damageCause(DamageSource source, ObservationVisibility.Frame visibility) {
		String cause = source.typeHolder().unwrapKey().map(key -> key.identifier().getPath()).orElse(source.getMsgId());
		Entity attacker = source.getEntity();
		if (attacker == null || visibility == null || !visibility.canSeeEntity(attacker)) return cause;
		return cause + " by " + BuiltInRegistries.ENTITY_TYPE.getKey(attacker.getType());
	}

	/**
	 * Remembers lava seen within 4 blocks and reports remembered lava near the body that this sample no longer shows.
	 * A sampled lava row counts as seen only when the eye itself sees the cell (view cone with no allowance behind the
	 * eye, no block or other lava in front: {@link ObservationVisibility.Frame#seesCell}) or the body touches it; a
	 * block row's closeness allowance is not sight. {@code lavaRows} holds the packed positions of the sampled lava rows.
	 */
	synchronized void rememberLava(AgentId agentId, ServerPlayer agent, ObservationVisibility.Frame visibility, LongArrayList lavaRows, JsonObject player) {
		Memory memory = memory(agentId, agent);
		// Runs on every observation; with nothing remembered and no lava in view there is nothing to keep or report.
		if (memory.lavaSeenAt.isEmpty() && lavaRows.isEmpty()) return;
		long tick = agent.level().getGameTime();
		double x = agent.getX(), y = agent.getY(), z = agent.getZ();
		LongArrayList current = new LongArrayList(lavaRows.size());
		for (int i = 0; i < lavaRows.size(); i++) {
			long key = lavaRows.getLong(i);
			int bx = BlockPos.getX(key), by = BlockPos.getY(key), bz = BlockPos.getZ(key);
			if (!near(bx, by, bz, x, y, z)) continue;
			if (visibility != null && !visibility.seesCell(new BlockPos(bx, by, bz))
					&& !agent.getBoundingBox().intersects(bx, by, bz, bx + 1.0D, by + 1.0D, bz + 1.0D)) continue;
			current.add(key);
			memory.lavaSeenAt.put(key, tick);
		}
		memory.lavaSeenAt.entrySet().removeIf(entry -> tick - entry.getValue() > LAVA_MEMORY_TICKS || tick < entry.getValue());
		while (memory.lavaSeenAt.size() > MAX_REMEMBERED) {
			memory.lavaSeenAt.entrySet().stream().min(Map.Entry.comparingByValue())
					.ifPresent(oldest -> memory.lavaSeenAt.remove(oldest.getKey()));
		}
		List<Map.Entry<Long, Long>> unseen = null;
		for (Map.Entry<Long, Long> entry : memory.lavaSeenAt.entrySet()) {
			long key = entry.getKey();
			if (current.contains(key) || !near(BlockPos.getX(key), BlockPos.getY(key), BlockPos.getZ(key), x, y, z)) continue;
			if (unseen == null) unseen = new ArrayList<>(4);
			unseen.add(entry);
		}
		if (unseen == null) return;
		unseen.sort((left, right) -> Double.compare(distance(left.getKey(), x, y, z), distance(right.getKey(), x, y, z)));
		JsonArray seen = new JsonArray();
		for (int i = 0; i < unseen.size() && i < MAX_REPORTED; i++) {
			Map.Entry<Long, Long> entry = unseen.get(i);
			BlockPos cell = BlockPos.of(entry.getKey());
			seen.add("(" + cell.getX() + "," + cell.getY() + "," + cell.getZ() + ") " + (tick - entry.getValue()) / 20L + "s ago");
		}
		player.add("lavaSeen", seen);
	}

	/** Drops agents no longer tracked (left the server); observations and actions keep the memory. */
	synchronized void retain(Set<AgentId> agents) {
		memories.keySet().retainAll(agents);
		harm.retain(agents);
	}

	private Memory memory(AgentId agentId, ServerPlayer agent) {
		ResourceKey<Level> dimension = agent.level().dimension();
		Memory memory = memories.computeIfAbsent(agentId, ignored -> new Memory());
		// A respawned body is a new entity.
		if (!dimension.equals(memory.dimension) || memory.entityId != agent.getId()) {
			memory.dimension = dimension;
			memory.entityId = agent.getId();
			memory.lavaSeenAt.clear();
			memory.exits = null;
		}
		return memory;
	}

	private static boolean near(int bx, int by, int bz, double x, double y, double z) {
		return distanceSquared(bx, by, bz, x, y, z) <= LAVA_RADIUS * LAVA_RADIUS;
	}

	private static double distance(long key, double x, double y, double z) {
		BlockPos cell = BlockPos.of(key);
		return distanceSquared(cell.getX(), cell.getY(), cell.getZ(), x, y, z);
	}

	private static double distanceSquared(int bx, int by, int bz, double x, double y, double z) {
		double dx = bx + 0.5D - x, dy = by + 0.5D - y, dz = bz + 0.5D - z;
		return dx * dx + dy * dy + dz * dz;
	}
}
