package dev.agaminggod.arenaagents.server.runtime.controller;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Action-wide body evidence. Advancement along an accepted path counts even when a detour moves away from the goal.
 * Each replacement path starts its own distance baseline without earning progress. Only measured movement reducing
 * that distance or the destination distance resets the gain window; closest-position facts remain goal-relative.
 */
final class RouteProgress {
	/** Coarse goal-distance baseline used to size the no-gain travel allowance. */
	static final double MATERIAL_GAIN = 0.5D;
	/** Local envelope for a stop only when neither route nor destination distance improved. */
	static final double STILL_DISTANCE = 1.0D;
	/** Time without measured route advancement inside the local envelope, excluding catching breath. */
	static final long STILL_MS = 8_000L;
	/** Walking without getting closer: the detour allowance is twice the best remaining distance plus this. */
	static final double DETOUR_SLACK = 32.0D;
	/** Breadcrumb spacing along the walked track. */
	static final double CRUMB_SPACING = 2.0D;
	/** Back within this horizontal distance (and two blocks of height) of an earlier crumb means the same place. */
	static final double REVISIT_RADIUS = 1.5D;
	/** A revisit counts only after walking at least this far since the crumb, and since the last gain. */
	static final double LOOP_MIN_WALK = 16.0D;
	private static final int MAX_CRUMBS = 512;

	private final double startDistance;
	private double best;
	private double closest;
	private double bestX, bestY, bestZ;
	private double walkedAtBest;
	private double walked;
	private double lastX, lastY, lastZ;
	private double anchorX, anchorY, anchorZ;
	private long anchorMs;
	private double crumbWalked;
	private final List<double[]> crumbs = new ArrayList<>();
	private double plannedBest = Double.NaN;
	private long gainSerial;
	private long gainAtReplan = -1;
	private double stallX, stallY, stallZ;

	RouteProgress(double x, double y, double z, double remaining, long elapsedMs) {
		startDistance = remaining;
		best = closest = remaining;
		bestX = lastX = anchorX = x;
		bestY = lastY = anchorY = y;
		bestZ = lastZ = anchorZ = z;
		anchorMs = elapsedMs;
		crumbs.add(new double[] {x, y, z, 0.0D});
	}

	/** Establishes a new route metric without counting the replan itself as body progress. */
	void beginPlan(double remaining) {
		// A shorter replacement plan is not body progress. Only subsequent measured advancement counts.
		plannedBest = remaining;
	}

	Stop observe(double x, double y, double z, double remaining, long elapsedMs, boolean breathing) {
		return observe(x, y, z, remaining, Double.NaN, elapsedMs, breathing);
	}

	/** Folds a measured body sample into progress; breathing exempts waits for air. */
	Stop observe(double x, double y, double z, double remaining, double pathRemaining, long elapsedMs, boolean breathing) {
		if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(z) || !Double.isFinite(remaining)) return null;
		double movement = Math.sqrt((x - lastX) * (x - lastX) + (y - lastY) * (y - lastY) + (z - lastZ) * (z - lastZ));
		double step = Math.hypot(x - lastX, z - lastZ);
		boolean advancing = movement > 0.0D && ((Double.isFinite(pathRemaining) && pathRemaining < plannedBest)
				|| remaining < closest);
		if (Double.isFinite(pathRemaining)) plannedBest = Math.min(plannedBest, pathRemaining);
		walked += step;
		lastX = x;
		lastY = y;
		lastZ = z;
		if (remaining < closest) {
			closest = remaining;
			bestX = x;
			bestY = y;
			bestZ = z;
		}
		if (remaining < best - MATERIAL_GAIN || remaining < best && remaining <= MATERIAL_GAIN) {
			best = remaining;
			walkedAtBest = walked;
		}
		if (advancing) {
			walkedAtBest = walked;
			gainSerial++;
		}
		if (advancing || Math.hypot(x - anchorX, z - anchorZ) > STILL_DISTANCE || Math.abs(y - anchorY) > STILL_DISTANCE || breathing) {
			anchorX = x;
			anchorY = y;
			anchorZ = z;
			anchorMs = elapsedMs;
		} else if (elapsedMs - anchorMs >= STILL_MS) {
			return new Stop(Kind.STILL, String.format(Locale.ROOT,
					"No route gain for %.0fs near %.1f,%.1f,%.1f",
					(elapsedMs - anchorMs) / 1_000.0D, anchorX, anchorY, anchorZ));
		}
		double sinceGain = walked - walkedAtBest;
		if (sinceGain >= 2.0D * best + DETOUR_SLACK) {
			return new Stop(Kind.NOT_CONVERGING, String.format(Locale.ROOT,
					"Walked %.0f blocks without route gain", sinceGain));
		}
		if (sinceGain >= LOOP_MIN_WALK) {
			for (double[] crumb : crumbs) {
				if (crumb[3] < walkedAtBest || walked - crumb[3] < LOOP_MIN_WALK) continue;
				if (Math.hypot(x - crumb[0], z - crumb[2]) <= REVISIT_RADIUS && Math.abs(y - crumb[1]) <= 2.0D) {
					return new Stop(Kind.CIRCLING, String.format(Locale.ROOT,
							"Back at %.0f,%.0f,%.0f after %.0f blocks without route gain",
							crumb[0], crumb[1], crumb[2], walked - crumb[3]));
				}
			}
		}
		crumbWalked += step;
		if (crumbWalked >= CRUMB_SPACING) {
			crumbWalked = 0.0D;
			crumbs.add(new double[] {x, y, z, walked});
			if (crumbs.size() > MAX_CRUMBS) crumbs.remove(0);
		}
		return null;
	}

	/** Records a stall replan; a later stall must also be near this body position to repeat it. */
	void stallReplanned() {
		gainAtReplan = gainSerial;
		stallX = lastX; stallY = lastY; stallZ = lastZ;
	}

	/** True only for a nearby repeated stall without measured route advancement. */
	boolean noGainSinceStallReplan() {
		return gainAtReplan >= 0 && gainSerial == gainAtReplan
				&& Math.sqrt((lastX - stallX) * (lastX - stallX) + (lastY - stallY) * (lastY - stallY)
						+ (lastZ - stallZ) * (lastZ - stallZ)) <= REVISIT_RADIUS;
	}

	/** Walked distance, remaining distance and closest point: the reached endpoint the model can plan from. */
	String facts(double remaining) {
		if (walked < 2.0D && Math.abs(startDistance - remaining) < 1.0D) return "";
		return String.format(Locale.ROOT, "; walked %.0f, left %.1f", walked, remaining) + closestFacts();
	}

	String closestFacts() {
		return String.format(Locale.ROOT, "; closest %.1f at %.0f,%.0f,%.0f", closest, Math.floor(bestX), Math.floor(bestY), Math.floor(bestZ));
	}

	double walked() { return walked; }

	double best() { return best; }

	enum Kind { STILL, NOT_CONVERGING, CIRCLING }

	record Stop(Kind kind, String message) {
	}
}
