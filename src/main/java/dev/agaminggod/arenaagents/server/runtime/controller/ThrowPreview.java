package dev.agaminggod.arenaagents.server.runtime.controller;

import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.VoxelShape;

/** Nominal vanilla flight against acquired terrain only; never authorizes or refuses a throw. */
public final class ThrowPreview {
	private static final double SPEED = 1.5D, GRAVITY = 0.03D, AIR_DRAG = (double) 0.99F;
	private static final int MAX_TICKS = 200;
	private ThrowPreview() { }

	public static boolean supported(ItemStack stack) {
		return stack.is(Items.ENDER_PEARL) || stack.is(Items.SNOWBALL) || stack.is(Items.EGG)
				|| stack.is(Items.BLUE_EGG) || stack.is(Items.BROWN_EGG);
	}

	interface Terrain {
		VoxelShape shape(BlockPos cell);
		default boolean water(BlockPos cell) { return false; }
		/** Whether the column at (x, z) is empty from y down past the world's bottom: the void a thrower sees under an island edge. */
		default boolean voidBelow(int x, int y, int z) { return false; }
	}

	public static JsonObject sample(ServerPlayer player, ItemStack stack, Vec3 aim) {
		if (!supported(stack)) return null;
		var seen = SeenTerrain.of(player);
		var geometry = new AcquiredGeometry(player.level(), cell -> seen.known(cell.getX(), cell.getY(), cell.getZ()));
		Terrain terrain = new Terrain() {
			public VoxelShape shape(BlockPos cell) {
				var state = seen.known(cell.getX(), cell.getY(), cell.getZ());
				return state == null ? null : geometry.shape(state, cell);
			}
			public boolean water(BlockPos cell) {
				var state = seen.known(cell.getX(), cell.getY(), cell.getZ());
				return state != null && state.getFluidState().is(FluidTags.WATER);
			}
			public boolean voidBelow(int x, int y, int z) {
				return dev.agaminggod.arenaagents.server.perception.VoidColumn.below(player.level(), x, y, z);
			}
		};
		Vec3 eye = player.getEyePosition();
		Vec3 movement = player.getKnownMovement();
		Vec3 velocity = (aim == null ? player.getViewVector(1.0F) : aim.subtract(eye).normalize()).scale(SPEED)
				.add(movement.x, player.onGround() ? 0 : movement.y, movement.z);
		JsonObject result = predict(terrain, eye.add(0, -0.10000000149011612D, 0), velocity, player.level().getMinY());
		if (aim != null) addAimOffset(result, eye, aim);
		addMobsNearLanding(result, player);
		// The throw holds this view, and it stays after the throw: on a calm enderman's eyes it is a provoking stare.
		var stared = EndermanGaze.staredAt(player, aim == null ? player.getViewVector(1.0F) : aim.subtract(eye), null);
		if (stared != null) {
			JsonObject gaze = new JsonObject();
			gaze.addProperty("id", stared.getStringUUID());
			gaze.addProperty("distance", Math.round(player.distanceTo(stared)));
			result.add("viewMeetsEndermanEyes", gaze);
		}
		return result;
	}

	/** Mobs that can fight within this many blocks of the landing reach the thrower within a second or two of arrival. */
	static final double LANDING_COMPANY_RADIUS = 8.0D;

	/**
	 * Visible hostile or neutral mobs around the predicted landing, nearest first: a thrower sees who waits where the
	 * pearl comes down (live End run 2026-10-20 landed five blocks from two endermen and died in four seconds). One
 * already after the thrower is marked angry (run d9-end-b pearled beside the enderman it had provoked and died).
	 */
	private static void addMobsNearLanding(JsonObject result, ServerPlayer player) {
		JsonObject cell = result.has("impactCell") ? result.getAsJsonObject("impactCell")
				: result.has("unknownCell") ? result.getAsJsonObject("unknownCell") : null;
		if (cell == null || !(player.level() instanceof net.minecraft.server.level.ServerLevel level)) return;
		Vec3 landing = new Vec3(cell.get("x").getAsInt() + 0.5D, cell.get("y").getAsInt() + 1.0D, cell.get("z").getAsInt() + 0.5D);
		var candidates = level.getEntitiesOfClass(net.minecraft.world.entity.Mob.class, new AABB(landing, landing).inflate(LANDING_COMPANY_RADIUS),
				mob -> mob.isAlive() && (mob instanceof net.minecraft.world.entity.monster.Enemy || mob instanceof net.minecraft.world.entity.NeutralMob)
						&& mob.position().distanceTo(landing) <= LANDING_COMPANY_RADIUS);
		if (candidates.isEmpty()) return;
		var frame = dev.agaminggod.arenaagents.server.perception.ObservationVisibility.frame(level, player);
		var mobs = new java.util.ArrayList<>(candidates.stream().filter(frame::canSeeEntity).toList());
		if (mobs.isEmpty()) return;
		mobs.sort(java.util.Comparator.comparingDouble(mob -> mob.position().distanceToSqr(landing)));
		com.google.gson.JsonArray near = new com.google.gson.JsonArray();
		for (var mob : mobs.subList(0, Math.min(4, mobs.size()))) {
			JsonObject row = new JsonObject();
			row.addProperty("type", net.minecraft.core.registries.BuiltInRegistries.ENTITY_TYPE.getKey(mob.getType()).toString());
			row.addProperty("distance", Math.round(mob.position().distanceTo(landing) * 10.0D) / 10.0D);
			// Who is already after the thrower: an angry enderman's open jaw and shaking, or any mob's chase.
			if (mob.getTarget() == player || mob instanceof net.minecraft.world.entity.monster.Enderman enderman && enderman.isCreepy()) {
				row.addProperty("angry", true);
				row.addProperty("id", mob.getStringUUID());
			}
			near.add(row);
		}
		result.add("mobsNearLanding", near);
		if (mobs.size() > near.size()) result.addProperty("moreMobsNearLanding", mobs.size() - near.size());
	}

