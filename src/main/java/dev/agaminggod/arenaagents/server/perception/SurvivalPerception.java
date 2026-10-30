package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.agent.AgentId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.Container;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.ItemStack;

/**
 * Healing facts for the model: whether the agent is hurt, safe and able to eat right now, and its best food. Two
 * debounced signals raise attention; neither eats or flees by itself, the model decides:
 * <ul>
 * <li>{@link #HEAL_OPPORTUNITY} (ordinary): at or below 70% health or missing 6+ HP, no active threat within 16
 * blocks, and something edible now (hunger below 20, or always-edible food). Players heal long before 4 hearts.</li>
 * <li>{@link #LOW_HEALTH_NO_FOOD} (urgent): at or below half health while threatened with nothing edible, so the
 * model can weigh a retreat before it is too late.</li>
 * </ul>
 * A reported signal stays while its condition holds (plus {@link #HOLD_TICKS} against flicker); once it clears it
 * cannot be raised again for {@link #COOLDOWN_TICKS}, so regeneration around the threshold never nags.
 */
public final class SurvivalPerception {
	public static final String HEAL_OPPORTUNITY = "heal_opportunity";
	public static final String LOW_HEALTH_NO_FOOD = "low_health_no_food";
	/** Every signal this class can emit; the coordinator's protocol schema must accept exactly these. */
	public static final List<String> SIGNALS = List.of(HEAL_OPPORTUNITY, LOW_HEALTH_NO_FOOD);
	public static final double HURT_FRACTION = 0.7D;
	public static final double HURT_MISSING = 6.0D;
	public static final double LOW_FRACTION = 0.5D;
	public static final double SAFE_RANGE = 16.0D;
	public static final long HOLD_TICKS = 40L;
	public static final long COOLDOWN_TICKS = 600L;
	public static final int MAX_FOOD_LEVEL = 20;
	/** Edible but harmful (hunger, poison, nausea or a random teleport); never reported as the best food. */
	private static final Set<String> HARMFUL_FOODS = Set.of("minecraft:rotten_flesh", "minecraft:spider_eye",
			"minecraft:poisonous_potato", "minecraft:pufferfish", "minecraft:suspicious_stew", "minecraft:chorus_fruit");

	public record Food(int slot, String itemId, int nutrition, float saturation, boolean alwaysEdible) {
	}

	/** {@code healFood} is the best safe food edible right now; it can differ from {@code bestFood} at full hunger. */
	public record Snapshot(boolean hurt, boolean safe, boolean canHealNow, Food bestFood, Set<String> signals, boolean canEat,
			Food healFood) {
		static final Snapshot HEALTHY = new Snapshot(false, true, false, null, Set.of(), false, null);
	}

	private record Tracked(long tick, int entityId, String dimension, Snapshot snapshot) {
	}

	private final PerceivedHarm harm;

	public SurvivalPerception() { this(new PerceivedHarm()); }
	SurvivalPerception(PerceivedHarm harm) { this.harm = harm; }

	private final Map<AgentId, Latch> latches = new HashMap<>();
	private final Map<AgentId, Tracked> latest = new HashMap<>();

	public synchronized Snapshot sample(AgentId agentId, ServerPlayer agent, ThreatPerception.Snapshot threats) {
		Objects.requireNonNull(agentId, "agentId must not be null");
		long tick = agent.level().getGameTime();
		String dimension = agent.level().dimension().identifier().toString();
		Tracked tracked = latest.get(agentId);
		if (!agent.isAlive()) { reset(agentId); return Snapshot.HEALTHY; }
		PerceivedHarm.Snapshot perceived = harm.sample(agentId, agent);
		boolean harmed = perceived != null;
		if (tracked != null && (tracked.entityId() != agent.getId() || !tracked.dimension().equals(dimension) || tick < tracked.tick())) {
			latches.remove(agentId);
			tracked = null;
		}
		boolean threatened = harmed || !threats.entries().isEmpty();
		boolean safe = safe(perceived, threats);
		if (tracked != null && tracked.tick() == tick && tracked.snapshot().safe() == safe) return tracked.snapshot();
		int foodLevel = agent.getFoodData().getFoodLevel();
		CarriedFood carried = carriedFood(agent.getInventory(), foodLevel);
		Snapshot snapshot = evaluate(agent.getHealth(), agent.getMaxHealth(), foodLevel,
				carried.bestFood(), threatened, safe,
				latches.computeIfAbsent(agentId, ignored -> new Latch()), tick, carried.canEat(), carried.healFood());
		latest.put(agentId, new Tracked(tick, agent.getId(), dimension, snapshot));
		return snapshot;
	}

