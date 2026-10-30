package dev.agaminggod.arenaagents.server.runtime;

import dev.agaminggod.arenaagents.server.perception.ObservationVisibility;
import dev.agaminggod.arenaagents.server.perception.ThreatPerception;
import dev.agaminggod.arenaagents.server.runtime.controller.ServerController;
import dev.agaminggod.arenaagents.server.runtime.controller.ServerItemPickupController;
import dev.agaminggod.arenaagents.server.runtime.controller.ServerLookController;
import dev.agaminggod.arenaagents.server.runtime.controller.ServerNavigationController;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.piglin.AbstractPiglin;
import net.minecraft.world.entity.monster.piglin.Piglin;
import net.minecraft.world.entity.monster.piglin.PiglinAi;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.Vec3;

/**
 * barter_until: the player's bartering loop, chosen by the model. With gold armour worn, it walks to the nearest calm
 * adult piglin it can see that is not already examining an item, throws one gold ingot toward its feet (a vanilla Q drop
 * the piglin picks up), turns to the next free piglin, and walks over the items the piglins throw back (vanilla contact
 * pickup). It counts the asked item by the inventory change since the call started.
 */
public final class ServerBarterController implements ServerController {
	static final double PIGLIN_RANGE = 16.0D;
	static final double THROW_RANGE = 2.6D;
	static final double DROP_RANGE = 8.0D;
	static final double HOSTILE_RANGE = 12.0D;
	static final float LOW_HEALTH = 8.0F;
	/** A thrown ingot the piglin has not taken in this time frees it for another throw. */
	static final long THROW_WAIT_MS = 4_000L;
	/** A piglin examines an ingot about 6 s before it throws its return. */
	static final long RETURN_WAIT_MS = 9_000L;

	private final Item wanted;
	private final String wantedId;
	private final int count;
	private final long timeoutMs;
	private final ElapsedTimeAccumulator elapsed;
	private ResourceKey<Level> dimension;
	private float lastHealth = Float.NaN;
	private int startWanted, startGold;
	private final Map<Item, Integer> startCounts = new HashMap<>();
	private final Set<UUID> ignoredDrops = new HashSet<>();
	private final Map<UUID, Long> busyUntil = new HashMap<>();
	private long lastThrowMs = Long.MIN_VALUE / 2;
	private Vec3 scanAim;
	private int scanSteps;
	private int thrown;
	private ServerItemPickupController pickup;
	private UUID pickupId;
	private ServerNavigationController walk;
	private UUID walkTarget;
	private Vec3 walkGoal;
	private int pause, turnTicks;

	public ServerBarterController(String itemId, int count, long timeoutMs, long startedAt) {
		this.wantedId = itemId.contains(":") ? itemId : "minecraft:" + itemId;
		this.wanted = BuiltInRegistries.ITEM.getOptional(net.minecraft.resources.Identifier.parse(wantedId)).orElse(Items.AIR);
		this.count = Math.max(1, count);
		this.timeoutMs = timeoutMs;
		this.elapsed = new ElapsedTimeAccumulator(startedAt);
	}

