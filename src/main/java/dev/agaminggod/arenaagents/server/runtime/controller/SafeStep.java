package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.server.level.ServerPlayer;

/** The fight/flee footing probe for callers outside this package: two known safe cells along a heading. */
public final class SafeStep {
	/** Deepest fall {@link #dropDepth} counts; deeper (or the void) reports this. */
	public static final int MAX_COUNTED_DROP = 64;
	private static final int[][] CARDINALS = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};

	private SafeStep() {
	}

	/** True when walking along {@code yaw} keeps known safe footing, with the knockback margin while a threat is close. */
	public static boolean canStep(ServerPlayer player, float yaw) {
		return CombatPlanning.canStep(ObservedTerrain.of(player), standing(player), yaw, CombatMoveText.knockbackMargin(player));
	}

	/**
	 * The first heading of {@code offsets} around {@code awayYaw} that keeps safe footing, or null. Headings that keep
	 * the knockback margin win; when the margin refuses them all (the body stands on an edge with the threat inland),
	 * a heading with plain safe footing (along the edge) is taken instead, since standing still there takes the hit anyway.
	 * {@code previous}, the heading already being run, is kept while it stays within the offsets' spread of
	 * {@code awayYaw} and safe: re-picking every tick among threats on several sides swung the view and the body never ran.
	 */
	public static Float heading(ServerPlayer player, float awayYaw, float[] offsets, Float previous) {
		return heading(player, awayYaw, offsets, previous, yaw -> false);
	}

	/**
	 * As above, preferring headings that {@code avoid} does not refuse (such as a run into a harmful cloud); when every
	 * safe heading is refused, the plain safe heading is taken, as before.
	 */
	public static Float heading(ServerPlayer player, float awayYaw, float[] offsets, Float previous, java.util.function.Predicate<Float> avoid) {
		return heading(player, awayYaw, offsets, previous, List.of(avoid));
	}

	/**
	 * As above with preferences in order: the first safe heading that the first predicate does not refuse, else the
	 * first that the second does not refuse, and so on, else the plain safe heading.
	 */
	public static Float heading(ServerPlayer player, float awayYaw, float[] offsets, Float previous,
			List<java.util.function.Predicate<Float>> preferences) {
		for (java.util.function.Predicate<Float> avoid : preferences) {
			Float preferred = heading(player, awayYaw, offsets, previous, avoid, true);
			if (preferred != null) return preferred;
		}
		return heading(player, awayYaw, offsets, previous, yaw -> false, false);
	}

	private static Float heading(ServerPlayer player, float awayYaw, float[] offsets, Float previous, java.util.function.Predicate<Float> avoid,
			boolean avoiding) {
		WalkabilityView world = ObservedTerrain.of(player);
		GridPosition feet = standing(player);
		CombatPlanning.Margin margin = CombatMoveText.knockbackMargin(player);
		float spread = 0.0F;
		for (float offset : offsets) spread = Math.max(spread, Math.abs(offset));
		for (CombatPlanning.Margin pass : margin.active() ? List.of(margin, CombatPlanning.Margin.NONE) : List.of(margin)) {
			if (previous != null && Math.abs(net.minecraft.util.Mth.wrapDegrees(previous - awayYaw)) <= spread
					&& CombatPlanning.canStep(world, feet, previous, pass) && !(avoiding && avoid.test(previous))) return previous;
			for (float offset : offsets) {
				float yaw = net.minecraft.util.Mth.wrapDegrees(awayYaw + offset);
				if (CombatPlanning.canStep(world, feet, yaw, pass) && !(avoiding && avoid.test(yaw))) return yaw;
			}
		}
		return null;
	}

	/** What keeps a heading from safe footing, as the player knows the terrain. */
	public enum Barrier { UNSEEN, WALL, DROP, VOID, HAZARD }

	/** Why one heading is refused: the barrier, the cell where it starts, and for a DROP the known fall depth. */
	public record Blocked(float yaw, Barrier barrier, GridPosition at, int drop) {
		/** Vanilla fall damage for this drop (blocks fallen minus 3), before armour enchantments. */
		public int fallDamage() {
			return barrier == Barrier.DROP ? Math.max(0, drop - 3) : 0;
		}
	}

	/**
	 * Why walking along {@code yaw} has no safe footing (no knockback margin), or null when it has. Unseen cells read
	 * as UNSEEN rather than as a wall or a drop, so a caller can look before it gives up; a drop names how far the body
	 * would fall onto known ground, VOID when nothing is below, HAZARD for lava or fire at the bottom.
	 */
	public static Blocked blocked(ServerPlayer player, float yaw) {
		WalkabilityView world = ObservedTerrain.of(player);
		GridPosition feet = standing(player);
		CombatPlanning.Refusal refusal = CombatPlanning.refusal(world, feet, yaw);
		if (refusal == null) return null;
		GridPosition at = refusal.at();
		return switch (refusal.kind()) {
			case UNLOADED -> new Blocked(yaw, Barrier.UNSEEN, at, 0);
			case HAZARD -> new Blocked(yaw, Barrier.HAZARD, at, 0);
			case WALL, LOW_CEILING -> new Blocked(yaw, world.cellAt(at) == WalkabilityView.Cell.UNLOADED ? Barrier.UNSEEN : Barrier.WALL, at, 0);
			case DROP -> {
				for (int depth = 1; depth <= MAX_COUNTED_DROP; depth++) {
					GridPosition below = at.below(depth);
					if (at.y() - depth < player.level().getMinY()) yield new Blocked(yaw, Barrier.VOID, at, MAX_COUNTED_DROP);
					WalkabilityView.Cell kind = world.cellAt(below);
					if (kind == WalkabilityView.Cell.WATER) yield new Blocked(yaw, Barrier.DROP, at, 0);
					if (kind == WalkabilityView.Cell.HAZARD) yield new Blocked(yaw, Barrier.HAZARD, below, depth);
					if (kind == WalkabilityView.Cell.UNLOADED) {
						// Nothing known below: the void when the column is empty to the world's bottom, else unseen.
						boolean empty = dev.agaminggod.arenaagents.server.perception.VoidColumn.below(player.level(), at.x(), at.y(), at.z());
						yield new Blocked(yaw, empty ? Barrier.VOID : Barrier.UNSEEN, below, depth);
					}
					if (!CombatPlanning.open(world, below)) yield new Blocked(yaw, Barrier.DROP, at, depth - 1);
				}
				yield new Blocked(yaw, Barrier.VOID, at, MAX_COUNTED_DROP);
			}
		};
	}

	/** How close to a face over a damaging drop the body's centre may end a move (blocks); a hit's knockback is about this. */
	public static final double BRINK_MARGIN = 0.4D;

	/**
	 * The centre of the footing cell to step back to when the body stands on the brink of the void or a damaging drop the
	 * player has seen (its centre within {@link #BRINK_MARGIN} of that face, or already over it), else null. A run that
	 * ends there is pushed off by the next hit: live End games 2026-10-23 dodged dragon breath to the edge of the 5x5
	 * arrival platform, stood on it with the centre 0.1 past the face, and a dragon hit knocked the body into the void.
	 */
	public static net.minecraft.world.phys.Vec3 brinkRetreat(ServerPlayer player) {
		return brinkRetreat(player, cell -> false);
	}

	/** As above, never stepping into a cell {@code avoid} refuses (a harmful cloud) when going farther in. */
	public static net.minecraft.world.phys.Vec3 brinkRetreat(ServerPlayer player, java.util.function.Predicate<GridPosition> avoid) {
		if (!player.onGround() || player.isInWater() || player.onClimbable()) return null;
		WalkabilityView world = ObservedTerrain.of(player);
		int y = net.minecraft.util.Mth.floor(player.getY() + 1.0E-4D);
		double x = player.getX(), z = player.getZ();
		int cx = net.minecraft.util.Mth.floor(x), cz = net.minecraft.util.Mth.floor(z);
		// The footing cell nearest the centre among those the 0.6-wide body overlaps.
		GridPosition support = null;
		double best = Double.POSITIVE_INFINITY;
		for (int dx = -1; dx <= 1; dx++) for (int dz = -1; dz <= 1; dz++) {
			GridPosition cell = new GridPosition(cx + dx, y, cz + dz);
			double ox = Math.max(cell.x() - x, x - (cell.x() + 1)), oz = Math.max(cell.z() - z, z - (cell.z() + 1));
			if (ox >= 0.3D || oz >= 0.3D || !CombatPlanning.walkable(world, cell)) continue;
			double d = Math.hypot(cell.x() + 0.5D - x, cell.z() + 0.5D - z);
			if (d < best) { best = d; support = cell; }
		}
		if (support == null) return null;
		boolean brink = support.x() != cx || support.z() != cz;
		for (int[] step : CARDINALS) {
			if (brink) break;
			// Distance from the centre to the face shared with this neighbour.
			double toFace = step[0] > 0 ? support.x() + 1 - x : step[0] < 0 ? x - support.x() : step[1] > 0 ? support.z() + 1 - z : z - support.z();
			if (toFace >= BRINK_MARGIN) continue;
			GridPosition beside = new GridPosition(support.x() + step[0], y, support.z() + step[1]);
			if (dropDepth(player, beside) > 3) brink = true;
		}
		if (!brink) return null;
		// Farther in when it can: a cell beside the footing with no damaging drop beside it (the middle of a 5x5 platform),
		// unless that is inside the cloud the run fled: a breath cloud's hit shoves the body away from its centre, and from
		// the cell back in the cloud the shove went over the rim (replay of the 2026-10-23 platform death).
		GridPosition inner = null;
		best = Double.POSITIVE_INFINITY;
		for (int dx = -1; dx <= 1; dx++) for (int dz = -1; dz <= 1; dz++) {
			if (Math.abs(dx) + Math.abs(dz) > 1) continue;
			GridPosition cell = new GridPosition(support.x() + dx, y, support.z() + dz);
			if (!CombatPlanning.walkable(world, cell) || !innerCell(player, cell) || avoid.test(cell)) continue;
			double d = Math.hypot(cell.x() + 0.5D - x, cell.z() + 0.5D - z);
			if (d < best) { best = d; inner = cell; }
		}
		GridPosition to = inner != null ? inner : support;
		return new net.minecraft.world.phys.Vec3(to.x() + 0.5D, y, to.z() + 0.5D);
	}

	/** No damaging drop beside {@code cell}: a body at its centre has a block or more of footing every way. */
	private static boolean innerCell(ServerPlayer player, GridPosition cell) {
		for (int[] step : CARDINALS) if (dropDepth(player, new GridPosition(cell.x() + step[0], cell.y(), cell.z() + step[1])) > 3) return false;
		return true;
	}

	/** Whether a cell beside {@code cells} (at feet or footing level) is one the player has not seen. */
	public static boolean unseenBeside(ServerPlayer player, java.util.Collection<GridPosition> cells) {
		WalkabilityView world = ObservedTerrain.of(player);
		for (GridPosition cell : cells) {
			for (int[] step : CARDINALS) {
				GridPosition side = new GridPosition(cell.x() + step[0], cell.y(), cell.z() + step[1]);
				if (world.cellAt(side) == WalkabilityView.Cell.UNLOADED || world.cellAt(side.below()) == WalkabilityView.Cell.UNLOADED) return true;
			}
		}
		return false;
	}

	/** Compass word for a yaw (Minecraft: 0 faces south, 90 west). */
	public static String compass(float yaw) {
		String[] names = {"S", "SW", "W", "NW", "N", "NE", "E", "SE"};
		return names[Math.floorMod(Math.round(net.minecraft.util.Mth.wrapDegrees(yaw) / 45.0F), 8)];
	}

	/** Whether the first cell along {@code yaw} is a step up the body must jump onto. */
	public static boolean jumpAhead(ServerPlayer player, float yaw) {
		return CombatPlanning.probe(ObservedTerrain.of(player), standing(player), yaw).jump();
	}

	public static GridPosition feet(ServerPlayer player) {
		return standing(player);
	}

	/** Cells an airborne body may sit above the footing it will land on and still count as standing there. */
	private static final int LANDING_CELLS = 2;

	/**
	 * The cell the body stands in, or the one it lands in while airborne. Knocked up by a hit or mid-hop down a step, the
	 * feet cell (floor of y + 0.2) is a cell above the footing, and every probe from there met the step's ceiling: live
	 * run d19-iron-b, a zombie in a dug staircase, "no safe heading away: wall E, SE, NE, S, N, SW, NW" with the stairs
	 * down free behind the body, and no known-ground path either (the search started from a cell with no floor).
	 */
	public static GridPosition standing(ServerPlayer player) {
		return standing(ObservedTerrain.of(player), CombatMoveText.feet(player), player.onGround() || player.isInWater() || player.onClimbable());
	}

	/** As above over a view of the terrain: {@code supported} says the body is on the ground, swimming or climbing. */
	public static GridPosition standing(WalkabilityView world, GridPosition feet, boolean supported) {
		if (supported || CombatPlanning.walkable(world, feet)) return feet;
		GridPosition cell = feet;
		for (int depth = 1; depth <= LANDING_CELLS && CombatPlanning.open(world, cell.below()); depth++) {
			cell = cell.below();
			if (CombatPlanning.walkable(world, cell)) return cell;
		}
		return feet;
	}

	/**
	 * How far the body would fall stepping into the cell at feet level {@code cell}, from terrain the player has seen:
	 * 0 for footing there or a wall, otherwise the open cells below it (up to {@link #MAX_COUNTED_DROP}; the void and
	 * unseen depths count as the most). Falling into water counts as no drop; a hazard below counts as the most.
	 */
	public static int dropDepth(ServerPlayer player, GridPosition cell) {
		WalkabilityView world = ObservedTerrain.of(player);
		if (CombatPlanning.walkable(world, cell) || !CombatPlanning.open(world, cell)) return 0;
		for (int depth = 1; depth <= MAX_COUNTED_DROP; depth++) {
			GridPosition below = cell.below(depth);
			if (cell.y() - depth < player.level().getMinY()) return MAX_COUNTED_DROP;
			WalkabilityView.Cell kind = world.cellAt(below);
			if (kind == WalkabilityView.Cell.WATER) return 0;
			if (kind == WalkabilityView.Cell.HAZARD || kind == WalkabilityView.Cell.UNLOADED) return MAX_COUNTED_DROP;
			if (!CombatPlanning.open(world, below)) return depth - 1;
		}
		return MAX_COUNTED_DROP;
	}

	/**
	 * Cells the body can walk to from its feet in at most {@code maxSteps} cardinal steps over seen terrain, using the
	 * flee probe's footing rules (walk, swim or climb; a one-block step up; a damage-free drop). Breadth first, so the
	 * map is ordered by path length and each cell maps to the cell it is reached from (the feet map to null).
	 */
	public static Map<GridPosition, GridPosition> reachable(ServerPlayer player, int maxSteps, int maxCells) {
		return reachable(ObservedTerrain.of(player), standing(player), maxSteps, maxCells);
	}

	/** As above, over a given view of the terrain from {@code start}. */
	public static Map<GridPosition, GridPosition> reachable(WalkabilityView world, GridPosition start, int maxSteps, int maxCells) {
		Map<GridPosition, GridPosition> parents = new LinkedHashMap<>();
		Map<GridPosition, Integer> depth = new LinkedHashMap<>();
		parents.put(start, null);
		depth.put(start, 0);
		Deque<GridPosition> queue = new ArrayDeque<>();
		queue.add(start);
		while (!queue.isEmpty() && parents.size() < maxCells) {
			GridPosition from = queue.removeFirst();
			int steps = depth.get(from);
			if (steps >= maxSteps) continue;
			for (int[] step : CARDINALS) {
				GridPosition next = next(world, from, step[0], step[1]);
				if (next == null || parents.containsKey(next)) continue;
				parents.put(next, from);
				depth.put(next, steps + 1);
				queue.addLast(next);
			}
		}
		return parents;
	}

	/**
	 * A way away from a threat at ({@code threatX}, {@code threatZ}) along cells the player knows it can walk (seen now,
	 * remembered, or walked in the last 30 s), as a player in a tunnel backs along the way it came: the path to the
	 * reachable cell farthest from the threat, at least {@code minGain} blocks farther than the feet, that never passes
	 * nearer the threat than the feet are (half a block of slack for a bend) and has no cell {@code refuse} rejects.
	 * Null when there is none.
	 */
	public static List<GridPosition> awayPath(WalkabilityView world, GridPosition feet, double threatX, double threatZ, int maxSteps,
			int maxCells, double minGain, java.util.function.Predicate<GridPosition> refuse) {
		Map<GridPosition, GridPosition> parents = reachable(world, feet, maxSteps, maxCells);
		double from = separation(feet, threatX, threatZ);
		double nearest = from - 0.5D;
		GridPosition best = null;
		double bestSeparation = from + minGain - 1.0E-9D;
		// Breadth-first order: among equally far cells the first found has the shortest path.
		for (GridPosition cell : parents.keySet()) {
			double separation = separation(cell, threatX, threatZ);
			if (separation <= bestSeparation || refuse.test(cell)) continue;
			boolean clear = true;
			for (GridPosition step = parents.get(cell); step != null && clear; step = parents.get(step)) {
				clear = separation(step, threatX, threatZ) >= nearest && (step.equals(feet) || !refuse.test(step));
			}
			if (!clear) continue;
			best = cell;
			bestSeparation = separation;
		}
		return best == null ? null : pathTo(parents, best);
	}

	private static double separation(GridPosition cell, double x, double z) {
		return Math.hypot(cell.x() + 0.5D - x, cell.z() + 0.5D - z);
	}

	/** {@link #awayPath} over this player's knowledge of the terrain, from its feet. */
	public static List<GridPosition> awayPath(ServerPlayer player, double threatX, double threatZ, int maxSteps, int maxCells, double minGain,
			java.util.function.Predicate<GridPosition> refuse) {
		return awayPath(ObservedTerrain.of(player), standing(player), threatX, threatZ, maxSteps, maxCells, minGain, refuse);
	}

	/** The path from the feet to {@code goal} (excluding the feet), or null when it is not in {@code parents}. */
	public static List<GridPosition> pathTo(Map<GridPosition, GridPosition> parents, GridPosition goal) {
		if (!parents.containsKey(goal)) return null;
		List<GridPosition> path = new ArrayList<>();
		for (GridPosition cell = goal; parents.get(cell) != null; cell = parents.get(cell)) path.add(cell);
		Collections.reverse(path);
		return path;
	}

	/** The cell one cardinal step from {@code from} reaches, or null when the step is not safe. */
	private static GridPosition next(WalkabilityView world, GridPosition from, int dx, int dz) {
		GridPosition reached = step(world, from, dx, dz);
		// Never from outside a seen lava flow's way into it (as the flee probe); inside it, cells on the way out stay open.
		return reached == null || CombatPlanning.flowRefused(world, from, reached) ? null : reached;
	}

	private static GridPosition step(WalkabilityView world, GridPosition from, int dx, int dz) {
		GridPosition level = new GridPosition(from.x() + dx, from.y(), from.z() + dz);
		if (CombatPlanning.walkable(world, level)) return level;
		if (CombatPlanning.walkable(world, level.above()) && CombatPlanning.open(world, from.above(2)) && world.canJumpUp(from, level.above())) {
			return level.above();
		}
		int drop = CombatPlanning.dropTo(world, level);
		return drop == 0 ? null : level.below(drop);
	}

	/** The cells of {@code cells} that lava this player has seen flows into (beside their feet or head, or over them). */
	public static java.util.Set<GridPosition> lavaFlows(ServerPlayer player, java.util.Collection<GridPosition> cells) {
		WalkabilityView world = ObservedTerrain.of(player);
		java.util.Set<GridPosition> flows = new java.util.HashSet<>();
		for (GridPosition cell : cells) if (world.lavaFlowsInto(cell)) flows.add(cell);
		return flows;
	}
}
