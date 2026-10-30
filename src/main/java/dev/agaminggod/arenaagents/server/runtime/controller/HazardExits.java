package dev.agaminggod.arenaagents.server.runtime.controller;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.util.Mth;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/**
 * The nearest cells a body in lava or fire could stand on, read only from terrain the player has seen
 * ({@link SeenHazardTerrain}); an exit built on remembered cells says how long ago they were seen. Hazard observations
 * scan nearby cells, then recall a landing when stranded. Facts only: the model chooses whether and where to go.
 */
public final class HazardExits {
	public static final int RADIUS = 3;
	public static final int MAX_EXITS = 4;
	private static final double BODY_HALF_WIDTH = 0.3D;
	private static final String[] DIRECTIONS = { "front", "front_right", "right", "back_right", "back", "back_left", "left", "front_left" };

	/** {@code UNKNOWN} is a cell the player has not seen. */
	public enum Cell { OPEN, SOLID, LAVA, FIRE, HOT, UNKNOWN }

	/** What the body touches: lava, a fire block, or a hot floor (magma, campfire). */
	public enum Contact {
		LAVA("lava"), FIRE("fire"), HOT_FLOOR("hot_floor");

		public final String wire;

		Contact(String wire) {
			this.wire = wire;
		}
	}

	@FunctionalInterface
	public interface Cells {
		Cell at(int x, int y, int z);

		/** Whether the cell is known to be {@code expected}; a source may answer without looking when it cannot be. */
		default boolean is(int x, int y, int z, Cell expected) {
			return at(x, y, z) == expected;
		}

		/** 0 for a cell seen now or unknown; otherwise how many seconds ago a remembered cell was seen. */
		default int secondsSinceSeen(int x, int y, int z) {
			return 0;
		}

		default long[] rememberedPositions() {
			return new long[0];
		}

		default Cell recalled(int x, int y, int z) {
			return at(x, y, z);
		}

		default int recalledAge(int x, int y, int z) {
			return secondsSinceSeen(x, y, z);
		}
	}

	/**
	 * {@code up} is the height from the body's block level; {@code lavaCells} counts lava crossed on the
	 * straight line, {@code gaps} cells on it with no floor, and {@code unseen} says part of it was not seen.
	 * {@code seenAgoS} is 0 when every cell it rests on is in view now, otherwise the age of the oldest remembered one.
	 */
	public record Exit(int x, int y, int z, String direction, double distance, int up, int lavaCells, int gaps, boolean unseen, int seenAgoS) {
		public Exit(int x, int y, int z, String direction, double distance, int up, int lavaCells, int gaps, boolean unseen) {
			this(x, y, z, direction, distance, up, lavaCells, gaps, unseen, 0);
		}
	}

	record Path(int lavaCells, int gaps, boolean unseen) {
	}

	private HazardExits() {
	}

	public static boolean fireResistant(ServerPlayer player) {
		return player.hasEffect(MobEffects.FIRE_RESISTANCE) || player.fireImmune() || player.getAbilities().invulnerable;
	}

	/** Lava, then a fire block anywhere the body overlaps, then magma under the feet or a campfire under the body. */
	public static Contact contact(ServerPlayer player) {
		if (player.isInLava()) return Contact.LAVA;
		BlockGetter level = player.level();
		BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
		AABB box = player.getBoundingBox().deflate(1.0E-4D);
		// Every action asks this each tick: block checks only, no collision shapes (see hazard).
		for (int x = Mth.floor(box.minX); x <= Mth.floor(box.maxX); x++) {
			for (int y = Mth.floor(box.minY); y <= Mth.floor(box.maxY); y++) {
				for (int z = Mth.floor(box.minZ); z <= Mth.floor(box.maxZ); z++) {
					if (hazard(level.getBlockState(cursor.set(x, y, z))) == Cell.FIRE) return Contact.FIRE;
				}
			}
		}
		BlockPos feet = player.blockPosition();
		if (hazard(level.getBlockState(feet)) == Cell.HOT || hazard(level.getBlockState(cursor.set(feet.getX(), feet.getY() - 1, feet.getZ()))) == Cell.HOT) {
			return Contact.HOT_FLOOR;
		}
		return null;
	}

