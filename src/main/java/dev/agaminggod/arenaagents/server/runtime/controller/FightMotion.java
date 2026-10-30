package dev.agaminggod.arenaagents.server.runtime.controller;

import java.util.Objects;

/**
 * The footwork of a model-chosen melee fight, tick by tick, as a player's hands do it between the model's calls. The
 * model still chooses whom to fight, whether to pursue, the shield and the bail-out; this only moves the body the way
 * a player moves while that fight runs. Pure: the controller reads the world into a {@link Sense} and applies the
 * {@link Move}.
 * <ul>
 * <li>Spacing: while the sword recharges the body stays just outside the target's own melee reach (a mob's swing lands
 * about 0.83 block beyond its box, a player's sword reaches 3 from the eye), and steps in, sprinting, only when the
 * swing will be charged on arrival: the sprint hit knocks the target back out of reach again (live runs 2026-10-23: the
 * fight stood in contact during every recharge and traded hits with piglins, wither skeletons and endermen it could
 * have out-spaced).</li>
 * <li>Critical hits: against a target that takes them (a living mob, not a dragon part; vanilla
 * Player.canCriticalAttack), with headroom, the jump starts as many ticks before full charge as the rise lasts, so the
 * charged swing lands while falling (x1.5).</li>
 * <li>Circling: in reach the body strafes round the target, changing side at irregular intervals, so a shooter's aim at
 * where it stood misses; never toward unsafe footing, and when a lethal drop lies behind (where the target's hits push
 * it) it circles away from that side and never steps back.</li>
 * <li>Dodging: a projectile about to hit that the raised shield does not face is side-stepped away from its line.</li>
 * <li>Low health: no jumps and strict spacing.</li>
 * </ul>
 */
public final class FightMotion {
	/** Extra distance kept beyond the target's melee reach while the sword recharges. */
	static final double SPACING_MARGIN = 0.5D;
	/** Steps in this many ticks before full charge, the time to cover the spacing gap at a sprint. */
	static final int STEP_IN_TICKS = 4;
	/** A vanilla jump rises for about 6 ticks; falling starts on the 7th. */
	static final int CRIT_LEAD_TICKS = 7;
	/** A charged swing waits for the descent of a crit jump at most this long after the jump. */
	static final int CRIT_WAIT_TICKS = 12;
	static final int MIN_SIDE_TICKS = 10;
	static final int MAX_SIDE_TICKS = 28;
	/** A dodge keeps its side this long once started. */
	static final int DODGE_TICKS = 8;
	/** Circling only within this much beyond the swing's reach. */
	static final double CIRCLE_BAND = 1.5D;
	/** Charge threshold of a full-damage swing (as {@link CombatPlanning#READY_ATTACK_STRENGTH}). */
	static final float READY = CombatPlanning.READY_ATTACK_STRENGTH;

	/**
	 * One tick's view of the fight. Distances are horizontal between body centres. {@code mobReach} is the centre distance
	 * within which the target's own melee lands (0 when it has none). {@code safeForward/Back/Left/Right} say whether the
	 * two cells along that key's heading are safe footing (the knockback margin included). {@code brinkBehind}: 0 when no
	 * lethal drop lies behind within a hit's push, +1 when circling left moves it from behind, -1 right, 2 straight
	 * behind (either side). {@code dodge}: 0, or +1/-1 to side-step left/right off a projectile's line.
	 */
	public record Sense(double distance, double ourReach, double mobReach, float strength, int ticksToReady,
			boolean canHit, boolean onGround, boolean descending, boolean critTarget, boolean headroom, boolean lowHealth,
			boolean circle, boolean safeForward, boolean safeBack, boolean safeLeft, boolean safeRight, int brinkBehind,
			int dodge, boolean canSprint) {
	}

	/** Keys for this tick; {@code swing} is whether a charged swing may land now. */
	public record Move(float forward, float strafe, boolean sprint, boolean jump, boolean swing, String phase) {
	}

	private int side = 1;
	private int sideTicks;
	private int dodgeSide;
	private int dodgeTicks;
	private int sinceJump = Integer.MAX_VALUE / 2;
	private int seed;

	public FightMotion(int seed) {
		this.seed = seed;
		this.sideTicks = nextInterval();
	}

	/** Irregular side changes: a fixed rhythm is as predictable as standing still. */
	private int nextInterval() {
		seed = seed * 1103515245 + 12345;
		int span = MAX_SIDE_TICKS - MIN_SIDE_TICKS + 1;
		return MIN_SIDE_TICKS + Math.floorMod(seed >>> 8, span);
	}

