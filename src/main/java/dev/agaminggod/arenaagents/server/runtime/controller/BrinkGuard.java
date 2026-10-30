package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import dev.agaminggod.arenaagents.server.perception.VoidColumn;
import java.util.Map;
import java.util.WeakHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/**
 * The body's footing at a lethal brink, whatever drives it: a player crouches at the lip of a lava drop or a fall that
 * kills, and leans back into place when a hit shoves them toward it. Movement planning already refuses lava and deadly
 * drops as destinations, but nothing kept the body from going over a brink between those plans: 26 Nether deaths on
 * 2026-10-23 included bodies shoved off ledges into lava while holding a shield (9 blocked piglin hits walked one 4.6
 * blocks back over a 13-block drop), a pickup that coasted off a ledge onto lava and control steps off a bridge.
 * <p>
 * Two rules, both a player's own keys and vanilla's own mechanics:
 * <ul>
 * <li>Moving: when the next two ticks' motion would leave the whole body unsupported over a lethal column (lava or
 * fire before the landing, the void, or a fall whose damage reaches the body's health, from terrain the player has
 * seen), sneak is held: vanilla's edge back-off (Player.maybeBackOffFromEdge) then stops the body at the lip. Not while
 * the body's own jump is under way (a planned gap jump must keep its run-up).</li>
 * <li>Still: with no movement keys held, the spot where the body stopped is its anchor. While the body is within reach
 * of a lethal brink it is crouched, and a shove away from the anchor is walked back (keyboard keys toward it, in the air
 * too): a stance that started three blocks from the edge and was pushed toward it walks back to where it started.
 * Vanilla's back-off clips only on the ground and while descending, never the rising part of a knockback hop, so a run
 * of blocked hits still drifts a crouched body; walking back between them is what holds the spot.</li>
 * </ul>
 * The general guard keeps a commanded stance where it was commanded and refuses the last step over a lethal brink.
 * A fight or shield stance retaining its level also leans onto nearby known footing with more bracing room before
 * a hit, keeps its last supported position while moving, and steers back during an airborne shove.
 */
public final class BrinkGuard {
	/** Ticks after the body's own jump during which motion is the jump's (a planned gap jump), not a stumble. */
	static final int OWN_JUMP_TICKS = 12;
	/** A still body this close to a lethal column (horizontal shift of its box, blocks) is braced. */
	static final double BRACE_REACH = 1.4D;
	/** Horizontal speed (blocks per tick) below which a body with no keys held has come to rest. */
	static final double SETTLED_SPEED = 0.02D;
	/** Displacement from the anchor that is walked back (blocks). */
	static final double DRIFT = 0.12D;
	/** Displacement beyond which the anchor is given up (the body was moved somewhere else entirely). */
	static final double LOST_ANCHOR = 6.0D;
	/** Ticks between re-checks of whether the body is within reach of a lethal brink. */
	static final int RECHECK_TICKS = 4;
	/** Horizontal input acceleration per tick at most (sprinting on the ground), for the look-ahead. */
	private static final double INPUT_ACCELERATION = 0.13D;
	private static final double[] BRACE_STEPS = {0.35D, 0.7D, 1.05D, BRACE_REACH};
	private static final double[] LEVEL_BRACE_STEPS = {0.35D, 0.7D, 1.05D, BRACE_REACH, 2.0D, 2.7D};

	private static final Map<ServerPlayer, Memory> MEMORY = new WeakHashMap<>();

	private BrinkGuard() { }

	/**
	 * The movement keys to apply this tick. {@code sneak} is the commanded sneak or the guard's. {@code jumpRefused}: the
	 * jump key is let go this tick (the jump would land the body over a lethal or unseen-bottom drop). {@code lowerShield}:
	 * a raised shield is lowered this tick, so an airborne walk-back moves at full air speed (Lucas's ruling 15: a player
	 * can release the shield any time; a raised one cuts movement to a fifth).
	 */
	public record Keys(float forward, float strafe, boolean sneak, boolean braced, boolean jumpRefused, boolean lowerShield) {
		public Keys(float forward, float strafe, boolean sneak, boolean braced) { this(forward, strafe, sneak, braced, false, false); }
	}

