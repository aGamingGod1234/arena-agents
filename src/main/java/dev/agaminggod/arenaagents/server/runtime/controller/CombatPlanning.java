package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.LocalPathfinder;
import dev.agaminggod.arenaagents.client.navigation.TraversalType;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Pure decisions behind the model-chosen fight_target and flee_from actions. Nothing here reads the
 * world directly, so weapon choice, melee pacing, flee completion and flee steering verify without a server.
 * The model decides whether to fight or flee; these rules only make the chosen action effective.
 */
public final class CombatPlanning {
	/** Vanilla deals full melee damage near a full attack-strength charge; earlier clicks waste the swing. */
	public static final float READY_ATTACK_STRENGTH = 0.9F;
	/** Short step back after each hit, which also lets vanilla knockback open space before the next swing. */
	public static final int BACKOFF_TICKS = 4;
	public static final float BACKOFF_FORWARD = -0.6F;
	public static final double DEFAULT_FIGHT_RANGE = 2.5D;
	/** A flee only ends once the target has not gained ground over this window (half a second). */
	public static final int NOT_CLOSING_WINDOW_TICKS = 10;
	/** Ticks without targeting or sight before a chaser counts as having lost the agent. */
	public static final int LOST_TICKS = 20;

	static final int[] FLEE_OFFSETS = {0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180};
	private static final float STICKY_HEADING_DEGREES = 45.0F;
	/** More than any turn: a flee already beside a lava flow takes any heading out of its way first. */
	static final float LAVA_FLOW_PENALTY_DEGREES = 400.0F;

	private CombatPlanning() {
	}

	/** 3 sword, 2 axe or spear, 1 other tool or weapon (pickaxe, shovel, hoe, mace, trident), 0 not a weapon. */
	public static int weaponRank(boolean sword, boolean axeOrSpear, boolean otherWeapon) {
		if (sword) return 3;
		if (axeOrSpear) return 2;
		return otherWeapon ? 1 : 0;
	}

	public record WeaponCandidate(int slot, int rank, int maxDamage) {
		public WeaponCandidate {
			if (slot < 0 || slot > 8) throw new IllegalArgumentException("slot must be a hotbar slot");
		}
	}

	/**
	 * Best hotbar weapon: highest rank, then the most durable (a proxy for tier: wood < stone < iron < diamond),
	 * then the current slot so an equal choice never causes a visible swap. With no weapon the current slot stays.
	 */
	public static int bestWeaponSlot(List<WeaponCandidate> hotbar, int currentSlot) {
		Objects.requireNonNull(hotbar, "hotbar must not be null");
		WeaponCandidate best = null;
		for (WeaponCandidate candidate : hotbar) {
			if (candidate.rank() <= 0) continue;
			if (best == null || compare(candidate, best, currentSlot) > 0) best = candidate;
		}
		return best == null ? currentSlot : best.slot();
	}

	private static int compare(WeaponCandidate left, WeaponCandidate right, int currentSlot) {
		if (left.rank() != right.rank()) return Integer.compare(left.rank(), right.rank());
		if (left.maxDamage() != right.maxDamage()) return Integer.compare(left.maxDamage(), right.maxDamage());
		return Boolean.compare(left.slot() == currentSlot, right.slot() == currentSlot);
	}

	public record FightInput(
			double distance,
			double desiredRange,
			boolean inReach,
			boolean aimed,
			boolean lineOfSight,
			float attackStrength,
			boolean weaponReady,
			int backoffTicks
	) {
	}

	public record FightStep(float forward, boolean sprint, boolean attack, int backoffTicks) {
	}

	/** One melee tick: back off after a hit, swing only at a full charge, otherwise close to (or hold) range. */
	public static FightStep fightStep(FightInput input) {
		Objects.requireNonNull(input, "input must not be null");
		if (input.backoffTicks() > 0) return new FightStep(BACKOFF_FORWARD, false, false, input.backoffTicks() - 1);
		if (input.inReach() && input.aimed() && input.lineOfSight() && input.weaponReady()
				&& input.attackStrength() >= READY_ATTACK_STRENGTH) {
			return new FightStep(0.0F, false, true, BACKOFF_TICKS);
		}
		if (!input.inReach() || input.distance() > input.desiredRange()) {
			return new FightStep(1.0F, input.distance() > input.desiredRange() + 3.0D, false, 0);
		}
		// Too close lets the target body-block and hit first; a slight retreat keeps it at the edge of reach.
		if (input.distance() < input.desiredRange() - 1.0D) return new FightStep(-0.4F, false, false, 0);
		return new FightStep(0.0F, false, false, 0);
	}

	/**
	 * The fight-level "no hit and no ground gained" clock behind TARGET_UNREACHABLE. A live policy switch keeps it
	 * running (alternating between two unreachable attackers used to restart it every switch); a hit, a kill, ground
	 * gained on the current target or progress along the approach route resets it.
	 */
	public static final class ProgressClock {
		/** Getting this much closer to the current target counts as ground gained. */
		static final double GAIN_BLOCKS = 0.5D;
		private double closest = Double.MAX_VALUE;
		private int ticks;

