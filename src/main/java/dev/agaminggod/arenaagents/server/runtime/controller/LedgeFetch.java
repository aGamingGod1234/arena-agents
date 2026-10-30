package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.server.perception.ObservationVisibility;
import dev.agaminggod.arenaagents.server.perception.ObservedDrops;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputState;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputStates;
import java.util.Locale;
import java.util.UUID;
import java.util.function.BiPredicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BlockTags;
import net.minecraft.util.Mth;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Count mode, between engagements: a drop of the counted item the body saw fall onto a ledge 1-3 blocks above its feet
 * (the platform round a blaze spawner, over the room's floor) lies out of sight from below, and the level-keeping rod
 * pickup never leaves the body's own floor. As a player does, the body goes up for it: it walks there over seen
 * terrain (the platform's stairs), and where no walk gets there it pillars up beside the ledge with a carried block
 * (look down, jump, place under the feet) and walks over from the top; it picks the drop up by walking into it (vanilla
 * collision pickup) and walks back down to the fighting spot. Only what the body saw is used: the drop's last seen
 * position and the terrain it has seen.
 */
final class LedgeFetch {
	static final int MAX_LEDGE = 3;
	/** How far (horizontal blocks) a drop may lie from the body for the trip. */
	static final double MAX_DISTANCE = 14.0D;
	/** How far from the drop's column a pillar may stand. */
	static final int BASE_RADIUS = 8;
	static final long BUDGET_MS = 30_000L;
	/** Other counted drops seen on the ledge this near where the trip's drop landed are picked up on the same trip. */
	static final double SWEEP = 6.0D;
	private enum Phase { BASE, PILLAR, CROSS, LOOK, BACK }
	/** Why the last {@link #plan} gave no trip (server thread only; for the fight's result text). */
	static String refusal;
	/** The last refusal is for now only (try the drop again later). */
	static boolean waiting;
	/** Walk endings that mean no seen way up: a pillar beside the ledge is tried then. */
	static final java.util.Set<String> NO_WAY = java.util.Set.of("NO_STANDABLE_PATH", "NO_SEEN_ROUTE", "NO_PATH", "REACHED_FRONTIER",
			"PATH_BLOCKED", "NO_PROGRESS", "DESTINATION_NEAR_UNVERIFIED", "MISSED_LANDING");
	/** Seen hostiles this near the landing hold the trip back. */
	static final double CROWD_RADIUS = 5.0D;
	/** Health lost on a trip that turns it back. */
	static final float TURN_BACK_LOSS = 6.0F;

	/** The witnessed drop this trip is for, or null for a kill whose drop the body did not see fall. */
	private final UUID drop;
	private final Item item;
	private final BlockPos landing;
	private final BlockPos base;
	private final int height;
	private final Vec3 back;
	private final BiPredicate<ServerPlayer, BlockPos> mayModify;
	private final long deadline;
	private final int heldAtStart;
	private float startHealth;
	private int heldLast;
	private UUID chasing;
	private final CombatInputLease input = new CombatInputLease();
	private Phase phase;
	private ServerNavigationController walk;
	private Vec3 walkGoal;
	private int levelFeet;
	private int stageTicks;
	private int placed;
	private boolean picked;
	private boolean climbed;
	private boolean crouched;
	private String failureCode;
	/** Walks re-aimed at the drop once it came into sight somewhere else than its estimated landing. */
	private int retargets;
	private int damagedRewalks;
	private boolean looked;
	private long lastApplyTick = Long.MIN_VALUE / 2;
	private long lookUntil;
	/** Where the drop was last seen, or where the kill died: what the body looks toward from the ledge. */
	private Vec3 estimateAt;
	private String note;

	private LedgeFetch(UUID drop, Item item, BlockPos landing, BlockPos base, int height, Vec3 back,
			BiPredicate<ServerPlayer, BlockPos> mayModify, int held, long now) {
		this.drop = drop;
		this.item = item;
		this.landing = landing;
		this.base = base;
		this.height = height;
		this.back = back;
		this.mayModify = mayModify;
		this.heldAtStart = held;
		this.heldLast = held;
		this.chasing = drop;
		this.deadline = now + BUDGET_MS;
		this.startHealth = Float.NaN;
		this.estimateAt = Vec3.atBottomCenterOf(landing);
		this.phase = Phase.CROSS;
	}

	/**
	 * A trip for the remembered drop when it landed (by the seen column under its last seen position) 1 to
	 * {@link #MAX_LEDGE} blocks above the feet within {@link #MAX_DISTANCE}; null when it did not.
	 */
	static LedgeFetch plan(ServerPlayer player, UUID drop, Item item, Vec3 back, BiPredicate<ServerPlayer, BlockPos> mayModify,
			int held, long now) {
		ObservedDrops.Drop seen = ObservedDrops.recall(player, drop);
		waiting = false;
		refusal = "last sight expired";
		if (seen == null) return null;
		return plan(player, drop, seen.position(), item, back, mayModify, held, now);
	}

	/**
	 * A trip to look for drops where kills the body saw died over a ledge (a player knows a blaze drops its rod where
	 * it dies and goes to look), with the same landing rule as a witnessed drop.
	 */
	static LedgeFetch plan(ServerPlayer player, UUID drop, Vec3 at, Item item, Vec3 back, BiPredicate<ServerPlayer, BlockPos> mayModify,
			int held, long now) {
		waiting = false;
		refusal = "too far";
		if (Math.hypot(at.x - player.getX(), at.z - player.getZ()) > MAX_DISTANCE) return null;
		int feet = Mth.floor(player.getY() + 1.0E-3D);
		var terrain = SeenTerrain.of(player);
		int x = Mth.floor(at.x), z = Mth.floor(at.z);
		int top = Integer.MIN_VALUE;
		for (int y = Mth.floor(at.y + 1.0E-3D); y >= feet; y--) {
			BlockState state = terrain.known(x, y, z);
			if (state == null) continue;
			if (!state.getFluidState().isEmpty() || state.is(BlockTags.FIRE)) return null;
			if (state.getCollisionShape(player.level(), new BlockPos(x, y, z)).isEmpty()) continue;
			// A fence or wall top is no ledge to stand on (vanilla: 1.5 high, no jump onto it).
			if (!state.isCollisionShapeFullBlock(player.level(), new BlockPos(x, y, z))) {
				refusal = "landed on a fence or wall top";
				return null;
			}
			top = y + 1;
			break;
		}
		if (top == Integer.MIN_VALUE) {
			// The drop's own column is unseen: walk to the seen edge of the ledge, where its top comes into view.
			BlockPos edge = edgeTop(player, terrain, at, feet);
			if (edge != null) { top = edge.getY(); x = edge.getX(); z = edge.getZ(); }
		}
		int height = top - feet;
		refusal = top == Integer.MIN_VALUE ? "no seen landing under " + Mth.floor(at.x) + "," + Mth.floor(at.y) + "," + Mth.floor(at.z) : "landing " + height + " up";
		if (top == Integer.MIN_VALUE || height < 1 || height > MAX_LEDGE) return null;
		BlockPos landing = new BlockPos(x, top, z);
		// Not into a crowd: while a seen hostile hovers near where the drop landed, the fight goes on from below first
		// (d41 floor fixture: a trip up the steps into three blazes cost 15 health in 7 s).
		for (net.minecraft.world.entity.Mob hostile : player.level().getEntitiesOfClass(net.minecraft.world.entity.Mob.class,
				new net.minecraft.world.phys.AABB(landing).inflate(CROWD_RADIUS, 4.0D, CROWD_RADIUS),
				e -> e.isAlive() && e instanceof net.minecraft.world.entity.monster.Enemy)) {
			if (!ObservationVisibility.canSeeEntity(player, hostile)) continue;
			refusal = "a hostile near the landing";
			waiting = true;
			return null;
		}
		BlockPos base = null;
		double best = Double.MAX_VALUE;
		for (int dx = -BASE_RADIUS; dx <= BASE_RADIUS; dx++) {
			for (int dz = -BASE_RADIUS; dz <= BASE_RADIUS; dz++) {
				BlockPos cell = new BlockPos(x + dx, feet, z + dz);
				if (!pillarable(player, terrain, cell, height) || !besideLedge(player, terrain, cell, top)) continue;
				double score = Math.hypot(dx, dz) * 2.0D + Math.hypot(cell.getX() + 0.5D - player.getX(), cell.getZ() + 0.5D - player.getZ()) * 0.5D;
				if (score < best) { best = score; base = cell; }
			}
		}
		// No pillar spot: the walk alone may still get there (stairs).
		LedgeFetch trip = new LedgeFetch(drop, item, landing, base, height, back, mayModify, held, now);
		trip.estimateAt = at;
		return trip;
	}

	/**
	 * The drop's own column is out of sight (the top of a platform seen from its foot): a drop last seen falling above
	 * a seen ledge edge between it and the body landed on that ledge, as a player watching it drop behind the edge
	 * knows. The top of the first seen solid block found stepping from the drop toward the body, no higher than where
	 * the drop was last seen: that column's standing cell on the ledge, or null.
	 */
	private static BlockPos edgeTop(ServerPlayer player, SeenTerrain.Reader<BlockState> terrain, Vec3 at, int feet) {
		double dx = player.getX() - at.x, dz = player.getZ() - at.z;
		double length = Math.hypot(dx, dz);
		if (length < 1.0E-3D) return null;
		for (double along = 0.5D; along <= Math.min(length, 8.0D); along += 0.5D) {
			int cx = Mth.floor(at.x + dx / length * along), cz = Mth.floor(at.z + dz / length * along);
			for (int y = Mth.floor(at.y + 1.0E-3D); y >= feet; y--) {
				BlockState state = terrain.known(cx, y, cz);
				if (state == null) continue;
				if (!state.getFluidState().isEmpty()) return null;
				if (state.getCollisionShape(player.level(), new BlockPos(cx, y, cz)).isEmpty()) continue;
				// A block standing on the ledge (the spawner) is not the ledge: look at the next column.
				if (y + 1 - feet >= 1 && y + 1 - feet <= MAX_LEDGE && state.isCollisionShapeFullBlock(player.level(), new BlockPos(cx, y, cz)))
					return new BlockPos(cx, y + 1, cz);
				break;
			}
		}
		return null;
	}

	/** A seen standing cell on the body's floor with nothing known solid up to a head's room over the pillar's top. */
	private static boolean pillarable(ServerPlayer player, SeenTerrain.Reader<BlockState> terrain, BlockPos cell, int height) {
		BlockState floor = terrain.known(cell.getX(), cell.getY() - 1, cell.getZ());
		if (floor == null || !floor.isCollisionShapeFullBlock(player.level(), cell.below()) || HazardExits.hotFloor(floor)) return false;
		for (int dy = 0; dy <= height + 1; dy++) {
			BlockState state = terrain.known(cell.getX(), cell.getY() + dy, cell.getZ());
			if (state == null) {
				if (dy <= 1) return false;
				continue;
			}
			if (!state.getCollisionShape(player.level(), cell.above(dy)).isEmpty() || !state.getFluidState().isEmpty() || state.is(BlockTags.FIRE)) return false;
		}
		return true;
	}

	/** A side neighbour at the pillar's top is ledge: seen solid with its top at the ledge's height. */
	private static boolean besideLedge(ServerPlayer player, SeenTerrain.Reader<BlockState> terrain, BlockPos cell, int top) {
		for (Direction direction : Direction.Plane.HORIZONTAL) {
			BlockPos side = new BlockPos(cell.getX() + direction.getStepX(), top - 1, cell.getZ() + direction.getStepZ());
			BlockState state = terrain.known(side.getX(), side.getY(), side.getZ());
			BlockState above = terrain.known(side.getX(), top, side.getZ());
			if (state != null && state.isCollisionShapeFullBlock(player.level(), side)
					&& (above == null || above.getCollisionShape(player.level(), side.above()).isEmpty())) return true;
		}
		return false;
	}

	/** Pillaring: a shot does not interrupt the climb. */
	boolean climbing() {
		return phase == Phase.PILLAR;
	}

	String describe() {
		return String.format(Locale.ROOT, "%s at %s, %d up%s", net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(item).toString(), landing.toShortString(), height,
				base == null ? " (walk only)" : " (walk, else pillar at " + base.getX() + "," + base.getZ() + ")");
	}

	LedgeFetch crouched(boolean crouched) {
		this.crouched = crouched;
		return this;
	}

	String failureCode() {
		return failureCode;
	}

	/** Null while the trip runs; what happened once it ended (picked or not, and back or not). */
	String tick(ServerPlayer player, long now) {
		if (!player.isAlive()) return finish(player, "the body died");
		if (Float.isNaN(startHealth)) startHealth = player.getHealth();
		if (phase != Phase.BACK && phase != Phase.PILLAR && player.getHealth() <= startHealth - TURN_BACK_LOSS) {
			note = String.format(Locale.ROOT, "turned back after losing %.0f health", startHealth - player.getHealth());
			toBack(player);
		}
		int held = ServerFightUntilController.count(player, item);
		if (held > heldLast) {
			heldLast = held;
			picked = true;
			chasing = null;
			// Another drop seen on the ledge is picked up on the same trip; else back down.
			if (phase == Phase.CROSS && dropPosition(player).equals(Vec3.atBottomCenterOf(landing))) toBack(player);
		}
		if (now > deadline) return finish(player, (picked ? "picked up " + (heldLast - heldAtStart) + "; " : "") + "the " + BUDGET_MS / 1000 + " s trip time ran out" + (note == null ? "" : " (" + note + ")"));
		switch (phase) {
			case BASE -> {
				ServerController.TickResult result = walkTo(player, Vec3.atBottomCenterOf(base), 0.25D, now, 10_000L, -1);
				if (result == null) return null;
				if (result.state() != ServerController.State.SUCCEEDED) return finish(player, "walk to the pillar spot " + base.toShortString() + " " + result.reasonCode());
				int slot = TravelBuilder.blockSlot(player);
				if (slot < 0 || slot >= 9) return finish(player, "no plain block on the hotbar to pillar with");
				player.getInventory().setSelectedSlot(slot);
				levelFeet = base.getY();
				stageTicks = 0;
				phase = Phase.PILLAR;
				return null;
			}
			case PILLAR -> {
				return pillar(player);
			}
			case CROSS -> {
				Vec3 goal = dropPosition(player);
				// To a seen drop, onto it; to the estimated landing, near enough to see the ledge's top.
				boolean estimate = goal.equals(Vec3.atBottomCenterOf(landing));
				ServerController.TickResult result = walkTo(player, goal, estimate ? 1.5D : 0.3D, now, climbed ? 6_000L : 12_000L, -1);
				if (result == null) return null;
				if (failureCode != null) return finish(player, "walk to the drop " + result.reasonCode());
				Vec3 seenAt = dropPosition(player);
				if (seenAt.distanceToSqr(goal) > 0.25D && !seenAt.equals(Vec3.atBottomCenterOf(landing)) && retargets++ < 6) return null;
				boolean seen = !estimate;
				boolean near = player.position().distanceTo(goal) <= 2.5D;
				if (!picked && !seen && near && !looked) {
					// Up by the ledge: look over it toward where the drop fell before calling it gone.
					looked = true;
					lookUntil = now + 700L;
					phase = Phase.LOOK;
					return null;
				}
				if (!picked && !seen && !near && NO_WAY.contains(result.reasonCode()) && base != null && !climbed) {
					// No walk up: pillar beside the ledge.
					phase = Phase.BASE;
					return null;
				}
				if (!picked) note = result.state() == ServerController.State.SUCCEEDED && !seen ? "no drop where it landed" : "walk to the drop " + result.reasonCode();
				toBack(player);
				return null;
			}
			case LOOK -> {
				Vec3 eye = player.getEyePosition();
				float[] view = TravelBuilder.lookAt(eye, new Vec3(estimateAt.x, Math.max(estimateAt.y, landing.getY() + 0.2D), estimateAt.z));
				apply(player, new AgentInputState(0.0F, 0.0F, false, crouched, false, false, false,
						AgentInputStates.turnYaw(player.getYRot(), view[0]), AgentInputStates.turnPitch(player.getXRot(), view[1]),
						player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
				if (now < lookUntil) return null;
				input.release();
				phase = Phase.CROSS;
				return null;
			}
			case BACK -> {
				ServerController.TickResult result = walkTo(player, back, 1.0D, now, 12_000L, -1);
				if (result == null) return null;
				return finish(player, (picked ? "picked up " + (heldLast - heldAtStart) : "picked up none" + (note == null ? "" : " (" + note + ")"))
						+ (placed > 0 ? ", pillared " + placed : "") + "; back " + (result.state() == ServerController.State.SUCCEEDED ? "at the fighting spot" : "walk " + result.reasonCode()));
			}
		}
		return null;
	}

	/**
	 * The drop being chased while the body sees it; else the nearest counted-item drop the body sees on the ledge (within
	 * {@link #SWEEP} blocks of where this one landed, at or above the ledge); else the estimated landing.
	 */
	private Vec3 dropPosition(ServerPlayer player) {
		Entity entity = chasing == null ? null : ((ServerLevel) player.level()).getEntity(chasing);
		if (entity instanceof ItemEntity seen && seen.isAlive() && ObservationVisibility.canSeeEntity(player, seen)) {
			ObservedDrops.remember(player, seen);
			return seen.position();
		}
		ItemEntity nearest = null;
		double best = Double.MAX_VALUE;
		for (ItemEntity other : player.level().getEntitiesOfClass(ItemEntity.class, new net.minecraft.world.phys.AABB(landing).inflate(SWEEP, 2.0D, SWEEP),
				e -> e.isAlive() && e.getItem().is(item) && e.getY() >= landing.getY() - 0.5D)) {
			if (!ObservationVisibility.canSeeEntity(player, other)) continue;
			double distance = other.distanceToSqr(player);
			if (distance < best) { best = distance; nearest = other; }
		}
		if (nearest != null) {
			chasing = nearest.getUUID();
			ObservedDrops.remember(player, nearest);
			return nearest.position();
		}
		chasing = null;
		return Vec3.atBottomCenterOf(landing);
	}

	private void toBack(ServerPlayer player) {
		if (walk != null) { walk.cancel(player); walk = null; }
		input.release();
		phase = Phase.BACK;
	}

	/** Look straight down, jump from the column's middle, place under the feet at the top of the jump, land; repeat. */
	private String pillar(ServerPlayer player) {
		int feet = Mth.floor(player.getY() + 1.0E-3D);
		if (player.onGround() && feet >= landing.getY()) {
			input.release();
			climbed = true;
			phase = Phase.CROSS;
			return null;
		}
		if (++stageTicks > 50 * height) return finish(player, "could not pillar up at " + base.getX() + "," + levelFeet + "," + base.getZ());
		if (player.onGround() && feet > levelFeet) levelFeet = feet;
		int slot = player.getInventory().getSelectedSlot();
		if (!TravelBuilder.buildingBlock(player.getInventory().getItem(slot))) {
			int found = TravelBuilder.blockSlot(player);
			if (found < 0 || found >= 9) return finish(player, "ran out of plain blocks on the hotbar after " + placed);
			player.getInventory().setSelectedSlot(found);
			slot = found;
		}
		double dx = base.getX() + 0.5D - player.getX(), dz = base.getZ() + 0.5D - player.getZ();
		boolean centred = dx * dx + dz * dz <= 0.04D;
		float yaw = player.getYRot();
		float pitch = AgentInputStates.turnPitch(player.getXRot(), 90.0F);
		float forward = 0.0F, strafe = 0.0F;
		boolean jump = false;
		if (player.onGround()) {
			if (!centred) {
				float[] keys = BrinkGuard.keysToward(yaw, dx, dz);
				forward = keys[0] * 0.3F;
				strafe = keys[1] * 0.3F;
			} else jump = player.getXRot() > 80.0F;
		} else if (player.getY() >= levelFeet + 1.0D + 1.0E-3D) {
			BlockPos under = new BlockPos(base.getX(), levelFeet, base.getZ());
			BlockHitResult hit = TravelBuilder.crosshair(player);
			if (hit != null && hit.getDirection() == Direction.UP && hit.getBlockPos().equals(under.below()) && mayModify.test(player, under)
					&& TravelBuilder.click(player, hit)) placed++;
		}
		apply(player, new AgentInputState(forward, strafe, jump, crouched, false, false, false, yaw, pitch, slot, InteractionHand.MAIN_HAND));
		return null;
	}

	/** Null while walking; the walk's end otherwise (success on arrival). */
	private ServerController.TickResult walkTo(ServerPlayer player, Vec3 goal, double tolerance, long now, long timeoutMs, int level) {
		if (walk == null || goal.distanceToSqr(walkGoal) > 0.25D) {
			if (walk != null) walk.cancel(player);
			input.release();
			ServerNavigationController next = new ServerNavigationController(goal, tolerance, false, now, timeoutMs, tolerance > 1.0D).crouched(crouched);
			walk = level >= 0 ? next.onLevel(level) : next;
			walkGoal = goal;
		}
		ServerController.TickResult result = walk.tick(player, now);
		if (result.state() == ServerController.State.RUNNING) return null;
		if ("SNEAK_HOLDS_EDGE".equals(result.reasonCode())) failureCode = result.reasonCode();
		walk.cancel(player);
		walk = null;
		// A hit stops a walk (navigation hands back on damage); in a blaze room the trip walks on, until it has lost
		// TURN_BACK_LOSS health.
		if ("NAVIGATION_DAMAGED".equals(result.reasonCode()) && damagedRewalks++ < 6) return null;
		return result;
	}

	/** Applies this tick's keys; a lease left unrenewed while the fight's shield guard had the body is taken afresh. */
	private void apply(ServerPlayer player, AgentInputState state) {
		long tick = player.level().getGameTime();
		if (tick - lastApplyTick > 1L) input.release();
		input.apply(player, state);
		lastApplyTick = tick;
	}

	private String finish(ServerPlayer player, String text) {
		cancel(player);
		return describe() + ": " + text;
	}

	/**
	 * The fight's shield guard has the body this tick: the walk is put down (an unticked navigation walk's input lease
	 * expires after 40 ticks and a later tick on it threw "input lease is no longer active") and the keys released. The
	 * next tick walks on to the same goal with a fresh walk and lease.
	 */
	void suspend(ServerPlayer player) {
		if (walk != null) { walk.cancel(player); walk = null; }
		input.release();
	}

	void cancel(ServerPlayer player) {
		if (walk != null) { walk.cancel(player); walk = null; }
		input.release();
	}

}
