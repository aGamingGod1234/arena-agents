package dev.agaminggod.arenaagents.server.watch;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.agent.AgentId;
import dev.agaminggod.arenaagents.server.perception.CrystalCage;
import dev.agaminggod.arenaagents.server.perception.ObservationVisibility;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import dev.agaminggod.arenaagents.server.runtime.ServerActionExecutor;
import dev.agaminggod.arenaagents.server.runtime.ServerActionRequest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.Registries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.entity.boss.enderdragon.EndCrystal;
import net.minecraft.world.entity.boss.enderdragon.EnderDragon;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.chunk.PalettedContainer;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.levelgen.structure.BuiltinStructureSets;
import net.minecraft.world.level.levelgen.structure.BuiltinStructures;
import net.minecraft.world.level.levelgen.structure.Structure;
import net.minecraft.world.level.levelgen.structure.StructureStart;
import net.minecraft.world.level.levelgen.structure.placement.ConcentricRingsStructurePlacement;
import net.minecraft.world.level.levelgen.structure.placement.StructurePlacement;

/**
 * Progress truth for the time audit: every {@link #EVERY_TICKS} ticks per agent, one line in
 * {@code arena-watch/<agentId>-progress.jsonl} with the real nearest targets the run's stages need (iron ore, a lava pool
 * to cast a portal from, gravel, obsidian, a Nether portal, a fortress and its blaze spawners, the stronghold and its
 * portal room, End crystals and the dragon), whether a player standing there could perceive each one and whether it
 * reached the agent's observation, plus the running action and the action results since the last line.
 *
 * <p>Read-only and never sent anywhere but that file (see {@link Watcher}). Bounded: blocks are read from loaded chunk
 * sections whose palette can hold a target, within {@link #SCAN_RADIUS} horizontally and {@link #SCAN_HALF_HEIGHT}
 * vertically; structures come from structure starts already in loaded chunks (no chunk is generated or loaded) and,
 * for the stronghold, the precomputed ring positions; sight rays only for the few nearest exposed cells of each kind.
 */
final class ProgressWatch {
	static final int VERSION = 1;
	static final int EVERY_TICKS = 100;
	static final int SCAN_RADIUS = 32;
	static final int SCAN_HALF_HEIGHT = 24;
	/** Structure starts are re-read from loaded chunks every this many lines (30 s). */
	static final int STRUCTURE_EVERY_LINES = 6;
	static final int STRUCTURE_CHUNK_RADIUS = 12;
	/** Still sources a pool needs to count as a casting pool: one portal frame of obsidian at least. */
	static final int LAVA_POOL_MIN = 10;
	/** Vanilla: cave air below y-54 is lava (the aquifer lava level), so this is where the lava floors are. */
	static final int LAVA_FLOOR_Y = -54;
	static final int POOL_VISIT_CAP = 64;
	/** Exposed cells kept per kind (nearest first); sight rays only for the first {@link #SIGHT_CANDIDATES}. */
	static final int NEAR_CANDIDATES = 8;
	static final int SIGHT_CANDIDATES = 4;
	static final int DELIVERED_CAP = 512;
	/** A delivered row of the same kind this close to a target cell names it (veins report one cell of several). */
	static final double DELIVERED_MATCH = 3.0D;

	/** Block targets read from chunk sections; {@code json} is the key in the line. */
	enum Kind {
		IRON("iron"), LAVA("lava"), GRAVEL("gravel"), OBSIDIAN("obsidian"), NETHER_PORTAL("nether_portal"), SPAWNER("blaze_spawner"),
		PORTAL_FRAME("portal_room"), FORTRESS_BRICK("fortress");

		final String json;

		Kind(String json) {
			this.json = json;
		}
	}

	/** Which delivered (observation) row names which target, from its block id, structure label or entity type. */
	static String deliveredKind(String text) {
		if (text == null) return null;
		if (text.endsWith("iron_ore")) return "iron";
		return switch (text) {
			case "minecraft:lava" -> "lava";
			case "minecraft:gravel" -> "gravel";
			case "minecraft:obsidian" -> "obsidian";
			case "minecraft:nether_portal" -> "nether_portal";
			case "minecraft:spawner" -> "blaze_spawner";
			case "minecraft:end_portal_frame" -> "portal_room";
			case "minecraft:nether_bricks", "minecraft:nether_brick_fence", "fortress", "nether fortress", "minecraft:fortress" -> "fortress";
			case "stronghold", "minecraft:stronghold" -> "stronghold";
			default -> null;
		};
	}