		/** One approach tick at this distance; returns the ticks without progress so far. */
		public int observe(double distance) {
			if (distance < closest - GAIN_BLOCKS) {
				closest = distance;
				ticks = 0;
			} else {
				ticks++;
			}
			return ticks;
		}

		/** A landed hit, a kill (follow-through starts fresh) or a step along the route. */
		public void progressed() {
			ticks = 0;
		}

		public void killed() {
			ticks = 0;
			closest = Double.MAX_VALUE;
		}

		/** A policy switch: the new target's current distance is the baseline, and the clock keeps running. */
		public void switched(double distanceToNewTarget) {
			closest = distanceToNewTarget;
		}

		public int ticks() {
			return ticks;
		}
	}

	/** A model-chosen bail-out threshold; absent means fight until the target is dead, gone or time runs out. */
	public static boolean shouldBailOut(float health, Float fleeAtHealth) {
		return fleeAtHealth != null && health <= fleeAtHealth;
	}

	/** Follow-through and multi-threat flee consider hostiles within the threat-sensing range. */
	public static final double THREAT_RANGE = 16.0D;
	/** A flee never reports escape while a creeper is this close: its blast reaches about 6 blocks. */
	public static final double CREEPER_SAFE_DISTANCE = 7.0D;

	/** One hostile near the agent when the chosen fight target dies. */
	public record AttackerCandidate(double distance, boolean targetingAgent, boolean hurtAgent, boolean creeper) {
	}

	/**
	 * The model's fight_target continues (unless it opted out) to the nearest hostile that is targeting or just
	 * hurt the agent. Only mobs already attacking the agent qualify, so follow-through never starts a new fight.
	 * Creepers are never chased into melee; they are reported back so the model chooses fight or flee itself.
	 * Returns the candidate index, or -1 when nobody else is attacking.
	 */
	public static int nextAttacker(List<AttackerCandidate> candidates) {
		Objects.requireNonNull(candidates, "candidates must not be null");
		int best = -1;
		for (int index = 0; index < candidates.size(); index++) {
			AttackerCandidate candidate = candidates.get(index);
			if (candidate.creeper() || !(candidate.targetingAgent() || candidate.hurtAgent())) continue;
			if (!(candidate.distance() <= THREAT_RANGE)) continue;
			if (best < 0 || candidate.distance() < candidates.get(best).distance()) best = index;
		}
		return best;
	}

	/**
	 * Model-chosen fight_target targeting policy. The model picks it; the controller only applies it live.
	 * named: fight the given target (then follow-through, if enabled). highest_risk: keep switching to the attacker
	 * with the highest risk score. nearest_attacker: keep switching to the nearest attacker. Only mobs or players
	 * already attacking the agent qualify and creepers are never chosen, so a policy never starts a new fight.
	 */
	public enum TargetPolicy {
		NAMED("named"), HIGHEST_RISK("highest_risk"), NEAREST_ATTACKER("nearest_attacker");

		private final String wireName;

		TargetPolicy(String wireName) {
			this.wireName = wireName;
		}

		public String wireName() {
			return wireName;
		}

		public static TargetPolicy parse(String value) {
			if (value == null) return NAMED;
			for (TargetPolicy policy : values()) if (policy.wireName.equals(value)) return policy;
			throw new IllegalArgumentException("unknown targetPolicy " + value);
		}
	}

	/** Policies are re-evaluated twice a second. */
	/**
	 * Whether a fight goes on to another attacker once its named target is dead or gone: only on the model's opt-in,
	 * continueWithAttackers:true or a targetPolicy (its own rule for choosing among attackers). An explicit
	 * continueWithAttackers always wins; omitted with no policy, the fight ends with its target.
	 */
	public static boolean followThrough(Boolean continueWithAttackers, TargetPolicy policy) {
		return continueWithAttackers != null ? continueWithAttackers : policy != TargetPolicy.NAMED;
	}

	public static final int POLICY_INTERVAL_TICKS = 10;
	/** Hysteresis: stay on a target at least 1.5 s before a policy may switch away from it. */
	public static final int POLICY_MIN_DWELL_TICKS = 30;
	/** Hysteresis: highest_risk switches only to a clearly riskier attacker (25% and 5 points more). */
	public static final double RISK_SWITCH_RATIO = 1.25D;
	public static final double RISK_SWITCH_MARGIN = 5.0D;
	/** Hysteresis: nearest_attacker switches only to an attacker at least 2 blocks nearer. */
	public static final double NEAREST_SWITCH_MARGIN = 2.0D;

	/** One fight candidate for a target policy; attacking means targeting or recently hurting the agent. */
	public record PolicyCandidate(double distance, double risk, boolean attacking, boolean creeper) {
	}

	/** Players (other agents included) are switch candidates only when the model passed includePlayers:true. */
	public static boolean switchableKind(boolean player, boolean includePlayers) {
		return !player || includePlayers;
	}

