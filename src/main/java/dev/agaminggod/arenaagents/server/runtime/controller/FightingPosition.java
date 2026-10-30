package dev.agaminggod.arenaagents.server.runtime.controller;

import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.LocalPathfinder;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView.Cell;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.WeakHashMap;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;

/**
 * Where a player under attack could stand instead, from seen terrain only: the nearest walkable cell with no open drop
 * within a hit's push (about 3 blocks, airborne), and the nearest such cell with a roof and at least two solid walls,
 * the fortress nook a player fights blazes from. Runs d9-nether-d, d11-nether-a and d11-nether-g were knocked off
 * fortress bridges (one from full health) while the edge facts said only how far the drop was, and every blaze death
 * that night was spent placing cover one block per turn in the open. A fact, not a move: the model chooses.
 */
public final class FightingPosition {
	/** Path steps searched over seen footing, and the cell budget of that search. */
	static final int MAX_STEPS = 16;
	static final int MAX_CELLS = 600;
	/** How far a hit carries the body's centre (about 3 blocks) plus half its width. */
	static final double PUSH_REACH = 3.3D;
	private static final int[][] SIDES = {{0, -1}, {1, 0}, {0, 1}, {-1, 0}};
	private static final String[] SIDE_NAMES = {"N", "E", "S", "W"};
	private static final Map<ServerPlayer, Cached> CACHE = new WeakHashMap<>();

	private record Cached(GridPosition feet, long tick, JsonObject facts) {}

	private FightingPosition() {}

	/** Null while airborne or when the feet cell is already push-safe and covered. Reuses one answer per cell for 10 ticks. */
	public static JsonObject facts(ServerPlayer player) {
		if (!player.onGround()) return null;
		GridPosition feet = SafeStep.feet(player);
		long tick = player.level().getGameTime();
		Cached cached = CACHE.get(player);
		if (cached != null && cached.feet.equals(feet) && tick >= cached.tick && tick - cached.tick < 10) return cached.facts == null ? null : cached.facts.deepCopy();
		JsonObject facts = compute(player, feet);
		CACHE.put(player, new Cached(feet, tick, facts));
		return facts == null ? null : facts.deepCopy();
	}

	private static JsonObject compute(ServerPlayer player, GridPosition feet) {
		WalkabilityView world = ObservedTerrain.of(player);
		Map<GridPosition, Boolean> columns = new HashMap<>();
		Map<GridPosition, GridPosition> reach = SafeStep.reachable(player, MAX_STEPS, MAX_CELLS);
		boolean hereSafe = world.isStandable(feet) && pushSafe(world, feet, columns);
		Cover hereCover = cover(world, feet);
		if (hereSafe && hereCover.covered()) return null;
		JsonObject facts = new JsonObject();
		JsonObject here = new JsonObject();
		here.addProperty("pushSafe", hereSafe);
		here.addProperty("roof", hereCover.roof);
		here.addProperty("walls", hereCover.walls);
		facts.add("here", here);
		GridPosition safe = hereSafe ? feet : null, covered = null;
		for (GridPosition cell : reach.keySet()) {
			if (safe != null && covered != null) break;
			if (cell.equals(feet) || !world.isStandable(cell)) continue;
			Cover cellCover = null;
			if (covered == null) {
				cellCover = cover(world, cell);
				if (!cellCover.covered()) cellCover = null;
			}
			if (safe != null && cellCover == null) continue;
			if (!pushSafe(world, cell, columns)) continue;
			if (safe == null) {
				safe = cell;
				facts.add("pushSafe", describe(reach, cell, cover(world, cell)));
			}
			if (cellCover != null) {
				covered = cell;
				facts.add("covered", describe(reach, cell, cellCover));
			}
		}
		facts.addProperty("searchedSteps", MAX_STEPS);
		return facts;
	}

	private static JsonObject describe(Map<GridPosition, GridPosition> reach, GridPosition cell, Cover cover) {
		JsonObject row = new JsonObject();
		row.addProperty("x", cell.x());
		row.addProperty("y", cell.y());
		row.addProperty("z", cell.z());
		List<GridPosition> path = SafeStep.pathTo(reach, cell);
		row.addProperty("steps", path == null ? 0 : path.size());
		row.addProperty("roof", cover.roof);
		row.addProperty("walls", cover.walls);
		if (!cover.open.isEmpty()) row.addProperty("open", cover.open);
		return row;
	}