	/**
	 * The fire block the body overlaps nearest its feet, or null. With no fire-free cell to step to (a one-cell shelter a
	 * fireball lit through its window), a player punches the flame out: fire breaks at the first hit (vanilla, hardness 0).
	 */
	public static BlockPos fireTouched(ServerPlayer player) {
		BlockGetter level = player.level();
		AABB box = player.getBoundingBox().deflate(1.0E-4D);
		BlockPos best = null;
		double bestDistance = Double.MAX_VALUE;
		for (int x = Mth.floor(box.minX); x <= Mth.floor(box.maxX); x++) {
			for (int y = Mth.floor(box.minY); y <= Mth.floor(box.maxY); y++) {
				for (int z = Mth.floor(box.minZ); z <= Mth.floor(box.maxZ); z++) {
					BlockPos at = new BlockPos(x, y, z);
					if (!level.getBlockState(at).is(BlockTags.FIRE)) continue;
					double distance = Vec3.atBottomCenterOf(at).distanceToSqr(player.position());
					if (distance < bestDistance) { bestDistance = distance; best = at; }
				}
			}
		}
		return best;
	}

	/** Whether the body's current view ray (block outlines, survival reach) ends on {@code block}, as a click would. */
	public static boolean viewHits(ServerPlayer player, BlockPos block) {
		Vec3 eye = player.getEyePosition();
		Vec3 end = eye.add(player.getViewVector(1.0F).scale(player.blockInteractionRange()));
		var hit = player.level().clip(new net.minecraft.world.level.ClipContext(eye, end, net.minecraft.world.level.ClipContext.Block.OUTLINE,
				net.minecraft.world.level.ClipContext.Fluid.NONE, player));
		return hit.getType() == net.minecraft.world.phys.HitResult.Type.BLOCK && hit.getBlockPos().equals(block);
	}

	/** Where the eye aims to hit a fire block: its thin outline lies on the floor of its cell. */
	public static Vec3 fireAim(BlockPos fire) {
		return new Vec3(fire.getX() + 0.5D, fire.getY() + 0.03D, fire.getZ() + 0.5D);
	}

	/** Whether the body touches a hazard block (lava, fire, or a hot floor), where exits are worth naming. */
	public static boolean inHazardBlock(ServerPlayer player) {
		return contact(player) != null;
	}

	/** Exits from the terrain this player has seen. */
	public static List<Exit> scan(ServerPlayer player) {
		return scan(SeenHazardTerrain.of(player), player.position(), player.getYRot());
	}

	public static Cells cells(BlockGetter level) {
		BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
		return (x, y, z) -> classify(level, cursor.set(x, y, z), level.getBlockState(cursor));
	}

	static Cell classify(BlockGetter level, BlockPos position, BlockState state) {
		Cell hazard = hazard(state);
		if (hazard != null) return hazard;
		return state.getCollisionShape(level, position).isEmpty() ? Cell.OPEN : Cell.SOLID;
	}

	/** LAVA, FIRE or HOT for a hazard block, otherwise null. */
	static Cell hazard(BlockState state) {
		if (state.getFluidState().is(FluidTags.LAVA)) return Cell.LAVA;
		if (state.is(BlockTags.FIRE)) return Cell.FIRE;
		if (hotFloor(state)) return Cell.HOT;
		return null;
	}

	/** Magma and lit campfires damage a standing body without igniting it. */
	public static boolean hotFloor(BlockState state) {
		boolean campfire = state.is(Blocks.CAMPFIRE) || state.is(Blocks.SOUL_CAMPFIRE) || state.is(BlockTags.CAMPFIRES);
		return state.is(Blocks.MAGMA_BLOCK) || campfire
				&& state.getOptionalValue(net.minecraft.world.level.block.state.properties.BlockStateProperties.LIT).orElse(false);
	}