	static boolean policyEligible(PolicyCandidate candidate) {
		return candidate.attacking() && !candidate.creeper() && candidate.distance() <= THREAT_RANGE;
	}

	/**
	 * The candidate index a live policy switches to, or -1 to keep the current target. {@code current} is the
	 * current target's own facts (null when it is gone, which skips the dwell and margin checks).
	 */
	public static int policyRetarget(TargetPolicy policy, PolicyCandidate current, List<PolicyCandidate> others, int ticksOnTarget) {
		Objects.requireNonNull(policy, "policy must not be null");
		Objects.requireNonNull(others, "others must not be null");
		if (policy == TargetPolicy.NAMED) return -1;
		if (current != null && ticksOnTarget < POLICY_MIN_DWELL_TICKS) return -1;
		int best = -1;
		for (int index = 0; index < others.size(); index++) {
			PolicyCandidate candidate = others.get(index);
			if (!policyEligible(candidate)) continue;
			if (best < 0) {
				best = index;
				continue;
			}
			PolicyCandidate leader = others.get(best);
			boolean better = policy == TargetPolicy.HIGHEST_RISK
					? candidate.risk() > leader.risk() || (candidate.risk() == leader.risk() && candidate.distance() < leader.distance())
					: candidate.distance() < leader.distance();
			if (better) best = index;
		}
		if (best < 0 || current == null) return best;
		PolicyCandidate leader = others.get(best);
		boolean clearlyBetter = policy == TargetPolicy.HIGHEST_RISK
				? leader.risk() > current.risk() * RISK_SWITCH_RATIO + RISK_SWITCH_MARGIN
				: leader.distance() < current.distance() - NEAREST_SWITCH_MARGIN;
		return clearlyBetter ? best : -1;
	}

	/**
	 * One threat during a flee. dx/dz point from the agent to the threat; closing means it gained ground over
	 * the last half second (or has not been watched that long yet).
	 */
	public record FleeThreat(double dx, double dz, double distance, boolean creeper, boolean swelling, boolean closing) {
	}

	/** Nearer threats push harder; a creeper weighs three times a zombie and a swelling one six times. */
	static double fleeWeight(FleeThreat threat) {
		double type = threat.swelling() ? 6.0D : threat.creeper() ? 3.0D : 1.0D;
		return type / Math.max(1.0D, threat.distance());
	}

	/**
	 * Direction away from every threat at once: the proximity-weighted sum of "away" unit vectors. When the
	 * pushes cancel out (surrounded evenly) it falls back to straight away from the heaviest threat. Null when
	 * there is no horizontal "away" at all (every threat directly above or below).
	 */
	public static Float fleeAwayYaw(List<FleeThreat> threats) {
		Objects.requireNonNull(threats, "threats must not be null");
		double sumX = 0.0D;
		double sumZ = 0.0D;
		FleeThreat heaviest = null;
		for (FleeThreat threat : threats) {
			double length = Math.sqrt(threat.dx() * threat.dx() + threat.dz() * threat.dz());
			if (length < 1.0E-2D) continue;
			double weight = fleeWeight(threat);
			sumX -= threat.dx() / length * weight;
			sumZ -= threat.dz() / length * weight;
			if (heaviest == null || weight > fleeWeight(heaviest)) heaviest = threat;
		}
		if (heaviest == null) return null;
		if (sumX * sumX + sumZ * sumZ < 1.0E-6D) return yawToward(heaviest.dx(), heaviest.dz(), 0.0D, 0.0D);
		return yawToward(0.0D, 0.0D, sumX, sumZ);
	}

	/**
	 * The nearest threat (other than the named one) that still blocks an escape: any creeper within
	 * {@link #CREEPER_SAFE_DISTANCE}, or a threat inside the requested distance that is still closing in.
	 * Returns its index, or -1 when the flee may report success.
	 */
	public static int escapeBlocker(List<FleeThreat> others, double requestedDistance) {
		Objects.requireNonNull(others, "others must not be null");
		int blocker = -1;
		for (int index = 0; index < others.size(); index++) {
			FleeThreat threat = others.get(index);
			boolean blocks = (threat.creeper() && threat.distance() < CREEPER_SAFE_DISTANCE)
					|| (threat.distance() < requestedDistance && threat.closing());
			if (blocks && (blocker < 0 || threat.distance() < others.get(blocker).distance())) blocker = index;
		}
		return blocker;
	}

	/** Per-threat "is it closing in" over the same half-second window the named flee target uses. */
	public static final class ClosingTracker {
		private final Map<String, double[]> windows = new HashMap<>();
		private final Map<String, Integer> samples = new HashMap<>();

		/** True while the threat gained ground over the window, or has not been watched for a full window. */
		public boolean observe(String id, double distance) {
			Objects.requireNonNull(id, "id must not be null");
			double[] window = windows.computeIfAbsent(id, ignored -> new double[NOT_CLOSING_WINDOW_TICKS + 1]);
			int count = samples.getOrDefault(id, 0);
			double windowStart = window[count % window.length];
			boolean full = count >= window.length;
			window[count % window.length] = distance;
			samples.put(id, count + 1);
			return !full || distance < windowStart - 0.05D;
		}