	/**
	 * Where the predicted impact lies against the chosen aim point, as a thrower sees the item fall short: blocks below
	 * (negative: above) and blocks short of it horizontally (negative: past it). A throw that lands low or short needs a
	 * higher aim point.
	 */
	static void addAimOffset(JsonObject result, Vec3 eye, Vec3 aim) {
		JsonObject cell = result.has("impactCell") ? result.getAsJsonObject("impactCell")
				: result.has("unknownCell") ? result.getAsJsonObject("unknownCell") : null;
		if (cell == null) return;
		double x = cell.get("x").getAsInt() + 0.5D, y = cell.get("y").getAsInt() + 1.0D, z = cell.get("z").getAsInt() + 0.5D;
		JsonObject offset = new JsonObject();
		offset.addProperty("below", Math.round(aim.y - y));
		offset.addProperty("short", Math.round(Math.hypot(aim.x - eye.x, aim.z - eye.z) - Math.hypot(x - eye.x, z - eye.z)));
		result.add("aimOffset", offset);
	}

	static JsonObject predict(Terrain terrain, Vec3 start, Vec3 velocity, int minY) {
		Vec3 point = start;
		for (int tick = 1; tick <= MAX_TICKS; tick++) {
			// ThrowableProjectile.tick in 26.1.2 applies gravity, then inertia, then traces the move.
			velocity = velocity.add(0, -GRAVITY, 0).scale(terrain.water(BlockPos.containing(point)) ? (double) 0.8F : AIR_DRAG);
			Vec3 next = point.add(velocity);
			Vec3 nearest = null;
			BlockPos hitCell = null;
			Direction face = null;
			boolean unknown = false;
			for (BlockPos cell : BlockPos.betweenClosed(BlockPos.containing(new Vec3(Math.min(point.x, next.x), Math.min(point.y, next.y), Math.min(point.z, next.z))),
					BlockPos.containing(new Vec3(Math.max(point.x, next.x), Math.max(point.y, next.y), Math.max(point.z, next.z))))) {
				if (cell.getY() < minY) continue;
				VoxelShape shape = terrain.shape(cell);
				if (shape == null) {
					AABB bounds = new AABB(cell);
					Vec3 entry = bounds.contains(point) ? point : bounds.clip(point, next).orElse(null);
					if (entry != null && (nearest == null || point.distanceToSqr(entry) < point.distanceToSqr(nearest))) {
						nearest = entry; hitCell = cell.immutable(); unknown = true; face = null;
					}
				} else {
					var hit = shape.clip(point, next, cell);
					if (hit != null && (nearest == null || point.distanceToSqr(hit.getLocation()) < point.distanceToSqr(nearest))) {
						nearest = hit.getLocation(); hitCell = cell.immutable(); face = hit.getDirection(); unknown = false;
					}
				}
			}
			if (nearest != null) {
				JsonObject result = result(start, nearest, tick, unknown ? "unknown_terrain" : "observed_impact");
				result.add(unknown ? "unknownCell" : "impactCell", cell(hitCell));
				if (!unknown) {
					result.addProperty("face", face.getName());
					// ThrownEnderpearl.onHit teleports the thrower to oldPosition(): where the pearl was when this tick
					// began, short of the face it struck. Off a wall face that is open air beside it.
					Vec3 arrival = point;
					result.add("arrival", point(arrival));
					result.addProperty("footing", !"void".equals(below(terrain, arrival, minY)) && !"unknown".equals(below(terrain, arrival, minY)));
					result.addProperty("headroom", headroom(terrain, arrival));
					result.addProperty("below", below(terrain, arrival, minY));
					double drop = drop(terrain, arrival, minY);
					if (!Double.isNaN(drop)) result.addProperty("dropAfterArrival", Math.round(drop * 10.0D) / 10.0D);
				} else result.addProperty("below", "unknown");
				return result;
			}
			point = next;
			if (point.y < minY) {
				JsonObject result = result(start, point, tick, "void");
				result.addProperty("footing", false); result.addProperty("below", "void");
				return result;
			}
		}
		JsonObject result = result(start, point, MAX_TICKS, "flight_limit");
		result.addProperty("below", "unknown");
		return result;
	}

