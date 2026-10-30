package dev.agaminggod.arenaagents.server.runtime;

import dev.agaminggod.arenaagents.agent.AgentDomainException;
import dev.agaminggod.arenaagents.server.perception.LavaSpread;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import it.unimi.dsi.fastutil.longs.LongArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Locale;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.BucketItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.material.Fluids;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * A bucket acts only along its own ray: an empty one fills from the first fluid source it meets, a filled one empties
 * against the first block outline. A player filling from a pool looks at the part of the water they can see; aiming at
 * the cell's hidden center (behind the obsidian the cast just made) clicks that obsidian instead.
 */
final class BucketUse {
	private BucketUse() { }

	static boolean is(ItemStack held) {
		return held.getItem() instanceof BucketItem;
	}

	static ClipContext.Fluid fluids(ItemStack held) {
		return held.is(Items.BUCKET) ? ClipContext.Fluid.SOURCE_ONLY : ClipContext.Fluid.NONE;
	}

	/**
	 * The look for a bucket aimed at {@code requested}. An empty bucket aimed into a fluid source keeps that source as its
	 * target: the requested point when the bucket ray meets the source there, else a visible point of the same source.
	 * Every other aim is kept as given.
	 */
	static Vec3 aim(Player player, Item bucket, Vec3 requested) {
		if (bucket != Items.BUCKET) return requested;
		BlockPos cell = BlockPos.containing(requested);
		FluidState fluid = player.level().getFluidState(cell);
		if (!fluid.isSource()) return requested;
		BlockHitResult direct = VanillaItemRay.atAim(player, requested, ClipContext.Fluid.SOURCE_ONLY);
		if (meets(direct, cell)) return requested;
		Vec3 eye = player.getEyePosition();
		double reach = player.blockInteractionRange();
		Vec3 point = null;
		for (Direction face : facesToward(eye, cell)) {
			point = BreakSightline.visibleFluidPoint(player.level(), eye, cell, reach, face,
					candidate -> VanillaItemRay.atAim(player, candidate, ClipContext.Fluid.SOURCE_ONLY));
			if (point != null) return point;
		}
		String source = fluidId(fluid) + " source at " + xyz(cell);
		double distance = eye.distanceTo(Vec3.atCenterOf(cell));
		if (point == null && direct.getType() == HitResult.Type.MISS && distance > reach) {
			throw new AgentDomainException("TARGET_TOO_FAR", String.format(Locale.ROOT,
					"The %s is %.1f m from the eye; a bucket reaches %.1f m", source, distance, reach));
		}
		throw new AgentDomainException("TARGET_OBSTRUCTED", "No part of the " + source
				+ " is the first thing the bucket ray meets from this eye; toward the aim it meets "
				+ describe(player.level(), eye, direct, reach));
	}

	/** The faces through which water casts a lava source: above and the four sides (water below does nothing). */
	private static final Direction[] COOLING_SIDES = { Direction.UP, Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST };
	/** How far ahead a poured source's spread is followed: a model turn or two. */
	static final double POUR_REACH_SECONDS = 9.0D;

	/**
	 * Why a held lava bucket emptied along the current look would leave a lava source whose flow reaches the body, or null.
	 * Vanilla empties a filled bucket into the cell on the clicked face's side of the first outline its ray meets. Water
	 * above or beside that cell casts the new source to obsidian at once (vanilla's LiquidBlock rule: the exact outcome of
	 * the pour, which the player then sees); otherwise it stays a source and spreads by {@link LavaSpread} over the cells
	 * the player knows, unknown cells at or above the feet counted open.
	 */
	static String lavaPourAtBody(ServerPlayer player, ItemStack held) {
		if (!held.is(Items.LAVA_BUCKET)) return null;
		BlockHitResult hit = VanillaItemRay.hit(player, ClipContext.Fluid.NONE);
		if (hit.getType() != HitResult.Type.BLOCK) return null;
		BlockPos cell = hit.getBlockPos().relative(hit.getDirection());
		if (cooled(player.level(), cell) || lavaSourceIn(player.level(), cell)) return null;
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		int delay = Fluids.LAVA.getTickDelay(player.level());
		AABB body = player.getBoundingBox();
		double seconds = lavaReachSeconds(seen::known, body, cell, delay);
		if (seconds < 0.0D) return null;
		String clicked = " (its ray meets " + describe(player.level(), player.getEyePosition(), hit, player.blockInteractionRange())
				+ "; lava goes on that face's side)";
		// Water evaporates where lava is fast (the Nether): no water advice there.
		boolean nether = delay <= 10;
		return refusal(cell, clicked, seconds, nether ? null : waterCell(seen::known, body, cell), nether);
	}

