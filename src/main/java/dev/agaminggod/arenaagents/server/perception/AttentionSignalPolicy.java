package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;

/** Selects factual changes important enough to request model attention. */
public final class AttentionSignalPolicy {
	private static final int CRITICAL_AIR = 60;
	/**
	 * Half of the vanilla 300 air: 7.5 s before drowning damage. The model needs several seconds to decide, so the
	 * 3 s critical edge alone came too late in the play-test. Each edge fires once per dive (air refills on surfacing).
	 */
	static final int WARNING_AIR = 150;
	private static final int CRITICAL_FOOD = 6;
	private static final double HAZARDOUS_FALL_DISTANCE = 4.0D;

	private AttentionSignalPolicy() {
	}

	static boolean safeAir(int air) {
		return air > CRITICAL_AIR;
	}

	/** 0 above the warning, 1 at or below the warning, 2 at or below critical air. */
	static int airBand(int air) {
		return air <= CRITICAL_AIR ? 2 : air <= WARNING_AIR ? 1 : 0;
	}

	/** Food falling to the warning level; the same edge {@link #changedFacts} reports as "player.foodLevel". */
	static boolean foodBecameCritical(int before, int after) {
		return before > CRITICAL_FOOD && after <= CRITICAL_FOOD;
	}

	/** A fall reaching the damaging distance; the same edge {@link #changedFacts} reports as "player.fallDistance". */
	static boolean fallBecameHazardous(double before, double after) {
		return before < HAZARDOUS_FALL_DISTANCE && after >= HAZARDOUS_FALL_DISTANCE;
	}

	private static double fallDamage(JsonObject player) {
		Double damage = number(player, "fallDamage");
		Double distance = number(player, "fallDistance");
		return damage != null ? damage : distance == null ? 0 : FallDanger.damage(distance, 3, 1);
	}

	public static List<String> changedFacts(JsonObject previous, JsonObject current) {
		return changedFacts(previous, current, null, null);
	}

