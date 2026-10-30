package dev.agaminggod.arenaagents.server;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Presentation state only. It never chooses an action or supplies an agent's intent. */
final class AgentFeedPolicy {
	static final long STATUS_LINGER_MS = 5_000L;
	static final long STATUS_STALE_MS = 30_000L;
	static final long OVERLAY_REFRESH_MS = 2_500L;
	static final long EXTERNAL_OVERLAY_MS = 3_000L;
	static final Set<String> IMPORTANT_ITEMS = Set.of("minecraft:raw_iron", "minecraft:iron_ingot",
			"minecraft:diamond", "minecraft:obsidian", "minecraft:blaze_rod", "minecraft:ender_pearl",
			"minecraft:ender_eye", "minecraft:netherite_scrap", "minecraft:netherite_ingot", "minecraft:elytra");
	private final Map<String, Agent> agents = new HashMap<>();
	boolean sendingOverlay;
	private final Map<String, Viewer> viewers = new HashMap<>();
	private final FailureChatThrottle problems = new FailureChatThrottle();

	/** Translate known facts; unfamiliar failures use their short reason, never raw executor evidence. */
	static java.util.Optional<String> problem(String reasonCode, String message) {
		return problem("complete this action", reasonCode, message);
	}

	static java.util.Optional<String> problem(String action, String reasonCode, String message) {
		String reason = normalize(reasonCode);
		String detail = message == null ? "" : message;
		if (reason.equals("AGENT_DEAD")) return java.util.Optional.empty();
		String problem = switch (reason) {
			case "INVENTORY_FULL" -> "Inventory is full; can't pick up more items.";
			case "DESTINATION_FULL" -> "No room for the items.";
			case "CRAFT_REMAINDER_UNSAFE" -> "Can't craft that recipe with this inventory layout.";
			case "RECIPE_INPUTS_UNAVAILABLE" -> "Missing ingredients for that recipe.";
			case "RECIPE_LOCKED" -> "That recipe hasn't been unlocked yet.";
			case "IN_LAVA" -> "In lava.";
			case "ON_FIRE" -> "On fire.";
			case "PATH_BLOCKED", "APPROACH_BLOCKED", "FLEE_BLOCKED" -> "The path is blocked.";
			case "NO_PATH", "NO_STANDABLE_PATH", "NO_SEEN_ROUTE", "PATH_LIMIT_REACHED", "TARGET_UNREACHABLE" -> "Can't find a path to the target.";
			case "ACTION_TIMEOUT", "ACTION_TIMED_OUT", "NAVIGATION_TIMED_OUT", "ITEM_PICKUP_TIMED_OUT",
					"BUILD_SEQUENCE_TIMEOUT", "RANGED_USE_TIMED_OUT", "FIGHT_TIMED_OUT", "FLEE_TIMED_OUT" -> "Couldn't " + action + ": it took too long.";
			case "TARGET_NOT_FOUND", "TARGET_UNAVAILABLE", "TARGET_LOST", "TARGET_ESCAPED" -> "Can't find the target anymore.";
			case "TARGET_TOO_FAR" -> "The target is too far away.";
			case "TARGET_NOT_LOADED" -> "The target's area isn't loaded.";
			case "TARGET_AIR" -> "That block is no longer there.";
			case "TARGET_OCCUPIED", "PLACEMENT_CONFLICT" -> "That space is occupied.";
			case "PLACEMENT_NOT_CONFIRMED", "PLACEMENT_STATE_MISMATCH" -> "The block didn't stay where it was placed.";
			case "NO_PLACEMENT_SUPPORT" -> "The block needs something to attach to.";
			case "ITEM_UNAVAILABLE", "SELECTION_NOT_CONFIRMED" -> "Can't use the selected item.";
			case "SHIELD_USE_NOT_STARTED", "SHIELD_USE_INTERRUPTED" -> "Couldn't raise the shield.";
			case "SHIELD_RELEASE_NOT_OBSERVED" -> "Couldn't lower the shield.";
			case "RANGED_USE_NOT_STARTED" -> "Couldn't ready the ranged weapon.";
			case "RANGED_RELEASE_NOT_OBSERVED" -> "Couldn't fire the ranged weapon.";
			case "RANGED_TARGET_DENIED" -> "Can't fire at that target.";
			default -> null;
		};

		// Obstructions are observed facts, not a runtime guess about the next plan.
		var obstruction = java.util.regex.Pattern.compile("(?:Seen obstruction: |; )(minecraft:[a-z0-9_]+)(?: at [^;]+)? is in the way|Seen obstruction: (minecraft:[a-z0-9_]+)").matcher(detail);
		if (obstruction.find()) {
			String block = obstruction.group(1) == null ? obstruction.group(2) : obstruction.group(1);
			return java.util.Optional.of("Can't reach the target: blocked by " + block.substring(block.indexOf(':') + 1).replace('_', ' ') + ".");
		}
		if (detail.startsWith("No part of it is visible within reach")) return java.util.Optional.of("Can't reach the target from here.");
		if (problem != null) return java.util.Optional.of(problem);
		if (!shouldAnnounceFailure(reason)) return java.util.Optional.empty();
		return java.util.Optional.of("Couldn't " + action + ": " + plainReason(reason) + ".");
	}