	/** Per agent and dimension: target kind to delivered cells (packed) and when they were last delivered. */
	private static final Map<AgentId, Map<String, LinkedHashMap<Long, Long>>> DELIVERED = new ConcurrentHashMap<>();
	private static final Map<AgentId, String> DIMENSION = new ConcurrentHashMap<>();
	/** Terminal action results since the last line: actionType to "STATE" or "STATE:reasonCode" to count. */
	private static final Map<AgentId, Map<String, Map<String, Integer>>> RESULTS = new ConcurrentHashMap<>();

	/** Per dimension and kind: structure starts seen in loaded chunks, by start chunk. */
	private final Map<String, Map<String, Map<Long, BoundingBox>>> structures = new HashMap<>();
	private List<ChunkPos> strongholdRings;
	private boolean ringsTried;
	private final Map<AgentId, Integer> lines = new HashMap<>();
	long costNanos;
	long costMaxNanos;
	long costLines;

	// ---- Bridge thread: what the observation carried and what actions returned ----

	static void delivered(AgentId agentId, JsonObject delivery, long epochMs) {
		String dim = DIMENSION.get(agentId);
		if (dim == null) return;
		Map<String, LinkedHashMap<Long, Long>> byKind = DELIVERED.computeIfAbsent(agentId, ignored -> new ConcurrentHashMap<>());
		List<Object[]> rows = new ArrayList<>();
		rows(delivery, rows, 0);
		for (Object[] row : rows) {
			LinkedHashMap<Long, Long> cells = byKind.computeIfAbsent(dim + "|" + row[0], ignored -> new LinkedHashMap<>());
			synchronized (cells) {
				long key = (Long) row[1];
				cells.remove(key);
				cells.put(key, epochMs);
				while (cells.size() > DELIVERED_CAP) cells.remove(cells.keySet().iterator().next());
			}
		}
	}

	/** Rows naming a target with a position: {kind, packed cell}. Objects with x/y/z (or a position object) and an id. */
	static void rows(JsonElement element, List<Object[]> out, int depth) {
		if (element == null || depth > 12) return;
		if (element.isJsonArray()) {
			for (JsonElement item : element.getAsJsonArray()) {
				if (!item.isJsonObject() && !item.isJsonArray()) return;
				rows(item, out, depth + 1);
			}
			return;
		}
		if (!element.isJsonObject()) return;
		JsonObject object = element.getAsJsonObject();
		String kind = null;
		for (String key : List.of("blockId", "type", "structure", "id")) {
			JsonElement value = object.get(key);
			if (value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()) kind = deliveredKind(value.getAsString());
			if (kind != null) break;
		}
		if (kind != null) {
			JsonObject at = object.has("x") ? object : object.get("position") instanceof JsonObject position ? position : null;
			if (at != null && number(at, "x") && number(at, "y") && number(at, "z")) {
				out.add(new Object[] {kind, BlockPos.asLong((int) Math.floor(at.get("x").getAsDouble()), (int) Math.floor(at.get("y").getAsDouble()),
						(int) Math.floor(at.get("z").getAsDouble()))});
			}
		}
		for (Map.Entry<String, JsonElement> entry : object.entrySet()) {
			if (entry.getKey().equals("tags") || entry.getKey().equals("bounds")) continue;
			JsonElement value = entry.getValue();
			if (value.isJsonObject() || value.isJsonArray()) rows(value, out, depth + 1);
		}
	}

	private static boolean number(JsonObject object, String key) {
		JsonElement value = object.get(key);
		return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isNumber();
	}

	static void result(AgentId agentId, String actionType, String state, String reasonCode) {
		if (actionType == null || state == null) return;
		String outcome = reasonCode == null || reasonCode.isEmpty() || state.equals("SUCCEEDED") ? state : state + ":" + reasonCode;
		RESULTS.computeIfAbsent(agentId, ignored -> new ConcurrentHashMap<>()).computeIfAbsent(actionType, ignored -> new ConcurrentHashMap<>())
				.merge(outcome, 1, Integer::sum);
	}

