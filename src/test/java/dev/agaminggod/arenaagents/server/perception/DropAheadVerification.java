package dev.agaminggod.arenaagents.server.perception;

import java.util.function.IntPredicate;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.piston.PistonMovingBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;

/**
 * Wave-2 drop-ahead: a control result names the seen edge along the view heading. In final-3 the agents scanned four
 * headings with control turns at a basalt-deltas start, got only "Control segment completed", then walked off a
 * 9-block rim, the largest source of fall damage there. Only what the player knows is measured.
 */
public final class DropAheadVerification {
	private static int assertions;

	private DropAheadVerification() {
	}

	public static void main(String[] args) {
		System.out.println("DropAheadVerification: " + verify() + " assertions passed");
	}

	public static int verify() {
		assertions = 0;
		verifyCliff();
		verifyBottomUnseen();
		verifyWalkableGround();
		verifyWallsAndHeading();
		verifyStepUpAndWater();
		verifyRememberedShape();
		verifyStateShapes();
		verifyMovementPreview();
		verifyVoid();
		return assertions;
	}

	private static void verifyMovementPreview() {
		// B3's observed fall was y57 to y31. Unlike the old receipt's 16-cell scan, a seen 26-block trench is measured.
		var trench = new World(-2, 56, 30, DropAhead.Kind.LAVA, x -> false, (x, y, z) -> true);
		var lava = GroundAhead.scan(trench, 0.5, 57, 0.5, 90);
		check(lava.get("status").getAsString().equals("lava") && lava.get("drop").getAsDouble() > 26,
				"a stationary preview names a deep lava landing, including fluid height: " + lava);
		check(lava.get("at").getAsDouble() == 2.75, "preview reports first crossed cell, not remaining safe travel: " + lava);
		var unknown = GroundAhead.scan(new World(-2, 56, 30, DropAhead.Kind.LAVA, x -> false,
				(x, y, z) -> x >= -2 || y >= 57), 0.5, 57, 0.5, 90);
		check(unknown.get("status").getAsString().equals("unknown") && unknown.get("drop").getAsInt() == 0
				&& unknown.get("atLeast").getAsBoolean(), "unseen support is explicit even with zero measured depth: " + unknown);
		var unseenBody = GroundAhead.scan((x, y, z) -> DropAhead.Cell.UNKNOWN, 0.5, 57, 0.5, 90);
		check(unseenBody.get("status").getAsString().equals("unknown"), "unseen body clearance never reads clear");
		var shallow = GroundAhead.scan(new World(-2, 56, 55, DropAhead.Kind.LAVA, x -> false, (x, y, z) -> true), 0.5, 57, 0.5, 90);
		check(shallow.get("status").getAsString().equals("lava"), "shallow lava is reported even below fall-damage depth");
		var away = GroundAhead.scan(trench, 0.5, 57, 0.5, -90);
		check(away.get("status").getAsString().equals("clear") && away.get("at").getAsInt() == 8, "preview follows the current view, not another heading");
		var blocked = GroundAhead.scan(new World(-4, 56, 30, DropAhead.Kind.LAVA, x -> x == -2, (x, y, z) -> true), 0.5, 57, 0.5, 90);
		check(blocked.get("status").getAsString().equals("blocked") && !blocked.has("drop"), "wall hides the trench behind it");
		var deep = GroundAhead.scan(new World(-2, 56, -100, DropAhead.Kind.SOLID, x -> false, (x, y, z) -> true), 0.5, 57, 0.5, 90);
		check(deep.get("status").getAsString().equals("unknown") && deep.get("drop").getAsInt() == 32,
				"a floor beyond search depth remains unverified: " + deep);
		check(GroundAhead.scan(cliff(71), 0.5, 81, 0.5, 90).get("drop").getAsInt() == 9, "preview measures known solid drops");
	}

