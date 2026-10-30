package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.Vec3;

/**
 * The nether portal frame a player would judge by eye from the obsidian it currently sees: which frame cells (corners
 * optional) already hold obsidian, what is seen in each missing one, and what fills the interior. A 4x5 frame is taller
 * than the block rows' vertical window and holds more obsidian than their per-type cap, so without this the agent cannot
 * see its own frame whole. Only cells in the current view count; unseen cells stay "unseen". It never places anything.
 */
public final class PortalFrameSight {
	static final int RADIUS = 8;
	static final int BELOW = 5;
	static final int ABOVE = 7;
	static final int MAX_OBSIDIAN = 32;
	static final int MIN_WIDTH = 2;
	static final int MAX_WIDTH = 4;
	static final int MIN_HEIGHT = 3;
	static final int MAX_HEIGHT = 5;
	static final int MIN_FRAME_OBSIDIAN = 3;
	static final String UNSEEN = "unseen";

	private PortalFrameSight() {
	}

	public record Cell(int x, int y, int z) {
	}

	/** What the player sees in a cell: a short block id, "air", or null when the cell is not in view. */
	@FunctionalInterface
	public interface Sight {
		String seen(Cell cell);
	}

	/** Interior from (x, y, z), {@code width} along x ({@code alongX}) or z, {@code height} up. */
	public record Fit(boolean alongX, int x, int y, int z, int width, int height, int obsidian, List<Object[]> missing,
			List<Object[]> blocked, int unseenInterior, boolean lit) {
		int needed() {
			return 2 * width + 2 * height;
		}
	}

	static Cell at(boolean alongX, int planeU, int y, int plane) {
		return alongX ? new Cell(planeU, y, plane) : new Cell(plane, y, planeU);
	}

	static List<Cell> frameCells(boolean alongX, int u, int y, int plane, int width, int height) {
		ArrayList<Cell> cells = new ArrayList<>(2 * width + 2 * height);
		for (int i = 0; i < width; i++) {
			cells.add(at(alongX, u + i, y - 1, plane));
			cells.add(at(alongX, u + i, y + height, plane));
		}
		for (int j = 0; j < height; j++) {
			cells.add(at(alongX, u - 1, y + j, plane));
			cells.add(at(alongX, u + width, y + j, plane));
		}
		return cells;
	}

	static List<Cell> interiorCells(boolean alongX, int u, int y, int plane, int width, int height) {
		ArrayList<Cell> cells = new ArrayList<>(width * height);
		for (int j = 0; j < height; j++) for (int i = 0; i < width; i++) cells.add(at(alongX, u + i, y + j, plane));
		return cells;
	}

	/** Frame sides holding at least one seen obsidian; a flat sheet (e.g. a cooled pool) fills only one side. */
	private static int sidesWithObsidian(boolean alongX, int u, int y, int plane, int width, int height, Set<Cell> obsidian) {
		int sides = 0;
		boolean bottom = false, top = false, left = false, right = false;
		for (int i = 0; i < width; i++) {
			bottom |= obsidian.contains(at(alongX, u + i, y - 1, plane));
			top |= obsidian.contains(at(alongX, u + i, y + height, plane));
		}
		for (int j = 0; j < height; j++) {
			left |= obsidian.contains(at(alongX, u - 1, y + j, plane));
			right |= obsidian.contains(at(alongX, u + width, y + j, plane));
		}
		for (boolean side : new boolean[] {bottom, top, left, right}) if (side) sides++;
		return sides;
	}