	static boolean shouldAnnounceFailure(String reasonCode) {
		if (reasonCode == null || reasonCode.isBlank()) return true;
		return switch (reasonCode.toUpperCase(java.util.Locale.ROOT)) {
			case "ACTION_CANCELLED", "PATH_BLOCKED", "NO_PATH", "NO_STANDABLE_PATH", "PATH_LIMIT_REACHED",
					"ACTION_TIMEOUT", "ACTION_TIMED_OUT", "NAVIGATION_TIMED_OUT",
					"TARGET_NOT_FOUND", "TARGET_UNAVAILABLE", "TARGET_TOO_FAR", "TARGET_AIR", "RANGED_TARGET_DENIED",
					"PLACEMENT_NOT_CONFIRMED", "PLACEMENT_STATE_MISMATCH", "PLACEMENT_CONFLICT",
					"NO_PLACEMENT_SUPPORT", "SELECTION_NOT_CONFIRMED", "ITEM_UNAVAILABLE",
					"TARGET_NOT_LOADED", "TARGET_LOST", "ITEM_PICKUP_TIMED_OUT", "INVENTORY_FULL", "RANGED_USE_TIMED_OUT",
					"RANGED_USE_NOT_STARTED", "RANGED_RELEASE_NOT_OBSERVED", "BUILD_SEQUENCE_TIMEOUT",
					"TARGET_OCCUPIED", "SHIELD_RELEASE_NOT_OBSERVED", "SHIELD_USE_NOT_STARTED",
					"SHIELD_USE_INTERRUPTED", "RETRY_SCHEDULED", "PROVIDER_RETRY", "PLANNING_RETRY",
					"MISSING_AGENT_MESSAGE", "MISSING_FINAL_MESSAGE",
					// Fight/flee outcomes the model chose or must simply re-decide; not operator errors.
					"LOW_HEALTH_BAILOUT", "TARGET_ESCAPED", "TARGET_UNREACHABLE", "FIGHT_TIMED_OUT", "FLEE_TIMED_OUT", "FLEE_BLOCKED",
					"NO_SEEN_ROUTE", "NO_PROGRESS", "APPROACH_BLOCKED", "FLEE_STALLED" -> false;
			default -> true;
		};
	}

	static String normalize(String reason) { return reason == null ? "" : reason.toUpperCase(java.util.Locale.ROOT); }

	static String plainReason(String reason) {
		return reason.matches("[A-Z][A-Z0-9_]{0,63}") ? reason.toLowerCase(java.util.Locale.ROOT).replace('_', ' ') : "the action failed";
	}

	static boolean severe(String reason) {
		String code = normalize(reason);
		return code.contains("PROVIDER") && !code.equals("PROVIDER_RETRY") || code.contains("CRITICAL")
				|| Set.of("AUTHENTICATION_REQUIRED", "PROCESS_EXITED", "SPAWN_FAILED", "TURN_FAILED", "NATIVE_TURN_FAILED", "REQUEST_TIMEOUT").contains(code)
				|| code.equals("AGENT_DEAD") || code.contains("DISCONNECT") || code.equals("COORDINATOR_UNAVAILABLE")
				|| code.equals("IN_LAVA") || code.equals("ON_FIRE");
	}

