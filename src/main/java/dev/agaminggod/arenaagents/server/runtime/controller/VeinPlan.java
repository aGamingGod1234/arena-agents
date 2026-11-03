package dev.agaminggod.arenaagents.server.runtime.controller;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Function;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/**
 * mine_vein's pure choices, over the block ids the body knows (seen, touched or remembered; never hidden contents):
 * which blocks belong to the tree or ore vein it was pointed at, where a player stands to fell a tree, what is in reach
 * from there, and what must never be broken. A tree is felled the way a player does it in one go: from beside the
 * trunk the two lowest trunk cells are cut, the body steps into the trunk's column, and every log above is cut looking
 * up through it, so each next log is in plain sight. A tree whose seen logs cannot all be reached that way is refused
 * before any swing, so the action never leaves floating logs it already knew about.
 */
public final class VeinPlan {
	private VeinPlan() {
	}

	public static final int DEFAULT_MAX_BLOCKS = 32;
	public static final int MAX_BLOCKS = 64;
	/** Known cells the connected search visits at most; a vein or tree is far smaller. */
	static final int SEARCH_LIMIT = 512;
	/** Player eye height over the feet. */
	static final double EYE = 1.62D;
	/** Kept off vanilla's 4.5-block reach so the crosshair still meets a block at the edge. */
	static final double REACH_MARGIN = 0.1D;
	/** Leaves cleared at most per action to open sightlines to logs. */
	static final int MAX_LEAVES = 24;

	public enum Kind { TREE, VEIN }

	/**
	 * The family a block id belongs to: a natural log or woody fungus stem (one species), or an ore with its deepslate twin
	 * ({@code minecraft:deepslate_iron_ore} mines with {@code minecraft:iron_ore}). Null for anything else.
	 */
	public static String family(String blockId) {
		if (blockId == null) return null;
		int colon = blockId.indexOf(':');
		String namespace = colon < 0 ? "minecraft" : blockId.substring(0, colon);
		String path = colon < 0 ? blockId : blockId.substring(colon + 1);
		if (path.startsWith("stripped_")) return null;
		if (path.endsWith("_log") || path.equals("crimson_stem") || path.equals("warped_stem")) return "tree:" + namespace + ":" + path;
		if (path.equals("ancient_debris")) return "vein:" + namespace + ":" + path;
		if (path.endsWith("_ore")) {
			if (path.startsWith("deepslate_")) path = path.substring("deepslate_".length());
			return "vein:" + namespace + ":" + path;
		}
		return null;
	}

	public static Kind kind(String family) {
		return family == null ? null : family.startsWith("tree:") ? Kind.TREE : Kind.VEIN;
	}

	/** Leaves (any species): what a player cuts through to reach a branch log. */
	static boolean leaves(String blockId) {
		return blockId != null && blockId.endsWith("_leaves");
	}

	/**
	 * Every known block of {@code family} connected to the seeds through the 26 neighbours (trees and veins touch
	 * corner to corner), breadth first, seeds first. Seeds need not be of the family (a cell already broken).
	 */
	static List<BlockPos> component(Collection<BlockPos> seeds, String family, Function<BlockPos, String> known, int limit) {
		LinkedHashSet<BlockPos> found = new LinkedHashSet<>();
		Set<BlockPos> visited = new java.util.HashSet<>(seeds);
		ArrayDeque<BlockPos> queue = new ArrayDeque<>(seeds);
		for (BlockPos seed : seeds) if (family.equals(family(known.apply(seed)))) found.add(seed);
		while (!queue.isEmpty() && visited.size() < SEARCH_LIMIT && found.size() < limit) {
			BlockPos at = queue.poll();
			for (int dx = -1; dx <= 1; dx++) for (int dy = -1; dy <= 1; dy++) for (int dz = -1; dz <= 1; dz++) {
				if (dx == 0 && dy == 0 && dz == 0) continue;
				BlockPos next = at.offset(dx, dy, dz);
				if (!visited.add(next)) continue;
				if (found.size() >= limit || !family.equals(family(known.apply(next)))) continue;
				found.add(next);
				queue.add(next);
			}
		}
		return List.copyOf(found);
	}

	/** The lowest log of a tree (nearest the body on a tie: the column of a 2x2 trunk it stands beside). */
	static BlockPos trunkBase(List<BlockPos> logs, Vec3 feet) {
		return logs.stream().min(Comparator.<BlockPos>comparingInt(BlockPos::getY)
				.thenComparingDouble(at -> horizontal(at, feet))).orElseThrow();
	}

	/** The eye of a body standing in the trunk column once its base log is cut. */
	static Vec3 columnEye(BlockPos base) {
		return new Vec3(base.getX() + 0.5D, base.getY() + EYE, base.getZ() + 0.5D);
	}

	/** The eye of a body standing in {@code feet}, centred. */
	static Vec3 eyeAt(BlockPos feet) {
		return new Vec3(feet.getX() + 0.5D, feet.getY() + EYE, feet.getZ() + 0.5D);
	}

	/** Within the crosshair's block reach of the eye, measured to the nearest point of the block, with a margin. */
	static boolean reachable(Vec3 eye, BlockPos cell, double range) {
		double limit = range - REACH_MARGIN;
		return new AABB(cell).distanceToSqr(eye) <= limit * limit;
	}

	/** The seen logs no planned stance reaches: felling the rest would leave these floating. */
	static List<BlockPos> outOfReach(List<BlockPos> blocks, double range, Vec3... eyes) {
		List<BlockPos> out = new ArrayList<>();
		for (BlockPos block : blocks) {
			boolean any = false;
			for (Vec3 eye : eyes) any |= reachable(eye, block, range);
			if (!any) out.add(block);
		}
		return out;
	}

	/**
	 * The standing cell beside the trunk base (same level, one of four sides) whose feet and head cells are seen open
	 * and whose floor is seen solid, nearest the body; null when none is known.
	 */
	static BlockPos stance(BlockPos base, Vec3 feet, Predicate<BlockPos> open, Predicate<BlockPos> floor) {
		BlockPos best = null;
		for (Direction side : Direction.Plane.HORIZONTAL) {
			BlockPos cell = base.relative(side);
			if (!open.test(cell) || !open.test(cell.above()) || !floor.test(cell.below())) continue;
			if (best == null || horizontal(cell, feet) < horizontal(best, feet)) best = cell;
		}
		return best;
	}

	/**
	 * A cell the body stands on or that lies under it: breaking it can drop the body (into a cave, lava, or just a
	 * fall). Never broken by mine_vein.
	 */
	static boolean underBody(AABB body, BlockPos cell) {
		return cell.getY() < Math.floor(body.minY + 1.0E-4D)
				&& cell.getX() + 1 > body.minX && cell.getX() < body.maxX
				&& cell.getZ() + 1 > body.minZ && cell.getZ() < body.maxZ;
	}

	/** The order blocks are cut: a tree bottom up (each log in sight once the one under it is gone), a vein nearest first. */
	static Comparator<BlockPos> order(Kind kind, Vec3 eye) {
		Comparator<BlockPos> nearest = Comparator.comparingDouble(at -> new AABB(at).distanceToSqr(eye));
		return kind == Kind.TREE ? Comparator.<BlockPos>comparingInt(BlockPos::getY).thenComparing(nearest) : nearest;
	}

	private static double horizontal(BlockPos cell, Vec3 feet) {
		double dx = cell.getX() + 0.5D - feet.x, dz = cell.getZ() + 0.5D - feet.z;
		return dx * dx + dz * dz;
	}
}