		/** Forgets threats no longer present so a returning mob is watched afresh. */
		public void retain(Set<String> present) {
			windows.keySet().retainAll(present);
			samples.keySet().retainAll(present);
		}
	}

	/** Tracks one flee so it ends on safety, not on reaching a waypoint. */
	public static final class FleeProgress {
		public enum Outcome { RUNNING, ESCAPED, LOST }

		private final double requestedDistance;
		private final double[] window = new double[NOT_CLOSING_WINDOW_TICKS + 1];
		private int samples;
		private int lostTicks;

		public FleeProgress(double requestedDistance) {
			if (!Double.isFinite(requestedDistance) || requestedDistance <= 0.0D) {
				throw new IllegalArgumentException("requestedDistance must be positive");
			}
			this.requestedDistance = requestedDistance;
		}

		/**
		 * Escaped means at least the requested distance away and the target has not closed in over the last
		 * half second. Lost means a chaser stopped targeting the agent and has no sight of it for a second
		 * while at least half the distance away.
		 */
		public Outcome observe(double distance, boolean targetStillHunting) {
			if (!Double.isFinite(distance)) throw new IllegalArgumentException("distance must be finite");
			double windowStart = window[samples % window.length];
			boolean full = samples >= window.length;
			window[samples % window.length] = distance;
			samples++;
			if (distance >= requestedDistance && full && distance >= windowStart - 0.05D) return Outcome.ESCAPED;
			lostTicks = !targetStillHunting && distance >= requestedDistance * 0.5D ? lostTicks + 1 : 0;
			return lostTicks >= LOST_TICKS ? Outcome.LOST : Outcome.RUNNING;
		}
	}

	public record Heading(float yaw, boolean jump, boolean clear) {
	}

	/**
	 * Picks a flee heading: straight away from the target when the next two cells are walkable, otherwise
	 * the nearest detour (30 degree steps), never into hazards or drops deeper than three blocks (no fall damage). The previous
	 * heading wins while it is still walkable and within 45 degrees of "away", which stops left/right dithering.
	 */
	public static Heading fleeHeading(WalkabilityView world, GridPosition feet, float awayYaw, Float previousYaw) {
		Objects.requireNonNull(world, "world must not be null");
		Objects.requireNonNull(feet, "feet must not be null");
		return fleeHeading(world, feet, awayYaw, previousYaw, SwimPlanning.WATER_PENALTY_DEGREES);
	}

	/**
	 * As {@link #fleeHeading(WalkabilityView, GridPosition, float, Float)} with deep water costed, not blocked: each
	 * candidate costs its offset from "away" plus {@code waterPenaltyDegrees} when the next two cells cross deep water,
	 * so a land escape wins whenever one exists nearby and the flee only swims when water is clearly the best way out.
	 * Once already swimming every heading is water and the cheapest (straightest, or a shore) wins.
	 */
	public static Heading fleeHeading(WalkabilityView world, GridPosition feet, float awayYaw, Float previousYaw,
			float waterPenaltyDegrees) {
		return fleeHeading(world, feet, awayYaw, previousYaw, waterPenaltyDegrees, Margin.NONE);
	}

	/** As above, with the knockback margin applied to every candidate heading (see {@link Margin}). */
	public static Heading fleeHeading(WalkabilityView world, GridPosition feet, float awayYaw, Float previousYaw,
			float waterPenaltyDegrees, Margin margin) {
		return fleeHeading(world, feet, awayYaw, previousYaw, waterPenaltyDegrees, margin, List.of());
	}

	/** A heading physically stalled at this spot is excluded until the body makes ground. */
	static Heading fleeHeading(WalkabilityView world, GridPosition feet, float awayYaw, Float previousYaw,
			float waterPenaltyDegrees, Margin margin, List<Float> stalledHeadings) {
		Objects.requireNonNull(world, "world must not be null");
		Objects.requireNonNull(feet, "feet must not be null");
		Objects.requireNonNull(margin, "margin must not be null");
		Heading best = null;
		float bestCost = Float.POSITIVE_INFINITY;
		if (previousYaw != null && !stalledHeading(previousYaw, stalledHeadings) && Math.abs(wrap(previousYaw - awayYaw)) <= STICKY_HEADING_DEGREES) {
			Probe sticky = probe(world, feet, previousYaw, margin);
			if (sticky.passable() && !sticky.water() && !sticky.lava()) return new Heading(wrap(previousYaw), sticky.jump(), true);
			if (sticky.passable()) {
				best = new Heading(wrap(previousYaw), sticky.jump(), true);
				bestCost = (sticky.water() ? waterPenaltyDegrees + 0.5F : 0.0F) + (sticky.lava() ? LAVA_FLOW_PENALTY_DEGREES : 0.0F);
			}
		}
		for (int offset : FLEE_OFFSETS) {
			float yaw = wrap(awayYaw + offset);
			if (stalledHeading(yaw, stalledHeadings)) continue;
			Probe probe = probe(world, feet, yaw, margin);
			if (!probe.passable()) continue;
			// Equal cost: land wins over water. A heading that stays in a lava flow's way loses to any that leaves it.
			float cost = Math.abs(offset) + (probe.water() ? waterPenaltyDegrees + 0.5F : 0.0F)
					+ (probe.lava() ? LAVA_FLOW_PENALTY_DEGREES : 0.0F);
			if (cost < bestCost) {
				best = new Heading(yaw, probe.jump(), true);
				bestCost = cost;
			}
		}
		// Boxed in (pillar, ledge over lava, dead-end tunnel): report it instead of jumping off; the model decides.
		return best != null ? best : new Heading(wrap(awayYaw), false, false);
	}

