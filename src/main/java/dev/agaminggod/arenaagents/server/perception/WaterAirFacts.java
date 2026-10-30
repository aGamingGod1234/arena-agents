package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.server.runtime.controller.SwimPlanning;
import net.minecraft.core.BlockPos;
import net.minecraft.tags.FluidTags;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;

/** Breath and acquired swim geometry, with no movement or survival policy installed. */
public final class WaterAirFacts {
	private WaterAirFacts() { }

	private static final java.util.Map<ServerPlayer, SurfaceCache> SURFACES = new java.util.WeakHashMap<>();
	public record SurfaceLookup(SwimPlanning.Surface surface, boolean searching) { }

	/** One search per eye cell and air second; a pending slice survives one-cell drift to avoid starvation. */
	public static SurfaceLookup surface(ServerPlayer agent) {
		var eye = agent.getEyePosition();
		var origin = BlockPos.containing(eye);
		var cache = SURFACES.computeIfAbsent(agent, ignored -> new SurfaceCache());
		return cache.lookup(view(agent), origin, agent.getAirSupply(), agent.level().getGameTime(), agent.level());
	}

	static final class SurfaceCache {
		private BlockPos origin;
		private Object world;
		private int airSecond;
		private long worldSecond;
		private long lastTick = Long.MIN_VALUE;
		private SwimPlanning.SurfaceSearch search;
		SurfaceLookup lookup(SwimPlanning.ColumnView view, BlockPos cell, int air, long tick, Object level) {
			int second = Math.max(0, air) / SwimPlanning.AIR_TICKS_PER_SECOND;
			if (search == null || world != level || !cell.equals(origin) && (search.complete() || cell.distManhattan(origin) > 1)
					|| search.complete() && (second != airSecond || tick / 20 != worldSecond)) {
				origin = cell; world = level; airSecond = second; worldSecond = tick / 20;
				search = new SwimPlanning.SurfaceSearch(cell.getX(), cell.getY(), cell.getZ());
			}
			if (lastTick != tick) {
				boolean wasComplete = search.complete();
				search.advance(view, SwimPlanning.SURFACE_CELLS_PER_TICK);
				if (!wasComplete && search.complete()) { airSecond = second; worldSecond = tick / 20; }
				lastTick = tick;
			}
			var found = search.result();
			if (found != null && !cell.equals(origin)) {
				int onPath = found.path().indexOf(cell);
				var path = new java.util.ArrayList<BlockPos>();
				if (onPath >= 0) path.addAll(found.path().subList(onPath, found.path().size()));
				else { path.add(cell); path.addAll(found.path()); }
				found = new SwimPlanning.Surface(found.x(), found.openY(), found.z(), path.size() - 1,
						found.breathOnly(), java.util.List.copyOf(path));
			}
			return new SurfaceLookup(found, !search.complete());
		}
	}

	private static SwimPlanning.ColumnView view(ServerPlayer agent) {
		var seen = SeenTerrain.of(agent);
		return (x, y, z) -> {
			var state = seen.known(x, y, z);
			if (state == null) return SwimPlanning.Cell.UNKNOWN;
			return cell(state, !state.getCollisionShape(agent.level(), new BlockPos(x, y, z)).isEmpty());
		};
	}

	static void add(ServerPlayer agent, JsonObject player) {
		if (!agent.isUnderWater()) { SURFACES.remove(agent); return; }
		var eye = agent.getEyePosition();
		add(player, view(agent), Mth.floor(eye.x), Mth.floor(eye.y), Mth.floor(eye.z), agent.getAirSupply(),
				agent.getDeltaMovement().y, agent.isSwimming(), surface(agent).surface());
	}