	private static JsonObject result(Vec3 start, Vec3 end, int ticks, String status) {
		JsonObject result = new JsonObject();
		result.addProperty("status", status);
		result.addProperty("distance", Math.round(start.distanceTo(end) * 10.0D) / 10.0D);
		result.addProperty("ticks", ticks);
		result.addProperty("uncertainty", "nominal; spread and entity hits unmodeled; observed terrain only");
		return result;
	}

	static boolean footing(Terrain terrain, Vec3 feet) {
		BlockPos support = BlockPos.containing(feet.add(0, -0.01D, 0));
		VoxelShape shape = terrain.shape(support);
		if (shape == null || shape.isEmpty()) return false;
		return shape.toAabbs().stream().anyMatch(box -> Math.abs(support.getY() + box.maxY - feet.y) < 0.02D
				&& feet.x >= support.getX() + box.minX && feet.x < support.getX() + box.maxX
				&& feet.z >= support.getZ() + box.minZ && feet.z < support.getZ() + box.maxZ);
	}

	static String headroom(Terrain terrain, Vec3 feet) {
		AABB body = new AABB(feet.x - 0.3D, feet.y + 0.01D, feet.z - 0.3D, feet.x + 0.3D, feet.y + 1.8D, feet.z + 0.3D);
		boolean unknown = false;
		for (BlockPos cell : BlockPos.betweenClosed(BlockPos.containing(body.minX, body.minY, body.minZ), BlockPos.containing(body.maxX, body.maxY, body.maxZ))) {
			VoxelShape shape = terrain.shape(cell);
			if (shape == null) { unknown = true; continue; }
			for (AABB box : shape.toAabbs()) if (body.intersects(box.move(cell))) return "blocked";
		}
		return unknown ? "unknown" : "clear";
	}

	/** Blocks the thrower falls from the arrival point to the first solid surface under it; NaN when none is known. */
	static double drop(Terrain terrain, Vec3 feet, int minY) {
		BlockPos cell = BlockPos.containing(feet);
		for (int y = cell.getY(); y >= minY; y--) {
			VoxelShape shape = terrain.shape(new BlockPos(cell.getX(), y, cell.getZ()));
			if (shape == null) return Double.NaN;
			if (shape.isEmpty()) continue;
			double top = y + shape.max(net.minecraft.core.Direction.Axis.Y);
			if (top <= feet.y + 1.0E-6D) return Math.max(0.0D, feet.y - top);
		}
		return Double.NaN;
	}

	static JsonObject point(Vec3 point) {
		JsonObject result = new JsonObject();
		result.addProperty("x", Math.round(point.x * 10.0D) / 10.0D);
		result.addProperty("y", Math.round(point.y * 10.0D) / 10.0D);
		result.addProperty("z", Math.round(point.z * 10.0D) / 10.0D);
		return result;
	}

	static String below(Terrain terrain, Vec3 feet, int minY) {
		BlockPos cell = BlockPos.containing(feet.add(0, -0.01D, 0));
		for (int y = cell.getY(); y >= minY; y--) {
			VoxelShape shape = terrain.shape(new BlockPos(cell.getX(), y, cell.getZ()));
			// Live End run d4i-end-a: a pearl struck an island's side face; the arrival column was unseen air down to the
			// void, reported "unknown", and the thrower fell out of the world.
			if (shape == null) return terrain.voidBelow(cell.getX(), y, cell.getZ()) ? "void" : "unknown";
			if (!shape.isEmpty()) return "solid";
		}
		return "void";
	}

	static JsonObject cell(BlockPos pos) {
		JsonObject result = new JsonObject();
		result.addProperty("x", pos.getX()); result.addProperty("y", pos.getY()); result.addProperty("z", pos.getZ());
		return result;
	}
}