	/**
	 * Up to {@link #MAX_EXITS} landings within {@link #RADIUS} horizontal blocks, at most three above, cheapest first
	 * and at most one per direction. If none is near, one nearest remembered landing, with an unknown route. An exit's
	 * floor, feet and head cells must be known; its path may be partly unseen (said so). Empty when none is known.
	 */
	public static List<Exit> scan(Cells known, Vec3 position, float yaw) {
		// The oldest remembered cell each candidate reads.
		int[] age = { 0 };
		Cells cells = new Cells() {
			@Override
			public Cell at(int x, int y, int z) {
				Cell cell = known.at(x, y, z);
				if (cell != Cell.UNKNOWN) age[0] = Math.max(age[0], known.secondsSinceSeen(x, y, z));
				return cell;
			}

			@Override
			public boolean is(int x, int y, int z, Cell expected) {
				boolean matches = known.is(x, y, z, expected);
				if (matches) age[0] = Math.max(age[0], known.secondsSinceSeen(x, y, z));
				return matches;
			}
		};
		int bx = (int) Math.floor(position.x);
		int by = (int) Math.floor(position.y + 0.01D);
		int bz = (int) Math.floor(position.z);
		List<Exit> candidates = new ArrayList<>();
		// Preserve the normal scan cost when a local exit exists; only stranded bodies need higher landings.
		for (int pass = 0; pass < 2; pass++) {
			for (int dx = -RADIUS; dx <= RADIUS; dx++) {
				for (int dz = -RADIUS; dz <= RADIUS; dz++) {
					double ex = bx + dx + 0.5D - position.x, ez = bz + dz + 0.5D - position.z;
					if (ex * ex + ez * ez > RADIUS * RADIUS) continue;
					for (int up = pass == 0 ? -1 : 2; up <= (pass == 0 ? 1 : RADIUS); up++) {
						if (dx == 0 && dz == 0 && up <= 1) continue;
						age[0] = 0;
						int x = bx + dx, y = by + up, z = bz + dz;
						// Higher open air is common over a pool; a missing floor rejects it without sight rays for air.
						if (up > 1 && !cells.is(x, y - 1, z, Cell.SOLID)) continue;
						if (!standable(cells, x, y, z)) continue;
						Path path = up > 1 ? new Path(0, 0, true) : path(cells, position, bx, by, bz, x, z, up);
						if (path == null) break;
						candidates.add(new Exit(x, y, z, direction(ex, ez, yaw), Math.round(Math.sqrt(ex * ex + ez * ez) * 10.0D) / 10.0D, up,
								path.lavaCells(), path.gaps(), path.unseen(), age[0]));
						break;
					}
				}
			}
			if (!candidates.isEmpty()) break;
		}
		// A fall or sinking can put the shore outside the local scan. Recall one nearest known landing without
		// scanning any new terrain or certifying the way to it. Its remembered floor and headroom may have changed.
		if (candidates.isEmpty()) {
			Exit recalled = recallLanding(known, position, yaw);
			if (recalled != null) candidates.add(recalled);
		}
		candidates.sort(Comparator.comparingDouble(HazardExits::cost));
		List<Exit> exits = new ArrayList<>();
		for (Exit exit : candidates) {
			if (exits.size() >= MAX_EXITS) break;
			if (exits.stream().noneMatch(chosen -> chosen.direction().equals(exit.direction()))) exits.add(exit);
		}
		return exits;
	}

	static Exit recallLanding(Cells cells, Vec3 position, float yaw) {
		Exit nearest = null;
		double nearestDistance = Double.POSITIVE_INFINITY;
		int by = (int) Math.floor(position.y + 0.01D);
		for (long key : cells.rememberedPositions()) {
			int x = BlockPos.getX(key), y = BlockPos.getY(key), z = BlockPos.getZ(key);
			double dx = x + 0.5D - position.x, dz = z + 0.5D - position.z;
			// Both local passes already evaluated this volume, including rejecting known walls on the way.
			if (dx * dx + dz * dz <= RADIUS * RADIUS && y - by >= -1 && y - by <= RADIUS) continue;
			double distance = dx * dx + dz * dz + (y - position.y) * (y - position.y);
			if (distance >= nearestDistance) continue;
			if (cells.recalled(x, y, z) != Cell.OPEN || cells.recalled(x, y - 1, z) != Cell.SOLID
					|| cells.recalled(x, y + 1, z) != Cell.OPEN) continue;
			int age = Math.max(cells.recalledAge(x, y, z), Math.max(cells.recalledAge(x, y - 1, z), cells.recalledAge(x, y + 1, z)));
			nearestDistance = distance;
			nearest = new Exit(x, y, z, direction(dx, dz, yaw), Math.round(Math.hypot(dx, dz) * 10.0D) / 10.0D, y - by,
					0, 0, true, age);
		}
		return nearest;
	}

	static double cost(Exit exit) {
		return exit.distance() + exit.lavaCells() * 1.5D + exit.gaps() + Math.max(0, exit.up()) * 0.5D + (exit.unseen() ? 1.0D : 0.0D);
	}

	static boolean standable(Cells cells, int x, int y, int z) {
		return cells.is(x, y, z, Cell.OPEN) && cells.is(x, y - 1, z, Cell.SOLID) && cells.is(x, y + 1, z, Cell.OPEN);
	}