	static JsonObject drainResults(AgentId agentId) {
		Map<String, Map<String, Integer>> taken = RESULTS.remove(agentId);
		JsonObject out = new JsonObject();
		if (taken == null) return out;
		for (Map.Entry<String, Map<String, Integer>> type : new TreeMap<>(taken).entrySet()) {
			JsonObject counts = new JsonObject();
			for (Map.Entry<String, Integer> entry : new TreeMap<>(type.getValue()).entrySet()) counts.addProperty(entry.getKey(), entry.getValue());
			out.add(type.getKey(), counts);
		}
		return out;
	}

	/** The nearest cell of a kind this agent's observations have carried in this dimension, or null. */
	static long[] nearestDelivered(AgentId agentId, String dim, String kind, BlockPos from, BlockPos match) {
		Map<String, LinkedHashMap<Long, Long>> byKind = DELIVERED.get(agentId);
		LinkedHashMap<Long, Long> cells = byKind == null ? null : byKind.get(dim + "|" + kind);
		if (cells == null) return null;
		long best = 0L;
		double bestDistance = Double.MAX_VALUE;
		boolean matched = false;
		synchronized (cells) {
			for (long key : cells.keySet()) {
				BlockPos cell = BlockPos.of(key);
				double distance = Math.sqrt(cell.distSqr(from));
				if (distance < bestDistance) {
					bestDistance = distance;
					best = key;
				}
				if (match != null && Math.sqrt(cell.distSqr(match)) <= DELIVERED_MATCH) matched = true;
			}
		}
		return bestDistance == Double.MAX_VALUE ? null : new long[] {best, matched ? 1L : 0L};
	}

	static void forget(AgentId agentId) {
		DELIVERED.remove(agentId);
		RESULTS.remove(agentId);
		DIMENSION.remove(agentId);
	}

	// ---- Server thread: one line ----

	/** Whether this agent writes a line on this tick (lines are staggered by the agent's phase). */
	static boolean due(long tick, int phase) {
		return (tick + phase * 23L) % EVERY_TICKS == 0;
	}

	void noteDimension(AgentId agentId, String dim) {
		DIMENSION.put(agentId, dim);
	}

