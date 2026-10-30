package dev.agaminggod.arenaagents.server.runtime.controller;

/**
 * Pure water rules for the movement the model already chose (flee_from, fight_target, navigate_to). They only make
 * that movement work in water the way a player's does: hold jump to rise and stay afloat, sprint to swim while
 * submerged, look up to surface, and never call an escape done while the agent is under water. Nothing here starts
 * an action; control and control_sequence frames keep the model's own explicit jump and sprint keys.
 */
public final class SwimPlanning {
	/** Vanilla drains one air point per tick under water and starts drowning damage at zero. */
	public static final int AIR_TICKS_PER_SECOND = 20;
	/** Looking this far up while sprint-swimming makes vanilla's swim physics rise toward the surface. */
	public static final float SURFACING_PITCH = -35.0F;
	/** navigate_to gives rising to the surface this long before it reports the start as unreachable. */
	public static final long SURFACING_TIMEOUT_MS = 10_000L;
	/** fight_target in water: a fair swim attempt (10 s) before TARGET_UNREACHABLE; on land it stays 5 s. */
	public static final int WATER_UNREACHABLE_TICKS = 200;
	/**
	 * Flee steering treats a heading through deep water as this many degrees worse than a land heading, so land within
	 * 90 degrees of "away" wins, but open water straight away still beats running back toward the threat.
	 */
	public static final float WATER_PENALTY_DEGREES = 90.0F;
	/** Drowned (and guardians) swim faster than a player; water is then a last resort. */
	public static final float AQUATIC_THREAT_WATER_PENALTY_DEGREES = 180.0F;

	private SwimPlanning() {
	}

	/** In water a player holds jump to rise and stay afloat; at a shore it also climbs out (vanilla water step). */
	public static boolean holdJump(boolean inWater) {
		return inWater;
	}

	/**
	 * Hold jump only when the body must rise or stay afloat: off the ground in water, or with the eyes under water.
	 * Standing in one-deep or waterlogged blocks it would only hop.
	 */
	public static boolean floatJump(boolean inWater, boolean onGround, boolean eyesInWater) {
		return inWater && (!onGround || eyesInWater);
	}

	/** Sprint-swim while the eyes are under water and moving forward, as a player does; never at the surface. */
	public static boolean swimSprint(boolean inWater, boolean eyesInWater, float forward, int foodLevel) {
		return inWater && eyesInWater && forward > 0.0F && foodLevel > 6;
	}

	/** View pitch for movement: look up to surface while the eyes are under water, otherwise the caller's pitch. */
	public static float swimPitch(boolean inWater, boolean eyesInWater, float pitch) {
		return inWater && eyesInWater ? SURFACING_PITCH : pitch;
	}

	/**
	 * Fight in water: while swimming hold jump (stay up, reach targets at or above) unless the target is clearly below,
	 * where releasing it lets the agent sink and sprint-swim down toward it.
	 */
	public static boolean fightJump(boolean swimming, double targetDy) {
		return swimming && targetDy > -1.0D;
	}

	/** Ticks without a hit or gained ground before TARGET_UNREACHABLE; only an agent that must swim gets longer. */
	public static int unreachableTicks(boolean agentSwimming, int landTicks) {
		return agentSwimming ? Math.max(landTicks, WATER_UNREACHABLE_TICKS) : landTicks;
	}

	/** Whether the eyes are submerged; this fact alone never starts a surfacing action. */
	public static boolean needsSurfacing(boolean inWater, boolean eyesInWater) {
		return inWater && eyesInWater;
	}

	/** Conservative swim speed for breath budgeting (the headless check measured about 3.5 blocks/s rising). */
	public static final double SURFACING_BLOCKS_PER_SECOND = 2.0D;
	/** Surfacing must close this much distance to the open surface every second, or it is blocked. */
	public static final double SURFACING_MIN_PROGRESS = 0.25D;
	public static final long SURFACING_PROGRESS_WINDOW_MS = 1_000L;
	/** Columns searched around the agent for open water surface, and the deepest water column followed. */
	public static final int SURFACE_SEARCH_RADIUS = 8;
	public static final int SURFACE_SEARCH_DEPTH = 24;

	/** What one cell is to a swimmer heading up: water to swim through, open air (the surface), or solid (ice, rock). */
	public enum Cell { WATER, RISING_WATER, SINKING_WATER, OPEN, SOLID, UNKNOWN }

	@FunctionalInterface
	public interface ColumnView {
		Cell at(int x, int y, int z);
	}

	/** The acquired eye-cell path ends in air; a low pocket supplies breath without standing headroom. */
	public record Surface(int x, int openY, int z, double distance, boolean breathOnly,
			java.util.List<net.minecraft.core.BlockPos> path) { }

	public static boolean swimmable(Cell cell) {
		return cell == Cell.WATER || cell == Cell.RISING_WATER;
	}

	/** One bounded slice, shared by observation and navigation for a player in a server tick. */
	public static final int SURFACE_CELLS_PER_TICK = 256;

