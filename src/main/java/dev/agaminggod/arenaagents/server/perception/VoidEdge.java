package dev.agaminggod.arenaagents.server.perception;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;

/**
 * Whether held walking input is about to carry a grounded body off an edge into the void ({@link VoidColumn}): the
 * edge a player sees before pressing forward. A model's raw control segment is authored seconds before it runs (live
 * End run d6-end-a: a sprint_away reflex had already carried the body to an island rim, then the model's 20-tick sprint
 * authored from the old position ran off it). Sneak (vanilla holds the body on the edge) and jump (a chosen leap) are
 * never stopped.
 */
public final class VoidEdge {
	/** Half the player's box width: the body falls once its whole box has left the last supporting column. */
	static final double HALF_WIDTH = 0.299D;
	private static final double STEP = 0.2D;

	private VoidEdge() {
	}

	/** Whether the column at (x, z) is empty from the feet cell down past the world's bottom. */
	interface Columns {
		boolean voidAt(int x, int z);
	}

	/**
	 * The feet cell over the void the body would walk into with this input before released input could stop it, or
	 * null. {@code forward}/{@code strafe} and {@code yaw} are the held movement.
	 */
	public static BlockPos ahead(ServerPlayer player, float forward, float strafe, float yaw, boolean jump, boolean sneak) {
		if (!player.onGround() || jump || sneak || player.isPassenger() || player.getAbilities().flying || player.isInWater()) return null;
		var level = player.level();
		int feetY = Mth.floor(player.getY() + 1.0E-4D);
		var motion = player.getDeltaMovement();
		double[] hit = scan(player.getX(), player.getZ(), forward, strafe, yaw, Math.hypot(motion.x, motion.z),
				(x, z) -> VoidColumn.below(level, x, feetY, z));
		return hit == null ? null : BlockPos.containing(hit[0], feetY, hit[1]);
	}

	/**
	 * The first point along the movement where the body's box has only void columns under it, within the distance it
	 * covers before released input stops it (vanilla ground friction: each tick keeps 0.546 of the motion, so it
	 * slides about 2.2 times its current per-tick motion), plus a margin; null when the way stays over ground.
	 */
	static double[] scan(double x, double z, float forward, float strafe, float yaw, double speed, Columns columns) {
		double length = Math.hypot(forward, strafe);
		if (length < 0.05D) return null;
		double radians = Math.toRadians(yaw);
		double sin = Math.sin(radians), cos = Math.cos(radians);
		// Vanilla moveRelative: strafe is +x local (left), forward is +z local, rotated by the yaw.
		double dx = (strafe * cos - forward * sin) / length;
		double dz = (forward * cos + strafe * sin) / length;
		double reach = 0.5D + 3.0D * Math.max(speed, 0.1D);
		for (double distance = STEP; ; distance = Math.min(reach, distance + STEP)) {
			double px = x + dx * distance, pz = z + dz * distance;
			if (unsupported(px, pz, columns)) return new double[] {px, pz};
			if (distance >= reach) return null;
		}
	}

	private static boolean unsupported(double x, double z, Columns columns) {
		for (int corner = 0; corner < 4; corner++) {
			double cx = x + ((corner & 1) == 0 ? -HALF_WIDTH : HALF_WIDTH);
			double cz = z + ((corner & 2) == 0 ? -HALF_WIDTH : HALF_WIDTH);
			if (!columns.voidAt(Mth.floor(cx), Mth.floor(cz))) return false;
		}
		return true;
	}

	/** The stop message: where the void is and how to go on anyway. */
	public static String stopMessage(BlockPos cell) {
		return "Stopped before walking off an edge into the void at " + cell.getX() + "," + cell.getY() + "," + cell.getZ()
				+ " (nothing below to the world's bottom); input released. sneak:true walks to the edge without falling; jump:true leaps";
	}
}
