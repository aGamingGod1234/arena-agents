package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.server.runtime.ArmSwing;
import carpet.script.utils.Tracer;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import dev.agaminggod.arenaagents.server.perception.ThreatPerception;
import dev.agaminggod.arenaagents.server.runtime.InventoryRoom;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputRuntime;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputState;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputStates;
import dev.agaminggod.arenaagents.server.runtime.input.InputLease;
import dev.agaminggod.arenaagents.server.runtime.input.InputOwner;
import dev.agaminggod.arenaagents.server.runtime.input.LeasedServerInputController;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.FluidTags;
import net.minecraft.util.Mth;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.item.FallingBlockEntity;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.Fluids;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * dig_to: the staircase or tunnel a player mines toward a goal, run at body speed. Each step's cells are known in
 * advance (a 1-drop staircase down clears the three cells ahead and below, a staircase up the two ahead and above plus
 * the jump headroom, a tunnel the two ahead), so the body selects the fastest hotbar tool, mines them with the held
 * attack key at vanilla speed, and walks into the opening; it never breaks the block it stands on. It stops and hands
 * the decision back on what a player would stop for, from what the player perceives: lava seen or heard at the cells it
 * opens (an opening it just made beside seen lava is plugged first), water it cannot seal with a few carried blocks, a
 * cave under the step it cannot pass, gravel that keeps falling in, a sensed hostile, damage, low health or food, no
 * fitting tool or a worn one, a full inventory, an unbreakable block, or the goal. What a player handles without
 * thinking it handles too: a cave beside the stairs is passed, water trickling into the cut is sealed with a carried
 * block, an open floor is first followed sideways along the cave wall and then, onto seen ground within a few blocks,
 * dropped into. The model chose the goal; nothing here picks another one.
 */
public final class ServerDigController implements ServerController {
	public enum Pattern {
		STAIRS_DOWN("stairs_down"), STEEP_DOWN("steep_down"), STAIRS_UP("stairs_up"), TUNNEL("tunnel"), SHAFT("shaft");

		private final String wireName;

		Pattern(String wireName) { this.wireName = wireName; }

		public String wireName() { return wireName; }

		public static Pattern parse(String value) {
			if (value == null) return STAIRS_DOWN;
			for (Pattern pattern : values()) if (pattern.wireName.equals(value)) return pattern;
			throw new IllegalArgumentException("pattern must be stairs_down, steep_down, stairs_up, tunnel or shaft");
		}

		boolean down() {
			return this == STAIRS_DOWN || this == STEEP_DOWN || this == SHAFT;
		}
	}

	/** Executor services the controller uses: the break gate's lava check and one vanilla placement click. */
	public interface Environment {
		/** Lava seen or heard beside the cell (break_block's LAVA_BEHIND rule), or null. */
		String lavaBehind(ServerPlayer player, BlockPos cell);

		/** One vanilla placement click of {@code itemId} at {@code cell} on its support face: null when it placed, else why not. */
		String place(ServerPlayer player, BlockPos cell, Direction face, String itemId);
	}

	static final float LOW_HEALTH = 8.0F;
	static final int LOW_FOOD = 6;
	static final double HOSTILE_RANGE = 12.0D;
	/** A tool with this many uses left or fewer is about to break; it is not swung. */
	static final int WORN_USES = 2;
	/** Blocks this soft (snow 0.1-0.2) are broken by hand when no hotbar tool harvests them. */
	static final float HAND_BREAKS = 0.5F;
	static final int MAX_REFILLS_PER_STEP = 12;
	/** The deepest drop onto seen ground a descent takes when no wall is left to follow: 4 fall damage at most. */
	static final int MAX_DROP = 7;
	/** Health a planned drop must leave, well clear of LOW_HEALTH. */
	static final float DROP_HEALTH_LEFT = 14.0F;
	/** Blocks placed into water at one step, and in one call, before the water counts as a lake or aquifer. */
	static final int MAX_SEALS_PER_STEP = 6;
	static final int MAX_SEALS = 40;
	/** Steps a sideways turn holds before an x/z goal pulls the heading back. */
	static final int DETOUR_STEPS = 4;
	static final int MAX_TURNS = 24;
	/** Level steps across the top of a cave (a placed floor where needed) before the descent is handed back. */
	static final int MAX_CROSS = 12;
	/** Landing blocks that hurt or give way: a drop never chooses them. */
	private static final Set<String> BAD_LANDINGS = Set.of("minecraft:magma_block", "minecraft:campfire", "minecraft:soul_campfire",
			"minecraft:pointed_dripstone", "minecraft:powder_snow", "minecraft:cactus", "minecraft:sweet_berry_bush", "minecraft:scaffolding");
	private static final int MOVE_TICKS = 50;
	private static final int AIM_TICKS = 20;
	private static final int PEER_TICKS = 40;
	private static final int SETTLE_FALL_TICKS = 60;
	private static final int PLACE_ATTEMPTS = 3;
	/** Blocks a player carries to fill a hole or plug lava, cheapest first. */
	static final List<String> FILLERS = List.of("minecraft:cobblestone", "minecraft:cobbled_deepslate", "minecraft:netherrack",
			"minecraft:dirt", "minecraft:andesite", "minecraft:diorite", "minecraft:granite", "minecraft:tuff", "minecraft:stone",
			"minecraft:deepslate", "minecraft:blackstone", "minecraft:basalt", "minecraft:sandstone", "minecraft:end_stone");

	/** The shaft's own fall past this many blocks is no longer its one-block step: the water bucket comes out. */
	static final double SHAFT_CLUTCH_FALL = 1.2D;
	/** A landing fall past this many blocks hurts (vanilla: one point per block past the third). */
	static final double SAFE_FALL = 3.0D;
	public static final int DEFAULT_MAX_SHAFT_Y = -20;
	private static final int CAVE_LOOK_TICKS = 40;
	/** Lava glows: across a dark cave it shows from far off, as far as the view reaches into it. */
	private static final double CAVE_SIGHT = 64.0D;
	static final double LAVA_NEAR = 16.0D;
	private static final String WATER_BUCKET = "minecraft:water_bucket";
	private static final int OFFHAND = 40;

	private enum Phase { START, MINE, SETTLE_FALL, FLOOR, PLACE, MOVE, RETREAT, RECENTER, SHAFT_FALL, CAVE_LOOK }

	private final Pattern pattern;
	/** The shape being dug now: the requested pattern, or steep_down once a shaft passes maxShaftY. */
	private Pattern active;
	/** A shaft goes on as steep_down at or below this y (lava lakes and aquifer lava are common down there). */
	private final int maxShaftY;
	private Integer shaftEndY;
	/** A block id whose sight ends the dig (TARGET_SEEN), as travel_to's stopWhenSeen. */
	private final String stopWhenSeen;
	/** The first lava the eye saw within {@link #LAVA_NEAR} blocks, how far and when (ms into the call). */
	private BlockPos lavaFirst;
	private double lavaFirstDistance;
	private long lavaFirstMs;
	// The shaft's fall after the floor breaks: from where, a water clutch placed, and the landing.
	private BlockPos shaftFrom;
	private BlockPos clutchWater;
	private InteractionHand clutchHand;
	private int clutchSlot;
	private int landedTicks;
	private int deepestDrop;
	private boolean doused;
	private int douseTicks;
	// The look round a cave before a CAVE_OPENING stop is handed back: what the eye saw of the way down.
	private boolean caveLooked;
	private String lookCode;
	private String lookWhy;
	private float lookTurned;
	private float lookLastYaw;
	private BlockPos caveFloor;
	private BlockPos caveLava;
	private final Integer targetY;
	private final Integer targetX;
	private final Integer targetZ;
	private final int maxBlocks;
	private final long timeoutMs;
	private final long startedAt;
	private final Environment environment;
	/**
	 * Dig on past caves (the default): a cave beside the cut is reported, an open floor is followed sideways along the
	 * wall and dropped through onto seen ground. False stops at the first cave.
	 */
	private final boolean throughCaves;
	/** throughCaves:true sent by the model (the default is true): the explicit override for an unseen floor underside. */
	private boolean acceptUnseenBelow;

	/** Set from the call's explicit throughCaves:true; returns this. */
	public ServerDigController acceptUnseenBelow(boolean accept) {
		this.acceptUnseenBelow = accept;
		return this;
	}
	private final List<String> caves = new ArrayList<>();
	private Direction heading;
	/** Headings already blocked at {@link #triedAt}; the stairs turn to another before dropping or stopping. */
	private final Set<Direction> triedHere = EnumSet.noneOf(Direction.class);
	private BlockPos triedAt;
	/** Up the stairs just dug from {@link #triedAt}: never a heading to turn to there. */
	private Direction backAt;
	/** The heading the cave was first met in at {@link #triedAt}: a crossing goes on that way. */
	private Direction blockedAt;
	private Direction lastStepHeading;
	/** The next step is a level one across a cave top (a 1x2 cut, a carried block placed as its floor when open). */
	private boolean crossNext;
	private Direction crossHeading;
	private int crossSteps;
	private int crossed;
	private int detourSteps;
	private int turns;
	/** Fall damage a chosen drop expects; that damage alone does not stop the dig. */
	private float plannedFall;
	private int dropStep = -1;
	private final List<String> drops = new ArrayList<>();
	private int seals;
	private int sealsThisStep;
	private boolean sealing;
	/** A body leaning over an edge (peering, aiming) steps back onto this column before the next cut. */
	private BlockPos recenterTo;
	private Phase afterRecenter;
	/** A stop met while crouched at an edge: handed back once the body stands back on its block, never sliding off it. */
	private String pendingCode;
	private String pendingWhy;

	private Phase phase = Phase.START;
	private InputLease lease;
	private LeasedServerInputController input;
	private BlockPos feet;
	private BlockPos next;
	private List<BlockPos> cells = List.of();
	private int cellIndex;
	private BlockState mining;
	private int miningTicks;
	private int aimTicks;
	private int phaseTicks;
	private int refills;
	private final Set<BlockPos> cut = new HashSet<>();
	private final Set<BlockPos> openBefore = new HashSet<>();
	private BlockPos placeAt;
	private Direction placeFace;
	private String placeItem;
	private int placeAttempts;
	private int leanTicks;
	private String placeRefusal;
	private String afterPlace;
	private String afterPlaceCode;
	private int startY;
	private float lastHealth = Float.NaN;
	private int blocksMined;
	private int steps;
	private final Map<String, Integer> minedCounts = new LinkedHashMap<>();
	private final Map<String, BlockPos> oresSeen = new LinkedHashMap<>();
	private final Map<String, Integer> oreCounts = new LinkedHashMap<>();
	private final List<String> notes = new ArrayList<>();
	private String lastTool;
	private boolean started;

	public ServerDigController(Pattern pattern, Integer targetY, Integer targetX, Integer targetZ, Direction heading,
			int maxBlocks, long timeoutMs, long startedAt, Environment environment) {
		this(pattern, targetY, targetX, targetZ, heading, maxBlocks, timeoutMs, startedAt, environment, false);
	}

	public ServerDigController(Pattern pattern, Integer targetY, Integer targetX, Integer targetZ, Direction heading,
			int maxBlocks, long timeoutMs, long startedAt, Environment environment, boolean throughCaves) {
		this(pattern, targetY, targetX, targetZ, heading, maxBlocks, timeoutMs, startedAt, environment, throughCaves, DEFAULT_MAX_SHAFT_Y, null);
	}

