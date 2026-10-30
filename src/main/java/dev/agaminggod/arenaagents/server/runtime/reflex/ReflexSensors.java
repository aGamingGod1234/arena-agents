package dev.agaminggod.arenaagents.server.runtime.reflex;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.mixin.AbstractArrowInvoker;
import dev.agaminggod.arenaagents.server.perception.ObservationVisibility;
import dev.agaminggod.arenaagents.server.perception.ProjectilePerception;
import dev.agaminggod.arenaagents.server.perception.ThreatPerception;
import dev.agaminggod.arenaagents.server.runtime.controller.HazardExits;
import dev.agaminggod.arenaagents.server.runtime.controller.SafeStep;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.stats.Stats;
import net.minecraft.tags.EntityTypeTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.tags.ItemTags;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.item.ItemEntity;
import dev.agaminggod.arenaagents.server.runtime.InventoryRoom;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.entity.monster.Enderman;
import net.minecraft.world.entity.projectile.Projectile;
import net.minecraft.world.entity.projectile.arrow.AbstractArrow;
import net.minecraft.world.entity.projectile.hurtingprojectile.AbstractHurtingProjectile;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Condition sensing from what the player perceives: visible projectiles, mobs in line of sight, the HUD (health, air,
 * hunger, fire) and the break of the held tool (its sound and the empty hand). A new condition adds a case here and
 * registers its parameters in {@link ReflexSpec}.
 */
public final class ReflexSensors {
	/** How far a mob counts as "in reach" candidates are searched; real reach is the held item's attack range. */
	private static final double REACH_SEARCH = 6.0D;

	private ReflexSensors() {
	}

	/** {@code point} is a place the condition is about (an edge, lava) when there is no entity to aim at. */
	record Reading(boolean truth, Entity focus, Vec3 point) {
		static final Reading FALSE = new Reading(false, null, null);

		Reading(boolean truth, Entity focus) {
			this(truth, focus, null);
		}
	}

	/** Per-agent memory for edge facts that need the previous tick (the held tool before it broke). */
	/** Seconds of air a player keeps beyond the swim to air before it stops fighting to breathe. */
	static final double BREATH_MARGIN_S = 3.0D;
	/** The swim to air assumed when no breathable cell has been seen. */
	static final double UNKNOWN_SWIM_S = 2.0D;

	/** Why the body must breathe before it fights, or null: the eyes are under water and the air is short of the swim to air. */
	static String breathShort(ServerPlayer player) {
		if (!player.isUnderWater()) return null;
		var surface = ReflexActions.airRoute(player);
		double swim = surface == null ? UNKNOWN_SWIM_S
				: surface.distance() / dev.agaminggod.arenaagents.server.runtime.controller.SwimPlanning.SURFACING_BLOCKS_PER_SECOND;
		return breathShort(player.getAirSupply(), player.getMaxAirSupply(), swim);
	}

	/** {@link #breathShort(ServerPlayer)} for an air supply (ticks), its maximum and the seconds the swim to air takes. */
	static String breathShort(int air, int maxAir, double swimSeconds) {
		double left = dev.agaminggod.arenaagents.server.runtime.controller.SwimPlanning.airSecondsLeft(air);
		if (left >= swimSeconds + BREATH_MARGIN_S) return null;
		return String.format(java.util.Locale.ROOT, "air low (%d of %d bubbles, %.1f s swim to air): breathing first",
				(Math.max(0, air) + 29) / 30, (maxAir + 29) / 30, swimSeconds);
	}

	static final class Memory {
		private int slot = -1;
		private Item held;
		private int brokenBefore;
		private long brokeTick = Long.MIN_VALUE;
		private String brokeKind;
		private String brokeItem;
		private Item stackItem;
		private int stackCount;
		private long usedUpTick = Long.MIN_VALUE;
		private String usedUpItem;
		/** The uses-left threshold of a tool_low reading that holds this tick: a swap skips tools at or below it. */
		private int lowUses = -1;
		/** Whether the agent has an action running (paused under a firing or not); {@code stop} waits for it to end. */
		private boolean actionActive;
		private net.minecraft.resources.ResourceKey<net.minecraft.world.level.Level> footingDimension;
		private final java.util.ArrayDeque<GridPosition> dryFooting = new java.util.ArrayDeque<>();

