package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.agent.AgentId;
import dev.agaminggod.arenaagents.server.runtime.controller.HotbarWeapons;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Function;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.NeutralMob;
import net.minecraft.world.entity.boss.enderdragon.EnderDragon;
import net.minecraft.world.entity.boss.wither.WitherBoss;
import net.minecraft.world.entity.monster.Blaze;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.monster.Ghast;
import net.minecraft.world.entity.monster.Witch;
import net.minecraft.world.entity.animal.equine.Llama;
import net.minecraft.world.entity.monster.piglin.AbstractPiglin;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Server-sensed threats for the model: hostile mobs that target the agent, creepers that swell or come
 * within 5 blocks, and ranged mobs with a clear shot. These are awareness facts (a player hears and turns
 * toward them), so unlike the entity list they do not require the mob to be inside the view cone.
 * Signals are latched by {@link ThreatSignalLatch}; a new latched signal raises one urgent attention edge.
 * Players and calm creatures appear only after they hurt the agent ({@link #ATTACKED}, see {@link AggressionLedger}).
 * Each entry carries an open-ended {@link RiskModel} score with its factors and the expected hit after the agent's
 * defenses; entries are reported highest risk first. Risk is a snapshot dominated by distance, so each entry also
 * carries its trend: closing speed, whether it approaches, seconds until it reaches contact range (melee reach, or the
 * 3 blocks at which a creeper lights its fuse) and the risk it will carry there. A hunter that will arrive within
 * {@link #IMMINENT_SECONDS} raises {@link #IMMINENT}, one more urgent edge between first sighting and contact. It is raised
 * when contact is within that window, including a hunter first seen already close.
 * The model chooses what to do with them.
 */
public final class ThreatPerception {
	public static final double RANGE = 16.0D;
	/** A latched threat is kept while it stays alive within this range, so pacing at 16 blocks cannot re-raise it. */
	public static final double RELEASE_RANGE = 20.0D;
	public static final double CREEPER_CLOSE = 5.0D;
	public static final int MAX_ENTRIES = 8;
	public static final String TARGETING = "targeting";
	public static final String SWELLING = "swelling";
	public static final String CREEPER_CLOSE_SIGNAL = "creeper_close";
	public static final String RANGED_SIGHT = "ranged_sight";
	/** A targeting ranged mob in sight that is drawing its bow or loading its crossbow at the agent. */
	public static final String RANGED_AIMING = "ranged_aiming";
	/** Anyone (player, neutral or hostile mob) that hurt the agent within {@link AggressionLedger#ACTIVE_TICKS}. */
	public static final String ATTACKED = "attacked";
	/** A melee hunter or a creeper that will reach contact range within {@link #IMMINENT_SECONDS} at its closing speed. */
	public static final String IMMINENT = "imminent";
	/** Every signal this class can emit; the coordinator's protocol schema must accept exactly these. */
	public static final List<String> SIGNALS = List.of(TARGETING, SWELLING, CREEPER_CLOSE_SIGNAL, RANGED_SIGHT, RANGED_AIMING, ATTACKED, IMMINENT);
	public static final double IMMINENT_SECONDS = 3.0D;
	/** Closing faster than this (blocks per second) counts as approaching; slower is pacing or standing still. */
	public static final double APPROACH_SPEED = 0.3D;
	/** Vanilla's SwellGoal lights a creeper's fuse once its target is inside 3 blocks. */
	public static final double CREEPER_CONTACT = 3.0D;
	/** About where a hunting melee mob starts landing hits on a player. */
	public static final double MELEE_CONTACT = 2.0D;
	private static final double TICKS_PER_SECOND = 20.0D;

	public record Entry(String uuid, String type, double distance, double bearing, boolean targeting,
			boolean swelling, boolean lineOfSight, List<String> signals, double risk, Map<String, Double> riskFactors,
			double expectedHitDamage, Trend trend, double contactRisk, double dy, String holding, boolean targetable,
			String shot) {
		public Entry(String uuid, String type, double distance, double bearing, boolean targeting,
				boolean swelling, boolean lineOfSight, List<String> signals, double risk, Map<String, Double> riskFactors,
				double expectedHitDamage, Trend trend, double contactRisk, double dy, String holding, boolean targetable) {
			this(uuid, type, distance, bearing, targeting, swelling, lineOfSight, signals, risk, riskFactors, expectedHitDamage,
					trend, contactRisk, dy, holding, targetable, null);
		}
		public Entry(String uuid, String type, double distance, double bearing, boolean targeting,
				boolean swelling, boolean lineOfSight, List<String> signals, double risk, Map<String, Double> riskFactors,
				double expectedHitDamage, Trend trend, double contactRisk, double dy, String holding) {
			this(uuid, type, distance, bearing, targeting, swelling, lineOfSight, signals, risk, riskFactors, expectedHitDamage,
					trend, contactRisk, dy, holding, Double.isFinite(dy));
		}
		public Entry(String uuid, String type, double distance, double bearing, boolean targeting,
				boolean swelling, boolean lineOfSight, List<String> signals, double risk, Map<String, Double> riskFactors,
				double expectedHitDamage, Trend trend, double contactRisk) {
			this(uuid, type, distance, bearing, targeting, swelling, lineOfSight, signals, risk, riskFactors, expectedHitDamage,
					trend, contactRisk, Double.NaN, null);
		}

		public Entry(String uuid, String type, double distance, double bearing, boolean targeting,
				boolean swelling, boolean lineOfSight, List<String> signals, double risk, Map<String, Double> riskFactors,
				double expectedHitDamage) {
			this(uuid, type, distance, bearing, targeting, swelling, lineOfSight, signals, risk, riskFactors, expectedHitDamage,
					Trend.NONE, Double.NaN);
		}

		public Entry(String uuid, String type, double distance, double bearing, boolean targeting,
				boolean swelling, boolean lineOfSight, List<String> signals) {
			this(uuid, type, distance, bearing, targeting, swelling, lineOfSight, signals, 0.0D, Map.of(), 0.0D);
		}
	}

	/**
	 * How a threat moves relative to the agent. closingSpeed is blocks per second along the line between them
	 * (positive approaches, negative recedes); etaSeconds is NaN unless it approaches toward a contact range
	 * (ranged attackers have none because their attacks keep distance).
	 */
	public record Trend(double closingSpeed, boolean approaching, double contactRange, double etaSeconds) {
		public static final Trend NONE = new Trend(0.0D, false, Double.NaN, Double.NaN);
	}

	public record Snapshot(List<Entry> entries, Set<String> signalKeys, int bestWeaponSlot, String bestWeaponItemId) {
		static final Snapshot EMPTY = new Snapshot(List.of(), Set.of(), -1, null);
	}

	private record Tracked(long tick, Snapshot snapshot) {
	}

	private final Map<AgentId, ThreatSignalLatch> latches = new HashMap<>();
	// Threat signals ("uuid.signal") the coordinator has received as attention facts; absent until the first delivery.
	private final Map<AgentId, Set<String>> announced = new HashMap<>();
	private final Map<AgentId, Tracked> latest = new HashMap<>();

	/** Samples once per game tick per agent; repeated calls in the same tick return the same snapshot. */
	public synchronized Snapshot sample(AgentId agentId, ServerPlayer agent) {
		Objects.requireNonNull(agentId, "agentId must not be null");
		long tick = agent.level().getGameTime();
		Tracked tracked = latest.get(agentId);
		if (tracked != null && tracked.tick() == tick) return tracked.snapshot();
		Snapshot snapshot = scan(agentId, agent, tick);
		latest.put(agentId, new Tracked(tick, snapshot));
		return snapshot;
	}

	public synchronized void forget(AgentId agentId) {
		latches.remove(agentId);
		latest.remove(agentId);
		announced.remove(agentId);
	}

	public synchronized void retain(Set<AgentId> agents) {
		latches.keySet().retainAll(agents);
		latest.keySet().retainAll(agents);
		announced.keySet().retainAll(agents);
	}

	/**
	 * Records which signals ("uuid.signal") the last delivered observation announced, or null for none known. A threat
	 * with a signal not yet announced takes a row so its attention fact always names a threat the model can see.
	 */
	public synchronized void acknowledge(AgentId agentId, Set<String> delivered) {
		if (delivered == null) announced.remove(agentId);
		else announced.put(agentId, Set.copyOf(delivered));
	}

	/** True for a hostile the agent can sense as a threat even outside its view cone (used by fight/flee). */
	public static boolean isSensedThreat(ServerPlayer agent, Entity entity) {
		if (!(entity instanceof LivingEntity living) || !living.isAlive() || entity == agent) return false;
		if (agent.distanceTo(living) > RANGE) return false;
		// Players and other non-hostile attackers count only while they actively attack the agent.
		if (RiskAssessment.attackedRecently(agent, living)) return true;
		if (!(entity instanceof Mob mob) || !isHostileTo(mob, agent)) return false;
		return mob.getTarget() == agent || agent.getLastHurtByMob() == mob || mob.getSensing().hasLineOfSight(agent);
	}

	/**
	 * An active threat for fight follow-through, flee steering and target policies: a hostile mob by the existing
	 * rule, or anyone (players included) that hurt the agent within the last 30 seconds.
	 */
	public static boolean isActiveThreat(ServerPlayer agent, LivingEntity entity) {
		if (!entity.isAlive() || entity.isDeadOrDying() || entity == agent) return false;
		if (!RiskAssessment.isRiskablePlayer(entity)) return false;
		if (entity instanceof Mob mob && isHostileTo(mob, agent)) return true;
		return RiskAssessment.attackedRecently(agent, entity);
	}

	/**
	 * Neutral mobs (endermen, zombified piglins, piglins that tolerate gold armour, wolves, bees...) only count
	 * as hostile once they target this agent; attacking a calm one would start a fight the model did not want.
	 */
	public static boolean isNeutral(Mob mob) {
		return mob instanceof NeutralMob || mob instanceof AbstractPiglin;
	}

	public static boolean isHostileTo(Mob mob, ServerPlayer agent) {
		return mob instanceof Enemy && (!isNeutral(mob) || mob.getTarget() == agent);
	}

	/**
	 * The signals one mob raises right now. Pure so the rules verify without a server: neutral mobs signal only
	 * while targeting the agent, and a close creeper counts only when it can see or is hunting the agent
	 * (one behind a wall cannot reach it).
	 */
	static List<String> signals(boolean neutral, boolean targeting, boolean creeper, boolean swelling, boolean ranged,
			boolean sight, double distance) {
		return signals(neutral, targeting, creeper, swelling, ranged, sight, distance, false);
	}

	/** As above, plus {@link #ATTACKED} for anyone that hurt the agent recently (the only signal a player raises). */
	static List<String> signals(boolean neutral, boolean targeting, boolean creeper, boolean swelling, boolean ranged,
			boolean sight, double distance, boolean attacked) {
		return signals(neutral, targeting, creeper, swelling, ranged, sight, distance, attacked, Double.NaN);
	}

	/**
	 * As above, plus {@link #IMMINENT} for a melee hunter (or a creeper that sees the agent) due at contact range
	 * within {@link #IMMINENT_SECONDS}; {@code etaSeconds} is NaN when it is not approaching.
	 */
	static List<String> signals(boolean neutral, boolean targeting, boolean creeper, boolean swelling, boolean ranged,
			boolean sight, double distance, boolean attacked, double etaSeconds) {
		return signals(neutral, targeting, creeper, swelling, ranged, sight, distance, attacked, etaSeconds, false);
	}

	static List<String> signals(boolean neutral, boolean targeting, boolean creeper, boolean swelling, boolean ranged,
			boolean sight, double distance, boolean attacked, double etaSeconds, boolean aiming) {
		List<String> signals = new ArrayList<>(6);
		if (distance > RANGE) return signals;
		if (!neutral || targeting) {
			if (targeting) signals.add(TARGETING);
			if (swelling) signals.add(SWELLING);
			if (creeper && distance <= CREEPER_CLOSE && (sight || targeting)) signals.add(CREEPER_CLOSE_SIGNAL);
			if (ranged && sight) signals.add(RANGED_SIGHT);
			if (ranged && sight && targeting && aiming) signals.add(RANGED_AIMING);
			if ((targeting || (creeper && sight)) && etaSeconds <= IMMINENT_SECONDS) signals.add(IMMINENT);
		}
		// attacked never duplicates another signal for the same creature.
		if (attacked && signals.isEmpty()) signals.add(ATTACKED);
		return signals;
	}

	/**
	 * Horizontal closing speed in blocks per second from both velocities (blocks per tick), projected on the line from
	 * the threat to the agent. Pure so it verifies without a server; vertical motion is left out because gravity's
	 * constant pull on grounded bodies would read as motion.
	 */
	static double closingSpeed(double agentX, double agentZ, double agentVelX, double agentVelZ,
			double threatX, double threatZ, double threatVelX, double threatVelZ) {
		double dx = agentX - threatX;
		double dz = agentZ - threatZ;
		double length = Math.hypot(dx, dz);
		if (!(length > 1.0E-6D)) return 0.0D;
		double closingPerTick = ((threatVelX - agentVelX) * dx + (threatVelZ - agentVelZ) * dz) / length;
		return Double.isFinite(closingPerTick) ? closingPerTick * TICKS_PER_SECOND : 0.0D;
	}

	/** Trend facts for one threat; see {@link Trend}. A body already at contact range has an ETA of 0. */
	static Trend trend(double distance, double closingSpeed, boolean creeper, boolean ranged) {
		double speed = Double.isFinite(closingSpeed) ? closingSpeed : 0.0D;
		boolean approaching = speed >= APPROACH_SPEED;
		// Ranged attackers keep distance; relative approach is not a prediction of melee contact.
		double contact = ranged ? Double.NaN : creeper ? CREEPER_CONTACT : MELEE_CONTACT;
		boolean contactApproach = approaching;
		double eta = !Double.isFinite(contact) ? Double.NaN
				: distance <= contact ? 0.0D : contactApproach ? (distance - contact) / speed : Double.NaN;
		return new Trend(round(speed), approaching, contact, Double.isFinite(eta) ? round(eta) : Double.NaN);
	}

	private Snapshot scan(AgentId agentId, ServerPlayer agent, long tick) {
		// Hostile mobs, neutral mobs already targeting the agent (a provoked wolf, bee or golem before its first hit),
		// plus any creature or player that hurt the agent recently. Players are otherwise only potential risks
		// (entity rows) and never appear here just for being near or armed.
		boolean anyAttackers = AggressionLedger.server().hasAttackers(agent.getUUID(), tick);
		ThreatSignalLatch held = latches.get(agentId);
		List<LivingEntity> candidates = agent.level().getEntitiesOfClass(LivingEntity.class, agent.getBoundingBox().inflate(RELEASE_RANGE),
				entity -> entity != agent && entity.isAlive() && !(entity instanceof EnderDragon) && !(entity instanceof WitherBoss)
						&& (scanCandidate(entity instanceof Enemy, entity instanceof Mob mob && mob.getTarget() == agent,
								anyAttackers && RiskAssessment.attackedRecently(agent, entity))
								// A latched neutral that briefly drops its target stays present so its signals debounce.
								|| held != null && held.tracks(entity.getUUID().toString())));
		Set<String> raw = new HashSet<>();
		Set<String> present = new HashSet<>();
		Map<String, LivingEntity> byId = new HashMap<>();
		Map<String, double[]> geometry = new HashMap<>();
		Map<String, boolean[]> flags = new HashMap<>();
		Map<String, Trend> trends = new HashMap<>();
		Vec3 agentVelocity = agent.getDeltaMovement();
		for (LivingEntity entity : candidates) {
			double distance = agent.distanceTo(entity);
			if (distance > RELEASE_RANGE) continue;
			String id = entity.getUUID().toString();
			boolean attacked = anyAttackers && RiskAssessment.attackedRecently(agent, entity);
			Mob mob = entity instanceof Mob value ? value : null;
			boolean targeting = mob != null && mob.getTarget() == agent;
			boolean creeper = entity instanceof Creeper;
			boolean swelling = creeper && ((Creeper) entity).getSwellDir() > 0;
			boolean ranged = mob != null && isRanged(mob);
			// The mob's own sensing caches line of sight for this tick (its AI asks the same question).
			boolean sight = distance <= RANGE && (mob != null
					? (targeting || creeper || ranged) && mob.getSensing().hasLineOfSight(agent)
					: attacked && agent.hasLineOfSight(entity));
			present.add(id);
			byId.put(id, entity);
			geometry.put(id, new double[] {distance, bearing(agent, entity), entity.getY() - agent.getY()});
			flags.put(id, new boolean[] {targeting, swelling, sight});
			// A player's server-side delta is not its walking motion; its known speed is (as in RiskAssessment).
			Vec3 velocity = entity instanceof Player ? entity.getKnownSpeed() : entity.getDeltaMovement();
			Trend trend = trend(distance, closingSpeed(agent.getX(), agent.getZ(), agentVelocity.x, agentVelocity.z,
					entity.getX(), entity.getZ(), velocity.x, velocity.z), creeper, ranged);
			trends.put(id, trend);
			boolean neutral = mob == null || isNeutral(mob) || !(entity instanceof Enemy);
			// attacked is only for players and neutral or passive creatures; a hostile mob's hit is already damage attention.
			for (String signal : signals(neutral, targeting, creeper, swelling, ranged, sight, distance, attacked && neutral,
					trend.etaSeconds(), isAiming(entity))) {
				raw.add(ThreatSignalLatch.key(id, signal));
			}
		}
		ThreatSignalLatch latch = latches.computeIfAbsent(agentId, ignored -> new ThreatSignalLatch());
		Set<String> latched = latch.update(raw, present, tick);
		Map<String, Long> firstSeen = new HashMap<>();
		Map<String, List<String>> signals = new HashMap<>();
		for (String key : latched) {
			signals.computeIfAbsent(ThreatSignalLatch.threatId(key), ignored -> new ArrayList<>()).add(ThreatSignalLatch.signal(key));
			firstSeen.merge(ThreatSignalLatch.threatId(key), latch.firstSeen(key), Math::min);
		}
		if (signals.isEmpty()) return Snapshot.EMPTY;
		// With more than 8 threats, report the most urgent first (a swelling creeper, an imminent hit), then the 8
		// latched first. A distance cut would reshuffle as mobs move and every reshuffle would look like a new signal;
		// this order only changes when a threat clears or its latched urgency changes. Urgency is read from the latched
		// signals, so a creeper that stops swelling keeps its rank for the hold window and then yields to a live one.
		// Risk is assessed only for the kept threats, after the cut, to keep the per-tick cost bounded.
		Map<String, Integer> urgencies = new HashMap<>();
		for (Map.Entry<String, List<String>> entry : signals.entrySet()) urgencies.put(entry.getKey(), urgency(entry.getValue()));
		Set<String> known = announced.get(agentId);
		Set<String> unannounced = new HashSet<>();
		if (known != null) for (String key : latched) {
			if (!known.contains(ThreatSignalLatch.threatId(key) + "." + ThreatSignalLatch.signal(key))) unannounced.add(ThreatSignalLatch.threatId(key));
		}
		List<String> kept = selectThreatIds(urgencies, firstSeen, unannounced);
		List<Entry> limited = new ArrayList<>(kept.size());
		ObservationVisibility.Frame view = null;
		for (String id : kept) {
			LivingEntity entity = byId.get(id);
			double[] where = geometry.get(id);
			boolean[] state = flags.get(id);
			// Height and held weapon are things the eye sees: only for a threat in the observer's view now. Distance and
			// bearing stay (heard, felt); visibility uses the observer's eye, not the mob's own line of sight.
			if (view == null) view = ObservationVisibility.frame(agent.level(), agent);
			boolean seen = view.canSeeEntity(entity);
			RiskAssessment.Assessment assessment = RiskAssessment.assess(agent, entity);
			Trend trend = trends.get(id);
			// Only an approaching body still outside contact range has a different "risk at contact" worth reporting.
			double contactRisk = Double.isFinite(trend.etaSeconds()) && Double.isFinite(trend.contactRange()) && where[0] > trend.contactRange()
					? RiskAssessment.contactRisk(agent, entity, trend.contactRange()) : Double.NaN;
			limited.add(new Entry(id, BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString(),
					round(where[0]), round(where[1]), state[0], state[1], state[2], List.copyOf(signals.get(id)),
					assessment.risk(), assessment.model().factors(), assessment.hit().damage(), trend, contactRisk,
					seen ? round(where[2]) : Double.NaN, seen ? rangedWeaponId(entity) : null, seen || isSensedThreat(agent, entity),
					seen ? shotLine(agent, entity) : null));
		}
		limited.sort(RISK_ORDER);
		int weaponSlot = HotbarWeapons.bestSlotOrNone(agent);
		ItemStack weapon = weaponSlot < 0 ? ItemStack.EMPTY : agent.getInventory().getItem(weaponSlot);
		// signalKeys is the full latched set, so forced delivery tracks real edges, not the output cut.
		return new Snapshot(List.copyOf(limited), Set.copyOf(latched), weaponSlot,
				weapon.isEmpty() ? null : BuiltInRegistries.ITEM.getKey(weapon.getItem()).toString());
	}

	/**
	 * Whether a player could see a line for a shot at a seen threat: "clear" when a straight line from the eye reaches its
	 * middle, the top of its box or its eye without crossing a block's collision shape (what stops an arrow), as a player
	 * aims at whatever part shows over a fence or slab; otherwise the id of the first block on the line to its middle.
	 */
	static String shotLine(ServerPlayer agent, Entity entity) {
		Vec3 eye = agent.getEyePosition();
		return shotLine(entity.getBoundingBox(), entity.getEyePosition(), aim -> {
			BlockHitResult hit = agent.level().clip(new ClipContext(eye, aim, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, agent));
			return hit.getType() == HitResult.Type.BLOCK
					? BuiltInRegistries.BLOCK.getKey(agent.level().getBlockState(hit.getBlockPos()).getBlock()).toString() : "clear";
		});
	}

	/** The shot verdict over the aim points (middle first); {@code firstBlockTo} names the first block on the eye line to a point, or "clear". */
	static String shotLine(AABB box, Vec3 mobEye, Function<Vec3, String> firstBlockTo) {
		Vec3 middle = box.getCenter();
		String blocked = firstBlockTo.apply(middle);
		if ("clear".equals(blocked)) return "clear";
		for (Vec3 aim : List.of(new Vec3(middle.x, box.maxY - 0.1D, middle.z), mobEye))
			if ("clear".equals(firstBlockTo.apply(aim))) return "clear";
		return blocked;
	}

	/** Whether a nearby living entity is a threat-scan candidate (the caller excludes bosses and the agent). */
	static boolean scanCandidate(boolean enemy, boolean targetingAgent, boolean attackedRecently) {
		return enemy || targetingAgent || attackedRecently;
	}

	/** The at most {@link #MAX_ENTRIES} threat ids to report: most urgent first, then first latched, then id. */
	static List<String> selectThreatIds(Map<String, Integer> urgencies, Map<String, Long> firstSeen) {
		return selectThreatIds(urgencies, firstSeen, Set.of());
	}

	/**
	 * As {@link #selectThreatIds(Map, Map)}, then each unreported threat carrying a signal not yet announced (most urgent
	 * first) replaces the least urgent kept row whose signals are all announced. The order changes only for new signals,
	 * which are attention anyway; once announced, the threat ranks as before.
	 */
	static List<String> selectThreatIds(Map<String, Integer> urgencies, Map<String, Long> firstSeen, Set<String> unannounced) {
		List<String> ranked = new ArrayList<>(urgencies.keySet());
		ranked.sort(Comparator.<String>comparingInt(id -> -urgencies.get(id))
				.thenComparingLong(firstSeen::get).thenComparing(Comparator.naturalOrder()));
		List<String> kept = new ArrayList<>(ranked.subList(0, Math.min(MAX_ENTRIES, ranked.size())));
		for (String id : ranked.subList(kept.size(), ranked.size())) {
			if (!unannounced.contains(id)) continue;
			int replaced = -1;
			for (int index = kept.size() - 1; index >= 0; index--) {
				if (!unannounced.contains(kept.get(index))) { replaced = index; break; }
			}
			if (replaced < 0) break;
			kept.remove(replaced);
			kept.add(id);
		}
		return List.copyOf(kept);
	}

	/** Selection urgency of a threat's latched signals: an exploding creeper outranks contact, which outranks sight. */
	static int urgency(List<String> signals) {
		int urgency = 0;
		for (String signal : signals) {
			urgency = Math.max(urgency, switch (signal) {
				case SWELLING -> 3;
				case CREEPER_CLOSE_SIGNAL, ATTACKED, IMMINENT, RANGED_AIMING -> 2;
				case TARGETING, RANGED_SIGHT -> 1;
				default -> 0;
			});
		}
		return urgency;
	}

	/** Highest risk first; equal risk falls back to nearest, then uuid, so the order is stable. */
	static final Comparator<Entry> RISK_ORDER = Comparator.comparingDouble(Entry::risk).reversed()
			.thenComparingDouble(Entry::distance).thenComparing(Entry::uuid);

	public static boolean isRanged(Mob mob) {
		// Weapon users depend on their held item; innate ranged attacks do not.
		return hasInnateRangedAttack(mob) || RiskAssessment.holdsRangedWeapon(mob);
	}

	private static boolean hasInnateRangedAttack(Mob mob) {
		return mob instanceof Blaze || mob instanceof Ghast || mob instanceof Witch || mob instanceof Llama
				|| mob instanceof WitherBoss;
	}

	private static boolean isAiming(LivingEntity entity) {
		return entity.isUsingItem()
				|| entity instanceof AbstractPiglin piglin
						&& (piglin.getArmPose() == net.minecraft.world.entity.monster.piglin.PiglinArmPose.CROSSBOW_CHARGE
								|| piglin.getArmPose() == net.minecraft.world.entity.monster.piglin.PiglinArmPose.CROSSBOW_HOLD)
				|| entity instanceof net.minecraft.world.entity.monster.illager.Pillager pillager && pillager.isChargingCrossbow();
	}

	/** The bow, crossbow or trident a threat visibly holds (either hand), or null: a player sees what a mob carries. */
	public static String rangedWeaponId(LivingEntity entity) {
		for (ItemStack held : new ItemStack[] {entity.getMainHandItem(), entity.getOffhandItem()}) {
			if (held.getItem() instanceof net.minecraft.world.item.BowItem || held.getItem() instanceof net.minecraft.world.item.CrossbowItem
					|| held.is(net.minecraft.world.item.Items.TRIDENT)) {
				return BuiltInRegistries.ITEM.getKey(held.getItem()).toString();
			}
		}
		return null;
	}

	/** Same convention as landmark bearings: degrees to turn from the current view, negative is left. */
	private static double bearing(ServerPlayer agent, Entity entity) {
		Vec3 delta = entity.position().subtract(agent.position());
		double yaw = Math.toDegrees(Math.atan2(-delta.x, delta.z));
		return Mth.wrapDegrees((float) (yaw - agent.getYRot()));
	}

	private static double round(double value) {
		return Math.round(value * 10.0D) / 10.0D;
	}

	/** Observation section, or null when nothing is threatening the agent (the field is then omitted). */
	public static JsonObject toJson(Snapshot snapshot) {
		if (snapshot.entries().isEmpty()) return null;
		JsonObject json = new JsonObject();
		JsonArray entries = new JsonArray();
		for (Entry entry : snapshot.entries()) {
			JsonObject value = new JsonObject();
			value.addProperty("uuid", entry.uuid());
			value.addProperty("type", entry.type());
			value.addProperty("distance", entry.distance());
			value.addProperty("bearing", entry.bearing());
			// Height above (+) or below (-) the agent's feet, and a held ranged weapon: melee reach and cover depend on both.
			if (Double.isFinite(entry.dy())) value.addProperty("dy", entry.dy());
			if (entry.holding() != null) value.addProperty("holding", entry.holding());
			// Seen threats only: "clear", or the first block a straight line from the eye to the threat's middle meets.
			if (entry.shot() != null) value.addProperty("shot", entry.shot());
			value.addProperty("targeting", entry.targeting());
			value.addProperty("swelling", entry.swelling());
			value.addProperty("lineOfSight", entry.lineOfSight());
			// Signals are latched; only eye-acquired height establishes a currently visible target.
			value.addProperty("visible", Double.isFinite(entry.dy()));
			// The same eligibility used by resolveCombatTarget, not a promise of a walkable route.
			value.addProperty("targetable", entry.targetable());
			JsonArray signals = new JsonArray();
			entry.signals().stream().sorted().forEach(signals::add);
			value.add("signals", signals);
			// riskFactors stay server-side: about 90 bytes per row that no reader used.
			value.addProperty("risk", entry.risk());
			value.addProperty("expectedHitDamage", entry.expectedHitDamage());
			value.addProperty("closingSpeed", entry.trend().closingSpeed());
			value.addProperty("approaching", entry.trend().approaching());
			if (Double.isFinite(entry.trend().etaSeconds())) value.addProperty("etaSeconds", entry.trend().etaSeconds());
			if (Double.isFinite(entry.contactRisk())) value.addProperty("contactRisk", entry.contactRisk());
			entries.add(value);
		}
		json.add("entries", entries);
		if (snapshot.bestWeaponSlot() >= 0) {
			JsonObject weapon = new JsonObject();
			weapon.addProperty("slot", snapshot.bestWeaponSlot());
			weapon.addProperty("itemId", snapshot.bestWeaponItemId());
			json.add("bestWeapon", weapon);
		}
		return json;
	}
}
