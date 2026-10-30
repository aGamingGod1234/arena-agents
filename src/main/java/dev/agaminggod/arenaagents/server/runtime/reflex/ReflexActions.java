package dev.agaminggod.arenaagents.server.runtime.reflex;

import dev.agaminggod.arenaagents.server.runtime.ArmSwing;
import carpet.script.utils.Tracer;
import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.mixin.LivingEntitySwingStateAccessor;
import dev.agaminggod.arenaagents.mixin.SwingStateAccessor;
import dev.agaminggod.arenaagents.server.perception.LavaSpread;
import dev.agaminggod.arenaagents.server.perception.ThreatPerception;
import dev.agaminggod.arenaagents.server.perception.WaterAirFacts;
import dev.agaminggod.arenaagents.server.runtime.controller.CombatPlanning;
import dev.agaminggod.arenaagents.server.runtime.controller.HazardExits;
import dev.agaminggod.arenaagents.server.runtime.controller.SafeStep;
import dev.agaminggod.arenaagents.server.runtime.controller.ServerNavigationController;
import dev.agaminggod.arenaagents.server.runtime.controller.SwimPlanning;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputState;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputStates;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Consumer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.boss.enderdragon.EnderDragon;
import net.minecraft.world.entity.boss.enderdragon.EnderDragonPart;
import net.minecraft.world.entity.projectile.Projectile;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import dev.agaminggod.arenaagents.server.runtime.AdvancedInteractionService;
import dev.agaminggod.arenaagents.server.runtime.InventoryRoom;
import dev.agaminggod.arenaagents.server.runtime.menu.AgentInventoryView;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.level.block.EntityBlock;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.shapes.BooleanOp;
import net.minecraft.world.phys.shapes.Shapes;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.entity.item.FallingBlockEntity;

/**
 * What a firing does with the body, one tick at a time, through the same input a player has: eased turning, held keys,
 * the hotbar, and a swing only when the crosshair is on the target and the attack has recharged. A new action adds a
 * case to {@link #create} and registers its parameters in {@link ReflexSpec}.
 */
final class ReflexActions {
	private ReflexActions() {
	}

	/**
	 * {@code point} is the place the condition is about (an edge, lava) when it names no entity. {@code below} is the input
	 * of the agent's own action when it keeps running under a held action (null when it is paused); {@code fightShields}
	 * says the agent's fight holds the shield itself between swings.
	 */
	record Context(ServerPlayer player, Entity focus, boolean stance, ReflexSensors.Memory memory, Vec3 point,
			AgentInputState below, boolean fightShields) {
		Context(ServerPlayer player, Entity focus, boolean stance, ReflexSensors.Memory memory) {
			this(player, focus, stance, memory, null);
		}

		Context(ServerPlayer player, Entity focus, boolean stance, ReflexSensors.Memory memory, Vec3 point) {
			this(player, focus, stance, memory, point, null, false);
		}

		/** Where the threat is: the live focus entity, else the condition's point, else null. */
		Vec3 threat() {
			if (focus != null && focus.isAlive()) return focus.position();
			return point;
		}
	}

	record Step(ReflexScheduler.ActionStatus status, String detail) {
		static Step running(String detail) { return new Step(ReflexScheduler.ActionStatus.RUNNING, detail); }
		static Step done(String detail) { return new Step(ReflexScheduler.ActionStatus.DONE, detail); }
		static Step failed(String detail) { return new Step(ReflexScheduler.ActionStatus.FAILED, detail); }
	}

	interface Behaviour {
		/** Applies this tick's input through {@code input} (at most once) and reports the action's status. */
		Step tick(Context context, Consumer<AgentInputState> input);

		/** A held action (a raised shield) ends when its condition clears, for triggers too. */
		default boolean holdsWhileTrue() { return false; }

		/** The hotbar choice outlives the firing (a tool swap), instead of returning to the paused action's slot. */
		default boolean keepsSelection() { return false; }

		/** The firing ended (done, preempted, timed out): undo what must not outlive it, such as an open screen. */
		default void end(ServerPlayer player) { }
		/** Ticks a held action stays held after its condition clears. */
		default long releaseGraceTicks() { return 0L; }

		/** The agent's own moving action keeps running under this one, its movement keys passed through. */
		default boolean passesMovement() { return false; }

		/** Its goal is met and it only holds on (a burn running out): reaching the rule's maxS is done, not a timeout. */
		default boolean settled() { return false; }

		/** Under the agent's fight with an offhand shield, the fight raises the shield itself this tick (see Shield). */
		default boolean defersToFight() { return true; }

		/** Only holds on now in a way the agent's paused fight handles itself (out of a fire block, still burning). */
		default boolean yieldsToFight() { return false; }
	}

	static Behaviour create(ReflexSpec.Action action) {
		return switch (action.type()) {
			case "shield" -> new Shield(action.flag("counter"));
			case "attack" -> new Attack();
			case "step_back" -> new StepBack(action.number("blocks", 2.0D));
			case "eat" -> new Eat();
			case "select" -> new Select(action.text("tool"), action.text("item"));
			case "swim_up" -> new SwimUp();
			case "pickup" -> new Pickup(action.number("within", 4.0D));
			case "place" -> new Place(action.text("item"), action.text("where"));
			case "stop" -> new Stop();
			case "deflect" -> new Deflect();
			case "sprint_away" -> new SprintAway(action.number("blocks", 8.0D));
			case "move_to_cell" -> new MoveToCell(new GridPosition(Mth.floor(action.number("x", 0.0D)), Mth.floor(action.number("y", 0.0D)),
					Mth.floor(action.number("z", 0.0D))), action.flag("sprint"));
			case "sneak" -> new Sneak();
			case "look_away" -> new LookAway();
			case "place_block" -> new PlaceBlock(action.text("item"), (int) action.number("count", 2.0D));
			case "take_cover" -> new TakeCover((int) action.number("within", 6.0D));
			case "away_from_edge" -> new AwayFromEdge(action.number("blocks", 6.0D));
			case "dig_out" -> new DigOut();
			case "leave_fire", "leave_lava" -> new LeaveFire();
			// Never started: the engine treats a brace rule as a body setting (see ReflexEngine), not a firing.
			case "brace" -> (context, input) -> Step.done("brace never takes the body");
			default -> (context, input) -> Step.failed("unknown action " + action.type());
		};
	}

	/**
	 * What {@code action} needs in hand or in the inventory that the body does not hold now, as the failure it would
	 * report on firing, or null: the model learns it when it arms the rule and when the item is lost, not when the rule
	 * fires (live run d18-iron-b: a water clutch armed with no bucket failed mid-fall).
	 */
	static String lacks(ServerPlayer player, ReflexSpec.Action action) {
		return lacks(action, index -> Held.of(player.getInventory().getItem(index)), player.getInventory().getSelectedSlot(), Held.of(player.getOffhandItem()));
	}

	/** One inventory slot as {@link #lacks} reads it: the item id (null when empty), and whether it is food or a cover block. */
	record Held(String id, boolean food, boolean coverBlock) {
		static final Held EMPTY = new Held(null, false, false);

		static Held of(ItemStack stack) {
			return stack.isEmpty() ? EMPTY : new Held(ReflexActions.id(stack), stack.get(DataComponents.FOOD) != null, PlaceBlock.coverBlock(stack));
		}
	}

	/**
	 * {@link #lacks(ServerPlayer, ReflexSpec.Action)} over inventory slots 0..35 (0..8 the hotbar), the selected hotbar
	 * slot and the offhand.
	 */
	static String lacks(ReflexSpec.Action action, java.util.function.IntFunction<Held> slots, int selected, Held offhand) {
		String item = action.text("item");
		return switch (action.type()) {
			case "place" -> holds(slots, offhand, 9, held -> item.equals(held.id())) ? null : "no " + item + " in hotbar or offhand";
			// The stance raises the shield it holds; it does not switch to one.
			case "shield" -> "minecraft:shield".equals(offhand.id()) || "minecraft:shield".equals(slots.apply(selected).id()) ? null : "no shield in either hand";
			case "eat" -> holds(slots, offhand, 9, Held::food) ? null : "no food in hotbar or offhand";
			case "place_block" -> holds(slots, Held.EMPTY, 9, held -> item != null ? item.equals(held.id()) : held.coverBlock()) ? null
					: "no " + (item != null ? item : "full block") + " in hotbar";
			case "select" -> item == null || holds(slots, offhand, 36, held -> item.equals(held.id())) ? null : "no " + item + " in inventory";
			default -> null;
		};
	}

	private static boolean holds(java.util.function.IntFunction<Held> slots, Held offhand, int count, java.util.function.Predicate<Held> wanted) {
		if (offhand.id() != null && wanted.test(offhand)) return true;
		for (int index = 0; index < count; index++) {
			Held held = slots.apply(index);
			if (held != null && held.id() != null && wanted.test(held)) return true;
		}
		return false;
	}

	/** Actions that stand and fight: a player stops them to breathe when the air runs short under water. */
	static boolean yieldsToBreath(ReflexSpec.Action action) {
		return "attack".equals(action.type());
	}

