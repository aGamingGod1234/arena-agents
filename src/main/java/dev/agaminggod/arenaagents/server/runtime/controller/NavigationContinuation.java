package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import net.minecraft.world.phys.Vec3;

/** Recheck missing sight after the view has time to turn, without treating a new plan as body progress. */
final class NavigationContinuation {
	static final int MAX_EMPTY_REPLANS = 3;
	static final long OBSERVE_INTERVAL_MS = 250L;
	private int searches;
	private int emptyReplans;
	private long retryAt;
	private Vec3 previousStop;

	void searching() { searches++; }
	int replans() { return Math.max(0, searches - 1); }
	boolean waiting(long elapsedMs) { return elapsedMs < retryAt; }
	void accepted() { emptyReplans = 0; retryAt = 0L; previousStop = null; }
	boolean stableAt(Vec3 body) { return previousStop != null && previousStop.distanceTo(body) <= 0.1D; }
	boolean exhausted(Vec3 body, long elapsedMs) {
		if (previousStop != null && previousStop.distanceTo(body) > 0.5D) emptyReplans = 0;
		previousStop = body;
		retryAt = elapsedMs + OBSERVE_INTERVAL_MS;
		return ++emptyReplans >= MAX_EMPTY_REPLANS;
	}

	/** Near is a factual stop, never permission to step into the unobserved cells. */
	static boolean nearUnseenTarget(WalkabilityView world, Vec3 body, Vec3 target, double tolerance) {
		if (body.distanceTo(target) > Math.max(tolerance, Math.min(2.5D, tolerance + 1.5D)) || Math.abs(body.y - target.y) > 0.5D) return false;
		GridPosition targetFeet = new GridPosition(net.minecraft.util.Mth.floor(target.x), net.minecraft.util.Mth.floor(target.y), net.minecraft.util.Mth.floor(target.z));
		if (world.cellAt(targetFeet) != WalkabilityView.Cell.CLEAR
				|| world.cellAt(targetFeet.above()) != WalkabilityView.Cell.CLEAR
				|| world.cellAt(targetFeet.below()) != WalkabilityView.Cell.SAFE_SUPPORT
				|| !world.isStandable(targetFeet)) return false;
		boolean unknown = false;
		int samples = Math.max(1, (int) Math.ceil(body.distanceTo(target) / 0.1D));
		for (int i = 0; i <= samples; i++) {
			Vec3 point = body.lerp(target, (double) i / samples);
			GridPosition feet = new GridPosition(net.minecraft.util.Mth.floor(point.x), net.minecraft.util.Mth.floor(point.y), net.minecraft.util.Mth.floor(point.z));
			for (GridPosition cell : new GridPosition[] {feet, feet.above()}) {
				WalkabilityView.Cell state = world.cellAt(cell);
				if (state != WalkabilityView.Cell.CLEAR && state != WalkabilityView.Cell.UNLOADED) return false;
				unknown |= state == WalkabilityView.Cell.UNLOADED;
			}
			WalkabilityView.Cell support = world.cellAt(feet.below());
			if (support != WalkabilityView.Cell.SAFE_SUPPORT && support != WalkabilityView.Cell.UNLOADED) return false;
			unknown |= support == WalkabilityView.Cell.UNLOADED;
		}
		return unknown;
	}
}