	public Move step(Sense sense) {
		Objects.requireNonNull(sense, "sense must not be null");
		sinceJump++;
		if (sense.dodge() != 0 && dodgeTicks == 0) {
			dodgeSide = sense.dodge();
			dodgeTicks = DODGE_TICKS;
		}
		boolean dodging = dodgeTicks > 0;
		if (dodging) dodgeTicks--;
		boolean ready = sense.strength() >= READY;
		boolean critMode = sense.critTarget() && sense.headroom() && !sense.lowHealth() && !dodging;
		// The charged swing lands on a crit jump's descent; on the ground, or once that jump is spent, it lands at once.
		boolean waitForDescent = critMode && !sense.onGround() && !sense.descending() && sinceJump < CRIT_WAIT_TICKS;
		boolean swing = sense.canHit() && ready && !waitForDescent;
		boolean jump = false;
		float forward;
		boolean sprint = false;
		String phase;
		boolean inBand = sense.distance() <= sense.ourReach() + CIRCLE_BAND;
		boolean brink = sense.brinkBehind() != 0;
		double keepOut = sense.mobReach() > 0.0D ? sense.mobReach() + SPACING_MARGIN : 0.0D;
		if (swing) {
			// A sprint hit (moving in) knocks back; a crit must not sprint (vanilla drops the crit while sprinting).
			forward = !critMode && sense.canSprint() && sense.safeForward() ? 1.0F : 0.0F;
			sprint = forward > 0.0F;
			phase = critMode && !sense.onGround() ? "crit" : sprint ? "sprint-hit" : "hit";
		} else if (!sense.canHit() && sense.distance() > sense.ourReach()) {
			// Out of reach: close in, sprinting when the swing will be charged on arrival (or the gap is long).
			boolean charged = sense.ticksToReady() <= STEP_IN_TICKS || sense.distance() > sense.ourReach() + 3.0D;
			boolean hold = !charged && keepOut > 0.0D && sense.distance() < keepOut + 0.75D;
			forward = hold || !sense.safeForward() ? 0.0F : 1.0F;
			sprint = forward > 0.0F && sense.canSprint() && charged;
			phase = hold ? "spacing" : "closing";
		} else if (!ready && sense.ticksToReady() > STEP_IN_TICKS && keepOut > 0.0D && sense.distance() < keepOut) {
			// Recharging inside the target's reach: back out of it, unless a drop lies behind.
			forward = sense.safeBack() && !brink ? -1.0F : 0.0F;
			phase = forward < 0.0F ? "spacing" : "holding";
		} else if (!ready && sense.ticksToReady() <= STEP_IN_TICKS) {
			forward = sense.safeForward() ? 1.0F : 0.0F;
			sprint = forward > 0.0F && sense.canSprint() && !critMode;
			phase = "stepping in";
		} else {
			forward = 0.0F;
			phase = "recharging";
		}
		if (sense.lowHealth() && !swing && keepOut > 0.0D && sense.distance() < keepOut + 0.5D && sense.ticksToReady() > STEP_IN_TICKS
				&& sense.safeBack() && !brink) {
			forward = -1.0F;
			sprint = false;
			phase = "spacing (low health)";
		}
		if (critMode && sense.onGround() && sense.canHit() && sense.ticksToReady() <= CRIT_LEAD_TICKS
				&& sense.ticksToReady() >= CRIT_LEAD_TICKS - 2 && sinceJump >= CRIT_WAIT_TICKS) {
			jump = true;
			sinceJump = 0;
			sprint = false;
			phase = "crit jump";
		}
		float strafe = 0.0F;
		if (dodging) {
			strafe = sideKey(dodgeSide, sense);
			if (strafe == 0.0F) strafe = sideKey(-dodgeSide, sense);
			phase = phase + ", dodging";
		} else if (sense.circle() && inBand) {
			if (sense.brinkBehind() == 1 || sense.brinkBehind() == -1) {
				side = sense.brinkBehind();
			} else if (--sideTicks <= 0) {
				side = -side;
				sideTicks = nextInterval();
			}
			strafe = sideKey(side, sense);
			if (strafe == 0.0F && !brink) {
				side = -side;
				strafe = sideKey(side, sense);
			}
		}
		if (brink && strafe != 0.0F && !dodging) phase = phase + ", circling off the drop";
		return new Move(forward, strafe, sprint, jump, swing, phase);
	}

	/** +1 strafe left, -1 right, 0 when that side's footing is unsafe. */
	private static float sideKey(int side, Sense sense) {
		if (side > 0) return sense.safeLeft() ? 1.0F : 0.0F;
		if (side < 0) return sense.safeRight() ? -1.0F : 0.0F;
		return 0.0F;
	}

	/**
	 * Centre distance within which a mob's own melee lands on the body: vanilla's attack box grows the mob's box by
	 * {@code sqrt(2.04) - 0.6} sideways (Mob.getAttackBoundingBox), meeting the body's 0.3 half width.
	 */
	public static double meleeReach(double mobHalfWidth) {
		return mobHalfWidth + Math.sqrt(2.04D) - 0.6D + 0.3D;
	}

	/**
	 * Side to step off a projectile's line: +1 left, -1 right, 0 when it does not threaten. {@code offX/offZ} is the body
	 * centre's offset from the projectile's line (perpendicular part), {@code yaw} the body's facing.
	 */
	public static int dodgeSide(double offX, double offZ, double velX, double velZ, float yaw) {
		double radians = Math.toRadians(yaw);
		double leftX = Math.cos(radians), leftZ = Math.sin(radians);
		double length = Math.hypot(offX, offZ);
		if (length < 0.05D) {
			// Dead centre: step to the side the shot does not drift toward.
			double across = velX * leftX + velZ * leftZ;
			return across > 0.0D ? -1 : 1;
		}
		return offX * leftX + offZ * leftZ >= 0.0D ? 1 : -1;
	}
}
