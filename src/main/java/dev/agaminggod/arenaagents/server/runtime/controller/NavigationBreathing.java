package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.server.perception.WaterAirFacts;
import net.minecraft.world.phys.Vec3;

/** Executes one breathing interruption of an authored movement; completion always returns to the model. */
final class NavigationBreathing {
	private final String reason;
	private final String triggerFacts;
	private final long startedMs;
	private SwimPlanning.Surface surface;
	private int index;
	private long progressMs;
	private double progressDistance = Double.POSITIVE_INFINITY;
	private double eyeHeight;
	private int surfacedTicks;
	private static final int SURFACED_TICKS = 10;

	static String reason(boolean underwater, int air, int submergedNodes, boolean noRoute) {
		if (!underwater) return null;
		if (air <= SwimPlanning.AIR_RESERVE_TICKS) return "AIR_RESERVE_REACHED";
		return noRoute || !SwimPlanning.breathCovers(air, submergedNodes) ? "BREATH_NOT_COVERED" : null;
	}

	NavigationBreathing(String reason, int air, int submergedNodes, boolean noRoute, long elapsedMs) {
		this.reason = reason;
		this.startedMs = this.progressMs = elapsedMs;
		this.triggerFacts = String.format(java.util.Locale.ROOT,
				"Navigation ended early to breathe: %s; triggered at %.1f s air; submerged route %d cells (%.1f s swim estimate); no route=%s",
				reason, SwimPlanning.airSecondsLeft(air), submergedNodes,
				submergedNodes / SwimPlanning.SURFACING_BLOCKS_PER_SECOND, noRoute);
	}

	record Step(Vec3 eyeTarget, ServerController.TickResult result) { }

	Step tick(boolean underwater, int air, Vec3 eye, WaterAirFacts.SurfaceLookup lookup, long elapsedMs, double progress) {
		return tick(underwater, air, eye, 0, lookup, elapsedMs, progress);
	}

	Step tick(boolean underwater, int air, Vec3 eye, double eyeHeight, WaterAirFacts.SurfaceLookup lookup, long elapsedMs, double progress) {
		this.eyeHeight = eyeHeight;
		if (!underwater) {
			// Out of water at the breathable cell, or for half a second: air. A tick out under a ceiling lip (the top of
			// a flooded stair) is not, so the swim carries on to the cell instead of sinking back.
			if (atSurface(eye) || ++surfacedTicks >= SURFACED_TICKS) return stop(air, "Reached breathable air; destination was not resumed", progress);
			if (surface == null) return new Step(null, null);
		} else {
			surfacedTicks = 0;
		}
		if (surface == null) {
			if (lookup.searching()) return new Step(null, null);
			surface = lookup.surface();
			if (surface == null) return stop(air, "No acquired breathable cell; stopped before continuing the route", progress);
			index = Math.min(1, surface.path().size() - 1);
		}
		Vec3 target = target(eye.y);
		while (index < surface.path().size() - 1 && eye.distanceTo(target) < 0.55) {
			index++;
			target = target(eye.y);
			progressDistance = Double.POSITIVE_INFINITY;
			progressMs = elapsedMs;
		}
		double distance = eye.distanceTo(target);
		if (elapsedMs - progressMs >= SwimPlanning.SURFACING_PROGRESS_WINDOW_MS) {
			if (progressDistance - distance < SwimPlanning.SURFACING_MIN_PROGRESS) {
				return stop(air, "Breathing swim blocked by a current or obstruction", progress);
			}
			progressDistance = distance; progressMs = elapsedMs;
		} else if (!Double.isFinite(progressDistance)) progressDistance = distance;
		if (elapsedMs - startedMs >= SwimPlanning.SURFACING_TIMEOUT_MS) {
			return stop(air, "Breathing swim timed out", progress);
		}
		return new Step(target, null);
	}

	private boolean atSurface(Vec3 eye) {
		return surface != null && net.minecraft.util.Mth.floor(eye.x) == surface.x() && net.minecraft.util.Mth.floor(eye.z) == surface.z()
				&& net.minecraft.util.Mth.floor(eye.y) >= surface.openY();
	}

	private Vec3 target(double eyeY) {
		var cell = surface.path().get(index);
		// The path only vouches for the eye cell and the one below it; a standing body reaches lower, so a step onto a
		// raised flooded stair keeps the feet above that lower cell's floor instead of inside the step.
		double feetClear = cell.getY() - 1 + eyeHeight + 0.01;
		return new Vec3(cell.getX() + 0.5, Math.max(Math.max(cell.getY() + 0.25, eyeY), feetClear), cell.getZ() + 0.5);
	}

	Step stop(int air, String detail, double progress) {
		String target = surface == null ? "" : String.format(java.util.Locale.ROOT,
				"; breathable eye cell %d,%d,%d; swim path estimate %.1f blocks / %.1f s; %s",
				surface.x(), surface.openY(), surface.z(), surface.distance(),
				surface.distance() / SwimPlanning.SURFACING_BLOCKS_PER_SECOND, surface.breathOnly() ? "breath only" : "surface");
		return new Step(null, ServerController.TickResult.failed(reason,
				triggerFacts + "; " + detail + target + String.format(java.util.Locale.ROOT,
						"; %.1f s air left", SwimPlanning.airSecondsLeft(air)), progress));
	}
}