	private static final class Memory {
		private Vec3 anchor;
		private Vec3 bracePoint;
		private boolean near;
		private boolean needsFooting;
		private int recheck;
		private int ownJump;
		private boolean sneakSet;
		private Vec3 destination;
		private int destinationTick;
		/** Where the body last stood on supported ground (its take-off point once it is airborne). */
		private Vec3 footing;
		private boolean wasOnGround;
		private int lastHurtTime;
		/** An airborne body that left the ground without its own jump and with upward motion: a hit's knockback hop. */
		private boolean shoved;
		/** The last thing the guard did for the model's view (player.brink.saved): what, where (feet) and when (game time). */
		private String savedWhat;
		private Vec3 savedAt;
		private String savedBelow;
		private long savedTime;
		/** Last tick a model-commanded action other than raw control keys drove the body (see commandedAction). */
		private int actionTick = -1000;
		/** Last tick a brace reflex rule held (see braceArmed); the walk-back after a shove then runs in any stance. */
		private int braceTick = -1000;
		private final java.util.Set<Object> levelHolders = java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());
		private final java.util.Set<Object> bracingHolders = java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());
	}

	/** Keep a commanded fight/stance on its deck, including survivable drops; released by that action on exit. */
	public static synchronized void keepLevel(ServerPlayer player, Object owner, boolean hold) {
		keepLevel(player, owner, hold, true);
	}

	public static synchronized void keepLevel(ServerPlayer player, Object owner, boolean hold, boolean brace) {
		Memory memory = MEMORY.computeIfAbsent(player, ignored -> new Memory());
		if (hold) memory.levelHolders.add(owner);
		else memory.levelHolders.remove(owner);
		if (hold && brace) memory.bracingHolders.add(owner);
		else memory.bracingHolders.remove(owner);
	}

	/** A braced level stance needs a glance at the floor before it can lean inward onto known footing. */
	public static synchronized boolean needsFooting(ServerPlayer player) {
		Memory memory = MEMORY.get(player);
		return memory != null && !memory.levelHolders.isEmpty() && memory.needsFooting;
	}

	/**
	 * The destination of the movement action driving the body this tick (navigate_to, move_to, a travel_to leg), stamped
	 * every tick it runs; raw control keys carry none.
	 */
	public static synchronized void commandedDestination(ServerPlayer player, Vec3 destination) {
		Memory memory = MEMORY.computeIfAbsent(player, ignored -> new Memory());
		memory.destination = destination;
		memory.destinationTick = player.tickCount;
	}

	/**
	 * A model-commanded action other than raw control keys drives the body this tick (a move, a use such as a raised
	 * shield or eating, a placement, a controller such as build_shelter, fight_target or dig_to), stamped every tick it
	 * runs. Ruling 12: the walk-back after a shove runs only in such a commanded stance or move.
	 */
	public static synchronized void commandedAction(ServerPlayer player) {
		MEMORY.computeIfAbsent(player, ignored -> new Memory()).actionTick = player.tickCount;
	}

	/** Ticks a brace rule keeps the walk-back on after its condition (an edge near) last held: a shove's whole hop. */
	static final int BRACE_HOLD_TICKS = 40;

	/**
	 * A brace reflex rule (a default survival rule, Lucas's ruling 16, Oct 28) holds this tick: the walk-back after a shove
	 * runs whatever drives the body (control keys, a program, a reflex firing or nothing), not only a commanded stance.
	 */
	public static synchronized void braceArmed(ServerPlayer player) {
		MEMORY.computeIfAbsent(player, ignored -> new Memory()).braceTick = player.tickCount;
	}

	/** A movement action (navigate_to, move_to, a travel_to leg) stamped its destination within the last two ticks. */
	private static boolean commandedMove(ServerPlayer player, Memory memory) {
		return memory.destination != null && player.tickCount - memory.destinationTick <= 2;
	}

	/**
	 * The body holds a stance or a move the model set (ruling 12): a commanded action, a stance keeping its level, or an
	 * item in use (a shield a model-armed rule raised, food). Raw control keys, a program's keys and an idle body are
	 * not: the still rule below covers a body holding no keys.
	 */
	private static boolean inStance(ServerPlayer player, Memory memory) {
		return !memory.levelHolders.isEmpty() || player.isUsingItem() || player.tickCount - memory.actionTick <= 2
				|| commandedMove(player, memory) || player.tickCount - memory.braceTick <= BRACE_HOLD_TICKS;
	}

	/**
	 * What the guard did for this body at or after game time {@code since}, for the result of the action that ran then
	 * (the model learns why its move or jump did not go as sent); null when it did nothing.
	 */
	public static synchronized String savedSince(ServerPlayer player, long since) {
		Memory memory = MEMORY.get(player);
		if (memory == null || memory.savedWhat == null || memory.savedTime < since) return null;
		return "at a brink the body " + ("jump refused".equals(memory.savedWhat) ? "refused a jump" : memory.savedWhat)
				+ " at " + Mth.floor(memory.savedAt.x) + "," + Mth.floor(memory.savedAt.y + 1.0E-4D) + "," + Mth.floor(memory.savedAt.z)
				+ " (below: " + memory.savedBelow + ")";
	}

	/**
	 * The drop a body takes when the only block under its feet is broken, as the player knows the columns under it: a
	 * lethal one (lava or fire, the void, a fall that kills at its health) or one whose bottom is unseen; null when a
	 * seen landing is a survivable fall.
	 */
	public static Fall dropThroughFloor(ServerPlayer player) {
		return fall(ObservedTerrain.of(player), player.getBoundingBox().move(0.0D, -1.0D, 0.0D), player.level().getMinY(),
				(x, y, z) -> VoidColumn.below(player.level(), x, y, z), player.fallDistance + 1.0D,
				player.getHealth() + player.getAbsorptionAmount());
	}

	/** A destination stamped within the last two ticks whose cell is below the body's feet. */
	private static boolean destinationBelow(ServerPlayer player, Memory memory) {
		return memory.destination != null && player.tickCount - memory.destinationTick <= 2
				&& Mth.floor(memory.destination.y) < Mth.floor(player.getY() + 1.0E-4D);
	}

	/** Whether the guard holds this body's sneak now (so an interaction that wants no secondary use can lift it). */
	public static synchronized boolean holdsSneak(ServerPlayer player) {
		Memory memory = MEMORY.get(player);
		return memory != null && memory.sneakSet;
	}

	/**
	 * One tick before the body moves, with the keys its input holds. Returns the keys to move with; the caller applies
	 * {@link Keys#sneak} only when it differs from the body's shift state (see {@link #applySneak}).
	 */
	public static synchronized Keys tick(ServerPlayer player, float forward, float strafe, boolean sneak, boolean jump, boolean clickUse) {
		Memory memory = MEMORY.computeIfAbsent(player, ignored -> new Memory());
		if (!eligible(player)) {
			memory.anchor = null;
			memory.ownJump = 0;
			return release(player, memory, forward, strafe, sneak);
		}
		boolean keepLevel = !memory.levelHolders.isEmpty();
		boolean brace = !memory.bracingHolders.isEmpty();
		memory.needsFooting = false;
		if (!brace) memory.bracePoint = null;
		// A jump is judged where it lands before it starts: the guard stood aside while a jump was under way, so a
		// commanded sprint-jump carried the body over unseen-bottom lips (lava library fb1-move, d38t123-control) and a
		// control jump at a bridge edge went over (deck c6-1). A player does not jump off a ledge whose landing kills or
		// whose bottom it has not seen, unless it is heading down there (decision 11: a commanded destination below the
		// lip); a gap jump onto footing is still taken. Take-off judgement from claude/d41-travel 005111c6..91482b12.
		WalkabilityView world = null;
		// Ruling 11 covers commanded moves (its exception: a destination below the lip). Control keys, a program's keys, a
		// fight's crit jump and a rule's jump are the model's own and are not judged (no override exists for them).
		Fall refusedFall = jump && !brace && player.onGround() && commandedMove(player, memory)
				? jumpLandsLethal(player, worldHeading(player.getYRot(), forward, strafe), player.isSprinting()) : null;
		if (refusedFall != null && refusedFall.unknown() && destinationBelow(player, memory)) refusedFall = null;
		boolean refuseJump = refusedFall != null;
		if (refuseJump) {
			jump = false;
			saved(player, memory, "jump refused", refusedFall);
		}
		memory.ownJump = brace || refuseJump ? 0 : jump ? OWN_JUMP_TICKS : Math.max(0, memory.ownJump - 1);
		// A shove: the body leaves the ground going up without its own jump (vanilla knockback lifts a grounded body 0.4).
		// Seen on the take-off tick (the hit set the motion after the last move) or the first airborne one.
		boolean onGround = player.onGround();
		Vec3 lift = player.getDeltaMovement();
		// A hit in the air (its hurt tilt starts this tick) shoves a jumping body too (deck c6-1: a fireball mid-jump).
		boolean hurtNow = player.hurtTime > memory.lastHurtTime;
		memory.lastHurtTime = player.hurtTime;
		if (memory.footing != null && (hurtNow && !onGround || memory.ownJump == 0 && lift.y > SHOVE_LIFT && (onGround || memory.wasOnGround))) memory.shoved = true;
		else if (onGround) memory.shoved = false;
		if (onGround && !memory.shoved && !unsupported(player, 0.0D, 0.0D)) memory.footing = player.position();
		memory.wasOnGround = onGround;
		if (memory.shoved && inStance(player, memory) && !destinationBelow(player, memory)) {
			// In a stance or move the model set (ruling 12: a commanded move, shield, place, shelter or eat), a hop that lands
			// over a lethal or unseen-bottom column is steered back toward the take-off point with the air keys a player
			// has, upright and with a raised shield lowered (deck c6-3: a fireball knocked a travel_to off the y59 bridge;
			// c6-2: the low-health sprint_away rule ran the hop on into the lava; pearl c5: a shield fight on a lava shore).
			// On the take-off tick (still on the ground, the hit's motion just set) the keys push against that motion with
			// ground grip, five times what air control gives; once airborne they aim at the take-off point.
			Vec3 to = memory.footing;
			double dx = to.x - player.getX(), dz = to.z - player.getZ();
			if (dx * dx + dz * dz <= DRIFT * DRIFT) {
				dx = -lift.x;
				dz = -lift.z;
			}
			if (dx * dx + dz * dz > 1.0E-4D) {
				world = ObservedTerrain.of(player);
				Fall landing = shoveLanding(player, world, to.y);
				if (landing != null) {
					float[] keys = keysToward(player.getYRot(), dx, dz);
					if (!"walked back after a hit".equals(memory.savedWhat) || player.level().getGameTime() - memory.savedTime > SAVED_FACT_TICKS)
						saved(player, memory, "walked back after a hit", landing);
					memory.sneakSet = false;
					return new Keys(keys[0], keys[1], false, true, false, shieldRaised(player));
				}
			}
		}
		boolean idle = forward == 0.0F && strafe == 0.0F && !jump;
		if (!idle && !keepLevel) memory.anchor = null;
		else if (memory.anchor != null && horizontal(player.position(), memory.anchor) > LOST_ANCHOR && player.onGround()) memory.anchor = null;
		// The anchor is where the body came to rest, not where the keys were released: a stop that is still sliding
		// (a reflex walk's last cell, a sprint's coast) settles first (replay of death 7: an anchor taken mid-slide held
		// the body overlapping the fire it had just walked out of).
		Vec3 motion = player.getDeltaMovement();
		boolean settled = motion.x * motion.x + motion.z * motion.z < SETTLED_SPEED * SETTLED_SPEED;
		if ((idle && settled || keepLevel) && memory.anchor == null && player.onGround()) {
			memory.anchor = player.position();
			memory.recheck = 0;
		}
		// Releasing an action clears its crouch. Keep a stationary body on magma safe during the model's next turn.
		boolean hold = idle && !clickUse && onMagma(player), braced = false, lowerShield = false;
		float keysForward = forward, keysStrafe = strafe;
		// Still: keep the commanded spot while a lethal brink is within reach of the body.
		if ((idle || keepLevel) && memory.anchor != null && memory.ownJump == 0) {
			if (memory.recheck-- <= 0 || keepLevel) {
				world = ObservedTerrain.of(player);
				memory.near = nearLethal(player, world, keepLevel, brace);
				memory.recheck = RECHECK_TICKS;
			}
			if (memory.near) {
				braced = true;
				// A raised shield cannot undo a whole knockback hop at a lip. Gain a little room before the hit,
				// using only already-seen, continuous footing on this level.
				Vec3 inward = null;
				if (brace && idle && player.onGround()) {
					if (memory.bracePoint != null && (horizontal(player.position(), memory.bracePoint) < 0.2D
							|| !supportedGoal(world, player, memory.bracePoint))) memory.bracePoint = null;
					if (memory.bracePoint == null) memory.bracePoint = bracePoint(world, player.getX(), player.getY(), player.getZ());
					inward = memory.bracePoint;
				}
				if (inward != null) {
					float[] keys = keysToward(player.getYRot(), inward.x - player.getX(), inward.z - player.getZ());
					keysForward = keys[0];
					keysStrafe = keys[1];
					memory.anchor = inward;
					return release(player, memory, keysForward, keysStrafe, sneak, true);
				}
				memory.needsFooting = brace && player.onGround()
						&& world instanceof ObservedTerrain observed && observed.unknownReads() > 0;
				double dx = memory.anchor.x - player.getX(), dz = memory.anchor.z - player.getZ();
				if (dx * dx + dz * dz > DRIFT * DRIFT && (idle || !player.onGround())) {
					// Walking back, away from the brink, upright: crouching would cut the step to 0.3 (and a raised
					// shield already cuts it to 0.2), too slow to undo one hit's shove before the next.
					float[] keys = keysToward(player.getYRot(), dx, dz);
					keysForward = keys[0];
					keysStrafe = keys[1];
					// Ruling 15: in the air the shield comes down so the walk-back runs at full speed.
					lowerShield = !player.onGround() && shieldRaised(player);
				} else {
					// Settled: crouched, so a slide over the lip is clipped. A click on a block while crouched is vanilla's
					// secondary use (no chest opens): that tick stays upright.
					hold = (!keepLevel || idle) && !clickUse;
				}
			} else if (keepLevel && player.onGround()) {
				// The last supported interior point survives an incoming hit even while movement keys are held.
				memory.anchor = player.position();
			}
		}
		// Moving (on the input's keys, walking back or still sliding): the whole body would be over a lethal column
		// within two ticks.
		boolean moving = keysForward != 0.0F || keysStrafe != 0.0F || !settled;
		if (!hold && moving && memory.ownJump == 0 && player.onGround()) {
			double[] heading = worldHeading(player.getYRot(), keysForward, keysStrafe);
			double dx = (motion.x + heading[0] * INPUT_ACCELERATION) * 2.0D, dz = (motion.z + heading[1] * INPUT_ACCELERATION) * 2.0D;
			if (unsupported(player, dx, dz)) {
				if (world == null) world = ObservedTerrain.of(player);
				AABB over = player.getBoundingBox().move(dx, 0.0D, dz);
				// A player checks the landing before walking off an edge. Unknown depth stops a commanded step too,
				// unless the commanded destination lies below the lip (the model chose to go down there).
				// A travel_to cancelled mid-bridge let go of sneak at the lip while the body still backed toward
				// the gap, and it slid off into the lava sea it had not looked at (lqqf7a, 2026-10-24).
				Fall drop = fall(player, world, over);
				hold = keepLevel || drop != null && (!drop.unknown() || !destinationBelow(player, memory));
			}
		}
		// A refused jump also holds sneak: the move was aimed over a real drop, and without it forward and sprint walked
		// the body off the same lip (claude/d41-travel derived replay flee-jump5, 3/3 dead).
		if (refuseJump) hold = true;
		if (!hold) {
			Keys keys = release(player, memory, keysForward, keysStrafe, sneak, braced);
			return lowerShield ? new Keys(keys.forward(), keys.strafe(), keys.sneak(), keys.braced(), false, true) : keys;
		}
		memory.sneakSet = !sneak;
		return new Keys(keysForward, keysStrafe, true, braced, refuseJump, false);
	}

	/** Upward motion past which a grounded body without its own jump was lifted by a hit (vanilla knockback: 0.4). */
	static final double SHOVE_LIFT = 0.2D;
	/** Ticks the guard's last save stays in the model's view (player.brink.saved). */
	static final int SAVED_FACT_TICKS = 100;

	private static boolean shieldRaised(ServerPlayer player) {
		return player.isUsingItem() && player.getUseItem().is(net.minecraft.world.item.Items.SHIELD);
	}

	private static void saved(ServerPlayer player, Memory memory, String what, Fall fall) {
		memory.savedWhat = what;
		memory.savedAt = player.position();
		memory.savedBelow = fall.unknown() ? "unseen" : fall.below();
		memory.savedTime = player.level().getGameTime();
	}

	/**
	 * Where a hop under way comes down at the take-off height {@code floorY} with no keys (vanilla air drag 0.91,
	 * gravity 0.08 with 0.98 drag): the drop it would go over there (lethal or unseen bottom), or null when it lands on
	 * footing or over a survivable drop.
	 */
	static Fall shoveLanding(ServerPlayer player, WalkabilityView world, double floorY) {
		Vec3 v = player.getDeltaMovement();
		double[] shift = shoveDisplacement(v.x, v.y, v.z, player.getY() - floorY);
		AABB landing = player.getBoundingBox().move(shift[0], floorY - player.getY(), shift[1]);
		if (!unsupportedAt(player, landing)) return null;
		return fall(player, world, landing);
	}

	/** Horizontal (x, z) a keyless hop still covers from motion (vx, vy, vz) at {@code above} blocks over its floor. */
	static double[] shoveDisplacement(double vx, double vy, double vz, double above) {
		double x = 0.0D, z = 0.0D, y = above;
		for (int tick = 0; tick < 40; tick++) {
			x += vx;
			z += vz;
			y += vy;
			vx *= 0.91D;
			vz *= 0.91D;
			vy = (vy - 0.08D) * 0.98D;
			if (vy < 0.0D && y <= 1.0E-3D) break;
		}
		return new double[] {x, z};
	}

	/** Ticks a jump from level ground stays airborne before it lands at its take-off height (vanilla: 0.42 up, 0.08 gravity). */
	static final int JUMP_AIR_TICKS = 12;

	/**
	 * First airborne tick at which a jump can come down on footing at its take-off height: the feet are 1.25 above it at
	 * ticks 5 to 7 and still 1.0 above at tick 8, so a landing judged there is footing the body flies over.
	 */
	static final int JUMP_FIRST_LANDING_TICK = 10;

	/**
	 * Horizontal displacement (x, z) of a jump after {@code ticks} airborne ticks, from the motion now and the keys'
	 * world heading: the take-off tick's ground push and sprint-jump boost, then vanilla air control (0.02 a tick, 0.026
	 * sprinting) and air drag (0.91).
	 */
	static double[] jumpDisplacement(double motionX, double motionZ, double[] heading, boolean sprint, int ticks) {
		double vx = motionX + heading[0] * (INPUT_ACCELERATION + (sprint ? 0.2D : 0.0D));
		double vz = motionZ + heading[1] * (INPUT_ACCELERATION + (sprint ? 0.2D : 0.0D));
		double air = sprint ? 0.026D : 0.02D, x = 0.0D, z = 0.0D;
		for (int tick = 0; tick < ticks; tick++) {
			x += vx;
			z += vz;
			vx = vx * 0.91D + heading[0] * air;
			vz = vz * 0.91D + heading[1] * air;
		}
		return new double[] {x, z};
	}

	/**
	 * Whether a jump taken now lands the whole body over a drop that kills as the player knows it (lava or fire, the void,
	 * a killing fall) or whose bottom the player has not seen. Every tick of the jump's way down (airborne ticks 10 to 14)
	 * is a possible landing: any of them on footing or over a known survivable drop allows the jump. A wall on the way
	 * stops the jump short, so a landing past it is never judged; a block only at take-off height is a ledge one up across
	 * the gap, which the jump lands on.
	 */
	static Fall jumpLandsLethal(ServerPlayer player, double[] heading, boolean sprint) {
		Vec3 motion = player.getDeltaMovement();
		AABB box = player.getBoundingBox();
		WalkabilityView world = null;
		Fall last = null;
		for (int ticks = JUMP_FIRST_LANDING_TICK; ticks <= JUMP_AIR_TICKS + 2; ticks++) {
			double[] shift = jumpDisplacement(motion.x, motion.z, heading, sprint, ticks);
			double length = Math.hypot(shift[0], shift[1]);
			if (length < 1.0E-6D) return null;
			AABB landing = box;
			boolean walled = false;
			for (double d = 0.25D; d <= length + 1.0E-6D; d += 0.25D) {
				AABB next = box.move(shift[0] * d / length, 0.0D, shift[1] * d / length);
				if (!player.level().noCollision(player, next.move(0.0D, 1.0D, 0.0D).deflate(1.0E-3D))) { walled = true; break; }
				if (!player.level().noCollision(player, next.deflate(1.0E-3D))) return null;
				landing = next;
			}
			if (walled && landing == box) return null;
			if (!walled) landing = box.move(shift[0], 0.0D, shift[1]);
			if (!unsupportedAt(player, landing)) return null;
			if (world == null) world = ObservedTerrain.of(player);
			last = fall(player, world, landing);
			if (last == null) return null;
		}
		return last;
	}

	/** Compare actual supported steps; an averaged inward direction can point into a hole in the deck. */
	static Vec3 bracePoint(WalkabilityView world, double x, double y, double z) {
		double best = braceRoom(world, x, y, z) + 0.5D;
		Vec3 point = null;
		for (double d : new double[]{0.5D, 1.0D, 1.5D}) {
			for (int heading = 0; heading < 8; heading++) {
				double angle = heading * Math.PI / 4.0D;
				double nx = Mth.floor(x + Math.cos(angle) * d) + 0.5D, nz = Mth.floor(z + Math.sin(angle) * d) + 0.5D;
				double distance = Math.hypot(nx - x, nz - z);
				if (distance < 0.25D || distance > 1.75D) continue;
				if (!levelFooting(world, x, y, z, new double[]{(nx - x) / distance, (nz - z) / distance}, distance)) continue;
				double score = braceRoom(world, nx, y, nz);
				if (score > best) { best = score; point = new Vec3(nx, y, nz); }
			}
		}
		return point;
	}

	private static boolean supportedGoal(WalkabilityView world, ServerPlayer player, Vec3 goal) {
		double dx = goal.x - player.getX(), dz = goal.z - player.getZ(), distance = Math.hypot(dx, dz);
		return distance > 0 && levelFooting(world, player.getX(), player.getY(), player.getZ(), new double[]{dx / distance, dz / distance}, distance);
	}

	private static double braceRoom(WalkabilityView world, double x, double y, double z) {
		double room = 0;
		for (int heading = 0; heading < 8; heading++) {
			double angle = heading * Math.PI / 4.0D;
			for (double d = 0.5D; d <= 2.0D; d += 0.5D) {
				GridPosition at = new GridPosition(Mth.floor(x + Math.cos(angle) * d), Mth.floor(y), Mth.floor(z + Math.sin(angle) * d));
				WalkabilityView.Cell feet = world.cellAt(at), head = world.cellAt(at.above());
				if (feet == WalkabilityView.Cell.UNLOADED || head == WalkabilityView.Cell.UNLOADED) break;
				if (!CombatPlanning.open(world, at) || !CombatPlanning.open(world, at.above())) {
					if (feet != WalkabilityView.Cell.HAZARD && head != WalkabilityView.Cell.HAZARD) room += 2.5D - d;
					break;
				}
				if (!world.isStandable(at)) break;
				room += 0.5D;
			}
		}
		return room;
	}

	static boolean levelFooting(WalkabilityView world, double x, double y, double z, double[] direction) {
		return levelFooting(world, x, y, z, direction, 1.5D);
	}

	private static boolean levelFooting(WalkabilityView world, double x, double y, double z, double[] direction, double distance) {
		for (double d = 0.25D; d <= distance; d += 0.25D) {
			if (!world.isStandable(new GridPosition(Mth.floor(x + direction[0] * d), Mth.floor(y), Mth.floor(z + direction[1] * d)))) return false;
		}
		return true;
	}

	/** The keys unchanged (a body the guard does not drive), lifting a sneak the guard had set. */
	public static synchronized Keys passThrough(ServerPlayer player, float forward, float strafe, boolean sneak) {
		Memory memory = MEMORY.get(player);
		if (memory == null) return new Keys(forward, strafe, sneak || player.isShiftKeyDown(), false);
		memory.anchor = null;
		memory.bracePoint = null;
		return release(player, memory, forward, strafe, sneak);
	}

	/** Applies the guard's sneak: sets the shift key when it differs, and lifts sprint while the guard crouches the body. */
	public static void applySneak(ServerPlayer player, Keys keys) {
		if (player.isShiftKeyDown() != keys.sneak()) player.setShiftKeyDown(keys.sneak());
		if (keys.sneak() && player.isSprinting()) player.setSprinting(false);
	}

	private static Keys release(ServerPlayer player, Memory memory, float forward, float strafe, boolean sneak) {
		return release(player, memory, forward, strafe, sneak, false);
	}

	private static Keys release(ServerPlayer player, Memory memory, float forward, float strafe, boolean sneak, boolean braced) {
		boolean was = memory.sneakSet;
		memory.sneakSet = false;
		// Only a sneak the guard set is lifted; otherwise the shift key stays as the input (or an action) left it.
		return new Keys(forward, strafe, was ? sneak : sneak || player.isShiftKeyDown(), braced);
	}

	/** Include the trailing edge of the feet when leaving a hot block, not only the centre support. */
	static boolean onMagma(ServerPlayer player) {
		if (!player.onGround()) return false;
		AABB box = player.getBoundingBox();
		int y = (int) Math.floor(box.minY - 0.01D);
		for (int x = (int) Math.floor(box.minX + 1.0E-5D); x <= (int) Math.floor(box.maxX - 1.0E-5D); x++)
			for (int z = (int) Math.floor(box.minZ + 1.0E-5D); z <= (int) Math.floor(box.maxZ - 1.0E-5D); z++)
				if (player.level().getBlockState(new BlockPos(x, y, z)).is(Blocks.MAGMA_BLOCK)) return true;
		return false;
	}

	private static boolean eligible(ServerPlayer player) {
		return player.isAlive() && !player.isSpectator() && !player.getAbilities().flying && !player.isPassenger()
				&& !player.isFallFlying() && !player.isInWater() && !player.isInLava() && (!player.onClimbable() || player.onGround());
	}

	/** Vanilla's Player.canFallAtLeast for the body's box shifted by (dx, dz): nothing under it within a step. */
	static boolean unsupported(ServerPlayer player, double dx, double dz) {
		return unsupportedAt(player, player.getBoundingBox().move(dx, 0.0D, dz));
	}

	/** The body's box shifted at most {@link #BRACE_REACH} any way (over open footing) would hang over a lethal column. */
	static boolean nearLethal(ServerPlayer player, WalkabilityView world) {
		return nearLethal(player, world, false, false);
	}

	private static boolean nearLethal(ServerPlayer player, WalkabilityView world, boolean keepLevel, boolean brace) {
		AABB box = player.getBoundingBox();
		Memory memory = MEMORY.get(player);
		if (keepLevel && memory != null && memory.anchor != null) box = box.move(0.0D, memory.anchor.y - player.getY(), 0.0D);
		for (int index = 0; index < 8; index++) {
			double angle = Math.PI / 4.0D * index, cos = Math.cos(angle), sin = Math.sin(angle);
			for (double reach : brace ? LEVEL_BRACE_STEPS : BRACE_STEPS) {
				AABB shifted = box.move(cos * reach, 0.0D, sin * reach);
				// A wall (or a step up) this way ends the reach: the body is not shoved through it.
				if (!player.level().noCollision(player, shifted.deflate(1.0E-3D))) break;
				if (!unsupportedAt(player, shifted)) continue;
				// A drop whose bottom the body has not seen counts too: a shoved body has not looked behind it (the
				// lava sea under a ledge it stood on with its back to the edge), and walking back to where it stood is
				// safe whatever is down there.
				if (keepLevel || fall(player, world, shifted) != null) return true;
				break;
			}
		}
		return false;
	}

	private static boolean unsupportedAt(ServerPlayer player, AABB box) {
		double step = player.maxUpStep();
		return player.level().noCollision(player, new AABB(box.minX + 1.0E-7D, box.minY - step - 1.0E-7D, box.minZ + 1.0E-7D,
				box.maxX - 1.0E-7D, box.minY, box.maxZ - 1.0E-7D));
	}

	/** What a body dropping from a brink meets: lava or fire, the void, or a fall whose damage reaches its health. */
	public record Fall(String below, int drop) {
		public boolean unknown() {
			return UNKNOWN.equals(below);
		}
	}

	/** {@link Fall#below} of a drop whose bottom nobody has seen (lethal for no one, but no place to be shoved). */
	static final String UNKNOWN = "unknown";

	/** A drop from {@code box} the player knows kills: {@link #fall} other than unknown. */
	static boolean lethal(ServerPlayer player, WalkabilityView world, AABB box) {
		Fall fall = fall(player, world, box);
		return fall != null && !fall.unknown();
	}

	/**
	 * What a body dropping straight down from {@code box} dies of, as the player knows the columns under the box: lava
	 * or fire before (or as) it lands, the void, or a landing whose fall damage reaches its health; null when the drop
	 * is survivable; {@link #UNKNOWN} when no column's landing is known. A hot floor, a cactus or a berry bush hurts but
	 * is no reason to refuse a step.
	 */
	static Fall fall(ServerPlayer player, WalkabilityView world, AABB box) {
		return fall(world, box, player.level().getMinY(), (x, y, z) -> VoidColumn.below(player.level(), x, y, z),
				player.fallDistance, player.getHealth() + player.getAbsorptionAmount());
	}

	/** Whether the column at (x, z) is empty from y to the world's bottom. */
	@FunctionalInterface
	interface VoidProbe {
		boolean empty(int x, int y, int z);
	}

	/** As above over a view of the terrain, for a body that has fallen {@code fallen} blocks with {@code health} left. */
	static Fall fall(WalkabilityView world, AABB box, int minY, VoidProbe voidBelow, double fallen, double health) {
		int feetY = Mth.floor(box.minY + 1.0E-4D);
		int land = Integer.MAX_VALUE, burn = Integer.MAX_VALUE, voids = 0, columns = 0;
		String burnKind = null;
		for (int x = Mth.floor(box.minX + 1.0E-7D); x <= Mth.floor(box.maxX - 1.0E-7D); x++) {
			for (int z = Mth.floor(box.minZ + 1.0E-7D); z <= Mth.floor(box.maxZ - 1.0E-7D); z++) {
				columns++;
				for (int depth = 1; ; depth++) {
					int y = feetY - depth;
					if (y < minY) {
						voids++;
						break;
					}
					if (depth > SafeStep.MAX_COUNTED_DROP) {
						// Deeper than any counted drop: the void when the column is empty to the bottom, else unknown.
						if (voidBelow.empty(x, y, z)) voids++;
						break;
					}
					GridPosition at = new GridPosition(x, y, z);
					WalkabilityView.Cell cell = world.cellAt(at);
					// An End portal takes the body the moment it touches it: what lies under the pool is never reached.
					if (world.teleportsOnContact(at)) {
						land = Math.min(land, depth);
						break;
					}
					if (cell == WalkabilityView.Cell.HAZARD) {
						String kind = burning(world, at);
						if (kind == null) land = Math.min(land, depth);
						else if (depth < burn) {
							burn = depth;
							burnKind = kind;
						}
						break;
					}
					if (cell == WalkabilityView.Cell.UNLOADED) {
						if (voidBelow.empty(x, y, z)) voids++;
						break;
					}
					// A hanging vine is handhold, not a landing; releasing it still falls through this column.
					if (cell == WalkabilityView.Cell.CLEAR || cell == WalkabilityView.Cell.CLIMBABLE) continue;
					// Floor, wall or water ends the fall here.
					land = Math.min(land, depth);
					break;
				}
			}
		}
		if (burnKind != null && burn <= land) return new Fall(burnKind, burn - 1);
		if (land == Integer.MAX_VALUE) {
			if (columns > 0 && voids == columns) return new Fall("void", SafeStep.MAX_COUNTED_DROP);
			// No landing known under any column: a drop whose bottom the player has not seen.
			return new Fall(UNKNOWN, 0);
		}
		// Landing on the top of the cell at this depth: a fall of depth - 1 blocks (plus any fall under way); vanilla's
		// damage is the distance minus 3.
		double damage = land - 1 + fallen - 3.0D;
		return damage > 0.0D && damage >= health ? new Fall("drop", land - 1) : null;
	}

	/** "lava" or "fire" for a known hazard cell that burns a body falling into it, else null (magma, cactus, berries). */
	private static String burning(WalkabilityView world, GridPosition at) {
		net.minecraft.world.level.block.state.BlockState state = world instanceof ObservedTerrain observed ? observed.stateAt(at) : null;
		if (state == null) return "lava";
		if (state.getFluidState().is(net.minecraft.tags.FluidTags.LAVA)) return "lava";
		if (state.is(net.minecraft.tags.BlockTags.FIRE)) return "fire";
		return null;
	}

	/**
	 * The nearest lethal brink a shove of at most {@link #BRACE_REACH} would put the body over, as the player knows the
	 * terrain, for the model's view: {dir (compass), at (blocks of shove), below (lava, fire, void or drop), drop}. Null
	 * off the ground or with no lethal brink in reach.
	 */
	public static com.google.gson.JsonObject facts(ServerPlayer player) {
		com.google.gson.JsonObject fact = brinkFact(player);
		Memory memory = MEMORY.get(player);
		if (memory == null || memory.savedWhat == null) return fact;
		long ago = player.level().getGameTime() - memory.savedTime;
		if (ago < 0 || ago > SAVED_FACT_TICKS) return fact;
		// What the guard just did, so the model knows why its move or jump did not happen as sent.
		com.google.gson.JsonObject saved = new com.google.gson.JsonObject();
		saved.addProperty("did", memory.savedWhat);
		com.google.gson.JsonArray at = new com.google.gson.JsonArray();
		at.add(Mth.floor(memory.savedAt.x));
		at.add(Mth.floor(memory.savedAt.y + 1.0E-4D));
		at.add(Mth.floor(memory.savedAt.z));
		saved.add("at", at);
		saved.addProperty("below", memory.savedBelow);
		saved.addProperty("agoS", Math.round(ago / 2.0D) / 10.0D);
		if (fact == null) fact = new com.google.gson.JsonObject();
		fact.add("saved", saved);
		return fact;
	}

	private static com.google.gson.JsonObject brinkFact(ServerPlayer player) {
		if (!player.onGround() || !eligible(player)) return null;
		WalkabilityView world = ObservedTerrain.of(player);
		AABB box = player.getBoundingBox();
		double best = Double.POSITIVE_INFINITY;
		Fall found = null;
		float yaw = 0.0F;
		for (int index = 0; index < 8; index++) {
			double angle = Math.PI / 4.0D * index, cos = Math.cos(angle), sin = Math.sin(angle);
			for (double reach : BRACE_STEPS) {
				if (reach >= best) break;
				AABB shifted = box.move(cos * reach, 0.0D, sin * reach);
				if (!player.level().noCollision(player, shifted.deflate(1.0E-3D))) break;
				if (!unsupportedAt(player, shifted)) continue;
				Fall fall = fall(player, world, shifted);
				if (fall != null && !fall.unknown()) {
					best = reach;
					found = fall;
					// The heading (x, z) = (cos, sin) as a Minecraft yaw: 0 faces +z (south), 90 faces -x (west).
					yaw = (float) Math.toDegrees(Math.atan2(-cos, sin));
				}
				break;
			}
		}
		if (found == null) return null;
		com.google.gson.JsonObject fact = new com.google.gson.JsonObject();
		fact.addProperty("dir", SafeStep.compass(yaw));
		fact.addProperty("at", best);
		fact.addProperty("below", found.below());
		if (!found.below().equals("void")) fact.addProperty("drop", found.drop());
		return fact;
	}

	/** The world heading (x, z) of movement keys under a yaw (vanilla: forward is -sin, +cos; strafe left is cos, sin). */
	static double[] worldHeading(float yaw, float forward, float strafe) {
		double radians = Math.toRadians(yaw), sin = Math.sin(radians), cos = Math.cos(radians);
		double x = -sin * forward + cos * strafe, z = cos * forward + sin * strafe;
		double length = Math.hypot(x, z);
		return length < 1.0E-6D ? new double[]{0.0D, 0.0D} : new double[]{x / length, z / length};
	}

	/** Keyboard keys (forward, strafe; each -1, 0 or 1) closest to the world heading (dx, dz) under a yaw. */
	static float[] keysToward(float yaw, double dx, double dz) {
		double radians = Math.toRadians(yaw), sin = Math.sin(radians), cos = Math.cos(radians);
		double forward = -dx * sin + dz * cos, strafe = dx * cos + dz * sin;
		double snapped = Math.round(Math.atan2(strafe, forward) / (Math.PI / 4.0D)) * (Math.PI / 4.0D);
		return new float[]{(float) Math.round(Math.cos(snapped)), (float) Math.round(Math.sin(snapped))};
	}

	private static double horizontal(Vec3 a, Vec3 b) {
		return Math.hypot(a.x - b.x, a.z - b.z);
	}
}
