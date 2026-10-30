package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.agent.AgentId;
import dev.agaminggod.arenaagents.mixin.AbstractArrowInvoker;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BiPredicate;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.projectile.Projectile;
import net.minecraft.world.entity.projectile.arrow.AbstractArrow;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/** Visible flight geometry only. This informs the model and never steers the body. */
public final class ProjectilePerception {
	public static final double RANGE = 32.0D;
	public static final double WARNING_SECONDS = 2.0D;
	public static final double IMMINENT_SECONDS = 0.5D;
	/** Vanilla grows the struck entity's box by this margin when testing a projectile's path (ProjectileUtil), so a shot
	 * grazing that close still lands. */
	public static final double HIT_MARGIN = net.minecraft.world.entity.projectile.ProjectileUtil.DEFAULT_ENTITY_HIT_RESULT_MARGIN;
	private static final Set<String> TYPES = Set.of("minecraft:arrow", "minecraft:spectral_arrow", "minecraft:trident", "minecraft:fireball", "minecraft:small_fireball", "minecraft:dragon_fireball");
	public record Entry(String uuid, String type, double bearing, double etaSeconds, boolean damaging, boolean fresh, boolean imminentFresh, boolean shieldBlockable) {
		public Entry(String uuid, String type, double bearing, double etaSeconds, boolean damaging, boolean fresh, boolean imminentFresh) {
			this(uuid, type, bearing, etaSeconds, damaging, fresh, imminentFresh, ProjectilePerception.shieldBlockable(type, false));
		}
	}
	public record Snapshot(List<Entry> entries, Set<String> signalKeys) {}
	private record Tracked(long tick, Snapshot snapshot) {}
	private final Map<AgentId, Tracked> latest = new HashMap<>();
	private final Map<AgentId, Set<String>> raised = new HashMap<>();

	public synchronized Snapshot sample(AgentId id, ServerPlayer agent) {
		long tick = agent.level().getGameTime();
		Tracked cached = latest.get(id);
		if (cached != null && cached.tick() == tick) return cached.snapshot();
		long started = PerceptionTiming.start();
		Set<String> signals = raised.computeIfAbsent(id, ignored -> new HashSet<>());
		Set<String> living = new HashSet<>();
		List<Entry> entries = new ArrayList<>();
		ObservationVisibility.Frame visibility = null;
		for (Projectile projectile : agent.level().getEntitiesOfClass(Projectile.class, agent.getBoundingBox().inflate(RANGE), Projectile::isAlive)) {
			String type = BuiltInRegistries.ENTITY_TYPE.getKey(projectile.getType()).toString();
			if (!supported(type) || projectile.getOwner() == agent
					|| !flying(projectile instanceof AbstractArrow arrow && ((AbstractArrowInvoker) arrow).arenaagents$isInGround(), projectile.getDeltaMovement())) continue;
			String uuid = projectile.getUUID().toString();
			double eta = impactSeconds(projectile.position(), projectile.getDeltaMovement(), agent.getBoundingBox(), agent.getDeltaMovement(), type.contains("fireball"), HIT_MARGIN);
			if (!Double.isFinite(eta)) continue;
			if (visibility == null) visibility = ObservationVisibility.frame(agent.level(), agent);
			if (!visibility.canSeeEntity(projectile)) continue;
			eta = impactSeconds(projectile.position(), projectile.getDeltaMovement(), agent.getBoundingBox(), agent.getDeltaMovement(),
					type.contains("fireball"), HIT_MARGIN,
					(from, to) -> agent.level().clip(new ClipContext(from, to, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, projectile))
							.getType() == HitResult.Type.MISS);
			if (!Double.isFinite(eta)) continue;
			living.add(uuid + ".incoming");
			living.add(uuid + ".imminent");
			boolean fresh = signals.add(uuid + ".incoming");
			boolean imminentFresh = eta <= IMMINENT_SECONDS && signals.add(uuid + ".imminent");
			Vec3 delta = projectile.position().subtract(agent.position());
			double bearing = net.minecraft.util.Mth.wrapDegrees(Math.toDegrees(Math.atan2(-delta.x, delta.z)) - agent.getYRot());
			var resistance = agent.getEffect(MobEffects.RESISTANCE);
			boolean damaging = damaging(agent.getAbilities().invulnerable || agent.isSpectator(), resistance == null ? -1 : resistance.getAmplifier(), agent.hasEffect(MobEffects.FIRE_RESISTANCE), type)
					&& !shieldBlocks(agent.isBlocking(), agent.getViewVector(1.0F), delta, type,
						projectile instanceof AbstractArrow arrow && arrow.getPierceLevel() > 0);
			entries.add(new Entry(uuid, type, Math.round(bearing), Math.round(eta * 100.0D) / 100.0D, damaging, fresh, imminentFresh, shieldBlockable(type, projectile instanceof AbstractArrow arrow && arrow.getPierceLevel() > 0)));
		}
		signals.retainAll(living);
		entries.sort(Comparator.comparingDouble(Entry::etaSeconds));
		Snapshot snapshot = new Snapshot(List.copyOf(entries.subList(0, Math.min(8, entries.size()))), Set.copyOf(signals));
		latest.put(id, new Tracked(tick, snapshot));
		PerceptionTiming.recordTick("projectiles", tick, started);
		return snapshot;
	}