	/**
	 * A roof over the head (the first non-open cell up to 4 above it is solid) and walls solid at feet and head height on
	 * each side. A connected fence row counts: its bars stop a fireball as its posts stop a push.
	 */
	private record Cover(boolean roof, int walls, String open) {
		boolean covered() {
			return roof && walls >= 2;
		}
	}

	private static Cover cover(WalkabilityView world, GridPosition cell) {
		boolean roof = false;
		for (int up = 2; up <= 5; up++) {
			Cell above = world.cellAt(cell.above(up));
			if (above == Cell.CLEAR) continue;
			roof = solid(above);
			break;
		}
		int walls = 0;
		StringBuilder open = new StringBuilder();
		for (int side = 0; side < SIDES.length; side++) {
			GridPosition next = cell.offset(SIDES[side][0], 0, SIDES[side][1]);
			if (solid(world.cellAt(next)) && solid(world.cellAt(next.above()))) walls++;
			else open.append(open.isEmpty() ? "" : ",").append(SIDE_NAMES[side]);
		}
		return new Cover(roof, walls, open.toString());
	}

	private static boolean solid(Cell cell) {
		return cell == Cell.SAFE_SUPPORT || cell == Cell.BLOCKED;
	}

	/**
	 * No push from this cell, in any of 16 headings, carries the body across open floor into a column it would fall more
	 * than {@link LocalPathfinder#MAX_DROP_BLOCKS} down, into lava or fire, or into terrain not seen. A blocked cell at
	 * body height stops the push.
	 */
	static boolean pushSafe(WalkabilityView world, GridPosition cell, Map<GridPosition, Boolean> columns) {
		double cx = cell.x() + 0.5D, cz = cell.z() + 0.5D;
		for (int heading = 0; heading < 16; heading++) {
			double angle = Math.PI / 8.0D * heading, ux = Math.cos(angle), uz = Math.sin(angle);
			int lastX = cell.x(), lastZ = cell.z();
			for (double step = 0.25D; step <= PUSH_REACH; step += 0.25D) {
				int x = Mth.floor(cx + ux * step), z = Mth.floor(cz + uz * step);
				if (x == lastX && z == lastZ) continue;
				lastX = x;
				lastZ = z;
				GridPosition next = new GridPosition(x, cell.y(), z);
				Boolean result = columns.computeIfAbsent(next, key -> column(world, key));
				if (result == null) break;
				if (!result) return false;
			}
		}
		return true;
	}

	/** A knocked-back body falls at least this far before it counts as thrown off (about 1.5 hearts of fall damage). */
	static final int LETHAL_PUSH_DROP = 5;

	/**
	 * Whether a hit's push from {@code (x, z)} along {@code yaw} (within {@link #PUSH_REACH}) carries the body over seen
	 * lava or fire, or off a seen drop of at least {@link #LETHAL_PUSH_DROP} (the void included). A wall at body height
	 * stops the push. Unseen footing is not counted: a fight faces its target, not the ground behind it.
	 */
	public static boolean lethalPush(WalkabilityView world, double x, double z, int feetY, float yaw) {
		double radians = Math.toRadians(yaw), ux = -Math.sin(radians), uz = Math.cos(radians);
		int lastX = Mth.floor(x), lastZ = Mth.floor(z);
		for (double step = 0.25D; step <= PUSH_REACH; step += 0.25D) {
			int cx = Mth.floor(x + ux * step), cz = Mth.floor(z + uz * step);
			if (cx == lastX && cz == lastZ) continue;
			lastX = cx;
			lastZ = cz;
			GridPosition cell = new GridPosition(cx, feetY, cz);
			Cell feet = world.cellAt(cell);
			if (feet == Cell.HAZARD) return true;
			if (feet == Cell.UNLOADED) return false;
			if (!CombatPlanning.open(world, cell) || !CombatPlanning.open(world, cell.above())) return false;
			if (CombatPlanning.walkable(world, cell)) continue;
			for (int depth = 1; depth <= 16; depth++) {
				Cell below = world.cellAt(cell.below(depth));
				if (below == Cell.WATER) break;
				if (below == Cell.HAZARD) return true;
				if (below == Cell.UNLOADED) {
					if (depth > LETHAL_PUSH_DROP) return true;
					break;
				}
				if (!CombatPlanning.open(world, cell.below(depth))) {
					if (depth - 1 >= LETHAL_PUSH_DROP) return true;
					break;
				}
				if (depth == 16) return true;
			}
		}
		return false;
	}

