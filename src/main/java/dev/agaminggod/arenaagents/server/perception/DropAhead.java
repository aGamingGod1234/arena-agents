package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.material.LavaFluid;

/**
 * The ground along the view heading as the player knows it ({@link SeenTerrain}: seen now or remembered, lava opaque):
 * the first edge within {@link #RANGE} blocks whose drop could hurt ({@link #HURTFUL_DROP} blocks or more), or whose
 * bottom is not known. Shorter steps down and one block up are followed; a wall, an unseen
 * cell at body height or fluid at foot level ends the walk without a fact. Called once when a control result is built,
 * never per tick. A cliff a player looking ahead could see is reported; one out of sight is not.
 */
public final class DropAhead {
	/** Blocks along the heading: about what a 40-tick walk covers. */
	public static final int RANGE = 8;
	/** Blocks along the direction of motion that count as approaching an edge: about half a second of sprinting. */
	static final int APPROACH_RANGE = 3;
	/** Horizontal blocks per tick below which the body is not carried toward anything (a walk is about 0.2). */
	private static final double MOVING = 0.06D;
	/** Vanilla fall damage is floor(distance - 3): the first hurtful drop is 4 blocks. */
	static final int HURTFUL_DROP = 4;
	private static final int DEPTH = 16;
	private static final double EPSILON = 1.0E-3D;

	private DropAhead() {
	}

	enum Kind { UNKNOWN, OPEN, SOLID, WATER, LAVA }

	/** One cell as known: what it is and, for solids and fluids, the height of its top within the cell (0 to 1.5). */
	record Cell(Kind kind, double top) {
		static final Cell UNKNOWN = new Cell(Kind.UNKNOWN, 0.0D);
		static final Cell OPEN = new Cell(Kind.OPEN, 0.0D);
	}

	/** Cells as the player knows them. */
	interface Cells {
		Cell at(int x, int y, int z);
	}

	/** Whether the column at (x, z) is empty from y down past the world's bottom ({@link VoidColumn}). */
	interface VoidProbe {
		boolean empty(int x, int y, int z);
	}

	static final VoidProbe NO_VOID = (x, y, z) -> false;

	/**
	 * An edge {@code at} whole blocks of ground ahead, dropping {@code drop} blocks (at least that far when
	 * {@code atLeast}: the bottom is not known), landing in {@code into} ("water", "lava", "void": nothing down to the world's bottom) or null.
	 */
	record Drop(int at, int drop, boolean atLeast, String into) {
		JsonObject json() {
			JsonObject json = new JsonObject();
			json.addProperty("drop", drop);
			if (atLeast) json.addProperty("atLeast", true);
			if (into != null) json.addProperty("into", into);
			json.addProperty("at", at);
			return json;
		}
	}

	/** Walks the heading {@code yaw} from feet position (x, y, z); null when no hurtful or unmeasured edge is known. */
	static Drop scan(Cells cells, double x, double y, double z, float yaw, int range) {
		return scan(cells, x, y, z, yaw, range, NO_VOID);
	}

	/** As above; an edge over an empty column reports {@code into:"void"} with its depth to the world's bottom. */
	static Drop scan(Cells cells, double x, double y, double z, float yaw, int range, VoidProbe voids) {
		double radians = Math.toRadians(yaw);
		double dirX = -Math.sin(radians), dirZ = Math.cos(radians);
		double floor = y;
		int lastX = Mth.floor(x), lastZ = Mth.floor(z);
		for (double distance = 0.25D; distance <= range; distance += 0.25D) {
			int cx = Mth.floor(x + dirX * distance), cz = Mth.floor(z + dirZ * distance);
			if (cx == lastX && cz == lastZ) continue;
			lastX = cx;
			lastZ = cz;
			int body = Mth.floor(floor + 0.5D);
			Cell feet = cells.at(cx, body, cz);
			if (feet.kind() == Kind.SOLID) {
				// One block up is a jump; anything taller, or no headroom above it, is a wall.
				double surface = body + feet.top();
				if (surface - floor > 1.0D + EPSILON || !open(cells, cx, Mth.floor(surface + 0.5D), cz)) return null;
				floor = surface;
				continue;
			}
			if (feet.kind() != Kind.OPEN || cells.at(cx, body + 1, cz).kind() != Kind.OPEN) return null;
			int at = (int) Math.floor(distance);
			Drop drop = null;
			boolean landed = false;
			for (int down = 1; down <= DEPTH && !landed; down++) {
				Cell below = cells.at(cx, body - down, cz);
				switch (below.kind()) {
					case OPEN -> {
						if (down == DEPTH) drop = voids.empty(cx, body - down, cz) ? voidDrop(at, floor, cells)
								: new Drop(at, (int) Math.floor(floor - (body - down) + EPSILON), true, null);
					}
					case UNKNOWN -> {
						// Known open down to the top of this unseen cell: at least that deep, bottom unknown. Nothing known
						// below the ground cell ahead is no fact at all.
						int known = (int) Math.floor(floor - (body - down + 1) + EPSILON);
						if (known < 1) return null;
						drop = voids.empty(cx, body - down, cz) ? voidDrop(at, floor, cells) : new Drop(at, known, true, null);
						landed = true;
					}
					default -> {
						double surface = body - down + below.top();
						double depth = floor - surface;
						if (depth > HURTFUL_DROP - EPSILON) {
							String into = below.kind() == Kind.WATER ? "water" : below.kind() == Kind.LAVA ? "lava" : null;
							drop = new Drop(at, (int) Math.floor(depth + EPSILON), false, into);
						} else if (below.kind() != Kind.SOLID) {
							return null;
						} else {
							floor = surface;
						}
						landed = true;
					}
				}
			}
			if (drop != null) return drop;
		}
		return null;
	}