	/**
	 * As {@link #changedFacts(JsonObject, JsonObject)}, with threat edges taken from the full latched signal sets
	 * ("uuid.signal", see {@link #threatFacts}) when both are known. The serialized rows are capped at eight, so a row
	 * re-entering after another threat's urgency expired is not a new signal; only a key new to the full set is.
	 */
	public static List<String> changedFacts(JsonObject previous, JsonObject current, Set<String> threatsBefore, Set<String> threatsAfter) {
		Objects.requireNonNull(current, "current must not be null");
		if (previous == null) return List.of();
		TreeSet<String> facts = new TreeSet<>();
		JsonArray incoming = array(current, "incomingProjectiles");
		if (incoming != null) for (JsonElement value : incoming) {
			if (value.isJsonObject() && (booleanValue(value.getAsJsonObject(), "new") || booleanValue(value.getAsJsonObject(), "imminentNew"))) facts.add("projectile");
		}
		addChanged(facts, "ready", previous.get("ready"), current.get("ready"));
		if (statusRequiresAttention(previous.get("status"), current.get("status"))) facts.add("status");

		JsonObject beforePlayer = object(previous, "player");
		JsonObject afterPlayer = object(current, "player");
		boolean activeActionWindow = activeAction(previous) || activeAction(current);
		Set<String> clouds = cloudKeys(afterPlayer);
		if (!clouds.isEmpty() && !cloudKeys(beforePlayer).containsAll(clouds)) facts.add("player.clouds");
		if (decreased(beforePlayer, afterPlayer, "health")) facts.add("player.health");
		if (started(beforePlayer, afterPlayer, "onFire")) facts.add("player.onFire");
		if (started(beforePlayer, afterPlayer, "suffocating")) facts.add("player.suffocating");
		if (crossedAtOrBelow(beforePlayer, afterPlayer, "air", CRITICAL_AIR)
				|| crossedAtOrBelow(beforePlayer, afterPlayer, "air", WARNING_AIR)
				|| WaterAirFacts.urgent(afterPlayer) && !WaterAirFacts.urgent(beforePlayer)) facts.add("player.air");
		if (crossedAtOrBelow(beforePlayer, afterPlayer, "foodLevel", CRITICAL_FOOD)) facts.add("player.foodLevel");
		if (fallDamage(beforePlayer) <= 0 && fallDamage(afterPlayer) > 0) {
			facts.add("player.fallDistance");
		}
		// Moving toward a known hurtful edge, before any fall. A path the navigator planned already keeps to safe footing.
		if (approachingDrop(beforePlayer, afterPlayer) && !navigating(current)) facts.add("player.dropAhead");
		if (activeActionWindow && attackerAppearedOrChanged(beforePlayer, afterPlayer)) {
			facts.add("player.lastAttacker");
		}

		// Threat edges matter during actions too: they exist so the model can react before damage.
		// Each side falls back to its serialized rows on its own. A fact names only a threat with a row in this observation,
		// so the model can see its cause; an edge on an unreported threat stays owed (the scan promotes it into the rows).
		Set<String> rowIds = threatIds(current);
		Set<String> newThreats = new TreeSet<>();
		addNewThreatSignals(newThreats, threatsBefore != null ? threatsBefore : threatSignals(previous),
				threatsAfter != null ? threatsAfter : threatSignals(current));
		for (String fact : newThreats) {
			String key = fact.substring("threats.".length());
			if (rowIds.contains(key.substring(0, key.lastIndexOf('.')))) facts.add(fact);
		}
		// Healing signals (a safe chance to eat, or low health with no food under threat) are debounced server-side.
		addNewSurvivalSignals(facts, survivalSignals(previous), survivalSignals(current));
		if (!activeActionWindow && !inventory(previous).equals(inventory(current))) facts.add("inventory");
		if (newFailure(previous, current)) facts.add("lastResult");
		// An action ending with the eyes under water and air at or below the warning hands back a body whose swim input
		// was released while air drains: as urgent as the air edge itself, once per result.
		if (newResult(previous, current) && submergedLowAir(current)) facts.add("player.air");
		if (!Objects.equals(dimension(previous), dimension(current))) facts.add("world.dimension");
		JsonObject beforePerception = object(previous, "perception");
		JsonObject afterPerception = object(current, "perception");
		if (afterPerception != null) addChanged(facts, "perception", beforePerception == null ? null : beforePerception.get("latestSequence"), afterPerception.get("latestSequence"));
		Set<String> previousFurnaces = FurnaceMemory.readyFacts(previous);
		for (String fact : FurnaceMemory.readyFacts(current)) if (!previousFurnaces.contains(fact)) facts.add("furnaces");
		addLavaChanges(facts, previous, current);
		// Lava first heard (it stays remembered 30 s, so a pool's intermittent pops raise this once, not per pop).
		if (heardLava(current) && !heardLava(previous)) facts.add("heard");
		// A structure first seen (or seen again after a minute) is worth a look even mid-action; the model decides.
		if (newStructureSighted(current)) facts.add("sighted");

		boolean viewpointChanged = !Objects.equals(previous.get("position"), current.get("position"))
				|| !Objects.equals(previous.get("view"), current.get("view"));
		if (!activeActionWindow && !viewpointChanged) {
			addEntityMembershipChanges(facts, entityIds(previous), entityIds(current));
			addChanged(facts, "landmarks", previous.get("landmarks"), current.get("landmarks"));
		}
		if (facts.size() <= AttentionFactDelta.MAX_CHANGED_FACTS) return List.copyOf(facts);
		// Over the cap, danger edges go first; publication commits only the threat edges it actually delivered.
		List<String> urgent = facts.stream().filter(fact -> fact.startsWith("threats.") || fact.startsWith("survival.") || fact.equals("player.clouds")).toList();
		List<String> rest = facts.stream().filter(fact -> !fact.startsWith("threats.") && !fact.startsWith("survival.") && !fact.equals("player.clouds")).toList();
		return java.util.stream.Stream.concat(urgent.stream(), rest.stream()).limit(AttentionFactDelta.MAX_CHANGED_FACTS).sorted().toList();
	}

