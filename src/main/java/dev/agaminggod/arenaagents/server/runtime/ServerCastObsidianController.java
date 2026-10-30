package dev.agaminggod.arenaagents.server.runtime;

import dev.agaminggod.arenaagents.agent.AgentDomainException;
import dev.agaminggod.arenaagents.server.perception.ThreatPerception;
import dev.agaminggod.arenaagents.server.runtime.controller.ServerController;
import dev.agaminggod.arenaagents.server.runtime.controller.ServerLookController;
import dev.agaminggod.arenaagents.server.runtime.controller.ServerNavigationController;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.BiPredicate;
import java.util.function.Function;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.material.Fluids;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * cast_obsidian: obsidian made in place with buckets, as a player does it. Count mode pours a water bucket at the edge of a
 * seen lava pool so the flow runs over the lava sources (vanilla turns a lava source with water above or beside it into
 * obsidian), waits for the flow, then scoops the water back. Frame mode builds a 4x5 Nether portal frame cell by cell:
 * water poured into a cell beside the frame cell, lava from the pool poured into the frame cell (cast at once by the water
 * beside it), the water scooped back. Every click is a vanilla item use along the body's eased look, within vanilla reach,
 * at a face the eye can see; every lava pour passes the same LAVA_POUR_AT_BODY check use_item applies. Every judgement of
 * the terrain (frame cells done, blocked or still to cast, water and mould cells, standing spots, the result text) reads
 * what the body has seen or remembers ({@link dev.agaminggod.arenaagents.server.perception.SeenTerrain}, plus the frame
 * cells it has seen during this call); a frame cell it has not seen is looked at first, walked to if still hidden, and
 * reported as unknown, never read from the live world.
 */
public final class ServerCastObsidianController implements ServerController {
	static final double HOSTILE_RANGE = 12.0D;
	static final float LOW_HEALTH = 8.0F;
	/** Flowing water crosses its 7 cells at 5 ticks a cell. */
	static final int WATER_FLOW_TICKS = 40;
	/** Ticks between two clicks: a hotbar swap and a click. */
	static final int ACT_PAUSE_TICKS = 2;
	static final int MAX_TURN_TICKS = 30;
	static final int MAX_WALKS = 12;
	static final int SEARCH = 6;
	static final int LAVA_SEARCH = 16;
	/** Ticks the body looks toward an unseen frame cell before walking to see it. */
	static final int LOOK_TICKS = 15;
	private static final Direction[] COOLING = { Direction.UP, Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST };

	enum Kind { FILL_LAVA, POUR_WATER, POUR_LAVA, SCOOP_WATER, PLACE_MOULD }

	/** One click: the item it needs, the aim, and the block/face (or fluid cell) its ray must meet. */
	record Step(Kind kind, Item item, BlockPos clicked, Direction face, BlockPos cell, Vec3 aim) { }

	private final BlockPos site;
	private final boolean frame;
	private final int count;
	private final long timeoutMs;
	private final BiPredicate<ServerPlayer, BlockPos> mayModify;
	private final ElapsedTimeAccumulator elapsed;
	private Direction.Axis axis;
	private ResourceKey<Level> dimension;
	/** Cells the body has known as not obsidian during this call: only these can count as obsidian it made. */
	private final Set<BlockPos> knownOpen = new HashSet<>();
	private final java.util.Map<BlockPos, Integer> refusals = new java.util.HashMap<>();
	private final Set<BlockPos> refused = new HashSet<>();
	private String lastRefusal;
	private float lastHealth = Float.NaN;
	private Step step;
	private int turnTicks, pause;
	private BlockPos placedWater;
	private int waterTicks;
	private ServerNavigationController walk;
	private int walks;
	private final Set<BlockPos> triedSpots = new HashSet<>();
	private String lastWalkFailure;
	private int waterPours, lavaPours, scoops, fills, moulds;
	/** Frame cells as last seen during this call (a player remembers the frame being cast). */
	private final java.util.Map<BlockPos, BlockState> frameRecall = new java.util.HashMap<>();
	/** New obsidian the body has seen (count mode), and the frame as last read, for progress and the result. */
	private final Set<BlockPos> madeSeen = new HashSet<>();
	private FrameRead lastRead;
	private BlockPos lookCell;
	private int lookTicks;

	public ServerCastObsidianController(BlockPos site, String axis, boolean frame, int count, long timeoutMs, long startedAt,
			BiPredicate<ServerPlayer, BlockPos> mayModify) {
		this.site = site.immutable();
		this.axis = axis == null ? null : axis.equals("z") ? Direction.Axis.Z : Direction.Axis.X;
		this.frame = frame;
		this.count = Math.max(1, count);
		this.timeoutMs = timeoutMs;
		this.mayModify = mayModify;
		this.elapsed = new ElapsedTimeAccumulator(startedAt);
	}