	/** The LAVA_POUR_AT_BODY failure text: where it lands, when its flow reaches the body, and the vanilla ways out. */
	static String refusal(BlockPos cell, String clicked, double seconds, BlockPos water, boolean nether) {
		String reach = seconds <= 0.0D ? ", in a cell your body occupies"
				: String.format(Locale.ROOT, "; no water touches that cell, so it stays a source and its flow reaches your body in about %.1f s", seconds);
		return "This lava would empty at " + xyz(cell) + clicked + reach + ". Not poured: "
				+ (nether ? "water evaporates here, so pick a landing cell whose flow misses your body (behind a wall, below your feet, or beside a drop on the far side from you)"
						: water == null ? "let water touch that cell first" : "water at " + xyz(water) + " touches that cell, so lava poured after it casts to obsidian")
				+ "; a pour back into a lava source (to free the bucket) is never refused; or acceptLavaRisk:true pours it anyway";
	}

	/**
	 * Seconds until a lava source placed at {@code cell} reaches a cell the body box overlaps, by vanilla spread over the
	 * known cells with vanilla's slope search (only toward the nearest drop within 2 cells, 4 where lava is fast; a drop
	 * that fills with lava stays a drop, as vanilla's isWaterHole counts the same fluid below), or -1 when it does not
	 * within {@link #POUR_REACH_SECONDS}. Unknown cells at or above the feet count open (the flow is not ruled out).
	 * Unknown cells below them are tried both ways, solid (a flow there cannot rise into the body) and open (a drop the
	 * player has not seen under the body draws the slope search toward it), and the earliest arrival counts.
	 */
	static double lavaReachSeconds(LavaSpread.Read known, AABB body, BlockPos cell, int delayTicks) {
		if (overlaps(body, cell)) return 0.0D;
		int feetY = Mth.floor(body.minY + 1.0E-4D);
		double step = delayTicks / 20.0D, best = -1.0D;
		for (boolean unknownBelowOpen : new boolean[] {false, true}) {
			best = earliest(best, reach(known, body, cell, delayTicks, feetY, unknownBelowOpen, false));
			// A source over an open cell falls into it first; once that cell holds lava (which lava cannot replace), vanilla's
			// next tick spreads the source to its sides, one delay later.
			BlockState below = cellState(known, cell.below(), feetY, unknownBelowOpen);
			if (below.getFluidState().isEmpty() && (below.isAir() || below.canBeReplaced(Fluids.LAVA))) {
				double sides = reach(known, body, cell, delayTicks, feetY, unknownBelowOpen, true);
				if (sides >= 0.0D) best = earliest(best, sides + step);
			}
		}
		return best;
	}

	private static double earliest(double best, double seconds) {
		return seconds < 0.0D ? best : best < 0.0D ? seconds : Math.min(best, seconds);
	}

	private static BlockState cellState(LavaSpread.Read known, BlockPos at, int feetY, boolean unknownBelowOpen) {
		BlockState state = known.at(at.getX(), at.getY(), at.getZ());
		return state != null ? state : at.getY() >= feetY || unknownBelowOpen ? Blocks.AIR.defaultBlockState() : Blocks.STONE.defaultBlockState();
	}

	/** One world's spread from the source; {@code belowFilled} holds the source's own cell below as filled. */
	private static double reach(LavaSpread.Read known, AABB body, BlockPos cell, int delayTicks, int feetY, boolean unknownBelowOpen,
			boolean belowFilled) {
		BlockState source = Blocks.LAVA.defaultBlockState(), stone = Blocks.STONE.defaultBlockState();
		BlockPos under = cell.below();
		LavaSpread.Read read = (x, y, z) -> {
			if (x == cell.getX() && y == cell.getY() && z == cell.getZ()) return source;
			if (belowFilled && x == under.getX() && y == under.getY() && z == under.getZ()) return stone;
			return cellState(known, new BlockPos(x, y, z), feetY, unknownBelowOpen);
		};
		double step = delayTicks / 20.0D;
		LongArrayList seeds = new LongArrayList();
		seeds.add(cell.asLong());
		// Vanilla's drop-off and slope search: 1 and 4 where lava is fast (the Nether, 10-tick delay), else 2 and 2.
		boolean fast = delayTicks <= 10;
		LavaSpread.Arrival arrival = LavaSpread.predict(read, seeds, fast ? 1 : 2, fast ? 4 : 2, step,
				(int) Math.ceil(POUR_REACH_SECONDS / step)).box(body);
		return arrival == null ? -1.0D : arrival.seconds();
	}