	public synchronized void retain(Set<AgentId> agents) {
		latches.keySet().retainAll(agents);
		latest.keySet().retainAll(agents);
		harm.retain(agents);
	}

	synchronized void reset(AgentId id) { latches.remove(id); latest.remove(id); harm.reset(id); }

	static boolean safe(PerceivedHarm.Snapshot harm, ThreatPerception.Snapshot threats) {
		// Eating remedies starvation; its harm fact still counts as threatened for the no-food signal.
		return (harm == null || "minecraft:starve".equals(harm.source())) && threats.entries().stream().noneMatch(entry -> entry.distance() <= SAFE_RANGE || entry.targeting());
	}

	static boolean hurt(double health, double maxHealth) {
		return health <= maxHealth * HURT_FRACTION || maxHealth - health >= HURT_MISSING;
	}

	static boolean canEat(Food food, int foodLevel) {
		return food != null && (foodLevel < MAX_FOOD_LEVEL || food.alwaysEdible());
	}

	/**
	 * Raw (undebounced) signals. Pure so the thresholds verify without a server. {@code food} is the best food carried
	 * regardless of hunger, so low_health_no_food means truly none carried; a heal opportunity needs {@code healFood},
	 * the best safe food edible now (an always-edible golden apple still heals at full hunger when steak cannot).
	 */
	static List<String> rawSignalsAtHunger(double health, double maxHealth, int foodLevel, Food food, boolean threatened, boolean safe) {
		return rawSignals(health, maxHealth, food, canEat(food, foodLevel) ? food : null, threatened, safe);
	}

	static List<String> rawSignals(double health, double maxHealth, Food food, Food healFood, boolean threatened, boolean safe) {
		List<String> signals = new ArrayList<>(2);
		if (health < maxHealth && hurt(health, maxHealth) && safe && healFood != null) signals.add(HEAL_OPPORTUNITY);
		if (health <= maxHealth * LOW_FRACTION && threatened && food == null) signals.add(LOW_HEALTH_NO_FOOD);
		return signals;
	}

	static Snapshot evaluate(double health, double maxHealth, int foodLevel, Food food, boolean threatened, boolean safe,
			Latch latch, long tick) {
		return evaluate(health, maxHealth, foodLevel, food, threatened, safe, latch, tick, canEat(food, foodLevel));
	}

	static Snapshot evaluate(double health, double maxHealth, int foodLevel, Food food, boolean threatened, boolean safe,
			Latch latch, long tick, boolean canEat) {
		return evaluate(health, maxHealth, foodLevel, food, threatened, safe, latch, tick, canEat,
				canEat(food, foodLevel) ? food : null);
	}

	static Snapshot evaluate(double health, double maxHealth, int foodLevel, Food food, boolean threatened, boolean safe,
			Latch latch, long tick, boolean canEat, Food healFood) {
		Set<String> signals = latch.update(rawSignals(health, maxHealth, food, healFood, threatened, safe), tick);
		boolean injured = health < maxHealth;
		if (!safe && signals.contains(HEAL_OPPORTUNITY)) {
			Set<String> filtered = new TreeSet<>(signals);
			filtered.remove(HEAL_OPPORTUNITY);
			signals = Set.copyOf(filtered);
		}
		if (!injured && safe && signals.isEmpty()) return Snapshot.HEALTHY;
		return new Snapshot(injured, safe, injured && safe && healFood != null, food, signals, canEat, healFood);
	}