	/** Retains the BFS frontier and visited cells across slices; unknown and magma columns stop search. */
	public static final class SurfaceSearch {
		private record Step(net.minecraft.core.BlockPos pos, int distance, Step parent) { }
		private final java.util.ArrayDeque<Step> queue = new java.util.ArrayDeque<>();
		private final java.util.HashSet<net.minecraft.core.BlockPos> visited = new java.util.HashSet<>();
		private final int x, eyeY, z;
		private Surface result;
		private boolean complete;
		public SurfaceSearch(int x, int eyeY, int z) {
			this.x = x; this.eyeY = eyeY; this.z = z;
			var origin = new net.minecraft.core.BlockPos(x, eyeY, z);
			queue.add(new Step(origin, 0, null)); visited.add(origin);
		}
		public boolean complete() { return complete; }
		public Surface result() { return result; }
		public int visitedCells() { return visited.size(); }
		public void advance(ColumnView view, int budget) {
			int[][] directions = {{0, 1, 0}, {1, 0, 0}, {-1, 0, 0}, {0, 0, 1}, {0, 0, -1}};
			while (!complete && budget-- > 0 && !queue.isEmpty()) {
				Step step = queue.removeFirst();
				var pos = step.pos;
				Cell cell = view.at(pos.getX(), pos.getY(), pos.getZ());
				if (!swimmable(cell) && cell != Cell.OPEN) continue;
				Cell below = view.at(pos.getX(), pos.getY() - 1, pos.getZ());
				if (!swimmable(below) && below != Cell.OPEN) continue;
				if (cell == Cell.OPEN) {
					var path = new java.util.ArrayList<net.minecraft.core.BlockPos>();
					for (Step cursor = step; cursor != null; cursor = cursor.parent) path.add(cursor.pos);
					java.util.Collections.reverse(path);
					result = new Surface(pos.getX(), pos.getY(), pos.getZ(), step.distance,
							view.at(pos.getX(), pos.getY() + 1, pos.getZ()) != Cell.OPEN, java.util.List.copyOf(path));
					complete = true;
					return;
				}
				for (int[] direction : directions) {
					int nx = pos.getX() + direction[0], ny = pos.getY() + direction[1], nz = pos.getZ() + direction[2];
					if (ny - eyeY > SURFACE_SEARCH_DEPTH || (nx - x) * (nx - x) + (nz - z) * (nz - z)
							> SURFACE_SEARCH_RADIUS * SURFACE_SEARCH_RADIUS) continue;
					var next = new net.minecraft.core.BlockPos(nx, ny, nz);
					if (visited.add(next)) queue.addLast(new Step(next, step.distance + 1, step));
				}
			}
			if (queue.isEmpty()) complete = true;
		}
	}

	/** Pure complete search for callers without a tick loop (verification). Live callers retain bounded slices. */
	public static Surface nearestSurface(ColumnView view, int x, int eyeY, int z) {
		var search = new SurfaceSearch(x, eyeY, z);
		while (!search.complete()) search.advance(view, SURFACE_CELLS_PER_TICK);
		return search.result();
	}

	/** Enough breath to swim the distance to the surface at a conservative speed (fail fast otherwise). */
	public static boolean surfacingFeasible(int air, double distance) {
		return airSecondsLeft(air) >= distance / SURFACING_BLOCKS_PER_SECOND;
	}

	/** Breath budgeting keeps three seconds in reserve for ordinary dives; an authored breathable target can use it. */
	public static final int AIR_RESERVE_TICKS = 60;

	/**
	 * Submerged cells the current breath covers at the conservative swim speed, keeping the reserve, capped at the
	 * planner's full-breath run. This bounds how far a route may stay under water before it reaches air.
	 */
	public static int breathNodes(int air) {
		double seconds = Math.max(0, air - AIR_RESERVE_TICKS) / (double) AIR_TICKS_PER_SECOND;
		return (int) Math.min(dev.agaminggod.arenaagents.client.navigation.LocalPathfinder.FULL_BREATH_SUBMERGED_NODES,
				Math.floor(seconds * SURFACING_BLOCKS_PER_SECOND));
	}

	/** A chosen breathable target can use the reserve; failing that budget must still leave the model in control. */
	public static int navigationBreathNodes(int air, boolean breathableTarget) {
		return breathNodes(breathableTarget ? Math.max(0, air) + AIR_RESERVE_TICKS : air);
	}

	/** The breath left covers the submerged cells ahead before the route reaches air. */
	public static boolean breathCovers(int air, int submergedNodesAhead) {
		return submergedNodesAhead <= breathNodes(air);
	}

	/**
	 * navigate_to's jump key in water: held to rise or stay afloat, released when the next waypoint is clearly below
	 * so the body sinks toward it (diving down a flooded shaft), and released over a submerged-floor endpoint so the
	 * body settles onto it like a player letting go of space.
	 */
	public static boolean navigationJump(boolean swimming, double targetDy, boolean settleOnFloor) {
		return swimming && !settleOnFloor && targetDy > -0.5D;
	}

	/** Seconds of breath left before drowning damage starts (Respiration only makes it last longer). */
	public static double airSecondsLeft(int air) {
		return Math.max(0, air) / (double) AIR_TICKS_PER_SECOND;
	}

	/**
	 * Eye height to steer toward when surfacing: the breathable cell's floor is the lowest acceptable eye height, not a
	 * target, so a body whose eyes are already higher keeps its height instead of being driven down into a shore floor.
	 */
	public static double surfacingEyeY(int openY, double eyeY) {
		return Math.max(openY, eyeY);
	}
}