	/**
	 * Horizontal distance from the centre of {@code cell} to the nearest seen lethal drop or hazard over open floor (as
	 * {@link #lethalPush}, in 16 headings, a wall ending a heading), or {@code max} when none lies within it. A dragon's
	 * body throws a player 5-15 blocks; this is how far the nearest edge is for that throw.
	 */
	public static double edgeClearance(WalkabilityView world, GridPosition cell, double max) {
		double cx = cell.x() + 0.5D, cz = cell.z() + 0.5D, nearest = max;
		for (int heading = 0; heading < 16; heading++) {
			float yaw = heading * 22.5F;
			double radians = Math.toRadians(yaw), ux = -Math.sin(radians), uz = Math.cos(radians);
			int lastX = cell.x(), lastZ = cell.z();
			for (double step = 0.5D; step < nearest; step += 0.5D) {
				int x = Mth.floor(cx + ux * step), z = Mth.floor(cz + uz * step);
				if (x == lastX && z == lastZ) continue;
				lastX = x;
				lastZ = z;
				Boolean edge = edgeColumn(world, new GridPosition(x, cell.y(), z));
				if (edge == null) break;
				if (edge) {
					nearest = Math.min(nearest, step);
					break;
				}
			}
		}
		return nearest;
	}

	/**
	 * Whether the body at ({@code x}, {@code z}) keeps footing moving along {@code yaw}: the columns 0.5 and 1 block ahead
	 * of its actual position (not its cell's centre) are walkable, or a damage-free drop onto seen floor. The two-cell probe
	 * steps whole cells, so a body 0.4 from a lip passes it while a circling move curves off (live footwork check).
	 */
	public static boolean footingAhead(WalkabilityView world, double x, double z, int feetY, float yaw) {
		double radians = Math.toRadians(yaw), ux = -Math.sin(radians), uz = Math.cos(radians);
		return footing(world, x, z, feetY, ux, uz, STEP_FOOTING);
	}

	/** A fight step keeps footing this far ahead, so the body never stops within a block of a lip. */
	static final double STEP_FOOTING = 1.5D;

	/**
	 * The world direction (x, z) away from footing missing within {@code reach} of the body (unseen, open or lethal
	 * columns, in eight headings), or null when every heading has footing that near: where a player standing at a lip
	 * steps to get off it.
	 */
	public static double[] inlandFrom(WalkabilityView world, double x, double z, int feetY, double reach) {
		double sumX = 0.0D, sumZ = 0.0D;
		boolean missing = false;
		for (int heading = 0; heading < 8; heading++) {
			double radians = Math.PI / 4.0D * heading, ux = Math.cos(radians), uz = Math.sin(radians);
			if (footing(world, x, z, feetY, ux, uz, reach)) continue;
			missing = true;
			sumX -= ux;
			sumZ -= uz;
		}
		double length = Math.hypot(sumX, sumZ);
		return !missing || length < 1.0E-6D ? null : new double[] {sumX / length, sumZ / length};
	}

	/**
	 * Whether every heading of eight keeps footing within {@code reach} of the body's actual position (as
	 * {@link #footingAhead}): no unseen, open or lethal column that near. A jump there carries the body past the brink
	 * guard, which leaves the body's own jumps alone (live footwork check: a body watching a blaze above the yard edge
	 * had never seen the cells past it, jumped and fell 90 blocks).
	 */
	public static boolean footingAround(WalkabilityView world, double x, double z, int feetY, double reach) {
		for (int heading = 0; heading < 8; heading++) {
			double radians = Math.PI / 4.0D * heading;
			if (!footing(world, x, z, feetY, Math.cos(radians), Math.sin(radians), reach)) return false;
		}
		return true;
	}

	/** Columns every half block along (ux, uz) up to {@code reach}: unseen footing counts as no footing; a wall ends it. */
	private static boolean footing(WalkabilityView world, double x, double z, int feetY, double ux, double uz, double reach) {
		for (double step = 0.5D; step <= reach + 1.0E-6D; step += 0.5D) {
			GridPosition cell = new GridPosition(Mth.floor(x + ux * step), feetY, Mth.floor(z + uz * step));
			Cell feet = world.cellAt(cell);
			if (feet == Cell.UNLOADED || feet == Cell.HAZARD) return false;
			if (!CombatPlanning.open(world, cell) || !CombatPlanning.open(world, cell.above())) return true;
			if (CombatPlanning.walkable(world, cell)) continue;
			if (world.cellAt(cell.below()) == Cell.UNLOADED || CombatPlanning.dropTo(world, cell) == 0) return false;
		}
		return true;
	}