	public ServerDigController(Pattern pattern, Integer targetY, Integer targetX, Integer targetZ, Direction heading,
			int maxBlocks, long timeoutMs, long startedAt, Environment environment, boolean throughCaves, int maxShaftY, String stopWhenSeen) {
		this.throughCaves = throughCaves;
		this.pattern = pattern;
		this.active = pattern;
		this.maxShaftY = maxShaftY;
		this.stopWhenSeen = stopWhenSeen;
		this.targetY = targetY;
		this.targetX = targetX;
		this.targetZ = targetZ;
		this.heading = heading;
		this.maxBlocks = maxBlocks;
		this.timeoutMs = timeoutMs;
		this.startedAt = startedAt;
		this.environment = environment;
		if (pattern != Pattern.TUNNEL && targetY == null) throw new IllegalArgumentException("stairs patterns need a target y");
		if (pattern == Pattern.TUNNEL && targetX == null && targetZ == null && heading == null)
			throw new IllegalArgumentException("tunnel needs x, z or a heading");
	}

	@Override
	public TickResult tick(ServerPlayer player, long nowEpochMs) {
		if (!started) {
			started = true;
			startY = player.blockPosition().getY();
			lastHealth = player.getHealth();
			if (heading == null && targetX == null && targetZ == null) heading = player.getDirection();
			// Already falling when the call starts (a drop the last call began): the landing is not this call's surprise.
			if (!player.onGround() && player.fallDistance > 0.0F) plannedFall = player.getHealth();
			// A shaft drops the body through every floor it breaks; a player digs one only with water in hand for the fall
			// or the lava a broken floor can open onto.
			if (pattern == Pattern.SHAFT && bucketSlot(player) < 0) {
				releaseInput();
				return TickResult.failed("NO_WATER_BUCKET", "A shaft needs a water bucket in the hotbar or offhand (it catches a fall into a cave"
						+ " and puts out lava the body drops into); fill a bucket at any water, or dig steep_down or stairs_down instead", 0.0D);
			}
		}
		TickResult lava = douse(player);
		if (lava != null) return lava;
		if (phase == Phase.CAVE_LOOK) return caveLook(player);
		if (pendingCode != null) {
			TickResult back = recenter(player);
			return phase == Phase.RECENTER ? back : finishStop(player);
		}
		long elapsed = nowEpochMs - startedAt;
		if (elapsed >= timeoutMs) return TickResult.timedOut("ACTION_TIMED_OUT", summary(player, "Dig timed out"), progress(player));
		TickResult danger = danger(player);
		if (danger != null) return danger;
		TickResult sight = sight(player, nowEpochMs);
		if (sight != null) return sight;
		return switch (phase) {
			case START -> plan(player);
			case MINE -> mine(player);
			case SETTLE_FALL -> settleFall(player);
			case FLOOR -> floor(player);
			case PLACE -> place(player);
			case MOVE -> move(player);
			case RETREAT -> retreat(player);
			case RECENTER -> recenter(player);
			case SHAFT_FALL -> shaftFall(player);
			case CAVE_LOOK -> caveLook(player);
		};
	}

	/**
	 * Once a second: lava the eye sees (the first sighting is kept for the result, with its distance) and the
	 * stopWhenSeen block. A fan of sight lines across the view only: what the player is looking at, nothing behind rock.
	 */
	private TickResult sight(ServerPlayer player, long nowEpochMs) {
		if (player.tickCount % 20 != 0) return null;
		if (lavaFirst == null || "minecraft:lava".equals(stopWhenSeen)) {
			BlockPos lava = ServerTravelController.sees(player, "minecraft:lava");
			if (lava != null) noteLava(player, lava, nowEpochMs - startedAt);
			if (lava != null && "minecraft:lava".equals(stopWhenSeen)) return seen(player, lava);
		}
		if (stopWhenSeen != null && !"minecraft:lava".equals(stopWhenSeen)) {
			BlockPos seen = ServerTravelController.sees(player, stopWhenSeen);
			if (seen != null) return seen(player, seen);
		}
		return null;
	}

	private TickResult seen(ServerPlayer player, BlockPos at) {
		// Never handed back mid-fall or leaning over an edge: the next tick on the ground reports it.
		if (!player.onGround() || phase == Phase.SHAFT_FALL || phase == Phase.PLACE) return null;
		releaseInput();
		return TickResult.succeeded("TARGET_SEEN", summary(player, stopWhenSeen + " seen at " + cell(at) + ", "
				+ fmt(Math.sqrt(at.distToCenterSqr(player.getEyePosition()))) + " blocks away (dy" + signed(at.getY() - player.blockPosition().getY()) + ")"));
	}

	@Override
	public void cancel(ServerPlayer player) {
		releaseInput();
	}

	// ---- stops a player makes whatever the step ----