		List<GridPosition> dryFooting() {
			return List.copyOf(dryFooting);
		}

		void observe(ServerPlayer player, long tick) {
			if (footingDimension != player.level().dimension()) {
				footingDimension = player.level().dimension();
				dryFooting.clear();
			}
			if (player.onGround() && !HazardExits.inHazardBlock(player)) {
				BlockPos feet = player.blockPosition();
				var floor = player.level().getBlockState(feet.below());
				if (floor.isCollisionShapeFullBlock(player.level(), feet.below())) {
					GridPosition cell = new GridPosition(feet.getX(), feet.getY(), feet.getZ());
					if (!cell.equals(dryFooting.peekFirst())) {
						dryFooting.addFirst(cell);
						if (dryFooting.size() > 8) dryFooting.removeLast();
					}
				}
			}

			int selected = player.getInventory().getSelectedSlot();
			ItemStack stack = player.getMainHandItem();
			lowUses = -1;
			// A stack that is not a tool emptied in the hand: the last block placed, the last torch, the last food eaten.
			if (stackItem != null && slot == selected && stack.isEmpty()) {
				usedUpTick = tick;
				usedUpItem = BuiltInRegistries.ITEM.getKey(stackItem).toString();
			}
			stackItem = !stack.isEmpty() && !stack.isDamageableItem() ? stack.getItem() : null;
			stackCount = stackItem == null ? 0 : stack.getCount();
			// The stat counts every break of that item: an increase while it was the held tool is the break a player hears.
			if (held != null && slot == selected) {
				int broken = player.getStats().getValue(Stats.ITEM_BROKEN, held);
				if (broken > brokenBefore && (stack.isEmpty() || stack.getItem() != held)) {
					brokeTick = tick;
					brokeKind = toolKind(new ItemStack(held));
					brokeItem = BuiltInRegistries.ITEM.getKey(held).toString();
				}
			}
			slot = selected;
			held = !stack.isEmpty() && stack.isDamageableItem() ? stack.getItem() : null;
			brokenBefore = held == null ? 0 : player.getStats().getValue(Stats.ITEM_BROKEN, held);
		}

		boolean brokeAt(long tick) {
			return brokeTick == tick;
		}

		String brokeKind() {
			return brokeKind;
		}

		String brokeItem() {
			return brokeItem;
		}

		boolean usedUpAt(long tick) {
			return usedUpTick == tick;
		}

		String usedUpItem() {
			return usedUpItem;
		}

		int lowUses() {
			return lowUses;
		}

		void actionActive(boolean active) {
			actionActive = active;
		}

		boolean actionActive() {
			return actionActive;
		}
	}

	static String toolKind(ItemStack stack) {
		if (stack.isEmpty()) return null;
		if (stack.is(ItemTags.PICKAXES)) return "pickaxe";
		if (stack.is(ItemTags.AXES)) return "axe";
		if (stack.is(ItemTags.SHOVELS)) return "shovel";
		if (stack.is(ItemTags.HOES)) return "hoe";
		if (stack.is(ItemTags.SWORDS)) return "sword";
		if (stack.is(Items.SHIELD)) return "shield";
		return null;
	}