	private static void verifyVoid() {
		// End runs 2026-10-20: island edges read "drop 4+" or "unknown, drop 32+"; the column past them is empty to the
		// world's bottom, which a player looking over the edge sees as the void.
		var rimOnly = new World(-2, 80, -1_000, DropAhead.Kind.SOLID, x -> false, (x, y, z) -> x >= -2 || y >= 78);
		DropAhead.VoidProbe empty = (x, y, z) -> x < -2;
		var ground = GroundAhead.scan(rimOnly, 0.5, 81, 0.5, 90, empty);
		check(ground.get("status").getAsString().equals("void") && ground.get("at").getAsDouble() == 2.75, "an empty column past an edge is the void: " + ground);
		check(GroundAhead.scan(rimOnly, 0.5, 81, 0.5, 90).get("status").getAsString().equals("unknown"), "without the probe the bottom stays unknown");
		DropAhead.Drop drop = DropAhead.scan(rimOnly, 0.5D, 81.0D, 0.5D, 90.0F, DropAhead.RANGE, empty);
		check(drop != null && "void".equals(drop.into()) && !drop.atLeast() && drop.at() == 2, "the edge ahead drops into the void: " + drop);
		check(DropAhead.hurtful(drop.json()), "a void edge is hurtful");
		DropAhead.Drop floor = DropAhead.scan(rimOnly, 0.5D, 81.0D, 0.5D, 90.0F, DropAhead.RANGE, (x, y, z) -> false);
		check(floor != null && floor.into() == null && floor.atLeast(), "a column with a floor somewhere stays at least its seen depth: " + floor);
	}

	/** Ground top at {@code high} for x >= {@code rim}, else at {@code low}; cells pass {@code known} or are unknown. */
	private record World(int rim, int high, int low, DropAhead.Kind lowKind, IntPredicate wallAtX, KnownCell known) implements DropAhead.Cells {
		@Override
		public DropAhead.Cell at(int x, int y, int z) {
			if (!known.test(x, y, z)) return DropAhead.Cell.UNKNOWN;
			if (wallAtX.test(x) && y <= high + 2) return new DropAhead.Cell(DropAhead.Kind.SOLID, 1.0D);
			int top = x >= rim ? high : low;
			if (y < top) return new DropAhead.Cell(DropAhead.Kind.SOLID, 1.0D);
			if (y == top) return new DropAhead.Cell(x >= rim ? DropAhead.Kind.SOLID : lowKind, lowKind == DropAhead.Kind.SOLID || x >= rim ? 1.0D : 0.875D);
			return DropAhead.Cell.OPEN;
		}
	}

	private interface KnownCell {
		boolean test(int x, int y, int z);
	}

	private static World cliff(int low) {
		// Ground top surface at y 81 (cells up to 80 solid), rim after x = -2, lower ground surface at low + 1.
		return new World(-2, 80, low, DropAhead.Kind.SOLID, x -> false, (x, y, z) -> true);
	}

	private static DropAhead.Drop west(DropAhead.Cells cells) {
		return DropAhead.scan(cells, 0.5D, 81.0D, 0.5D, 90.0F, DropAhead.RANGE);
	}

	private static void verifyCliff() {
		DropAhead.Drop drop = west(cliff(71));
		check(drop != null && drop.drop() == 9 && !drop.atLeast() && drop.into() == null, "a seen 9-block rim is reported: " + drop);
		check(drop.at() == 2, "two whole blocks of ground lie before the rim: " + drop);
		check("{\"drop\":9,\"at\":2}".equals(drop.json().toString()), "compact facts: " + drop.json());
		check(west(cliff(77)) == null, "a 3-block drop does no damage and is not reported");
		DropAhead.Drop four = west(cliff(76));
		check(four != null && four.drop() == 4, "a 4-block drop can hurt and is reported: " + four);
		check(DropAhead.scan(cliff(71), 0.5D, 81.0D, 0.5D, -90.0F, DropAhead.RANGE) == null, "facing away from the rim, nothing is reported");
		check(DropAhead.scan(cliff(71), 0.5D, 81.0D, 0.5D, 90.0F, 2) == null, "a rim beyond the range is not reported");
	}