	@Override
	public TickResult tick(ServerPlayer player, long nowEpochMs) {
		ServerLevel level = (ServerLevel) player.level();
		if (dimension == null) start(player, level);
		if (!player.level().dimension().equals(dimension)) return stop(player, "ACTION_DIMENSION_CHANGED", "The body changed dimension");
		if (elapsed.advance(nowEpochMs) >= timeoutMs) {
			release(player);
			return TickResult.timedOut("CAST_TIMED_OUT", summary(player, "timeoutMs ran out"), progress(level));
		}
		TickResult danger = danger(player);
		if (danger != null) return danger;
		if (placedWater != null) waterTicks++;
		if (walk != null) {
			TickResult moved = walk.tick(player, nowEpochMs);
			if (moved.state() == State.RUNNING) return TickResult.running(progress(level));
			walk.cancel(player);
			walk = null;
			// A walk that could not arrive leaves that spot tried; the next plan picks another (walks are capped).
			if (moved.state() != State.SUCCEEDED) lastWalkFailure = moved.reasonCode() + " " + moved.message();
		}
		if (pause > 0) { pause--; return TickResult.running(progress(level)); }
		if (step == null) {
			TickResult planned = frame ? planFrame(player, level, nowEpochMs) : planCount(player, level, nowEpochMs);
			if (planned != null) return planned;
			if (step == null) return TickResult.running(progress(level));
		}
		return perform(player, level);
	}

	@Override
	public void cancel(ServerPlayer player) {
		release(player);
	}

	private void release(ServerPlayer player) {
		if (walk != null) walk.cancel(player);
		walk = null;
		step = null;
	}

	private void start(ServerPlayer player, ServerLevel level) {
		dimension = level.dimension();
		lastHealth = player.getHealth();
		if (frame && axis == null) axis = inferAxis(player, level);
		// The baseline is what the body knows at the start: a cell it has not seen stays unknown, not "not obsidian".
		trackObsidian(obsidianCells(), obsidianView(player, level), knownOpen, madeSeen);
	}

	/** The cell as the body knows it: seen or touched now, else remembered (frame cells: as seen during this call), else null. */
	private BlockState known(ServerPlayer player, BlockPos at) {
		BlockState seen = dev.agaminggod.arenaagents.server.perception.SeenTerrain.of(player).known(at.getX(), at.getY(), at.getZ());
		boolean frameCell = frame && axis != null && frameCells().contains(at);
		if (seen != null) { if (frameCell) frameRecall.put(at.immutable(), seen); return seen; }
		return frameCell ? frameRecall.get(at) : null;
	}

	private Function<BlockPos, BlockState> knownView(ServerPlayer player) {
		return at -> known(player, at);
	}

	/**
	 * What the body knows of the frame: the cells known cast, the cells known not cast, the cells it has not seen, and
	 * the next cell to work (bottom row first: an unseen cell, or one known not cast that was not given up).
	 */
	record FrameRead(BlockPos next, List<BlockPos> missing, List<BlockPos> unknown, int done) {
		boolean complete() { return missing.isEmpty() && unknown.isEmpty(); }
	}

	static FrameRead readFrame(List<BlockPos> cells, Set<BlockPos> refused, Function<BlockPos, BlockState> known) {
		BlockPos next = null;
		List<BlockPos> missing = new ArrayList<>(), unknown = new ArrayList<>();
		int done = 0;
		for (BlockPos c : cells) {
			BlockState state = known.apply(c);
			if (state == null) { unknown.add(c); if (next == null) next = c; }
			else if (state.is(Blocks.OBSIDIAN)) done++;
			else { missing.add(c); if (next == null && !refused.contains(c)) next = c; }
		}
		return new FrameRead(next, missing, unknown, done);
	}

	private boolean knownObsidian(ServerPlayer player, BlockPos at) {
		BlockState state = known(player, at);
		return state != null && state.is(Blocks.OBSIDIAN);
	}

	/** The frame's long side: along existing obsidian at the origin, else across the line from the body to the site. */
	private Direction.Axis inferAxis(ServerPlayer player, ServerLevel level) {
		for (int i = 1; i <= 3; i++) {
			if (knownObsidian(player, site.offset(i, 0, 0)) || knownObsidian(player, site.offset(i, 1, 0))) return Direction.Axis.X;
			if (knownObsidian(player, site.offset(0, 0, i)) || knownObsidian(player, site.offset(0, 1, i))) return Direction.Axis.Z;
		}
		Vec3 d = Vec3.atCenterOf(site).subtract(player.position());
		return Math.abs(d.x) > Math.abs(d.z) ? Direction.Axis.Z : Direction.Axis.X;
	}

	// ---- stops ----