	JsonObject line(AgentId agentId, ServerPlayer player, ServerActionExecutor executor, long epochMs) {
		long started = System.nanoTime();
		ServerLevel level = player.level();
		String dim = level.dimension().identifier().toString();
		BlockPos feet = player.blockPosition();
		JsonObject row = new JsonObject();
		row.addProperty("v", VERSION);
		row.addProperty("type", "progress");
		row.addProperty("agentId", agentId.toString());
		row.addProperty("atMs", epochMs);
		row.addProperty("gameTime", level.getGameTime());
		row.addProperty("dim", dim);
		JsonObject pos = new JsonObject();
		pos.addProperty("x", round(player.getX()));
		pos.addProperty("y", round(player.getY()));
		pos.addProperty("z", round(player.getZ()));
		row.add("pos", pos);
		row.addProperty("health", round(player.getHealth()));
		row.addProperty("food", player.getFoodData().getFoodLevel());
		ServerActionRequest active = executor == null ? null : executor.activeRequest(agentId);
		if (active == null) row.add("action", JsonNull.INSTANCE);
		else {
			JsonObject action = new JsonObject();
			action.addProperty("type", active.type().wireName());
			BlockPos target = executor.activeTarget(agentId);
			action.add("target", target == null ? JsonNull.INSTANCE : cell(target));
			row.add("action", action);
		}
		row.add("results", drainResults(agentId));

		boolean overworld = level.dimension() == Level.OVERWORLD;
		boolean nether = level.dimension() == Level.NETHER;
		boolean end = level.dimension() == Level.END;
		ObservationVisibility.Frame frame = ObservationVisibility.frame(level, player);
		JsonObject targets = new JsonObject();
		Scan scan = scan(level, feet, overworld, nether);
		if (overworld) {
			targets.add("iron", blockTarget(agentId, player, frame, dim, feet, scan.of(Kind.IRON), "iron"));
			targets.add("lava_pool", lavaPool(agentId, player, frame, dim, feet, scan.of(Kind.LAVA)));
			targets.add("lava_floor", lavaFloor(agentId, player, frame, dim, feet, scan.of(Kind.LAVA)));
			targets.add("gravel", blockTarget(agentId, player, frame, dim, feet, scan.of(Kind.GRAVEL), "gravel"));
			targets.add("obsidian", blockTarget(agentId, player, frame, dim, feet, scan.of(Kind.OBSIDIAN), "obsidian"));
			targets.add("nether_portal", blockTarget(agentId, player, frame, dim, feet, scan.of(Kind.NETHER_PORTAL), "nether_portal"));
			targets.add("portal_room", blockTarget(agentId, player, frame, dim, feet, scan.of(Kind.PORTAL_FRAME), "portal_room"));
		} else if (nether) {
			targets.add("nether_portal", blockTarget(agentId, player, frame, dim, feet, scan.of(Kind.NETHER_PORTAL), "nether_portal"));
			targets.add("gravel", blockTarget(agentId, player, frame, dim, feet, scan.of(Kind.GRAVEL), "gravel"));
			targets.add("blaze_spawner", blockTarget(agentId, player, frame, dim, feet, scan.of(Kind.SPAWNER), "blaze_spawner"));
		}
		int line = lines.merge(agentId, 1, Integer::sum);
		if ((overworld || nether) && (line % STRUCTURE_EVERY_LINES == 1 || !structures.containsKey(dim))) structureStarts(level, feet);
		if (nether) {
			JsonObject fortress = structureTarget(dim, "fortress", feet);
			JsonObject wall = blockTarget(agentId, player, frame, dim, feet, scan.of(Kind.FORTRESS_BRICK), "fortress");
			if (fortress == null && wall != null) fortress = new JsonObject();
			if (fortress != null) {
				fortress.add("walls", wall == null ? JsonNull.INSTANCE : wall);
				targets.add("fortress", fortress);
			} else targets.add("fortress", JsonNull.INSTANCE);
		}
		if (overworld) {
			JsonObject stronghold = structureTarget(dim, "stronghold", feet);
			if (stronghold == null) stronghold = ring(level, feet);
			targets.add("stronghold", stronghold == null ? JsonNull.INSTANCE : stronghold);
		}
		if (end) end(agentId, player, frame, targets);
		row.add("targets", targets);
		JsonObject bounds = new JsonObject();
		bounds.addProperty("radius", SCAN_RADIUS);
		bounds.addProperty("halfHeight", SCAN_HALF_HEIGHT);
		bounds.addProperty("sections", scan.sections);
		bounds.addProperty("sectionsRead", scan.sectionsRead);
		row.add("scan", bounds);
		long spent = System.nanoTime() - started;
		costNanos += spent;
		costMaxNanos = Math.max(costMaxNanos, spent);
		costLines++;
		row.addProperty("costUs", Math.round(spent / 1_000.0D));
		return row;
	}

	// ---- Blocks ----

	/** Nearest cells per kind: the nearest of any exposure, and the {@link #NEAR_CANDIDATES} nearest exposed ones. */
	static final class Nearest {
		int count;
		long any;
		int anyD2 = Integer.MAX_VALUE;
		final long[] near = new long[NEAR_CANDIDATES];
		final int[] nearD2 = new int[NEAR_CANDIDATES];
		int size;

		boolean wantsExposed(int d2) {
			return size < NEAR_CANDIDATES || d2 < nearD2[size - 1];
		}

		void exposed(long cell, int d2) {
			int at = size < NEAR_CANDIDATES ? size++ : NEAR_CANDIDATES - 1;
			while (at > 0 && nearD2[at - 1] > d2) {
				near[at] = near[at - 1];
				nearD2[at] = nearD2[at - 1];
				at--;
			}
			near[at] = cell;
			nearD2[at] = d2;
		}
	}

	static final class Scan {
		final Nearest[] kinds = new Nearest[Kind.values().length];
		int sections;
		int sectionsRead;

		Nearest of(Kind kind) {
			return kinds[kind.ordinal()];
		}
	}