	private static Drop voidDrop(int at, double floor, Cells cells) {
		int bottom = cells instanceof KnownCells known ? known.minY : 0;
		return new Drop(at, (int) Math.floor(floor - bottom + EPSILON), false, "void");
	}

	private static boolean open(Cells cells, int x, int body, int z) {
		return cells.at(x, body, z).kind() == Kind.OPEN && cells.at(x, body + 1, z).kind() == Kind.OPEN;
	}

	/** The drop ahead of the body's view heading as known now, or null. Server thread only. */
	public static JsonObject facts(ServerPlayer player) {
		if (!player.onGround()) return null;
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		var level = player.level();
		Cells cells = cells(seen, level);
		Drop drop = scan(cells, player.getX(), player.getY(), player.getZ(), player.getYRot(), RANGE, (x, y, z) -> VoidColumn.below(level, x, y, z));
		return drop == null ? null : drop.json();
	}

	/**
	 * A known hurtful drop within {@link #APPROACH_RANGE} blocks along the way the body is moving on the ground (walking,
	 * sprinting or carried by a hit), or null. Sneaking stops a player at edges, so a crouched body approaches nothing.
	 */
	public static JsonObject approachFacts(ServerPlayer player) {
		if (!player.onGround() || player.isCrouching()) return null;
		var motion = player.getDeltaMovement();
		if (Math.hypot(motion.x, motion.z) < MOVING) return null;
		float heading = (float) Math.toDegrees(Math.atan2(-motion.x, motion.z));
		var level = player.level();
		Drop drop = scan(cells(SeenTerrain.of(player), level), player.getX(), player.getY(), player.getZ(), heading, APPROACH_RANGE,
				(x, y, z) -> VoidColumn.below(level, x, y, z));
		return drop == null ? null : drop.json();
	}

	/**
	 * Every field an authored condition can read from an approach fact, including distance thresholds;
	 * null when there is no drop ahead. Sample identity is separate from model attention.
	 */
	public static String geometryKey(JsonObject facts) {
		if (facts == null) return null;
		return facts.get("at").getAsInt() + ":" + facts.get("drop").getAsInt() + (facts.has("atLeast") && facts.get("atLeast").getAsBoolean() ? "+" : "")
				+ (facts.has("into") ? ":" + facts.get("into").getAsString() : "");
	}

	/**
	 * Whether an approach fact describes a landing that can hurt: a fluid landing cancels fall damage
	 * ({@link FallDanger}), but lava burns, and an edge whose bottom is not known stays a possible harm.
	 */
	public static boolean hurtful(JsonObject facts) {
		return facts != null && !(facts.has("into") && "water".equals(facts.get("into").getAsString()));
	}

	static Cells cells(SeenTerrain.Reader<BlockState> seen, BlockGetter dimensions) {
		return new KnownCells(seen, dimensions.getHeight(), dimensions.getMinY());
	}

	/** Collision dependencies come only from known states; block entities are not part of that memory. */
	private static final class KnownCells implements Cells, BlockGetter {
		private final SeenTerrain.Reader<BlockState> seen;
		private final int height;
		private final int minY;
		private final BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
		private boolean missing;

		KnownCells(SeenTerrain.Reader<BlockState> seen, int height, int minY) {
			this.seen = seen;
			this.height = height;
			this.minY = minY;
		}

		@Override
		public Cell at(int x, int y, int z) {
			BlockState state = seen.known(x, y, z);
			if (state == null) return Cell.UNKNOWN;
			missing = false;
			var shape = state.getCollisionShape(this, cursor.set(x, y, z));
			if (missing) return Cell.UNKNOWN;
			if (!shape.isEmpty()) return new Cell(Kind.SOLID, shape.max(Direction.Axis.Y));
			FluidState fluid = state.getFluidState();
			if (fluid.isEmpty()) return Cell.OPEN;
			return new Cell(fluid.getType() instanceof LavaFluid ? Kind.LAVA : Kind.WATER, fluid.getOwnHeight());
		}

		@Override
		public BlockState getBlockState(BlockPos position) {
			BlockState state = seen.known(position.getX(), position.getY(), position.getZ());
			if (state != null) return state;
			// The placeholder lets the shape finish, but any shape using it is discarded as unknown.
			missing = true;
			return Blocks.AIR.defaultBlockState();
		}

		@Override
		public BlockEntity getBlockEntity(BlockPos position) {
			missing = true;
			return null;
		}

		@Override
		public FluidState getFluidState(BlockPos position) {
			return getBlockState(position).getFluidState();
		}

		@Override
		public int getHeight() {
			return height;
		}

		@Override
		public int getMinY() {
			return minY;
		}
	}

	/** "; ahead {...}" for a result message, or "" when nothing is known ahead. */
	public static String describe(ServerPlayer player) {
		JsonObject facts = facts(player);
		return facts == null ? "" : "; ahead " + facts;
	}
}