	static Reading sense(ServerPlayer player, ReflexSpec.Condition condition, ObservationVisibility.Frame frame, Memory memory, long tick) {
		Reading raw = switch (condition.type()) {
			case "incoming_projectile" -> incoming(player, condition, frame);
			case "hostile_near" -> hostile(player, condition.ids("mobs"), condition.number("within", 8.0D), frame, false, condition.text("targetId"));
			case "target_in_reach" -> hostile(player, condition.ids("mobs"), REACH_SEARCH, frame, true);
			case "health_below" -> flag(player.getHealth() < condition.number("value", 0.0D));
			case "air_below" -> flag(player.getAirSupply() / 30.0D < condition.number("bubbles", 0.0D));
			case "hunger_below" -> flag(player.getFoodData().getFoodLevel() < condition.number("value", 0.0D));
			case "tool_broke" -> flag(memory.brokeAt(tick) && toolMatches(condition.text("tool"), memory.brokeKind()));
			case "on_fire" -> flag(player.isOnFire());
			case "in_lava" -> flag(player.isInLava());
			case "in_fire" -> flag(HazardExits.contact(player) == HazardExits.Contact.FIRE);
			case "on_hot_floor" -> flag(HazardExits.contact(player) == HazardExits.Contact.HOT_FLOOR);
			case "inventory_full" -> flag(player.getInventory().getFreeSlot() < 0);
			case "item_nearby" -> itemNearby(player, condition.ids("items"), condition.number("within", 4.0D), frame);
			case "tool_low" -> toolLow(player, (int) condition.number("uses", 1.0D), condition.text("tool"), memory);
			case "falling" -> flag(!player.onGround() && !player.isInWater() && !player.isFallFlying() && !player.getAbilities().flying
					&& player.fallDistance >= condition.number("blocks", 3.0D));
			// The hunger bar jitters when saturation is gone; that is all a player sees of it.
			case "saturation_empty" -> flag(player.getFoodData().getSaturationLevel() <= 0.0F);
			case "night" -> flag(night(player));
			case "stack_used_up" -> flag(memory.usedUpAt(tick) && (condition.text("item") == null || condition.text("item").equals(memory.usedUpItem())));
			case "fireball_incoming" -> fireball(player, condition, frame);
			case "creeper_fusing" -> creeperFusing(player, condition.number("within", 6.0D), frame);
			case "enderman_gaze" -> enderman(player, condition.number("within", 64.0D), frame, true);
			case "enderman_provoked" -> enderman(player, condition.number("within", 16.0D), frame, false);
			case "edge_near" -> edge(player, condition.number("within", 1.0D), condition.text("direction"), condition.number("drop", 4.0D));
			case "lava_near" -> lava(player, condition.number("within", 2.0D), frame);
			case "lava_flowing" -> lavaFlowing(player, condition.number("withinS", 3.0D));
			case "attacked_from_behind" -> behind(player, condition.number("within", 4.0D), frame);
			case "exposed" -> exposed(player, condition.ids("mobs"), condition.number("within", 16.0D));
			case "cloud_near" -> cloud(player, condition.number("within", 1.0D));
			case "dragon_charging" -> dragonCharging(player, condition.number("within", DRAGON_CHARGE_RANGE), frame);
			// The in-wall view (the block's texture fills the screen) and its damage every half second.
			case "suffocating" -> flag(!ReflexActions.DigOut.stuckCells(player).isEmpty());
			default -> Reading.FALSE;
		};
		if (!condition.negated()) return raw;
		return new Reading(!raw.truth(), null);
	}

	/** The held tool's durability bar: at most {@code uses} uses left (the bar's width, or the exact count in the tooltip). */
	private static Reading toolLow(ServerPlayer player, int uses, String tool, Memory memory) {
		ItemStack stack = player.getMainHandItem();
		if (stack.isEmpty() || !stack.isDamageableItem() || stack.getMaxDamage() - stack.getDamageValue() > uses) return Reading.FALSE;
		if (tool != null && !"any".equals(tool) && !tool.equals(toolKind(stack))) return Reading.FALSE;
		memory.lowUses = Math.max(memory.lowUses, uses);
		return new Reading(true, null);
	}

	/** The sky has started to darken (sunset onward until dawn), seen through open sky or on a carried clock. */
	static boolean night(ServerPlayer player) {
		var level = player.level();
		if (!level.dimension().equals(net.minecraft.world.level.Level.OVERWORLD)) return false;
		boolean sky = level.canSeeSky(net.minecraft.core.BlockPos.containing(player.getEyePosition()));
		if (!sky && !player.getInventory().contains(new ItemStack(Items.CLOCK))) return false;
		long time = Math.floorMod(level.getDefaultClockTime(), 24_000L);
		return time >= 12_000L && time < 23_000L;
	}

