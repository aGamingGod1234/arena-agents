package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;

/**
 * The fight footwork (2026-10-23 combat deaths: fights stood in contact through every recharge, never dodged a shot and
 * were thrown off ledges behind them) as pure checks: spacing outside the target's reach while recharging, a sprint
 * step-in timed to the charge, a crit jump timed so the charged swing lands falling, no crit on a dragon part, circling
 * that flips side irregularly and never onto unsafe footing, circling away from a drop behind with no step back, a
 * side-step off a projectile's line, the lethal-push and edge-clearance probes, and the dragon's charge line.
 */
public final class FightMotionVerification {
	private static int assertions;

	private FightMotionVerification() {
	}

	public static void main(String[] args) {
		System.out.println("FightMotionVerification: " + verify() + " assertions passed");
	}

	public static int verify() {
		assertions = 0;
		verifySpacing();
		verifyStepIn();
		verifyCritTiming();
		verifyNoCritOnPart();
		verifyCircling();
		verifyBrinkBehind();
		verifyDodge();
		verifyLowHealth();
		verifyLethalPush();
		verifyEdgeClearance();
		verifyFootingAhead();
		verifyDragonPass();
		return assertions;
	}

	private static FightMotion.Sense sense(double distance, float strength, int ticksToReady, boolean canHit, boolean critTarget,
			boolean safeBack, boolean safeLeft, boolean safeRight, int brink, int dodge, boolean lowHealth) {
		return new FightMotion.Sense(distance, 3.3D, FightMotion.meleeReach(0.3D), strength, ticksToReady, canHit, true, false,
				critTarget, true, lowHealth, true, true, safeBack, safeLeft, safeRight, brink, dodge, true);
	}

	private static void verifySpacing() {
		FightMotion motion = new FightMotion(1);
		// Just swung (charge 0.1, 11 ticks to go) inside a zombie's reach (1.43): back out.
		FightMotion.Move move = motion.step(sense(1.2D, 0.1F, 11, true, false, true, true, true, 0, 0, false));
		check(move.forward() < 0.0F && !move.swing(), "recharging inside the mob's reach backs out of it: " + move);
		// Outside its reach and still recharging: hold, no swing.
		move = motion.step(sense(2.4D, 0.4F, 7, true, false, true, true, true, 0, 0, false));
		check(move.forward() == 0.0F && !move.swing(), "recharging outside its reach holds: " + move);
		// Charged and in reach: swing.
		move = motion.step(sense(2.4D, 0.95F, 0, true, false, true, true, true, 0, 0, false));
		check(move.swing() && move.sprint(), "a charged swing in reach lands as a sprint hit: " + move);
	}

	private static void verifyStepIn() {
		FightMotion motion = new FightMotion(2);
		FightMotion.Move move = motion.step(sense(2.4D, 0.7F, 3, true, false, true, true, true, 0, 0, false));
		check(move.forward() > 0.0F && move.sprint() && !move.swing(), "steps in sprinting as the charge completes: " + move);
		// Out of its own reach and far from charged: walks (no sprint) to its reach, which is outside the mob's.
		move = motion.step(sense(3.6D, 0.2F, 10, false, false, true, true, true, 0, 0, false));
		check(move.forward() > 0.0F && !move.sprint(), "out of reach while recharging walks in without sprinting: " + move);
		move = motion.step(sense(3.6D, 0.8F, 2, false, false, true, true, true, 0, 0, false));
		check(move.forward() > 0.0F && move.sprint(), "closes at a sprint once the charge will be ready: " + move);
	}

	private static void verifyCritTiming() {
		FightMotion motion = new FightMotion(3);
		// Living target, headroom, 7 ticks to full charge, on the ground in reach: jump now.
		FightMotion.Move move = motion.step(sense(2.4D, 0.4F, 7, true, true, true, true, true, 0, 0, false));
		check(move.jump() && !move.sprint(), "jumps 7 ticks before full charge for a falling crit: " + move);
		// Charged while still rising: wait for the descent.
		FightMotion.Sense rising = new FightMotion.Sense(2.4D, 3.3D, 1.43D, 0.95F, 0, true, false, false, true, true, false, true,
				true, true, true, true, 0, 0, true);
		move = motion.step(rising);
		check(!move.swing(), "a charged swing waits while the crit jump rises: " + move);
		FightMotion.Sense falling = new FightMotion.Sense(2.4D, 3.3D, 1.43D, 0.95F, 0, true, false, true, true, true, false, true,
				true, true, true, true, 0, 0, true);
		move = motion.step(falling);
		check(move.swing() && !move.sprint() && move.forward() == 0.0F, "the swing lands on the descent, not sprinting: " + move);
		// No headroom: no jump.
		FightMotion other = new FightMotion(3);
		move = other.step(new FightMotion.Sense(2.4D, 3.3D, 1.43D, 0.4F, 7, true, true, false, true, false, false, true,
				true, true, true, true, 0, 0, true));
		check(!move.jump(), "no crit jump under a low ceiling: " + move);
	}

