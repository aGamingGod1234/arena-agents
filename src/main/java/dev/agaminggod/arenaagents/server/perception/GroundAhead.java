package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonObject;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;

/** A stationary, view-heading terrain fact. It never changes input or treats unseen cells as support. */
public final class GroundAhead {
	private static final int DEPTH = 32;
	private GroundAhead() { }

	public static JsonObject facts(ServerPlayer player) {
		if (!player.onGround()) return null;
		var level = player.level();
		return scan(DropAhead.cells(SeenTerrain.of(player), level),
				player.getX(), player.getY(), player.getZ(), player.getYRot(), (x, y, z) -> VoidColumn.below(level, x, y, z));
	}

	public static String describe(ServerPlayer player) {
		var facts = facts(player);
		return facts == null ? "" : "; groundAhead " + facts;
	}

	/** Samples the centerline, not a swept body or a verified route; range is horizontal blocks. */
	static JsonObject scan(DropAhead.Cells cells, double x, double y, double z, float yaw) {
		return scan(cells, x, y, z, yaw, DropAhead.NO_VOID);
	}

	/** As above; {@code voids} says whether a column is empty from a height to the world's bottom (status "void"). */
	static JsonObject scan(DropAhead.Cells cells, double x, double y, double z, float yaw, DropAhead.VoidProbe voids) {
		double heading = Math.toRadians(yaw), floor = y;
		int lastX = Mth.floor(x), lastZ = Mth.floor(z);
		for (double distance = 0.25; distance <= DropAhead.RANGE; distance += 0.25) {
			int cx = Mth.floor(x - Math.sin(heading) * distance), cz = Mth.floor(z + Math.cos(heading) * distance);
			if (cx == lastX && cz == lastZ) continue;
			lastX = cx; lastZ = cz;
			int body = Mth.floor(floor + 0.5);
			var feet = cells.at(cx, body, cz);
			if (feet.kind() == DropAhead.Kind.UNKNOWN) return fact("unknown", distance);
			if (feet.kind() == DropAhead.Kind.LAVA || feet.kind() == DropAhead.Kind.WATER) {
				return fact(feet.kind() == DropAhead.Kind.LAVA ? "lava" : "water", distance);
			}
			if (feet.kind() == DropAhead.Kind.SOLID) {
				double top = body + feet.top();
				if (top - floor > 1.001) return fact("blocked", distance);
				body = Mth.floor(top + 0.5);
				floor = top;
			}
			for (int up = 0; up <= 1; up++) {
				var kind = cells.at(cx, body + up, cz).kind();
				if (kind == DropAhead.Kind.UNKNOWN) return fact("unknown", distance);
				if (kind != DropAhead.Kind.OPEN) return fact("blocked", distance);
			}
			for (int down = 1; down <= DEPTH; down++) {
				var below = cells.at(cx, body - down, cz);
				double knownDepth = floor - (body - down + 1);
				if (below.kind() == DropAhead.Kind.UNKNOWN || down == DEPTH && below.kind() == DropAhead.Kind.OPEN) {
					if (voids.empty(cx, body - down, cz)) return fact("void", distance);
					var result = fact("unknown", distance);
					result.addProperty("drop", Math.max(0, below.kind() == DropAhead.Kind.OPEN ? knownDepth + 1 : knownDepth));
					result.addProperty("atLeast", true);
					return result;
				}
				if (below.kind() == DropAhead.Kind.OPEN) continue;
				double top = body - down + below.top(), depth = floor - top;
				if (below.kind() != DropAhead.Kind.SOLID || depth >= 3.999) {
					var result = fact(below.kind() == DropAhead.Kind.LAVA ? "lava"
							: below.kind() == DropAhead.Kind.WATER ? "water" : "drop", distance);
					result.addProperty("drop", Math.round(depth * 10) / 10.0);
					return result;
				}
				floor = top;
				break;
			}
		}
		return fact("clear", DropAhead.RANGE);
	}

	private static JsonObject fact(String status, double at) {
		var fact = new JsonObject();
		fact.addProperty("status", status);
		fact.addProperty("at", at);
		return fact;
	}
}