	private TickResult danger(ServerPlayer player) {
		float health = player.getHealth();
		if (health < lastHealth - 0.01F) {
			String source = player.getLastDamageSource() == null ? "unknown" : player.getLastDamageSource().getMsgId();
			return stop(player, "DAMAGE_TAKEN", String.format(Locale.ROOT, "Took %.1f damage (%s); health %.1f", lastHealth - health, source, health));
		}
		lastHealth = health;
		if (player.isInLava()) return stop(player, "IN_LAVA", "The body is in lava");
		if (player.isOnFire()) return stop(player, "ON_FIRE", "The body is burning");
		// Its own poured water may wash over the eyes for a moment; a stop comes once the breath runs down.
		if (player.isUnderWater() && player.getAirSupply() < player.getMaxAirSupply() - 60)
			return stop(player, "WATER_AHEAD", "The body's eyes are under water (air " + player.getAirSupply() + "/" + player.getMaxAirSupply() + ")");
		if (health <= LOW_HEALTH) return stop(player, "LOW_HEALTH", String.format(Locale.ROOT, "Health %.1f is at or below %.0f", health, LOW_HEALTH));
		if (player.tickCount % 5 == 0) {
			List<Mob> threats = player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(HOSTILE_RANGE),
					mob -> player.distanceTo(mob) <= HOSTILE_RANGE && ThreatPerception.isSensedThreat(player, mob));
			if (!threats.isEmpty()) {
				Mob nearest = threats.stream().min(Comparator.comparingDouble(player::distanceTo)).orElseThrow();
				return stop(player, "HOSTILE_NEAR", String.format(Locale.ROOT, "%s %s %.1f blocks away",
						BuiltInRegistries.ENTITY_TYPE.getKey(nearest.getType()), nearest.getUUID(), player.distanceTo(nearest)));
			}
		}
		return null;
	}

	private TickResult stop(ServerPlayer player, String reason, String why) {
		release(player);
		return TickResult.failed(reason, summary(player, why), progress((ServerLevel) player.level()));
	}

	private TickResult done(ServerPlayer player, String reason, String why) {
		release(player);
		return TickResult.succeeded(reason, summary(player, why));
	}

	// ---- count mode: water over a seen pool ----

	private TickResult planCount(ServerPlayer player, ServerLevel level, long now) {
		int made = newObsidian(player, level);
		if (placedWater != null) {
			if (knownGone(player, placedWater)) { placedWater = null; return null; }
			if (made < count && waterTicks < WATER_FLOW_TICKS) return null;
			Step scoop = scoopStep(player, level, placedWater);
			if (scoop == null) return stop(player, "TARGET_OBSTRUCTED", "The water source at " + xyz(placedWater) + " is out of the bucket's reach or sight");
			step = scoop;
			return null;
		}
		if (made >= count) return done(player, "CAST_COUNT_REACHED", made + " new obsidian (asked " + count + ")");
		if (find(player, Items.WATER_BUCKET) < 0) return stop(player, "NO_WATER_BUCKET", "No water bucket carried");
		List<BlockPos> lava = seenLavaSources(player, level, LAVA_SEARCH);
		if (lava.isEmpty()) return stop(player, "NO_LAVA_IN_REACH", "No lava source seen within " + LAVA_SEARCH + " blocks; " + made + " new obsidian");
		Step best = null;
		int bestScore = 0;
		BlockPos feet = player.blockPosition();
		var terrain = dev.agaminggod.arenaagents.server.perception.SeenTerrain.of(player);
		for (BlockPos w : BlockPos.betweenClosed(feet.offset(-SEARCH, -3, -SEARCH), feet.offset(SEARCH, 2, SEARCH))) {
			// Skips only cells that cannot be known as air (neither remembered nor air now); the choice reads known().
			if (occupied(player, w) || terrain.recalled(w.getX(), w.getY(), w.getZ()) == null && !level.getBlockState(w).isAir()) continue;
			BlockState seen = known(player, w);
			if (seen == null || !seen.isAir()) continue;
			int score = 0;
			for (BlockPos l : lava) {
				int dx = Math.abs(l.getX() - w.getX()), dz = Math.abs(l.getZ() - w.getZ());
				if ((l.getY() == w.getY() - 1 || l.getY() == w.getY()) && dx + dz <= 4 && dx + dz >= 1) score++;
			}
			if (score <= bestScore) continue;
			Step pour = clickInto(player, level, w.immutable(), Kind.POUR_WATER, Items.WATER_BUCKET, null);
			if (pour != null) { best = pour; bestScore = score; }
		}
		if (best != null) { step = best; return null; }
		return walkNear(player, level, lava.get(0), now, "no cell in reach where poured water runs onto the lava");
	}

	// ---- frame mode: a 4x5 frame cast cell by cell ----

	/** The ten frame cells a portal needs (no corners), bottom row first. */
	List<BlockPos> frameCells() {
		List<BlockPos> cells = new ArrayList<>();
		cells.add(along(1, 0)); cells.add(along(2, 0));
		for (int y = 1; y <= 3; y++) { cells.add(along(0, y)); cells.add(along(3, y)); }
		cells.add(along(1, 4)); cells.add(along(2, 4));
		return cells;
	}

	private BlockPos along(int i, int y) {
		return axis == Direction.Axis.Z ? site.offset(0, y, i) : site.offset(i, y, 0);
	}

	private boolean interior(BlockPos at) {
		for (int i = 1; i <= 2; i++) for (int y = 1; y <= 3; y++) if (along(i, y).equals(at)) return true;
		return false;
	}

	private boolean corner(BlockPos at) {
		return at.equals(along(0, 0)) || at.equals(along(3, 0)) || at.equals(along(0, 4)) || at.equals(along(3, 4));
	}

	private TickResult planFrame(ServerPlayer player, ServerLevel level, long now) {
		FrameRead read = readFrame(frameCells(), refused, knownView(player));
		lastRead = read;
		// Every plan, as in count mode: a cell seen open now and cast later counts as obsidian the body made.
		newObsidian(player, level);
		BlockPos cell = read.next();
		if (placedWater != null && knownGone(player, placedWater)) placedWater = null;
		// The water's job ends when the cell it cooled is obsidian (or the frame is done): scoop it back first.
		if (placedWater != null && (cell == null || !touches(placedWater, cell))) {
			Step scoop = scoopStep(player, level, placedWater);
			if (scoop != null) { step = scoop; return null; }
			return walkNear(player, level, placedWater, now, "the water poured at " + xyz(placedWater) + " is out of the bucket's reach");
		}
		if (cell == null) {
			if (!read.missing().isEmpty())
				return stop(player, "LAVA_POUR_AT_BODY", "Frame cell " + xyz(read.missing().get(0)) + " was not poured: " + lastRefusal);
			return done(player, "FRAME_COMPLETE", "the 4x5 frame at " + xyz(site) + " (axis " + axisName() + ") is complete");
		}
		if (read.unknown().contains(cell)) return observe(player, level, cell, now);
		lookCell = null;
		lookTicks = 0;
		BlockState there = known(player, cell);
		if (!there.isAir() && there.getFluidState().isEmpty() && !there.canBeReplaced())
			return stop(player, "FRAME_CELL_BLOCKED", "Frame cell " + xyz(cell) + " holds " + BuiltInRegistries.BLOCK.getKey(there.getBlock()) + "; break it, then call again");
		if (there.getFluidState().isSource() && there.getFluidState().getType().isSame(Fluids.LAVA)) {
			// Lava already in the cell: water beside it casts it.
			return pourWaterFor(player, level, cell, now);
		}
		boolean cooled = cooledKnown(knownView(player), cell);
		boolean hasLava = find(player, Items.LAVA_BUCKET) >= 0;
		if (!hasLava) {
			if (find(player, Items.BUCKET) < 0) {
				if (placedWater != null) { Step scoop = scoopStep(player, level, placedWater); if (scoop != null) { step = scoop; return null; } }
				return stop(player, "NO_EMPTY_BUCKET", "No empty bucket to take lava with");
			}
			List<BlockPos> lava = seenLavaSources(player, level, LAVA_SEARCH);
			lava.removeIf(l -> frameCells().contains(l) || interior(l));
			for (BlockPos l : lava) {
				Step fill = scoopLike(player, level, l, Kind.FILL_LAVA);
				if (fill != null) { step = fill; return null; }
			}
			if (lava.isEmpty()) return stop(player, "NO_LAVA_IN_REACH", "No lava source seen within " + LAVA_SEARCH + " blocks to fill the bucket");
			// The nearest seen source may have no spot to stand within reach (cast over, walled off): try the next ones.
			for (int i = 0; i < Math.min(lava.size(), 8); i++) {
				BlockPos spot = standSpot(player, level, lava.get(i));
				if (spot != null) return walkTo(player, level, spot, now);
			}
			return walkNear(player, level, lava.get(0), now, "no seen lava source within " + LAVA_SEARCH + " blocks has a standing spot in reach");
		}
		// The lava's face comes first: water poured before it would flow with nowhere to cast.
		Step pour = clickInto(player, level, cell, Kind.POUR_LAVA, Items.LAVA_BUCKET, null);
		if (pour == null) {
			if (placedWater != null) { Step scoop = scoopStep(player, level, placedWater); if (scoop != null) { step = scoop; return null; } }
			Step mould = mouldChain(player, level, cell, Set.of(cell));
			if (mould != null) { step = mould; return null; }
			return walkNear(player, level, cell, now, "no face beside frame cell " + xyz(cell) + " is in reach for the lava");
		}
		if (!cooled) return pourWaterFor(player, level, cell, now);
		step = pour;
		return null;
	}

	/**
	 * A frame cell the body has not seen: it turns to look at it first; still hidden (behind a wall, or out of view from
	 * here), it walks to a spot in reach of it; with no spot left it hands back naming the cell as unknown.
	 */
	private TickResult observe(ServerPlayer player, ServerLevel level, BlockPos cell, long now) {
		if (!cell.equals(lookCell)) { lookCell = cell.immutable(); lookTicks = 0; }
		if (lookTicks++ < LOOK_TICKS) {
			ServerLookController.turnToward(player, Vec3.atCenterOf(cell));
			return TickResult.running(progress(level));
		}
		lookTicks = 0;
		BlockPos spot = walks < MAX_WALKS ? standSpot(player, level, cell) : null;
		if (spot != null) return walkTo(player, level, spot, now);
		return stop(player, "FRAME_CELL_UNSEEN", "Frame cell " + xyz(cell) + " is not in view (unknown: looked at it and found no seen spot to see it from); move where you can see it, then call again");
	}

	/** Whether a cell beside {@code cell} is known to hold water (vanilla casts lava that touches water). */
	static boolean cooledKnown(Function<BlockPos, BlockState> known, BlockPos cell) {
		for (Direction side : COOLING) {
			BlockState state = known.apply(cell.relative(side));
			if (state != null && state.getFluidState().getType().isSame(Fluids.WATER)) return true;
		}
		return false;
	}

	/** The body's poured water is known gone (it remembers pouring it until it sees otherwise). */
	private boolean knownGone(ServerPlayer player, BlockPos water) {
		BlockState state = known(player, water);
		return state != null && !(state.getFluidState().isSource() && state.getFluidState().getType().isSame(Fluids.WATER));
	}

	private TickResult pourWaterFor(ServerPlayer player, ServerLevel level, BlockPos cell, long now) {
		if (find(player, Items.WATER_BUCKET) < 0) {
			if (placedWater != null) { Step scoop = scoopStep(player, level, placedWater); if (scoop != null) { step = scoop; return null; } }
			return stop(player, "NO_WATER_BUCKET", "No water bucket carried");
		}
		List<BlockPos> options = new ArrayList<>();
		Direction normal = axis == Direction.Axis.Z ? Direction.EAST : Direction.SOUTH;
		// Above first (water there falls onto the cell), then out of the frame's plane, then along it.
		options.add(cell.above());
		options.add(cell.relative(normal)); options.add(cell.relative(normal.getOpposite()));
		for (Direction d : COOLING) if (!options.contains(cell.relative(d))) options.add(cell.relative(d));
		for (BlockPos w : options) {
			BlockState state = known(player, w);
			if (state == null || frameCells().contains(w) && state.is(Blocks.OBSIDIAN)) continue;
			if (!(state.isAir() || (!state.getFluidState().isEmpty() && !state.getFluidState().isSource())) || occupied(player, w) || fallsOnBody(player, w)) continue;
			Step pour = clickInto(player, level, w, Kind.POUR_WATER, Items.WATER_BUCKET, null);
			if (pour != null) { step = pour; return null; }
		}
		for (BlockPos w : options) {
			BlockState state = known(player, w);
			if (state == null || !state.isAir() || occupied(player, w) || fallsOnBody(player, w)) continue;
			Step mould = mouldChain(player, level, w, Set.of(cell, w));
			if (mould != null) { step = mould; return null; }
		}
		return walkNear(player, level, cell, now, "no cell beside frame cell " + xyz(cell) + " takes water from here");
	}

	/**
	 * The next carried block to place so {@code target} gets a face the eye can click: a chain of at most 3 blocks, each
	 * clicked onto a face the eye sees from where it stands. Never in the frame's interior or its plane (corners
	 * excepted), never in {@code keepOpen}.
	 */
	private Step mouldChain(ServerPlayer player, ServerLevel level, BlockPos target, Set<BlockPos> keepOpen) {
		Item block = mouldItem(player);
		if (block == null) return null;
		List<BlockPos> frontier = List.of(target);
		Set<BlockPos> visited = new HashSet<>(keepOpen);
		visited.add(target);
		for (int depth = 1; depth <= 3; depth++) {
			List<BlockPos> next = new ArrayList<>();
			for (BlockPos needs : frontier) for (Direction d : Direction.values()) {
				BlockPos m = needs.relative(d);
				if (!visited.add(m) || !mouldAllowed(player, level, m)) continue;
				// m, once placed, offers its face toward the cell that needs it: the eye must see that face.
				if (!faceSeen(player, level, m, d.getOpposite())) continue;
				Step place = clickInto(player, level, m, Kind.PLACE_MOULD, block, null);
				if (place != null) return place;
				next.add(m);
			}
			frontier = next;
		}
		return null;
	}

	private boolean mouldAllowed(ServerPlayer player, ServerLevel level, BlockPos m) {
		BlockState state = known(player, m);
		if (state == null || !state.isAir() || occupied(player, m) || !mayModify.test(player, m)) return false;
		if (!frame) return true;
		if (interior(m) || frameCells().contains(m)) return false;
		boolean inPlane = axis == Direction.Axis.Z ? m.getX() == site.getX() : m.getZ() == site.getZ();
		return !inPlane || corner(m);
	}

	/** Whether the eye, within reach and with nothing in between, sees {@code face} of the cell at {@code at} once it is solid. */
	private static boolean faceSeen(ServerPlayer player, ServerLevel level, BlockPos at, Direction face) {
		Vec3 eye = player.getEyePosition();
		Vec3 center = Vec3.atCenterOf(at).add(face.getStepX() * 0.5D, face.getStepY() * 0.5D, face.getStepZ() * 0.5D);
		for (Vec3 point : facePoints(center, face)) {
			Vec3 toEye = eye.subtract(point);
			if (toEye.x * face.getStepX() + toEye.y * face.getStepY() + toEye.z * face.getStepZ() < 0.05D) continue;
			if (eye.distanceTo(point) > player.blockInteractionRange() - 0.05D) continue;
			BlockHitResult hit = level.clip(new ClipContext(eye, point, ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
			if (hit.getType() == HitResult.Type.MISS || hit.getLocation().distanceTo(eye) >= eye.distanceTo(point) - 0.02D) return true;
		}
		return false;
	}

	private static Item mouldItem(ServerPlayer player) {
		for (Item item : new Item[] { Items.COBBLESTONE, Items.COBBLED_DEEPSLATE, Items.NETHERRACK, Items.STONE, Items.DIRT, Items.BLACKSTONE, Items.ANDESITE, Items.DIORITE, Items.GRANITE, Items.TUFF })
			if (find(player, item) >= 0) return item;
		return null;
	}

	// ---- clicks ----

	/** A click that puts something into {@code cell}: a visible, reachable solid face whose outward side is the cell. */
	private Step clickInto(ServerPlayer player, ServerLevel level, BlockPos cell, Kind kind, Item item, BlockPos avoid) {
		if (!mayModify.test(player, cell)) return null;
		Vec3 eye = player.getEyePosition();
		double reach = player.blockInteractionRange();
		List<Direction> sides = new ArrayList<>(List.of(Direction.values()));
		sides.sort(Comparator.comparingDouble(d -> Vec3.atCenterOf(cell.relative(d)).distanceToSqr(eye)));
		for (Direction toward : sides) {
			BlockPos support = cell.relative(toward);
			if (support.equals(avoid)) continue;
			BlockState state = known(player, support);
			Direction face = toward.getOpposite();
			if (state == null || state.isAir() || !state.getFluidState().isEmpty() && state.getCollisionShape(level, support).isEmpty()) continue;
			if (!state.isFaceSturdy(level, support, face)) continue;
			Vec3 center = Vec3.atCenterOf(support).add(face.getStepX() * 0.5D, face.getStepY() * 0.5D, face.getStepZ() * 0.5D);
			for (Vec3 aim : facePoints(center, face)) {
				if (eye.distanceTo(aim) > reach - 0.05D) continue;
				BlockHitResult hit = VanillaItemRay.atAim(player, aim, ClipContext.Fluid.NONE);
				if (hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(support) && hit.getDirection() == face)
					return new Step(kind, item, support, face, cell, aim);
			}
		}
		return null;
	}

	private static List<Vec3> facePoints(Vec3 center, Direction face) {
		List<Vec3> points = new ArrayList<>();
		points.add(center);
		double[] offsets = { -0.3D, 0.3D };
		for (double a : offsets) for (double b : offsets) {
			Vec3 p = switch (face.getAxis()) {
				case X -> center.add(0, a, b);
				case Y -> center.add(a, 0, b);
				case Z -> center.add(a, b, 0);
			};
			points.add(p);
		}
		return points;
	}

	private Step scoopStep(ServerPlayer player, ServerLevel level, BlockPos water) {
		if (find(player, Items.BUCKET) < 0) return null;
		return scoopLike(player, level, water, Kind.SCOOP_WATER);
	}

	/** An empty bucket aimed at a seen fluid source: the bucket's own ray (sources only) must meet it first. */
	private Step scoopLike(ServerPlayer player, ServerLevel level, BlockPos source, Kind kind) {
		if (Vec3.atCenterOf(source).distanceTo(player.getEyePosition()) > player.blockInteractionRange() + 0.9D) return null;
		try {
			Vec3 aim = BucketUse.aim(player, Items.BUCKET, Vec3.atCenterOf(source));
			BlockHitResult hit = VanillaItemRay.atAim(player, aim, ClipContext.Fluid.SOURCE_ONLY);
			if (hit.getType() != HitResult.Type.BLOCK || !hit.getBlockPos().equals(source)) return null;
			return new Step(kind, Items.BUCKET, source, hit.getDirection(), source, aim);
		} catch (AgentDomainException unreachable) {
			return null;
		}
	}

	private TickResult perform(ServerPlayer player, ServerLevel level) {
		int slot = find(player, step.item());
		if (slot < 0) { step = null; return TickResult.running(progress(level)); }
		if (player.getInventory().getSelectedSlot() != slot) {
			if (slot >= 9) {
				int hotbar = player.getInventory().getSelectedSlot();
				var swap = AdvancedInteractionService.swapIntoHotbar(player, slot, hotbar);
				if (swap != null) return stop(player, swap.reasonCode(), swap.message());
			} else {
				player.getInventory().setSelectedSlot(slot);
			}
			pause = 1;
			return TickResult.running(progress(level));
		}
		if (!ServerLookController.turnToward(player, step.aim())) {
			if (++turnTicks > MAX_TURN_TICKS) { step = null; turnTicks = 0; }
			return TickResult.running(progress(level));
		}
		turnTicks = 0;
		Step now = step;
		step = null;
		pause = ACT_PAUSE_TICKS;
		ItemStack held = player.getMainHandItem();
		boolean empty = held.is(Items.BUCKET);
		BlockHitResult hit = VanillaItemRay.hit(player, empty ? ClipContext.Fluid.SOURCE_ONLY : ClipContext.Fluid.NONE);
		boolean meets = hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(now.clicked())
				&& (empty || hit.getDirection() == now.face());
		if (!meets) return TickResult.running(progress(level));
		if (now.kind() == Kind.POUR_LAVA) {
			String guard = BucketUse.lavaPourAtBody(player, held);
			if (guard != null) {
				// A pour the guard refuses is never made; three refusals of one cell give it up.
				if (refusals.merge(now.cell(), 1, Integer::sum) >= 3) refused.add(now.cell());
				lastRefusal = guard;
				return TickResult.running(progress(level));
			}
		}
		InteractionResult result = InteractionResult.PASS;
		if (!empty && held.getItem() instanceof BlockItem) {
			result = player.gameMode.useItemOn(player, level, held, InteractionHand.MAIN_HAND, hit);
		} else {
			result = player.gameMode.useItemOn(player, level, held, InteractionHand.MAIN_HAND, hit);
			if (!result.consumesAction() && !(result instanceof InteractionResult.Fail)) result = player.gameMode.useItem(player, level, held, InteractionHand.MAIN_HAND);
		}
		if (!result.consumesAction()) return TickResult.running(progress(level));
		ArmSwing.use(player, InteractionHand.MAIN_HAND);
		// A click landed: spots tried for an earlier cell may serve the next one.
		triedSpots.clear();
		walks = 0;
		switch (now.kind()) {
			case POUR_WATER -> { waterPours++; placedWater = now.cell(); waterTicks = 0; }
			case SCOOP_WATER -> { scoops++; if (now.cell().equals(placedWater)) placedWater = null; }
			case POUR_LAVA -> lavaPours++;
			case FILL_LAVA -> fills++;
			case PLACE_MOULD -> moulds++;
		}
		return TickResult.running(progress(level));
	}

	// ---- walking to a spot in reach ----

	private TickResult walkNear(ServerPlayer player, ServerLevel level, BlockPos target, long now, String why) {
		if (walks >= MAX_WALKS) return stop(player, "NO_STAND_SPOT", why + "; " + MAX_WALKS + " walks did not bring it into reach");
		BlockPos best = standSpot(player, level, target);
		if (best == null) return stop(player, "NO_STAND_SPOT", why + "; no standing spot within reach of " + xyz(target)
				+ (lastWalkFailure == null ? "" : "; last walk: " + lastWalkFailure));
		return walkTo(player, level, best, now);
	}

	private TickResult walkTo(ServerPlayer player, ServerLevel level, BlockPos best, long now) {
		walks++;
		triedSpots.add(best);
		walk = new ServerNavigationController(new Vec3(best.getX() + 0.5D, best.getY(), best.getZ() + 0.5D), 0.4D, false, now, 20_000L);
		return TickResult.running(progress(level));
	}

	/** A standing spot not yet tried from which the eye reaches {@code target}, nearest the body (a step out of a frame's plane preferred). */
	private BlockPos standSpot(ServerPlayer player, ServerLevel level, BlockPos target) {
		BlockPos feet = player.blockPosition();
		triedSpots.add(feet.immutable());
		BlockPos best = null;
		double bestCost = Double.MAX_VALUE;
		for (BlockPos at : BlockPos.betweenClosed(target.offset(-4, -4, -4), target.offset(4, 3, 4))) {
			if (triedSpots.contains(at)) continue;
			if (!standable(knownView(player), level, at) || (frame && (frameCells().contains(at) || interior(at) || interior(at.above())))) continue;
			Vec3 eye = new Vec3(at.getX() + 0.5D, at.getY() + player.getEyeHeight(), at.getZ() + 0.5D);
			double reach = eye.distanceTo(Vec3.atCenterOf(target));
			if (reach > player.blockInteractionRange() - 0.6D) continue;
			double cost = Vec3.atCenterOf(at).distanceTo(player.position());
			if (frame) {
				// Facing the frame from a step or two out of its plane sees the faces a cast needs.
				int off = Math.abs(axis == Direction.Axis.Z ? at.getX() - site.getX() : at.getZ() - site.getZ());
				if (off == 0) cost += 6.0D; else if (off == 1) cost += 1.5D;
			}
			if (cost < bestCost) { bestCost = cost; best = at.immutable(); }
		}
		return best;
	}

	/**
	 * A spot the body knows it can stand in: seen sturdy ground under it, seen open cells for the body, no seen lava
	 * beside it. A cell it has not seen is not a standing spot. {@code shapes} only gives a known state its shape.
	 */
	static boolean standable(Function<BlockPos, BlockState> known, net.minecraft.world.level.BlockGetter shapes, BlockPos at) {
		BlockState below = known.apply(at.below());
		if (below == null || !below.isFaceSturdy(shapes, at.below(), Direction.UP) || !below.getFluidState().isEmpty()) return false;
		for (BlockPos body : new BlockPos[] { at, at.above() }) {
			BlockState s = known.apply(body);
			if (s == null || !s.getCollisionShape(shapes, body).isEmpty() || !s.getFluidState().isEmpty()) return false;
		}
		for (Direction d : Direction.Plane.HORIZONTAL) {
			BlockState side = known.apply(at.relative(d));
			if (side != null && side.getFluidState().getType().isSame(Fluids.LAVA)) return false;
		}
		return true;
	}

	// ---- reading the world ----

	/**
	 * Lava sources the body knows of (seen now, else remembered) within {@code radius}, nearest first. The cell's known
	 * state must be a lava source: remembered water or flowing lava is not one, whatever the cell holds now.
	 */
	private List<BlockPos> seenLavaSources(ServerPlayer player, ServerLevel level, int radius) {
		var seen = dev.agaminggod.arenaagents.server.perception.SeenTerrain.of(player);
		BlockPos feet = player.blockPosition();
		List<BlockPos> out = knownLavaSources(BlockPos.betweenClosed(feet.offset(-radius, -6, -radius), feet.offset(radius, 4, radius)),
				lavaView(at -> seen.recalled(at.getX(), at.getY(), at.getZ()), level::getBlockState, at -> seen.known(at.getX(), at.getY(), at.getZ())));
		knownOpen.addAll(out);
		Vec3 eye = player.getEyePosition();
		out.sort(Comparator.comparingDouble(at -> Vec3.atCenterOf(at).distanceToSqr(eye)));
		return out;
	}

	static boolean knownLavaSource(BlockState known) {
		return known != null && known.getFluidState().isSource() && known.getFluidState().getType().isSame(Fluids.LAVA);
	}

	/**
	 * {@code known} for the cells that could be known as a lava source (remembered as one, or one now), null for the
	 * rest. The live state only decides which cells skip the sight ray; the answer is always the known state.
	 */
	static Function<BlockPos, BlockState> lavaView(Function<BlockPos, BlockState> recalled, Function<BlockPos, BlockState> live,
			Function<BlockPos, BlockState> known) {
		return at -> knownLavaSource(recalled.apply(at)) || knownLavaSource(live.apply(at)) ? known.apply(at) : null;
	}

	/** The cells whose known state is a lava source; an unknown cell (null) is not one. */
	static List<BlockPos> knownLavaSources(Iterable<BlockPos> cells, Function<BlockPos, BlockState> known) {
		List<BlockPos> out = new ArrayList<>();
		for (BlockPos at : cells) if (knownLavaSource(known.apply(at))) out.add(at.immutable());
		return out;
	}

	private Iterable<BlockPos> obsidianCells() {
		return BlockPos.betweenClosed(site.offset(-8, -4, -8), site.offset(8, 6, 8));
	}

	/** {@link #known}, skipping the sight ray for cells that are neither remembered nor obsidian or fluid now. */
	private Function<BlockPos, BlockState> obsidianView(ServerPlayer player, ServerLevel level) {
		var seen = dev.agaminggod.arenaagents.server.perception.SeenTerrain.of(player);
		return at -> {
			if (seen.recalled(at.getX(), at.getY(), at.getZ()) == null) {
				BlockState live = level.getBlockState(at);
				if (!live.is(Blocks.OBSIDIAN) && live.getFluidState().isEmpty()) return null;
			}
			return known(player, at);
		};
	}

	/**
	 * Folds what the body knows of {@code cells} into {@code knownOpen} (known not obsidian) and {@code made} (known
	 * obsidian after being known not obsidian in this call). An unknown cell changes neither: obsidian the body never
	 * saw as anything else is not counted as made, and a made cell stays counted until it is seen otherwise.
	 */
	static void trackObsidian(Iterable<BlockPos> cells, Function<BlockPos, BlockState> known, Set<BlockPos> knownOpen, Set<BlockPos> made) {
		for (BlockPos at : cells) {
			BlockState state = known.apply(at);
			if (state == null) continue;
			if (state.is(Blocks.OBSIDIAN)) {
				if (knownOpen.contains(at)) made.add(at.immutable());
			} else {
				BlockPos cell = at.immutable();
				knownOpen.add(cell);
				made.remove(cell);
			}
		}
	}

	/** New obsidian the body has seen made (known obsidian now, known as something else earlier in this call). */
	private int newObsidian(ServerPlayer player, ServerLevel level) {
		trackObsidian(obsidianCells(), obsidianView(player, level), knownOpen, madeSeen);
		return madeSeen.size();
	}

	private static boolean touches(BlockPos water, BlockPos cell) {
		for (Direction d : COOLING) if (cell.relative(d).equals(water)) return true;
		return false;
	}

	/** Whether water poured at {@code at} would fall in the column over the body (or beside its head). */
	private static boolean fallsOnBody(ServerPlayer player, BlockPos at) {
		AABB body = player.getBoundingBox().inflate(0.4D, 0.0D, 0.4D);
		return at.getY() >= Math.floor(body.minY) && body.intersects(new AABB(at.getX(), body.minY, at.getZ(), at.getX() + 1, at.getY() + 1, at.getZ() + 1));
	}

	private static boolean occupied(ServerPlayer player, BlockPos at) {
		AABB body = player.getBoundingBox().inflate(0.05D);
		return body.intersects(new AABB(at));
	}

	static int find(ServerPlayer player, Item item) {
		int selected = player.getInventory().getSelectedSlot();
		if (player.getInventory().getItem(selected).is(item)) return selected;
		for (int slot = 0; slot < 36; slot++) if (player.getInventory().getItem(slot).is(item)) return slot;
		return -1;
	}

	private double progress(ServerLevel level) {
		if (frame && axis != null) return Math.min(0.99D, (lastRead == null ? 0 : lastRead.done()) / 10.0D);
		return Math.min(0.99D, madeSeen.size() / (double) count);
	}

	private String axisName() {
		return axis == Direction.Axis.Z ? "z" : "x";
	}

	private String summary(ServerPlayer player, String why) {
		ServerLevel level = (ServerLevel) player.level();
		StringBuilder text = new StringBuilder(why);
		text.append(". New obsidian seen: ").append(newObsidian(player, level));
		if (frame && axis != null) {
			FrameRead read = readFrame(frameCells(), Set.of(), knownView(player));
			text.append("; frame at ").append(xyz(site)).append(" axis ").append(axisName()).append(": ")
					.append(read.done()).append("/10 cells seen cast");
			if (!read.missing().isEmpty()) text.append(" (missing ").append(String.join(" ", read.missing().stream().map(ServerCastObsidianController::xyz).toList())).append(')');
			if (!read.unknown().isEmpty()) text.append(" (unknown, not seen: ").append(String.join(" ", read.unknown().stream().map(ServerCastObsidianController::xyz).toList())).append(')');
		}
		text.append(String.format(Locale.ROOT, "; clicks: water poured %d, lava poured %d, water scooped %d, lava taken %d, blocks placed %d",
				waterPours, lavaPours, scoops, fills, moulds));
		if (placedWater != null && !knownGone(player, placedWater)) text.append("; water source left at ").append(xyz(placedWater));
		if (lastRefusal != null) text.append("; a lava pour was refused (LAVA_POUR_AT_BODY): ").append(lastRefusal);
		text.append(String.format(Locale.ROOT, "; lava sources seen within %d: %d; carried water_bucket %d, lava_bucket %d, bucket %d",
				LAVA_SEARCH, seenLavaSources(player, level, LAVA_SEARCH).size(), carried(player, Items.WATER_BUCKET), carried(player, Items.LAVA_BUCKET), carried(player, Items.BUCKET)));
		return text.length() > 1900 ? text.substring(0, 1900) : text.toString();
	}

	private static int carried(ServerPlayer player, Item item) {
		int n = 0;
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (stack.is(item)) n += stack.getCount();
		}
		return n;
	}

	private static String xyz(BlockPos at) {
		return at.getX() + "," + at.getY() + "," + at.getZ();
	}
}