	private static void verifyNoCritOnPart() {
		FightMotion motion = new FightMotion(4);
		FightMotion.Move move = motion.step(new FightMotion.Sense(2.0D, 3.5D, 1.8D, 0.4F, 7, true, true, false, false, true, false,
				false, true, true, true, true, 0, 0, true));
		check(!move.jump() && move.strafe() == 0.0F, "a dragon part gets no crit jump and no circling: " + move);
	}

	private static void verifyCircling() {
		FightMotion motion = new FightMotion(5);
		int flips = 0;
		float last = 0.0F;
		for (int tick = 0; tick < 200; tick++) {
			FightMotion.Move move = motion.step(sense(2.4D, 0.5F, 6, true, false, true, true, true, 0, 0, false));
			check(move.strafe() != 0.0F, "circles in reach");
			if (last != 0.0F && move.strafe() != last) flips++;
			last = move.strafe();
		}
		check(flips >= 200 / FightMotion.MAX_SIDE_TICKS && flips <= 200 / FightMotion.MIN_SIDE_TICKS + 1, "changes side irregularly: " + flips);
		FightMotion blocked = new FightMotion(6);
		for (int tick = 0; tick < 60; tick++) {
			FightMotion.Move move = blocked.step(sense(2.4D, 0.5F, 6, true, false, true, false, true, 0, 0, false));
			check(move.strafe() <= 0.0F, "never strafes onto unsafe footing on the left");
		}
	}

	private static void verifyBrinkBehind() {
		FightMotion motion = new FightMotion(7);
		// A drop at the back-left: circle right (-1) and never back out, even inside the mob's reach while recharging.
		for (int tick = 0; tick < 40; tick++) {
			FightMotion.Move move = motion.step(sense(1.2D, 0.1F, 11, true, false, true, true, true, -1, 0, false));
			check(move.forward() >= 0.0F, "never steps back toward a drop behind: " + move);
			check(move.strafe() < 0.0F, "circles right, away from a drop at the back-left: " + move);
		}
		FightMotion other = new FightMotion(8);
		FightMotion.Move move = other.step(sense(2.4D, 0.5F, 6, true, false, true, true, true, 1, 0, false));
		check(move.strafe() > 0.0F, "circles left, away from a drop at the back-right: " + move);
	}

	private static void verifyDodge() {
		FightMotion motion = new FightMotion(9);
		FightMotion.Move move = motion.step(sense(3.0D, 0.5F, 6, true, false, true, true, true, 0, -1, false));
		check(move.strafe() < 0.0F && move.phase().contains("dodging"), "side-steps right off the shot's line: " + move);
		for (int tick = 1; tick < FightMotion.DODGE_TICKS; tick++) {
			move = motion.step(sense(3.0D, 0.5F, 6, true, false, true, true, true, 0, 0, false));
			check(move.strafe() < 0.0F, "a dodge keeps its side for its whole step");
		}
		FightMotion blocked = new FightMotion(10);
		move = blocked.step(sense(3.0D, 0.5F, 6, true, false, true, true, false, 0, -1, false));
		check(move.strafe() > 0.0F, "dodges to the other side when the shot's side is unsafe: " + move);
		// Facing yaw 0 (south, +Z): left is +X. A body 0.5 east of a shot's line flying south-to-north steps further east (left).
		check(FightMotion.dodgeSide(0.5D, 0.0D, 0.0D, -1.0D, 0.0F) == 1, "steps off the line on the side it already stands");
		check(FightMotion.dodgeSide(-0.5D, 0.0D, 0.0D, -1.0D, 0.0F) == -1, "west of the line steps west (right when facing south)");
	}

	private static void verifyLowHealth() {
		FightMotion motion = new FightMotion(11);
		FightMotion.Move move = motion.step(sense(1.7D, 0.3F, 9, true, true, true, true, true, 0, 0, true));
		check(move.forward() < 0.0F && !move.jump(), "low health keeps out of reach and does not jump: " + move);
	}

