package dev.agaminggod.arenaagents.server;

import dev.agaminggod.arenaagents.protocol.ActionType;
import dev.agaminggod.arenaagents.server.runtime.ServerActionProgress;
import dev.agaminggod.arenaagents.server.runtime.ServerActionObservation;
import dev.agaminggod.arenaagents.server.runtime.ServerActionResult;
import dev.agaminggod.arenaagents.server.runtime.ServerActionState;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;

/** Player-facing activity copy. Lifecycle plumbing stays in the field console, not chat. */
public final class AgentActivityPresentation {
	private AgentActivityPresentation() {
	}

	public static String action(ActionType type) {
		return switch (Objects.requireNonNull(type, "type must not be null")) {
			case CONTROL, CONTROL_SEQUENCE -> "Carrying out the next step";
			case MOVE_TO, NAVIGATE_TO, TRAVEL_TO -> "Moving to the next position";
			case DIG_TO -> "Digging toward a goal";
			case BUILD_SHELTER -> "Building a shelter";
			case CAST_OBSIDIAN -> "Casting obsidian";
			case BARTER_UNTIL -> "Bartering with piglins";
			case LOOK_AT -> "Looking around";
			case ATTACK, FIGHT_TARGET, FIGHT_UNTIL -> "Engaging a target";
			case SELECT_ITEM, SELECT_TOOL -> "Choosing the right item";
			case USE_ITEM -> "Using an item";
			case BREAK_BLOCK -> "Mining a block";
			case PLACE_BLOCK -> "Placing a block";
			case BUILD_SEQUENCE -> "Building a sequence";
			case CHAT -> "Sending a message";
			case WAIT -> "Waiting briefly";
			case SET_DOOR -> "Using a door";
			case PICK_UP_ITEM -> "Picking up an item";
			case DROP_ITEM -> "Dropping an item";
			case FLEE_FROM -> "Moving to safety";
			case FOLLOW_ENTITY -> "Following a target";
			case TRANSFER_CONTAINER -> "Moving items";
			case CRAFT_INVENTORY, CRAFT_TABLE -> "Crafting an item";
			case FURNACE_TRANSACTION -> "Using a furnace";
			case EQUIP_ITEM -> "Equipping an item";
			case BLOCK_WITH_SHIELD -> "Blocking with a shield";
			case USE_RANGED -> "Using a ranged weapon";
			case INTERACT_BLOCK -> "Interacting with a block";
			case INTERACT_ENTITY -> "Interacting with an entity";
			case DISMOUNT -> "Dismounting";
			case START_FALL_FLYING -> "Starting elytra flight";
			case SET_FLIGHT -> "Changing flight controls";
			case WAKE_UP -> "Waking up";
			case WRITE_SIGN -> "Writing a sign";
			case EDIT_BOOK -> "Writing a book";
			case MENU_CLICK -> "Using a menu";
			case MENU_CLOSE -> "Closing a menu";
			case BEACON_EFFECTS -> "Selecting beacon effects";
			case MENU_TRANSFER -> "Moving items in a menu";
			case MENU_BUTTON -> "Selecting a menu option";
			case ANVIL_RENAME -> "Naming an item";
			case RESPAWN -> "Respawning";
			case COMPLETE_GOAL -> "Finishing the task";
		};
	}

	public static String actionStart(ActionType type) {
		return sentence(action(type));
	}

	public static String status(ActionType type, com.google.gson.JsonObject arguments) {
		String key = switch (type) {
			case BREAK_BLOCK -> "expectedBlockId";
			case PLACE_BLOCK -> "itemId";
			case CRAFT_INVENTORY, CRAFT_TABLE -> "recipeId";
			default -> null;
		};
		if (key != null && arguments.has(key) && arguments.get(key).isJsonPrimitive()
				&& arguments.getAsJsonPrimitive(key).isString()) {
			String id = arguments.get(key).getAsString();
			if (id.matches("[a-z0-9_.-]+:[a-z0-9_/.-]+") && id.length() <= 64) {
				String verb = type == ActionType.BREAK_BLOCK ? "Mining " : type == ActionType.PLACE_BLOCK ? "Placing " : "Crafting ";
				return verb + readableIdentifier(id);
			}
		}
		return action(type);
	}

	public static String respawnDisconnected() {
		return "Connection lost while respawning. Reconnect the coordinator and try again.";
	}