	boolean decision(String id, long revision, String text) {
		Agent agent = agent(id);
		String key = text.strip().replaceAll("\\s+", " ");
		if (agent.revision == revision && key.equals(agent.decision)) return false;
		agent.revision = revision;
		agent.decision = key;
		return true;
	}

	boolean problem(String id, String text, long now) { return problem(id, "", text, now); }

	boolean problem(String id, String reason, String text, long now) {
		return severe(reason) || problems.allow(id, text, now);
	}

	void acting(String id, String actionId, String activity, long now) {
		Agent agent = agent(id);
		if (actionId.equals(agent.actionId)) return;
		if (!activity.equals(agent.activity)) agent.count = 0;
		agent.activity = activity;
		agent.actionId = actionId;
		agent.finishedAt = -1;
		agent.startedAt = now;
	}

	void result(String id, String actionId, boolean success, long now) {
		Agent agent = agent(id);
		if (!actionId.equals(agent.actionId) || agent.finishedAt >= 0) return;
		if (success) agent.count++;
		agent.finishedAt = now;
	}

	String status(String id, long now) {
		Agent agent = agent(id);
		if (agent.activity == null || (agent.finishedAt >= 0 ? now - agent.finishedAt >= STATUS_LINGER_MS : now - agent.startedAt >= STATUS_STALE_MS)) return "";
		return agent.activity + (agent.count > 0 ? " ×" + agent.count : "");
	}

	List<String> items(String id, Set<String> inventory) {
		Agent agent = agent(id);
		List<String> acquired = new ArrayList<>();
		for (String item : IMPORTANT_ITEMS.stream().sorted().toList()) {
			if (inventory.contains(item) && agent.seenItems.add(item) && agent.inventoryKnown) acquired.add(item);
		}
		// Existing inventory on connection is a baseline, not a new acquisition.
		agent.inventoryKnown = true;
		return acquired;
	}

	String dimension(String id, String dimension) {
		Agent agent = agent(id);
		String previous = agent.dimension;
		agent.dimension = dimension;
		return previous != null && !previous.equals(dimension) ? dimension : null;
	}

	List<String> danger(String id, float health, int food, boolean alive) {
		Agent agent = agent(id);
		boolean lowHealth = alive && health <= 6;
		boolean hungry = alive && food <= 6;
		List<String> warnings = new ArrayList<>();
		if (lowHealth && !agent.lowHealth) warnings.add("Health is dangerously low.");
		if (hungry && !agent.hungry) warnings.add("Almost out of food.");
		agent.lowHealth = lowHealth;
		agent.hungry = hungry;
		return warnings;
	}

	static List<Integer> statusIndices(int size, long now) {
		if (size == 0) return List.of();
		if (size == 1) return List.of(0);
		if (size == 2) return List.of(0, 1);
		int start = (int) ((now / OVERLAY_REFRESH_MS) % size);
		return List.of(start, (start + 1) % size);
	}

	void externalOverlay(String viewer, long now) {
		viewers.computeIfAbsent(viewer, ignored -> new Viewer()).externalAt = now;
	}

	boolean overlay(String viewer, boolean operatorOrOwner, boolean agentBody, String text, long now) {
		if (!operatorOrOwner || agentBody || text.isBlank()) return false;
		Viewer state = viewers.computeIfAbsent(viewer, ignored -> new Viewer());
		if (state.externalAt >= 0 && now - state.externalAt < EXTERNAL_OVERLAY_MS) return false;
		if (text.equals(state.text) && now - state.sentAt < OVERLAY_REFRESH_MS) return false;
		state.text = text;
		state.sentAt = now;
		return true;
	}

	void retain(Set<String> ids) { agents.keySet().retainAll(ids); }
	void retainViewers(Set<String> ids) { viewers.keySet().retainAll(ids); }

	private static final class Viewer {
		String text = "";
		long sentAt;
		long externalAt = -1;
	}

	private Agent agent(String id) { return agents.computeIfAbsent(id, ignored -> new Agent()); }

	private static final class Agent {
		long revision = -1;
		String decision;
		String activity;
		String actionId;
		int count;
		long finishedAt = -1;
		long startedAt;
		boolean lowHealth;
		boolean hungry;
		boolean inventoryKnown;
		final Set<String> seenItems = new HashSet<>();
		String dimension;
	}
}