	private TickResult danger(ServerPlayer player) {
		float health = player.getHealth();
		if (health < lastHealth - 0.01F) {
			String source = player.getLastDamageSource() == null ? "unknown" : player.getLastDamageSource().getMsgId();
			// The fall the dig chose to take (a drop into a cave onto seen ground) is the expected damage, not a surprise.
			if (plannedFall > 0.0F && "fall".equals(source) && lastHealth - health <= plannedFall + 1.0F) {
				plannedFall = 0.0F;
			} else {
				return stop(player, "DAMAGE_TAKEN", "Took " + fmt(lastHealth - health) + " damage (" + source + "); health " + fmt(health));
			}
		}
		lastHealth = health;
		// Eyes under water is no trickle: the breath is running out and the model decides (swim up, block off, leave).
		if (player.isUnderWater()) return stop(player, "WATER_AHEAD", "The body is under water at " + cell(player.blockPosition())
				+ " (air " + player.getAirSupply() + "/" + player.getMaxAirSupply() + "); not digging on");
		if (health <= LOW_HEALTH) return stop(player, "LOW_HEALTH", "Health " + fmt(health) + " is at or below " + fmt(LOW_HEALTH));
		if (player.getFoodData().getFoodLevel() <= LOW_FOOD)
			return stop(player, "LOW_FOOD", "Food " + player.getFoodData().getFoodLevel() + " is at or below " + LOW_FOOD + " (no sprinting or healing soon)");
		// Mid-drop nothing can be done about a mob; the stop waits for the landing.
		if (player.tickCount % 5 == 0 && (plannedFall <= 0.0F || player.onGround()) && phase != Phase.SHAFT_FALL) {
			List<Mob> threats = player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(HOSTILE_RANGE),
					mob -> player.distanceTo(mob) <= HOSTILE_RANGE && ThreatPerception.isSensedThreat(player, mob));
			if (!threats.isEmpty()) {
				Mob nearest = threats.stream().min((a, b) -> Double.compare(player.distanceTo(a), player.distanceTo(b))).orElseThrow();
				return stop(player, "HOSTILE_NEAR", BuiltInRegistries.ENTITY_TYPE.getKey(nearest.getType()) + " " + nearest.getUUID()
						+ " at " + cell(nearest.blockPosition()) + ", " + fmt(player.distanceTo(nearest)) + " blocks away");
			}
		}
		return null;
	}

	// ---- planning one step ----

	private TickResult plan(ServerPlayer player) {
		if (!player.onGround()) {
			if (++phaseTicks > 40) return stop(player, "DIG_STUCK", "The body is not standing on a block");
			hold(player, 0.0F, false, false, player.getYRot(), player.getXRot());
			return TickResult.running(progress(player));
		}
		feet = player.blockPosition();
		// Leaning over an edge the body's centre can hang over open air while a neighbouring block holds it: step back
		// onto that block first, so no cut of the next step is the block the body rests on.
		if (!standable(player.level(), feet.below(), player.level().getBlockState(feet.below()))) {
			BlockPos support = supportColumn(player);
			if (support != null) return startRecenter(player, support, Phase.START);
		}
		if (goalReached(feet)) return done(player);
		if (blocksMined >= maxBlocks) {
			releaseInput();
			return TickResult.succeeded("DIG_LIMIT_REACHED", summary(player, "Mined the maxBlocks limit of " + maxBlocks + " before the goal; call dig_to again to go on"));
		}
		Direction toward = towardTarget(targetX, targetZ, feet);
		if (toward != null && detourSteps <= 0) heading = toward;
		if (plannedFall > 0.0F && steps > dropStep + 1) plannedFall = 0.0F;
		sealsThisStep = 0;
		if (active == Pattern.SHAFT && feet.getY() <= maxShaftY) {
			// Down here lava lakes and aquifer lava are common: the rest of the way is steep_down, which sees each step's
			// floor before it stands on it.
			active = Pattern.STEEP_DOWN;
			shaftEndY = feet.getY();
		}
		if (active == Pattern.SHAFT) {
			TickResult shaft = planShaft(player);
			if (shaft != null) return shaft;
		}
		Pattern shape = crossNext ? Pattern.TUNNEL : active;
		cells = stepCells(shape, feet, heading);
		// A plant or snow layer in the body's own cell is in the way of the crosshair down: broken first.
		BlockState atFeet = player.level().getBlockState(feet);
		if (shape == Pattern.SHAFT && !open(player.level(), feet, atFeet) && atFeet.getFluidState().isEmpty()) cells = List.of(feet, feet.below());
		next = stepTarget(shape, feet, heading);
		openBefore.clear();
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		for (BlockPos cell : cells) for (Direction side : Direction.values()) {
			BlockPos neighbour = cell.relative(side);
			BlockState known = seen.known(neighbour.getX(), neighbour.getY(), neighbour.getZ());
			if (known != null && passable(player.level(), neighbour, known)) openBefore.add(neighbour);
		}
		refills = 0;
		cellIndex = 0;
		mining = null;
		phaseTicks = 0;
		phase = Phase.MINE;
		return mine(player);
	}

	/**
	 * Before the shaft breaks the block underfoot: the body stands centred on it (so it drops straight into the hole,
	 * not onto an edge), and what the eye has already seen of the column under it rules the break out: lava or water
	 * there, or a drop past a safe fall into open space. Most often nothing below is seen yet; the next floor shows once
	 * this one breaks, and {@link #shaftFall} looks at it on landing. Null goes on to mine the block.
	 */
	private TickResult planShaft(ServerPlayer player) {
		Vec3 center = Vec3.atBottomCenterOf(feet);
		if (Math.hypot(center.x - player.getX(), center.z - player.getZ()) > 0.2D) return startRecenter(player, feet, Phase.START);
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		BlockPos floor = feet.below();
		// Where water evaporates (the Nether) the bucket catches no fall and puts out no lava, so a floor whose underside
		// the eye has not seen is a drop of unseen depth: decision 11 refuses it unless the model accepts caves (deck c6-4:
		// a shaft through a fortress bridge broke into a cave and fell 18 blocks into the lava sea).
		boolean noClutch = !acceptUnseenBelow && evaporates(player, floor);
		for (int depth = 1; depth <= 24; depth++) {
			BlockPos at = floor.below(depth);
			BlockState state = seen.known(at.getX(), at.getY(), at.getZ());
			if (state == null) {
				if (noClutch) return stop(player, "UNSEEN_BELOW", "Nothing under the floor at " + cell(floor) + " is seen " + (depth == 1 ? "" : "past "
						+ (depth - 1) + " open block(s) ") + "and water evaporates here, so breaking it may drop the body into a cave or lava;"
						+ " not breaking it (steep_down or stairs_down see each step first; an explicit throughCaves:true breaks it anyway)");
				break;
			}
			if (state.getFluidState().is(FluidTags.LAVA))
				return stop(player, "LAVA_AHEAD", "Lava seen at " + cell(at) + " under the floor at " + cell(floor) + "; not breaking it");
			if (state.getFluidState().is(FluidTags.WATER))
				return stop(player, "WATER_AHEAD", "Water seen at " + cell(at) + " under the floor at " + cell(floor) + "; not breaking it");
			if (!passable(player.level(), at, state)) {
				if (depth > SAFE_FALL) return stop(player, "CAVE_OPENING", "Breaking the floor at " + cell(floor) + " drops " + depth
						+ " blocks into a cave onto " + shortId(state) + " at " + cell(at) + "; not breaking it");
				break;
			}
			if (depth == 24) return stop(player, "CAVE_OPENING", "Breaking the floor at " + cell(floor) + " drops into a cave more than 24 blocks deep; not breaking it");
		}
		return null;
	}

	/** Whether water placed at {@code at} evaporates (vanilla's ultrawarm rule, the Nether). */
	static boolean evaporates(ServerPlayer player, BlockPos at) {
		return player.level().environmentAttributes().getValue(net.minecraft.world.attribute.EnvironmentAttributes.WATER_EVAPORATES, at);
	}

	/**
	 * The cells one step opens, top first so a loose block above lands in a cell still to be cleared. Only the shaft
	 * breaks the block the body stands on: the stairs never dig straight down.
	 */
	static List<BlockPos> stepCells(Pattern pattern, BlockPos feet, Direction heading) {
		BlockPos ahead = feet.relative(heading);
		return switch (pattern) {
			case STAIRS_DOWN -> List.of(ahead.above(), ahead, ahead.below());
			// Two blocks down per step: 2 blocks mined per level instead of 3, a drop with no fall damage, not walkable back up.
			case STEEP_DOWN -> List.of(ahead.above(), ahead, ahead.below(), ahead.below(2));
			// Ahead (the next step's feet at eye level, then its head, seen through it) first; the jump headroom over the
			// body last. From a two-high pocket the head cell is hidden until the feet cell is open.
			case STAIRS_UP -> List.of(ahead.above(), ahead.above(2), feet.above(2));
			case TUNNEL -> List.of(ahead.above(), ahead);
			// Straight down: the block the body stands on, broken only with the body centred over it.
			case SHAFT -> List.of(feet.below());
		};
	}

	/** The feet cell the body steps into once the step's cells are open. */
	static BlockPos stepTarget(Pattern pattern, BlockPos feet, Direction heading) {
		BlockPos ahead = feet.relative(heading);
		return switch (pattern) {
			case STAIRS_DOWN -> ahead.below();
			case STEEP_DOWN -> ahead.below(2);
			case STAIRS_UP -> ahead.above();
			case TUNNEL -> ahead;
			case SHAFT -> feet.below();
		};
	}

	private boolean goalReached(BlockPos at) {
		return switch (pattern) {
			case STAIRS_DOWN, STEEP_DOWN, SHAFT -> at.getY() <= targetY;
			case STAIRS_UP -> at.getY() >= targetY;
			case TUNNEL -> (targetX != null || targetZ != null)
					&& (targetX == null || at.getX() == targetX) && (targetZ == null || at.getZ() == targetZ);
		};
	}

	/** The cardinal heading that closes the larger remaining x/z distance, or null with no x/z left. */
	static Direction towardTarget(Integer targetX, Integer targetZ, BlockPos at) {
		int dx = targetX == null ? 0 : targetX - at.getX();
		int dz = targetZ == null ? 0 : targetZ - at.getZ();
		if (dx == 0 && dz == 0) return null;
		if (Math.abs(dx) >= Math.abs(dz)) return dx > 0 ? Direction.EAST : Direction.WEST;
		return dz > 0 ? Direction.SOUTH : Direction.NORTH;
	}

	// ---- mining the step's cells, top first so loose blocks above land in a cell still to be cleared ----

	private TickResult mine(ServerPlayer player) {
		ServerLevel level = player.level();
		// A loose block that fell into a cell already opened hides the cells below it: mine from the highest such cell.
		for (int index = 0; index < cellIndex; index++) {
			BlockState above = level.getBlockState(cells.get(index));
			if (!open(level, cells.get(index), above) && above.getFluidState().isEmpty()) {
				if (above.getBlock() instanceof FallingBlock) refills++;
				cellIndex = index;
				mining = null;
				break;
			}
		}
		while (cellIndex < cells.size()) {
			BlockPos cell = cells.get(cellIndex);
			BlockState state = level.getBlockState(cell);
			if (state.getFluidState().is(FluidTags.LAVA)) return fluidStop(player, cell, cell, true);
			if (state.getFluidState().is(FluidTags.WATER)) return fluidStop(player, cell, cell, false);
			if (!open(level, cell, state)) break;
			cut.add(cell);
			cellIndex++;
			if (mining != null) {
				// Carpet's held attack broke it since the last tick.
				blocksMined++;
				minedCounts.merge(shortId(mining), 1, Integer::sum);
				if (isOre(mining)) noteOre(blockId(mining), cell);
				mining = null;
				// A shaft's broken floor drops the body at once: what it opened onto is judged on landing (lava there is
				// doused), not plugged from a hole the body is already falling through.
				TickResult shown = active == Pattern.SHAFT ? null : fluidShown(player, cell);
				if (shown != null) return shown;
			}
		}
		if (cellIndex >= cells.size()) {
			if (active == Pattern.SHAFT) {
				shaftFrom = feet;
				landedTicks = 0;
				phase = Phase.SHAFT_FALL;
				phaseTicks = 0;
				return shaftFall(player);
			}
			phase = Phase.SETTLE_FALL;
			phaseTicks = 0;
			return settleFall(player);
		}
		BlockPos cell = cells.get(cellIndex);
		BlockState state = level.getBlockState(cell);
		if (mining == null) {
			// What a player checks before swinging at the next cell: lava seen or heard beside it, water seen beside it.
			String lava = environment.lavaBehind(player, cell);
			if (lava != null) return stop(player, "LAVA_AHEAD", "Lava is " + lava + "; not breaking " + blockId(state) + " at " + cell(cell));
			BlockPos water = seenFluidBeside(player, cell, false);
			if (water != null) return fluidStop(player, cell, water, false);
			if (active != Pattern.SHAFT && restsOnlyOn(player, cell)) return startRecenter(player, feet, Phase.MINE);
			if (state.getDestroySpeed(level, cell) < 0.0F) return stop(player, "UNBREAKABLE", blockId(state) + " at " + cell(cell) + " cannot be broken");
			if (refills > MAX_REFILLS_PER_STEP)
				return stop(player, "FALLING_BLOCKS", "Loose blocks keep falling into " + cell(cell) + " (" + refills + " refills this step); "
						+ blockId(state) + " above");
			TickResult room = inventoryRoom(player, cell, state);
			if (room != null) return room;
			mining = state;
			miningTicks = 0;
			aimTicks = 0;
		} else if (!state.equals(mining)) {
			// A loose block fell into the cell being mined: mine it too.
			if (state.getBlock() instanceof FallingBlock) refills++;
			mining = null;
			return TickResult.running(progress(player));
		}
		int slot = toolSlot(player, state);
		if (slot == -2) return stop(player, "NO_TOOL", "No hotbar tool can harvest " + blockId(state) + " at " + cell(cell) + toolHint(player, state));
		if (slot == -3) return stop(player, "TOOL_WORN", "Every hotbar tool for " + blockId(state) + " has " + WORN_USES + " or fewer uses left" + toolHint(player, state));
		if (slot >= 0) lastTool = itemId(player.getInventory().getItem(slot));
		int selected = slot >= 0 ? slot : player.getInventory().getSelectedSlot();
		Vec3 aim = dev.agaminggod.arenaagents.server.runtime.TargetSightline.block(level, net.minecraft.world.phys.shapes.CollisionContext.of(player),
				player.getEyePosition(), cell, player.blockInteractionRange(), null);
		if (aim == null) {
			// Hidden behind the lip of the cut: crouch forward to the edge and look down, as a player leans over.
			if (++aimTicks > AIM_TICKS * 2) return stop(player, "DIG_STUCK", "No part of " + blockId(state) + " at " + cell(cell) + " is in reach and view");
			AgentInputState look = AgentInputStates.lookingAt(player, Vec3.atCenterOf(cell), 0.0F, 0.0F, false, false, false, false, false, InteractionHand.MAIN_HAND);
			applyInput(player, aimTicks > 4 ? 1.0F : 0.0F, false, true, false, AgentInputStates.turnYaw(player.getYRot(), look.yaw()),
					AgentInputStates.turnPitch(player.getXRot(), look.pitch()), selected);
			return TickResult.running(progress(player));
		}
		AgentInputState look = AgentInputStates.lookingAt(player, aim, 0.0F, 0.0F, false, false, false, false, false, InteractionHand.MAIN_HAND);
		float yaw = AgentInputStates.turnYaw(player.getYRot(), look.yaw());
		float pitch = AgentInputStates.turnPitch(player.getXRot(), look.pitch());
		boolean onTarget = Tracer.rayTrace(player, 1.0F, player.blockInteractionRange(), false) instanceof BlockHitResult hit
				&& hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(cell);
		if (!onTarget && ++aimTicks > AIM_TICKS * 3) return stop(player, "DIG_STUCK", "The view did not settle on " + cell(cell));
		applyInput(player, 0.0F, false, false, onTarget, yaw, pitch, selected);
		if (onTarget && ++miningTicks > 600) return stop(player, "DIG_STUCK", blockId(state) + " at " + cell(cell) + " did not break in 30 s");
		return TickResult.running(progress(player));
	}

	/** Lava or water the cell just opened shows the eye beside it (or that flowed into it). */
	private TickResult fluidShown(ServerPlayer player, BlockPos cell) {
		BlockState inCell = player.level().getBlockState(cell);
		if (inCell.getFluidState().is(FluidTags.LAVA)) return fluidStop(player, cell, cell, true);
		if (inCell.getFluidState().is(FluidTags.WATER)) return fluidStop(player, cell, cell, false);
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		for (Direction side : Direction.values()) {
			BlockPos neighbour = cell.relative(side);
			if (cut.contains(neighbour) || !seen.seesNow(neighbour.getX(), neighbour.getY(), neighbour.getZ())) continue;
			BlockState known = seen.known(neighbour.getX(), neighbour.getY(), neighbour.getZ());
			if (known == null || trickleAtBody(player, neighbour, known)) continue;
			if (known.getFluidState().is(FluidTags.LAVA)) return fluidStop(player, cell, neighbour, true);
			if (known.getFluidState().is(FluidTags.WATER)) return fluidStop(player, cell, neighbour, false);
		}
		return null;
	}

	private TickResult settleFall(ServerPlayer player) {
		cut.addAll(cells);
		AABB column = new AABB(cells.getFirst()).minmax(new AABB(cells.getLast())).inflate(0.5D, 3.0D, 0.5D);
		boolean falling = !player.level().getEntitiesOfClass(FallingBlockEntity.class, column).isEmpty();
		if (falling && active == Pattern.STAIRS_UP && player.level().getEntitiesOfClass(FallingBlockEntity.class,
				player.getBoundingBox().inflate(0.2D, 4.0D, 0.2D)).stream().anyMatch(e -> e.getY() > player.getEyeY())) {
			phase = Phase.RETREAT;
			phaseTicks = 0;
			return retreat(player);
		}
		if (falling && ++phaseTicks < SETTLE_FALL_TICKS) {
			hold(player, 0.0F, false, false, player.getYRot(), player.getXRot());
			return TickResult.running(progress(player));
		}
		ServerLevel level = player.level();
		for (int index = 0; index < cells.size(); index++) {
			BlockPos cell = cells.get(index);
			BlockState state = level.getBlockState(cell);
			if (!open(level, cell, state) && !state.getFluidState().is(FluidTags.LAVA) && !state.getFluidState().is(FluidTags.WATER)) {
				// Something fell in or flowed in: back to mining from that cell.
				if (state.getBlock() instanceof FallingBlock) refills++;
				cellIndex = index;
				mining = null;
				phase = Phase.MINE;
				return TickResult.running(progress(player));
			}
		}
		TickResult revealed = revealed(player);
		if (revealed != null) return revealed;
		phase = Phase.FLOOR;
		phaseTicks = 0;
		return floor(player);
	}

	/** Lava, water and caves the opened cells now show the eye; ores on their walls are noted. */
	private TickResult revealed(ServerPlayer player) {
		ServerLevel level = player.level();
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		int newlyOpen = 0;
		BlockPos firstOpen = null;
		for (BlockPos cell : cells) {
			BlockState inCell = level.getBlockState(cell);
			if (inCell.getFluidState().is(FluidTags.LAVA)) return fluidStop(player, cell, cell, true);
			if (inCell.getFluidState().is(FluidTags.WATER)) return fluidStop(player, cell, cell, false);
			for (Direction side : Direction.values()) {
				BlockPos neighbour = cell.relative(side);
				if (cut.contains(neighbour) || cells.contains(neighbour) || isBody(player, neighbour)) continue;
				if (!seen.seesNow(neighbour.getX(), neighbour.getY(), neighbour.getZ())) continue;
				BlockState known = seen.known(neighbour.getX(), neighbour.getY(), neighbour.getZ());
				if (known == null) continue;
				if (known.getFluidState().is(FluidTags.LAVA)) return fluidStop(player, cell, neighbour, true);
				if (known.getFluidState().is(FluidTags.WATER)) return fluidStop(player, cell, neighbour, false);
				if (isOre(known)) noteOre(blockId(known), neighbour);
				// Open sky beside a surface step is not a cave; the player sees the sky above the ground it stands on.
				if (passable(level, neighbour, known) && !openBefore.contains(neighbour) && !level.canSeeSky(neighbour)) {
					newlyOpen++;
					if (firstOpen == null) firstOpen = neighbour;
				}
			}
		}
		if (newlyOpen >= 2 && !throughCaves) return stop(player, "CAVE_OPENING", "The step opened into a cave at " + cell(firstOpen)
				+ " (" + newlyOpen + " open cells beside the cut); not stepping in (throughCaves:false)");
		if (newlyOpen >= 2 && caves.size() < 4) caves.add(cell(firstOpen) + " (y" + firstOpen.getY() + ")");
		return null;
	}

	// ---- the floor of the cell the body steps into ----

	private TickResult floor(ServerPlayer player) {
		if (active == Pattern.STAIRS_UP) {
			BlockPos step = next.below();
			BlockState state = player.level().getBlockState(step);
			if (!standable(player.level(), step, state)) return stop(player, "CAVE_OPENING", "No step block at " + cell(step) + "; " + blockId(state));
			phase = Phase.MOVE;
			phaseTicks = 0;
			return move(player);
		}
		if (crossNext) return crossFloor(player);
		BlockPos floor = next.below();
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		// The column under the step down to the first block, as far as the eye has seen it.
		BlockPos landing = null, unseen = null, water = null;
		BlockState landed = null;
		for (int depth = 0; depth < 24; depth++) {
			BlockPos at = floor.below(depth);
			// The floor is judged as seen now: a remembered floor may have fallen (gravel) since the eye last saw it.
			BlockState state = depth == 0 && !seen.seesNow(at.getX(), at.getY(), at.getZ()) ? null : seen.known(at.getX(), at.getY(), at.getZ());
			if (state == null) {
				unseen = at;
				break;
			}
			if (state.getFluidState().is(FluidTags.LAVA)) return fluidStop(player, next, at, true);
			if (state.getFluidState().is(FluidTags.WATER)) {
				// Water standing in the floor cell is filled like a hole; water further down is a pool under a drop.
				if (depth == 0) return fluidStop(player, next, at, false);
				water = at;
				break;
			}
			if (!passable(player.level(), at, state)) {
				landing = at;
				landed = state;
				break;
			}
		}
		// Peer down at what decides the step (the floor itself, the block under a one-block hole, or a cave landing within
		// reach of a drop): look first, then sneak to the edge of the cut, as a player does to look down a hole.
		if (unseen != null && (unseen.equals(floor) || floor.getY() - unseen.getY() <= MAX_DROP)) {
			if (++phaseTicks > PEER_TICKS) {
				if (unseen.equals(floor)) return stop(player, "DIG_STUCK", "Could not see the floor at " + cell(floor));
			} else {
				Vec3 point = Vec3.atBottomCenterOf(unseen).add(0.0D, 1.0D, 0.0D);
				AgentInputState look = AgentInputStates.lookingAt(player, point, 0.0F, 0.0F, false, false, false, false, false, InteractionHand.MAIN_HAND);
				float yaw = AgentInputStates.turnYaw(player.getYRot(), look.yaw());
				float pitch = AgentInputStates.turnPitch(player.getXRot(), look.pitch());
				applyInput(player, phaseTicks > AIM_TICKS / 2 ? 1.0F : 0.0F, false, true, false, yaw, pitch, player.getInventory().getSelectedSlot());
				return TickResult.running(progress(player));
			}
		}
		if (landing != null && landing.equals(floor) && standable(player.level(), floor, landed)) {
			// Loose floor (gravel, sand) holds only on something solid; a player checks under it before stepping on.
			if (landed.getBlock() instanceof FallingBlock) {
				BlockPos under = floor.below();
				BlockState support = seen.known(under.getX(), under.getY(), under.getZ());
				if (support != null && passable(player.level(), under, support))
					return blocked(player, "The floor under the next step is " + blockId(landed) + " at " + cell(floor) + " with open space under it", null, null);
			}
			TickResult beyond = openBeyond(player, seen);
			if (beyond != null) return beyond;
			return step(player);
		}
		BlockState known = seen.known(floor.getX(), floor.getY(), floor.getZ());
		if (landing != null && landing.equals(floor.below()) && sturdy(player.level(), landing, landed) && known != null && known.canBeReplaced()) {
			String filler = filler(player);
			if (filler == null) return stop(player, "NO_FLOOR", "A one-block hole at " + cell(floor) + " under the next step and no block to fill it");
			return startPlace(player, floor, Direction.UP, filler, null, null);
		}
		// A drop of 3 blocks or less onto seen ground does no fall damage: a player digging on through a cave takes it.
		if (throughCaves && landing != null && standable(player.level(), landing, landed) && feet.getY() - (landing.getY() + 1) <= 3
				&& safeLanding(player, seen, landing, landed)) {
			TickResult beyond = openBeyond(player, seen);
			if (beyond != null) return beyond;
			return step(player);
		}
		return blocked(player, "The floor under the next step at " + cell(floor) + " is open: a drop of "
				+ (landing != null ? (feet.getY() - landing.getY() - 1) + " blocks onto " + blockId(landed)
						: water != null ? (feet.getY() - water.getY()) + " blocks into water at " + cell(water)
						: "at least " + (feet.getY() - (unseen == null ? floor.below(23) : unseen).getY()) + " blocks (bottom not seen)"), landing, landed);
	}

	/** The floor of a level step across a cave top: stepped on when there, else a carried block placed against the body's own floor. */
	private TickResult crossFloor(ServerPlayer player) {
		BlockPos floor = next.below();
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		BlockState state = seen.seesNow(floor.getX(), floor.getY(), floor.getZ()) ? seen.known(floor.getX(), floor.getY(), floor.getZ()) : null;
		if (state != null && state.getFluidState().is(FluidTags.LAVA)) return fluidStop(player, next, floor, true);
		if (state != null && standable(player.level(), floor, state) && !(state.getBlock() instanceof FallingBlock)) return step(player);
		BlockPos support = feet.below();
		String filler = filler(player);
		if ((state == null || state.canBeReplaced()) && filler != null && sturdy(player.level(), support, player.level().getBlockState(support))) {
			if (notes.size() < 8 && crossSteps == 0) notes.add("crossed a cave top " + heading.getName() + " from y" + feet.getY());
			return startPlace(player, floor, heading, filler, null, null);
		}
		return stop(player, "CAVE_OPENING", "Cannot cross the cave at " + cell(floor) + ": " + (filler == null ? "no block to place" : "no floor to build from"));
	}

	private TickResult step(ServerPlayer player) {
		phase = Phase.MOVE;
		phaseTicks = 0;
		return move(player);
	}

	/**
	 * The step ahead cannot be taken (an open floor or an edge past it). As a player keeps the stairs going beside a
	 * cave: turn to a heading not yet tried here (never back up the stairs just dug), then, with every heading tried,
	 * drop onto seen ground within {@link #MAX_DROP} blocks when the fall leaves health well clear; else stop.
	 */
	private TickResult blocked(ServerPlayer player, String why, BlockPos landing, BlockState landed) {
		if (!throughCaves) return stop(player, "CAVE_OPENING", why + "; not stepping in (throughCaves:false)");
		boolean down = active.down();
		if (down) {
			if (!feet.equals(triedAt)) {
				triedAt = feet;
				triedHere.clear();
				backAt = (lastStepHeading != null ? lastStepHeading : heading).getOpposite();
				blockedAt = heading;
			}
			triedHere.add(heading);
			Direction back = backAt;
			// Out on a crossing the walls are behind: no turning there, the crossing goes on or ends.
			if (turns < MAX_TURNS && crossSteps == 0) for (Direction side : new Direction[] { heading.getClockWise(), heading.getCounterClockWise(), heading.getOpposite() }) {
				if (triedHere.contains(side) || side == back) continue;
				turns++;
				if (notes.size() < 6) notes.add("turned " + side.getName() + " along a cave at y" + feet.getY());
				heading = side;
				detourSteps = DETOUR_STEPS;
				phase = Phase.START;
				phaseTicks = 0;
				return TickResult.running(progress(player));
			}
			if (landing != null) {
				SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
				int drop = feet.getY() - landing.getY() - 1;
				float damage = dropDamage(drop);
				if (drop <= MAX_DROP && standable(player.level(), landing, landed) && safeLanding(player, seen, landing, landed)
						&& player.getHealth() - damage >= DROP_HEALTH_LEFT) {
					plannedFall = damage;
					dropStep = steps;
					if (drops.size() < 4) drops.add(drop + " blocks onto " + shortId(landed) + " at " + cell(landing));
					return step(player);
				}
			}
			// Across the top of the cave at this level, as a player tunnels or bridges over it to rock beyond.
			if (crossSteps < MAX_CROSS && filler(player) != null) {
				crossHeading = crossSteps == 0 ? blockedAt : crossHeading;
				heading = crossHeading;
				crossNext = true;
				phase = Phase.START;
				phaseTicks = 0;
				return TickResult.running(progress(player));
			}
		}
		return stop(player, "CAVE_OPENING", why + "; not stepping in" + (down ? "; no other heading here has a floor (tried "
				+ String.join(", ", triedHere.stream().map(Direction::getName).toList()) + "), no seen landing within " + MAX_DROP + " blocks"
				+ (crossSteps > 0 ? " and " + crossSteps + " level steps across the cave found no floor below" : filler(player) == null ? " and no block to cross it" : "") : ""));
	}

	/** Vanilla fall damage for a drop of whole blocks: one point per block past the third. */
	static float dropDamage(int drop) {
		return Math.max(0, drop - 3);
	}

	/** Ground the body may land on: not a block that hurts or gives way, with two open cells above it and no lava beside them. */
	private boolean safeLanding(ServerPlayer player, SeenTerrain.Reader<BlockState> seen, BlockPos landing, BlockState landed) {
		if (BAD_LANDINGS.contains(blockId(landed))) return false;
		if (landed.getBlock() instanceof FallingBlock) {
			BlockPos under = landing.below();
			BlockState support = seen.known(under.getX(), under.getY(), under.getZ());
			if (support == null || passable(player.level(), under, support)) return false;
		}
		for (int up = 1; up <= 2; up++) {
			BlockPos at = landing.above(up);
			BlockState state = seen.known(at.getX(), at.getY(), at.getZ());
			if (state == null || !passable(player.level(), at, state)) return false;
			for (Direction side : Direction.values()) {
				BlockPos beside = at.relative(side);
				BlockState near = seen.known(beside.getX(), beside.getY(), beside.getZ());
				if (near != null && near.getFluidState().is(FluidTags.LAVA)) return false;
			}
		}
		return true;
	}

	/**
	 * The cell past the landing, where a body still moving after the drop goes next: open there over 4 or more blocks of
	 * seen open space is an edge over a cave, which the step does not go near.
	 */
	private TickResult openBeyond(ServerPlayer player, SeenTerrain.Reader<BlockState> seen) {
		BlockPos past = next.relative(heading);
		BlockState state = seen.known(past.getX(), past.getY(), past.getZ());
		if (state == null || !passable(player.level(), past, state)) return null;
		// Only a drop the eye has seen stops the step; the crouched landing holds an edge whose bottom is out of sight.
		for (int depth = 1; depth <= 4; depth++) {
			BlockPos at = past.below(depth);
			BlockState below = seen.known(at.getX(), at.getY(), at.getZ());
			if (below == null) return null;
			if (below.getFluidState().is(FluidTags.LAVA)) return fluidStop(player, past, at, true);
			if (!passable(player.level(), at, below)) return null;
		}
		return blocked(player, "The cell past the next step at " + cell(past) + " is open over a drop", null, null);
	}

	private TickResult startPlace(ServerPlayer player, BlockPos at, Direction face, String item, String code, String message) {
		placeAt = at;
		placeFace = face;
		placeItem = item;
		placeAttempts = 0;
		leanTicks = 0;
		afterPlaceCode = code;
		afterPlace = message;
		phase = Phase.PLACE;
		phaseTicks = 0;
		return place(player);
	}

	private TickResult place(ServerPlayer player) {
		BlockPos support = placeAt.relative(placeFace.getOpposite());
		Vec3 target = Vec3.atCenterOf(support).add(placeFace.getStepX() * 0.499D, placeFace.getStepY() * 0.499D, placeFace.getStepZ() * 0.499D);
		AgentInputState look = AgentInputStates.lookingAt(player, target, 0.0F, 0.0F, false, false, false, false, false, InteractionHand.MAIN_HAND);
		float yaw = AgentInputStates.turnYaw(player.getYRot(), look.yaw());
		float pitch = AgentInputStates.turnPitch(player.getXRot(), look.pitch());
		// A floor placed out over a cave goes on the side face of the block underfoot: crouch to its edge first, as a
		// player bridging does, so the eye sees that face.
		if (crossNext && leanTicks < 12) {
			// Face the heading first: forward follows the view, and a lean sideways leaves the face out of sight.
			float toward = AgentInputStates.turnYaw(player.getYRot(), heading.toYRot());
			boolean facing = Math.abs(AgentInputStates.shortestAngleDelta(toward, heading.toYRot())) < 10.0F;
			if (facing || ++phaseTicks > AIM_TICKS) leanTicks++;
			applyInput(player, facing ? 1.0F : 0.0F, false, true, false, toward, pitch, player.getInventory().getSelectedSlot());
			return TickResult.running(progress(player));
		}
		applyInput(player, 0.0F, false, crossNext, false, yaw, pitch, player.getInventory().getSelectedSlot());
		boolean settled = Math.abs(AgentInputStates.shortestAngleDelta(yaw, look.yaw())) <= 1.0F && Math.abs(pitch - look.pitch()) <= 1.0F;
		if (!settled && ++phaseTicks < AIM_TICKS) return TickResult.running(progress(player));
		boolean placed = standable(player.level(), placeAt, player.level().getBlockState(placeAt));
		if (!placed) {
			placeRefusal = environment.place(player, placeAt, placeFace, placeItem);
			placed = placeRefusal == null;
		}
		if (!placed && ++placeAttempts < PLACE_ATTEMPTS) return TickResult.running(progress(player));
		String what = shortId(placeItem) + " at " + cell(placeAt) + (placed || placeRefusal == null ? "" : " (" + placeRefusal + ")");
		if (sealing) {
			sealing = false;
			if (!placed) return stop(player, "WATER_AHEAD", afterPlace + "; sealing it with " + what + " failed");
			seals++;
			sealsThisStep++;
			// Back to the step's cells from the top: a sealed cell of the cut is mined again, the rest are open.
			cellIndex = 0;
			mining = null;
			phase = Phase.MINE;
			phaseTicks = 0;
			return TickResult.running(progress(player));
		}
		if (afterPlaceCode != null) return stop(player, afterPlaceCode, afterPlace + (placed ? "; plugged it with " + what : "; plugging it with " + what + " failed"));
		if (!placed) return stop(player, "NO_FLOOR", "Could not fill the hole under the next step with " + what);
		if (!crossNext) notes.add("filled a hole with " + what);
		phase = Phase.MOVE;
		phaseTicks = 0;
		return TickResult.running(progress(player));
	}

	// ---- stepping into the opening ----

	private TickResult move(ServerPlayer player) {
		Vec3 center = Vec3.atBottomCenterOf(next);
		Vec3 body = player.position();
		double along = (center.x - body.x) * heading.getStepX() + (center.z - body.z) * heading.getStepZ();
		BlockPos at = player.blockPosition();
		// The step's column at or below its cell: a drop through an open floor lands lower.
		boolean inCell = at.getX() == next.getX() && at.getZ() == next.getZ() && at.getY() <= next.getY();
		if (inCell && player.onGround() && player.getDeltaMovement().horizontalDistance() < 0.1D) {
			steps++;
			lastStepHeading = heading;
			if (detourSteps > 0) detourSteps--;
			if (crossNext) {
				crossNext = false;
				crossSteps++;
				crossed++;
			} else {
				crossSteps = 0;
			}
			phase = Phase.START;
			phaseTicks = 0;
			hold(player, 0.0F, false, false, player.getYRot(), player.getXRot());
			return TickResult.running(progress(player));
		}
		if (++phaseTicks > MOVE_TICKS) return stop(player, "DIG_STUCK", "Could not step into " + cell(next) + " from " + cell(player.blockPosition()));
		float yaw = (float) Math.toDegrees(Math.atan2(-(center.x - body.x), center.z - body.z));
		if (Math.hypot(center.x - body.x, center.z - body.z) < 0.2D) yaw = heading.toYRot();
		boolean down = active.down();
		float pitch = down ? 35.0F : active == Pattern.STAIRS_UP ? -10.0F : 15.0F;
		// Down a step the body lets go of forward before the edge and coasts over it slowly (a nudge if it stops short), so
		// it never carries speed past the landing; in the landing column it crouches, which vanilla keeps from any edge.
		double speed = player.getDeltaMovement().horizontalDistance();
		float forward = inCell ? 0.0F : down ? (along > 0.6D || player.onGround() && speed < 0.03D ? 1.0F : 0.0F) : along > 0.3D ? 1.0F : 0.0F;
		boolean jump = active == Pattern.STAIRS_UP && player.onGround() && player.blockPosition().getY() < next.getY() && along < 1.3D;
		applyInput(player, forward, jump, crossNext || inCell && player.onGround(), false, AgentInputStates.turnYaw(player.getYRot(), yaw),
				AgentInputStates.turnPitch(player.getXRot(), pitch), player.getInventory().getSelectedSlot());
		return TickResult.running(progress(player));
	}

	private TickResult startRecenter(ServerPlayer player, BlockPos to, Phase then) {
		recenterTo = to;
		afterRecenter = then;
		phase = Phase.RECENTER;
		phaseTicks = 0;
		return recenter(player);
	}

	/** Crouched steps back to the centre of a column with a floor (sneaking never walks off an edge). */
	private TickResult recenter(ServerPlayer player) {
		Vec3 center = Vec3.atBottomCenterOf(recenterTo);
		double dx = center.x - player.getX(), dz = center.z - player.getZ();
		if (Math.hypot(dx, dz) < 0.2D && player.onGround()) {
			phase = afterRecenter;
			phaseTicks = 0;
			hold(player, 0.0F, false, false, player.getYRot(), player.getXRot());
			return TickResult.running(progress(player));
		}
		if (++phaseTicks > MOVE_TICKS) {
			if (pendingCode != null) return finishStop(player);
			return stop(player, "DIG_STUCK", "Could not step back onto " + cell(recenterTo));
		}
		float yaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
		float turned = AgentInputStates.turnYaw(player.getYRot(), yaw);
		boolean facing = Math.abs(AgentInputStates.shortestAngleDelta(turned, yaw)) < 20.0F;
		applyInput(player, facing ? 1.0F : 0.0F, false, true, false, turned, AgentInputStates.turnPitch(player.getXRot(), 30.0F),
				player.getInventory().getSelectedSlot());
		return TickResult.running(progress(player));
	}

	/** The column beside the body's own whose floor holds it, nearest the body's centre, or null. */
	private static BlockPos supportColumn(ServerPlayer player) {
		AABB box = player.getBoundingBox();
		int y = player.blockPosition().getY();
		BlockPos best = null;
		double bestDistance = Double.MAX_VALUE;
		for (BlockPos at : BlockPos.betweenClosed(Mth.floor(box.minX + 1.0E-3D), y, Mth.floor(box.minZ + 1.0E-3D),
				Mth.floor(box.maxX - 1.0E-3D), y, Mth.floor(box.maxZ - 1.0E-3D))) {
			BlockPos below = at.below();
			if (!standable(player.level(), below, player.level().getBlockState(below))) continue;
			double distance = Vec3.atBottomCenterOf(at).distanceToSqr(player.position());
			if (distance < bestDistance) {
				bestDistance = distance;
				best = at.immutable();
			}
		}
		return best;
	}

	/** Whether {@code cell} is the only block under the body's footprint holding it up: breaking it would drop the body. */
	static boolean restsOnlyOn(ServerPlayer player, BlockPos cell) {
		AABB box = player.getBoundingBox();
		if (!player.onGround() || Math.abs(cell.getY() + 1 - box.minY) > 0.05D) return false;
		int y = cell.getY();
		boolean under = false;
		for (BlockPos at : BlockPos.betweenClosed(Mth.floor(box.minX + 1.0E-3D), y, Mth.floor(box.minZ + 1.0E-3D),
				Mth.floor(box.maxX - 1.0E-3D), y, Mth.floor(box.maxZ - 1.0E-3D))) {
			if (at.equals(cell)) under = true;
			else if (standable(player.level(), at, player.level().getBlockState(at))) return false;
		}
		return under;
	}

	/** A loose block is falling at the head after the jump headroom opened: step back down the stairs out of its way. */
	private TickResult retreat(ServerPlayer player) {
		BlockPos back = feet.relative(heading.getOpposite()).below();
		if (player.blockPosition().equals(back) && player.onGround() || ++phaseTicks > 30)
			return stop(player, "FALLING_BLOCKS", "A loose block fell from above " + cell(feet.above(2)) + "; stepped back to " + cell(player.blockPosition()));
		hold(player, -1.0F, false, false, heading.toYRot(), 0.0F);
		return TickResult.running(progress(player));
	}

	// ---- the shaft: straight down through the block underfoot ----

	/**
	 * The shaft's floor is broken and the body drops into the hole. Its own one-block step needs nothing; a longer fall
	 * (the floor opened onto a cave) brings the water bucket out as a player clutches. On the ground it looks at what
	 * the drop revealed before the next break (the view is already down the shaft).
	 */
	private TickResult shaftFall(ServerPlayer player) {
		phaseTicks++;
		if (clutchWater != null) return scoop(player);
		float down = AgentInputStates.turnPitch(player.getXRot(), 90.0F);
		boolean dropped = player.blockPosition().getY() < shaftFrom.getY();
		if (!player.onGround() && !player.isInWater()) {
			landedTicks = 0;
			if (phaseTicks > 200) return stop(player, "DIG_STUCK", "Still falling 10 s after breaking the floor at " + cell(shaftFrom.below()));
			if (shaftFrom.getY() - player.getY() > SHAFT_CLUTCH_FALL) return clutch(player, down);
			hold(player, 0.0F, false, false, player.getYRot(), down);
			return TickResult.running(progress(player));
		}
		hold(player, 0.0F, false, false, player.getYRot(), down);
		if (!dropped) {
			// The broken floor has not let the body go yet (the tick it broke): wait for the drop, then plan again.
			if (phaseTicks > 20) {
				phase = Phase.START;
				phaseTicks = 0;
			}
			return TickResult.running(progress(player));
		}
		if (++landedTicks < 2) return TickResult.running(progress(player));
		return shaftLanded(player);
	}

	/** On the ground after a shaft drop: the walls passed and stood in, as the eye sees them now. */
	private TickResult shaftLanded(ServerPlayer player) {
		BlockPos at = player.blockPosition();
		int drop = shaftFrom.getY() - at.getY();
		steps++;
		deepestDrop = Math.max(deepestDrop, drop);
		ServerLevel level = player.level();
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		int newlyOpen = 0;
		BlockPos firstOpen = null;
		for (int y = at.getY(); y <= shaftFrom.getY(); y++) {
			BlockPos column = new BlockPos(at.getX(), y, at.getZ());
			cut.add(column);
			for (Direction side : Direction.Plane.HORIZONTAL) {
				BlockPos wall = column.relative(side);
				if (cut.contains(wall) || !seen.seesNow(wall.getX(), wall.getY(), wall.getZ())) continue;
				BlockState known = seen.known(wall.getX(), wall.getY(), wall.getZ());
				if (known == null) continue;
				if (known.getFluidState().is(FluidTags.LAVA)) return lavaInWall(player, wall, column);
				if (known.getFluidState().is(FluidTags.WATER) && !trickleAtBody(player, wall, known)) return fluidStop(player, column, wall, false);
				if (isOre(known)) noteOre(blockId(known), wall);
				// The cell the body stood in before the break was looked at then; only the newly opened ones count.
				if (y < shaftFrom.getY() && passable(level, wall, known) && !level.canSeeSky(wall)) {
					newlyOpen++;
					if (firstOpen == null) firstOpen = wall;
				}
			}
		}
		// A drop of 3 or less does no fall damage: like the stairs, the shaft digs on through a small cave and lists it.
		if (drop > 1 && (drop > SAFE_FALL || !throughCaves)) return stop(player, "CAVE_OPENING", "The floor at " + cell(shaftFrom.below())
				+ " opened onto a cave: dropped " + drop + " blocks to " + cell(at) + (clutchUsed() ? " (caught with water)" : "")
				+ (throughCaves ? "" : " (throughCaves:false)"));
		if (drop > 1 && drops.size() < 4) drops.add(drop + " blocks into a cave at " + cell(at));
		if (newlyOpen >= 2 && !throughCaves) return stop(player, "CAVE_OPENING", "The shaft opened into a cave at " + cell(firstOpen)
				+ " (" + newlyOpen + " open cells beside it); not going on (throughCaves:false)");
		if (newlyOpen >= 2 && caves.size() < 4) caves.add(cell(firstOpen) + " (y" + firstOpen.getY() + ")");
		phase = Phase.START;
		phaseTicks = 0;
		return TickResult.running(progress(player));
	}

	private boolean clutchUsed() {
		return notes.stream().anyMatch(note -> note.startsWith("caught a"));
	}

	/** Lava in the shaft's wall flows into it: plugged with a carried block as a player would, then handed back. */
	private TickResult lavaInWall(ServerPlayer player, BlockPos lava, BlockPos beside) {
		String what = "Lava at " + cell(lava) + " in the wall of the shaft at " + cell(beside);
		String filler = filler(player);
		Direction face = filler == null ? null : supportFace(player.level(), lava);
		if (face != null && lava.distToCenterSqr(player.getEyePosition()) <= 16.0D) return startPlace(player, lava, face, filler, "LAVA_AHEAD", what);
		return stop(player, "LAVA_AHEAD", what + "; not going further");
	}

	/**
	 * A fall past the shaft's own step, as a player clutches it: the water bucket selected, the view down, and one
	 * click on the ground the crosshair meets once it is in reach and the landing would hurt.
	 */
	private TickResult clutch(ServerPlayer player, float pitch) {
		int slot = bucketSlot(player);
		if (slot < 0) {
			hold(player, 0.0F, false, false, player.getYRot(), pitch);
			return TickResult.running(progress(player));
		}
		InteractionHand hand = slot == OFFHAND ? InteractionHand.OFF_HAND : InteractionHand.MAIN_HAND;
		int select = slot == OFFHAND ? player.getInventory().getSelectedSlot() : slot;
		applyInput(player, 0.0F, false, false, false, player.getYRot(), pitch, select);
		if (hand == InteractionHand.MAIN_HAND && player.getInventory().getSelectedSlot() != slot) return TickResult.running(progress(player));
		ServerLevel level = player.level();
		Vec3 eye = player.getEyePosition();
		BlockHitResult crosshair = level.clip(new ClipContext(eye, eye.add(player.getLookAngle().scale(player.blockInteractionRange())),
				ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
		if (crosshair.getType() != HitResult.Type.BLOCK || crosshair.getDirection() != Direction.UP) return TickResult.running(progress(player));
		BlockPos above = crosshair.getBlockPos().above();
		if (!level.getBlockState(above).canBeReplaced()) return TickResult.running(progress(player));
		double landing = player.fallDistance + (player.getY() - above.getY());
		if (landing <= SAFE_FALL) return TickResult.running(progress(player));
		ItemStack held = player.getItemInHand(hand);
		InteractionResult result = player.gameMode.useItemOn(player, level, held, hand, crosshair);
		if (!result.consumesAction() && !(result instanceof InteractionResult.Fail)) result = player.gameMode.useItem(player, level, held, hand);
		if (result.consumesAction() && level.getFluidState(above).isSourceOfType(Fluids.WATER)) {
			ArmSwing.use(player, hand);
			clutchWater = above;
			clutchHand = hand;
			clutchSlot = select;
			landedTicks = 0;
			if (notes.size() < 8) notes.add("caught a " + fmt(landing) + "-block fall with water at " + cell(above));
		}
		return TickResult.running(progress(player));
	}

	/** After the clutch: once landed, the emptied bucket scoops the source back (left, its flow carries the body off). */
	private TickResult scoop(ServerPlayer player) {
		ServerLevel level = player.level();
		if (!level.getFluidState(clutchWater).isSourceOfType(Fluids.WATER) || ++landedTicks > 40) {
			if (landedTicks > 40 && notes.size() < 8) notes.add("left the water at " + cell(clutchWater));
			clutchWater = null;
			landedTicks = 0;
			return TickResult.running(progress(player));
		}
		Vec3 centre = Vec3.atCenterOf(clutchWater);
		AgentInputState look = AgentInputStates.lookingAt(player, centre, 0.0F, 0.0F, false, false, false, false, false, InteractionHand.MAIN_HAND);
		applyInput(player, 0.0F, false, false, false, AgentInputStates.turnYaw(player.getYRot(), look.yaw()),
				AgentInputStates.turnPitch(player.getXRot(), look.pitch()), clutchSlot);
		if (!player.onGround() && !player.isInWater()) return TickResult.running(progress(player));
		ItemStack held = player.getItemInHand(clutchHand);
		if (!held.is(Items.BUCKET)) return TickResult.running(progress(player));
		Vec3 eye = player.getEyePosition();
		BlockHitResult sight = level.clip(new ClipContext(eye, eye.add(player.getLookAngle().scale(player.blockInteractionRange())),
				ClipContext.Block.OUTLINE, ClipContext.Fluid.SOURCE_ONLY, player));
		if (sight.getType() != HitResult.Type.BLOCK || !sight.getBlockPos().equals(clutchWater)) return TickResult.running(progress(player));
		if (player.gameMode.useItem(player, level, held, clutchHand).consumesAction() && player.getItemInHand(clutchHand).is(Items.WATER_BUCKET)) {
			ArmSwing.use(player, clutchHand);
			clutchWater = null;
			landedTicks = 0;
		}
		return TickResult.running(progress(player));
	}

	/**
	 * The broken floor dropped the body into lava: the water bucket poured down at once, as a player does (water on a
	 * lava source makes obsidian, on flowing lava cobblestone, and puts the body out), then the decision is handed back.
	 * Null when the body is not in lava (or a shaft call already poured).
	 */
	private TickResult douse(ServerPlayer player) {
		if (pattern != Pattern.SHAFT || doused || !player.isInLava()) return null;
		int slot = bucketSlot(player);
		InteractionHand hand = slot == OFFHAND ? InteractionHand.OFF_HAND : InteractionHand.MAIN_HAND;
		if (slot >= 0) applyInput(player, 0.0F, false, false, false, player.getYRot(), AgentInputStates.turnPitch(player.getXRot(), 90.0F),
				slot == OFFHAND ? player.getInventory().getSelectedSlot() : slot);
		boolean ready = slot >= 0 && (hand == InteractionHand.OFF_HAND || player.getInventory().getSelectedSlot() == slot) && player.getXRot() >= 60.0F;
		boolean poured = ready && player.gameMode.useItem(player, player.level(), player.getItemInHand(hand), hand).consumesAction();
		if (poured) ArmSwing.use(player, hand);
		if (!poured && slot >= 0 && ++douseTicks <= 20) return TickResult.running(progress(player));
		doused = true;
		return stop(player, "IN_LAVA", "Dropped into lava at " + cell(player.blockPosition()) + (poured ? "; poured the water bucket down (water on lava"
				+ " sources makes obsidian, on flowing lava cobblestone)" : slot < 0 ? " with no water bucket left to pour" : "; the water bucket could not be poured")
				+ "; health " + fmt(player.getHealth()) + ". " + HazardExits.stopMessage(player, true));
	}

	/** The hotbar slot holding a water bucket (the selected one first), {@link #OFFHAND}, or -1. */
	static int bucketSlot(ServerPlayer player) {
		if (WATER_BUCKET.equals(itemId(player.getOffhandItem()))) return OFFHAND;
		int selected = player.getInventory().getSelectedSlot();
		if (WATER_BUCKET.equals(itemId(player.getInventory().getItem(selected)))) return selected;
		for (int slot = 0; slot < 9; slot++) if (WATER_BUCKET.equals(itemId(player.getInventory().getItem(slot)))) return slot;
		return -1;
	}

	// ---- a look round a cave before handing it back ----

	private TickResult startCaveLook(ServerPlayer player, String code, String why) {
		caveLooked = true;
		lookCode = code;
		lookWhy = why;
		lookTurned = 0.0F;
		lookLastYaw = player.getYRot();
		phase = Phase.CAVE_LOOK;
		phaseTicks = 0;
		return TickResult.running(progress(player));
	}

	/**
	 * A cave met is a way down the model may take instead of digging: one turn of the head round it, looking down into
	 * it, noting the lowest floor the eye lands on and any lava (lava glows; it shows across a dark cave).
	 */
	private TickResult caveLook(ServerPlayer player) {
		phaseTicks++;
		float yaw = player.getYRot();
		lookTurned += Math.abs(AgentInputStates.shortestAngleDelta(lookLastYaw, yaw));
		lookLastYaw = yaw;
		// Crouched while it looks: sneaking keeps a body near the cave's edge from sliding off it as the head turns.
		applyInput(player, 0.0F, false, true, false, AgentInputStates.turnYaw(yaw, yaw + 30.0F), AgentInputStates.turnPitch(player.getXRot(), 35.0F),
				player.getInventory().getSelectedSlot());
		scanCave(player);
		if (lookTurned < 360.0F && phaseTicks < CAVE_LOOK_TICKS) return TickResult.running(progress(player));
		releaseInput();
		return TickResult.failed(lookCode, summary(player, "Stopped: " + lookWhy + caveRoute(player)), progress(player));
	}

	/** On the ground with the block under its own column holding it: not leaning out over an edge. */
	private static boolean standsOnOwnBlock(ServerPlayer player) {
		BlockPos below = player.blockPosition().below();
		return player.onGround() && standable(player.level(), below, player.level().getBlockState(below));
	}

	/** Sight lines across the current view: lava hit, and the open standing cells on the block tops they land on. */
	private void scanCave(ServerPlayer player) {
		ServerLevel level = player.level();
		Vec3 eye = player.getEyePosition();
		for (int yawStep = -3; yawStep <= 3; yawStep++) {
			// From a little above level (lava across the cave) to steeply down (its floor below).
			for (int pitchStep = -4; pitchStep <= 3; pitchStep++) {
				Vec3 direction = Vec3.directionFromRotation(Mth.clamp(player.getXRot() + pitchStep * 10.0F, -90.0F, 90.0F), player.getYRot() + yawStep * 10.0F);
				BlockHitResult hit = level.clip(new ClipContext(eye, eye.add(direction.scale(CAVE_SIGHT)), ClipContext.Block.VISUAL, ClipContext.Fluid.ANY, player));
				if (hit.getType() != HitResult.Type.BLOCK) continue;
				BlockPos at = hit.getBlockPos();
				BlockState state = level.getBlockState(at);
				if (state.getFluidState().is(FluidTags.LAVA)) {
					if (caveLava == null || at.distToCenterSqr(eye) < caveLava.distToCenterSqr(eye)) caveLava = at.immutable();
					continue;
				}
				if (hit.getDirection() != Direction.UP || !state.getFluidState().isEmpty()) continue;
				BlockPos top = at.above();
				if (!passable(level, top, level.getBlockState(top)) || !passable(level, top.above(), level.getBlockState(top.above()))) continue;
				if (caveFloor == null || top.getY() < caveFloor.getY() || top.getY() == caveFloor.getY() && top.distToCenterSqr(eye) < caveFloor.distToCenterSqr(eye))
					caveFloor = top.immutable();
			}
		}
		if (caveLava != null) noteLava(player, caveLava, System.currentTimeMillis() - startedAt);
	}

	private void noteLava(ServerPlayer player, BlockPos lava, long ms) {
		double distance = Math.sqrt(lava.distToCenterSqr(player.getEyePosition()));
		if (lavaFirst != null || distance > LAVA_NEAR) return;
		lavaFirst = lava.immutable();
		lavaFirstDistance = distance;
		lavaFirstMs = ms;
	}

	/** What the look round showed of the way down, and how to take it. */
	private String caveRoute(ServerPlayer player) {
		BlockPos at = player.blockPosition();
		StringBuilder text = new StringBuilder("; looked round the cave: ");
		if (caveLava != null) text.append("lava seen at ").append(cell(caveLava)).append(", ")
				.append(fmt(Math.sqrt(caveLava.distToCenterSqr(player.getEyePosition())))).append(" blocks away (dy").append(signed(caveLava.getY() - at.getY())).append(')');
		else text.append("no lava in sight");
		if (caveFloor != null && caveFloor.getY() < at.getY()) text.append("; lowest floor seen ").append(cell(caveFloor)).append(" (")
				.append(fmt(Math.hypot(caveFloor.getX() - at.getX(), caveFloor.getZ() - at.getZ()))).append(" blocks across, dy").append(signed(caveFloor.getY() - at.getY())).append(')');
		else text.append("; no floor in sight below this one");
		if (caveLava != null || caveFloor != null && caveFloor.getY() < at.getY())
			text.append("; travel_to with that x, y and z walks down the cave (drops of up to 3 blocks; stopWhenSeen minecraft:lava stops at the first lava in view)");
		return text.toString();
	}

	private static String signed(int value) {
		return value > 0 ? "+" + value : Integer.toString(value);
	}

	// ---- checks ----

	private TickResult fluidStop(ServerPlayer player, BlockPos opening, BlockPos fluid, boolean lava) {
		String what = (lava ? "Lava" : "Water") + " at " + cell(fluid) + (fluid.equals(opening) ? " fills the cut" : " beside the opened cell " + cell(opening));
		String code = lava ? "LAVA_AHEAD" : "WATER_AHEAD";
		if (!lava && phase != Phase.PLACE) {
			TickResult sealed = sealWater(player, fluid, what);
			if (sealed != null) return sealed;
		}
		// An opening the body made beside lava is plugged as a player would, before it pours toward the body.
		String filler = lava && !isBody(player, opening) ? filler(player) : null;
		if (filler != null && phase != Phase.PLACE && opening.distToCenterSqr(player.getEyePosition()) <= 16.0D) {
			Direction face = supportFace(player.level(), opening);
			if (face != null) return startPlace(player, opening, face, filler, code, what);
		}
		return stop(player, code, what + "; not going further");
	}

	/**
	 * Water trickling into the cut is sealed as a player does, by placing a carried block into it: into the water cell
	 * that feeds a flooded cell of the cut when the eye sees it, else into the water itself. More water than a few blocks
	 * stop (a lake, an aquifer, the sea) is the model's call.
	 */
	private TickResult sealWater(ServerPlayer player, BlockPos fluid, String what) {
		if (!throughCaves) return null;
		if (sealsThisStep >= MAX_SEALS_PER_STEP || seals >= MAX_SEALS)
			return stop(player, "WATER_AHEAD", what + "; water keeps coming after " + seals + " blocks placed into it (a lake or aquifer); not going further");
		BlockPos target = fluid;
		// Water standing in the cut or around the body is fed from beside it: seal the feeder the eye sees.
		if (cells.contains(fluid) || cut.contains(fluid) || isBody(player, fluid)) {
			SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
			for (Direction side : Direction.values()) {
				BlockPos feeder = fluid.relative(side);
				if (cells.contains(feeder) || cut.contains(feeder) || isBody(player, feeder) || !seen.seesNow(feeder.getX(), feeder.getY(), feeder.getZ())) continue;
				BlockState known = seen.known(feeder.getX(), feeder.getY(), feeder.getZ());
				if (known != null && known.getFluidState().is(FluidTags.WATER) && feeder.distToCenterSqr(player.getEyePosition()) <= 20.0D) {
					target = feeder;
					break;
				}
			}
		}
		if (isBody(player, target) || target.distToCenterSqr(player.getEyePosition()) > 20.0D) return null;
		// Water on three or more sides of the cell is a body of water (an aquifer, a lake), not a trickle: the model's call.
		SeenTerrain.Reader<BlockState> around = SeenTerrain.of(player);
		int wet = 0;
		for (Direction side : Direction.values()) {
			BlockPos beside = target.relative(side);
			BlockState near = around.known(beside.getX(), beside.getY(), beside.getZ());
			if (near != null && near.getFluidState().is(FluidTags.WATER) && !cut.contains(beside) && !cells.contains(beside)) wet++;
		}
		if (wet >= 3) return stop(player, "WATER_AHEAD", what + "; water on " + wet + " sides of it: a body of water (an aquifer or lake), not a trickle; not going further");
		String filler = filler(player);
		if (filler == null) return null;
		Direction face = supportFace(player.level(), target);
		if (face == null) return null;
		sealing = true;
		return startPlace(player, target, face, filler, null, what);
	}

	/**
	 * Flowing water at the body's feet with the head in air: a player keeps digging in a trickle; its feeder is what gets
	 * sealed. Water at the head is not a trickle.
	 */
	private static boolean trickleAtBody(ServerPlayer player, BlockPos at, BlockState state) {
		return isBody(player, at) && at.getY() < Mth.floor(player.getEyeY()) && !player.isEyeInFluid(FluidTags.WATER)
				&& state.getFluidState().is(FluidTags.WATER) && !state.getFluidState().isSource();
	}

	private Direction supportFace(ServerLevel level, BlockPos at) {
		for (Direction face : new Direction[] { Direction.UP, Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST, Direction.DOWN }) {
			BlockPos support = at.relative(face.getOpposite());
			if (sturdy(level, support, level.getBlockState(support))) return face;
		}
		return null;
	}

	private BlockPos seenFluidBeside(ServerPlayer player, BlockPos cell, boolean lava) {
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		for (Direction side : Direction.values()) {
			BlockPos neighbour = cell.relative(side);
			if (!seen.eyeSeesNow(neighbour.getX(), neighbour.getY(), neighbour.getZ())) continue;
			BlockState known = seen.known(neighbour.getX(), neighbour.getY(), neighbour.getZ());
			if (known != null && !lava && trickleAtBody(player, neighbour, known)) continue;
			if (known != null && known.getFluidState().is(lava ? FluidTags.LAVA : FluidTags.WATER)) return neighbour;
		}
		return null;
	}

	private TickResult inventoryRoom(ServerPlayer player, BlockPos cell, BlockState state) {
		if (player.isCreative()) return null;
		int free = player.getInventory().getFreeSlot();
		if (free >= 0) return null;
		ItemStack tool = player.getMainHandItem();
		for (ItemStack drop : Block.getDrops(state, player.level(), cell, null, player, tool)) {
			if (!InventoryRoom.canTake(player, drop)) return stop(player, "INVENTORY_FULL", "Inventory is full; "
					+ itemId(drop) + " from " + blockId(state) + " at " + cell(cell) + " would stay on the ground");
		}
		return null;
	}

	/**
	 * The hotbar slot to mine with: the fastest tool that is not about to break (and harvests the block when it needs a
	 * tool). -1 keeps the hand; -2 no hotbar item can harvest it; -3 the only fitting tools are worn out.
	 */
	static int toolSlot(ServerPlayer player, BlockState state) {
		int best = -1;
		float bestSpeed = 1.0F;
		boolean worn = false;
		for (int slot = 0; slot < 9; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (stack.isEmpty()) continue;
			float speed = stack.getDestroySpeed(state);
			boolean harvests = !state.requiresCorrectToolForDrops() || stack.isCorrectToolForDrops(state);
			if (!harvests || speed <= 1.0F) continue;
			if (stack.isDamageableItem() && stack.getMaxDamage() - stack.getDamageValue() <= WORN_USES) {
				worn = true;
				continue;
			}
			if (speed > bestSpeed) {
				bestSpeed = speed;
				best = slot;
			}
		}
		if (best >= 0) return best;
		// Snow and the like break by hand in a moment with no drop: a player digging through does not stop for a shovel.
		if (state.requiresCorrectToolForDrops() && state.getBlock().defaultDestroyTime() > HAND_BREAKS) return worn ? -3 : -2;
		return -1;
	}

	private static String toolHint(ServerPlayer player, BlockState state) {
		for (int slot = 9; slot < 36; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (!stack.isEmpty() && stack.isCorrectToolForDrops(state) && (!stack.isDamageableItem() || stack.getMaxDamage() - stack.getDamageValue() > WORN_USES))
				return "; " + itemId(stack) + " is in inventory slot " + slot + " (move it to the hotbar)";
		}
		return "";
	}

	private static String filler(ServerPlayer player) {
		for (String id : FILLERS) {
			for (int slot = 0; slot < 36; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (!stack.isEmpty() && stack.getItem() instanceof BlockItem && itemId(stack).equals(id)) return id;
			}
		}
		return null;
	}

	static boolean passable(ServerLevel level, BlockPos at, BlockState state) {
		return state.getCollisionShape(level, at).isEmpty() && state.getFluidState().isEmpty() && !state.isSolidRender();
	}

	/** Nothing to break: air, or a cell with no collision, outline or fluid. A plant has an outline the crosshair meets. */
	static boolean open(ServerLevel level, BlockPos at, BlockState state) {
		return state.isAir() || state.getCollisionShape(level, at).isEmpty() && state.getShape(level, at).isEmpty() && state.getFluidState().isEmpty();
	}

	static boolean standable(ServerLevel level, BlockPos at, BlockState state) {
		return !state.getCollisionShape(level, at).isEmpty() && state.getFluidState().isEmpty();
	}

	static boolean sturdy(ServerLevel level, BlockPos at, BlockState state) {
		return state.getFluidState().isEmpty() && state.isFaceSturdy(level, at, Direction.UP);
	}

	private static boolean isBody(ServerPlayer player, BlockPos at) {
		return player.getBoundingBox().intersects(new AABB(at));
	}

	static boolean isOre(BlockState state) {
		String id = blockId(state);
		return id.endsWith("_ore") || id.equals("minecraft:ancient_debris");
	}

	private void noteOre(String id, BlockPos at) {
		if (oresSeen.containsKey(id + "@" + at.asLong())) return;
		oresSeen.put(id + "@" + at.asLong(), at);
		oreCounts.merge(id, 1, Integer::sum);
	}

	// ---- input ----

	private void hold(ServerPlayer player, float forward, boolean jump, boolean attack, float yaw, float pitch) {
		hold(player, forward, jump, attack, yaw, pitch, player.getInventory().getSelectedSlot());
	}

	private void hold(ServerPlayer player, float forward, boolean jump, boolean attack, float yaw, float pitch, int slot) {
		applyInput(player, forward, jump, false, attack, yaw, pitch, slot);
	}

	private void applyInput(ServerPlayer player, float forward, boolean jump, boolean sneak, boolean attack, float yaw, float pitch, int slot) {
		if (lease == null) {
			input = AgentInputRuntime.controller(player);
			lease = input.acquire(AgentInputRuntime.requireAgentId(player), InputOwner.NAVIGATION, 100);
		}
		input.apply(lease, new AgentInputState(forward, 0.0F, jump, sneak, false, attack, false, yaw, pitch, slot, InteractionHand.MAIN_HAND));
	}

	private void releaseInput() {
		if (lease == null) return;
		try {
			input.release(lease);
		} catch (LeasedServerInputController.StaleInputLeaseException ignored) {
			// A lifecycle clear may already have invalidated every lease.
		}
		lease = null;
		input = null;
	}

	// ---- results ----

	private TickResult done(ServerPlayer player) {
		releaseInput();
		String goal = pattern == Pattern.TUNNEL ? "Reached the tunnel goal" : "Reached y" + player.blockPosition().getY();
		return TickResult.succeeded("DIG_GOAL_REACHED", summary(player, goal));
	}

	private TickResult stop(ServerPlayer player, String code, String why) {
		// Let go of a crouch at an edge (leaning out to look or to place) and the body slides off it: step back first.
		if (pendingCode == null && lease != null && player.onGround() && player.isShiftKeyDown()) {
			BlockPos at = player.blockPosition();
			BlockPos support = standable(player.level(), at.below(), player.level().getBlockState(at.below())) ? at : supportColumn(player);
			if (support != null) {
				pendingCode = code;
				pendingWhy = why;
				startRecenter(player, support, Phase.START);
				return TickResult.running(progress(player));
			}
		}
		if ("CAVE_OPENING".equals(code) && !caveLooked && standsOnOwnBlock(player)) return startCaveLook(player, code, why);
		releaseInput();
		return TickResult.failed(code, summary(player, "Stopped: " + why), progress(player));
	}

	private TickResult finishStop(ServerPlayer player) {
		String code = pendingCode, why = pendingWhy;
		pendingCode = null;
		if ("CAVE_OPENING".equals(code) && !caveLooked && standsOnOwnBlock(player)) return startCaveLook(player, code, why);
		hold(player, 0.0F, false, false, player.getYRot(), player.getXRot());
		releaseInput();
		return TickResult.failed(code, summary(player, "Stopped: " + why), progress(player));
	}

	private String summary(ServerPlayer player, String headline) {
		BlockPos at = player.blockPosition();
		long seconds = Math.max(1L, (System.currentTimeMillis() - startedAt) / 1000L);
		StringBuilder text = new StringBuilder(headline).append(". At ").append(cell(at)).append(", ").append(pattern.wireName())
				.append(shaftEndY != null ? " to y" + shaftEndY + " then steep_down" : "")
				.append(" heading ").append(heading == null ? "none" : heading.getName()).append("; ").append(blocksMined).append(" blocks mined in ")
				.append(steps).append(" steps over ").append(seconds).append(" s (y").append(startY).append(" to y").append(at.getY()).append(')');
		if (!minedCounts.isEmpty()) text.append("; mined ").append(counts(minedCounts));
		if (!oreCounts.isEmpty()) text.append("; ores seen ").append(counts(oreCounts)).append(" (first at ").append(firstOres()).append(')');
		if (lastTool != null) {
			ItemStack held = player.getMainHandItem();
			text.append("; tool ").append(shortId(lastTool));
			if (itemId(held).equals(lastTool) && held.isDamageableItem()) text.append(' ').append(held.getMaxDamage() - held.getDamageValue()).append(" uses left");
		}
		if (!caves.isEmpty()) text.append("; dug past caves at ").append(String.join(", ", caves));
		if (!drops.isEmpty()) text.append("; dropped ").append(String.join(", ", drops));
		if (crossed > 0) text.append("; ").append(crossed).append(" level steps across cave tops");
		if (seals > 0) text.append("; sealed water with ").append(seals).append(seals == 1 ? " block" : " blocks");
		if (!notes.isEmpty()) text.append("; ").append(String.join("; ", notes));
		if (lavaFirst != null) text.append("; lava first seen at ").append(cell(lavaFirst)).append(", ").append(fmt(lavaFirstDistance))
				.append(" blocks away, ").append(Math.max(1L, lavaFirstMs / 1000L)).append(" s into the dig");
		return text.toString();
	}

	private String firstOres() {
		List<String> out = new ArrayList<>();
		Set<String> named = new HashSet<>();
		for (Map.Entry<String, BlockPos> entry : oresSeen.entrySet()) {
			String id = entry.getKey().substring(0, entry.getKey().indexOf('@'));
			if (named.add(id) && out.size() < 4) out.add(shortId(id) + " " + cell(entry.getValue()));
		}
		return String.join(", ", out);
	}

	private static String counts(Map<String, Integer> counts) {
		List<String> parts = new ArrayList<>();
		counts.entrySet().stream().sorted((a, b) -> b.getValue() - a.getValue()).limit(6)
				.forEach(entry -> parts.add(shortId(entry.getKey()) + " " + entry.getValue()));
		return String.join(", ", parts);
	}

	private double progress(ServerPlayer player) {
		int y = player.blockPosition().getY();
		double value = switch (pattern) {
			case STAIRS_DOWN, STEEP_DOWN, STAIRS_UP, SHAFT -> startY == targetY ? 1.0D : (double) Math.abs(y - startY) / Math.abs(targetY - startY);
			case TUNNEL -> maxBlocks <= 0 ? 0.0D : (double) blocksMined / maxBlocks;
		};
		return Math.max(0.0D, Math.min(0.99D, value));
	}

	public Pattern pattern() {
		return pattern;
	}

	private static String blockId(BlockState state) {
		return BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
	}

	private static String itemId(ItemStack stack) {
		return BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
	}

	private static String shortId(BlockState state) {
		return shortId(blockId(state));
	}

	private static String shortId(String id) {
		return id.startsWith("minecraft:") ? id.substring("minecraft:".length()) : id;
	}

	private static String cell(BlockPos at) {
		return at.getX() + "," + at.getY() + "," + at.getZ();
	}

	private static String fmt(double value) {
		return String.format(Locale.ROOT, "%.1f", value);
	}
}