	private static void verifyBottomUnseen() {
		// Looking level over a rim, the eye sees the open cell right past it but not the cells below.
		DropAhead.Drop rim = west(new World(-2, 80, 71, DropAhead.Kind.SOLID, x -> false, (x, y, z) -> x >= -2 || y >= 80));
		check(rim != null && rim.drop() == 1 && rim.atLeast() && rim.at() == 2, "an edge whose bottom is unseen reads as at least the known open depth: " + rim);
		check("{\"drop\":1,\"atLeast\":true,\"at\":2}".equals(rim.json().toString()), "unseen bottom is marked atLeast: " + rim.json());
		DropAhead.Drop deeper = west(new World(-2, 80, 71, DropAhead.Kind.SOLID, x -> false, (x, y, z) -> x >= -2 || y >= 76));
		check(deeper != null && deeper.drop() == 5 && deeper.atLeast(), "five open cells seen below the rim, then unknown: at least 5: " + deeper);
		check(west(new World(-2, 80, 71, DropAhead.Kind.SOLID, x -> false, (x, y, z) -> x >= -2 || y >= 81)) == null,
				"nothing known below the ground ahead is no fact: an unseen floor is not called a drop");
		check(west(new World(-2, 80, 71, DropAhead.Kind.SOLID, x -> false, (x, y, z) -> x >= -1)) == null,
				"a column not seen at body height ends the walk without a fact");
		check(west(new World(-2, 80, -100, DropAhead.Kind.SOLID, x -> false, (x, y, z) -> true)).drop() == 16,
				"a void with no floor within 16 blocks reads as at least 16");
	}

	private static void verifyWalkableGround() {
		check(west(new World(-100, 80, 80, DropAhead.Kind.SOLID, x -> false, (x, y, z) -> true)) == null, "flat known ground: no fact");
		// Steps of 2 blocks down each: every step is safe, the total is not a fall.
		DropAhead.Cells stairs = (x, y, z) -> {
			int top = x >= 0 ? 80 : 80 - 2 * (-x);
			return y <= top ? new DropAhead.Cell(DropAhead.Kind.SOLID, 1.0D) : DropAhead.Cell.OPEN;
		};
		check(west(stairs) == null, "a staircase of 2-block steps is walkable and not reported as a drop");
	}

	private static void verifyWallsAndHeading() {
		World walled = new World(-4, 80, 71, DropAhead.Kind.SOLID, x -> x == -2, (x, y, z) -> true);
		check(west(walled) == null, "a wall before the rim ends the walk: the rim behind it is not reported");
		// A one-block ledge is a jump: the rim beyond it is measured from the raised ground.
		DropAhead.Cells ledge = (x, y, z) -> {
			int top = x >= 0 ? 80 : x >= -2 ? 81 : 71;
			return y <= top ? new DropAhead.Cell(DropAhead.Kind.SOLID, 1.0D) : DropAhead.Cell.OPEN;
		};
		DropAhead.Drop afterLedge = west(ledge);
		check(afterLedge != null && afterLedge.drop() == 10 && afterLedge.at() == 2, "a rim past a one-block ledge drops from the ledge top: " + afterLedge);
	}

	private static void verifyStepUpAndWater() {
		DropAhead.Drop water = west(new World(-2, 80, 71, DropAhead.Kind.WATER, x -> false, (x, y, z) -> true));
		check(water != null && "water".equals(water.into()) && water.drop() == 9, "a landing in water is named: " + water);
		DropAhead.Drop lava = west(new World(-2, 80, 71, DropAhead.Kind.LAVA, x -> false, (x, y, z) -> true));
		check(lava != null && "lava".equals(lava.into()), "a landing in lava is named: " + lava);
		check(west(new World(-2, 80, 79, DropAhead.Kind.LAVA, x -> false, (x, y, z) -> true)) == null,
				"shallow fluid ahead is not a fall and ends the walk without a drop fact");
	}