	public static SwimPlanning.Cell cell(net.minecraft.world.level.block.state.BlockState state, boolean collision) {
		if (state == null) return SwimPlanning.Cell.UNKNOWN;
		if (collision) return SwimPlanning.Cell.SOLID;
		if (state.is(net.minecraft.world.level.block.Blocks.BUBBLE_COLUMN)) {
			return state.getValue(net.minecraft.world.level.block.BubbleColumnBlock.DRAG_DOWN)
					? SwimPlanning.Cell.SINKING_WATER : SwimPlanning.Cell.RISING_WATER;
		}
		if (state.getFluidState().is(FluidTags.WATER) || state.getFluidState().getType() == net.minecraft.world.level.material.Fluids.WATER
				|| state.getFluidState().getType() == net.minecraft.world.level.material.Fluids.FLOWING_WATER) return SwimPlanning.Cell.WATER;
		return state.isAir() ? SwimPlanning.Cell.OPEN : SwimPlanning.Cell.SOLID;
	}

	public static void add(JsonObject player, SwimPlanning.ColumnView view, int x, int eyeY, int z,
			int air, double velocityY, boolean swimming) {
		add(player, view, x, eyeY, z, air, velocityY, swimming, SwimPlanning.nearestSurface(view, x, eyeY, z));
	}

	private static void add(JsonObject player, SwimPlanning.ColumnView view, int x, int eyeY, int z,
			int air, double velocityY, boolean swimming, SwimPlanning.Surface surface) {
		player.addProperty("airSecondsLeft", round(SwimPlanning.airSecondsLeft(air)));
		var current = view.at(x, eyeY, z);
		player.addProperty("waterMotion", current == SwimPlanning.Cell.SINKING_WATER ? "sinking"
				: current == SwimPlanning.Cell.RISING_WATER ? "rising" : velocityY < -0.01 ? "sinking" : velocityY > 0.01 ? "rising" : swimming ? "swimming" : "level");
		String above = "unknown";
		for (int dy = 1; dy <= SwimPlanning.SURFACE_SEARCH_DEPTH; dy++) {
			var cell = view.at(x, eyeY + dy, z);
			if (cell == SwimPlanning.Cell.UNKNOWN) break;
			if (cell == SwimPlanning.Cell.SOLID || cell == SwimPlanning.Cell.SINKING_WATER) { above = "blocked"; break; }
			if (cell == SwimPlanning.Cell.OPEN) { above = "open_water"; break; }
		}
		player.addProperty("waterAbove", above);
		if (surface == null) { player.add("breathable", com.google.gson.JsonNull.INSTANCE); return; }
		JsonObject target = new JsonObject();
		target.addProperty("x", surface.x() + 0.5);
		// A sprint-swimming eye is only 0.4 blocks above the feet; aim high enough to breathe in either pose.
		target.addProperty("y", surface.openY() - 0.25);
		target.addProperty("z", surface.z() + 0.5);
		target.addProperty("distance", surface.distance());
		target.addProperty("kind", surface.breathOnly() ? "breath_only" : "surface");
		String direction = (surface.z() < z ? "north" : surface.z() > z ? "south" : "")
				+ (surface.x() < x ? "west" : surface.x() > x ? "east" : "");
		if (surface.openY() > eyeY) direction = direction.isEmpty() ? "up" : "up_" + direction;
		target.addProperty("direction", direction.isEmpty() ? "here" : direction);
		target.addProperty("seconds", round(surface.distance() / SwimPlanning.SURFACING_BLOCKS_PER_SECOND));
		player.add("breathable", target);
	}

	public static boolean urgent(JsonObject player) {
		if (player == null || !player.has("underWater") || !player.get("underWater").getAsBoolean()) return false;
		double seconds = player.has("air") ? SwimPlanning.airSecondsLeft(player.get("air").getAsInt())
				: player.has("airSecondsLeft") ? player.get("airSecondsLeft").getAsDouble() : 15;
		var value = player.get("breathable");
		var target = value != null && value.isJsonObject() ? value.getAsJsonObject() : null;
		return seconds < (target != null && target.has("seconds") ? target.get("seconds").getAsDouble() : 0) + 15;
	}

	private static double round(double value) { return Math.round(value * 10) / 10.0; }
}