	/**
	 * The straight line from the body to the exit column, swept at body width: null when a known wall or hot block
	 * stands in it at body height (one block higher for a step up, whose foot-level blocks are the step). Counts lava and
	 * floorless cells on the centre line. The start and exit columns do not count.
	 */
	static Path path(Cells cells, Vec3 position, int bx, int by, int bz, int tx, int tz, int up) {
		double ex = tx + 0.5D - position.x, ez = tz + 0.5D - position.z;
		double length = Math.hypot(ex, ez);
		int steps = (int) Math.ceil(length / 0.25D);
		double sideX = -ez / length * BODY_HALF_WIDTH, sideZ = ex / length * BODY_HALF_WIDTH;
		long start = BlockPos.asLong(bx, 0, bz), target = BlockPos.asLong(tx, 0, tz);
		List<Long> centre = new ArrayList<>();
		List<Long> swept = new ArrayList<>();
		for (int step = 1; step <= steps; step++) {
			double cx = position.x + ex * step / steps, cz = position.z + ez * step / steps;
			long middle = BlockPos.asLong((int) Math.floor(cx), 0, (int) Math.floor(cz));
			if (middle == target) break;
			if (middle != start && !centre.contains(middle)) centre.add(middle);
			if (middle != start && !swept.contains(middle)) swept.add(middle);
			for (int side = -1; side <= 1; side += 2) {
				long column = BlockPos.asLong((int) Math.floor(cx + sideX * side), 0, (int) Math.floor(cz + sideZ * side));
				if (column != start && column != target && !swept.contains(column)) swept.add(column);
			}
		}
		boolean unseen = false;
		int clearance = by + Math.max(0, up);
		for (long column : swept) {
			int x = BlockPos.getX(column), z = BlockPos.getZ(column);
			Cell feet = cells.at(x, clearance, z), head = cells.at(x, clearance + 1, z);
			if (feet == Cell.SOLID || feet == Cell.HOT || head == Cell.SOLID || head == Cell.HOT) return null;
			if (feet == Cell.UNKNOWN || head == Cell.UNKNOWN) unseen = true;
		}
		int lava = 0, gaps = 0;
		for (long column : centre) {
			int x = BlockPos.getX(column), z = BlockPos.getZ(column);
			Cell feet = cells.at(x, by, z), head = cells.at(x, by + 1, z), below = cells.at(x, by - 1, z);
			if (feet == Cell.LAVA || head == Cell.LAVA || feet == Cell.OPEN && below == Cell.LAVA) lava++;
			else if (feet == Cell.OPEN && below == Cell.OPEN) gaps++;
			else if (below == Cell.UNKNOWN) unseen = true;
		}
		return new Path(lava, gaps, unseen);
	}

	static String direction(double dx, double dz, float yaw) {
		double bearing = Math.toDegrees(Math.atan2(-dx, dz)) - yaw;
		return DIRECTIONS[Math.floorMod((int) Math.round(bearing / 45.0D), DIRECTIONS.length)];
	}

	/** One landing, with horizontal distance, height and any path uncertainty or remembered age. */
	public static String describe(Exit exit) {
		// Scans already round to tenths; the general decimal formatter is unnecessary on this hot observation path.
		long tenths = Math.round(exit.distance() * 10.0D);
		String bearing = tenths == 0 && exit.up() != 0 ? exit.up() > 0 ? "above" : "below" : exit.direction();
		StringBuilder text = new StringBuilder(bearing).append(' ')
				.append(tenths / 10L).append('.').append(tenths % 10L).append('m');
		if (exit.up() > 0) text.append(" up").append(exit.up());
		if (exit.up() < 0) text.append(" down").append(-exit.up());
		if (exit.up() > 1 || exit.up() < -1 || exit.distance() > RADIUS) text.append(" landing");
		if (exit.lavaCells() > 0) text.append(' ').append(exit.lavaCells()).append("lava");
		if (exit.gaps() > 0) text.append(' ').append(exit.gaps()).append("gap");
		if (exit.unseen()) text.append(exit.up() > 1 || exit.up() < -1 || exit.distance() > RADIUS ? " route unknown" : " unseen");
		if (exit.seenAgoS() > 0) text.append(" remembered ").append(exit.seenAgoS()).append('s');
		return text.append(" (").append(exit.x()).append(',').append(exit.y()).append(',').append(exit.z()).append(')').toString();
	}

	public static String describe(List<Exit> exits) {
		if (exits.isEmpty()) return "none seen within " + RADIUS + " blocks";
		return String.join("; ", exits.stream().map(HazardExits::describe).toList());
	}

	/**
	 * The result message for a model action stopped by lava or fire: what happened, the burn, and the exits. Shared so
	 * fight and flee can return the same facts.
	 */
	public static String stopMessage(ServerPlayer player, boolean lava) {
		StringBuilder message = new StringBuilder(lava ? "The body entered lava (raw 8 HP/s)" : "The body entered fire")
				.append("; this action stopped");
		int fireTicks = player.getRemainingFireTicks();
		if (fireTicks > 0) message.append(". Burning ").append((fireTicks + 19) / 20).append("s after exit, raw 1 HP/s");
		if (lava || inHazardBlock(player)) message.append(". Exits: ").append(describe(scan(player)));
		return message.toString();
	}
}