	private static void verifyRememberedShape() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
		PistonWorld world = new PistonWorld();
		SeenTerrain.Memory<BlockState> memory = new SeenTerrain.Memory<>();
		var acquired = new SeenTerrain.Reader<>(memory, world, 0L, null);
		west(DropAhead.cells(acquired, world));
		acquired.known(-3, 71, 0);
		world.visible = false;
		world.moved = true;
		var remembered = new SeenTerrain.Reader<>(memory, world, 3L, null);
		check(remembered.known(-3, 71, 0).is(Blocks.MOVING_PISTON), "hidden live air does not replace the remembered piston state");
		DropAhead.Drop before = west(DropAhead.cells(remembered, world));
		world.piston = null;
		DropAhead.Drop after = west(DropAhead.cells(new SeenTerrain.Reader<>(memory, world, 4L, null), world));
		check(before != null && before.equals(after), "an unseen piston entity change cannot change the drop: " + before + " -> " + after);
		check(world.entityReads == 0, "drop facts never read live block entities");
		check(before.drop() == 9 && before.atLeast(), "a remembered state cannot resolve a moving piston surface: " + before);
	}

	private static void verifyStateShapes() {
		check(cell(Blocks.STONE.defaultBlockState()).equals(new DropAhead.Cell(DropAhead.Kind.SOLID, 1.0D)), "ordinary ground keeps its state-derived collision");
		check(cell(Blocks.OAK_SLAB.defaultBlockState()).equals(new DropAhead.Cell(DropAhead.Kind.SOLID, 0.5D)), "a bottom slab keeps its half-block surface");
		check(cell(Blocks.CHEST.defaultBlockState()).kind() == DropAhead.Kind.SOLID, "a chest's state-derived collision needs no block entity");
		check(cell(Blocks.WATER.defaultBlockState()).kind() == DropAhead.Kind.WATER, "known water remains water");
		check(cell(Blocks.LAVA.defaultBlockState()).kind() == DropAhead.Kind.LAVA, "known lava remains lava");
		check(cell(Blocks.AIR.defaultBlockState()).equals(DropAhead.Cell.OPEN), "known air remains open");
		check(cell(null).equals(DropAhead.Cell.UNKNOWN), "unknown terrain remains unknown");
	}

	private static DropAhead.Cell cell(BlockState state) {
		var reader = new SeenTerrain.Reader<>(new SeenTerrain.Memory<BlockState>(), new SeenTerrain.Source<BlockState>() {
			@Override
			public BlockState live(int x, int y, int z) {
				return state;
			}

			@Override
			public boolean sees(int x, int y, int z) {
				return true;
			}
		}, 0L, null);
		return DropAhead.cells(reader, EmptyBlockGetter.INSTANCE).at(0, 0, 0);
	}

	private static final class PistonWorld implements BlockGetter, SeenTerrain.Source<BlockState> {
		private final BlockPos position = new BlockPos(-3, 71, 0);
		private final BlockState moving = Blocks.MOVING_PISTON.defaultBlockState();
		private BlockEntity piston = new PistonMovingBlockEntity(position, moving, Blocks.STONE.defaultBlockState(), Direction.EAST, true, false);
		private boolean visible = true;
		private boolean moved;
		private int entityReads;

		@Override
		public BlockState live(int x, int y, int z) {
			if (x == -3 && y == 71 && z == 0 && !moved) return moving;
			return y <= (x >= -2 ? 80 : 69) ? Blocks.STONE.defaultBlockState() : Blocks.AIR.defaultBlockState();
		}

		@Override
		public boolean sees(int x, int y, int z) {
			return visible;
		}

		@Override
		public BlockEntity getBlockEntity(BlockPos position) {
			entityReads++;
			return position.equals(this.position) ? piston : null;
		}

		@Override
		public BlockState getBlockState(BlockPos position) {
			return live(position.getX(), position.getY(), position.getZ());
		}

		@Override
		public FluidState getFluidState(BlockPos position) {
			return getBlockState(position).getFluidState();
		}

		@Override
		public int getHeight() {
			return 384;
		}

		@Override
		public int getMinY() {
			return -64;
		}
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