	private static AgentInputState look(ServerPlayer player, Vec3 target, float forward, float strafe, boolean jump,
			boolean use, int slot, InteractionHand hand) {
		float yaw = player.getYRot();
		float pitch = player.getXRot();
		if (target != null) {
			Vec3 delta = target.subtract(player.getEyePosition());
			double horizontal = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
			yaw = AgentInputStates.turnYaw(yaw, Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-delta.x, delta.z))));
			pitch = AgentInputStates.turnPitch(pitch, Mth.clamp((float) -Math.toDegrees(Math.atan2(delta.y, horizontal)), -90.0F, 90.0F));
		}
		return new AgentInputState(forward, strafe, jump, false, false, false, use, yaw, pitch, slot, hand);
	}

	static final long SHIELD_GRACE_TICKS = 10L;
	/** How far ahead a held shield turns to an incoming shot (the incoming_projectile default; a 180 degree turn takes ~5 ticks). */
	static final double SHIELD_SHOT_SECONDS = 1.0D;
	/** How long the shield stays toward where the last shot came from: a blaze volley is three shots over about a second. */
	static final long SHIELD_SHOT_HOLD_TICKS = 30L;

	/** How near a hostile mob must be for a raised shield to guard against it (a zombie hits from about 2 blocks). */
	static final double GUARD_RANGE = 3.5D;
	/** Widest spread of attackers, either side of the shield's facing, that one facing still covers (vanilla blocks to 90). */
	static final double GUARD_SPREAD_DEGREES = 75.0D;
	/** A melee mob's swing is followed by vanilla's 20-tick attack cooldown; a counter needs this many of them left. */
	static final long RECOVERY_TICKS = 20L;
	static final long COUNTER_WINDOW_TICKS = 8L;
	/** Ticks a counter may wait with the shield lowered for the swing to land before it raises the shield again. */
	static final int COUNTER_LOWERED_TICKS = 3;

	/**
	 * Raise the shield and hold it, facing what will hit next; reports blocks by shield wear. A player's shield arm:
	 * between shots it faces the melee attackers, all of them when one facing covers them (vanilla blocks hits from within
	 * 90 degrees of the view), else the one whose swing is due. With {@code counter} it strikes between their attacks: when
	 * the sword has recharged and every attacker near has just swung (its 20-tick cooldown runs), it lowers the shield,
	 * swings at the one in reach and raises it again (live run d19-iron-a: a stance blocked 13 hits from two zombies and
	 * never struck back while they wore the body down).
	 */
	static final class Shield implements Behaviour {
		private final boolean counter;
		private int lastDamage = -1;
		private int blocked;
		private int countered;
		private InteractionHand hand;
		private Vec3 shotFrom;
		private long shotTick;
		private boolean defers = true;
		private int lowered;
		private final Map<Integer, Long> swungAt = new java.util.HashMap<>();

		@Override
		public void end(ServerPlayer player) {
			dev.agaminggod.arenaagents.server.runtime.controller.BrinkGuard.keepLevel(player, this, false);
		}

		Shield() {
			this(false);
		}

		Shield(boolean counter) {
			this.counter = counter;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			dev.agaminggod.arenaagents.server.runtime.controller.BrinkGuard.keepLevel(player, this,
					context.below() == null && context.focus() instanceof net.minecraft.world.entity.monster.Blaze);
			InteractionHand current = player.getOffhandItem().is(Items.SHIELD) ? InteractionHand.OFF_HAND
					: player.getMainHandItem().is(Items.SHIELD) ? InteractionHand.MAIN_HAND : null;
			if (current == null) {
				// A player knows its shield just broke, and that only distance or cover helps now.
				String lost = hand != null ? "the shield broke after " + blocked + " blocked hit(s): " : "";
				return Step.failed(lost + "no shield in either hand; arm sprint_away or take_cover for this condition instead");
			}
			ItemStack shield = player.getItemInHand(current);
			// Each block wears the shield once (by a damage-scaled amount): count the wear events, not the points.
			if (hand == current && lastDamage >= 0 && shield.getDamageValue() > lastDamage) blocked++;
			hand = current;
			lastDamage = shield.getDamageValue();
			String held = (blocked == 0 ? "shield raised" : "blocked " + blocked + " hit(s)") + (countered > 0 ? ", countered " + countered : "");
			long now = player.level().getGameTime();
			// A player holding a shield turns it to the shot about to land, not to whichever mob is nearest.
			Entity shot = ReflexSensors.incomingShot(player, SHIELD_SHOT_SECONDS);
			if (shot != null) {
				shotFrom = ReflexSensors.aimPoint(shot);
				shotTick = now;
			}
			// Between the shots of a volley it stays toward where they come from.
			boolean volley = shotFrom != null && now - shotTick <= SHIELD_SHOT_HOLD_TICKS;
			// The fight raises this shield between its own swings (a player lowers it to hit), unless a shot is about to
			// land: then the shield stays up (live run d19-iron-a: three arrows hit for 4 each mid-fight under "shots").
			// Volley memory keeps an idle shield facing the shooter; only a shot still inbound interrupts a fight's swing.
			defers = context.fightShields() && shot == null;
			if (defers) return Step.running(held + " (fight)");
			List<Mob> close = attackers(player);
			for (Mob mob : close) if (swingJustStarted(mob)) swungAt.put(mob.getId(), now);
			AgentInputState below = context.below();
			if (counter && !volley && below == null) {
				Step strike = counter(player, context.focus(), close, now, input);
				if (strike != null) return strike;
			}
			Vec3 target = volley ? shotFrom : guardPoint(player, context.focus(), close, now);
			AgentInputState aim = look(player, target, 0.0F, 0.0F, false, true, player.getInventory().getSelectedSlot(), hand);
			if (below == null) {
				if (dev.agaminggod.arenaagents.server.runtime.controller.BrinkGuard.needsFooting(player)) {
					aim = new AgentInputState(0, 0, false, false, false, false, true, aim.yaw(), 40.0F,
							aim.selectedSlot(), aim.hand());
				}
				input.accept(aim);
				return Step.running(held);
			}
			// Walking behind the shield: the action's keys, re-pressed for the shield's view so the body keeps its course.
			float[] keys = keysFor(below.forward(), below.strafe(), below.yaw(), aim.yaw());
			int slot = hand == InteractionHand.OFF_HAND ? below.selectedSlot() : aim.selectedSlot();
			input.accept(new AgentInputState(keys[0], keys[1], below.jump(), below.sneak(), false, false, true,
					aim.yaw(), aim.pitch(), slot, hand).withMovementBasis(below));
			return Step.running(held + (keys[0] != 0.0F || keys[1] != 0.0F ? "; walking" : ""));
		}

		/**
		 * One tick of a counter, or null to keep guarding. Starts only with the sword recharged, the shield in the
		 * offhand, a hostile in reach and every attacker near inside its cooldown with {@link #COUNTER_WINDOW_TICKS} to go;
		 * then the use key is released and the swing lands once the shield is down, as vanilla drops attack clicks while an
		 * item is in use.
		 */
		private Step counter(ServerPlayer player, Entity focus, List<Mob> close, long now, Consumer<AgentInputState> input) {
			if (hand != InteractionHand.OFF_HAND) return null;
			var range = player.getAttackRangeWith(player.getMainHandItem());
			Mob target = focus instanceof Mob mob && close.contains(mob) && range.isInRange(player, mob.getBoundingBox(), 0.0D) ? mob : null;
			if (target == null) {
				for (Mob mob : close) {
					if (range.isInRange(player, mob.getBoundingBox(), 0.0D)) {
						target = mob;
						break;
					}
				}
			}
			if (lowered == 0) {
				if (target == null || close.isEmpty() || player.getAttackStrengthScale(0.5F) < CombatPlanning.READY_ATTACK_STRENGTH) return null;
				for (Mob mob : close) {
					Long swung = swungAt.get(mob.getId());
					if (swung == null || now - swung > RECOVERY_TICKS - COUNTER_WINDOW_TICKS) return null;
				}
			} else if (target == null || lowered > COUNTER_LOWERED_TICKS) {
				lowered = 0;
				return null;
			}
			lowered++;
			input.accept(look(player, target.getBoundingBox().getCenter(), 0.0F, 0.0F, false, false,
					player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			if (!player.isUsingItem() && Tracer.rayTrace(player, 1.0F, range.effectiveMaxRange(player), false) instanceof EntityHitResult hit
					&& hit.getEntity() == target) {
				player.attack(target);
				ArmSwing.attack(player, InteractionHand.MAIN_HAND);
				player.resetAttackStrengthTicker();
				player.resetLastActionTime();
				countered++;
				lowered = 0;
				return Step.running("countered " + type(target) + " between its attacks");
			}
			return Step.running("lowering the shield to counter " + type(target));
		}

		/**
		 * Where the shield faces with no shot coming: toward every hostile within {@link #GUARD_RANGE} when one facing
		 * covers them all, else the nearest whose attack is not cooling down, else the condition's mob.
		 */
		private Vec3 guardPoint(ServerPlayer player, Entity focus, List<Mob> close, long now) {
			Vec3 fallback = focus == null || !focus.isAlive() ? null : ReflexSensors.aimPoint(focus);
			if (close.size() < 2) return fallback != null || close.isEmpty() ? fallback : ReflexSensors.aimPoint(close.getFirst());
			Vec3 eye = player.getEyePosition();
			double sumX = 0.0D, sumZ = 0.0D, sumY = 0.0D;
			for (Mob mob : close) {
				Vec3 to = ReflexSensors.aimPoint(mob).subtract(eye);
				double length = Math.hypot(to.x, to.z);
				if (length < 1.0E-3D) continue;
				sumX += to.x / length;
				sumZ += to.z / length;
				sumY += ReflexSensors.aimPoint(mob).y;
			}
			double meanLength = Math.hypot(sumX, sumZ);
			boolean covered = meanLength > 1.0E-3D;
			for (Mob mob : close) {
				Vec3 to = ReflexSensors.aimPoint(mob).subtract(eye);
				double length = Math.hypot(to.x, to.z);
				if (length < 1.0E-3D || !covered) continue;
				double cos = (to.x * sumX + to.z * sumZ) / (length * meanLength);
				if (Math.toDegrees(Math.acos(Mth.clamp(cos, -1.0D, 1.0D))) > GUARD_SPREAD_DEGREES) covered = false;
			}
			if (covered) return new Vec3(eye.x + sumX / meanLength * 2.0D, sumY / close.size(), eye.z + sumZ / meanLength * 2.0D);
			for (Mob mob : close) {
				Long swung = swungAt.get(mob.getId());
				if (swung == null || now - swung >= RECOVERY_TICKS - 5L) return ReflexSensors.aimPoint(mob);
			}
			return ReflexSensors.aimPoint(close.getFirst());
		}

		/** Hostile mobs within {@link #GUARD_RANGE} that the player can see, nearest first. */
		/** Old swinging && swingTime <= 1: swingTime started at -1 and rose each tick, 26.3 ticks start at 0. */
		private static boolean swingJustStarted(Mob mob) {
			LivingEntity.SwingState swing = ((LivingEntitySwingStateAccessor) mob).arenaagents$swingState();
			return mob.isSwinging() && ((SwingStateAccessor) swing).arenaagents$ticks() <= 2;
		}

		private static List<Mob> attackers(ServerPlayer player) {
			List<Mob> mobs = new ArrayList<>(player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(GUARD_RANGE),
					mob -> mob.isAlive() && ThreatPerception.isHostileTo(mob, player) && !mob.isInvisibleTo(player)
							&& player.distanceTo(mob) <= GUARD_RANGE && player.hasLineOfSight(mob)));
			mobs.sort(java.util.Comparator.comparingDouble(player::distanceTo));
			return mobs;
		}

		@Override
		public boolean holdsWhileTrue() { return true; }

		@Override
		public boolean passesMovement() { return true; }

		@Override
		public boolean defersToFight() { return defers; }

		/** A blaze volley is three shots about 0.3 s apart: a player keeps the shield up between them. */
		@Override
		public long releaseGraceTicks() { return SHIELD_GRACE_TICKS; }
	}

	/**
	 * Movement keys {forward, strafe} that move the body the same way as {@code forward}/{@code strafe} pressed while
	 * facing {@code fromYaw}, now pressed while facing {@code toYaw}, retaining analog length and direction.
	 */
	static float[] keysFor(float forward, float strafe, float fromYaw, float toYaw) {
		// Vanilla normalizes axes longer than one before movement. Rotate that effective input, so every
		// orientation fits AgentInputState's axis bounds without clipping or snapping small analog movement.
		double length = Math.hypot(forward, strafe);
		if (length > 1.0D) { forward /= (float) length; strafe /= (float) length; }
		double turn = Math.toRadians(fromYaw - toYaw);
		double rotatedStrafe = strafe * Math.cos(turn) - forward * Math.sin(turn);
		double rotatedForward = forward * Math.cos(turn) + strafe * Math.sin(turn);
		return new float[]{(float) rotatedForward, (float) rotatedStrafe};
	}

	/** Aim at the focus and swing when the crosshair is on it and the attack has recharged; a trigger swings once. */
	static final class Attack implements Behaviour {
		/** A mob just outside reach is faced and awaited this long, as a player turns and swings when it arrives. */
		private static final int APPROACH_TICKS = 20;
		private int hits;
		private int waited;

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			if (!(context.focus() instanceof LivingEntity target) || !target.isAlive()) {
				return hits > 0 ? Step.done(hits + " hit(s)") : Step.failed("no target in reach");
			}
			var range = player.getAttackRangeWith(player.getMainHandItem());
			// The dragon's root is not pickable: a player hits it through a part, the head taking full damage.
			Entity aim = target instanceof EnderDragon dragon ? dragonPart(player, dragon) : target;
			if (!range.isInRange(player, aim.getBoundingBox(), 0.0D)) {
				if (hits > 0) return Step.done(hits + " hit(s)");
				if (++waited > APPROACH_TICKS || player.distanceTo(aim) > range.effectiveMaxRange(player) + 2.0D) return Step.failed("target out of reach");
				input.accept(look(player, aim.getBoundingBox().getCenter(), 0.0F, 0.0F, false, false,
						player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
				return Step.running("facing " + type(target));
			}
			input.accept(look(player, aim.getBoundingBox().getCenter(), 0.0F, 0.0F, false, false,
					player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			boolean ready = player.getAttackStrengthScale(0.5F) >= CombatPlanning.READY_ATTACK_STRENGTH && !player.isUsingItem();
			if (ready && Tracer.rayTrace(player, 1.0F, range.effectiveMaxRange(player), false) instanceof EntityHitResult hit
					&& (hit.getEntity() == target || hit.getEntity() instanceof EnderDragonPart part && part.parentMob == target)) {
				player.attack(hit.getEntity());
				ArmSwing.attack(player, InteractionHand.MAIN_HAND);
				player.resetAttackStrengthTicker();
				player.resetLastActionTime();
				hits++;
				if (!context.stance()) return Step.done("hit " + type(target));
			}
			return Step.running(hits + " hit(s)");
		}
	}

	/** The dragon part a swing aims at: the head when in reach, else the nearest part in reach, else the head. */
	static Entity dragonPart(ServerPlayer player, EnderDragon dragon) {
		var range = player.getAttackRangeWith(player.getMainHandItem());
		Entity best = null;
		double nearest = Double.POSITIVE_INFINITY;
		for (EnderDragonPart part : dragon.getSubEntities()) {
			if (part == null || !range.isInRange(player, part.getBoundingBox(), 0.0D)) continue;
			if (part == dragon.head) return part;
			double distance = part.getBoundingBox().distanceToSqr(player.getEyePosition());
			if (distance < nearest) { nearest = distance; best = part; }
		}
		return best != null ? best : dragon.head;
	}

	/** Back away from the focus (or from the view) onto known safe footing, facing what it backs from. */
	static final class StepBack implements Behaviour {
		private static final float[] OFFSETS = {0.0F, 45.0F, -45.0F, 90.0F, -90.0F};
		private final double blocks;
		private Vec3 start;
		private int ticks;
		private float awayYaw = Float.NaN;
		private Float lastHeading;

		StepBack(double blocks) {
			this.blocks = blocks;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			if (start == null) start = player.position();
			ticks++;
			double moved = Math.hypot(player.getX() - start.x, player.getZ() - start.z);
			if (moved >= blocks) return Step.done(String.format(Locale.ROOT, "stepped back %.1f blocks", moved));
			Entity focus = context.focus() != null && context.focus().isAlive() ? context.focus() : null;
			if (focus != null) {
				Vec3 delta = player.position().subtract(focus.position());
				awayYaw = (float) Math.toDegrees(Math.atan2(-delta.x, delta.z));
			} else if (Float.isNaN(awayYaw)) {
				awayYaw = player.getYRot() + 180.0F;
			}
			Float heading = SafeStep.heading(player, awayYaw, OFFSETS, lastHeading);
			lastHeading = heading;
			if (heading == null) {
				return moved >= 0.3D ? Step.done(String.format(Locale.ROOT, "stepped back %.1f blocks; no safe cell further", moved))
						: Step.failed("no safe cell behind");
			}
			if (ticks >= 20 && moved < 0.2D) return Step.failed("blocked while stepping back");
			AgentInputState aim = look(player, focus == null ? null : focus.getBoundingBox().getCenter(), 0.0F, 0.0F, false, false,
					player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND);
			// Keys relative to the view: backpedal and strafe toward the safe heading while still facing the threat.
			float relative = (float) Math.toRadians(AgentInputStates.shortestAngleDelta(aim.yaw(), heading));
			float forward = clean((float) Math.cos(relative));
			float strafe = clean(-(float) Math.sin(relative));
			input.accept(new AgentInputState(forward, strafe, false, false, false, false, false,
					aim.yaw(), aim.pitch(), aim.selectedSlot(), aim.hand()));
			return Step.running(String.format(Locale.ROOT, "stepping back %.1f/%.1f", moved, blocks));
		}

		private static float clean(float value) {
			return Math.abs(value) < 1.0E-4F ? 0.0F : Mth.clamp(value, -1.0F, 1.0F);
		}
	}

	/** Eat the most nourishing food that can be eaten now, from the offhand or the hotbar. */
	static final class Eat implements Behaviour {
		private int slot = -2;
		private InteractionHand hand;
		private String item;
		private int count;

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			if (slot == -2) {
				if (edible(player, player.getOffhandItem()) != null) {
					hand = InteractionHand.OFF_HAND;
					slot = player.getInventory().getSelectedSlot();
				} else {
					int best = -1;
					int nutrition = -1;
					for (int index = 0; index < 9; index++) {
						FoodProperties food = edible(player, player.getInventory().getItem(index));
						if (food != null && food.nutrition() > nutrition) {
							nutrition = food.nutrition();
							best = index;
						}
					}
					if (best < 0) return Step.failed(anyFood(player) ? "hunger is full" : "no food in hotbar or offhand");
					hand = InteractionHand.MAIN_HAND;
					slot = best;
				}
				ItemStack stack = hand == InteractionHand.OFF_HAND ? player.getOffhandItem() : player.getInventory().getItem(slot);
				item = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
				count = stack.getCount();
			}
			ItemStack now = hand == InteractionHand.OFF_HAND ? player.getOffhandItem() : player.getInventory().getItem(slot);
			if (now.isEmpty() || !item.equals(BuiltInRegistries.ITEM.getKey(now.getItem()).toString()) || now.getCount() < count) {
				return Step.done("ate " + item);
			}
			input.accept(new AgentInputState(0.0F, 0.0F, false, false, false, false, true,
					player.getYRot(), player.getXRot(), slot, hand));
			return Step.running("eating " + item);
		}

		private static FoodProperties edible(ServerPlayer player, ItemStack stack) {
			FoodProperties food = stack.isEmpty() ? null : stack.get(DataComponents.FOOD);
			return food != null && player.canEat(food.canAlwaysEat()) ? food : null;
		}

		private static boolean anyFood(ServerPlayer player) {
			for (int index = 0; index < 9; index++) {
				if (player.getInventory().getItem(index).get(DataComponents.FOOD) != null) return true;
			}
			return player.getOffhandItem().get(DataComponents.FOOD) != null;
		}
	}

	/**
	 * Pick the slot with the named item or the best tool of a kind ("any": the kind that just broke). In the hotbar it is
	 * one number key; in the main inventory the screen opens, the stack is swapped into the hotbar with its number key,
	 * and the screen closes, paced as a player does it (the body stands still while the screen is open). A tool at or
	 * below a holding tool_low threshold is not a replacement.
	 */
	static final class Select implements Behaviour {
		/** Same pacing as the select_tool transaction: the screen is shown 2 ticks before the swap and 2 after. */
		static final int OPEN_TICKS = 2;
		static final int LINGER_TICKS = 2;
		private final String tool;
		private final String item;
		private int ticks;
		private int source = -1;
		private int hotbar = -1;
		private boolean screen;
		private String swapped;

		Select(String tool, String item) {
			this.tool = tool;
			this.item = item;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			ticks++;
			if (screen) return paced(player, input);
			String kind = "any".equals(tool) ? context.memory().brokeKind() : tool;
			if (item == null && kind == null) return Step.failed("no tool has broken yet to match");
			String preferred = "any".equals(tool) || tool != null && tool.equals(context.memory().brokeKind()) ? context.memory().brokeItem() : null;
			int low = item == null ? context.memory().lowUses() : -1;
			int best = best(player, kind, preferred, low, 0, 9);
			String wanted = item != null ? item : kind;
			if (best >= 0) {
				input.accept(still(player, best));
				return Step.done("selected " + id(player.getInventory().getItem(best)) + " in slot " + best);
			}
			int stored = best(player, kind, preferred, low, 9, 36);
			if (stored < 0) return Step.failed("no " + wanted + (low >= 0 ? " with more than " + low + " uses left" : "") + " in inventory");
			if (player.containerMenu != player.inventoryMenu) return Step.failed("a container screen is open; " + wanted + " is in the main inventory");
			if (!player.inventoryMenu.getCarried().isEmpty()) return Step.failed("a stack is held on the cursor");
			source = stored;
			hotbar = hotbarFor(player, kind, low);
			screen = true;
			ticks = 0;
			AgentInventoryView.open(player);
			input.accept(still(player, player.getInventory().getSelectedSlot()));
			return Step.running("opening inventory for " + id(player.getInventory().getItem(source)));
		}

		private Step paced(ServerPlayer player, Consumer<AgentInputState> input) {
			if (swapped == null) {
				if (ticks < OPEN_TICKS) {
					input.accept(still(player, player.getInventory().getSelectedSlot()));
					return Step.running("inventory open");
				}
				String moving = id(player.getInventory().getItem(source));
				var refused = AdvancedInteractionService.swapIntoHotbar(player, source, hotbar);
				if (refused != null) {
					end(player);
					return Step.failed("swap refused: " + refused.message());
				}
				swapped = moving;
				ticks = 0;
			}
			input.accept(still(player, hotbar));
			if (ticks < LINGER_TICKS) return Step.running("swapped " + swapped + " into slot " + hotbar);
			end(player);
			return Step.done("moved " + swapped + " from inventory slot " + source + " to hotbar " + hotbar + " and selected it");
		}

		@Override
		public void end(ServerPlayer player) {
			if (screen && AgentInventoryView.isOpen(player)) AgentInventoryView.close(player);
			screen = false;
		}

		private int best(ServerPlayer player, String kind, String preferred, int low, int from, int to) {
			int best = -1;
			double score = Double.NEGATIVE_INFINITY;
			for (int index = from; index < to; index++) {
				ItemStack stack = player.getInventory().getItem(index);
				if (!matches(stack, kind) || low >= 0 && stack.isDamageableItem() && stack.getMaxDamage() - stack.getDamageValue() <= low) continue;
				double value = rank(stack, kind) + (preferred != null && preferred.equals(id(stack)) ? 1_000.0D : 0.0D);
				if (value > score) {
					score = value;
					best = index;
				}
			}
			return best;
		}

		/**
		 * The hotbar slot the stack goes to: the held slot when it is empty or holds the worn tool being replaced (the
		 * worn one goes back into the inventory), else an empty hotbar slot, else the held slot.
		 */
		private static int hotbarFor(ServerPlayer player, String kind, int low) {
			int selected = player.getInventory().getSelectedSlot();
			ItemStack held = player.getInventory().getItem(selected);
			if (held.isEmpty() || low >= 0 && kind != null && kind.equals(ReflexSensors.toolKind(held))) return selected;
			for (int index = 0; index < 9; index++) if (player.getInventory().getItem(index).isEmpty()) return index;
			return selected;
		}

		private static AgentInputState still(ServerPlayer player, int slot) {
			return new AgentInputState(0.0F, 0.0F, false, false, false, false, false,
					player.getYRot(), player.getXRot(), slot, InteractionHand.MAIN_HAND);
		}

		private boolean matches(ItemStack stack, String kind) {
			if (stack.isEmpty()) return false;
			return item != null ? item.equals(id(stack)) : kind.equals(ReflexSensors.toolKind(stack));
		}

		private static double rank(ItemStack stack, String kind) {
			if (kind == null) return 0.0D;
			return switch (kind) {
				case "pickaxe" -> stack.getDestroySpeed(Blocks.STONE.defaultBlockState());
				case "axe" -> stack.getDestroySpeed(Blocks.OAK_LOG.defaultBlockState());
				case "shovel" -> stack.getDestroySpeed(Blocks.DIRT.defaultBlockState());
				case "hoe" -> stack.getDestroySpeed(Blocks.HAY_BLOCK.defaultBlockState());
				default -> stack.getMaxDamage();
			};
		}

		@Override
		public boolean keepsSelection() { return true; }
	}

	/**
	 * Walk to a dropped item a few blocks away (the focus of item_nearby, else the nearest one in view) and let vanilla
	 * pick it up on contact. A short straight walk over known safe footing, jumping a one-block step; anything farther or
	 * blocked fails back to the program.
	 */
	static final class Pickup implements Behaviour {
		private final double within;
		private ItemEntity target;
		private ItemStack identity;
		private int before;
		private int ticks;
		private double bestDistance = Double.POSITIVE_INFINITY;
		private int stalled;

		Pickup(double within) {
			this.within = within;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			if (target == null) {
				target = context.focus() instanceof ItemEntity focused ? focused : nearest(player);
				if (target == null) return Step.failed("no dropped item in view within " + trim(within) + " blocks");
				identity = target.getItem().copy();
				before = count(player, identity);
			}
			ticks++;
			int now = count(player, identity);
			if (now > before) return Step.done("picked up " + (now - before) + " " + id(identity));
			if (!target.isAlive() || target.getItem().isEmpty()) return Step.failed(id(identity) + " is gone (picked up by something else or despawned)");
			if (!InventoryRoom.canTake(player, target.getItem())) return Step.failed("inventory full for " + id(identity));
			double distance = Math.hypot(target.getX() - player.getX(), target.getZ() - player.getZ());
			if (distance > within + 1.0D) return Step.failed(id(identity) + " moved out of reach (" + String.format(Locale.ROOT, "%.1f", distance) + " blocks)");
			if (distance + 0.05D < bestDistance) {
				bestDistance = distance;
				stalled = 0;
			} else if (++stalled >= 20) {
				return Step.failed("blocked walking to " + id(identity));
			}
			Vec3 delta = target.position().subtract(player.position());
			float heading = Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-delta.x, delta.z)));
			boolean close = distance < 0.6D;
			if (!close && !SafeStep.canStep(player, heading)) return Step.failed("no safe footing toward " + id(identity));
			AgentInputState aim = look(player, target.position(), 0.0F, 0.0F, false, false, player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND);
			float relative = (float) Math.toRadians(AgentInputStates.shortestAngleDelta(aim.yaw(), heading));
			float forward = close ? 0.0F : Mth.clamp((float) Math.cos(relative), -1.0F, 1.0F);
			float strafe = close ? 0.0F : Mth.clamp(-(float) Math.sin(relative), -1.0F, 1.0F);
			boolean jump = player.horizontalCollision && player.onGround() && target.getY() > player.getY() + 0.5D;
			input.accept(new AgentInputState(forward, strafe, jump, false, false, false, false, aim.yaw(), aim.pitch(), aim.selectedSlot(), aim.hand()));
			return Step.running(String.format(Locale.ROOT, "walking to %s %.1f blocks", id(identity), distance));
		}

		private ItemEntity nearest(ServerPlayer player) {
			var frame = dev.agaminggod.arenaagents.server.perception.ObservationVisibility.frame(player.level(), player);
			ItemEntity best = null;
			double bestDistance = Double.POSITIVE_INFINITY;
			for (ItemEntity item : player.level().getEntitiesOfClass(ItemEntity.class, player.getBoundingBox().inflate(within), ItemEntity::isAlive)) {
				double distance = player.distanceTo(item);
				if (distance > within || distance >= bestDistance || !InventoryRoom.canTake(player, item.getItem()) || !frame.canSeeEntity(item)) continue;
				bestDistance = distance;
				best = item;
			}
			return best;
		}

		private static int count(ServerPlayer player, ItemStack identity) {
			int count = 0;
			for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (!stack.isEmpty() && ItemStack.isSameItemSameComponents(stack, identity)) count += stack.getCount();
			}
			return count;
		}
	}

	/**
	 * Place the named item from the hotbar or offhand, with a player's right click on a face in reach: {@code below} the
	 * feet (a block under a gap, a torch at the feet, water under a fall once the ground is in reach) or {@code ahead}
	 * (the feet-level cell in front of the view: a block into flowing water or a hole, a torch on the floor). The view
	 * turns at player speed and the click lands only when the crosshair is on that face.
	 */
	static final class Place implements Behaviour {
		/** Ticks of horizontal motion a fall clutch leads its aim by: the body moves on between the click and the landing. */
		static final double CLUTCH_LEAD_TICKS = 2.0D;
		private final String item;
		private final String where;
		private int ticks;
		/** The water source a fall clutch placed, while the body lands and scoops it back. */
		private BlockPos placedWater;
		private InteractionHand placedHand;
		private int placedSlot;
		private int landedTicks;

		Place(String item, String where) {
			this.item = item;
			this.where = where;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			ticks++;
			if (placedWater != null) return scoop(player, input);
			InteractionHand hand;
			int slot = player.getInventory().getSelectedSlot();
			if (item.equals(id(player.getOffhandItem()))) hand = InteractionHand.OFF_HAND;
			else {
				hand = InteractionHand.MAIN_HAND;
				slot = -1;
				for (int index = 0; index < 9; index++) if (item.equals(id(player.getInventory().getItem(index)))) {
					slot = index;
					if (index == player.getInventory().getSelectedSlot()) break;
				}
				if (slot < 0) return Step.failed("no " + item + " in hotbar or offhand");
			}
			boolean bucket = (hand == InteractionHand.OFF_HAND ? player.getOffhandItem() : player.getInventory().getItem(slot)).getItem() instanceof net.minecraft.world.item.BucketItem;
			Level level = player.level();
			BlockPos feet = player.blockPosition();
			BlockHitResult crosshair;
			if (bucket && "below".equals(where) && !player.onGround() && !player.isInWater()) {
				// A fall clutch as a player does it: look down where the body will land and click the moment the crosshair
				// is on ground in reach. Leading the landing matters in a throw (the body crosses most of a block per tick),
				// and the click takes whatever top face the crosshair is on: waiting for one exact face missed the one or
				// two ticks a fast fall has the ground in reach (live End deaths 2026-10-21: "could not aim at the below face").
				Vec3 motion = player.getDeltaMovement();
				Vec3 landing = player.getEyePosition().add(motion.x * CLUTCH_LEAD_TICKS, -4.0D, motion.z * CLUTCH_LEAD_TICKS);
				input.accept(look(player, landing, 0.0F, 0.0F, false, false, slot, hand));
				if (player.getInventory().getSelectedSlot() != slot && hand == InteractionHand.MAIN_HAND) return Step.running("selecting " + item);
				crosshair = level.clip(new ClipContext(player.getEyePosition(), player.getEyePosition().add(player.getLookAngle().scale(player.blockInteractionRange())),
						ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
				if (crosshair.getType() != HitResult.Type.BLOCK || crosshair.getDirection() != Direction.UP
						|| !level.getBlockState(crosshair.getBlockPos().above()).canBeReplaced()) {
					return Step.running("falling; ground not in reach yet");
				}
			} else {
				// feet: a bucket empties on the ground under you and the water stays, the puddle a player stands in against endermen.
				Click click = bucket && ("below".equals(where) || "feet".equals(where)) ? waterBelow(player) : target(player, level, feet, bucket);
				if (click == null) return Step.failed("nothing to place against " + where);
				AgentInputState aim = look(player, click.point(), 0.0F, 0.0F, false, false, slot, hand);
				input.accept(aim);
				if (player.getInventory().getSelectedSlot() != slot && hand == InteractionHand.MAIN_HAND) return Step.running("selecting " + item);
				crosshair = level.clip(new ClipContext(player.getEyePosition(), player.getEyePosition().add(player.getLookAngle().scale(player.blockInteractionRange())),
						ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
				if (crosshair.getType() != HitResult.Type.BLOCK || !crosshair.getBlockPos().equals(click.against()) || crosshair.getDirection() != click.face()) {
					return ticks > 20 ? Step.failed("could not aim at the " + where + " face") : Step.running("aiming " + where);
				}
			}
			ItemStack held = player.getItemInHand(hand);
			int count = held.getCount();
			InteractionResult result = player.gameMode.useItemOn(player, level, held, hand, crosshair);
			if (!result.consumesAction() && !(result instanceof InteractionResult.Fail)) result = player.gameMode.useItem(player, level, held, hand);
			if (!result.consumesAction()) return Step.failed("the click on the " + where + " face was refused");
			ArmSwing.use(player, hand);
			boolean used = player.getItemInHand(hand).getCount() < count || !item.equals(id(player.getItemInHand(hand))) || player.isCreative();
			if (used && bucket && "below".equals(where) && level.getFluidState(crosshair.getBlockPos().above()).isSourceOfType(net.minecraft.world.level.material.Fluids.WATER)) {
				// The clutch is finished as a player finishes it: land, then scoop the source back. Left in place, its flow
				// carried a landed body 4 blocks off an End island into the void (live run d6-end-b).
				placedWater = crosshair.getBlockPos().above();
				placedHand = hand;
				placedSlot = hand == InteractionHand.MAIN_HAND ? slot : player.getInventory().getSelectedSlot();
				return Step.running("placed " + item + " below; landing");
			}
			if (used && bucket && "feet".equals(where)) {
				BlockPos source = crosshair.getBlockPos().above();
				return Step.done("placed " + item + " at feet " + source.getX() + "," + source.getY() + "," + source.getZ() + "; the source stays until scooped");
			}
			return used ? Step.done("placed " + item + " " + where) : Step.failed("click accepted but nothing was placed");
		}

		/** After a water clutch: once the body has landed, use the emptied bucket on the source to take it back. */
		private Step scoop(ServerPlayer player, Consumer<AgentInputState> input) {
			Level level = player.level();
			if (!level.getFluidState(placedWater).isSourceOfType(net.minecraft.world.level.material.Fluids.WATER)) {
				return Step.done("placed water below; the source is gone");
			}
			if (!player.onGround() && !player.isInWater()) {
				return ticks > 60 ? Step.done("placed water below; still airborne") : Step.running("landing in the placed water");
			}
			if (++landedTicks > 30) return Step.done("placed water below and landed; could not scoop it back");
			ItemStack held = player.getItemInHand(placedHand);
			if (!held.is(net.minecraft.world.item.Items.BUCKET)) return Step.done("placed water below and landed; no empty bucket in hand to scoop it back");
			Vec3 centre = Vec3.atCenterOf(placedWater);
			input.accept(look(player, centre, 0.0F, 0.0F, false, false, placedSlot, placedHand));
			BlockHitResult sight = level.clip(new ClipContext(player.getEyePosition(), player.getEyePosition().add(player.getLookAngle().scale(player.blockInteractionRange())),
					ClipContext.Block.OUTLINE, ClipContext.Fluid.SOURCE_ONLY, player));
			if (sight.getType() != HitResult.Type.BLOCK || !sight.getBlockPos().equals(placedWater)) return Step.running("landed; aiming at the placed water");
			InteractionResult result = player.gameMode.useItem(player, level, held, placedHand);
			if (result.consumesAction() && player.getItemInHand(placedHand).is(net.minecraft.world.item.Items.WATER_BUCKET)) {
				ArmSwing.use(player, placedHand);
				return Step.done("placed water below, landed and scooped it back");
			}
			return Step.running("landed; scooping the placed water");
		}

		private record Click(BlockPos against, Direction face, Vec3 point) {
		}

		/** The face to click so the item lands in the target cell, or null when nothing solid is beside it in reach. */
		private Click target(ServerPlayer player, Level level, BlockPos feet, boolean bucket) {
			BlockPos cell;
			if (!"ahead".equals(where)) {
				BlockPos under = feet.below();
				// Standing on something: the item goes at the feet on its top (a torch); over a gap: into the gap.
				cell = level.getBlockState(under).canBeReplaced() ? under : feet;
			} else {
				Direction facing = player.getDirection();
				cell = feet.relative(facing);
			}
			if (!level.getBlockState(cell).canBeReplaced()) return null;
			Direction[] order = {Direction.DOWN, Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST, Direction.UP};
			for (Direction side : order) {
				BlockPos against = cell.relative(side);
				var state = level.getBlockState(against);
				if (state.canBeReplaced() || state.getCollisionShape(level, against).isEmpty()) continue;
				Direction face = side.getOpposite();
				Vec3 point = Vec3.atCenterOf(against).add(Vec3.atLowerCornerOf(face.getUnitVec3i()).scale(0.5D));
				if (point.distanceTo(player.getEyePosition()) > player.blockInteractionRange()) continue;
				if (bucket) return new Click(against, face, point);
				return new Click(against, face, point);
			}
			return null;
		}

		/** Water under a fall: the first solid top face straight down within reach. */
		private static Click waterBelow(ServerPlayer player) {
			Level level = player.level();
			Vec3 eye = player.getEyePosition();
			BlockHitResult hit = level.clip(new ClipContext(eye, eye.add(0.0D, -player.blockInteractionRange(), 0.0D), ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, player));
			if (hit.getType() != HitResult.Type.BLOCK || hit.getDirection() != Direction.UP) return null;
			return new Click(hit.getBlockPos(), Direction.UP, Vec3.atCenterOf(hit.getBlockPos()).add(0.0D, 0.5D, 0.0D));
		}
	}

	/**
	 * Stop where you are: the body holds still (the paused action does not resume) until the coordinator, seeing this
	 * firing, has cancelled the running program or action; then the firing ends and wakes the model.
	 */
	static final class Stop implements Behaviour {
		private int ticks;
		private boolean running;

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			ticks++;
			if (ticks == 1) running = context.memory().actionActive();
			if (ticks > 1 && !context.memory().actionActive()) return Step.done(running ? "stopped the running action" : "stopped (nothing was running)");
			input.accept(new AgentInputState(0.0F, 0.0F, false, false, false, false, false,
					player.getYRot(), player.getXRot(), player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			return Step.running("holding still; stopping the running work");
		}
	}

	private static String trim(double value) {
		return value == Math.rint(value) ? Long.toString((long) value) : Double.toString(value);
	}

	/**
	 * Swim to air until the eyes are out of the water for half a second: along the route to the nearest breathable cell
	 * the player has seen (the observation's {@code breathable}), which is straight up under open water and around the
	 * ceiling of a flooded tunnel. With no seen air, hold jump with the view tilted up.
	 */
	static final class SwimUp implements Behaviour {
		private boolean wasInWater;
		private int surfacedTicks;
		private int ticks;
		private final SwimAirProgress progress = new SwimAirProgress();

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			boolean inWater = player.isInWater() || player.isUnderWater();
			if (inWater) wasInWater = true;
			if (!wasInWater) return Step.failed("not in water");
			surfacedTicks = player.isUnderWater() ? 0 : surfacedTicks + 1;
			if (surfacedTicks >= 10 || !inWater) return Step.done("surfaced");
			ticks++;
			var surface = airRoute(player);
			if (surface == null) {
				input.accept(riseBlind(player));
				return Step.running("swimming up");
			}
			BlockPos nextDestination = new BlockPos(surface.x(), surface.openY(), surface.z());
			double left = SwimAirProgress.remaining(player.getEyePosition(), surface.path());
			if (progress.stalled(nextDestination, left, ticks)) {
				return Step.failed(String.format(Locale.ROOT, "no progress swimming to air at %d,%d,%d (%.1f blocks left)",
						surface.x(), surface.openY(), surface.z(), left));
			}
			input.accept(swimToAir(player, surface));
			return Step.running(String.format(Locale.ROOT, "swimming to air at %d,%d,%d, %.1f blocks", surface.x(), surface.openY(), surface.z(), left));
		}
	}

	/** The route to the nearest breathable cell the player has seen, while the eyes are under water; null when none is known. */
	static dev.agaminggod.arenaagents.server.runtime.controller.SwimPlanning.Surface airRoute(ServerPlayer player) {
		var surface = player.isUnderWater() ? WaterAirFacts.surface(player).surface() : null;
		return surface == null || surface.path().size() < 2 ? null : surface;
	}

	/** No air seen: hold jump with the view tilted up, as a player rises blind. */
	static AgentInputState riseBlind(ServerPlayer player) {
		float pitch = AgentInputStates.turnPitch(player.getXRot(), -45.0F);
		return new AgentInputState(0.0F, 0.0F, true, false, false, false, false, player.getYRot(), pitch,
				player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND);
	}

	/** One tick of swimming along {@code surface}'s route: aim at the next cell (the path starts at the eye cell), rising to it. */
	static AgentInputState swimToAir(ServerPlayer player, dev.agaminggod.arenaagents.server.runtime.controller.SwimPlanning.Surface surface) {
		Vec3 eye = player.getEyePosition();
		BlockPos next = surface.path().get(1);
		Vec3 target = new Vec3(next.getX() + 0.5D, Math.max(next.getY() + 0.25D, eye.y), next.getZ() + 0.5D);
		double dx = target.x - eye.x, dz = target.z - eye.z;
		boolean across = dx * dx + dz * dz > 0.04D;
		float heading = across ? Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-dx, dz))) : player.getYRot();
		float yaw = AgentInputStates.turnYaw(player.getYRot(), heading);
		float pitch = AgentInputStates.turnPitch(player.getXRot(), target.y > eye.y + 0.05D ? SwimPlanning.SURFACING_PITCH : 0.0F);
		float forward = across ? CombatPlanning.alignedForward(1.0F, AgentInputStates.shortestAngleDelta(yaw, heading)) : 0.0F;
		boolean sprint = SwimPlanning.swimSprint(true, true, forward, player.getFoodData().getFoodLevel());
		return new AgentInputState(forward, 0.0F, true, false, sprint, false, false, yaw, pitch,
				player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND);
	}

	/**
	 * Punch a fireball back, as a player does: aim at it and swing when the crosshair is on it inside entity reach.
	 * Vanilla sends only {@code #redirectable_projectile} (ghast fireballs, wind charges) back along the view; the hit
	 * makes the player its owner, which ends the firing.
	 */
	static final class Deflect implements Behaviour {
		private int swings;

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			Entity focus = context.focus();
			if (!(focus instanceof Projectile projectile) || !projectile.isAlive()) {
				return swings > 0 ? Step.done("deflected the fireball") : Step.failed("no fireball to deflect");
			}
			if (projectile.getOwner() == player) return Step.done("deflected " + type(projectile));
			if (!ReflexSensors.redirectable(projectile)) return Step.failed(type(projectile) + " cannot be deflected; shield or dodge it");
			// Lead by one tick: the view lands where the fireball will be when the swing resolves.
			Vec3 aim = projectile.getBoundingBox().getCenter().add(projectile.getDeltaMovement());
			input.accept(look(player, aim, 0.0F, 0.0F, false, false, player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			double reach = player.entityInteractionRange();
			if (!player.isUsingItem() && Tracer.rayTrace(player, 1.0F, reach, false) instanceof EntityHitResult hit && hit.getEntity() == projectile) {
				player.attack(projectile);
				ArmSwing.attack(player, InteractionHand.MAIN_HAND);
				player.resetAttackStrengthTicker();
				player.resetLastActionTime();
				swings++;
			}
			return Step.running(swings == 0 ? "tracking fireball" : "swung " + swings + "x");
		}

		@Override
		public boolean holdsWhileTrue() { return true; }
	}

	/** How far a fallback threat (a condition that names no mob, such as low health) is looked for. */
	static final double WATCHER_RANGE = 24.0D;

	/** Hostile mobs within range that can see the player (they can shoot or charge it), nearest first. */
	static List<Mob> watchers(ServerPlayer player) {
		List<Mob> mobs = new ArrayList<>(player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(WATCHER_RANGE),
				mob -> mob.isAlive() && ThreatPerception.isHostileTo(mob, player) && !mob.isInvisibleTo(player)
						&& player.distanceTo(mob) <= WATCHER_RANGE && mob.hasLineOfSight(player)));
		mobs.sort(java.util.Comparator.comparingDouble(player::distanceTo));
		return mobs;
	}

	/** Sprinting needs food above 6, as for a player. */
	private static boolean canSprint(ServerPlayer player) {
		return player.getFoodData().getFoodLevel() > 6 || player.getAbilities().mayfly;
	}

	/** Walk the body toward a cell centre: face it, press forward when facing it, jump a step up, sprint if asked. */
	private static AgentInputState walkToward(ServerPlayer player, GridPosition cell, boolean sprint) {
		Vec3 centre = new Vec3(cell.x() + 0.5D, player.getEyeY(), cell.z() + 0.5D);
		AgentInputState aim = look(player, centre, 0.0F, 0.0F, false, false, player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND);
		float error = AgentInputStates.shortestAngleDelta(aim.yaw(), (float) Math.toDegrees(Math.atan2(-(centre.x - player.getX()), centre.z - player.getZ())));
		float forward = CombatPlanning.alignedForward(1.0F, error);
		boolean jump = cell.y() > SafeStep.feet(player).y() && player.onGround() && Math.abs(error) < 30.0F;
		boolean run = sprint && Math.abs(error) < 30.0F && canSprint(player);
		return new AgentInputState(forward, 0.0F, jump, false, run, false, false, aim.yaw(), aim.pitch(), aim.selectedSlot(), aim.hand());
	}

	/** Follows a short planned path cell by cell; fails when the body stops making ground. */
	static final class PathWalk {
		private final List<GridPosition> path;
		private final double arrivalRadius;
		private int index;
		private Vec3 last;
		private int stuck;

		/** Path cells a seen lava flow already reached when the walk began (it started in the flow's way). */
		private java.util.Set<GridPosition> acceptedFlows;
		private int sinceLavaCheck;
		/** Ticks between checks of the cells ahead for lava that has flowed beside them. */
		static final int LAVA_RECHECK_TICKS = 5;
		/** Cells ahead of the body checked (a flow moves about a cell a second over a floor). */
		static final int LAVA_LOOKAHEAD_CELLS = 6;

		PathWalk(List<GridPosition> path) {
			this(path, 0.4D);
		}

		PathWalk(List<GridPosition> path, double arrivalRadius) {
			this.path = List.copyOf(path);
			this.arrivalRadius = arrivalRadius;
		}

		/**
		 * A cell within the next few that seen lava has flowed into since the walk began, or null; checked every
		 * {@link #LAVA_RECHECK_TICKS} ticks. A player turns away from a flow coming at its path instead of walking on into it.
		 */
		GridPosition lavaAhead(ServerPlayer player) {
			if (acceptedFlows == null) {
				acceptedFlows = SafeStep.lavaFlows(player, path);
				return null;
			}
			if (++sinceLavaCheck < LAVA_RECHECK_TICKS) return null;
			sinceLavaCheck = 0;
			advance(player);
			List<GridPosition> ahead = path.subList(index, Math.min(path.size(), index + LAVA_LOOKAHEAD_CELLS));
			return newFlow(ahead, acceptedFlows, SafeStep.lavaFlows(player, ahead));
		}

		/** The first of {@code ahead} that lava flows into now ({@code flows}) and did not when the walk began. */
		static GridPosition newFlow(List<GridPosition> ahead, java.util.Set<GridPosition> accepted, java.util.Set<GridPosition> flows) {
			for (GridPosition cell : ahead) if (flows.contains(cell) && !accepted.contains(cell)) return cell;
			return null;
		}

		/** The cell walked toward now (cells already reached are passed), or null once the last is reached. */
		GridPosition next(ServerPlayer player) {
			advance(player);
			return index < path.size() ? path.get(index) : null;
		}

		private void advance(ServerPlayer player) {
			while (index < path.size()) {
				GridPosition cell = path.get(index);
				double horizontal = Math.hypot(player.getX() - (cell.x() + 0.5D), player.getZ() - (cell.z() + 0.5D));
				if (horizontal > arrivalRadius || Math.abs(player.getY() - cell.y()) > 0.7D) break;
				index++;
			}
		}

		/** RUNNING while walking, DONE on the last cell, FAILED when blocked. */
		Step tick(ServerPlayer player, Consumer<AgentInputState> input, boolean sprint) {
			advance(player);
			if (index >= path.size()) return Step.done("arrived");
			Vec3 now = player.position();
			stuck = last != null && now.distanceToSqr(last) < 0.0025D ? stuck + 1 : 0;
			last = now;
			GridPosition cell = path.get(index);
			if (stuck >= 30) return Step.failed("blocked on the way at " + cell.x() + "," + cell.y() + "," + cell.z());
			input.accept(walkToward(player, cell, sprint));
			return Step.running("moving " + (path.size() - index) + " cell(s) left");
		}
	}

	/** Run from the threat (the focus or the condition's point) along known safe footing, facing where it runs. */
	static final class SprintAway implements Behaviour {
		private static final float[] OFFSETS = {0.0F, 30.0F, -30.0F, 60.0F, -60.0F, 90.0F, -90.0F, 120.0F, -120.0F};
		/** Health a drop taken in place of a level escape must leave. */
		private static final float SURVIVE_MARGIN = 4.0F;
		/** Headings back toward a cloud's centre, tried only when none of {@link #OFFSETS} has footing. */
		private static final float[] BACK_OFFSETS = {150.0F, -150.0F, 180.0F};
		/** One dragon-breath hit (Instant Damage I). */
		private static final int CLOUD_CROSSING_DAMAGE = 6;
		private final double blocks;
		private Vec3 start;
		private Vec3 origin;
		private double startSeparation = Double.NaN;
		private Vec3 last;
		private int stuck;
		private Float lastHeading;
		private int glanced;
		private final Map<Integer, Integer> glancedAt = new java.util.HashMap<>();
		private Float dropHeading;
		/** Feet height when {@link #dropHeading} was chosen: once the body lands below it the drop is taken. */
		private int dropFromY;
		/** {@link #dropHeading} is the level way back across a cloud, not a drop; {@link #spentAcross} once its footing ran out. */
		private boolean acrossCloud;
		private boolean spentAcross;
		private String dropNote = "";
		/** The run's end, held while the body steps back off a brink first ({@link #settle}). */
		private Step ending;
		private Vec3 settleTo;
		private int settleTicks;
		/** A way back along known walkable cells, taken when no straight heading has safe footing (a tunnel, a bend). */
		private PathWalk walk;
		private String walkNote = "";
		private boolean repathed;
		/** Ticks pressed against something before a straight run turns to the known-ground path. */
		private static final int STUCK_REPATH_TICKS = 6;
		/** Ticks a run's end may spend stepping back off a brink (a crouched step covers about 0.065 blocks a tick). */
		private static final int SETTLE_TICKS = 24;

		SprintAway(double blocks) {
			this.blocks = blocks;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			if (start == null) start = player.position();
			if (ending != null) return settle(player, input);
			Vec3 threat = context.threat();
			if (threat == null && origin == null) {
				// No mob or place in the condition (low health): run from the nearest hostile that sees the player.
				List<Mob> seen = watchers(player);
				if (!seen.isEmpty()) threat = seen.getFirst().position();
			}
			if (threat != null) origin = threat;
			else if (origin == null) origin = player.position().subtract(player.getViewVector(1.0F).multiply(1.0D, 0.0D, 1.0D));
			double separation = Math.hypot(player.getX() - origin.x, player.getZ() - origin.z);
			if (Double.isNaN(startSeparation)) startSeparation = separation;
			double moved = Math.hypot(player.getX() - start.x, player.getZ() - start.z);
			if (separation - startSeparation >= blocks || moved >= blocks * 1.5D) {
				return end(player, input, Step.done(String.format(Locale.ROOT, "ran %.1f blocks, now %.1f away", moved, separation) + dropNote + walkNote));
			}
			// The drop taken in place of a level escape is behind the body once it lands lower: the next heading is chosen
			// again from here, at the health left. Reused, the old heading walked a landed body off a 23-block drop at 13
			// health (live End run d5c78a73 2026-10-23: a fireball dodge from a pillar top took a 10-block drop, then the next).
			if (dropHeading != null && player.onGround() && Mth.floor(player.getY() + 1.0E-4D) < dropFromY) dropHeading = null;
			// The way back across a cloud is a level heading: once its footing ends (the far rim of an End platform) the
			// run ends there rather than carry on into the void, which it did with the heading checked only once.
			if (dropHeading != null && acrossCloud && player.onGround() && SafeStep.blocked(player, dropHeading) != null) {
				dropHeading = null;
				acrossCloud = false;
				spentAcross = true;
			}
			// Under water a player escapes up first: running level under water drowned the body while it fled (live run
			// d18-iron-a: 7-8 blocks sideways per firing, and a 12-block run along the bottom that cost 6 health).
			if (player.isUnderWater()) {
				var surface = airRoute(player);
				input.accept(surface == null ? riseBlind(player) : swimToAir(player, surface));
				return Step.running(surface == null ? "surfacing first: swimming up"
						: String.format(Locale.ROOT, "surfacing first: swimming to air at %d,%d,%d", surface.x(), surface.openY(), surface.z()));
			}
			// Lava flowing toward the way back: drop it and pick a heading (the probe refuses the flow's cells).
			if (walk != null && walk.lavaAhead(player) != null) walk = null;
			if (walk != null) {
				Step step = walk.tick(player, input, canSprint(player));
				if (step.status() == ReflexScheduler.ActionStatus.RUNNING) return Step.running(String.format(Locale.ROOT, "%s, %.1f away", walkNote.substring(2), separation));
				walk = null;
				repathed = false;
				if (step.status() == ReflexScheduler.ActionStatus.FAILED) {
					return Step.failed(String.format(Locale.ROOT, "%s after %.1f blocks", step.detail(), moved));
				}
			}
			float away = (float) Math.toDegrees(Math.atan2(-(player.getX() - origin.x), player.getZ() - origin.z));
			// A run toward an island rim ends on the brink (live End run d6-end-a: 8.4 blocks east to the rim, then the
			// model's next sprint went over it); the void is worse than a cloud, so headings along the island win first.
			Float heading = SafeStep.heading(player, away, OFFSETS, lastHeading,
					List.of(yaw -> runsIntoCloud(player, yaw) || runsTowardVoid(player, yaw), yaw -> runsTowardVoid(player, yaw)));
			lastHeading = heading;
			if (heading == null && dropHeading != null) heading = dropHeading;
			if (heading == null && spentAcross) return end(player, input, Step.done(String.format(Locale.ROOT, "ran %.1f blocks; no safe heading further", moved) + dropNote + walkNote));
			if (heading == null) {
				// No straight heading keeps footing (a bend in a tunnel, a ledge path): back along cells the player knows it
				// can walk, as a player retraces the way it came.
				Step back = walkBack(player, input, separation);
				if (back != null) return back;
				if (moved >= 1.0D) return end(player, input, Step.done(String.format(Locale.ROOT, "ran %.1f blocks; no safe heading further", moved) + dropNote + walkNote));
				List<SafeStep.Blocked> blocked = new ArrayList<>();
				for (float offset : OFFSETS) {
					SafeStep.Blocked why = SafeStep.blocked(player, Mth.wrapDegrees(away + offset));
					if (why != null) blocked.add(why);
				}
				// Footing the eye has not seen (it faced the threat, or looked up at the dragon): a player turns and looks
				// where it will run before it decides there is nowhere to go.
				// Each unseen heading gets a few ticks of the view; one the eye cannot reach (behind a wall) is not stared at.
				SafeStep.Blocked unseen = blocked.stream().filter(why -> why.barrier() == SafeStep.Barrier.UNSEEN
						&& glancedAt.getOrDefault(Math.round(why.yaw()), 0) < GLANCE_TICKS_EACH).findFirst().orElse(null);
				if (unseen != null && glanced < GLANCE_TICKS) {
					glanced++;
					glancedAt.merge(Math.round(unseen.yaw()), 1, Integer::sum);
					// The headroom a step up needs is above the head: look up for it, else down at the footing.
					float pitch = unseen.at().y() > SafeStep.feet(player).y() + 1 ? -GLANCE_PITCH : GLANCE_PITCH;
					input.accept(new AgentInputState(0.0F, 0.0F, false, false, false, false, false,
							AgentInputStates.turnYaw(player.getYRot(), unseen.yaw()), AgentInputStates.turnPitch(player.getXRot(), pitch),
							player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
					return Step.running("looking at the footing " + SafeStep.compass(unseen.yaw()));
				}
				// Every level heading is a wall, a deep drop or unseen: a player still moves, down the shallowest drop
				// onto known ground that leaves it alive, rather than stand in the cloud or the blast.
				SafeStep.Blocked least = null;
				for (SafeStep.Blocked why : blocked) {
					if (why.barrier() != SafeStep.Barrier.DROP || why.fallDamage() > player.getHealth() - SURVIVE_MARGIN) continue;
					if (least == null || why.drop() < least.drop()) least = why;
				}
				// From a cloud (a place, not a mob) the way out can be back across it: one more breath hit, about what a
				// 9-block drop costs; never back past a mob.
				Float across = null;
				if (context.focus() == null && context.point() != null && (least == null || least.fallDamage() > CLOUD_CROSSING_DAMAGE)) {
					for (float offset : BACK_OFFSETS) {
						float yaw = Mth.wrapDegrees(away + offset);
						if (SafeStep.blocked(player, yaw) == null) {
							across = yaw;
							break;
						}
					}
				}
				dropFromY = Mth.floor(player.getY() + 1.0E-4D);
				acrossCloud = across != null;
				if (across != null) {
					dropHeading = across;
					dropNote = "; ran back across the cloud " + SafeStep.compass(across) + ", no other heading away: " + describe(blocked, player);
				} else if (least != null) {
					dropHeading = least.yaw();
					dropNote = String.format(Locale.ROOT, "; dropped %d blocks %s (about %d damage), no level heading away", least.drop(),
							SafeStep.compass(least.yaw()), least.fallDamage());
				} else {
					return Step.failed("no safe heading away: " + describe(blocked, player));
				}
				heading = dropHeading;
			}
			Vec3 now = player.position();
			stuck = last != null && now.distanceToSqr(last) < 0.0025D ? stuck + 1 : 0;
			last = now;
			// A straight heading the probe allows can still jam the body on a corner (a diagonal into a side tunnel): a
			// player steps around it along ground it knows rather than push into the corner.
			if (stuck >= STUCK_REPATH_TICKS && !repathed) {
				repathed = true;
				Step back = walkBack(player, input, separation);
				if (back != null) {
					stuck = 0;
					return back;
				}
			}
			if (stuck >= 30) return Step.failed(String.format(Locale.ROOT, "blocked after %.1f blocks running %s", moved, SafeStep.compass(heading)));
			float yaw = AgentInputStates.turnYaw(player.getYRot(), heading);
			// Navigation's walking gaze, not the horizon: a level sprint sweeps enderman eyes (live End run 2026-10-20).
			float pitch = AgentInputStates.turnPitch(player.getXRot(),
					dev.agaminggod.arenaagents.server.runtime.controller.EndermanGaze.clearPitch(player, heading, ServerNavigationController.WALKING_GAZE_PITCH));
			float error = AgentInputStates.shortestAngleDelta(yaw, heading);
			boolean aligned = Math.abs(error) < 30.0F;
			// Swimming on the surface a player holds jump to keep the head out; released, the body sinks as it runs.
			input.accept(new AgentInputState(CombatPlanning.alignedForward(1.0F, error), aligned ? centring(player, yaw) : 0.0F,
					player.isInWater() || aligned && SafeStep.jumpAhead(player, heading), false, aligned && canSprint(player), false, false, yaw, pitch,
					player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			return Step.running(String.format(Locale.ROOT, "running %s, %.1f away", SafeStep.compass(heading), separation));
		}

		/** Ends the run with {@code result}, after a step back off the brink of a seen void or damaging drop when it stands on one. */
		private Step end(ServerPlayer player, Consumer<AgentInputState> input, Step result) {
			settleTo = SafeStep.brinkRetreat(player,
					cell -> dev.agaminggod.arenaagents.server.perception.CloudDanger.harmAt(player, new Vec3(cell.x() + 0.5D, cell.y(), cell.z() + 0.5D)));
			if (settleTo == null) return result;
			ending = result;
			return settle(player, input);
		}

		/**
		 * A player does not stop a run on the rim: it steps back toward the middle of the footing, crouched so the step
		 * cannot carry it over, and keeps facing as it was. A few ticks at most; the run's result then stands.
		 */
		private Step settle(ServerPlayer player, Consumer<AgentInputState> input) {
			double dx = settleTo.x - player.getX(), dz = settleTo.z - player.getZ();
			if (Math.hypot(dx, dz) < 0.15D) return Step.done(ending.detail() + "; stepped back from the edge");
			if (++settleTicks > SETTLE_TICKS) return ending;
			float heading = Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-dx, dz)));
			float relative = (float) Math.toRadians(AgentInputStates.shortestAngleDelta(player.getYRot(), heading));
			input.accept(new AgentInputState(Mth.clamp((float) Math.cos(relative), -1.0F, 1.0F), Mth.clamp(-(float) Math.sin(relative), -1.0F, 1.0F),
					false, true, false, false, false, player.getYRot(), player.getXRot(), player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			return Step.running("stepping back from the edge");
		}

		/** Starts a run back along known walkable cells away from the threat and takes its first step; null when there is none. */
		private Step walkBack(ServerPlayer player, Consumer<AgentInputState> input, double separation) {
			List<GridPosition> path = SafeStep.awayPath(player, origin.x, origin.z, MAX_PATH_STEPS, MAX_PATH_CELLS, PATH_MIN_GAIN,
					cell -> runsIntoCloud(player, cell));
			if (path == null) return null;
			walk = new PathWalk(path);
			GridPosition end = path.getLast();
			walkNote = String.format(Locale.ROOT, "; ran back along known ground toward %d,%d,%d (%d steps)", end.x(), end.y(), end.z(), path.size());
			Step step = walk.tick(player, input, canSprint(player));
			if (step.status() == ReflexScheduler.ActionStatus.RUNNING) return Step.running(String.format(Locale.ROOT, "%s, %.1f away", walkNote.substring(2), separation));
			walk = null;
			return null;
		}
	}

	/**
	 * Strafe toward the feet cell's centre line while the body is pressed against something: a 0.6-wide body running
	 * off-centre catches the corner of a block beside the free column it runs along (live replay of End run 62ac775e:
	 * the escape stood 1.3 s against a corner and failed as blocked); a player sidesteps it.
	 */
	static float centring(ServerPlayer player, float yaw) {
		if (!player.horizontalCollision) return 0.0F;
		double offX = Mth.floor(player.getX()) + 0.5D - player.getX(), offZ = Mth.floor(player.getZ()) + 0.5D - player.getZ();
		double radians = Math.toRadians(yaw);
		// Positive strafe moves toward (cos yaw, sin yaw): the body's left.
		double left = offX * Math.cos(radians) + offZ * Math.sin(radians);
		return Math.abs(left) < 0.1D ? 0.0F : (float) Math.signum(left);
	}

	/** Ticks an escape may spend turning to see footing it has not seen (a 180 degree turn takes about 5). */
	static final int GLANCE_TICKS = 12;
	/** Ticks of that spent on one heading. */
	static final int GLANCE_TICKS_EACH = 5;
	/** Below the horizon far enough that the cells one and two steps out, and the ground under them, are in view. */
	static final float GLANCE_PITCH = 35.0F;

	/** "walls N, NE; void E; 12-block drop S (9 damage at health 6.0); unseen ground W": every refused heading, grouped. */
	static String describe(List<SafeStep.Blocked> blocked, ServerPlayer player) {
		Map<String, List<String>> groups = new java.util.LinkedHashMap<>();
		for (SafeStep.Blocked why : blocked) {
			String kind = switch (why.barrier()) {
				case WALL -> "wall";
				case VOID -> "void";
				case HAZARD -> "lava or fire";
				case UNSEEN -> "unseen ground";
				case DROP -> String.format(Locale.ROOT, "%d-block drop (%d damage)", why.drop(), why.fallDamage());
			};
			List<String> where = groups.computeIfAbsent(kind, key -> new ArrayList<>());
			String direction = SafeStep.compass(why.yaw());
			if (!where.contains(direction)) where.add(direction);
		}
		StringBuilder text = new StringBuilder();
		for (Map.Entry<String, List<String>> group : groups.entrySet()) {
			if (!text.isEmpty()) text.append("; ");
			text.append(group.getKey()).append(' ').append(String.join(", ", group.getValue()));
		}
		return text.append(String.format(Locale.ROOT, " (health %.1f)", player.getHealth())).toString();
	}

	/** Blocks farther from the threat a path back along known ground must lead. */
	static final double PATH_MIN_GAIN = 2.0D;

	/** Whether standing in {@code cell} puts the body in a harmful cloud it is not already in. */
	static boolean runsIntoCloud(ServerPlayer player, GridPosition cell) {
		return dev.agaminggod.arenaagents.server.perception.CloudDanger.newHarmAt(player, new Vec3(cell.x() + 0.5D, cell.y(), cell.z() + 0.5D));
	}

	/** Points along a sprint heading checked for a harmful cloud the body is not already in. */
	private static final double[] CLOUD_LOOKAHEAD = {1.5D, 3.0D, 4.5D};

	static boolean runsIntoCloud(ServerPlayer player, float yaw) {
		double radians = Math.toRadians(yaw);
		Vec3 direction = new Vec3(-Math.sin(radians), 0.0D, Math.cos(radians));
		for (double distance : CLOUD_LOOKAHEAD) {
			if (dev.agaminggod.arenaagents.server.perception.CloudDanger.newHarmAt(player, player.position().add(direction.scale(distance)))) return true;
		}
		return false;
	}

	/** Distances along a sprint heading checked for a void edge (a column empty from the feet cell to the world's bottom). */
	private static final double[] VOID_LOOKAHEAD = {1.0D, 2.0D, 3.0D, 4.0D, 5.0D};

	static boolean runsTowardVoid(ServerPlayer player, float yaw) {
		double radians = Math.toRadians(yaw);
		double dx = -Math.sin(radians), dz = Math.cos(radians);
		int feetY = net.minecraft.util.Mth.floor(player.getY() + 1.0E-4D);
		for (double distance : VOID_LOOKAHEAD) {
			int x = net.minecraft.util.Mth.floor(player.getX() + dx * distance), z = net.minecraft.util.Mth.floor(player.getZ() + dz * distance);
			if (dev.agaminggod.arenaagents.server.perception.VoidColumn.below(player.level(), x, feetY, z)) return true;
		}
		return false;
	}

	/** Steps a short reflex path may take; anything longer is a move for a program. */
	static final int MAX_PATH_STEPS = 16;
	private static final int MAX_PATH_CELLS = 1_500;

	/** Go to a cell the model named (cover it chose) by a short safe path over seen terrain. */
	static final class MoveToCell implements Behaviour {
		private final GridPosition goal;
		private final boolean sprint;
		private PathWalk walk;

		MoveToCell(GridPosition goal, boolean sprint) {
			this.goal = goal;
			this.sprint = sprint;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			String at = goal.x() + "," + goal.y() + "," + goal.z();
			// Seen lava flowing beside the cells ahead: find the way again (the search refuses the flow's cells).
			if (walk != null && walk.lavaAhead(player) != null) walk = null;
			if (walk == null) {
				if (SafeStep.feet(player).equals(goal)) return Step.done("already at " + at);
				List<GridPosition> path = SafeStep.pathTo(SafeStep.reachable(player, MAX_PATH_STEPS, MAX_PATH_CELLS), goal);
				if (path == null) return Step.failed("no short safe path to " + at + " (" + MAX_PATH_STEPS + " steps over seen footing)");
				walk = new PathWalk(path);
			}
			Step step = walk.tick(player, input, sprint);
			return step.status() == ReflexScheduler.ActionStatus.DONE ? Step.done("reached " + at) : step;
		}
	}

	/**
	 * Sprint along seen footing to the nearest cell at least {@code blocks} from every seen lethal drop (the void, a fall of
	 * 5 or more, lava), as a player moves to the middle of the island when the dragon swoops: its body throws a player
	 * 5-15 blocks, and the 18 End falls and void deaths of 2026-10-23 were bodies thrown from towers, the arrival platform
	 * and island edges. Done once there (or already there); with no such cell in reach it goes to the reachable cell
	 * farthest from the edge, and fails naming the best clearance when none gains a block.
	 */
	static final class AwayFromEdge implements Behaviour {
		/** Steps of seen footing searched; an island's middle is often more than the move_to_cell 16 away. */
		static final int STEPS = 24;
		static final int CELLS = 2_000;
		/** Ticks spent turning to look inland before a search over seen footing is given up. */
		static final int LOOK_TICKS = 10;
		private final double blocks;
		private PathWalk walk;
		private String goalText;
		private int looked;
		private Float lookYaw;
		/** Clearance where the escape began, and whether the current walk's goal has the wanted clearance. */
		private double start = -1.0D;
		private boolean goalClear;
		private int hops;
		/** Walks toward better clearance before the escape settles for what it has. */
		static final int MAX_HOPS = 4;

		AwayFromEdge(double blocks) {
			this.blocks = blocks;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			if (walk != null && walk.lavaAhead(player) != null) walk = null;
			if (walk == null) {
				var escape = dev.agaminggod.arenaagents.server.runtime.controller.FightingPosition.awayFromEdge(player, blocks, STEPS, CELLS,
						cell -> runsIntoCloud(player, cell));
				if (escape.here() >= blocks) return Step.done(hops == 0 ? String.format(Locale.ROOT, "already %.0f+ blocks from any seen drop", blocks)
						: "reached " + goalText);
				if (escape.path() == null && hops > 0 && looked >= LOOK_TICKS) return Step.done("reached " + goalText + "; no seen footing further from the drop");
				if (escape.path() == null) {
					// Footing behind the body may simply be unseen (it faced the drop): a player turns and looks inland first.
					if (looked < LOOK_TICKS) {
						if (lookYaw == null) {
							Float inland = dev.agaminggod.arenaagents.server.runtime.controller.FightingPosition.inlandYaw(player, 3.0D);
							lookYaw = inland == null ? player.getYRot() + 180.0F : inland;
						}
						looked++;
						float yaw = AgentInputStates.turnYaw(player.getYRot(), lookYaw);
						float pitch = AgentInputStates.turnPitch(player.getXRot(), 35.0F);
						input.accept(new AgentInputState(0.0F, 0.0F, false, false, false, false, false, yaw, pitch,
								player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
						return Step.running("looking inland for footing");
					}
					return Step.failed(String.format(Locale.ROOT,
							"no seen footing within %d steps is farther from a drop than here (%.1f blocks), after looking inland", STEPS, escape.here()));
				}
				GridPosition goal = escape.path().getLast();
				if (start < 0.0D) start = escape.here();
				goalText = String.format(Locale.ROOT, "%d,%d,%d (%s blocks from a drop, was %.1f)", goal.x(), goal.y(), goal.z(),
						escape.clearance() >= blocks ? String.format(Locale.ROOT, "%.0f+", blocks) : String.format(Locale.ROOT, "%.1f", escape.clearance()), start);
				goalClear = escape.clearance() >= blocks;
				walk = new PathWalk(escape.path());
			}
			Step step = walk.tick(player, input, canSprint(player));
			if (step.status() != ReflexScheduler.ActionStatus.DONE) return step;
			if (goalClear || ++hops >= MAX_HOPS) return Step.done("reached " + goalText);
			// Short of the clearance: the ground seen from here goes further; look inland again and keep going.
			walk = null;
			looked = 0;
			lookYaw = null;
			return Step.running("reached " + goalText + "; looking further inland");
		}
	}

	/** Hold sneak and stand still (sneaking never walks off an edge); held while the condition holds. */
	static final class Sneak implements Behaviour {
		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			input.accept(new AgentInputState(0.0F, 0.0F, false, true, false, false, false, player.getYRot(), player.getXRot(),
					player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			return Step.running("sneaking");
		}

		@Override
		public boolean holdsWhileTrue() { return true; }
	}

	/** Look down and away from the focus (an enderman's eyes) until the view is well off it. */
	static final class LookAway implements Behaviour {
		private int clear;

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			Entity focus = context.focus() != null && context.focus().isAlive() ? context.focus() : null;
			float yaw = player.getYRot();
			float pitch = 70.0F;
			if (focus != null) {
				Vec3 delta = focus.position().subtract(player.position());
				yaw = Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-delta.x, delta.z)) + 90.0F);
				// Below the eyes: look up instead, still off to the side.
				if (focus.getEyeY() < player.getY() - 1.0D) pitch = -60.0F;
			}
			float nextYaw = AgentInputStates.turnYaw(player.getYRot(), yaw);
			float nextPitch = AgentInputStates.turnPitch(player.getXRot(), pitch);
			input.accept(new AgentInputState(0.0F, 0.0F, false, false, false, false, false, nextYaw, nextPitch,
					player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			boolean watched = focus instanceof LivingEntity living && living.isLookingAtMe(player, 0.1D, true, false, living.getEyeY());
			clear = watched ? 0 : clear + 1;
			return clear >= 3 ? Step.done("looked away") : Step.running("looking away");
		}
	}

	/**
	 * Place up to {@code count} blocks from the hotbar in the cell beside the body toward the threat (feet level, then
	 * head level): quick cover. Each block goes on a face the crosshair is actually on, within reach, as a right-click.
	 */
	static final class PlaceBlock implements Behaviour {
		private final String item;
		private final int count;
		private List<BlockPos> targets;
		private final List<BlockPos> open = new ArrayList<>();
		private int slot = -1;
		private int heldSlot = -1;
		private int waited;

		PlaceBlock(String item, int count) {
			this.item = item;
			this.count = count;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			Level level = player.level();
			if (targets == null) {
				slot = blockSlot(player, item);
				if (slot < 0) return Step.failed(item == null ? "no solid block in hotbar" : "no " + item + " in hotbar");
				Vec3 threat = context.threat();
				float yaw = threat == null ? player.getYRot()
						: (float) Math.toDegrees(Math.atan2(-(threat.x - player.getX()), threat.z - player.getZ()));
				BlockPos base = player.blockPosition().relative(Direction.fromYRot(yaw));
				targets = new ArrayList<>();
				for (int index = 0; index < count; index++) targets.add(base.above(index));
				for (BlockPos cell : targets) if (level.getBlockState(cell).canBeReplaced()) open.add(cell);
				heldSlot = player.getInventory().getSelectedSlot();
			}
			BlockPos target = null;
			for (BlockPos cell : targets) {
				if (level.getBlockState(cell).canBeReplaced()) {
					target = cell;
					break;
				}
			}
			int placed = (int) open.stream().filter(cell -> !level.getBlockState(cell).canBeReplaced()).count();
			if (target == null) {
				// Back to the item held before, as a player switches back after blocking up.
				input.accept(look(player, null, 0.0F, 0.0F, false, false, heldSlot, InteractionHand.MAIN_HAND));
				return placed > 0 ? Step.done("placed " + placed + " block(s) toward the threat") : Step.done("cover already there");
			}
			if (!(player.getInventory().getItem(slot).getItem() instanceof BlockItem)) return Step.failed("ran out of blocks after " + placed);
			BlockHitResult face = face(player, target);
			if (face == null) return Step.failed("no face to place against at " + target.toShortString());
			if (++waited > 30 * targets.size()) return Step.failed("could not place at " + target.toShortString() + " (placed " + placed + ")");
			boolean onFace = Tracer.rayTrace(player, 1.0F, player.blockInteractionRange(), false) instanceof BlockHitResult hit
					&& hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(face.getBlockPos()) && hit.getDirection() == face.getDirection();
			input.accept(look(player, face.getLocation(), 0.0F, 0.0F, false, onFace, slot, InteractionHand.MAIN_HAND));
			return Step.running("placing " + (placed + 1) + "/" + targets.size());
		}

		/** A solid face beside {@code target} that the eye sees and can reach, as the hit a right-click there makes. */
		private static BlockHitResult face(ServerPlayer player, BlockPos target) {
			Vec3 eye = player.getEyePosition();
			for (Direction toward : new Direction[] {Direction.DOWN, Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST, Direction.UP}) {
				BlockPos support = target.relative(toward);
				Direction side = toward.getOpposite();
				if (!player.level().getBlockState(support).isFaceSturdy(player.level(), support, side)) continue;
				if (!player.isWithinBlockInteractionRange(support, 0.0D)) continue;
				Vec3 point = Vec3.atCenterOf(target).add(toward.getStepX() * 0.5D, toward.getStepY() * 0.5D, toward.getStepZ() * 0.5D);
				if (eye.subtract(point).dot(new Vec3(side.getStepX(), side.getStepY(), side.getStepZ())) <= 0.05D) continue;
				return new BlockHitResult(point, side, support, false);
			}
			return null;
		}

		/** A block that quick cover can use: a full, non-falling block without a block entity. */
		static boolean coverBlock(ItemStack stack) {
			if (!(stack.getItem() instanceof BlockItem block)) return false;
			return block.getBlock().defaultBlockState().isCollisionShapeFullBlock(net.minecraft.world.level.EmptyBlockGetter.INSTANCE, BlockPos.ZERO)
					&& !(block.getBlock() instanceof FallingBlock) && !(block.getBlock() instanceof EntityBlock);
		}

		static int blockSlot(ServerPlayer player, String item) {
			for (int index = 0; index < 9; index++) {
				ItemStack stack = player.getInventory().getItem(index);
				if (!(stack.getItem() instanceof BlockItem block)) continue;
				if (item != null) {
					if (item.equals(id(stack))) return index;
					continue;
				}
				var state = block.getBlock().defaultBlockState();
				if (state.isCollisionShapeFullBlock(player.level(), player.blockPosition()) && !(block.getBlock() instanceof FallingBlock)
						&& !(block.getBlock() instanceof EntityBlock)) {
					return index;
				}
			}
			return -1;
		}
	}

	/**
	 * Back off to the nearest cell (by a short safe path) out of the focus mob's line of sight, at eye and body height,
	 * then report it. Plans once, from terrain the player has seen.
	 */
	/**
	 * Mine out the solid block the head is stuck in, as a player digs out of gravel or sand that fell onto it: the cells
	 * vanilla's in-wall test touches (the eye cell first), with the hotbar's fastest tool for that block, by holding attack
	 * on it (from inside a block any view targets that block). Sand or gravel that drops in after a break is mined too.
	 */
	static final class DigOut implements Behaviour {
		private static final int SETTLE_TICKS = 12;
		private BlockPos target;
		private int targetTicks;
		private int limit;
		private int broken;
		private int settle;
		private int heldSlot = -1;

		/** Suffocating cells at the eye, nearest the eye first: vanilla Entity.isInWall's box, so the HUD and this agree. */
		static List<BlockPos> stuckCells(ServerPlayer player) {
			List<BlockPos> cells = new ArrayList<>();
			if (player.noPhysics || player.isSpectator()) return cells;
			float width = player.getBbWidth() * 0.8F;
			AABB box = AABB.ofSize(player.getEyePosition(), width, 1.0E-6D, width);
			for (BlockPos pos : BlockPos.betweenClosed(box)) {
				BlockState state = player.level().getBlockState(pos);
				if (!state.isAir() && state.isSuffocating(player.level(), pos)
						&& Shapes.joinIsNotEmpty(state.getCollisionShape(player.level(), pos).move(pos), Shapes.create(box), BooleanOp.AND)) {
					cells.add(pos.immutable());
				}
			}
			BlockPos eye = BlockPos.containing(player.getEyePosition());
			cells.sort((left, right) -> Boolean.compare(!left.equals(eye), !right.equals(eye)));
			return cells;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			Level level = player.level();
			if (heldSlot < 0) heldSlot = player.getInventory().getSelectedSlot();
			if (target != null && !level.getBlockState(target).isSuffocating(level, target)) {
				broken++;
				target = null;
				settle = 0;
			}
			List<BlockPos> cells = stuckCells(player);
			if (cells.isEmpty()) {
				// Gravel above a mined cell drops a moment later: a player watches it fall before calling the shaft clear.
				if (broken > 0 && settle++ < SETTLE_TICKS && fallingAbove(player)) {
					input.accept(look(player, null, 0.0F, 0.0F, false, false, player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
					return Step.running("watching a falling block");
				}
				return broken > 0 ? Step.done("dug out " + broken + " block(s)") : Step.failed("head not inside a block");
			}
			BlockPos cell = cells.get(0);
			BlockState state = level.getBlockState(cell);
			if (!cell.equals(target)) {
				target = cell;
				targetTicks = 0;
				int slot = fastestSlot(player, state, heldSlot);
				player.getInventory().setSelectedSlot(slot);
				float progress = state.getDestroyProgress(player, level, cell);
				if (progress <= 0.0F) return Step.failed(id(state) + " at " + cell.toShortString() + " cannot be mined");
				limit = (int) Math.ceil(1.0F / progress) * 2 + 20;
			}
			if (++targetTicks > limit) return Step.failed("could not mine " + id(state) + " at " + cell.toShortString() + " (dug " + broken + ")");
			int slot = player.getInventory().getSelectedSlot();
			BlockPos eye = BlockPos.containing(player.getEyePosition());
			// The eye's own cell is hit by any view; a neighbouring cell the head overlaps is looked at.
			AgentInputState aim = cell.equals(eye) ? look(player, null, 0.0F, 0.0F, false, false, slot, InteractionHand.MAIN_HAND)
					: look(player, Vec3.atCenterOf(cell), 0.0F, 0.0F, false, false, slot, InteractionHand.MAIN_HAND);
			input.accept(new AgentInputState(0.0F, 0.0F, false, false, false, true, false, aim.yaw(), aim.pitch(), slot, InteractionHand.MAIN_HAND));
			return Step.running("mining " + id(state) + " at " + cell.toShortString());
		}

		private static boolean fallingAbove(ServerPlayer player) {
			AABB column = player.getBoundingBox().inflate(0.5D, 0.0D, 0.5D).expandTowards(0.0D, 4.0D, 0.0D);
			return !player.level().getEntitiesOfClass(FallingBlockEntity.class, column).isEmpty();
		}

		/** The hotbar slot that mines {@code state} fastest, the held slot on a tie, as a player reaches for a shovel. */
		private static int fastestSlot(ServerPlayer player, BlockState state, int held) {
			int best = player.getInventory().getSelectedSlot();
			float speed = player.getInventory().getItem(best).getDestroySpeed(state);
			for (int index = 0; index < 9; index++) {
				float candidate = player.getInventory().getItem(index).getDestroySpeed(state);
				if (candidate > speed) {
					speed = candidate;
					best = index;
				}
			}
			return best;
		}

		@Override
		public boolean keepsSelection() { return false; }
	}

	static final class TakeCover implements Behaviour {
		/** Turns of the view (120 degrees apart) a cover search looks around before it decides there is none. */
		private static final int GLANCE_TURNS = 3;
		private static final int TICKS_PER_TURN = 4;
		private final int within;
		private PathWalk walk;
		private GridPosition cover;
		private int glanced;
		private float glanceStart = Float.NaN;
		private PlaceBlock wall;
		private LivingEntity shooter;
		private String why;

		TakeCover(int within) {
			this.within = within;
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			if (wall != null) return buildCover(context, input);
			if (walk == null) {
				// The condition's mob; when it names none (low health), the hostiles that see the player and can shoot it,
				// since cover stops shots and a melee mob walks around it; with no shooter, every hostile that sees it.
				List<? extends LivingEntity> from;
				if (context.focus() instanceof LivingEntity mob && mob.isAlive()) from = List.of(mob);
				else {
					List<Mob> seen = watchers(player);
					List<Mob> shooters = seen.stream().filter(ThreatPerception::isRanged).toList();
					from = shooters.isEmpty() ? seen : shooters;
				}
				if (from.isEmpty()) return Step.failed("no mob to take cover from");
				String who = from.size() == 1 ? type(from.getFirst()) : from.size() + " mobs";
				Map<GridPosition, GridPosition> reach = SafeStep.reachable(player, within, MAX_PATH_CELLS);
				for (GridPosition cell : reach.keySet()) {
					if (!from.stream().allMatch(mob -> hidden(player, mob, mob.getEyePosition(), cell))) continue;
					if (reach.get(cell) == null) return Step.done("already out of sight of " + who);
					cover = cell;
					walk = new PathWalk(SafeStep.pathTo(reach, cell));
					break;
				}
				if (walk == null) {
					// Ground the eye has not seen limits the search: a player looks around once before deciding.
					if (glanced < GLANCE_TURNS * TICKS_PER_TURN && SafeStep.unseenBeside(player, reach.keySet())) {
						if (Float.isNaN(glanceStart)) glanceStart = player.getYRot();
						float yaw = glanceStart + 120.0F * (1 + glanced / TICKS_PER_TURN);
						glanced++;
						input.accept(new AgentInputState(0.0F, 0.0F, false, false, false, false, false,
								AgentInputStates.turnYaw(player.getYRot(), Mth.wrapDegrees(yaw)), AgentInputStates.turnPitch(player.getXRot(), GLANCE_PITCH),
								player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
						return Step.running("looking around for cover");
					}
					why = "no cell within " + within + " steps hides from " + who + " (" + reach.size() + " cells reachable over seen ground)";
					// In the open a player with blocks makes the cover: two blocks between it and the nearest shooter.
					shooter = from.getFirst();
					if (PlaceBlock.blockSlot(player, null) < 0) return Step.failed(why + "; no solid block in the hotbar to build cover");
					wall = new PlaceBlock(null, 2);
					return buildCover(context, input);
				}
			}
			GridPosition flow = walk.lavaAhead(player);
			if (flow != null) {
				walk = null;
				return Step.running("lava flows beside the way to cover at " + flow.x() + "," + flow.y() + "," + flow.z() + "; choosing cover again");
			}
			Step step = walk.tick(player, input, true);
			return step.status() == ReflexScheduler.ActionStatus.DONE
					? Step.done("in cover at " + cover.x() + "," + cover.y() + "," + cover.z()) : step;
		}

		private Step buildCover(Context context, Consumer<AgentInputState> input) {
			Context toward = new Context(context.player(), shooter, context.stance(), context.memory(), shooter.position(), context.below(), context.fightShields());
			Step step = wall.tick(toward, input);
			String detail = why + "; " + step.detail() + " toward " + type(shooter);
			return switch (step.status()) {
				case RUNNING -> Step.running(step.detail());
				case DONE -> Step.done(detail);
				case FAILED -> Step.failed(detail);
			};
		}

		private static boolean hidden(ServerPlayer player, LivingEntity mob, Vec3 eye, GridPosition cell) {
			for (double height : new double[] {0.9D, 1.62D}) {
				Vec3 point = new Vec3(cell.x() + 0.5D, cell.y() + height, cell.z() + 0.5D);
				if (player.level().clip(new ClipContext(eye, point, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, mob)).getType()
						== HitResult.Type.MISS) return false;
			}
			return true;
		}
	}

	/**
	 * Walk to the nearest cell the whole body can stand in without touching fire or lava, over seen footing at most
	 * {@link #LEAVE_FIRE_STEPS} steps away: a player stepping out of the flames a blaze's fireball left at their feet, or
	 * backing out of lava that flowed into a tunnel. Inside lava a player holds jump and forward (lava slows walking and
	 * jump swims up and over a ledge); with no dry cell in reach it swims to the nearest seen exit (the exits facts name).
	 * For lava the exit is out of the seen flow's way ({@link LavaSpread}): a cell the spread reaches within its horizon
	 * is where the lava goes next, so a pit below a flow or a tunnel cell ahead of it is no way out (d22-lava2: the body
	 * jumped out of a flow into the pit under it). It also runs before contact, while the flow is on its way to the body
	 * (armed on lava_flowing), and ends only standing (or swimming) out of the flow's way, not in the air over a drop.
	 */
	static final class LeaveFire implements Behaviour {
		static final int LEAVE_FIRE_STEPS = 6;
		/** With no exit out of the seen flow's way within {@link #LEAVE_FIRE_STEPS}, the search goes this far. */
		static final int LEAVE_FIRE_FAR_STEPS = MAX_PATH_STEPS;
		static final int LAVA_CLEARANCE = 3;
		/** Ticks between checks that the chosen exit is still out of the flow's way. */
		static final int EXIT_RECHECK_TICKS = 5;
		/** A flow reaching the body this soon is lava to leave even before it touches. */
		static final double FLOW_LEAVE_SECONDS = 4.0D;
		private PathWalk walk;
		private GridPosition exit;
		/** The exit was chosen out of the seen flow's way (not the cell it reaches last). */
		private boolean exitOut;
		private String hazard;
		private int sinceChoice;
		/** Out of the hazard on safe footing with the body still burning: what the result says until the burn ends. */
		private String afterburn;
		/** Ticks spent putting out fire the body stands in with no fire-free cell to step to. */
		private int punchTicks;
		private boolean punching;
		static final int PUNCH_TICKS = 60;

		/**
		 * Out and still burning, the rule keeps running on the footing it reached until the fire goes out (decision 13), so
		 * its result is the burn's end; a higher rule or a model command still takes the body. Its maxS ends it as done.
		 */
		@Override
		public boolean settled() {
			return afterburn != null;
		}

		/**
		 * Out of a fire block and only burning: standing still does not put a burn out, and a paused fight against blazes
		 * left them free hits (d41 platform fixture: 8 s held by default-fire, no swing and no shield, while blazes hit).
		 * The fight steps off fire itself. Lava's afterburn still holds (decision 13).
		 */
		@Override
		public boolean yieldsToFight() {
			return afterburn != null && HazardExits.Contact.FIRE.wire.equals(hazard);
		}

		@Override
		public Step tick(Context context, Consumer<AgentInputState> input) {
			ServerPlayer player = context.player();
			if (punching) {
				BlockPos fire = HazardExits.fireTouched(player);
				if (fire != null && punchTicks < PUNCH_TICKS) return punchOut(player, fire, input);
				if (fire != null) return Step.failed("could not put out the fire at " + fire.toShortString() + " in " + PUNCH_TICKS / 20 + " s");
				punching = false;
				walk = null;
			}
			if (afterburn != null) {
				if (safeFooting(player)) {
					if (!player.isOnFire()) return Step.done(afterburn + "; no longer burning");
					return holdBurning(afterburn, player, input);
				}
				// Shoved or slid off it, or the flow came on: get out again.
				afterburn = null;
				walk = null;
			}
			if (walk != null && hazard.equals(HazardExits.Contact.LAVA.wire) && ++sinceChoice >= EXIT_RECHECK_TICKS) {
				sinceChoice = 0;
				// Lava keeps spreading while the body walks out: an exit it has reached, now sits under or will reach
				// soon is no way out (d22-lava: the flow ran down into the pit chosen as the exit and the body burned there).
				if (!fireFree(player, exit) || lavaAbove(player, exit) || exitOut && flowReaches(LavaSpread.reach(player), exit)) walk = null;
			}
			if (walk == null) {
				sinceChoice = 0;
				HazardExits.Contact contact = HazardExits.contact(player);
				// When the flow arrives: as vanilla spreads it now. Where it may go: every open side (LavaSpread.reach).
				LavaSpread.Arrival coming = LavaSpread.of(player).box(player.getBoundingBox());
				LavaSpread.Prediction flow = LavaSpread.reach(player);
				boolean flowing = coming != null && coming.seconds() <= FLOW_LEAVE_SECONDS;
				if (contact == null && !flowing) {
					// Out of the hazard but still in the air (jumped out over a drop): landing is part of getting out.
					if (!player.onGround() && !player.isInWater() && hazard != null) return Step.running("landing out of " + hazard);
					if (hazard != null && player.isOnFire() && safeFooting(player)) return holdBurning("out of " + hazard, player, input);
					return Step.done("not touching fire or lava" + burnRemaining(player));
				}
				hazard = contact != null ? contact.wire : HazardExits.Contact.LAVA.wire;
				GridPosition feet = SafeStep.feet(player);
				Map<GridPosition, GridPosition> reach = SafeStep.reachable(player, LEAVE_FIRE_STEPS, MAX_PATH_CELLS);
				choose(player, reach, contact, flow, feet);
				if (exit == null || !exitOut && contact != HazardExits.Contact.FIRE && contact != HazardExits.Contact.HOT_FLOOR) {
					// Nothing out of the flow's way that near: look further over seen footing, with the same flow checks,
					// before settling for a cell the flow reaches last or swimming for a landing.
					Map<GridPosition, GridPosition> far = SafeStep.reachable(player, LEAVE_FIRE_FAR_STEPS, MAX_PATH_CELLS);
					GridPosition nearExit = exit;
					choose(player, far, contact, flow, feet);
					if (exitOut || nearExit == null) reach = far;
					else exit = nearExit;
				}
				// Back out along supported ground we just walked, if the seen flow will not reach it.
				if (contact == HazardExits.Contact.LAVA) {
					for (GridPosition previous : context.memory().dryFooting()) {
						if (previous.equals(feet) || !reach.containsKey(previous) || !fireFree(player, previous)
								|| lavaBelow(player, previous) || lavaAbove(player, previous) || flowReaches(flow, previous)) continue;
						exit = previous;
						exitOut = true;
						break;
					}
				}
				walk = null;
				if (exit != null) {
					List<GridPosition> path = SafeStep.pathTo(reach, exit);
					walk = new PathWalk(path.isEmpty() ? List.of(exit) : path, 0.1D);
				}
				if (walk == null && contact == HazardExits.Contact.LAVA) {
					// A pool: no dry step from the feet, so swim straight for the cheapest seen landing.
					for (HazardExits.Exit landing : HazardExits.scan(player)) {
						exit = new GridPosition(landing.x(), landing.y(), landing.z());
						walk = new PathWalk(List.of(exit), 0.1D);
						break;
					}
				}
				if (walk == null && contact == HazardExits.Contact.FIRE) {
					// No fire-free cell to step to (a one-cell shelter lit through its window: d41 live floor deaths stood
					// in it 15 s): punch the flame out, as a player does.
					BlockPos fire = HazardExits.fireTouched(player);
					if (fire != null) { punching = true; return punchOut(player, fire, input); }
				}
				if (walk == null) return Step.failed("no seen " + hazard + "-free footing within " + LEAVE_FIRE_FAR_STEPS + " steps"
						+ (contact == null && coming != null ? " (" + coming.describe() + ")" : ""));
			}
			if (player.isInLava()) {
				GridPosition next = walk.next(player);
				if (next != null) {
					input.accept(swimToward(player, next));
					return Step.running("swimming out of lava toward " + exit.x() + "," + exit.y() + "," + exit.z());
				}
			}
			Step step = walk.tick(player, input, false);
			if (step.status() == ReflexScheduler.ActionStatus.FAILED && HazardExits.Contact.FIRE.wire.equals(hazard)) {
				// The way out is blocked (a shelter wall the seen terrain did not hold): punch the flame out instead.
				BlockPos fire = HazardExits.fireTouched(player);
				if (fire != null) { punching = true; walk = null; return punchOut(player, fire, input); }
			}
			if (step.status() == ReflexScheduler.ActionStatus.DONE && player.isInLava()) {
				// The path's last cell is reached but lava still holds the body (it flowed there): keep swimming at it.
				input.accept(swimToward(player, exit));
				return Step.running("swimming out of lava toward " + exit.x() + "," + exit.y() + "," + exit.z());
			}
			if (step.status() != ReflexScheduler.ActionStatus.DONE) return step;
			// Reaching a cell's approach radius does not mean the whole body left its neighbouring flame.
			if (HazardExits.inHazardBlock(player) || !player.onGround() && !player.isInWater()
					|| hazard.equals(HazardExits.Contact.LAVA.wire) && flowReaches(LavaSpread.reach(player), exit)) {
				walk = null;
				return Step.running("not clear of " + hazard + " yet; checking footing");
			}
			String out = "out of " + hazard + " at " + exit.x() + "," + exit.y() + "," + exit.z();
			if (player.isOnFire() && safeFooting(player)) return holdBurning(out, player, input);
			return Step.done(out + burnRemaining(player));
		}

		/** Turn the view onto the fire's outline at the feet and click it once the view ray ends on it. */
		private Step punchOut(ServerPlayer player, BlockPos fire, Consumer<AgentInputState> input) {
			int slot = player.getInventory().getSelectedSlot();
			AgentInputState aim = look(player, HazardExits.fireAim(fire), 0.0F, 0.0F, false, false, slot, InteractionHand.MAIN_HAND);
			punchTicks++;
			boolean onIt = HazardExits.viewHits(player, fire);
			input.accept(new AgentInputState(0.0F, 0.0F, false, false, false, onIt && !player.isUsingItem(), false, aim.yaw(), aim.pitch(), slot, InteractionHand.MAIN_HAND));
			return Step.running("no fire-free footing in reach; putting out the fire at " + fire.toShortString());
		}

		/** Out on safe footing and still burning: stand there, running, until the fire is out (see {@link #settled}). */
		private Step holdBurning(String out, ServerPlayer player, Consumer<AgentInputState> input) {
			afterburn = out;
			input.accept(new AgentInputState(0.0F, 0.0F, false, false, false, false, false,
					player.getYRot(), player.getXRot(), player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			return Step.running(out + burnRemaining(player) + "; holding this footing until the fire is out");
		}

		/**
		 * The exit among {@code reach}'s cells (breadth first, so the first fire-free cell is the nearest by steps: the
		 * feet cell when only the body's edge burns) into {@link #exit}, and whether it is out of the seen flow's way.
		 */
		private void choose(ServerPlayer player, Map<GridPosition, GridPosition> reach, HazardExits.Contact contact,
				LavaSpread.Prediction flow, GridPosition feet) {
			// Lava keeps flowing (about 3 more cells over a floor in the Overworld, 7 in the Nether): a player backs off
			// past its reach. The nearest cell the seen flow does not reach with no lava within LAVA_CLEARANCE wins,
			// then one out of the flow with none beside it, then any out of the flow; with every cell in reach in the
			// flow's way, the one it reaches last (not upstream into it: d22-lava2 swam against the current); with
			// no seen flow at all, the old order: no lava within LAVA_CLEARANCE, none beside, any lava-free cell.
			GridPosition clear = null, apart = null, edge = null, outClear = null, outApart = null, outEdge = null, latest = null;
			double latestSeconds = -1.0D;
			for (GridPosition cell : reach.keySet()) {
				if (!fireFree(player, cell)) continue;
				if (contact == HazardExits.Contact.FIRE || contact == HazardExits.Contact.HOT_FLOOR) {
					clear = cell;
					break;
				}
				// Out of lava means standing beside it, not floating in the cell over it (a hole broken into a pool).
				if (cell.equals(feet) || lavaBelow(player, cell)) continue;
				// Lava above the cell within a step flows down into it: a pit below a flow is where the flow goes next.
				if (lavaAbove(player, cell)) continue;
				LavaSpread.Arrival arrives = flow.standing(cell.x(), cell.y(), cell.z());
				boolean out = arrives == null;
				if (!out && arrives.seconds() > latestSeconds) {
					latest = cell;
					latestSeconds = arrives.seconds();
				}
				boolean beside = lavaWithin(player, cell, 1), near = lavaWithin(player, cell, LAVA_CLEARANCE);
				if (out) {
					if (outEdge == null) outEdge = cell;
					if (outApart == null && !beside) outApart = cell;
					if (!near) {
						outClear = cell;
						break;
					}
				}
				if (edge == null) edge = cell;
				if (apart == null && !beside) apart = cell;
				if (clear == null && !near) clear = cell;
			}
			exitOut = outClear != null || outApart != null || outEdge != null;
			exit = outClear != null ? outClear : outApart != null ? outApart : outEdge != null ? outEdge
					: latest != null ? latest : clear != null ? clear : apart != null ? apart : edge;
		}

		/** Standing (or swimming) out of fire and lava, off a hot floor, where the seen flow does not reach. */
		private boolean safeFooting(ServerPlayer player) {
			if (HazardExits.contact(player) != null || HazardExits.inHazardBlock(player)) return false;
			if (!player.onGround() && !player.isInWater()) return false;
			LavaSpread.Arrival coming = LavaSpread.of(player).box(player.getBoundingBox());
			return coming == null || coming.seconds() > FLOW_LEAVE_SECONDS;
		}

		/** The seen flow reaches the cell's feet or head within the prediction's horizon. */
		static boolean flowReaches(LavaSpread.Prediction flow, GridPosition cell) {
			return flow.standing(cell.x(), cell.y(), cell.z()) != null;
		}

		/** Forward (and jump unless the cell is lower) toward the cell, as a player in lava does: jump swims up and over a ledge. */
		private static AgentInputState swimToward(ServerPlayer player, GridPosition cell) {
			Vec3 centre = new Vec3(cell.x() + 0.5D, player.getEyeY(), cell.z() + 0.5D);
			AgentInputState aim = look(player, centre, 0.0F, 0.0F, false, false, player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND);
			float error = AgentInputStates.shortestAngleDelta(aim.yaw(), (float) Math.toDegrees(Math.atan2(-(centre.x - player.getX()), centre.z - player.getZ())));
			// Swim horizontally toward shore even when its remembered landing is high above us. Rising in place
			// beneath a 40-block cliff never closes the distance to its wall or a climbable rim.
			float forward = CombatPlanning.alignedForward(1.0F, error);
			// Jump swims up: for a way out level with or above the feet, or a ledge in the way. Toward a lower one it
			// only lifts the body up into the lava pouring onto it (d22-lava2 replay: it rose into a lava fall).
			boolean jump = cell.y() >= Mth.floor(player.getY()) || player.horizontalCollision;
			return new AgentInputState(forward, 0.0F, jump, false, false, false, false,
					aim.yaw(), aim.pitch(), aim.selectedSlot(), aim.hand());
		}

		private static String burnRemaining(ServerPlayer player) {
			return player.isOnFire() ? "; still burning " + (player.getRemainingFireTicks() + 19) / 20
					+ " s (raw 1 HP/s); dry ground does not extinguish" : "; no longer burning";
		}

		static boolean touchesFire(ServerPlayer player) {
			return HazardExits.contact(player) == HazardExits.Contact.FIRE;
		}

		/** Lava within {@code radius} horizontal cells of the feet or head cell, or up to two above the head. */
		private static boolean lavaWithin(ServerPlayer player, GridPosition cell, int radius) {
			BlockPos.MutableBlockPos at = new BlockPos.MutableBlockPos();
			for (int dx = -radius; dx <= radius; dx++) {
				for (int dz = -radius; dz <= radius; dz++) {
					for (int dy = 0; dy <= 3; dy++) {
						if (dy >= 2 && (dx != 0 || dz != 0)) continue;
						if (player.level().getFluidState(at.set(cell.x() + dx, cell.y() + dy, cell.z() + dz)).is(net.minecraft.tags.FluidTags.LAVA)) return true;
					}
				}
			}
			return false;
		}

		/** Lava higher than the feet within one cell (beside or over the head, up to three above), so it can flow down here. */
		static boolean lavaAbove(ServerPlayer player, GridPosition cell) {
			BlockPos.MutableBlockPos at = new BlockPos.MutableBlockPos();
			for (int dx = -1; dx <= 1; dx++) {
				for (int dz = -1; dz <= 1; dz++) {
					for (int dy = dx == 0 && dz == 0 ? 2 : 1; dy <= 3; dy++) {
						if (player.level().getFluidState(at.set(cell.x() + dx, cell.y() + dy, cell.z() + dz)).is(net.minecraft.tags.FluidTags.LAVA)) return true;
					}
				}
			}
			return false;
		}

		private static boolean lavaBelow(ServerPlayer player, GridPosition cell) {
			return player.level().getFluidState(new BlockPos(cell.x(), cell.y() - 1, cell.z())).is(net.minecraft.tags.FluidTags.LAVA);
		}

		/** Feet and head cells hold no fire or lava (a body centred in the cell overlaps only those two). */
		static boolean fireFree(ServerPlayer player, GridPosition cell) {
			BlockState floor = player.level().getBlockState(new BlockPos(cell.x(), cell.y() - 1, cell.z()));
			if (HazardExits.hotFloor(floor)) return false;
			for (int dy = 0; dy <= 1; dy++) {
				BlockState state = player.level().getBlockState(new BlockPos(cell.x(), cell.y() + dy, cell.z()));
				if (state.is(net.minecraft.tags.BlockTags.FIRE) || HazardExits.hotFloor(state)
						|| state.getFluidState().is(net.minecraft.tags.FluidTags.LAVA)) return false;
			}
			return true;
		}
	}

	private static String id(ItemStack stack) {
		return BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
	}

	private static String id(BlockState state) {
		return BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
	}

	private static String type(Entity entity) {
		return BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
	}
}