	/** The nearest dropped item in view within range that the inventory has room for; it is the focus a pickup walks to. */
	private static Reading itemNearby(ServerPlayer player, Set<String> types, double within, ObservationVisibility.Frame frame) {
		ItemEntity nearest = null;
		double best = Double.POSITIVE_INFINITY;
		for (ItemEntity item : player.level().getEntitiesOfClass(ItemEntity.class, player.getBoundingBox().inflate(within),
				candidate -> candidate.isAlive() && !candidate.getItem().isEmpty())) {
			if (!types.isEmpty() && !types.contains(BuiltInRegistries.ITEM.getKey(item.getItem().getItem()).toString())) continue;
			double distance = player.distanceTo(item);
			if (distance > within || distance >= best) continue;
			if (!InventoryRoom.canTake(player, item.getItem()) || !frame.canSeeEntity(item)) continue;
			best = distance;
			nearest = item;
		}
		return nearest == null ? Reading.FALSE : new Reading(true, nearest);
	}

	private static boolean toolMatches(String wanted, String broke) {
		return broke != null && (wanted == null || "any".equals(wanted) || wanted.equals(broke));
	}

	private static Reading flag(boolean truth) {
		return truth ? new Reading(true, null) : Reading.FALSE;
	}

	/** A visible projectile in flight whose swept path reaches the body within {@code withinS}; the soonest is the focus. */
	private static Reading incoming(ServerPlayer player, ReflexSpec.Condition condition, ObservationVisibility.Frame frame) {
		double within = condition.number("withinS", 1.0D);
		Set<String> types = condition.ids("projectiles");
		Projectile soonest = null;
		double best = Double.POSITIVE_INFINITY;
		for (Projectile projectile : player.level().getEntitiesOfClass(Projectile.class,
				player.getBoundingBox().inflate(ProjectilePerception.RANGE), Projectile::isAlive)) {
			String type = BuiltInRegistries.ENTITY_TYPE.getKey(projectile.getType()).toString();
			if (types.isEmpty() ? !ProjectilePerception.supported(type) : !types.contains(type)) continue;
			if (projectile.getOwner() == player) continue;
			boolean grounded = projectile instanceof AbstractArrow arrow && ((AbstractArrowInvoker) arrow).arenaagents$isInGround();
			if (!ProjectilePerception.flying(grounded, projectile.getDeltaMovement())) continue;
			double eta = ProjectilePerception.impactSeconds(projectile.position(), projectile.getDeltaMovement(), player.getBoundingBox(),
					player.getDeltaMovement(), type.contains("fireball"), ProjectilePerception.HIT_MARGIN,
					(from, to) -> player.level().clip(new ClipContext(from, to, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, projectile))
							.getType() == HitResult.Type.MISS);
			if (!Double.isFinite(eta) || eta > within || eta >= best) continue;
			if (!frame.canSeeEntity(projectile)) continue;
			best = eta;
			soonest = projectile;
		}
		return soonest == null ? Reading.FALSE : new Reading(true, soonest);
	}

	/**
	 * The nearest listed (or, unlisted, hostile) mob within range that the player can see or would notice: in line of
	 * sight, not invisible. {@code reach} additionally requires it inside the held item's attack range.
	 */
	private static Reading hostile(ServerPlayer player, Set<String> types, double within, ObservationVisibility.Frame frame, boolean reach) {
		return hostile(player, types, within, frame, reach, null);
	}