	public static String progress(ActionType type, int milestone) {
		Objects.requireNonNull(type, "type must not be null");
		if (milestone != 25 && milestone != 50 && milestone != 75) {
			throw new IllegalArgumentException("progress milestone must be 25, 50, or 75");
		}
		return milestone + (type == ActionType.MOVE_TO || type == ActionType.NAVIGATE_TO || type == ActionType.TRAVEL_TO ? "% there." : "% complete.");
	}

	public static String goalNotComplete(java.util.List<dev.agaminggod.arenaagents.agent.goal.GoalEvidence.Fact> facts) {
		var unmet = facts.stream().filter(fact -> !fact.satisfied()).toList();
		if (!unmet.isEmpty() && unmet.stream().allMatch(fact -> fact.type().equals("operator_confirmed"))) {
			return "Finished the work. Waiting for your confirmation.";
		}
		var fact = unmet.isEmpty() ? null : unmet.getFirst();
		if (fact != null && fact.type().equals("inventory_contains")) {
			return "Still need " + readableIdentifier(fact.expectedValue()) + ". I'll keep working.";
		}
		return "The goal is not complete yet. I'll keep working.";
	}

	/** Chat describes the action; its detailed evidence remains in the protocol observation. */
	public static String progress(ServerActionProgress progress, int milestone) {
		Objects.requireNonNull(progress, "progress must not be null");
		String message = progress(progress.actionType(), milestone);
		ServerActionObservation observation = progress.actionObservation();
		if (observation == null) return message;
		if (progress.actionType() == ActionType.BREAK_BLOCK) {
			String block = observation.target() == null ? null : observation.target().expectedId();
			if (block == null && observation.lookedAt() != null && observation.lookedAt().type().equals("block")) {
				block = observation.lookedAt().id();
			}
			if (block != null) return "Mining " + readableIdentifier(block) + ": " + message;
		}
		if ((progress.actionType() == ActionType.MOVE_TO || progress.actionType() == ActionType.NAVIGATE_TO)
				&& observation.target() != null && observation.target().distanceRemaining() != null) {
			return message + " " + String.format(Locale.ROOT, "%.1f", observation.target().distanceRemaining())
					+ " blocks to go.";
		}
		return message;
	}

	public static String verboseResultStage(ServerActionResult result) {
		Objects.requireNonNull(result, "result must not be null");
		if (result.state() == ServerActionState.SUCCEEDED || result.state() == ServerActionState.CANCELLED) {
			return "result";
		}
		if (timedOut(result)) return "error";
		return result.state() == ServerActionState.FAILED && !shouldAnnounceFailure(result.reasonCode())
				? "retry" : "error";
	}

	public static String verboseResult(ServerActionResult result) {
		Objects.requireNonNull(result, "result must not be null");
		if (timedOut(result)) {
			return timeoutSubject(result.actionType()) + " timed out after " + readableDuration(result.elapsedMs()) + ".";
		}
		if (result.state() == ServerActionState.CANCELLED) {
			return timeoutSubject(result.actionType()) + " was cancelled.";
		}
		if ("retry".equals(verboseResultStage(result))) return recoveryMessage(result.reasonCode());
		if (result.state() == ServerActionState.SUCCEEDED) {
			return successfulResult(result.actionType());
		}
		String detail = compactResultMessage(result.message());
		return detail.isBlank()
				? sentence(timeoutSubject(result.actionType()) + " failed")
				: timeoutSubject(result.actionType()) + " failed: " + sentence(detail);
	}

	private static String successfulResult(ActionType type) {
		return switch (type) {
			case CONTROL, CONTROL_SEQUENCE -> "Step complete.";
			case MOVE_TO, NAVIGATE_TO, TRAVEL_TO -> "Destination reached.";
			case LOOK_AT -> "Finished looking around.";
			case BREAK_BLOCK -> "Block broken.";
			case PLACE_BLOCK -> "Block placed.";
			case BUILD_SEQUENCE -> "Building steps complete.";
			case PICK_UP_ITEM -> "Picked up the item.";
			case CRAFT_INVENTORY, CRAFT_TABLE -> "Crafted the item.";
			case SELECT_ITEM, SELECT_TOOL -> "Selected the item.";
			case TRANSFER_CONTAINER, MENU_TRANSFER -> "Moved the items.";
			case CHAT -> "Message sent.";
			case DROP_ITEM -> "Dropped the item.";
			case EQUIP_ITEM -> "Equipped the item.";
			case MENU_CLOSE -> "Closed the menu.";
			case ANVIL_RENAME -> "Renamed the item.";
			case WRITE_SIGN -> "Updated the sign.";
			case EDIT_BOOK -> "Updated the book.";
			case RESPAWN -> "Respawned.";
			case COMPLETE_GOAL -> "Task complete.";
			default -> "Step complete.";
		};
	}

