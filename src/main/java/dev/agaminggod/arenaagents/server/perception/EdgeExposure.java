package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.material.LavaFluid;
import net.minecraft.world.phys.Vec3;

/**
 * Bounded footing probe, called only while building danger facts or terminal move results. Reads the cells beside and
 * below the body as the player knows them ({@link SeenTerrain}: seen now or remembered, lava opaque). Below an edge
 * whose top is known open, a bottom the eye has not seen is the one a glance over that edge shows: the first
 * non-air cell straight down (within {@link #GLANCE_DEPTH}), as {@link VoidColumn} already reads an empty column. A
 * player on a bridge knows the fall beside it; "at least 1" over a 20-block drop reads like a step. A deeper or
 * unloaded bottom keeps the known lower bound. With no drop beside the feet, the nearest one across open floor within
 * knockback reach is reported with its distance.
 */
public final class EdgeExposure {
	private EdgeExposure() {}
	/** How far down a glance over an edge reads the landing: below this the bottom stays "at least". */
	static final int GLANCE_DEPTH = 64;
	public static JsonObject facts(ServerPlayer player) {
		if (!player.onGround()) return null;
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		BlockPos feet = BlockPos.containing(player.getX(), player.getY() - 1.0E-3D, player.getZ());
		Column best = null;
		double yaw = 0;
		for (int dx = -1; dx <= 1; dx++) for (int dz = -1; dz <= 1; dz++) {
			if (dx == 0 && dz == 0) continue;
			double x = feet.getX() + dx + 0.5D, z = feet.getZ() + dz + 0.5D;
			if (Math.hypot(Math.max(0, Math.abs(x - player.getX()) - 0.3D),
					Math.max(0, Math.abs(z - player.getZ()) - 0.3D)) > 1.0D) continue;
			Column column = column(player, seen, feet, feet.getX() + dx, feet.getZ() + dz);
			if (column != null && (column.depth >= 4 || column.hidden && column.depth >= 1) && (best == null || column.depth > best.depth)) {
				best = column;
				yaw = yawTo(player, x, z);
			}
		}
		double distance = 0.0D;
		if (best == null) {
			// A hit pushes a player about 3 blocks (airborne), so an open drop that far off across open floor is as live
			// as one beside the feet (runs d9-nether-d and d10-nether-b: knocked 2 cells off fortress bridges).
			for (int heading = 0; heading < 16; heading++) {
				double angle = Math.PI / 8.0D * heading, ux = Math.cos(angle), uz = Math.sin(angle);
				int lastX = feet.getX(), lastZ = feet.getZ();
				for (double step = 0.25D; step <= KNOCKBACK_REACH + 0.8D; step += 0.25D) {
					int cx = Mth.floor(player.getX() + ux * step), cz = Mth.floor(player.getZ() + uz * step);
					if (cx == lastX && cz == lastZ) continue;
					lastX = cx;
					lastZ = cz;
					double cellGap = gap(player, cx, cz);
					if (cellGap > KNOCKBACK_REACH) break;
					Column column = column(player, seen, feet, cx, cz);
					if (column == null) break;
					if (column.depth >= 4) {
						if (best == null || cellGap < distance - 1.0E-6D || Math.abs(cellGap - distance) < 1.0E-6D && column.depth > best.depth) {
							best = column;
							distance = cellGap;
							yaw = yawTo(player, cx + 0.5D, cz + 0.5D);
						}
						break;
					}
					// Floor (or an unmeasured hole) under this cell: the push carries on over it.
				}
			}
		}
		if (best == null) return null;
		JsonObject facts = new JsonObject();
		facts.addProperty("drop", best.depth);
		if (best.hidden) facts.addProperty("atLeast", true);
		if (best.into != null) facts.addProperty("into", best.into);
		facts.addProperty("yaw", Math.round(yaw));
		if (distance > 0.0D) facts.addProperty("distance", Math.round(distance * 10.0D) / 10.0D);
		return facts;
	}

	/** How far a hit carries a player across open ground, airborne: about 3 blocks. */
	static final double KNOCKBACK_REACH = 3.0D;

	private record Column(int depth, boolean hidden, String into) {}

	/** Horizontal gap from the body's box to the column's cell. */
	private static double gap(ServerPlayer player, int cx, int cz) {
		return Math.hypot(Math.max(0, Math.abs(cx + 0.5D - player.getX()) - 0.8D), Math.max(0, Math.abs(cz + 0.5D - player.getZ()) - 0.8D));
	}