	private static Kind classify(BlockState state, boolean overworld, boolean nether) {
		if (state.is(Blocks.IRON_ORE) || state.is(Blocks.DEEPSLATE_IRON_ORE)) return Kind.IRON;
		if (state.is(Blocks.LAVA)) return overworld && state.getFluidState().isSource() ? Kind.LAVA : null;
		if (state.is(Blocks.GRAVEL)) return Kind.GRAVEL;
		if (state.is(Blocks.OBSIDIAN)) return Kind.OBSIDIAN;
		if (state.is(Blocks.NETHER_PORTAL)) return Kind.NETHER_PORTAL;
		// Only fortresses hold spawners in the Nether, and theirs are blaze spawners.
		if (state.is(Blocks.SPAWNER)) return nether ? Kind.SPAWNER : null;
		if (state.is(Blocks.END_PORTAL_FRAME)) return overworld ? Kind.PORTAL_FRAME : null;
		if (state.is(Blocks.NETHER_BRICKS)) return nether ? Kind.FORTRESS_BRICK : null;
		return null;
	}

	private static Scan scan(ServerLevel level, BlockPos feet, boolean overworld, boolean nether) {
		Scan scan = new Scan();
		for (Kind kind : Kind.values()) scan.kinds[kind.ordinal()] = new Nearest();
		if (!overworld && !nether) return scan;
		int minSection = Math.max(level.getMinSectionY(), (feet.getY() - SCAN_HALF_HEIGHT) >> 4);
		int maxSection = Math.min(level.getMaxSectionY(), (feet.getY() + SCAN_HALF_HEIGHT) >> 4);
		BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
		for (int cx = (feet.getX() - SCAN_RADIUS) >> 4; cx <= (feet.getX() + SCAN_RADIUS) >> 4; cx++) {
			for (int cz = (feet.getZ() - SCAN_RADIUS) >> 4; cz <= (feet.getZ() + SCAN_RADIUS) >> 4; cz++) {
				LevelChunk chunk = level.getChunkSource().getChunkNow(cx, cz);
				if (chunk == null) continue;
				LevelChunkSection[] sections = chunk.getSections();
				for (int sy = minSection; sy <= maxSection; sy++) {
					int index = level.getSectionIndexFromSectionY(sy);
					if (index < 0 || index >= sections.length) continue;
					LevelChunkSection section = sections[index];
					scan.sections++;
					if (section == null || section.hasOnlyAir()) continue;
					PalettedContainer<BlockState> states = section.getStates();
					if (!states.maybeHas(state -> classify(state, overworld, nether) != null)) continue;
					scan.sectionsRead++;
					int baseX = cx << 4, baseY = sy << 4, baseZ = cz << 4;
					for (int ly = 0; ly < 16; ly++) {
						int dy = baseY + ly - feet.getY();
						if (dy < -SCAN_HALF_HEIGHT || dy > SCAN_HALF_HEIGHT) continue;
						for (int lz = 0; lz < 16; lz++) {
							int dz = baseZ + lz - feet.getZ();
							if (dz < -SCAN_RADIUS || dz > SCAN_RADIUS) continue;
							for (int lx = 0; lx < 16; lx++) {
								int dx = baseX + lx - feet.getX();
								if (dx < -SCAN_RADIUS || dx > SCAN_RADIUS) continue;
								Kind kind = classify(states.get(lx, ly, lz), overworld, nether);
								if (kind == null) continue;
								Nearest nearest = scan.kinds[kind.ordinal()];
								int d2 = dx * dx + dy * dy + dz * dz;
								long cell = BlockPos.asLong(baseX + lx, baseY + ly, baseZ + lz);
								nearest.count++;
								if (d2 < nearest.anyD2) {
									nearest.anyD2 = d2;
									nearest.any = cell;
								}
								if (nearest.wantsExposed(d2) && exposed(level, cursor, baseX + lx, baseY + ly, baseZ + lz)) nearest.exposed(cell, d2);
							}
						}
					}
				}
			}
		}
		return scan;
	}

	/** A face open to air, water or a see-through block, so a player could see the cell from somewhere. */
	private static boolean exposed(ServerLevel level, BlockPos.MutableBlockPos cursor, int x, int y, int z) {
		for (Direction direction : Direction.values()) {
			cursor.set(x + direction.getStepX(), y + direction.getStepY(), z + direction.getStepZ());
			BlockState side = level.getBlockState(cursor);
			if (side.getFluidState().is(FluidTags.LAVA)) continue;
			if (side.isAir() || side.getFluidState().is(FluidTags.WATER) || !side.canOcclude()) return true;
		}
		return false;
	}

