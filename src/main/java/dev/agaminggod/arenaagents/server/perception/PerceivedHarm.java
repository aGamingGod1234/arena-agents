package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.agent.AgentId;
import dev.agaminggod.arenaagents.server.runtime.controller.HazardExits;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.attribute.EnvironmentAttributes;
import net.minecraft.world.effect.MobEffects;

/** Damage facts from the player's own HUD, overlays, contact and received damage cause. Never predicts DPS. */
final class PerceivedHarm {
	static final long WINDOW_TICKS = 40;
	static final long MIN_RATE_TICKS = 20;
	private final Map<AgentId, Memory> memories = new HashMap<>();

	static final class History {
		private final long[] ticks = new long[64];
		private final int[] hearts = new int[64];
		private int size, next;
		private long lastTick = Long.MIN_VALUE;
		void sample(long tick, int visibleHp) {
			if (tick == lastTick) { hearts[Math.floorMod(next - 1, ticks.length)] = visibleHp; return; }
			if (tick < lastTick || (lastTick != Long.MIN_VALUE && tick - lastTick > WINDOW_TICKS)) size = next = 0;
			ticks[next] = tick;
			hearts[next] = visibleHp;
			next = (next + 1) % ticks.length;
			size = Math.min(size + 1, ticks.length);
			lastTick = tick;
		}
		/** Net displayed HP loss, including absorption, per game second (20 ticks), not per wall second. */
		Double rate(long tick, int visibleHp) {
			long start = Long.MAX_VALUE;
			int hp = visibleHp;
			for (int i = 0; i < size; i++) {
				if (ticks[i] >= tick - WINDOW_TICKS && ticks[i] <= tick && ticks[i] < start) {
					start = ticks[i];
					hp = hearts[i];
				}
			}
			if (start == Long.MAX_VALUE || tick - start < MIN_RATE_TICKS) return null;
			return Math.round(Math.max(0, hp - visibleHp) * 20.0D / (tick - start) * 10.0D) / 10.0D;
		}
	}

	private static final class Memory {
		String dimension;
		int entityId;
		History history = new History();
		int hurtTime;
		float health = Float.NaN;
		String recentSource;
		long recentTick = Long.MIN_VALUE;
		HazardExits.Contact contact;
		long contactCell, contactTick;
		Snapshot snapshot;
	}

	record Cues(boolean fire, boolean lava, boolean drowning, boolean suffocating, boolean falling,
			boolean starving, boolean poison, boolean wither, boolean freezing, boolean voidFall, String contact) { }
	/** waterEvaporates: vanilla removes placed water in this dimension (the Nether), so water is not a remedy there. */
	record Snapshot(String source, boolean ongoing, Double hpLossPerSecond, String direction, boolean waterEvaporates) {
		Snapshot(String source, boolean ongoing, Double hpLossPerSecond, String direction) { this(source, ongoing, hpLossPerSecond, direction, false); }
	}

	synchronized Snapshot sample(AgentId id, ServerPlayer player) { return sample(id, player, null, false); }
	synchronized Snapshot sample(AgentId id, ServerPlayer player, HazardExits.Contact contact) { return sample(id, player, contact, true); }

	private Snapshot sample(AgentId id, ServerPlayer player, HazardExits.Contact contact, boolean contactKnown) {
		if (player.getEntityData() == null || !player.isAlive()) { reset(id); return null; }
		long tick = player.level().getGameTime();
		String dimension = player.level().dimension().identifier().toString();
		Memory memory = memories.computeIfAbsent(id, ignored -> new Memory());
		if (!dimension.equals(memory.dimension) || memory.entityId != player.getId()) {
			memory = new Memory();
			memory.dimension = dimension;
			memory.entityId = player.getId();
			memories.put(id, memory);
		}
		int hp = visibleHp(player.getHealth(), player.getAbsorptionAmount());
		float health = player.getHealth() + player.getAbsorptionAmount();
		boolean lostHealth = health < memory.health;
		boolean immune = player.getAbilities().invulnerable || player.isSpectator();
		boolean received = !immune && (lostHealth || player.hurtTime > memory.hurtTime);
		boolean magicContact = !immune && (lostHealth || player.hurtTime > 0) && CloudDanger.magicDamage(player);
		String cloudSource = magicContact ? CloudDanger.contactSource(player) : null;
		if (received) {
			var damage = player.getLastDamageSource();
			memory.recentSource = damage == null ? "minecraft:generic" : damage.typeHolder().unwrapKey()
					.map(key -> key.identifier().toString()).orElse("minecraft:generic");
			if (cloudSource != null) memory.recentSource = cloudSource;
			memory.recentTick = tick;
		}
		memory.health = health;
		memory.hurtTime = player.hurtTime;
		memory.history.sample(tick, hp);
		if (contactKnown) {
			memory.contact = contact;
			memory.contactCell = player.blockPosition().asLong();
			memory.contactTick = tick;
		} else if (memory.contactCell != player.blockPosition().asLong() || tick - memory.contactTick > 10) memory.contact = null;
		boolean fireImmune = HazardExits.fireResistant(player);
		Cues cues = new Cues(!fireImmune && player.isOnFire(), !fireImmune && player.isInLava(),
				player.isUnderWater() && player.getAirSupply() <= 60 && !player.hasEffect(MobEffects.WATER_BREATHING)
						&& !player.hasEffect(MobEffects.CONDUIT_POWER), player.isInWall(), FallDanger.damage(player) > 0,
				player.getFoodData().getFoodLevel() == 0, player.hasEffect(MobEffects.POISON) && player.getHealth() > 1,
				player.hasEffect(MobEffects.WITHER), player.getTicksFrozen() > 0,
				player.getY() < player.level().getMinY() - 64 || fallingIntoVoid(player),
				!fireImmune && memory.contact != null ? memory.contact.wire : null);
		String active = immune ? null : currentSource(cues);
		if (!immune && cloudSource != null && active == null) active = cloudSource;
		String recent = recentSource(memory.recentSource, memory.recentTick, tick);
		String source = active == null ? recent : active;
		if (source == null) { memory.snapshot = null; return null; }
		// Hurt-tilt direction is addressed to this body; no attacker identity or hidden location is read.
		JsonObject damage = PlayerObservationEvents.recentDamage(player);
		String direction = damage != null && damage.has("direction") && recent != null
				? damage.get("direction").getAsString() : null;
		boolean evaporates = player.level().environmentAttributes().getValue(EnvironmentAttributes.WATER_EVAPORATES, player.blockPosition());
		memory.snapshot = new Snapshot(source, active != null, memory.history.rate(tick, hp), direction, evaporates);
		return memory.snapshot;
	}