	private static Set<String> cloudKeys(JsonObject player) {
		TreeSet<String> keys = new TreeSet<>();
		JsonArray clouds = array(player, "clouds");
		if (clouds != null) for (JsonElement value : clouds) {
			JsonObject cloud = value.getAsJsonObject();
			keys.add(CloudDanger.key(primitiveString(cloud.get("uuid")), false));
			if (booleanValue(cloud, "contact")) keys.add(CloudDanger.key(primitiveString(cloud.get("uuid")), true));
		}
		return keys;
	}

	/** Threat ids with a serialized row. */
	private static Set<String> threatIds(JsonObject observation) {
		TreeSet<String> ids = new TreeSet<>();
		JsonArray entries = array(object(observation, "threats"), "entries");
		if (entries != null) for (JsonElement value : entries) {
			String uuid = value.isJsonObject() ? primitiveString(value.getAsJsonObject().get("uuid")) : null;
			if (uuid != null) ids.add(uuid);
		}
		return ids;
	}

	/** One fact per newly reported "uuid.signal"; the server latch already debounces flickering signals. */
	static void addNewThreatSignals(Set<String> facts, Set<String> before, Set<String> after) {
		for (String signal : after) if (!before.contains(signal)) facts.add("threats." + signal);
	}

	static void addNewSurvivalSignals(Set<String> facts, Set<String> before, Set<String> after) {
		for (String signal : after) if (!before.contains(signal)) facts.add("survival." + signal);
	}

	/** A newly sighted structure, possibly player-built cluster or point of interest; new biomes and lava ride along quietly. */
	static boolean newStructureSighted(JsonObject observation) {
		for (String section : List.of("structures", "built", "poi")) {
			JsonArray rows = array(object(observation, "sighted"), section);
			if (rows == null) continue;
			for (JsonElement value : rows) {
				if (value.isJsonObject() && value.getAsJsonObject().has("new")) return true;
			}
		}
		return false;
	}

	/** Full latched threat keys ("uuid:signal", {@link ThreatSignalLatch#key}) in the "uuid.signal" form of serialized rows. */
	public static Set<String> threatFacts(Set<String> latchedKeys) {
		TreeSet<String> signals = new TreeSet<>();
		for (String key : latchedKeys) signals.add(ThreatSignalLatch.threatId(key) + "." + ThreatSignalLatch.signal(key));
		return signals;
	}

	static Set<String> survivalSignals(JsonObject observation) {
		TreeSet<String> signals = new TreeSet<>();
		JsonArray names = array(object(observation, "survival"), "signals");
		if (names == null) return signals;
		for (JsonElement name : names) {
			String signal = primitiveString(name);
			if (signal != null) signals.add(signal);
		}
		return signals;
	}

	public static Set<String> threatSignals(JsonObject observation) {
		TreeSet<String> signals = new TreeSet<>();
		JsonArray entries = array(object(observation, "threats"), "entries");
		if (entries == null) return signals;
		for (JsonElement value : entries) {
			if (!value.isJsonObject()) continue;
			String uuid = primitiveString(value.getAsJsonObject().get("uuid"));
			JsonArray names = array(value.getAsJsonObject(), "signals");
			if (uuid == null || names == null) continue;
			for (JsonElement name : names) {
				String signal = primitiveString(name);
				if (signal != null) signals.add(uuid + "." + signal);
			}
		}
		return signals;
	}

	private static void addChanged(Set<String> facts, String path, JsonElement before, JsonElement after) {
		if (!Objects.equals(before, after)) facts.add(path);
	}

	private static boolean statusRequiresAttention(JsonElement before, JsonElement after) {
		if (Objects.equals(before, after)) return false;
		String status = primitiveString(after);
		return status != null && Set.of("PLAYER_DEAD", "DEAD", "ERROR", "DISCONNECTED").contains(status);
	}

	private static boolean decreased(JsonObject before, JsonObject after, String field) {
		Double left = number(before, field);
		Double right = number(after, field);
		return left != null && right != null && right < left;
	}