	/** Could a player have perceived the cell: already in the body's seen terrain, or in line of sight from the eye. */
	private static boolean perceivable(ServerPlayer player, ObservationVisibility.Frame frame, BlockPos cell) {
		BlockState known = SeenTerrain.remembered(player, cell.getX(), cell.getY(), cell.getZ());
		if (known != null && !known.isAir()) return true;
		return frame.hasLineOfSight(cell);
	}

	private JsonObject blockTarget(AgentId agentId, ServerPlayer player, ObservationVisibility.Frame frame, String dim, BlockPos feet,
			Nearest nearest, String kind) {
		long[] known = nearestDelivered(agentId, dim, kind, feet, null);
		if (nearest.count == 0 && known == null) return null;
		JsonObject out = new JsonObject();
		out.addProperty("count", nearest.count);
		out.add("nearest", nearest.count == 0 ? JsonNull.INSTANCE : place(BlockPos.of(nearest.any), feet));
		out.add("exposed", nearest.size == 0 ? JsonNull.INSTANCE : place(BlockPos.of(nearest.near[0]), feet));
		JsonElement seen = JsonNull.INSTANCE;
		for (int i = 0; i < Math.min(nearest.size, SIGHT_CANDIDATES); i++) {
			BlockPos cell = BlockPos.of(nearest.near[i]);
			if (!perceivable(player, frame, cell)) continue;
			JsonObject place = place(cell, feet);
			long[] match = nearestDelivered(agentId, dim, kind, feet, cell);
			place.addProperty("inObservation", match != null && match[1] == 1L);
			seen = place;
			break;
		}
		out.add("perceivable", seen);
		out.add("known", known == null ? JsonNull.INSTANCE : place(BlockPos.of(known[0]), feet));
		return out;
	}

	/**
	 * A lava-floor depth step's own measure: blocks still to descend to {@link #LAVA_FLOOR_Y} (below it vanilla cave air is
	 * lava) and the nearest still source down there within the scan, so a stretch spent descending, or tunnelling at
	 * depth past hidden pools, has a true distance like any other target.
	 */
	private JsonObject lavaFloor(AgentId agentId, ServerPlayer player, ObservationVisibility.Frame frame, String dim, BlockPos feet, Nearest lava) {
		JsonObject out = new JsonObject();
		out.addProperty("depth", Math.max(0, feet.getY() - LAVA_FLOOR_Y));
		BlockPos best = null;
		if (lava.count > 0 && BlockPos.of(lava.any).getY() <= LAVA_FLOOR_Y) best = BlockPos.of(lava.any);
		for (int i = 0; i < lava.size; i++) {
			BlockPos cell = BlockPos.of(lava.near[i]);
			if (cell.getY() <= LAVA_FLOOR_Y && (best == null || cell.distSqr(feet) < best.distSqr(feet))) best = cell;
		}
		if (best == null) out.add("nearest", JsonNull.INSTANCE);
		else {
			JsonObject place = place(best, feet);
			place.addProperty("perceivable", perceivable(player, frame, best));
			long[] match = nearestDelivered(agentId, dim, "lava", feet, best);
			place.addProperty("inObservation", match != null && match[1] == 1L);
			out.add("nearest", place);
		}
		return out;
	}

	/** The nearest exposed still lava source whose connected pool holds {@link #LAVA_POOL_MIN} sources or more. */
	private JsonObject lavaPool(AgentId agentId, ServerPlayer player, ObservationVisibility.Frame frame, String dim, BlockPos feet, Nearest lava) {
		long[] known = nearestDelivered(agentId, dim, "lava", feet, null);
		JsonObject out = new JsonObject();
		out.addProperty("sources", lava.count);
		out.add("nearestSource", lava.count == 0 ? JsonNull.INSTANCE : place(BlockPos.of(lava.any), feet));
		Set<Long> pooled = new HashSet<>();
		JsonElement pool = JsonNull.INSTANCE;
		ServerLevel level = player.level();
		for (int i = 0; i < lava.size; i++) {
			if (pooled.contains(lava.near[i])) continue;
			int size = poolSize(level, BlockPos.of(lava.near[i]), pooled);
			if (size < LAVA_POOL_MIN) continue;
			BlockPos cell = BlockPos.of(lava.near[i]);
			JsonObject place = place(cell, feet);
			place.addProperty("sources", size);
			boolean seen = perceivable(player, frame, cell);
			place.addProperty("perceivable", seen);
			long[] match = nearestDelivered(agentId, dim, "lava", feet, cell);
			place.addProperty("inObservation", match != null && match[1] == 1L);
			pool = place;
			break;
		}
		out.add("pool", pool);
		out.add("known", known == null ? JsonNull.INSTANCE : place(BlockPos.of(known[0]), feet));
		return out;
	}