	/** Floor at y 63 for x < 3; open air (the void) beyond; lava at x -6. */
	private static final WalkabilityView ISLAND_EDGE = position -> {
		if (position.x() == -6 && position.y() == 64) return WalkabilityView.Cell.HAZARD;
		if (position.x() < 3 && position.y() <= 63) return WalkabilityView.Cell.SAFE_SUPPORT;
		return WalkabilityView.Cell.CLEAR;
	};

	private static void verifyLethalPush() {
		// Yaw -90 heads +X (east), toward the void 2.5 blocks away.
		check(FightingPosition.lethalPush(ISLAND_EDGE, 0.5D, 0.5D, 64, -90.0F), "a push east from 2.5 blocks of the void is lethal");
		check(!FightingPosition.lethalPush(ISLAND_EDGE, -2.5D, 0.5D, 64, -90.0F), "5.5 blocks from the void a push is not");
		check(!FightingPosition.lethalPush(ISLAND_EDGE, 0.5D, 0.5D, 64, 0.0F), "a push along the edge is not lethal");
		check(FightingPosition.lethalPush(ISLAND_EDGE, -3.5D, 0.5D, 64, 90.0F), "a push west into seen lava is lethal");
	}

	private static void verifyEdgeClearance() {
		double clearance = FightingPosition.edgeClearance(ISLAND_EDGE, new GridPosition(0, 64, 0), 10.0D);
		check(clearance > 2.0D && clearance <= 3.0D, "the edge 2.5 blocks east: " + clearance);
		check(FightingPosition.edgeClearance(ISLAND_EDGE, new GridPosition(-30, 64, 0), 8.0D) >= 8.0D, "deep inland is clear");
		// A 1x1 tower top whose sides were never seen below its rim.
		WalkabilityView tower = position -> position.x() == 0 && position.z() == 0 && position.y() <= 99 ? WalkabilityView.Cell.SAFE_SUPPORT
				: position.y() >= 100 ? WalkabilityView.Cell.CLEAR : WalkabilityView.Cell.UNLOADED;
		check(FightingPosition.edgeClearance(tower, new GridPosition(0, 100, 0), 8.0D) <= 1.0D, "a tower top is next to a drop");
	}

	private static void verifyFootingAhead() {
		// Floor ends at x 3 (cell 2 is the last). A body at x 2.6 stepping east has void 0.5 ahead; along the edge it is fine.
		check(!FightingPosition.footingAhead(ISLAND_EDGE, 2.6D, 0.5D, 64, -90.0F), "0.4 from the lip, a step toward it is refused");
		check(FightingPosition.footingAhead(ISLAND_EDGE, 2.6D, 0.5D, 64, 0.0F), "a step along the lip keeps footing");
		check(FightingPosition.footingAhead(ISLAND_EDGE, 0.5D, 0.5D, 64, -90.0F), "2.5 from the lip a step toward it keeps footing");
		WalkabilityView unseenPastEdge = position -> position.x() >= 3 ? WalkabilityView.Cell.UNLOADED : ISLAND_EDGE.cellAt(position);
		check(!FightingPosition.footingAhead(unseenPastEdge, 2.6D, 0.5D, 64, -90.0F), "unseen footing ahead is no footing");
		check(!FightingPosition.footingAround(unseenPastEdge, 1.5D, 0.5D, 64, 2.0D), "no jump within 2 blocks of unseen footing");
		check(FightingPosition.footingAround(ISLAND_EDGE, -10.5D, 0.5D, 64, 2.0D), "a jump far inland is fine");
		double[] inland = FightingPosition.inlandFrom(unseenPastEdge, 2.6D, 0.5D, 64, 0.75D);
		check(inland != null && inland[0] < -0.9D, "0.4 from an unseen lip, inland is west: " + java.util.Arrays.toString(inland));
		check(FightingPosition.inlandFrom(ISLAND_EDGE, -10.5D, 0.5D, 64, 0.75D) == null, "far inland nothing to step off");
		check(!FightingPosition.footingAhead(ISLAND_EDGE, 1.6D, 0.5D, 64, -90.0F), "a step that ends within a block of the lip is refused");
	}

	private static void verifyDragonPass() {
		dev.agaminggod.arenaagents.server.runtime.reflex.ReflexSensorsAccess.verifyDragonPass(FightMotionVerification::check);
	}

	static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