	/** The yaw facing away from footing missing within {@code reach} of the body (see {@link #inlandFrom}), or null. */
	public static Float inlandYaw(ServerPlayer player, double reach) {
		double[] inland = inlandFrom(ObservedTerrain.of(player), player.getX(), player.getZ(), SafeStep.feet(player).y(), reach);
		return inland == null ? null : (float) Math.toDegrees(Math.atan2(-inland[0], inland[1]));
	}

	/** A walk away from the edge: the path (null when none gains a block), the goal's clearance and the feet's. */
	public record EdgeEscape(List<GridPosition> path, double clearance, double here) {}

	/**
	 * The path over seen footing (at most {@code steps} steps) to the nearest standable cell at least {@code blocks} from
	 * every seen lethal drop, else to the reachable cell farthest from one when that gains at least a block. Cells
	 * {@code refuse} rejects (a breath cloud) are skipped.
	 */
	public static EdgeEscape awayFromEdge(ServerPlayer player, double blocks, int steps, int cells,
			java.util.function.Predicate<GridPosition> refuse) {
		WalkabilityView view = ObservedTerrain.of(player);
		GridPosition feet = SafeStep.standing(player);
		double here = edgeClearance(view, feet, blocks);
		if (here >= blocks) return new EdgeEscape(null, here, here);
		Map<GridPosition, GridPosition> reach = SafeStep.reachable(view, feet, steps, cells);
		GridPosition best = null;
		double bestClearance = here;
		for (GridPosition cell : reach.keySet()) {
			if (cell.equals(feet) || !view.isStandable(cell) || refuse.test(cell)) continue;
			double clearance = edgeClearance(view, cell, blocks);
			if (clearance >= blocks) return new EdgeEscape(SafeStep.pathTo(reach, cell), clearance, here);
			if (clearance > bestClearance + 1.0D) {
				bestClearance = clearance;
				best = cell;
			}
		}
		return new EdgeEscape(best == null ? null : SafeStep.pathTo(reach, best), bestClearance, here);
	}

	/**
	 * TRUE: a lethal drop, hazard or footing never seen (an escape from the edge needs footing it knows); FALSE: floor
	 * (or a shallow drop) to cross; null: a wall.
	 */
	private static Boolean edgeColumn(WalkabilityView world, GridPosition cell) {
		Cell feet = world.cellAt(cell);
		if (feet == Cell.HAZARD || feet == Cell.UNLOADED) return Boolean.TRUE;
		if (!CombatPlanning.open(world, cell) || !CombatPlanning.open(world, cell.above())) return null;
		if (CombatPlanning.walkable(world, cell)) return Boolean.FALSE;
		for (int depth = 1; depth <= 16; depth++) {
			Cell below = world.cellAt(cell.below(depth));
			if (below == Cell.WATER) return Boolean.FALSE;
			if (below == Cell.HAZARD) return Boolean.TRUE;
			// Open air at the feet over footing never seen (under a tower's rim, an island's edge): a player there knows
			// it is a drop (2026-10-24 replay: a tower top read as 8+ blocks from any drop).
			if (below == Cell.UNLOADED) return Boolean.TRUE;
			if (!CombatPlanning.open(world, cell.below(depth))) return depth - 1 >= LETHAL_PUSH_DROP;
		}
		return Boolean.TRUE;
	}

	/** TRUE: floor to cross; null: a wall that stops the push; FALSE: a fall, hazard or unseen cell. */
	private static Boolean column(WalkabilityView world, GridPosition cell) {
		Cell feet = world.cellAt(cell), head = world.cellAt(cell.above());
		if (feet == Cell.UNLOADED || head == Cell.UNLOADED || feet == Cell.HAZARD) return Boolean.FALSE;
		if (!CombatPlanning.open(world, cell) || !CombatPlanning.open(world, cell.above())) return null;
		if (CombatPlanning.walkable(world, cell)) return Boolean.TRUE;
		for (int depth = 1; depth <= LocalPathfinder.MAX_DROP_BLOCKS + 1; depth++) {
			Cell below = world.cellAt(cell.below(depth));
			if (below == Cell.WATER) return Boolean.TRUE;
			if (below == Cell.UNLOADED || below == Cell.HAZARD) return Boolean.FALSE;
			if (!CombatPlanning.open(world, cell.below(depth))) return depth - 1 <= LocalPathfinder.MAX_DROP_BLOCKS;
		}
		return Boolean.FALSE;
	}
}