	private static int poolSize(ServerLevel level, BlockPos start, Set<Long> pooled) {
		java.util.ArrayDeque<BlockPos> queue = new java.util.ArrayDeque<>();
		queue.add(start);
		pooled.add(start.asLong());
		int sources = 0;
		while (!queue.isEmpty() && pooled.size() <= POOL_VISIT_CAP * 4) {
			BlockPos cell = queue.poll();
			sources++;
			if (sources >= POOL_VISIT_CAP) break;
			for (Direction direction : Direction.values()) {
				BlockPos next = cell.relative(direction);
				if (pooled.contains(next.asLong())) continue;
				BlockState state = level.getBlockState(next);
				if (!state.is(Blocks.LAVA) || !state.getFluidState().isSource()) continue;
				pooled.add(next.asLong());
				queue.add(next);
			}
		}
		return sources;
	}

	// ---- Structures ----

	/** Records fortress and stronghold starts present in loaded chunks around the agent (no chunk is loaded or generated). */
	private void structureStarts(ServerLevel level, BlockPos feet) {
		String dim = level.dimension().identifier().toString();
		var registry = level.registryAccess().lookupOrThrow(Registries.STRUCTURE);
		Structure fortress = registry.getValue(BuiltinStructures.FORTRESS);
		Structure stronghold = registry.getValue(BuiltinStructures.STRONGHOLD);
		Map<String, Map<Long, BoundingBox>> byKind = structures.computeIfAbsent(dim, ignored -> new HashMap<>());
		int centerX = feet.getX() >> 4, centerZ = feet.getZ() >> 4;
		for (int cx = centerX - STRUCTURE_CHUNK_RADIUS; cx <= centerX + STRUCTURE_CHUNK_RADIUS; cx++) {
			for (int cz = centerZ - STRUCTURE_CHUNK_RADIUS; cz <= centerZ + STRUCTURE_CHUNK_RADIUS; cz++) {
				LevelChunk chunk = level.getChunkSource().getChunkNow(cx, cz);
				if (chunk == null) continue;
				for (Map.Entry<Structure, StructureStart> entry : chunk.getAllStarts().entrySet()) {
					Structure structure = entry.getKey();
					if (structure != fortress && structure != stronghold || !entry.getValue().isValid()) continue;
					byKind.computeIfAbsent(structure == fortress ? "fortress" : "stronghold", ignored -> new HashMap<>())
							.putIfAbsent(((long) cx << 32) ^ (cz & 0xFFFFFFFFL), entry.getValue().getBoundingBox());
				}
			}
		}
	}

