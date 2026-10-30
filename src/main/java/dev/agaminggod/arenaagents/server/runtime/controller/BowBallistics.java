package dev.agaminggod.arenaagents.server.runtime.controller;

import net.minecraft.world.item.BowItem;
import net.minecraft.world.phys.Vec3;

/**
 * The bow shot a practised player makes at a target that holds still: vanilla arrow flight (AbstractArrow.tick moves by
 * its velocity, then keeps 0.99 of it and loses 0.05 downward each tick; it leaves 0.1 below the eye at three times the
 * draw power) solved for the low arc through the aim point, led by the target's observed motion over the flight as a
 * practised archer leads a moving mob. Random spread is not modelled: vanilla Projectile.getMovementToShoot adds up to
 * {@link #SPREAD} radians each way per axis (triangular) to every player arrow.
 */
public final class BowBallistics {
	static final double GRAVITY = 0.05D;
	static final double DRAG = (double) 0.99F;
	/** Arrow.(LivingEntity) spawn height below the eye. */
	static final double LAUNCH_DROP = 0.10000000149011612D;
	static final int MAX_TICKS = 200;
	/** Projectile.getMovementToShoot: triangle(0, 0.0172275 * inaccuracy) per axis; player bows shoot at inaccuracy 1. */
	public static final double SPREAD = 0.0172275D;
	/** A lead longer than this many flight ticks extrapolates turning flight too far to be a useful aim. */
	static final int MAX_LEAD_TICKS = 60;
	private static final double LOWEST = Math.toRadians(-89.0D);
	private static final double HIGHEST = Math.toRadians(89.0D);

	private BowBallistics() {
	}

	/** Launch speed in blocks per tick after drawing {@code ticks} ticks (BowItem.getPowerForTime times 3). */
	public static double speed(int ticks) {
		return BowItem.getPowerForTime(ticks) * 3.0D;
	}

	/**
	 * The height of the arrow above its launch point once it has flown {@code horizontal} blocks, or NaN when it never
	 * gets that far within {@link #MAX_TICKS} ticks.
	 */
	static double heightAt(double horizontal, double pitch, double speed) {
		double x = 0.0D, y = 0.0D;
		double vx = Math.cos(pitch) * speed, vy = Math.sin(pitch) * speed;
		for (int tick = 0; tick < MAX_TICKS; tick++) {
			double nx = x + vx, ny = y + vy;
			if (nx >= horizontal) return vx <= 0.0D ? y : y + (ny - y) * (horizontal - x) / (nx - x);
			x = nx;
			y = ny;
			vx *= DRAG;
			vy = vy * DRAG - GRAVITY;
		}
		return Double.NaN;
	}

	/** The flight ticks to cover {@code horizontal} blocks at this pitch, or -1 when it never does. */
	static int ticksTo(double horizontal, double pitch, double speed) {
		double x = 0.0D, vx = Math.cos(pitch) * speed;
		for (int tick = 1; tick <= MAX_TICKS; tick++) {
			x += vx;
			if (x >= horizontal) return tick;
			vx *= DRAG;
		}
		return -1;
	}

	/** Launch pitch (radians, positive up) of the low arc through ({@code horizontal}, {@code rise}), or NaN out of range. */
	static double pitch(double horizontal, double rise, double speed) {
		if (speed <= 0.0D) return Double.NaN;
		if (horizontal < 1.0E-6D) return rise >= 0.0D ? Math.PI / 2.0D : -Math.PI / 2.0D;
		double previous = LOWEST;
		double previousHeight = heightAt(horizontal, previous, speed);
		double step = Math.toRadians(1.0D);
		for (double angle = LOWEST + step; angle <= HIGHEST + 1.0E-9D; angle += step) {
			double height = heightAt(horizontal, angle, speed);
			if (!Double.isNaN(height) && height >= rise && !Double.isNaN(previousHeight) && previousHeight < rise) {
				double low = previous, high = angle;
				for (int iteration = 0; iteration < 40; iteration++) {
					double middle = (low + high) / 2.0D;
					double middleHeight = heightAt(horizontal, middle, speed);
					if (!Double.isNaN(middleHeight) && middleHeight >= rise) high = middle;
					else low = middle;
				}
				return high;
			}
			previous = angle;
			previousHeight = height;
		}
		return Double.NaN;
	}