	/**
	 * The candidate frame best matching the seen obsidian: most frame obsidian, then fewest missing cells, then nearest.
	 * Interiors holding obsidian are not frames. Returns null below {@link #MIN_FRAME_OBSIDIAN} or on a single side.
	 */
	public static Fit best(List<Cell> seenObsidian, Sight sight, Cell eye) {
		Set<Cell> obsidian = new HashSet<>(seenObsidian);
		Set<List<Integer>> tried = new HashSet<>();
		Fit best = null;
		double bestDistance = Double.MAX_VALUE;
		for (Cell origin : seenObsidian) {
			for (boolean alongX : new boolean[] {true, false}) {
				int originU = alongX ? origin.x() : origin.z();
				int plane = alongX ? origin.z() : origin.x();
				for (int width = MIN_WIDTH; width <= MAX_WIDTH; width++) {
					for (int height = MIN_HEIGHT; height <= MAX_HEIGHT; height++) {
						// Each way the origin can be a frame cell fixes one interior corner.
						for (Cell offset : frameCells(true, 0, 0, 0, width, height)) {
							int u = originU - offset.x();
							int y = origin.y() - offset.y();
							if (!tried.add(List.of(alongX ? 1 : 0, u, y, plane, width, height))) continue;
							int count = 0;
							for (Cell cell : frameCells(alongX, u, y, plane, width, height)) if (obsidian.contains(cell)) count++;
							if (count < MIN_FRAME_OBSIDIAN || best != null && count < best.obsidian()) continue;
							if (sidesWithObsidian(alongX, u, y, plane, width, height, obsidian) < 2) continue;
							boolean interiorObsidian = false;
							for (Cell cell : interiorCells(alongX, u, y, plane, width, height)) {
								if (obsidian.contains(cell)) { interiorObsidian = true; break; }
							}
							if (interiorObsidian) continue;
							int missingCount = 2 * width + 2 * height - count;
							Cell corner = at(alongX, u, y, plane);
							double distance = distanceSquared(corner, eye);
							if (best != null) {
								int bestMissing = best.needed() - best.obsidian();
								if (count == best.obsidian() && (missingCount > bestMissing
										|| missingCount == bestMissing && distance >= bestDistance)) continue;
							}
							best = new Fit(alongX, corner.x(), corner.y(), corner.z(), width, height, count, List.of(), List.of(), 0, false);
							bestDistance = distance;
						}
					}
				}
			}
		}
		return best == null ? null : describe(best, obsidian, sight);
	}

	private static Fit describe(Fit fit, Set<Cell> obsidian, Sight sight) {
		int u = fit.alongX() ? fit.x() : fit.z();
		int plane = fit.alongX() ? fit.z() : fit.x();
		ArrayList<Object[]> missing = new ArrayList<>();
		for (Cell cell : frameCells(fit.alongX(), u, fit.y(), plane, fit.width(), fit.height())) {
			if (obsidian.contains(cell)) continue;
			String seen = sight.seen(cell);
			missing.add(new Object[] {cell.x(), cell.y(), cell.z(), seen == null ? UNSEEN : seen});
		}
		ArrayList<Object[]> blocked = new ArrayList<>();
		int unseen = 0;
		boolean lit = false;
		for (Cell cell : interiorCells(fit.alongX(), u, fit.y(), plane, fit.width(), fit.height())) {
			String seen = sight.seen(cell);
			if (seen == null) unseen++;
			else if (seen.equals("nether_portal")) lit = true;
			else if (!seen.equals("air") && !seen.equals("fire")) blocked.add(new Object[] {cell.x(), cell.y(), cell.z(), seen});
		}
		return new Fit(fit.alongX(), fit.x(), fit.y(), fit.z(), fit.width(), fit.height(), fit.obsidian(),
				List.copyOf(missing), List.copyOf(blocked), unseen, lit);
	}

	private static double distanceSquared(Cell cell, Cell eye) {
		double dx = cell.x() - eye.x(), dy = cell.y() - eye.y(), dz = cell.z() - eye.z();
		return dx * dx + dy * dy + dz * dz;
	}

	/** Whether the raw block window holds frame material, so the wider scan runs only near obsidian. */
	static boolean frameMaterialNearby(List<BlockObservationOrdering.Candidate> candidates) {
		for (BlockObservationOrdering.Candidate candidate : candidates) {
			String id = candidate.blockId();
			if (id.equals("minecraft:obsidian") || id.equals("minecraft:crying_obsidian") || id.equals("minecraft:nether_portal")) return true;
		}
		return false;
	}