	/**
	 * The yaw that walks the body from ({@code x}, {@code z}) along {@code headingYaw} through the cells the flee probe
	 * checked: toward the centre of the second cell ahead of {@code feet}, so a body standing off-centre drifts back to
	 * the cell line instead of brushing the next column. Falls back to the heading when that centre is the feet cell.
	 */
	public static float fleeSteerYaw(double x, double z, GridPosition feet, float headingYaw) {
		Objects.requireNonNull(feet, "feet must not be null");
		double radians = Math.toRadians(headingYaw);
		int cellX = feet.x() + (int) Math.round(-Math.sin(radians) * 2.0D);
		int cellZ = feet.z() + (int) Math.round(Math.cos(radians) * 2.0D);
		double towardX = cellX + 0.5D - x;
		double towardZ = cellZ + 0.5D - z;
		if (towardX * towardX + towardZ * towardZ < 0.25D) return wrap(headingYaw);
		return yawToward(x, z, cellX + 0.5D, cellZ + 0.5D);
	}

	private static boolean stalledHeading(float yaw, List<Float> headings) {
		return headings.stream().anyMatch(previous -> Math.abs(wrap(yaw - previous)) < 15.0F);
	}

	/** True when the next two cells along {@code yaw} cross deep water (swimming, not walking). */
	public static boolean headingCrossesWater(WalkabilityView world, GridPosition feet, float yaw) {
		Probe probe = probe(world, feet, yaw);
		return probe.passable() && probe.water();
	}

	/**
	 * Land a swimmer could climb onto, nearest first: standable (walk) cells within {@code radius} columns at the feet
	 * level, one to two above (a bank) or one below, at most {@code max} of them and at least 4 blocks apart so they
	 * name different banks. Facts for the model's choice of where to swim; empty when only water is in reach.
	 */
	public static List<GridPosition> shoreCandidates(WalkabilityView world, GridPosition feet, int radius, int max) {
		Objects.requireNonNull(world, "world must not be null");
		Objects.requireNonNull(feet, "feet must not be null");
		List<int[]> columns = new ArrayList<>();
		for (int dx = -radius; dx <= radius; dx++) {
			for (int dz = -radius; dz <= radius; dz++) {
				int distance = dx * dx + dz * dz;
				if (distance > 0 && distance <= radius * radius) columns.add(new int[]{dx, dz, distance});
			}
		}
		columns.sort(java.util.Comparator.comparingInt((int[] column) -> column[2]).thenComparingInt(column -> column[0])
				.thenComparingInt(column -> column[1]));
		List<GridPosition> shores = new ArrayList<>();
		int[] levels = {0, 1, -1, 2};
		for (int[] column : columns) {
			for (int dy : levels) {
				GridPosition candidate = feet.offset(column[0], dy, column[1]);
				if (world.traversalAt(candidate) != TraversalType.WALK) continue;
				boolean distinct = true;
				for (GridPosition shore : shores) {
					int sx = shore.x() - candidate.x();
					int sz = shore.z() - candidate.z();
					if (sx * sx + sz * sz < 16) distinct = false;
				}
				if (distinct) shores.add(candidate);
				break;
			}
			if (shores.size() >= max) break;
		}
		return shores;
	}

	/** True when walking along {@code yaw} keeps safe footing for the next two cells (the flee probe). */
	public static boolean canStep(WalkabilityView world, GridPosition feet, float yaw) {
		return probe(world, feet, yaw).passable();
	}

	/** As above, also refusing what the knockback margin refuses. */
	public static boolean canStep(WalkabilityView world, GridPosition feet, float yaw, Margin margin) {
		return probe(world, feet, yaw, margin).passable();
	}

	/**
	 * Knockback margin. While a mob that can hit the body is within 3 blocks, one hit can push it about a block
	 * sideways or off the edge it stands on: the run that died chased a magma cube off a pocket edge, slid off a block
	 * edge and fell down a shaft into lava. Active, the probe also refuses a heading that brings lava or a damaging drop
	 * beside the next cell, or that moves toward a column the body's box already overhangs (its support edge) when that
	 * column is lava or a damaging drop. {@code overhung} holds those columns at feet level, without the feet column.
	 */
	public record Margin(boolean active, Set<GridPosition> overhung) {
		public static final Margin NONE = new Margin(false, Set.of());
		/** Mobs this close can land a knockback hit before the body is clear. */
		public static final double KNOCKBACK_RANGE = 3.0D;

