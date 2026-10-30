package dev.agaminggod.arenaagents.server.runtime.reflex;

import java.util.function.BiConsumer;
import net.minecraft.world.phys.Vec3;

/** Package access to the pure parts of {@link ReflexSensors} for checks in other packages. */
public final class ReflexSensorsAccess {
	private ReflexSensorsAccess() {
	}

	/** The dragon's charge line: flying at the body, passing beside it, flying away, too far, hovering close. */
	public static void verifyDragonPass(BiConsumer<Boolean, String> check) {
		Vec3 body = new Vec3(0.0D, 65.0D, 0.0D);
		check.accept(ReflexSensors.dragonPasses(new Vec3(30.0D, 75.0D, 0.0D), new Vec3(-1.0D, -0.3D, 0.0D), body, 48.0D),
				"a dragon 30 blocks out flying straight at the body is charging");
		check.accept(ReflexSensors.dragonPasses(new Vec3(30.0D, 75.0D, 0.0D), new Vec3(-1.0D, -0.3D, 0.2D), body, 48.0D),
				"one whose line passes about 6 blocks beside the body is charging");
		check.accept(!ReflexSensors.dragonPasses(new Vec3(30.0D, 75.0D, 0.0D), new Vec3(1.0D, 0.0D, 0.0D), body, 48.0D),
				"one flying away is not");
		check.accept(!ReflexSensors.dragonPasses(new Vec3(30.0D, 75.0D, 0.0D), new Vec3(-0.2D, 0.0D, 1.0D), body, 48.0D),
				"one crossing far to the side is not");
		check.accept(!ReflexSensors.dragonPasses(new Vec3(60.0D, 75.0D, 0.0D), new Vec3(-1.0D, 0.0D, 0.0D), body, 48.0D),
				"one beyond the range is not");
		check.accept(ReflexSensors.dragonPasses(new Vec3(3.0D, 68.0D, 0.0D), Vec3.ZERO, body, 48.0D),
				"one hovering within 6 blocks is");
	}
}