	/**
	 * Airborne and falling over a column empty to the world's bottom: no landing exists, so the harm ahead is the void,
	 * not a fall (live End run d6-end-a read "fall: known_landing, water" while dropping off an island into the void).
	 */
	static boolean fallingIntoVoid(ServerPlayer player) {
		if (player.onGround() || player.fallDistance <= 0 || player.getDeltaMovement().y >= 0) return false;
		return VoidColumn.below(player.level(), net.minecraft.util.Mth.floor(player.getX()), net.minecraft.util.Mth.floor(player.getY()),
				net.minecraft.util.Mth.floor(player.getZ()));
	}

	static int visibleHp(float health, float absorption) { return Math.max(0, (int) Math.ceil(health)) + Math.max(0, (int) Math.ceil(absorption)); }
	static String recentSource(String source, long observedTick, long tick) {
		return source != null && tick >= observedTick && tick - observedTick <= WINDOW_TICKS ? source : null;
	}
	static String currentSource(Cues cues) {
		if (cues.voidFall()) return "minecraft:fell_out_of_world";
		if (cues.lava()) return "minecraft:lava";
		if (cues.drowning()) return "minecraft:drown";
		if (cues.suffocating()) return "minecraft:in_wall";
		// Flames at the feet re-ignite the body every tick, so they outrank the burn they cause: stepping out ends them.
		if ("fire".equals(cues.contact())) return "minecraft:in_fire";
		if (cues.fire()) return "minecraft:on_fire";
		if (cues.contact() != null) return cues.contact().equals("hot_floor") ? "minecraft:hot_floor" : "minecraft:in_fire";
		if (cues.wither()) return "minecraft:wither";
		if (cues.poison()) return "minecraft:magic";
		if (cues.freezing()) return "minecraft:freeze";
		if (cues.falling()) return "minecraft:fall";
		if (cues.starving()) return "minecraft:starve";
		return null;
	}
	static List<String> options(String source) { return options(source, false); }
	static List<String> options(String source, boolean waterEvaporates) {
		if (waterEvaporates) {
			if (source.equals("minecraft:on_fire") || source.equals("minecraft:in_fire")) return List.of("leave_fire", "fire_resistance");
			if (source.equals("minecraft:fall")) return List.of("known_landing", "slow_falling");
		}
		return switch (source) {
			case "minecraft:on_fire", "minecraft:in_fire" -> List.of("water_or_rain", "leave_fire", "fire_resistance");
			case "minecraft:lava", "minecraft:hot_floor" -> List.of("leave_contact", "fire_resistance");
			case "minecraft:drown" -> List.of("air", "water_breathing");
			case "minecraft:in_wall" -> List.of("leave_solid_block");
			case "minecraft:fall" -> List.of("known_landing", "water", "slow_falling");
			case "minecraft:starve" -> List.of("food");
			case "minecraft:dragon_breath", "minecraft:lingering_potion" -> List.of("leave_cloud", "healing");
			case "minecraft:magic", "minecraft:wither" -> List.of("milk", "healing");
			case "minecraft:freeze" -> List.of("leave_powder_snow", "leather");
			case "minecraft:fell_out_of_world" -> List.of("known_support", "flight", "teleport");
			case "minecraft:explosion", "minecraft:player_explosion" -> List.of("cover", "distance", "healing");
			default -> List.of("healing", "leave_source");
		};
	}
	static JsonObject toJson(Snapshot snapshot) {
		if (snapshot == null) return null;
		JsonObject json = new JsonObject();
		json.addProperty("source", snapshot.source());
		if (snapshot.ongoing()) json.addProperty("ongoing", true);
		if (snapshot.hpLossPerSecond() != null) json.addProperty("hpLossPerSecond", snapshot.hpLossPerSecond());
		if (snapshot.direction() != null) json.addProperty("direction", snapshot.direction());
		JsonArray options = new JsonArray();
		options(snapshot.source(), snapshot.waterEvaporates()).forEach(options::add);
		json.add("options", options);
		if (snapshot.waterEvaporates() && List.of("minecraft:on_fire", "minecraft:in_fire", "minecraft:fall").contains(snapshot.source()))
			json.addProperty("waterEvaporates", true);
		return json;
	}
	synchronized void reset(AgentId id) { memories.remove(id); }
	synchronized void retain(Set<AgentId> ids) { memories.keySet().retainAll(ids); }
}
