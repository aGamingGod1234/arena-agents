package dev.agaminggod.arenaagents.server.perception;

import java.util.HashSet;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.monster.piglin.PiglinArmPose;
import net.minecraft.world.phys.Vec3;

/** Verifies observed dragon motion, strict forward view, piglin arm poses and the crystal cage shape. */
public final class VisibleAppearanceVerification {
	private static int assertions;

	private VisibleAppearanceVerification() {
	}

	public static int verify() {
		assertions = 0;
		verifyDragonMotion();
		verifyArmPoses();
		verifyCage();
		verifyCracks();
		return assertions;
	}

	private static void verifyDragonMotion() {
		check("hovering".equals(VisibleAppearance.dragonMotion(Vec3.ZERO, false)), "stationary airborne dragon reveals no selected maneuver");
		check("perched".equals(VisibleAppearance.dragonMotion(Vec3.ZERO, true)), "stationary dragon over visible bedrock is perched");
		check("descending".equals(VisibleAppearance.dragonMotion(new Vec3(0.2, -0.2, 0), false)), "actual descent is shown");
		check("ascending".equals(VisibleAppearance.dragonMotion(new Vec3(0, 0.2, 0), false)), "actual ascent is shown");
		check("flying".equals(VisibleAppearance.dragonMotion(new Vec3(0.2, 0, 0), false)), "horizontal flight does not reveal attack intent");
		Vec3 eye = new Vec3(0, 1, 0), east = new Vec3(1, 0, 0);
		check(!ObservationVisibility.isInFrontOfEye(eye, east, new Vec3(-1, 1, 0)), "even a nearby entity behind the eye cannot supply appearance");
		check(ObservationVisibility.isInFrontOfEye(eye, east, new Vec3(1, 1, 0)), "turning toward the entity permits visual acquisition");
	}

	private static void verifyArmPoses() {
		check(VisibleAppearance.armPose(PiglinArmPose.DEFAULT) == null && VisibleAppearance.armPose(null) == null, "the default arm pose is omitted");
		check("admiring_item".equals(VisibleAppearance.armPose(PiglinArmPose.ADMIRING_ITEM)), "a piglin looking over gold reads admiring_item");
		check("crossbow_charge".equals(VisibleAppearance.armPose(PiglinArmPose.CROSSBOW_CHARGE)), "a charging crossbow is shown");
	}

	private static void verifyCracks() {
		check(VisibleAppearance.crackStage(null) == null && VisibleAppearance.crackStage(net.minecraft.world.entity.Crackiness.Level.NONE) == null, "an undamaged golem shows no cracks");
		check("medium".equals(VisibleAppearance.crackStage(net.minecraft.world.entity.Crackiness.Level.MEDIUM)), "crack stage is named");
		check("high".equals(VisibleAppearance.crackStage(net.minecraft.world.entity.Crackiness.Level.HIGH)), "heavy cracks are named");
	}

	private static void verifyCage() {
		BlockPos crystal = new BlockPos(3, 90, -40);
		Set<BlockPos> walls = new HashSet<>();
		for (int dx = -2; dx <= 2; dx++) for (int dz = -2; dz <= 2; dz++) for (int dy = -1; dy <= 2; dy++) {
			if (Math.abs(dx) == 2 || Math.abs(dz) == 2 || dy == 2) walls.add(crystal.offset(dx, dy, dz));
		}
		check(VisibleAppearance.caged(walls::contains, crystal), "a guarded spike's bar walls around the crystal read as caged");
		check(!VisibleAppearance.caged(cell -> false, crystal), "an open spike is not caged");
		walls.remove(crystal.east(2));
		walls.remove(crystal.east(2).below());
		check(VisibleAppearance.caged(walls::contains, crystal), "a cage with a broken bar is still a cage");
		check(CrystalCage.find(walls::contains, crystal).openings().equals(java.util.List.of(crystal.east(2))),
				"a broken bar beside the crystal is an opening; one at the bedrock row below it is not");
		walls.removeIf(cell -> cell.getY() >= crystal.getY());
		check(!VisibleAppearance.caged(walls::contains, crystal), "a cage stripped above the bedrock row is no longer caged");
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
