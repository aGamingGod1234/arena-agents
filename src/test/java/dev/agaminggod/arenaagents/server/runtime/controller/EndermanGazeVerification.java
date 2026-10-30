package dev.agaminggod.arenaagents.server.runtime.controller;

import net.minecraft.world.phys.Vec3;

/** The walking-view guard reads vanilla's distance-scaled stare cone, widened to the gaze reflex's margin. */
public final class EndermanGazeVerification {
	private static int assertions;

	private EndermanGazeVerification() {
	}

	public static int verify() {
		assertions = 0;
		Vec3 eye = new Vec3(0.0D, 62.62D, 0.0D);
		// An enderman 3 blocks lower and 17 away sits about 10 degrees below the horizon: the 10-degree walking gaze stares.
		Vec3 lowEye = new Vec3(0.0D, 59.6D, 17.0D);
		check(EndermanGaze.staring(eye, Vec3.directionFromRotation(10.0F, 0.0F), lowEye), "a walking gaze meets a lower enderman's eyes");
		check(!EndermanGaze.staring(eye, Vec3.directionFromRotation(25.0F, 0.0F), lowEye), "looking further down clears them");
		// An enderman 20 away on the same level: its eyes are about 2.7 degrees above the horizon.
		Vec3 levelEye = new Vec3(0.0D, 60.0D + 2.55D, 20.0D);
		check(EndermanGaze.staring(eye, Vec3.directionFromRotation(-3.0F, 0.0F), levelEye), "a raised walking gaze stares at a far enderman");
		check(!EndermanGaze.staring(eye, Vec3.directionFromRotation(5.0F, 0.0F), levelEye), "the uphill gaze floor clears it");
		check(!EndermanGaze.staring(eye, Vec3.directionFromRotation(-3.0F, 90.0F), levelEye), "looking elsewhere is no stare");
		return assertions;
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