	/** A known open cell above or beside the landing cell, outside the body, where water would cast the lava, or null. */
	static BlockPos waterCell(LavaSpread.Read known, AABB body, BlockPos cell) {
		for (Direction side : COOLING_SIDES) {
			BlockPos at = cell.relative(side);
			BlockState state = known.at(at.getX(), at.getY(), at.getZ());
			if (state != null && state.isAir() && !overlaps(body, at)) return at;
		}
		return null;
	}

	/** Whether water above or beside the cell casts a lava source placed there (water in the cell itself is replaced). */
	static boolean cooled(BlockGetter level, BlockPos cell) {
		for (Direction side : COOLING_SIDES) {
			if (level.getFluidState(cell.relative(side)).getType().isSame(Fluids.WATER)) return true;
		}
		return false;
	}

	/** Whether the cell already holds a lava source (a pour back into a pool): vanilla leaves the world as it was. */
	static boolean lavaSourceIn(BlockGetter level, BlockPos cell) {
		FluidState fluid = level.getFluidState(cell);
		return fluid.isSource() && fluid.getType().isSame(Fluids.LAVA);
	}

	private static boolean overlaps(AABB body, BlockPos cell) {
		// The edges shrink by a hair, as LavaSpread.Prediction.box: a body flush against a boundary does not overlap.
		return cell.getX() >= Mth.floor(body.minX + 1.0E-4D) && cell.getX() <= Mth.floor(body.maxX - 1.0E-4D)
				&& cell.getY() >= Mth.floor(body.minY + 1.0E-4D) && cell.getY() <= Mth.floor(body.maxY - 1.0E-4D)
				&& cell.getZ() >= Mth.floor(body.minZ + 1.0E-4D) && cell.getZ() <= Mth.floor(body.maxZ - 1.0E-4D);
	}

	/** What the held bucket's ray meets along the current look. */
	static String ray(Player player, ItemStack held) {
		return describe(player.level(), player.getEyePosition(), VanillaItemRay.hit(player, fluids(held)),
				player.blockInteractionRange());
	}

	static String describe(BlockGetter level, Vec3 eye, BlockHitResult hit, double reach) {
		if (hit.getType() != HitResult.Type.BLOCK) return String.format(Locale.ROOT, "nothing within %.1f m", reach);
		BlockPos at = hit.getBlockPos();
		var state = level.getBlockState(at);
		FluidState fluid = level.getFluidState(at);
		String what = fluid.isEmpty() ? BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString()
				: state.getShape(level, at).isEmpty() ? fluidId(fluid) + (fluid.isSource() ? " source" : " (flowing)")
				: BuiltInRegistries.BLOCK.getKey(state.getBlock()) + " holding " + fluidId(fluid);
		return String.format(Locale.ROOT, "%s at %s face %s (%.1f m)", what, xyz(at),
				hit.getDirection().getSerializedName(), eye.distanceTo(hit.getLocation()));
	}

	private static boolean meets(BlockHitResult hit, BlockPos cell) {
		return hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(cell);
	}

	/** Faces whose outward side holds the eye, most squarely facing it first. */
	private static Direction[] facesToward(Vec3 eye, BlockPos cell) {
		Vec3 toEye = eye.subtract(Vec3.atCenterOf(cell));
		return Arrays.stream(Direction.values())
				.sorted(Comparator.comparingDouble(face -> -(face.getStepX() * toEye.x + face.getStepY() * toEye.y + face.getStepZ() * toEye.z)))
				.toArray(Direction[]::new);
	}

	private static String fluidId(FluidState fluid) {
		return BuiltInRegistries.FLUID.getKey(fluid.getType()).toString();
	}

	private static String xyz(BlockPos at) {
		return at.getX() + "," + at.getY() + "," + at.getZ();
	}
}
