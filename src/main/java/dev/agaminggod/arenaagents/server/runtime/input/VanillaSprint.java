package dev.agaminggod.arenaagents.server.runtime.input;

/**
 * The run-sprint rules a vanilla client applies every tick (LocalPlayer.aiStep), for Carpet bodies whose sprint flag
 * never passes through a client. Carpet kept a body sprinting with no forward key and while pressed into a wall, so
 * an agent "sprinted in place" (sprint particles, hunger drain, no movement), which no player can do.
 */
public final class VanillaSprint {
	/** ClientInput.hasForwardImpulse: forward input above this counts as pressing forward. */
	static final float FORWARD_IMPULSE = 1.0E-5F;
	/** LocalPlayer.isHorizontalCollisionMinor: a graze within 8 degrees of the input direction keeps sprint. */
	static final double MINOR_COLLISION_RADIANS = 0.13962633907794952D;
	private static final double MOVE_EPSILON = 9.999999747378752E-6D;

	private VanillaSprint() {
	}

	/**
	 * LocalPlayer.shouldStopRunSprinting inverted: sprint holds while it is requested, forward is pressed, and the
	 * body is not stopped by a wall (a minor graze does not count). Swimming keeps the swim-sprint rule (forward only).
	 */
	public static boolean keeps(boolean requested, float forward, boolean horizontalCollision, boolean minorCollision,
			boolean swimming) {
		return keeps(requested, forward, horizontalCollision, minorCollision, swimming, true);
	}

	/** As above, and sprinting needs enough food ({@link #enoughFood}); a hungry body drops sprint like a client. */
	public static boolean keeps(boolean requested, float forward, boolean horizontalCollision, boolean minorCollision,
			boolean swimming, boolean enoughFood) {
		if (!requested || !enoughFood || !(forward > FORWARD_IMPULSE)) return false;
		return swimming || !horizontalCollision || minorCollision;
	}

	/** LocalPlayer.hasEnoughFoodToSprint: riding, food above 6 (three drumsticks), or creative flight. */
	public static boolean enoughFood(boolean passenger, int foodLevel, boolean mayfly) {
		return passenger || foodLevel > 6 || mayfly;
	}

	/**
	 * LocalPlayer.isHorizontalCollisionMinor: the input direction (strafe, forward rotated by yaw) and the movement
	 * the collision left are within 8 degrees. No input or no movement is a full stop, never minor.
	 */
	public static boolean minorCollision(float yawDegrees, float strafe, float forward, double moveX, double moveZ) {
		double radians = yawDegrees * 0.017453292F;
		double sin = Math.sin(radians);
		double cos = Math.cos(radians);
		double inputX = strafe * cos - forward * sin;
		double inputZ = forward * cos + strafe * sin;
		double inputSquared = inputX * inputX + inputZ * inputZ;
		double moveSquared = moveX * moveX + moveZ * moveZ;
		if (inputSquared < MOVE_EPSILON || moveSquared < MOVE_EPSILON) return false;
		double cosine = (inputX * moveX + inputZ * moveZ) / Math.sqrt(inputSquared * moveSquared);
		return Math.acos(Math.max(-1.0D, Math.min(1.0D, cosine))) < MINOR_COLLISION_RADIANS;
	}
}