	private static String readableIdentifier(String id) {
		int separator = id.indexOf(':');
		return id.substring(separator + 1).replace('_', ' ').replace('/', ' ');
	}

	public static Optional<String> result(ServerActionResult result) {
		Objects.requireNonNull(result, "result must not be null");
		if (result.state() != ServerActionState.FAILED && result.state() != ServerActionState.TIMED_OUT) return Optional.empty();
		String reason = result.reasonCode();
		if (result.state() == ServerActionState.TIMED_OUT && (reason == null || reason.isBlank())) reason = "ACTION_TIMEOUT";
		String action = "finish " + action(result.actionType()).toLowerCase(Locale.ROOT);
		Optional<String> problem = AgentFeedPolicy.problem(action, reason, result.message());
		return problem.isEmpty() && result.state() == ServerActionState.TIMED_OUT
				? AgentFeedPolicy.problem(action, "ACTION_TIMEOUT", "") : problem;
	}


	public static boolean shouldAnnounceAction(ActionType type) {
		Objects.requireNonNull(type, "type must not be null");
		return false;
	}

	public static boolean shouldAnnounceFailure(String reasonCode) {
		return AgentFeedPolicy.shouldAnnounceFailure(reasonCode);
	}

	/** Returns whether a reason belongs in public chat; routine failures stay structured. */
	public static boolean shouldShowInChat(String reasonCode, boolean routine) {
		return !routine || shouldAnnounceFailure(reasonCode);
	}


	private static boolean timedOut(ServerActionResult result) {
		if (result.state() == ServerActionState.TIMED_OUT) return true;
		String reason = result.reasonCode();
		if (reason == null) return false;
		String normalized = reason.toUpperCase(Locale.ROOT);
		return normalized.contains("TIMEOUT") || normalized.contains("TIMED_OUT");
	}

	private static String recoveryMessage(String reasonCode) {
		if (reasonCode != null) {
			String normalized = reasonCode.toUpperCase(Locale.ROOT);
			if (normalized.equals("PATH_BLOCKED") || normalized.equals("NO_PATH") || normalized.equals("NO_PROGRESS")
					|| normalized.equals("NO_STANDABLE_PATH") || normalized.equals("PATH_LIMIT_REACHED")) {
				return "The path is blocked. Trying another route.";
			}
		}
		return "That action did not work. Trying another approach.";
	}

	private static String timeoutSubject(ActionType type) {
		return switch (type) {
			case MOVE_TO, NAVIGATE_TO, TRAVEL_TO -> "Movement";
			case BREAK_BLOCK -> "Mining";
			case PLACE_BLOCK -> "Block placement";
			case BUILD_SEQUENCE -> "Building";
			case CRAFT_INVENTORY, CRAFT_TABLE -> "Crafting";
			case RESPAWN -> "Respawning";
			default -> action(type);
		};
	}

	private static String readableDuration(long elapsedMs) {
		if (elapsedMs < 1_000L) return elapsedMs + (elapsedMs == 1L ? " millisecond" : " milliseconds");
		if (elapsedMs % 1_000L == 0L) {
			long seconds = elapsedMs / 1_000L;
			return seconds + (seconds == 1L ? " second" : " seconds");
		}
		String seconds = String.format(Locale.ROOT, "%.1f", elapsedMs / 1_000.0D);
		return seconds + " seconds";
	}

	private static String compactResultMessage(String message) {
		if (message == null || message.isBlank()) return "";
		String compact = message.replace('\n', ' ').replace('\r', ' ').trim();
		return compact.length() <= 180 ? compact : compact.substring(0, 177) + "...";
	}

	private static String sentence(String value) {
		if (value.endsWith(".") || value.endsWith("!") || value.endsWith("?")) return value;
		return value + ".";
	}
}