	/**
	 * Where to put the crosshair from {@code eye} so a released arrow at {@code speed} passes through {@code target}: the
	 * point of the launch line straight above (or below) the target, so "N blocks above the target" means the same as a
	 * hand-chosen aim point N blocks over it. Null when the target is beyond the bow's reach.
	 */
	public static Vec3 aimPoint(Vec3 eye, Vec3 target, double speed) {
		double dx = target.x - eye.x, dz = target.z - eye.z;
		double horizontal = Math.sqrt(dx * dx + dz * dz);
		double pitch = pitch(horizontal, target.y - (eye.y - LAUNCH_DROP), speed);
		if (Double.isNaN(pitch)) return null;
		if (horizontal >= 1.0D && Math.abs(pitch) < Math.toRadians(80.0D)) {
			return new Vec3(target.x, eye.y + Math.tan(pitch) * horizontal, target.z);
		}
		double distance = Math.max(1.0D, eye.distanceTo(target));
		double flat = Math.cos(pitch) * distance;
		double nx = horizontal < 1.0E-6D ? 0.0D : dx / horizontal, nz = horizontal < 1.0E-6D ? 0.0D : dz / horizontal;
		return new Vec3(eye.x + nx * flat, eye.y + Math.sin(pitch) * distance, eye.z + nz * flat);
	}

	/**
	 * Where a target now at {@code target}, moving {@code motion} blocks per tick, will be when the arrow reaches it: the
	 * lead a practised archer gives a moving mob. The target itself when still; null when the bow cannot reach the lead.
	 */
	public static Vec3 lead(Vec3 eye, Vec3 target, Vec3 motion, double speed) {
		if (motion.lengthSqr() < 1.0E-6D) return target;
		Vec3 point = target;
		for (int iteration = 0; iteration < 6; iteration++) {
			double ticks = flightTicks(eye, point, speed);
			if (ticks < 0) return null;
			point = target.add(motion.scale(Math.min(ticks, MAX_LEAD_TICKS)));
		}
		return point;
	}

	/** Ticks (fractional) the solved arrow takes to reach {@code target}, or -1 out of reach. */
	public static double flightTicks(Vec3 eye, Vec3 target, double speed) {
		double dx = target.x - eye.x, dz = target.z - eye.z;
		double horizontal = Math.sqrt(dx * dx + dz * dz);
		double pitch = pitch(horizontal, target.y - (eye.y - LAUNCH_DROP), speed);
		if (Double.isNaN(pitch)) return -1;
		double x = 0.0D, vx = Math.cos(pitch) * speed;
		for (int tick = 0; tick < MAX_TICKS; tick++) {
			if (x + vx >= horizontal) return vx <= 0.0D ? tick : tick + (horizontal - x) / vx;
			x += vx;
			vx *= DRAG;
		}
		return -1;
	}

	/**
	 * Where an arrow loosed along the line from {@code eye} through {@code aim} is when it has flown as far out as
	 * {@code target} (horizontally): the point to compare with the target. Null when it never gets that far.
	 */
	public static Vec3 arcAt(Vec3 eye, Vec3 aim, Vec3 target, double speed) {
		double ax = aim.x - eye.x, az = aim.z - eye.z, aimHorizontal = Math.sqrt(ax * ax + az * az);
		double tx = target.x - eye.x, tz = target.z - eye.z, horizontal = Math.sqrt(tx * tx + tz * tz);
		if (aimHorizontal < 1.0E-6D || horizontal < 1.0E-6D) return null;
		double pitch = Math.atan2(aim.y - eye.y, aimHorizontal);
		double height = heightAt(horizontal, pitch, speed);
		if (Double.isNaN(height)) return null;
		return new Vec3(eye.x + ax / aimHorizontal * horizontal, eye.y - LAUNCH_DROP + height, eye.z + az / aimHorizontal * horizontal);
	}
}