	private JsonObject structureTarget(String dim, String kind, BlockPos feet) {
		Map<Long, BoundingBox> found = structures.getOrDefault(dim, Map.of()).get(kind);
		if (found == null) return null;
		BoundingBox best = null;
		double bestDistance = Double.MAX_VALUE;
		for (BoundingBox box : found.values()) {
			double distance = boxDistance(box, feet);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = box;
			}
		}
		if (best == null) return null;
		JsonObject out = new JsonObject();
		out.addProperty("dist", round(bestDistance));
		out.add("pos", cell(best.getCenter()));
		out.addProperty("source", "loaded_start");
		return out;
	}

	static double boxDistance(BoundingBox box, BlockPos feet) {
		double dx = Math.max(0, Math.max(box.minX() - feet.getX(), feet.getX() - box.maxX()));
		double dy = Math.max(0, Math.max(box.minY() - feet.getY(), feet.getY() - box.maxY()));
		double dz = Math.max(0, Math.max(box.minZ() - feet.getZ(), feet.getZ() - box.maxZ()));
		return Math.sqrt(dx * dx + dy * dy + dz * dz);
	}

	/** The nearest stronghold ring position (where an eye of ender leads), horizontally; read once the rings exist. */
	private JsonObject ring(ServerLevel level, BlockPos feet) {
		if (!ringsTried) {
			// The rings are computed at world load; asking only after a minute of play never waits on them.
			if (level.getServer().getTickCount() < 1_200) return null;
			ringsTried = true;
			try {
				StructurePlacement placement = level.registryAccess().lookupOrThrow(Registries.STRUCTURE_SET).getValue(BuiltinStructureSets.STRONGHOLDS).placement();
				if (placement instanceof ConcentricRingsStructurePlacement rings) strongholdRings = level.getChunkSource().getGeneratorState().getRingPositionsFor(rings);
			} catch (RuntimeException unavailable) {
				strongholdRings = null;
			}
		}
		if (strongholdRings == null || strongholdRings.isEmpty()) return null;
		ChunkPos best = null;
		double bestDistance = Double.MAX_VALUE;
		for (ChunkPos chunk : strongholdRings) {
			double distance = Math.hypot(chunk.getMiddleBlockX() - feet.getX(), chunk.getMiddleBlockZ() - feet.getZ());
			if (distance < bestDistance) {
				bestDistance = distance;
				best = chunk;
			}
		}
		JsonObject out = new JsonObject();
		out.addProperty("dist", round(bestDistance));
		JsonArray at = new JsonArray();
		at.add(best.getMiddleBlockX());
		at.add(best.getMiddleBlockZ());
		out.add("pos", at);
		out.addProperty("source", "ring");
		return out;
	}

	// ---- The End ----

	private static void end(AgentId agentId, ServerPlayer player, ObservationVisibility.Frame frame, JsonObject targets) {
		ServerLevel level = player.level();
		Watcher.Delivered delivered = Watcher.deliveredTo(agentId);
		int left = 0, caged = 0;
		EndCrystal nearest = null;
		double nearestDistance = Double.MAX_VALUE;
		for (EndCrystal crystal : level.getEntitiesOfClass(EndCrystal.class, player.getBoundingBox().inflate(192.0D), EndCrystal::isAlive)) {
			left++;
			if (CrystalCage.of(level, crystal) != null) caged++;
			double distance = player.distanceTo(crystal);
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearest = crystal;
			}
		}
		JsonObject crystals = new JsonObject();
		crystals.addProperty("left", left);
		crystals.addProperty("caged", caged);
		if (nearest == null) crystals.add("nearest", JsonNull.INSTANCE);
		else {
			JsonObject near = new JsonObject();
			near.addProperty("dist", round(nearestDistance));
			near.add("pos", cell(nearest.blockPosition()));
			near.addProperty("perceivable", frame.hasLineOfSight(nearest));
			near.addProperty("inView", frame.canSeeEntity(nearest));
			near.addProperty("inObservation", delivered != null && delivered.uuids().contains(nearest.getUUID().toString()));
			crystals.add("nearest", near);
		}
		targets.add("crystals", crystals);
		EnderDragon dragon = level.getDragons().stream().filter(EnderDragon::isAlive).findFirst().orElse(null);
		if (dragon == null) targets.add("dragon", JsonNull.INSTANCE);
		else {
			JsonObject out = new JsonObject();
			out.addProperty("dist", round(player.distanceTo(dragon)));
			out.addProperty("health", round(dragon.getHealth()));
			// Like a crystal: a clear line to any part (a player could turn to it); inView adds the current view cone, so an
			// unseen sample tells facing or cover apart from a visible dragon the observation left out.
			out.addProperty("perceivable", frame.hasLineOfSight(dragon));
			out.addProperty("inView", frame.canSeeEntity(dragon));
			out.addProperty("inObservation", delivered != null && delivered.uuids().contains(dragon.getUUID().toString()));
			targets.add("dragon", out);
		}
	}

	// ---- JSON ----

	private static JsonObject place(BlockPos cell, BlockPos feet) {
		JsonObject out = new JsonObject();
		out.addProperty("dist", round(Math.sqrt(cell.distSqr(feet))));
		out.add("pos", cell(cell));
		return out;
	}

	private static JsonArray cell(BlockPos cell) {
		JsonArray out = new JsonArray();
		out.add(cell.getX());
		out.add(cell.getY());
		out.add(cell.getZ());
		return out;
	}

	private static double round(double value) {
		return Math.round(value * 10.0D) / 10.0D;
	}
}