	private static boolean crossedAtOrBelow(JsonObject before, JsonObject after, String field, double threshold) {
		Double left = number(before, field);
		Double right = number(after, field);
		return left != null && right != null && left > threshold && right <= threshold;
	}

	private static boolean crossedAtOrAbove(JsonObject before, JsonObject after, String field, double threshold) {
		Double left = number(before, field);
		Double right = number(after, field);
		return left != null && right != null && left < threshold && right >= threshold;
	}

	/**
	 * A hurtful edge appears; it stays one fact while the body keeps approaching it, as a player notices a cliff once.
	 * A known water landing stays a geometric fact without this edge.
	 */
	static boolean approachingDrop(JsonObject before, JsonObject after) {
		return DropAhead.hurtful(object(after, "dropAhead")) && !DropAhead.hurtful(object(before, "dropAhead"));
	}

	private static boolean navigating(JsonObject observation) {
		JsonObject action = object(observation, "currentAction");
		String type = action == null ? null : primitiveString(action.get("actionType"));
		return "move_to".equals(type) || "navigate_to".equals(type) || "travel_to".equals(type);
	}

	private static boolean activeAction(JsonObject observation) {
		return booleanValue(object(observation, "currentAction"), "active");
	}

	private static boolean attackerAppearedOrChanged(JsonObject before, JsonObject after) {
		JsonObject previous = object(before, "lastAttacker");
		JsonObject current = object(after, "lastAttacker");
		if (current == null) return false;
		return previous == null
				|| !Objects.equals(previous.get("uuid"), current.get("uuid"))
				|| !Objects.equals(previous.get("type"), current.get("type"));
	}

	private static void addLavaChanges(Set<String> facts, JsonObject previous, JsonObject current) {
		java.util.Map<String, String> before = lavaByPosition(array(previous, "blocks"));
		java.util.Map<String, String> after = lavaByPosition(array(current, "blocks"));
		TreeSet<String> positions = new TreeSet<>(before.keySet());
		positions.addAll(after.keySet());
		for (String position : positions) {
			if (!Objects.equals(before.get(position), after.get(position))) facts.add("blocks." + position);
		}
	}

	static boolean heardLava(JsonObject observation) {
		JsonArray heard = array(observation, "heard");
		if (heard == null) return false;
		for (JsonElement value : heard) {
			String sound = value.isJsonObject() ? primitiveString(value.getAsJsonObject().get("sound")) : null;
			if (sound != null && HearingPerception.isLava(sound)) return true;
		}
		return false;
	}

	private static java.util.Map<String, String> lavaByPosition(JsonArray blocks) {
		java.util.Map<String, String> lava = new java.util.HashMap<>();
		if (blocks == null) return lava;
		for (JsonElement value : blocks) {
			if (!value.isJsonObject()) continue;
			JsonObject block = value.getAsJsonObject();
			String blockId = primitiveString(block.get("blockId"));
			if (!"minecraft:lava".equals(blockId)
					|| !block.has("x") || !block.has("y") || !block.has("z")) continue;
			lava.put(block.get("x").getAsInt() + "," + block.get("y").getAsInt() + "," + block.get("z").getAsInt(), blockId);
		}
		return lava;
	}

	private static boolean started(JsonObject before, JsonObject after, String field) {
		return !booleanValue(before, field) && booleanValue(after, field);
	}

	private static Double number(JsonObject object, String field) {
		if (object == null || !object.has(field) || !object.get(field).isJsonPrimitive()
				|| !object.get(field).getAsJsonPrimitive().isNumber()) return null;
		double value = object.get(field).getAsDouble();
		return Double.isFinite(value) ? value : null;
	}

	private static boolean booleanValue(JsonObject object, String field) {
		return object != null && object.has(field) && object.get(field).isJsonPrimitive()
				&& object.get(field).getAsJsonPrimitive().isBoolean() && object.get(field).getAsBoolean();
	}