	public synchronized void retain(Set<AgentId> ids) {
		latest.keySet().retainAll(ids);
		raised.keySet().retainAll(ids);
	}

	public static boolean supported(String type) { return TYPES.contains(type); }

	public static boolean damaging(boolean invulnerable, int resistanceAmplifier, boolean fireResistant, String type) {
		return !invulnerable && resistanceAmplifier < 4 && !(fireResistant && "minecraft:small_fireball".equals(type));
	}

	public static boolean flying(boolean inGround, Vec3 velocity) {
		return !inGround && velocity.lengthSqr() >= 0.01D;
	}

	public static boolean shieldBlocks(boolean blocking, Vec3 facing, Vec3 projectileOffset, String type, boolean piercing) {
		// A shield stops frontal direct hits; a ghast fireball still explodes around it and a dragon fireball still leaves its cloud.
		return blocking && shieldBlockable(type, piercing)
				&& facing.x * projectileOffset.x + facing.z * projectileOffset.z > 0.0D;
	}

	public static boolean shieldBlockable(String type, boolean piercing) {
		return supported(type) && !piercing && !"minecraft:fireball".equals(type) && !"minecraft:dragon_fireball".equals(type);
	}

	/** Short swept-flight estimate, using vanilla air drag, gravity and fireball acceleration, relative to the player's current motion. */
	public static double impactSeconds(Vec3 position, Vec3 velocity, AABB player, Vec3 playerVelocity, boolean fireball, double radius) {
		return impactSeconds(position, velocity, player, playerVelocity, fireball, radius, null);
	}

	public static double impactSeconds(Vec3 position, Vec3 velocity, AABB player, Vec3 playerVelocity, boolean fireball, double radius,
			BiPredicate<Vec3, Vec3> clearFlight) {
		if (!flying(false, velocity)) return Double.NaN;
		playerVelocity = new Vec3(playerVelocity.x, 0.0D, playerVelocity.z);
		Vec3 relative = velocity.subtract(playerVelocity);
		if (relative.lengthSqr() < 0.000001D || player.getCenter().subtract(position).dot(relative) <= 0.0D) return Double.NaN;
		AABB target = player.inflate(Math.max(0.0D, radius));
		Vec3 point = position;
		for (int tick = 0; tick < (int) (WARNING_SECONDS * 20); tick++) {
			if (fireball) velocity = velocity.add(velocity.normalize().scale(0.1D)).scale(0.95D);
			Vec3 next = point.add(velocity).subtract(playerVelocity);
			if (target.contains(point)) return tick / 20.0D;
			var hit = target.clip(point, next);
			if (clearFlight != null) {
				// Translate relative player-space geometry back to the projectile's actual world flight before tracing terrain.
				Vec3 motion = playerVelocity.scale(tick);
				Vec3 end = hit.orElse(next).add(playerVelocity.scale(tick + (hit.isPresent()
						? point.distanceTo(hit.get()) / Math.max(0.000001D, point.distanceTo(next)) : 1.0D)));
				if (!clearFlight.test(point.add(motion), end)) return Double.NaN;
			}
			if (hit.isPresent()) return (tick + point.distanceTo(hit.get()) / Math.max(0.000001D, point.distanceTo(next))) / 20.0D;
			point = next;
			if (!fireball) velocity = velocity.scale(0.99D).add(0.0D, -0.05D, 0.0D);
		}
		return Double.NaN;
	}

	public static JsonArray toJson(Snapshot snapshot) {
		if (snapshot.entries().isEmpty()) return null;
		JsonArray rows = new JsonArray();
		for (Entry entry : snapshot.entries()) {
			JsonObject row = new JsonObject();
			row.addProperty("uuid", entry.uuid()); row.addProperty("type", entry.type());
			row.addProperty("bearing", entry.bearing()); row.addProperty("etaSeconds", entry.etaSeconds());
			row.addProperty("damaging", entry.damaging());
			row.addProperty("shieldBlockable", entry.shieldBlockable());
			if (entry.fresh()) row.addProperty("new", true);
			if (entry.imminentFresh()) row.addProperty("imminentNew", true);
			rows.add(row);
		}
		return rows;
	}
}
