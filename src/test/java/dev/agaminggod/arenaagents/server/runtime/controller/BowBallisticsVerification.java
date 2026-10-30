package dev.agaminggod.arenaagents.server.runtime.controller;

import net.minecraft.world.phys.Vec3;

/** The solved bow aim flies vanilla's arrow tick (move, keep 0.99, lose 0.05 down) through the target point. */
public final class BowBallisticsVerification {
	private static int assertions;

	private BowBallisticsVerification() {
	}

	public static int verify() {
		assertions = 0;
		double full = BowBallistics.speed(20);
		check(Math.abs(full - 3.0D) < 1.0E-6D, "a full draw launches at 3 blocks per tick");
		check(BowBallistics.speed(10) < full, "a half draw launches slower");
		Vec3 eye = new Vec3(14.5D, 62.62D, -33.6D);
		// End crystals from the live runs: on pillars 20 to 40 blocks up, 20 to 60 blocks away.
		for (Vec3 crystal : new Vec3[] {new Vec3(42.5D, 102.0D, 0.5D), new Vec3(33.5D, 99.0D, 24.5D),
				new Vec3(-12.5D, 87.0D, -39.5D), new Vec3(12.5D, 105.0D, -39.5D), new Vec3(60.0D, 63.0D, -33.6D)}) {
			Vec3 aim = BowBallistics.aimPoint(eye, crystal, full);
			check(aim != null, "a crystal within bow range has a solution");
			double miss = closestPass(eye, aim, crystal, full);
			check(miss < 0.1D, "the solved arrow passes through the target, missed by " + miss);
			check(aim.y > crystal.y, "the aim sits above the target to allow for drop");
		}
		Vec3 below = new Vec3(30.0D, 50.0D, -33.6D);
		check(closestPass(eye, BowBallistics.aimPoint(eye, below, full), below, full) < 0.1D, "a target below is hit too");
		check(BowBallistics.aimPoint(eye, new Vec3(400.0D, 62.0D, 0.0D), full) == null, "a target past the bow's reach has no solution");
		Vec3 weak = new Vec3(24.5D, 65.0D, -30.0D);
		double slow = BowBallistics.speed(12);
		check(closestPass(eye, BowBallistics.aimPoint(eye, weak, slow), weak, slow) < 0.1D, "a short draw aims higher for its slower arrow");
		check(BowBallistics.aimPoint(eye, weak, slow).y > BowBallistics.aimPoint(eye, weak, full).y, "a slower arrow needs a higher aim");
		// A target moving across the line: the led aim meets it where it is when the arrow arrives.
		Vec3 flying = new Vec3(30.0D, 85.0D, 10.0D);
		Vec3 motion = new Vec3(0.6D, 0.05D, -0.4D);
		Vec3 led = BowBallistics.lead(eye, flying, motion, full);
		check(led != null && led.distanceTo(flying) > 5.0D, "a moving target is led by its motion over the flight: " + led);
		double movingMiss = movingPass(eye, BowBallistics.aimPoint(eye, led, full), flying, motion, full);
		check(movingMiss < 0.3D, "the led arrow meets the moving target, missed by " + movingMiss);
		double unled = movingPass(eye, BowBallistics.aimPoint(eye, flying, full), flying, motion, full);
		check(unled > 3.0D, "without lead the same arrow passes behind it, missed by " + unled);
		check(BowBallistics.lead(eye, flying, Vec3.ZERO, full) == flying, "a still target needs no lead");
		// The solved aim point sits straight above the target, and the arc of any aim point is read at the target's range.
		Vec3 crystal = new Vec3(33.5D, 99.0D, 24.5D);
		Vec3 aim = BowBallistics.aimPoint(eye, crystal, full);
		check(Math.abs(aim.x - crystal.x) < 1.0E-9D && Math.abs(aim.z - crystal.z) < 1.0E-9D, "the aim point is straight above the target");
		check(BowBallistics.arcAt(eye, aim, crystal, full).distanceTo(crystal) < 0.1D, "the solved aim's arc reaches the target at its range");
		Vec3 low = BowBallistics.arcAt(eye, new Vec3(crystal.x, crystal.y + 1.0D, crystal.z), crystal, full);
		check(low.y < crystal.y - 1.0D, "an aim point barely above the target drops below it at range: " + low);
		return assertions;
	}

	/** Closest approach between the arrow and a target moving {@code motion} per tick, both advanced tick by tick. */
	private static double movingPass(Vec3 eye, Vec3 aim, Vec3 target, Vec3 motion, double speed) {
		Vec3 position = eye.subtract(0.0D, BowBallistics.LAUNCH_DROP, 0.0D);
		Vec3 velocity = aim.subtract(eye).normalize().scale(speed);
		double best = Double.POSITIVE_INFINITY;
		for (int tick = 0; tick < 200; tick++) {
			Vec3 next = position.add(velocity);
			Vec3 from = target.add(motion.scale(tick)), to = target.add(motion.scale(tick + 1));
			for (int step = 0; step <= 16; step++) best = Math.min(best, position.lerp(next, step / 16.0D).distanceTo(from.lerp(to, step / 16.0D)));
			position = next;
			velocity = velocity.scale((double) 0.99F).subtract(0.0D, 0.05D, 0.0D);
		}
		return best;
	}

	/** Vanilla flight from 0.1 below the eye along the aim, as AbstractArrow.tick advances it; the closest pass to target. */
	private static double closestPass(Vec3 eye, Vec3 aim, Vec3 target, double speed) {
		Vec3 position = eye.subtract(0.0D, BowBallistics.LAUNCH_DROP, 0.0D);
		Vec3 velocity = aim.subtract(eye).normalize().scale(speed);
		double best = Double.POSITIVE_INFINITY;
		for (int tick = 0; tick < 200; tick++) {
			Vec3 next = position.add(velocity);
			for (int step = 0; step <= 16; step++) best = Math.min(best, position.lerp(next, step / 16.0D).distanceTo(target));
			position = next;
			velocity = velocity.scale((double) 0.99F).subtract(0.0D, 0.05D, 0.0D);
		}
		return best;
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