	private static InventorySignature inventory(JsonObject observation) {
		JsonObject inventory = object(observation, "inventory");
		String selected = primitiveString(inventory == null ? null : inventory.get("selectedItem"));
		ArrayList<InventoryItem> items = new ArrayList<>();
		JsonArray values = array(inventory, "items");
		if (values != null) {
			for (JsonElement value : values) {
				if (!value.isJsonObject()) continue;
				JsonObject item = value.getAsJsonObject();
				String itemId = primitiveString(item.get("itemId"));
				Double count = number(item, "count");
				if (itemId == null || count == null) continue;
				items.add(new InventoryItem(primitiveString(item.get("slot")), itemId, count.intValue()));
			}
		}
		items.sort(null);
		return new InventorySignature(selected, List.copyOf(items));
	}

	private static boolean newFailure(JsonObject previous, JsonObject current) {
		ResultSignature before = result(previous);
		ResultSignature after = result(current);
		return after != null && ("FAILED".equals(after.state()) || "TIMED_OUT".equals(after.state()))
				&& !after.equals(before);
	}

	static boolean newResult(JsonObject previous, JsonObject current) {
		ResultSignature after = result(current);
		return after != null && !after.equals(result(previous));
	}

	static boolean submergedLowAir(JsonObject observation) {
		JsonObject player = object(observation, "player");
		Double air = number(player, "air");
		return booleanValue(player, "underWater") && air != null && (airBand((int) Math.round(air)) > 0 || WaterAirFacts.urgent(player));
	}

	private static ResultSignature result(JsonObject observation) {

		JsonObject result = object(observation, "lastResult");
		if (result == null || !booleanValue(result, "present")) return null;
		return new ResultSignature(
				primitiveString(result.get("actionId")),
				primitiveString(result.get("state")),
				primitiveString(result.get("reasonCode"))
		);
	}

	private static String dimension(JsonObject observation) {
		JsonObject world = object(observation, "world");
		return primitiveString(world == null ? null : world.get("dimension"));
	}

	private static TreeSet<String> entityIds(JsonObject observation) {
		TreeSet<String> ids = new TreeSet<>();
		JsonArray entities = array(observation, "entities");
		if (entities == null) return ids;
		for (JsonElement value : entities) {
			if (!value.isJsonObject()) continue;
			String id = primitiveString(value.getAsJsonObject().get("uuid"));
			if (id != null) ids.add(id);
		}
		return ids;
	}

	private static void addEntityMembershipChanges(TreeSet<String> facts, Set<String> before, Set<String> after) {
		TreeSet<String> changed = new TreeSet<>(before);
		changed.addAll(after);
		TreeSet<String> retained = new TreeSet<>(before);
		retained.retainAll(after);
		changed.removeAll(retained);
		if (facts.size() + changed.size() <= AttentionFactDelta.MAX_CHANGED_FACTS) {
			changed.forEach(id -> facts.add("entities." + id));
		} else if (!changed.isEmpty()) {
			facts.add("entities");
		}
	}

	private static JsonObject object(JsonObject parent, String field) {
		return parent != null && parent.has(field) && parent.get(field).isJsonObject()
				? parent.getAsJsonObject(field) : null;
	}

	private static JsonArray array(JsonObject parent, String field) {
		return parent != null && parent.has(field) && parent.get(field).isJsonArray()
				? parent.getAsJsonArray(field) : null;
	}

	private static String primitiveString(JsonElement value) {
		return value != null && value.isJsonPrimitive() ? value.getAsString() : null;
	}

	private record InventorySignature(String selectedItem, List<InventoryItem> items) {
	}

	private record InventoryItem(String slot, String itemId, int count) implements Comparable<InventoryItem> {
		@Override
		public int compareTo(InventoryItem other) {
			int slotComparison = Objects.toString(slot, "").compareTo(Objects.toString(other.slot, ""));
			if (slotComparison != 0) return slotComparison;
			int itemComparison = itemId.compareTo(other.itemId);
			return itemComparison != 0 ? itemComparison : Integer.compare(count, other.count);
		}
	}

	private record ResultSignature(String actionId, String state, String reasonCode) {
	}
}