	private static double yawTo(ServerPlayer player, double x, double z) {
		return Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-(x - player.getX()), z - player.getZ())));
	}

	/**
	 * The fall into one column beside or near the body, measured from the feet; null when its cell at body height is
	 * unknown or blocked (the body cannot be pushed there).
	 */
	private static Column column(ServerPlayer player, SeenTerrain.Reader<BlockState> seen, BlockPos feet, int cx, int cz) {
		var level = player.level();
		double x = cx + 0.5D, z = cz + 0.5D;
		// The body could step there: the cell beside it at body height is known open.
		BlockPos beside = BlockPos.containing(x, player.getY() + 0.5D, z);
		BlockState besideState = seen.known(beside.getX(), beside.getY(), beside.getZ());
		if (besideState == null || !besideState.getCollisionShape(level, beside).isEmpty()) return null;
		int dx = cx - feet.getX(), dz = cz - feet.getZ();
		int depth = 0;
		boolean hidden = true;
		String landing = null;
		int unseenFrom = feet.getY() - 17;
		for (int drop = 0; drop <= 16; drop++) {
			BlockPos support = feet.offset(dx, -drop, dz);
			BlockState state = seen.known(support.getX(), support.getY(), support.getZ());
			if (state == null) {
				unseenFrom = support.getY();
				break;
			}
			// Known open down to here: at least this deep even if nothing below is known.
			depth = Math.max(0, (int) Math.ceil(player.getY() - support.getY() - 1.0E-3D));
			var hit = state.getCollisionShape(level, support).clip(new Vec3(x, support.getY() + 1.01D, z), new Vec3(x, support.getY() - 0.01D, z), support);
			FluidState fluid = state.getFluidState();
			if (hit == null && fluid.isEmpty()) continue;
			// The cell above is known open and dry, so a fluid here stands at its own height.
			double surface = hit != null ? hit.getLocation().y : support.getY() + fluid.getOwnHeight();
			depth = Math.max(0, (int) Math.ceil(player.getY() - surface - 1.0E-3D));
			hidden = false;
			if (depth >= 4 && !fluid.isEmpty()) landing = fluid.getType() instanceof LavaFluid ? "lava" : "water";
			break;
		}
		// Nothing below the edge to the world's bottom: the void, not a fall with an unknown floor.
		if (hidden && VoidColumn.below(level, cx, unseenFrom, cz)) {
			depth = Math.max(4, (int) Math.ceil(player.getY() - level.getMinY()));
			hidden = false;
			landing = "void";
		} else if (hidden && depth >= 1) {
			// Only an edge already known to open below the support is measured: a pit never seen stays no fact.
			Landing glance = glance(level, cx, unseenFrom, cz, x, z);
			if (glance != null) {
				depth = Math.max(0, (int) Math.ceil(player.getY() - glance.surface() - 1.0E-3D));
				hidden = false;
				landing = depth >= 4 ? glance.into() : null;
			}
		}
		return new Column(depth, hidden, landing);
	}
	private record Landing(double surface, String into) {}

	/** The first non-air cell at or below {@code fromY} in the column, within {@link #GLANCE_DEPTH}; null if none is loaded. */
	private static Landing glance(net.minecraft.world.level.Level level, int columnX, int fromY, int columnZ, double x, double z) {
		BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
		for (int y = fromY; y > fromY - GLANCE_DEPTH && y >= level.getMinY(); y--) {
			cursor.set(columnX, y, columnZ);
			if (!level.hasChunkAt(cursor)) return null;
			BlockState state = level.getBlockState(cursor);
			FluidState fluid = state.getFluidState();
			var hit = state.getCollisionShape(level, cursor).clip(new Vec3(x, y + 1.01D, z), new Vec3(x, y - 0.01D, z), cursor);
			if (hit == null && fluid.isEmpty()) continue;
			if (hit != null) return new Landing(hit.getLocation().y, null);
			return new Landing(y + fluid.getOwnHeight(), fluid.getType() instanceof LavaFluid ? "lava" : "water");
		}
		return null;
	}

	/** Side scan reach in cells: about how far a hit carries a body ({@link #KNOCKBACK_REACH}). */
	static final int SIDE_REACH = 3;
	private static final String[] SIDE_NAMES = {"E", "S", "W", "N"};
	private static final int[][] SIDE_STEPS = {{1, 0}, {0, 1}, {-1, 0}, {0, -1}};

	/**
	 * What a player standing here sees by glancing left, right, ahead and behind: on each side, the first drop of 4 or
	 * more within {@link #SIDE_REACH} cells of floor (cells of floor before it, depth, and what is below: lava, water or
	 * void), the floor width between two opposite drops (a bridge), and the nearest known lava the body could step or be
	 * knocked into. Read from {@link SeenTerrain} like {@link #facts}; null on open ground with none of these.
	 */
	public static JsonObject sides(ServerPlayer player) {
		if (!player.onGround()) return null;
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		BlockPos feet = BlockPos.containing(player.getX(), player.getY() - 1.0E-3D, player.getZ());
		int[] at = {-1, -1, -1, -1};
		com.google.gson.JsonArray drops = new com.google.gson.JsonArray();
		for (int side = 0; side < 4; side++) {
			for (int cells = 1; cells <= SIDE_REACH; cells++) {
				Column column = column(player, seen, feet, feet.getX() + SIDE_STEPS[side][0] * cells, feet.getZ() + SIDE_STEPS[side][1] * cells);
				// A wall or an unknown cell at body height: nothing to fall into this way.
				if (column == null) break;
				if (column.depth < 4 && !(column.hidden && column.depth >= 1)) continue;
				at[side] = cells - 1;
				JsonObject drop = new JsonObject();
				drop.addProperty("dir", SIDE_NAMES[side]);
				drop.addProperty("at", cells - 1);
				drop.addProperty("drop", column.depth);
				if (column.hidden) drop.addProperty("atLeast", true);
				if (column.into != null) drop.addProperty("into", column.into);
				drops.add(drop);
				break;
			}
		}
		JsonObject lava = nearestLava(player, seen, feet);
		if (drops.isEmpty() && lava == null) return null;
		JsonObject facts = new JsonObject();
		// Floor cells between opposite drops, the narrower way across: a fortress bridge reads 3 or 5.
		int width = Integer.MAX_VALUE;
		if (at[0] >= 0 && at[2] >= 0) width = at[0] + at[2] + 1;
		if (at[1] >= 0 && at[3] >= 0) width = Math.min(width, at[1] + at[3] + 1);
		if (width != Integer.MAX_VALUE) facts.addProperty("width", width);
		if (!drops.isEmpty()) facts.add("drops", drops);
		if (lava != null) facts.add("lava", lava);
		return facts;
	}

	/** The nearest known lava within 2 cells across and from one below the support to head height: a misstep or a shove away. */
	private static JsonObject nearestLava(ServerPlayer player, SeenTerrain.Reader<BlockState> seen, BlockPos feet) {
		int best = Integer.MAX_VALUE, bestDx = 0, bestDz = 0, bestDy = 0;
		for (int dy = -1; dy <= 2; dy++) for (int dx = -2; dx <= 2; dx++) for (int dz = -2; dz <= 2; dz++) {
			int distance = Math.max(Math.abs(dx), Math.abs(dz));
			if (distance > best || distance == 0) continue;
			if (!lava(seen.known(feet.getX() + dx, feet.getY() + dy, feet.getZ() + dz))) continue;
			if (distance < best || Math.abs(dy - 1) < Math.abs(bestDy - 1)) {
				best = distance; bestDx = dx; bestDz = dz; bestDy = dy;
			}
		}
		if (best == Integer.MAX_VALUE) return null;
		JsonObject lava = new JsonObject();
		lava.addProperty("dir", best == 0 ? "here" : dev.agaminggod.arenaagents.server.runtime.controller.SafeStep.compass(
				(float) Math.toDegrees(Math.atan2(-bestDx, bestDz))));
		lava.addProperty("at", best);
		// Relative to the feet cell: 0 feet, 1 head, -1 floor level, -2 one step down.
		lava.addProperty("dy", bestDy - 1);
		return lava;
	}

	public static String describe(ServerPlayer player) {
		JsonObject facts = facts(player);
		return facts == null ? "" : "; footing " + facts;
	}

	/**
	 * Known lava the stopped body can touch without choosing to, as navigation counts it (beside the support, feet or
	 * head, one step down past an open support, or straight above the head, where it pours into the head cell and a
	 * jump or pillar meets it). Empty when none is known. The body's feet cell is the one its support top rises into.
	 */
	public static String lavaNote(ServerPlayer player) {
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		int x = Mth.floor(player.getX()), y = Mth.floor(player.getY() + 0.5D), z = Mth.floor(player.getZ());
		java.util.List<String> parts = new java.util.ArrayList<>();
		if (lava(seen.known(x, y + 2, z))) parts.add("above head at " + x + "," + (y + 2) + "," + z);
		for (net.minecraft.core.Direction direction : net.minecraft.core.Direction.Plane.HORIZONTAL) {
			int nx = x + direction.getStepX(), nz = z + direction.getStepZ();
			String side = direction.getName();
			int level = lava(seen.known(nx, y + 1, nz)) ? 1 : lava(seen.known(nx, y, nz)) ? 0 : lava(seen.known(nx, y - 1, nz)) ? -1 : Integer.MIN_VALUE;
			if (level != Integer.MIN_VALUE) {
				parts.add(side + (level == 1 ? " at head height " : level == 0 ? " at feet height " : " at floor height ") + nx + "," + (y + level) + "," + nz);
				continue;
			}
			BlockState step = seen.known(nx, y - 1, nz);
			if (step != null && step.isAir() && lava(seen.known(nx, y - 2, nz))) parts.add(side + " one step down " + nx + "," + (y - 2) + "," + nz);
		}
		String flow = flowNote(player);
		return (parts.isEmpty() ? "" : "; lava beside the stop: " + String.join(", ", parts.subList(0, Math.min(3, parts.size())))) + flow;
	}

	/** A seen lava flow on its way to the stopped body (d22-lava2: a move stopped below a lava fall that then ran onto it). */
	static String flowNote(ServerPlayer player) {
		LavaSpread.Arrival arrival = LavaSpread.towardBody(player);
		return arrival == null ? "" : "; lava flowing at the stop: " + arrival.describe();
	}

	private static boolean lava(BlockState state) {
		return state != null && state.getFluidState().getType() instanceof LavaFluid;
	}
}
