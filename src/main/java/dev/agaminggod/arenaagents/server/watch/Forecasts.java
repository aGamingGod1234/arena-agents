package dev.agaminggod.arenaagents.server.watch;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Checks a body action's path or target against the real world when it starts: a route that crosses or skirts lava
 * or fire or descends more than a safe fall, a broken block that lets lava or water in, a portal arrival next to lava
 * or a drop. Each finding is one hazard; the caller writes it as a forecast line. Read-only.
 */
final class Forecasts {
	record Hazard(String kind, BlockPos block, double distance, String detail) {
	}

	private Forecasts() {
	}

	/** The first lava, fire and drop hazard along a planned route (feet cells), with the walked distance to it. */
	static List<Hazard> route(ServerPlayer player, List<GridPosition> route) {
		ServerLevel level = player.level();
		List<Hazard> found = new ArrayList<>(3);
		boolean lava = false;
		boolean fire = false;
		boolean drop = false;
		double walked = 0.0D;
		double px = player.getX() - 0.5D;
		double py = player.getY();
		double pz = player.getZ() - 0.5D;
		GridPosition previous = null;
		for (GridPosition node : route) {
			walked += previous == null ? Math.sqrt(sq(node.x() - px) + sq(node.y() - py) + sq(node.z() - pz))
					: Math.sqrt(sq(node.x() - previous.x()) + sq(node.y() - previous.y()) + sq(node.z() - previous.z()));
			BlockPos feet = new BlockPos(node.x(), node.y(), node.z());
			if (!lava) {
				BlockPos hit = lavaAt(level, feet);
				if (hit != null) {
					lava = true;
					found.add(new Hazard("lava", hit, walked, (hit.getY() < feet.getY() || hit.equals(feet) || hit.equals(feet.above())
							? "route crosses lava" : "route passes beside lava") + " " + walked(walked)));
				}
			}
			if (!fire && (level.getBlockState(feet).is(BlockTags.FIRE) || level.getBlockState(feet.above()).is(BlockTags.FIRE))) {
				fire = true;
				found.add(new Hazard("fire", feet, walked, "route crosses fire " + walked(walked)));
			}
			if (!drop && previous != null && previous.y() - node.y() > TruthScan.SAFE_FALL) {
				drop = true;
				found.add(new Hazard("drop", feet, walked, "route drops " + (previous.y() - node.y()) + " blocks " + walked(walked)));
			}
			previous = node;
			if (lava && fire && drop) break;
		}
		return found;
	}

	private static String walked(double distance) {
		return String.format(java.util.Locale.ROOT, "%.1f blocks along the route", distance);
	}

	private static double sq(double value) {
		return value * value;
	}

	/** Lava in the body's cells, under the feet, or beside them at feet or floor level. */
	private static BlockPos lavaAt(ServerLevel level, BlockPos feet) {
		if (isLava(level, feet)) return feet;
		if (isLava(level, feet.above())) return feet.above();
		if (isLava(level, feet.below())) return feet.below();
		for (Direction direction : Direction.Plane.HORIZONTAL) {
			BlockPos side = feet.relative(direction);
			if (isLava(level, side)) return side;
			if (isLava(level, side.below()) && level.getBlockState(side).getCollisionShape(level, side).isEmpty()) return side.below();
		}
		return null;
	}

	private static boolean isLava(ServerLevel level, BlockPos cell) {
		return level.getBlockState(cell).getFluidState().is(FluidTags.LAVA);
	}

	/** Lava or water a broken block would let in: fluid on any face of the target. */
	static List<Hazard> breaking(ServerPlayer player, BlockPos target) {
		ServerLevel level = player.level();
		List<Hazard> found = new ArrayList<>(2);
		double distance = Math.sqrt(player.distanceToSqr(target.getX() + 0.5D, target.getY() + 0.5D, target.getZ() + 0.5D));
		boolean lava = false;
		boolean water = false;
		for (Direction direction : Direction.values()) {
			BlockPos side = target.relative(direction);
			BlockState state = level.getBlockState(side);
			if (!lava && state.getFluidState().is(FluidTags.LAVA)) {
				lava = true;
				found.add(new Hazard("lava", side, distance, "breaking " + text(target) + " exposes lava on its " + direction.getName() + " face"));
			} else if (!water && state.getFluidState().is(FluidTags.WATER)) {
				water = true;
				found.add(new Hazard("water", side, distance, "breaking " + text(target) + " lets water in from its " + direction.getName() + " face"));
			}
		}
		return found;
	}

	/** Lava placed against: the target cell of a placement touching lava. */
	static List<Hazard> placing(ServerPlayer player, BlockPos target) {
		ServerLevel level = player.level();
		for (Direction direction : Direction.values()) {
			BlockPos side = target.relative(direction);
			if (isLava(level, side)) {
				double distance = Math.sqrt(player.distanceToSqr(side.getX() + 0.5D, side.getY() + 0.5D, side.getZ() + 0.5D));
				return List.of(new Hazard("lava", side, distance, "placing at " + text(target) + " next to lava"));
			}
		}
		return List.of();
	}

	/** Lava, fire and drops the truth scan finds around a portal arrival. */
	static List<Hazard> arrival(ServerPlayer player) {
		List<Danger> dangers = new ArrayList<>();
		TruthScan.blocks(player, null, dangers);
		List<Hazard> found = new ArrayList<>(dangers.size());
		for (Danger danger : dangers) {
			if (danger.block() == null) continue;
			BlockPos cell = new BlockPos(danger.block()[0], danger.block()[1], danger.block()[2]);
			found.add(new Hazard(danger.kind(), cell, danger.distance(), "portal arrival " + String.format(java.util.Locale.ROOT, "%.1f", danger.distance())
					+ " blocks from " + danger.kind() + (danger.kind().equals("drop") ? " (" + danger.sourceType() + ")" : "")));
		}
		return found;
	}

	private static String text(BlockPos cell) {
		return cell.getX() + " " + cell.getY() + " " + cell.getZ();
	}

	/** Whether an episode of {@code kind} at {@code block} is the hazard a forecast named. */
	static boolean matches(String forecastKind, int[] forecastBlock, String episodeKind, int[] episodeBlock) {
		boolean kindMatches = switch (forecastKind) {
			case "lava" -> episodeKind.equals("lava") || episodeKind.equals("lava_hidden") || episodeKind.equals("burning");
			case "fire" -> episodeKind.equals("fire") || episodeKind.equals("burning");
			case "drop" -> episodeKind.equals("drop") || episodeKind.equals("fall") || episodeKind.equals("void");
			default -> forecastKind.equals(episodeKind);
		};
		if (!kindMatches) return false;
		if (forecastBlock == null || episodeBlock == null) return true;
		int dx = forecastBlock[0] - episodeBlock[0];
		int dy = forecastBlock[1] - episodeBlock[1];
		int dz = forecastBlock[2] - episodeBlock[2];
		return dx * dx + dy * dy + dz * dz <= 9 + (forecastKind.equals("drop") ? 16 : 0);
	}
}