		public Margin {
			overhung = Set.copyOf(Objects.requireNonNull(overhung, "overhung must not be null"));
		}
	}

	private static Probe probe(WalkabilityView world, GridPosition feet, float yaw, Margin margin) {
		Probe probe = probe(world, feet, yaw);
		if (!probe.passable() || marginRefusal(world, feet, yaw, margin) == null) return probe;
		return new Probe(false, false);
	}

	/** {@link #refusal(WalkabilityView, GridPosition, float)} including what the knockback margin refuses. */
	public static Refusal refusal(WalkabilityView world, GridPosition feet, float yaw, Margin margin) {
		Refusal plain = refusal(world, feet, yaw);
		return plain != null ? plain : marginRefusal(world, feet, yaw, margin);
	}

	/** The cell the knockback margin refuses along this heading (HAZARD or DROP), or null. */
	static Refusal marginRefusal(WalkabilityView world, GridPosition feet, float yaw, Margin margin) {
		if (margin == null || !margin.active()) return null;
		double radians = Math.toRadians(yaw);
		double dx = -Math.sin(radians);
		double dz = Math.cos(radians);
		for (GridPosition column : margin.overhung()) {
			if ((column.x() - feet.x()) * dx + (column.z() - feet.z()) * dz <= 0.1D) continue;
			Refusal unsafe = unsafeColumn(world, new GridPosition(column.x(), feet.y(), column.z()));
			if (unsafe != null) return unsafe;
		}
		for (int step = 1; step <= 2; step++) {
			int x = feet.x() + (int) Math.round(dx * step);
			int z = feet.z() + (int) Math.round(dz * step);
			if (x == feet.x() && z == feet.z()) continue;
			// The next cell and the cells either side of it, across the heading.
			int sideX = (int) Math.round(-dz);
			int sideZ = (int) Math.round(dx);
			for (int side = -1; side <= 1; side++) {
				GridPosition cell = new GridPosition(x + side * sideX, feet.y(), z + side * sideZ);
				if (side != 0 && cell.x() == feet.x() && cell.z() == feet.z()) continue;
				Refusal unsafe = unsafeColumn(world, cell);
				if (unsafe != null) return unsafe;
			}
			return null;
		}
		return null;
	}

	/**
	 * The knockback margin for one step of a planned route toward {@code next} (a cardinal neighbour of the feet, or
	 * the landing beyond a one-block gap): refuses moving toward an overhung unsafe column and lava or a damaging drop
	 * beside the next cell, across the heading. A planned gap jump keeps its legal open gap; only lava in the gap
	 * is refused there. Null when the step keeps the margin or none is needed.
	 */
	public static Refusal routeMarginRefusal(WalkabilityView world, GridPosition feet, GridPosition next, TraversalType traversal,
			Margin margin) {
		Objects.requireNonNull(world, "world must not be null");
		if (margin == null || !margin.active()) return null;
		int dx = Integer.signum(next.x() - feet.x());
		int dz = Integer.signum(next.z() - feet.z());
		if (dx == 0 && dz == 0) return null;
		boolean gapJump = traversal == TraversalType.JUMP_GAP;
		for (GridPosition column : margin.overhung()) {
			if ((column.x() - feet.x()) * dx + (column.z() - feet.z()) * dz <= 0) continue;
			Refusal unsafe = unsafeColumn(world, new GridPosition(column.x(), feet.y(), column.z()));
			// Overhanging the gap a planned jump clears is the jump itself; only lava down there holds it.
			if (unsafe != null && (!gapJump || unsafe.kind() == RefusalKind.HAZARD)) return unsafe;
		}
		if (gapJump) {
			GridPosition gap = new GridPosition(feet.x() + dx, feet.y(), feet.z() + dz);
			for (int below = 0; below <= 16 && open(world, gap.below(below)); below++) {
				if (world.cellAt(gap.below(below + 1)) == WalkabilityView.Cell.HAZARD) {
					return new Refusal(RefusalKind.HAZARD, gap.below(below + 1), below + 1);
				}
			}
		}
		for (int side = -1; side <= 1; side += 2) {
			Refusal unsafe = unsafeColumn(world, new GridPosition(next.x() - side * dz, next.y(), next.z() + side * dx));
			if (unsafe != null) return unsafe;
		}
		return null;
	}

	/** Lava, fire or another hazard at or under this cell, or a drop deeper than a damage-free one; null when safe. */
	static Refusal unsafeColumn(WalkabilityView world, GridPosition cell) {
		if (walkable(world, cell)) return null;
		if (world.cellAt(cell) == WalkabilityView.Cell.HAZARD) return new Refusal(RefusalKind.HAZARD, cell, 0);
		if (!open(world, cell)) return null;
		if (world.cellAt(cell.below()) == WalkabilityView.Cell.HAZARD) return new Refusal(RefusalKind.HAZARD, cell.below(), 1);
		int below = 1;
		while (below <= 16 && open(world, cell.below(below))) {
			// Falling into water does no damage.
			if (world.cellAt(cell.below(below)) == WalkabilityView.Cell.WATER) return null;
			below++;
		}
		if (world.cellAt(cell.below(below)) == WalkabilityView.Cell.HAZARD) return new Refusal(RefusalKind.HAZARD, cell.below(below), below - 1);
		return below - 1 > LocalPathfinder.MAX_DROP_BLOCKS ? new Refusal(RefusalKind.DROP, cell, below - 1) : null;
	}

