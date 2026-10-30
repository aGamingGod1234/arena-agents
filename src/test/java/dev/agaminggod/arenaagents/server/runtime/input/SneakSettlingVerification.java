package dev.agaminggod.arenaagents.server.runtime.input;

public final class SneakSettlingVerification {
	private SneakSettlingVerification() { }
	public static int verify() {
		var bridge = new SneakSettling();
		double speed = 0.1D;
		int ticks = 0;
		while (bridge.hold(true, speed)) {
			// Vanilla edge clipping is active while shift stays held; ground friction removes drift.
			check(++ticks <= 10, "settling is bounded");
			speed *= 0.546D;
		}
		check(speed < 0.003D && ticks > 0, "a bridge segment keeps sneak until residual horizontal movement settles");
		check(bridge.describe().contains("movement/use/attack released"), "receipt names settling without extending movement or clicks");
		var edge = new SneakSettling();
		check(!edge.hold(false, 0.1D), "an edge never introduces a crouch the model did not author");
		check(!new SneakSettling().hold(false, 0.1D), "ordinary control releases immediately");
		check(!new SneakSettling().hold(true, 0), "stationary crouch needs no settling delay");
		var ice = new SneakSettling();
		for (int i = 0; i < 10; i++) check(ice.hold(true, 0.1D), "still-moving body keeps sneak within the bound");
		check(!ice.hold(true, 0.1D), "ten ticks is a hard bound even when friction cannot settle velocity");
		check(!new SneakSettling().hold(false, speed), "a new explicit non-sneak control inherits no settling policy");
		return 8 + ticks + 10;
	}
	private static void check(boolean value, String reason) { if (!value) throw new AssertionError(reason); }
}