	private static Reading hostile(ServerPlayer player, Set<String> types, double within, ObservationVisibility.Frame frame, boolean reach, String targetId) {
		LivingEntity nearest = null;
		double best = Double.POSITIVE_INFINITY;
		var range = player.getAttackRangeWith(player.getMainHandItem());
		for (LivingEntity entity : player.level().getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(within),
				candidate -> candidate != player && candidate.isAlive() && !candidate.isDeadOrDying())) {
			if (targetId != null && !targetId.equals(entity.getUUID().toString())) continue;
			String type = BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
			if (types.isEmpty() ? !(entity instanceof Mob mob && ThreatPerception.isHostileTo(mob, player)) : !types.contains(type)) continue;
			// The dragon is seen and reached through its parts; its root sits inside them (and the fountain when perched),
			// up to 8 blocks from the head a player swings at.
			Entity probe = entity instanceof net.minecraft.world.entity.boss.enderdragon.EnderDragon dragon ? ReflexActions.dragonPart(player, dragon) : entity;
			double distance = player.distanceTo(probe);
			if (distance > within || distance >= best || entity.isInvisibleTo(player)) continue;
			if (reach && !range.isInRange(player, probe.getBoundingBox(), 0.0D)) continue;
			if (!frame.hasLineOfSight(probe)) continue;
			best = distance;
			nearest = entity;
		}
		return nearest == null ? Reading.FALSE : new Reading(true, nearest);
	}

	/**
	 * A visible fireball-type projectile (ghast or blaze fireball, wither skull, wind charge) whose flight reaches the
	 * body within {@code withinS}. {@code deflectable} keeps only those a punch sends back (vanilla
	 * {@code #redirectable_projectile}: ghast fireballs and wind charges, not blaze fireballs).
	 */
	private static Reading fireball(ServerPlayer player, ReflexSpec.Condition condition, ObservationVisibility.Frame frame) {
		double within = condition.number("withinS", 1.5D);
		boolean deflectable = condition.flag("deflectable");
		Projectile soonest = null;
		double best = Double.POSITIVE_INFINITY;
		for (AbstractHurtingProjectile projectile : player.level().getEntitiesOfClass(AbstractHurtingProjectile.class,
				player.getBoundingBox().inflate(ProjectilePerception.RANGE), Projectile::isAlive)) {
			if (projectile.getOwner() == player) continue;
			if (deflectable && !ReflexSensors.redirectable(projectile)) continue;
			double eta = ProjectilePerception.impactSeconds(projectile.position(), projectile.getDeltaMovement(), player.getBoundingBox(),
					player.getDeltaMovement(), true, ProjectilePerception.HIT_MARGIN,
					(from, to) -> player.level().clip(new ClipContext(from, to, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, projectile))
							.getType() == HitResult.Type.MISS);
			if (!Double.isFinite(eta) || eta > within || eta >= best) continue;
			// A fireball is bright and loud: seen in line of sight, even at the edge of view.
			if (!frame.hasLineOfSight(projectile)) continue;
			best = eta;
			soonest = projectile;
		}
		return soonest == null ? Reading.FALSE : new Reading(true, soonest);
	}

	/**
	 * The soonest shot a raised shield stops that hits the body within {@code withinS}: a fireball in line of sight
	 * (bright and loud, as for {@code fireball_incoming}), any other projectile in view (as for {@code incoming_projectile}).
	 */
	static Projectile incomingShot(ServerPlayer player, double withinS) {
		return incoming(player, withinS, true);
	}

	/** {@link #incomingShot} for actions: the soonest perceived shot a raised shield stops, landing within {@code withinS}. */
	public static Projectile blockableShot(ServerPlayer player, double withinS) {
		return incoming(player, withinS, true);
	}

	/** {@link #aimPoint} for actions: where a shield faces to stop this shot (the line it flies in from). */
	public static Vec3 shieldFacing(Entity shot) {
		return aimPoint(shot);
	}

	/**
	 * The soonest perceived projectile of any kind {@code incoming_projectile} senses (dragon fireballs too) that hits the
	 * body within {@code withinS}: what a fight side-steps.
	 */
	public static Projectile incomingProjectile(ServerPlayer player, double withinS) {
		return incoming(player, withinS, false);
	}

	private static Projectile incoming(ServerPlayer player, double withinS, boolean blockableOnly) {
		Projectile soonest = null;
		double best = Double.POSITIVE_INFINITY;
		ObservationVisibility.Frame frame = null;
		for (Projectile projectile : player.level().getEntitiesOfClass(Projectile.class,
				player.getBoundingBox().inflate(ProjectilePerception.RANGE), Projectile::isAlive)) {
			if (projectile.getOwner() == player) continue;
			String type = BuiltInRegistries.ENTITY_TYPE.getKey(projectile.getType()).toString();
			boolean arrow = projectile instanceof AbstractArrow;
			if (blockableOnly ? !ProjectilePerception.shieldBlockable(type, arrow && ((AbstractArrow) projectile).getPierceLevel() > 0)
					: !ProjectilePerception.supported(type)) continue;
			boolean grounded = arrow && ((AbstractArrowInvoker) projectile).arenaagents$isInGround();
			if (!ProjectilePerception.flying(grounded, projectile.getDeltaMovement())) continue;
			double eta = ProjectilePerception.impactSeconds(projectile.position(), projectile.getDeltaMovement(), player.getBoundingBox(),
					player.getDeltaMovement(), type.contains("fireball"), ProjectilePerception.HIT_MARGIN,
					(from, to) -> player.level().clip(new ClipContext(from, to, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, projectile))
							.getType() == HitResult.Type.MISS);
			if (!Double.isFinite(eta) || eta > withinS || eta >= best) continue;
			if (frame == null) frame = ObservationVisibility.frame(player.level(), player);
			if (!(projectile instanceof AbstractHurtingProjectile ? frame.hasLineOfSight(projectile) : frame.canSeeEntity(projectile))) continue;
			best = eta;
			soonest = projectile;
		}
		return soonest;
	}

	/** Default range of {@code dragon_charging}: the dragon covers it in about 3 s. */
	static final double DRAGON_CHARGE_RANGE = 48.0D;
	/** Its flight passes within this of the body (its wings throw anyone within about 6 blocks of them). */
	static final double DRAGON_PASS_BLOCKS = 10.0D;
	/** How far ahead its flight line is followed. */
	static final double DRAGON_LOOKAHEAD_TICKS = 60.0D;

	/**
	 * The dragon seen flying (not perched) within {@code within} whose flight, followed in a straight line for up to 3 s,
	 * passes within {@link #DRAGON_PASS_BLOCKS} of the body: the swoop whose body throws a player 5-15 blocks. What a
	 * player sees: where it is and which way it flies.
	 */
	private static Reading dragonCharging(ServerPlayer player, double within, ObservationVisibility.Frame frame) {
		for (net.minecraft.world.entity.boss.enderdragon.EnderDragon dragon : player.level().getEntitiesOfClass(
				net.minecraft.world.entity.boss.enderdragon.EnderDragon.class, player.getBoundingBox().inflate(within),
				net.minecraft.world.entity.boss.enderdragon.EnderDragon::isAlive)) {
			if (dragon.getPhaseManager().getCurrentPhase().isSitting()) continue;
			boolean seen = false;
			for (var part : dragon.getSubEntities()) if (frame.hasLineOfSight(part)) { seen = true; break; }
			if (!seen) continue;
			Vec3 body = player.getBoundingBox().getCenter();
			if (dragonPasses(dragon.position(), dragon.position().subtract(dragon.xo, dragon.yo, dragon.zo), body, within)) {
				return new Reading(true, dragon);
			}
		}
		return Reading.FALSE;
	}

	/** Whether a flier at {@code at} moving {@code velocity} a tick comes within the pass distance of {@code body} soon. */
	static boolean dragonPasses(Vec3 at, Vec3 velocity, Vec3 body, double within) {
		Vec3 to = body.subtract(at);
		if (to.length() > within) return false;
		if (to.length() <= DRAGON_PASS_BLOCKS * 0.6D) return true;
		double speed = velocity.lengthSqr();
		if (speed < 1.0E-4D) return false;
		double t = Mth.clamp(to.dot(velocity) / speed, 0.0D, DRAGON_LOOKAHEAD_TICKS);
		if (t <= 0.0D) return false;
		return at.add(velocity.scale(t)).distanceTo(body) <= DRAGON_PASS_BLOCKS;
	}

	/** A harmful cloud (dragon breath) the player is in or near; the point is its centre at the player's height. */
	private static Reading cloud(ServerPlayer player, double within) {
		var cloud = dev.agaminggod.arenaagents.server.perception.CloudDanger.nearestHarmful(player, within);
		return cloud == null ? Reading.FALSE : new Reading(true, null, new Vec3(cloud.getX(), player.getY(), cloud.getZ()));
	}

	/** Whether a punch sends this projectile back (vanilla {@code #redirectable_projectile}). */
	static boolean redirectable(Entity projectile) {
		return projectile.getType().builtInRegistryHolder().is(EntityTypeTags.REDIRECTABLE_PROJECTILE);
	}

	/** The nearest creeper swelling to explode (it flashes and hisses, so it is heard without sight) within range. */
	private static Reading creeperFusing(ServerPlayer player, double within, ObservationVisibility.Frame frame) {
		Creeper nearest = null;
		double best = Double.POSITIVE_INFINITY;
		for (Creeper creeper : player.level().getEntitiesOfClass(Creeper.class, player.getBoundingBox().inflate(within), Creeper::isAlive)) {
			if (creeper.getSwellDir() <= 0 && creeper.getSwelling(1.0F) <= 0.0F) continue;
			double distance = player.distanceTo(creeper);
			if (distance > within || distance >= best) continue;
			best = distance;
			nearest = creeper;
		}
		return nearest == null ? Reading.FALSE : new Reading(true, nearest);
	}

	/** Twice vanilla's stare tolerance, so a reflex turns away before the stare provokes the enderman. */
	private static final double GAZE_TOLERANCE = 0.05D;

	/**
	 * {@code gaze}: the crosshair is on (or about to reach) a calm enderman's head, the stare that provokes it (unless a
	 * carved pumpkin is worn). One already after this player stays angry whatever it is looked at, so it never reads
	 * as a gaze; looking away from it would only spoil the defence. Otherwise: an enderman is provoked (jaw open,
	 * shaking, screaming) within range.
	 */
	private static Reading enderman(ServerPlayer player, double within, ObservationVisibility.Frame frame, boolean gaze) {
		if (gaze && !LivingEntity.PLAYER_NOT_WEARING_DISGUISE_ITEM.test(player)) return Reading.FALSE;
		Enderman nearest = null;
		double best = Double.POSITIVE_INFINITY;
		for (Enderman enderman : player.level().getEntitiesOfClass(Enderman.class, player.getBoundingBox().inflate(within), Enderman::isAlive)) {
			double distance = player.distanceTo(enderman);
			if (distance > within || distance >= best) continue;
			if (gaze ? enderman.getTarget() == player || !enderman.isLookingAtMe(player, GAZE_TOLERANCE, true, false, enderman.getEyeY())
					: !enderman.isCreepy() || !frame.hasLineOfSight(enderman) && distance > 16.0D) continue;
			best = distance;
			nearest = enderman;
		}
		return nearest == null ? Reading.FALSE : new Reading(true, nearest);
	}

	/**
	 * A fall of at least {@code drop} blocks (or the void) within {@code within} blocks in a direction relative to the
	 * body, judged from terrain the player has seen. The point is the edge cell.
	 */
	private static Reading edge(ServerPlayer player, double within, String direction, double drop) {
		String mode = direction == null ? "moving" : direction;
		List<Vec3> headings = new ArrayList<>(8);
		double yaw = Math.toRadians(player.getYRot());
		Vec3 ahead = new Vec3(-Math.sin(yaw), 0.0D, Math.cos(yaw));
		Vec3 right = new Vec3(-ahead.z, 0.0D, ahead.x);
		switch (mode) {
			case "ahead" -> headings.add(ahead);
			case "behind" -> headings.add(ahead.scale(-1.0D));
			case "left" -> headings.add(right.scale(-1.0D));
			case "right" -> headings.add(right);
			case "any" -> {
				for (int index = 0; index < 8; index++) {
					double angle = Math.PI / 4.0D * index;
					headings.add(new Vec3(Math.cos(angle), 0.0D, Math.sin(angle)));
				}
			}
			default -> {
				Vec3 motion = new Vec3(player.getDeltaMovement().x, 0.0D, player.getDeltaMovement().z);
				if (motion.lengthSqr() < 1.0E-4D) return Reading.FALSE;
				headings.add(motion.normalize());
			}
		}
		Vec3 from = player.position();
		int feetY = SafeStep.feet(player).y();
		for (Vec3 heading : headings) {
			for (double distance = 0.4D; distance <= within + 1.0E-6D; distance += 0.3D) {
				Vec3 at = from.add(heading.scale(distance));
				GridPosition cell = new GridPosition(Mth.floor(at.x), feetY, Mth.floor(at.z));
				if (SafeStep.dropDepth(player, cell) >= drop) {
					return new Reading(true, null, new Vec3(cell.x() + 0.5D, feetY, cell.z() + 0.5D));
				}
			}
		}
		return Reading.FALSE;
	}

	/** Lava within {@code within} blocks of the feet, at feet level or just below/above: seen, or felt beside the body. */
	/**
	 * Known lava flowing at the body: its predicted spread reaches the feet or head within withinS. The point is the cell
	 * the flow enters the body's cells from, so step_back backs away from it and place_block dams it.
	 */
	private static Reading lavaFlowing(ServerPlayer player, double withinS) {
		dev.agaminggod.arenaagents.server.perception.LavaSpread.Arrival arrival = dev.agaminggod.arenaagents.server.perception.LavaSpread.towardBody(player);
		if (arrival == null || arrival.seconds() > withinS + 1.0E-6D) return Reading.FALSE;
		return new Reading(true, null, Vec3.atCenterOf(arrival.via()));
	}

	private static Reading lava(ServerPlayer player, double within, ObservationVisibility.Frame frame) {
		int radius = Mth.ceil(within);
		BlockPos feet = player.blockPosition();
		Vec3 nearest = null;
		double best = Double.POSITIVE_INFINITY;
		BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
		for (int dy = -1; dy <= 1; dy++) {
			for (int dx = -radius; dx <= radius; dx++) {
				for (int dz = -radius; dz <= radius; dz++) {
					cursor.set(feet.getX() + dx, feet.getY() + dy, feet.getZ() + dz);
					if (!player.level().getFluidState(cursor).is(FluidTags.LAVA)) continue;
					Vec3 centre = Vec3.atCenterOf(cursor);
					double distance = Math.hypot(centre.x - player.getX(), centre.z - player.getZ());
					if (distance > within + 0.5D || distance >= best) continue;
					if (distance > 1.5D && !frame.seesCell(cursor.immutable())) continue;
					best = distance;
					nearest = centre;
				}
			}
		}
		return nearest == null ? Reading.FALSE : new Reading(true, null, nearest);
	}

	/**
	 * A mob behind the player (outside the view) that just hit it (the hurt and the knockback are felt) or that is
	 * closing in on it (heard), within range.
	 */
	private static Reading behind(ServerPlayer player, double within, ObservationVisibility.Frame frame) {
		LivingEntity attacker = player.getLastHurtByMob();
		if (attacker != null && attacker.isAlive() && player.tickCount - player.getLastHurtByMobTimestamp() <= 20
				&& player.distanceTo(attacker) <= within && !frame.isEntityWithinView(attacker)) {
			return new Reading(true, attacker);
		}
		Mob nearest = null;
		double best = Double.POSITIVE_INFINITY;
		for (Mob mob : player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(within),
				candidate -> candidate.isAlive() && candidate.getTarget() == player)) {
			double distance = player.distanceTo(mob);
			if (distance > within || distance >= best || frame.isEntityWithinView(mob)) continue;
			best = distance;
			nearest = mob;
		}
		return nearest == null ? Reading.FALSE : new Reading(true, nearest);
	}

	/**
	 * A listed (or, unlisted, hostile) mob within range with a clear line of sight to the player: one that can shoot or
	 * see it. Negated, this is the cover state.
	 */
	private static Reading exposed(ServerPlayer player, Set<String> types, double within) {
		LivingEntity nearest = null;
		double best = Double.POSITIVE_INFINITY;
		for (Mob mob : player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(within), Mob::isAlive)) {
			String type = BuiltInRegistries.ENTITY_TYPE.getKey(mob.getType()).toString();
			if (types.isEmpty() ? !ThreatPerception.isHostileTo(mob, player) : !types.contains(type)) continue;
			double distance = player.distanceTo(mob);
			if (distance > within || distance >= best || mob.isInvisibleTo(player) || !mob.hasLineOfSight(player)) continue;
			best = distance;
			nearest = mob;
		}
		return nearest == null ? Reading.FALSE : new Reading(true, nearest);
	}

	/** Where to face: a mob's body, or for a projectile the line it is flying in from (a shield blocks what comes from the front). */
	static Vec3 aimPoint(Entity focus) {
		if (!(focus instanceof Projectile)) return focus.getBoundingBox().getCenter();
		Vec3 velocity = focus.getDeltaMovement();
		return velocity.lengthSqr() < 1.0E-6D ? focus.position() : focus.position().subtract(velocity.normalize().scale(8.0D));
	}
}