	/**
	 * Forward input scaled to how well the body faces its goal: full when aligned, none when 90 degrees or more
	 * off, so a turn toward a target behind the agent never walks it the wrong way first (as stepMotor does).
	 */
	public static float alignedForward(float forward, float yawError) {
		return forward * (float) Math.max(0.0D, Math.cos(Math.toRadians(yawError)));
	}

	/**
	 * Flee and fight only walk, swim or climb; a crouch-only gap would need input they never give. Swimming includes
	 * submerged water with room above (a player swims through it), not just the surface cells the path planner uses.
	 */
	static boolean walkable(WalkabilityView world, GridPosition position) {
		TraversalType traversal = world.traversalAt(position);
		return traversal == TraversalType.WALK || traversal == TraversalType.SWIM || traversal == TraversalType.CLIMB
				|| swimmable(world, position);
	}

	static boolean swimmable(WalkabilityView world, GridPosition position) {
		return world.cellAt(position) == WalkabilityView.Cell.WATER && open(world, position.above());
	}

	/** Room for the body: clear air or water (swimming through it). */
	static boolean open(WalkabilityView world, GridPosition position) {
		return world.isBodyClear(position) || world.cellAt(position) == WalkabilityView.Cell.WATER;
	}

	/** {@code lava}: the heading keeps the body in a seen lava flow it already stands in (see {@link #probe}). */
	record Probe(boolean passable, boolean jump, boolean water, boolean lava) {
		Probe(boolean passable, boolean jump) {
			this(passable, jump, false, false);
		}
	}

	static Probe probe(WalkabilityView world, GridPosition feet, float yaw) {
		double radians = Math.toRadians(yaw);
		double dx = -Math.sin(radians);
		double dz = Math.cos(radians);
		int y = feet.y();
		boolean jump = false;
		boolean water = false;
		boolean lava = false;
		boolean inFlow = world.lavaFlowsInto(feet);
		GridPosition from = feet;
		for (int step = 1; step <= 2; step++) {
			int x = feet.x() + (int) Math.round(dx * step);
			int z = feet.z() + (int) Math.round(dz * step);
			if (x == feet.x() && z == feet.z()) continue;
			if (diagonalCornerHazard(world, from, x, z) != null) return new Probe(false, false);
			GridPosition level = new GridPosition(x, y, z);
			GridPosition reached;
			if (walkable(world, level)) {
				reached = level;
			} else if (walkable(world, level.above()) && open(world, new GridPosition(feet.x(), y + 2, feet.z()))
					&& world.canJumpUp(from, level.above())) {
				if (step == 1) jump = true;
				y += 1;
				reached = level.above();
			} else {
				int drop = dropTo(world, level);
				if (drop == 0) return new Probe(false, false);
				y -= drop;
				reached = level.below(drop);
			}
			// Deep water (not one-deep standing water, which the world reports as clear footing) means swimming.
			if (world.cellAt(reached) == WalkabilityView.Cell.WATER) water = true;
			// Seen lava beside the feet or head of a cell ahead flows into it next: a player does not run into a flow it
			// can see (d22-nether: flee_from ran beside a lava fall and the body burned). Already in a flow's way, the
			// body may cross such cells to get out; the flee prefers headings that leave it.
			if (world.lavaFlowsInto(reached)) {
				if (!inFlow) return new Probe(false, false);
				lava = true;
			}
			from = reached;
		}
		return new Probe(true, jump, water, lava);
	}

	/**
	 * A diagonal step from {@code from} to column (x, z) sweeps the body's 0.6-wide box through both cardinal corner
	 * columns: fire or lava there at feet or head height burns the body even though the centre line misses it.
	 * Returns the first such hazard cell, or null for a straight step or clear corners. Walls at a corner only make
	 * the body slide, so they are not refused here.
	 */
	static GridPosition diagonalCornerHazard(WalkabilityView world, GridPosition from, int x, int z) {
		if (from.x() == x || from.z() == z) return null;
		for (GridPosition corner : new GridPosition[] {new GridPosition(from.x(), from.y(), z), new GridPosition(x, from.y(), from.z())}) {
			for (int dy = 0; dy <= 1; dy++) {
				GridPosition cell = corner.above(dy);
				if (world.cellAt(cell) == WalkabilityView.Cell.HAZARD) return cell;
			}
		}
		return null;
	}

