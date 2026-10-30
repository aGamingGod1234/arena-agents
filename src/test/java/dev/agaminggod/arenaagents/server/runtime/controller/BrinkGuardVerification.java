package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import net.minecraft.world.phys.AABB;

public final class BrinkGuardVerification {
	private BrinkGuardVerification() {
	}

	public static void main(String[] arguments) {
		System.out.println("PASS: " + verify() + " brink guard assertions");
	}

	public static int verify() {
		int assertions = 0;
		// A netherrack ledge (floor top y 64) for z <= 0. South of it (z >= 1) the ground drops: a lava sea at y 51 below
		// x >= 0, a stone floor at y 60 (a 4-block fall) below x == -1, a floor at y 54 (a 10-block fall) below x == -2,
		// and nothing at all below x == -3 (the void). Cells nobody has seen are at x == -4. A body centred at x + 0.5 is
		// over column x alone.
		WalkabilityView world = position -> {
			int x = position.x(), y = position.y(), z = position.z();
			if (x == -4 && z >= 1) return WalkabilityView.Cell.UNLOADED;
			if (z <= 0) return y <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
			if (x >= 0) return y <= 51 ? WalkabilityView.Cell.HAZARD : WalkabilityView.Cell.CLEAR;
			if (x == -1) return y <= 59 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
			if (x == -2) return y <= 53 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
			return WalkabilityView.Cell.CLEAR;
		};
		BrinkGuard.VoidProbe voids = (x, y, z) -> x == -3 && z >= 1;
		BrinkGuard.Fall lava = BrinkGuard.fall(world, body(0.5D, 1.5D), -64, voids, 0.0D, 20.0D);
		check(lava != null && lava.below().equals("lava") && lava.drop() == 12, "a body over the lava sea falls 12 blocks into lava");
		assertions++;
		check(BrinkGuard.fall(world, body(0.0D, 1.5D), -64, voids, 0.0D, 20.0D) == null,
				"a box half over the 4-block floor lands there first: the lava beside it is below the landing");
		assertions++;
		check(BrinkGuard.fall(world, body(-0.5D, 1.5D), -64, voids, 0.0D, 20.0D) == null, "a 4-block fall is no reason to refuse a step");
		assertions++;
		check(BrinkGuard.fall(world, body(-1.5D, 1.5D), -64, voids, 0.0D, 20.0D) == null, "a 10-block fall at full health is survivable");
		assertions++;
		BrinkGuard.Fall deep = BrinkGuard.fall(world, body(-1.5D, 1.5D), -64, voids, 0.0D, 6.0D);
		check(deep != null && deep.below().equals("drop") && deep.drop() == 10, "a 10-block fall (7 damage) kills a body with 6 health");
		assertions++;
		check(BrinkGuard.fall(world, body(-1.5D, 1.5D), -64, voids, 2.0D, 8.0D) != null, "a fall already under way adds to the landing's damage");
		assertions++;
		BrinkGuard.Fall nothing = BrinkGuard.fall(world, body(-2.5D, 1.5D), -64, voids, 0.0D, 20.0D);
		check(nothing != null && nothing.below().equals("void"), "an empty column to the world's bottom is the void");
		assertions++;
		BrinkGuard.Fall unseen = BrinkGuard.fall(world, body(-3.5D, 1.5D), -64, voids, 0.0D, 20.0D);
		check(unseen != null && unseen.unknown(), "a column nobody has seen is a drop of unknown depth, not a known lethal one");
		assertions++;
		check(BrinkGuard.fall(world, body(0.5D, -0.5D), -64, voids, 0.0D, 20.0D) == null, "standing on the ledge falls nowhere");
		assertions++;
		WalkabilityView vines = position -> position.z() >= 1 && position.y() >= 68 && position.y() <= 70
				? WalkabilityView.Cell.CLIMBABLE : world.cellAt(position);
		BrinkGuard.Fall underVines = BrinkGuard.fall(vines, body(0.5D, 1.5D), -64, voids, 0.0D, 20.0D);
		check(underVines != null && underVines.below().equals("lava"),
				"hanging vines above lava are not a supported landing when the walking body releases its keys");
		assertions++;
		// Fire on a floor two blocks down burns as lava does; a hot floor (magma) does not count.
		WalkabilityView fire = position -> position.y() <= 61 ? WalkabilityView.Cell.SAFE_SUPPORT
				: position.y() == 62 && position.z() >= 1 ? WalkabilityView.Cell.HAZARD : position.z() <= 0 && position.y() <= 63
				? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		BrinkGuard.Fall burning = BrinkGuard.fall(fire, body(0.5D, 1.5D), -64, voids, 0.0D, 20.0D);
		check(burning != null && burning.drop() == 1, "an unknown hazard state below is counted as burning");
		assertions++;

		check(BrinkGuard.levelFooting(world, 0.5D, 64.0D, -0.5D, new double[]{0, -1}), "a brace can lean inward on known level floor");
		check(!BrinkGuard.levelFooting(world, -0.5D, 64.0D, -0.5D, new double[]{0, 1}), "a brace refuses even a survivable drop off this level");
		check(!BrinkGuard.levelFooting(world, -3.5D, 64.0D, -0.5D, new double[]{0, 1}), "a brace cannot lean onto unseen footing");
		assertions += 3;

		// A jump's reach: a sprint jump from a standstill covers about 3 to 4 blocks, a walking one about 2, a standing
		// one with no keys none (a pillar jump), so the landing judged is where the body would come down.
		double[] east = {1.0D, 0.0D}, still = {0.0D, 0.0D};
		double sprintJump = BrinkGuard.jumpDisplacement(0.0D, 0.0D, east, true, BrinkGuard.JUMP_AIR_TICKS)[0];
		double walkJump = BrinkGuard.jumpDisplacement(0.0D, 0.0D, east, false, BrinkGuard.JUMP_AIR_TICKS)[0];
		check(sprintJump > 3.0D && sprintJump < 4.5D, "a standing sprint jump lands 3 to 4.5 blocks on: " + sprintJump);
		check(walkJump > 1.5D && walkJump < sprintJump, "a walking jump lands short of a sprint jump: " + walkJump);
		double[] up = BrinkGuard.jumpDisplacement(0.0D, 0.0D, still, false, BrinkGuard.JUMP_AIR_TICKS);
		check(up[0] == 0.0D && up[1] == 0.0D, "a jump with no keys and no motion comes down where it took off");
		// A hit's hop (vanilla knockback 0.4 out, 0.36 up after the first tick) carries a keyless body 2 to 3 blocks: the
		// landing the shove walk-back judges.
		double hop = BrinkGuard.shoveDisplacement(0.4D, 0.36D, 0.0D, 0.0D)[0];
		check(hop > 2.0D && hop < 3.2D, "a knockback hop lands 2 to 3.2 blocks out: " + hop);
		assertions += 4;

		var inward = BrinkGuard.bracePoint(world, 0.5D, 64, -0.5D);
		check(inward != null && inward.z < -0.5D && inward.y == 64, "a brace gains room on its deck before a shove");
		assertions++;

		// Keys toward a world heading under a yaw, and back.
		for (float yaw : new float[]{0.0F, 90.0F, -135.0F, 180.0F, 33.0F}) {
			for (int index = 0; index < 8; index++) {
				double angle = Math.PI / 4.0D * index, dx = Math.cos(angle), dz = Math.sin(angle);
				float[] keys = BrinkGuard.keysToward(yaw, dx, dz);
				check(Math.abs(keys[0]) <= 1.0F && Math.abs(keys[1]) <= 1.0F && (keys[0] != 0.0F || keys[1] != 0.0F), "keys are keyboard keys");
				double[] heading = BrinkGuard.worldHeading(yaw, keys[0], keys[1]);
				check(heading[0] * dx + heading[1] * dz > Math.cos(Math.toRadians(23.0D)), "keys move within 22.5 degrees of the wanted heading");
				assertions += 2;
			}
		}
		double[] south = BrinkGuard.worldHeading(0.0F, 1.0F, 0.0F);
		check(Math.abs(south[0]) < 1.0E-9D && south[1] > 0.99D, "yaw 0 forward walks south (+z)");
		assertions++;
		double[] left = BrinkGuard.worldHeading(0.0F, 0.0F, 1.0F);
		check(left[0] > 0.99D, "yaw 0 strafe left walks east (+x), as vanilla's xxa");
		assertions++;
		return assertions;
	}

	/** A standing body's box centred at (x, z) on the floor top y 64. */
	private static AABB body(double x, double z) {
		return new AABB(x - 0.3D, 64.0D, z - 0.3D, x + 0.3D, 65.8D, z + 0.3D);
	}

	private static void check(boolean value, String reason) {
		if (!value) throw new AssertionError(reason);
	}
}