	/** Hold and cooldown per signal; see the class comment. */
	static final class Latch {
		private final Map<String, Long> lastTrue = new HashMap<>();
		private final Map<String, Long> clearedAt = new HashMap<>();
		private final Set<String> reported = new TreeSet<>();

		Set<String> update(List<String> raw, long tick) {
			for (String signal : raw) {
				Long cleared = clearedAt.get(signal);
				boolean coolingDown = !reported.contains(signal) && cleared != null && cleared <= tick && tick - cleared < COOLDOWN_TICKS;
				if (coolingDown) continue;
				reported.add(signal);
				lastTrue.put(signal, tick);
			}
			for (String signal : List.copyOf(reported)) {
				long last = lastTrue.getOrDefault(signal, tick);
				if (!raw.contains(signal) && (tick - last > HOLD_TICKS || last > tick)) {
					reported.remove(signal);
					lastTrue.remove(signal);
					clearedAt.put(signal, tick);
				}
			}
			return Set.copyOf(reported);
		}
	}

	/**
	 * Best-food ranking stays independent of hunger; eatability counts every food, including risky alternatives.
	 * {@code healFood} ranks only safe food edible at this hunger level.
	 */
	record CarriedFood(Food bestFood, boolean canEat, Food healFood) {
	}

	static CarriedFood carriedFood(Container inventory, int foodLevel) {
		Food best = null;
		Food heal = null;
		boolean edible = false;
		for (int slot = 0; slot < inventory.getContainerSize(); slot++) {
			ItemStack stack = inventory.getItem(slot);
			if (stack.isEmpty()) continue;
			FoodProperties properties = stack.get(DataComponents.FOOD);
			if (properties == null) continue;
			edible |= foodLevel < MAX_FOOD_LEVEL || properties.canAlwaysEat();
			String itemId = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
			if (HARMFUL_FOODS.contains(itemId)) continue;
			Food food = new Food(slot, itemId, properties.nutrition(), properties.saturation(), properties.canAlwaysEat());
			if (best == null || food.nutrition() + food.saturation() > best.nutrition() + best.saturation()) best = food;
			if (canEat(food, foodLevel)
					&& (heal == null || food.nutrition() + food.saturation() > heal.nutrition() + heal.saturation())) heal = food;
		}
		return new CarriedFood(best, edible, heal);
	}

	/** Observation section, or null when the agent is at full health and no signal is reported. */
	public static JsonObject toJson(Snapshot snapshot) {
		if (!snapshot.hurt() && snapshot.safe() && snapshot.signals().isEmpty()) return null;
		JsonObject json = new JsonObject();
		json.addProperty("safe", snapshot.safe());
		json.addProperty("canHealNow", snapshot.canHealNow());
		json.addProperty("canEat", snapshot.canEat());
		if (snapshot.bestFood() != null) {
			JsonObject food = new JsonObject();
			food.addProperty("slot", snapshot.bestFood().slot());
			food.addProperty("itemId", snapshot.bestFood().itemId());
			food.addProperty("nutrition", snapshot.bestFood().nutrition());
			food.addProperty("alwaysEdible", snapshot.bestFood().alwaysEdible());
			json.add("bestFood", food);
		}
		if (snapshot.healFood() != null && !snapshot.healFood().equals(snapshot.bestFood())) {
			JsonObject food = new JsonObject();
			food.addProperty("slot", snapshot.healFood().slot());
			food.addProperty("itemId", snapshot.healFood().itemId());
			food.addProperty("nutrition", snapshot.healFood().nutrition());
			food.addProperty("alwaysEdible", snapshot.healFood().alwaysEdible());
			json.add("healFood", food);
		}
		JsonArray signals = new JsonArray();
		snapshot.signals().stream().sorted().forEach(signals::add);
		json.add("signals", signals);
		return json;
	}
}