	/**
	 * Depth of a damage-free drop into the cell {@code level} (1 to {@link LocalPathfinder#MAX_DROP_BLOCKS}, as the
	 * path planner and vanilla fall damage allow) with a clear shaft, or 0 when there is none.
	 */
	static int dropTo(WalkabilityView world, GridPosition level) {
		if (!open(world, level) || !open(world, level.above())) return 0;
		for (int drop = 1; drop <= LocalPathfinder.MAX_DROP_BLOCKS; drop++) {
			if (walkable(world, level.below(drop))) return drop;
			if (!open(world, level.below(drop))) return 0;
		}
		return 0;
	}

	/** Why a step along a heading is refused: the first cell that fails and how. */
	public enum RefusalKind { WALL, LOW_CEILING, DROP, HAZARD, UNLOADED }

	/** {@code drop} is the fall depth for DROP (counted to 16 blocks; 16 means at least that). */
	public record Refusal(RefusalKind kind, GridPosition at, int drop) {
	}

	/**
	 * The reason {@link #canStep} refuses this heading, or null when it is passable. Names the first refused cell so a
	 * failed approach or flee can say "4-block drop ahead" or "wall at x,y,z" instead of just not moving.
	 */
	public static Refusal refusal(WalkabilityView world, GridPosition feet, float yaw) {
		Objects.requireNonNull(world, "world must not be null");
		Objects.requireNonNull(feet, "feet must not be null");
		if (probe(world, feet, yaw).passable()) return null;
		double radians = Math.toRadians(yaw);
		double dx = -Math.sin(radians);
		double dz = Math.cos(radians);
		int y = feet.y();
		GridPosition from = feet;
		for (int step = 1; step <= 2; step++) {
			int x = feet.x() + (int) Math.round(dx * step);
			int z = feet.z() + (int) Math.round(dz * step);
			if (x == feet.x() && z == feet.z()) continue;
			GridPosition corner = diagonalCornerHazard(world, from, x, z);
			if (corner != null) return new Refusal(RefusalKind.HAZARD, corner, 0);
			GridPosition level = new GridPosition(x, y, z);
			if (walkable(world, level)) {
				if (flowRefused(world, feet, level)) return new Refusal(RefusalKind.HAZARD, level, 0);
				from = level;
				continue;
			}
			// A step up that cannot be jumped from here (honey, cobweb, a slab to a full block) is a wall.
			if (walkable(world, level.above()) && world.canJumpUp(from, level.above())) {
				if (open(world, new GridPosition(feet.x(), y + 2, feet.z()))) {
					if (flowRefused(world, feet, level.above())) return new Refusal(RefusalKind.HAZARD, level.above(), 0);
					y += 1;
					from = level.above();
					continue;
				}
				return new Refusal(RefusalKind.LOW_CEILING, new GridPosition(feet.x(), y + 2, feet.z()), 0);
			}
			if (walkable(world, level.above())) return new Refusal(RefusalKind.WALL, level, 0);
			int drop = dropTo(world, level);
			if (drop > 0) {
				if (flowRefused(world, feet, level.below(drop))) return new Refusal(RefusalKind.HAZARD, level.below(drop), 0);
				y -= drop;
				from = level.below(drop);
				continue;
			}
			WalkabilityView.Cell cell = world.cellAt(level);
			if (cell == WalkabilityView.Cell.UNLOADED) return new Refusal(RefusalKind.UNLOADED, level, 0);
			if (cell == WalkabilityView.Cell.HAZARD) return new Refusal(RefusalKind.HAZARD, level, 0);
			if (!open(world, level) || !open(world, level.above())) {
				GridPosition blocking = open(world, level) ? level.above() : level;
				return new Refusal(world.cellAt(blocking) == WalkabilityView.Cell.HAZARD ? RefusalKind.HAZARD : RefusalKind.WALL, blocking, 0);
			}
			// Feet levels the body would fall: open cells below the step until the floor.
			int below = 1;
			while (below <= 16 && open(world, level.below(below))) below++;
			GridPosition floor = level.below(below);
			if (world.cellAt(floor) == WalkabilityView.Cell.HAZARD) return new Refusal(RefusalKind.HAZARD, floor, below - 1);
			return new Refusal(RefusalKind.DROP, level, below - 1);
		}
		return new Refusal(RefusalKind.WALL, feet, 0);
	}

	/** A cell a seen lava flow reaches, entered from feet outside any flow (see {@link #probe}). */
	static boolean flowRefused(WalkabilityView world, GridPosition feet, GridPosition cell) {
		return world.lavaFlowsInto(cell) && !world.lavaFlowsInto(feet);
	}

	/** Yaw (Minecraft convention) that faces from {@code fromX,fromZ} toward {@code toX,toZ}. */
	public static float yawToward(double fromX, double fromZ, double toX, double toZ) {
		return wrap((float) Math.toDegrees(Math.atan2(-(toX - fromX), toZ - fromZ)));
	}

	static float wrap(float degrees) {
		float wrapped = degrees % 360.0F;
		if (wrapped >= 180.0F) wrapped -= 360.0F;
		if (wrapped < -180.0F) wrapped += 360.0F;
		return wrapped;
	}
}
