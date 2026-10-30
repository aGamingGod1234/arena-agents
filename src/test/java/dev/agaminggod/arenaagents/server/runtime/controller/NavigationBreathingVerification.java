package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.server.perception.WaterAirFacts;
import net.minecraft.world.phys.Vec3;

/** Real interruption state machine and acquired swim geometry, without a live server. */
public final class NavigationBreathingVerification {
	public static int verify() {
		check(NavigationBreathing.reason(true, 60, 1, false).equals("AIR_RESERVE_REACHED"), "reserve triggers at three seconds");
		check(NavigationBreathing.reason(true, 70, 1, false) == null, "covered swim continues above reserve");
		check(NavigationBreathing.reason(true, 100, 5, false).equals("BREATH_NOT_COVERED"), "unsafe route interrupts before reserve");
		check(NavigationBreathing.reason(true, 280, 0, true).equals("BREATH_NOT_COVERED"), "no route underwater also seeks air");
		check(NavigationBreathing.reason(false, 40, 50, true) == null, "above-water navigation is unaffected");
		SwimPlanning.ColumnView lake = (x, y, z) -> y >= 64 ? SwimPlanning.Cell.OPEN : SwimPlanning.Cell.WATER;
		var surface = SwimPlanning.nearestSurface(lake, 0, 60, 0);
		var found = new WaterAirFacts.SurfaceLookup(surface, false);
		var eye = new Vec3(.5, 60.25, .5);
		int assertions = 5;
		for (String reason : new String[]{"AIR_RESERVE_REACHED", "BREATH_NOT_COVERED"}) {
			var breathing = new NavigationBreathing(reason, 60, 9, false, 0);
			var step = breathing.tick(true, 59, eye, found, 50, .2);
			check(step.result() == null && step.eyeTarget().y > eye.y, "interrupted move executes upward swim before returning");
			step = breathing.tick(false, 50, new Vec3(.5, 64.1, .5), found, 1000, .2);
			check(step.result().state() == ServerController.State.FAILED && step.result().reasonCode().equals(reason), "reaching air ends with original cause instead of destination success");
			check(step.result().message().contains("destination was not resumed") && step.result().message().contains("2.5 s air left")
					&& step.result().message().contains("swim path estimate"), "result tells model the interruption and measured air / estimated path facts");
			var sealed = new NavigationBreathing(reason, 100, 9, true, 0);
			step = sealed.tick(true, 100, eye, new WaterAirFacts.SurfaceLookup(null, false), 50, .2);
			check(step.result().reasonCode().equals(reason) && step.result().message().contains("No acquired breathable cell")
					&& step.result().message().contains("5.0 s air left"), "no breathable route stops before breath runs out");
			assertions += 4;
		}
		var breathing = new NavigationBreathing("BREATH_NOT_COVERED", 200, 20, false, 0);
		check(breathing.tick(true, 199, eye, new WaterAirFacts.SurfaceLookup(null, true), 50, .2).result() == null, "pending bounded search does not report no surface");
		var step = breathing.tick(true, 198, eye, found, 100, .2);
		step = breathing.tick(true, 178, eye, found, 1100, .2);
		check(step.result().reasonCode().equals("BREATH_NOT_COVERED") && step.result().message().contains("blocked"), "observed obstruction stops surfacing with its original cause");
		SwimPlanning.ColumnView overhang = (x, y, z) -> y == 61 && x < 2 ? SwimPlanning.Cell.SOLID
				: y >= 61 ? SwimPlanning.Cell.OPEN : SwimPlanning.Cell.WATER;
		var detour = SwimPlanning.nearestSurface(overhang, 0, 60, 0);
		var around = new NavigationBreathing("BREATH_NOT_COVERED", 200, 20, false, 0);
		step = around.tick(true, 199, eye, new WaterAirFacts.SurfaceLookup(detour, false), 50, .2);
		check(step.eyeTarget().x > eye.x && step.eyeTarget().y == eye.y, "ceiling detour follows the BFS around the wall before rising");
		var aboveCellCenter = new NavigationBreathing("BREATH_NOT_COVERED", 200, 20, false, 0);
		var standingEye = new Vec3(.5, 60.62, .5);
		step = aboveCellCenter.tick(true, 199, standingEye, new WaterAirFacts.SurfaceLookup(detour, false), 50, .2);
		check(step.eyeTarget().y == standingEye.y, "sideways breathing route preserves actual eye height instead of driving feet into the floor");
		// R-FLOOD: one tick with the eyes out under the lip of a flooded stair is not air; the swim goes on to the cell.
		var lip = new NavigationBreathing("AIR_RESERVE_REACHED", 0, 9, false, 0);
		check(lip.tick(true, 0, eye, found, 50, .2).result() == null, "lip swim starts");
		var underLip = new Vec3(.5, 61.9, .5);
		check(lip.tick(false, 0, underLip, found, 100, .2).result() == null, "a tick out of water below the breathable cell keeps swimming");
		check(lip.tick(true, 0, eye, found, 150, .2).result() == null, "back under resets the surfaced count");
		ServerController.TickResult out = null;
		for (int tick = 0; tick < 10 && out == null; tick++) out = lip.tick(false, 4 * tick, underLip, found, 200 + 50 * tick, .2).result();
		check(out != null && out.message().contains("Reached breathable air"), "half a second out of water counts as air");
		return assertions + 8;
	}
	private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