	@Override
	public TickResult tick(ServerPlayer player, long nowEpochMs) {
		if (dimension == null) {
			if (wanted == Items.AIR) return TickResult.failed("INVALID_ITEM", "Unknown item " + wantedId, 0.0D);
			dimension = player.level().dimension();
			lastHealth = player.getHealth();
			startWanted = carried(player, wanted);
			startGold = carried(player, Items.GOLD_INGOT);
			for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (!stack.isEmpty()) startCounts.merge(stack.getItem(), stack.getCount(), Integer::sum);
			}
			for (ItemEntity drop : player.level().getEntitiesOfClass(ItemEntity.class, player.getBoundingBox().inflate(PIGLIN_RANGE)))
				ignoredDrops.add(drop.getUUID());
			if (!PiglinAi.isWearingSafeArmor(player)) return stop(player, "NO_GOLD_ARMOUR", "No gold armour piece is worn; piglins attack a player without one");
		}
		if (!player.level().dimension().equals(dimension)) return stop(player, "ACTION_DIMENSION_CHANGED", "The body changed dimension");
		if (elapsed.advance(nowEpochMs) >= timeoutMs) {
			release(player);
			return TickResult.timedOut("BARTER_TIMED_OUT", summary(player, "timeoutMs ran out"), progress(player));
		}
		TickResult danger = danger(player);
		if (danger != null) return danger;
		if (gained(player) >= count) return done(player, "BARTER_COUNT_REACHED", gained(player) + " " + wantedId + " gained (asked " + count + ")");
		if (pickup != null) {
			TickResult r = pickup.tick(player, nowEpochMs);
			if (r.state() == State.RUNNING) return TickResult.running(progress(player));
			pickup.cancel(player);
			ignoredDrops.add(pickupId);
			pickup = null;
		}
		if (pause > 0) { pause--; return TickResult.running(progress(player)); }
		ItemEntity drop = nearestDrop(player);
		if (drop != null) {
			stopWalk(player);
			pickupId = drop.getUUID();
			pickup = new ServerItemPickupController(player, drop, nowEpochMs, 10_000L);
			return TickResult.running(progress(player));
		}
		boolean waiting = nowEpochMs - lastThrowMs < RETURN_WAIT_MS || anyAdmiring(player);
		if (carried(player, Items.GOLD_INGOT) == 0) {
			if (waiting) return TickResult.running(progress(player));
			return stop(player, "OUT_OF_GOLD", "No gold ingot left");
		}
		Piglin target = freePiglin(player, nowEpochMs);
		if (target == null) {
			stopWalk(player);
			// None free in view: turn on the spot in 60 degree steps, as a player looks around, to find piglins and returns.
			if (scanAim == null) {
				double yaw = Math.toRadians(player.getYRot() + 60.0F);
				scanAim = player.getEyePosition().add(-Math.sin(yaw) * 6.0D, -1.2D, Math.cos(yaw) * 6.0D);
			}
			if (ServerLookController.turnToward(player, scanAim)) {
				scanAim = null;
				scanSteps = visiblePiglins(player).isEmpty() ? scanSteps + 1 : 0;
				pause = 6;
			}
			if (scanSteps >= 6 && !waiting) return stop(player, "NO_PIGLIN", "No calm adult piglin in sight within " + (int) PIGLIN_RANGE + " blocks after a full look around");
			return TickResult.running(progress(player));
		}
		scanSteps = 0;
		scanAim = null;
		double distance = player.distanceTo(target);
		if (distance > THROW_RANGE) {
			Vec3 goal = target.position();
			if (walk == null || !target.getUUID().equals(walkTarget) || walkGoal.distanceToSqr(goal) > 2.25D) {
				stopWalk(player);
				walk = new ServerNavigationController(goal, 1.8D, false, nowEpochMs, 15_000L, true);
				walkTarget = target.getUUID();
				walkGoal = goal;
			}
			TickResult moved = walk.tick(player, nowEpochMs);
			if (moved.state() == State.RUNNING) return TickResult.running(progress(player));
			stopWalk(player);
			if (moved.state() != State.SUCCEEDED) busyUntil.put(target.getUUID(), nowEpochMs + THROW_WAIT_MS);
			return TickResult.running(progress(player));
		}
		stopWalk(player);
		int slot = ServerCastObsidianController.find(player, Items.GOLD_INGOT);
		if (player.getInventory().getSelectedSlot() != slot) {
			if (slot >= 9) {
				var swap = AdvancedInteractionService.swapIntoHotbar(player, slot, player.getInventory().getSelectedSlot());
				if (swap != null) return stop(player, swap.reasonCode(), swap.message());
			} else {
				player.getInventory().setSelectedSlot(slot);
			}
			pause = 1;
			return TickResult.running(progress(player));
		}
		// Thrown toward its feet: a Q drop flies about a block and a half ahead of a slightly lowered look.
		Vec3 feet = target.position().add(0.0D, 0.1D, 0.0D);
		if (!ServerLookController.turnToward(player, feet)) {
			if (++turnTicks > 30) { turnTicks = 0; busyUntil.put(target.getUUID(), nowEpochMs + THROW_WAIT_MS); }
			return TickResult.running(progress(player));
		}
		turnTicks = 0;
		int selected = player.getInventory().getSelectedSlot();
		ItemStack one = player.getInventory().removeItem(selected, 1);
		if (one.isEmpty() || player.drop(one, true, net.minecraft.util.Prediction.PREDICTED) == null) return stop(player, "ITEM_DROP_REJECTED", "The gold ingot could not be thrown");
		ArmSwing.use(player, InteractionHand.MAIN_HAND);
		thrown++;
		lastThrowMs = nowEpochMs;
		busyUntil.put(target.getUUID(), nowEpochMs + THROW_WAIT_MS);
		pause = 6;
		return TickResult.running(progress(player));
	}

	@Override
	public void cancel(ServerPlayer player) {
		release(player);
	}

	private void release(ServerPlayer player) {
		stopWalk(player);
		if (pickup != null) pickup.cancel(player);
		pickup = null;
	}

	private void stopWalk(ServerPlayer player) {
		if (walk != null) walk.cancel(player);
		walk = null;
		walkTarget = null;
		walkGoal = null;
	}

	private TickResult danger(ServerPlayer player) {
		for (AbstractPiglin piglin : player.level().getEntitiesOfClass(AbstractPiglin.class, player.getBoundingBox().inflate(PIGLIN_RANGE))) {
			if (!perceivedAngry(ObservationVisibility.canSeeEntity(player, piglin), piglin.getTarget() == player)) continue;
			return stop(player, "PIGLIN_ANGRY", String.format(Locale.ROOT, "a seen %s %s goes for the body, %.1f blocks away",
					BuiltInRegistries.ENTITY_TYPE.getKey(piglin.getType()), piglin.getUUID(), player.distanceTo(piglin)));
		}
		float health = player.getHealth();
		if (health < lastHealth - 0.01F) {
			String source = player.getLastDamageSource() == null ? "unknown" : player.getLastDamageSource().getMsgId();
			return stop(player, "DAMAGE_TAKEN", String.format(Locale.ROOT, "Took %.1f damage (%s); health %.1f", lastHealth - health, source, health));
		}
		lastHealth = health;
		if (player.isInLava()) return stop(player, "IN_LAVA", "The body is in lava");
		if (player.isOnFire()) return stop(player, "ON_FIRE", "The body is burning");
		if (health <= LOW_HEALTH) return stop(player, "LOW_HEALTH", String.format(Locale.ROOT, "Health %.1f is at or below %.0f", health, LOW_HEALTH));
		if (player.tickCount % 5 == 0) {
			List<Mob> threats = player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(HOSTILE_RANGE),
					mob -> !(mob instanceof AbstractPiglin) && player.distanceTo(mob) <= HOSTILE_RANGE && ThreatPerception.isSensedThreat(player, mob));
			if (!threats.isEmpty()) {
				Mob nearest = threats.stream().min(Comparator.comparingDouble(player::distanceTo)).orElseThrow();
				return stop(player, "HOSTILE_NEAR", String.format(Locale.ROOT, "%s %s %.1f blocks away",
						BuiltInRegistries.ENTITY_TYPE.getKey(nearest.getType()), nearest.getUUID(), player.distanceTo(nearest)));
			}
		}
		return null;
	}

	/**
	 * A piglin's anger as a player perceives it: a piglin the eye sees going for the body (its target is the body, so it
	 * charges or aims at it). Its brain's ANGRY_AT memory is never read, and a piglin out of sight (behind a wall) is not
	 * reported; one that hits the body ends the call as DAMAGE_TAKEN.
	 */
	static boolean perceivedAngry(boolean seen, boolean targetsBody) {
		return seen && targetsBody;
	}

	private List<Piglin> visiblePiglins(ServerPlayer player) {
		return player.level().getEntitiesOfClass(Piglin.class, player.getBoundingBox().inflate(PIGLIN_RANGE),
				p -> p.isAlive() && p.getType() == EntityTypes.PIGLIN && !p.isBaby() && player.distanceTo(p) <= PIGLIN_RANGE
						&& ObservationVisibility.canSeeEntity(player, p));
	}

	private boolean anyAdmiring(ServerPlayer player) {
		return visiblePiglins(player).stream().anyMatch(p -> !p.getOffhandItem().isEmpty());
	}

	/** The nearest seen calm adult piglin with an empty offhand (not examining an item) that has no ingot pending. */
	private Piglin freePiglin(ServerPlayer player, long now) {
		return visiblePiglins(player).stream()
				.filter(p -> p.getOffhandItem().isEmpty() && busyUntil.getOrDefault(p.getUUID(), 0L) <= now)
				.min(Comparator.comparingDouble(player::distanceTo)).orElse(null);
	}

	/** A seen item on the ground within reach of a short walk that appeared after the call started: a barter return. */
	private ItemEntity nearestDrop(ServerPlayer player) {
		return player.level().getEntitiesOfClass(ItemEntity.class, player.getBoundingBox().inflate(DROP_RANGE),
						e -> e.isAlive() && !ignoredDrops.contains(e.getUUID()) && !e.getItem().is(Items.GOLD_INGOT)
								&& e.onGround() && player.distanceTo(e) <= DROP_RANGE && ObservationVisibility.canSeeEntity(player, e)
								&& dev.agaminggod.arenaagents.server.runtime.InventoryRoom.canTake(player, e.getItem()))
				.stream().min(Comparator.comparingDouble(player::distanceTo)).orElse(null);
	}

	private int gained(ServerPlayer player) {
		return Math.max(0, carried(player, wanted) - startWanted);
	}

	private double progress(ServerPlayer player) {
		return Math.min(0.99D, gained(player) / (double) count);
	}

	private TickResult stop(ServerPlayer player, String reason, String why) {
		release(player);
		return TickResult.failed(reason, summary(player, why), progress(player));
	}

	private TickResult done(ServerPlayer player, String reason, String why) {
		release(player);
		return TickResult.succeeded(reason, summary(player, why));
	}

	private String summary(ServerPlayer player, String why) {
		Map<String, Integer> gainedItems = new TreeMap<>();
		Map<Item, Integer> now = new HashMap<>();
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (!stack.isEmpty()) now.merge(stack.getItem(), stack.getCount(), Integer::sum);
		}
		now.forEach((item, n) -> {
			int delta = n - startCounts.getOrDefault(item, 0);
			if (delta > 0) gainedItems.put(BuiltInRegistries.ITEM.getKey(item).toString(), delta);
		});
		int gold = carried(player, Items.GOLD_INGOT);
		return String.format(Locale.ROOT, "%s. %s gained: %d of %d (now held %d); gold ingots thrown %d, held %d (started with %d); all items gained: %s",
				why, wantedId, gained(player), count, carried(player, wanted), thrown, gold, startGold, gainedItems.isEmpty() ? "none" : gainedItems.toString());
	}

	private static int carried(ServerPlayer player, Item item) {
		int n = 0;
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (stack.is(item)) n += stack.getCount();
		}
		return n;
	}
}