	static String shortId(BlockState state) {
		String id = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
		if (id.startsWith("minecraft:")) id = id.substring("minecraft:".length());
		FluidState fluid = state.getFluidState();
		if (!fluid.isEmpty()) id += fluid.isSource() ? " source" : " flowing";
		return id;
	}

	/** The sighted row for the frame nearest completion in view, or null. */
	static JsonArray observe(ServerLevel level, BlockPos center, Vec3 eye, float yaw, ObservationVisibility.Frame visibility,
			List<BlockObservationOrdering.Candidate> candidates) {
		if (!frameMaterialNearby(candidates)) return null;
		ArrayList<Cell> seenObsidian = new ArrayList<>();
		BlockPos.MutableBlockPos position = new BlockPos.MutableBlockPos();
		for (int y = -BELOW; y <= ABOVE; y++) {
			for (int x = -RADIUS; x <= RADIUS; x++) {
				for (int z = -RADIUS; z <= RADIUS; z++) {
					position.set(center.getX() + x, center.getY() + y, center.getZ() + z);
					if (!level.hasChunkAt(position)) continue;
					if (!level.getBlockState(position).is(net.minecraft.world.level.block.Blocks.OBSIDIAN)) continue;
					seenObsidian.add(new Cell(position.getX(), position.getY(), position.getZ()));
				}
			}
		}
		Cell eyeCell = new Cell((int) Math.floor(eye.x), (int) Math.floor(eye.y), (int) Math.floor(eye.z));
		seenObsidian.sort(Comparator.comparingDouble(cell -> distanceSquared(cell, eyeCell)));
		ArrayList<Cell> visible = new ArrayList<>();
		for (Cell cell : seenObsidian) {
			if (visible.size() == MAX_OBSIDIAN) break;
			BlockPos target = new BlockPos(cell.x(), cell.y(), cell.z());
			if (visibility.canSeeBlock(target) || visibility.seesCell(target)) visible.add(cell);
		}
		if (visible.size() < MIN_FRAME_OBSIDIAN) return null;
		Sight sight = cell -> {
			BlockPos target = new BlockPos(cell.x(), cell.y(), cell.z());
			if (!level.hasChunkAt(target)) return null;
			BlockState state = level.getBlockState(target);
			if (state.isAir()) return visibility.seesCell(target) ? "air" : null;
			return visibility.canSeeBlock(target) || visibility.seesCell(target) ? shortId(state) : null;
		};
		Fit fit = best(visible, sight, eyeCell);
		if (fit == null) return null;
		JsonObject row = toJson(fit);
		row.addProperty("distance", Math.round(Math.sqrt(distanceSquared(new Cell(fit.x(), fit.y(), fit.z()), eyeCell))));
		row.addProperty("bearing", SightedFeatures.bearing(eye, yaw, new SightedFeatures.Cell(fit.x(), fit.y(), fit.z())));
		JsonArray rows = new JsonArray();
		rows.add(row);
		return rows;
	}

	static JsonObject toJson(Fit fit) {
		JsonObject row = new JsonObject();
		row.addProperty("x", fit.x());
		row.addProperty("y", fit.y());
		row.addProperty("z", fit.z());
		row.addProperty("axis", fit.alongX() ? "x" : "z");
		JsonArray interior = new JsonArray();
		interior.add(fit.width());
		interior.add(fit.height());
		row.add("interior", interior);
		row.addProperty("obsidian", fit.obsidian());
		row.addProperty("needed", fit.needed());
		row.add("missing", cells(fit.missing()));
		row.add("blocked", cells(fit.blocked()));
		if (fit.unseenInterior() > 0) row.addProperty("unseenInterior", fit.unseenInterior());
		row.addProperty("lit", fit.lit());
		return row;
	}

	private static JsonArray cells(List<Object[]> cells) {
		JsonArray rows = new JsonArray();
		for (Object[] cell : cells) {
			JsonArray row = new JsonArray();
			row.add((Integer) cell[0]);
			row.add((Integer) cell[1]);
			row.add((Integer) cell[2]);
			row.add((String) cell[3]);
			rows.add(row);
		}
		return rows;
	}
}
