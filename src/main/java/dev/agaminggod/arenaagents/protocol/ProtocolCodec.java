package dev.agaminggod.arenaagents.protocol;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigDecimal;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.EnumMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

public final class ProtocolCodec {
	public static final int MAX_ACTION_ARGUMENT_BYTES = 32_768;
	private static final String FIELD_PROTOCOL_VERSION = ProtocolConstants.FIELD_PROTOCOL_VERSION;
	private static final String FIELD_COMMAND_ID = "commandId";
	private static final String FIELD_TYPE = "type";
	private static final String FIELD_ISSUED_AT_EPOCH_MS = "issuedAtEpochMs";
	private static final String FIELD_X = "x";
	private static final String FIELD_Y = "y";
	private static final String FIELD_Z = "z";
	private static final String FIELD_TOLERANCE = "tolerance";
	private static final String FIELD_SPRINT = "sprint";
	private static final String FIELD_FORWARD = "forward";
	private static final String FIELD_STRAFE = "strafe";
	private static final String FIELD_JUMP = "jump";
	private static final String FIELD_SNEAK = "sneak";
	private static final String FIELD_ATTACK = "attack";
	private static final String FIELD_USE = "use";
	private static final String FIELD_YAW = "yaw";
	private static final String FIELD_PITCH = "pitch";
	private static final String FIELD_SELECTED_SLOT = "selectedSlot";
	private static final String FIELD_TICKS = "ticks";
	/** Optional on control frames: true writes the frame's yaw and pitch at once instead of a player-speed turn. */
	private static final String FIELD_INSTANT_LOOK = "instantLook";
	private static final String FIELD_ACCEPT_LAVA_RISK = "acceptLavaRisk";
	private static final String FIELD_TARGET_SELECTOR = "targetSelector";
	private static final String FIELD_TARGET_ID = "targetId";
	private static final String FIELD_TIMEOUT_MS = "timeoutMs";
	private static final String FIELD_ITEM_ID = "itemId";
	private static final String FIELD_DURATION_MS = "durationMs";
	private static final String FIELD_FACE = "face";
	private static final String FIELD_FACE_MODE = "faceMode";
	private static final String FIELD_DESIRED_STATE = "desiredState";
	private static final String FIELD_PLACEMENTS = "placements";
	private static final int MAX_DESIRED_STATE_LENGTH = 512;
	private static final int MAX_BUILD_SEQUENCE_PLACEMENTS = 32;
	private static final String FIELD_MESSAGE = "message";
	private static final String FIELD_AUDIENCE = "audience";
	private static final String FIELD_RECIPIENT_ID = "recipientId";
	private static final String FIELD_SUMMARY = "summary";
	private static final String FIELD_OPEN = "open";
	private static final String FIELD_SLOT = "slot";
	private static final String FIELD_COUNT = "count";
	private static final String FIELD_DESIRED_RANGE = "desiredRange";
	private static final String FIELD_DISTANCE = "distance";
	private static final String FIELD_FLEE_AT_HEALTH = "fleeAtHealth";
	private static final String FIELD_CONTINUE_WITH_ATTACKERS = "continueWithAttackers";
	private static final String FIELD_TARGET_POLICY = "targetPolicy";
	private static final String FIELD_PURSUE = "pursue";
	private static final String FIELD_INCLUDE_PLAYERS = "includePlayers";
	private static final Set<String> TARGET_POLICIES = Set.of("named", "highest_risk", "nearest_attacker");
	private static final String FIELD_SOURCE_KIND = "sourceKind";
	private static final String FIELD_SOURCE_SLOT = "sourceSlot";
	private static final String FIELD_DESTINATION_KIND = "destinationKind";
	private static final String FIELD_DESTINATION_SLOT = "destinationSlot";
	private static final String FIELD_EXPECTED_ITEM_ID = "expectedItemId";
	private static final String FIELD_EXPECTED_BLOCK_ID = "expectedBlockId";
	private static final String FIELD_RECIPE_ID = "recipeId";
	private static final String FIELD_OPERATION = "operation";
	private static final String FIELD_INVENTORY_SLOT = "inventorySlot";
	private static final String FIELD_TARGET_SLOT = "targetSlot";
	private static final String FIELD_HOTBAR_SLOT = "hotbarSlot";
	private static final String FIELD_MIN_REMAINING_DURABILITY = "minRemainingDurability";
	private static final String FIELD_DRAW_DURATION_MS = "drawDurationMs";
	private static final String FIELD_HAND = "hand";
	private static final String FIELD_MENU_ID = "menuId";
	private static final String FIELD_BUTTON_ID = "buttonId";
	private static final String FIELD_NAME = "name";

	private static final List<String> ENVELOPE_FIELDS = List.of(
			FIELD_PROTOCOL_VERSION,
			FIELD_COMMAND_ID,
			FIELD_TYPE,
			FIELD_ISSUED_AT_EPOCH_MS
	);
	private static final List<String> BLOCK_FACES = List.of("down", "up", "north", "south", "west", "east");
	private static final Map<ActionType, List<String>> ACTION_FIELDS = createActionFields();
	private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

	public ActionCommand decodeCommand(String json) throws ProtocolException {
		enforceLineLimit(json);
		JsonObject commandObject = parseObject(json);
		ActionType actionType = requireActionType(commandObject);
		JsonObject arguments = validateActionArguments(
				actionType,
				copyActionArguments(commandObject, actionType)
		);

		validateProtocolVersion(commandObject);
		String commandId = requireBoundedText(
				commandObject,
				FIELD_COMMAND_ID,
				ProtocolConstants.MAX_COMMAND_ID_LENGTH,
				false
		);
		long issuedAtEpochMs = requirePositiveLong(commandObject, FIELD_ISSUED_AT_EPOCH_MS);
		validateKnownFields(commandObject, actionType);

		return new ActionCommand(commandId, actionType, arguments, issuedAtEpochMs);
	}

	public String encode(Object value) throws ProtocolException {
		String json = serialize(toVersionedJsonObject(value));
		enforceLineLimit(json);
		return json;
	}

	public JsonObject toVersionedJsonObject(Object value) throws ProtocolException {
		if (value == null) {
			throw invalidField("Protocol value must not be null");
		}

		return value instanceof ActionCommand command
				? encodeCommand(command)
				: ensureProtocolVersion(encodeObject(value));
	}

	public String readLine(InputStream input) throws IOException, ProtocolException {
		if (input == null) {
			throw invalidField("Input stream must not be null");
		}

		ByteArrayOutputStream line = new ByteArrayOutputStream();
		while (true) {
			int next = input.read();
			if (next == -1) {
				if (line.size() == 0) {
					return null;
				}
				throw new ProtocolException("INCOMPLETE_FRAME", "JSON line ended before a newline delimiter");
			}
			if (next == '\n') {
				return decodeUtf8Line(line.toByteArray());
			}
			if (line.size() >= ProtocolConstants.MAX_LINE_BYTES) {
				throw new ProtocolException(
						ProtocolConstants.ERROR_LINE_TOO_LARGE,
						"JSON line exceeds maximum of " + ProtocolConstants.MAX_LINE_BYTES + " UTF-8 bytes"
				);
			}
			line.write(next);
		}
	}

	public void writeLine(OutputStream output, String json) throws IOException, ProtocolException {
		if (output == null) {
			throw invalidField("Output stream must not be null");
		}
		enforceLineLimit(json);
		output.write(json.getBytes(StandardCharsets.UTF_8));
		output.write('\n');
		output.flush();
	}

	private static String decodeUtf8Line(byte[] bytes) throws ProtocolException {
		int length = bytes.length;
		if (length > 0 && bytes[length - 1] == '\r') {
			length--;
		}
		try {
			return StandardCharsets.UTF_8.newDecoder()
					.onMalformedInput(CodingErrorAction.REPORT)
					.onUnmappableCharacter(CodingErrorAction.REPORT)
					.decode(ByteBuffer.wrap(bytes, 0, length))
					.toString();
		} catch (CharacterCodingException exception) {
			throw new ProtocolException("INVALID_ENCODING", "JSON line must be valid UTF-8", exception);
		}
	}

	private static JsonObject ensureProtocolVersion(JsonObject encoded) throws ProtocolException {
		if (encoded.has(FIELD_PROTOCOL_VERSION)) {
			validateProtocolVersion(encoded);
			return encoded;
		}

		JsonObject versioned = new JsonObject();
		versioned.addProperty(FIELD_PROTOCOL_VERSION, ProtocolConstants.PROTOCOL_VERSION);
		for (Map.Entry<String, JsonElement> entry : encoded.entrySet()) {
			versioned.add(entry.getKey(), entry.getValue().deepCopy());
		}
		return versioned;
	}

	private static String serialize(JsonObject encoded) throws ProtocolException {
		try {
			return GSON.toJson(encoded);
		} catch (RuntimeException exception) {
			throw new ProtocolException(
					ProtocolConstants.ERROR_ENCODING_FAILED,
					"Could not encode protocol value as JSON: " + exception.getMessage(),
					exception
			);
		}
	}

	private static JsonObject encodeCommand(ActionCommand command) throws ProtocolException {
		JsonObject encoded = new JsonObject();
		encoded.addProperty(FIELD_PROTOCOL_VERSION, ProtocolConstants.PROTOCOL_VERSION);
		encoded.addProperty(FIELD_COMMAND_ID, command.commandId());
		encoded.addProperty(FIELD_TYPE, command.type().wireName());
		encoded.addProperty(FIELD_ISSUED_AT_EPOCH_MS, command.issuedAtEpochMs());

		for (Map.Entry<String, JsonElement> entry : command.arguments().entrySet()) {
			if (encoded.has(entry.getKey())) {
				throw unknownField(entry.getKey(), command.type());
			}
			encoded.add(entry.getKey(), entry.getValue().deepCopy());
		}

		validateActionArguments(command.type(), command.arguments());
		validateKnownFields(encoded, command.type());
		return encoded;
	}

	private static JsonObject encodeObject(Object value) throws ProtocolException {
		try {
			JsonElement element = GSON.toJsonTree(value);
			if (!element.isJsonObject()) {
				throw invalidField("Encoded protocol value must be a JSON object");
			}
			return element.getAsJsonObject();
		} catch (ProtocolException exception) {
			throw exception;
		} catch (RuntimeException exception) {
			throw new ProtocolException(
					ProtocolConstants.ERROR_ENCODING_FAILED,
					"Could not encode protocol value as JSON: " + exception.getMessage(),
					exception
			);
		}
	}

	private static JsonObject parseObject(String json) throws ProtocolException {
		try {
			JsonElement parsed = JsonParser.parseString(json);
			if (!parsed.isJsonObject()) {
				throw malformedJson("Command JSON must be an object", null);
			}
			return parsed.getAsJsonObject();
		} catch (JsonParseException exception) {
			throw malformedJson("Malformed JSON command: " + exception.getMessage(), exception);
		}
	}

	private static void enforceLineLimit(String json) throws ProtocolException {
		if (json == null) {
			throw invalidField("Command JSON must not be null");
		}
		int byteLength = json.getBytes(StandardCharsets.UTF_8).length;
		if (byteLength > ProtocolConstants.MAX_LINE_BYTES) {
			throw new ProtocolException(
					ProtocolConstants.ERROR_LINE_TOO_LARGE,
					"Command line is " + byteLength + " UTF-8 bytes; maximum is "
							+ ProtocolConstants.MAX_LINE_BYTES
			);
		}
	}

	private static ActionType requireActionType(JsonObject command) throws ProtocolException {
		String wireName = requireString(command, FIELD_TYPE);
		if (isProtocolBlank(wireName)) {
			throw invalidField("Field '" + FIELD_TYPE + "' must not be blank");
		}
		return ActionType.fromWireName(wireName)
				.orElseThrow(() -> new ProtocolException(
						ProtocolConstants.ERROR_UNKNOWN_ACTION,
						"Unknown action type '" + wireName + "'"
				));
	}

	private static void validateProtocolVersion(JsonObject command) throws ProtocolException {
		long version = requireIntegralLong(command, FIELD_PROTOCOL_VERSION);
		if (version != ProtocolConstants.PROTOCOL_VERSION) {
			throw new ProtocolException(
					ProtocolConstants.ERROR_UNSUPPORTED_VERSION,
					"Unsupported protocolVersion " + version + "; expected " + ProtocolConstants.PROTOCOL_VERSION
			);
		}
	}

	public static JsonObject validateActionArguments(ActionType actionType, JsonObject arguments)
			throws ProtocolException {
		if (actionType == null) {
			throw invalidField("Action type must not be null");
		}
		if (arguments == null) {
			throw invalidField("Action arguments must not be null");
		}

		switch (actionType) {
			case MOVE_TO -> validateMoveTo(arguments);
			case CONTROL -> validateControl(arguments);
			case CONTROL_SEQUENCE -> validateControlSequence(arguments);
			case LOOK_AT -> validateCoordinates(arguments, false);
			case ATTACK -> validateAttack(arguments);
			case SELECT_ITEM -> requireIdentifier(arguments, FIELD_ITEM_ID);
			case USE_ITEM -> {
				if (arguments.has("aimX") || arguments.has("aimY") || arguments.has("aimZ")) {
					for (String field : List.of("aimX", "aimY", "aimZ")) requireFiniteRange(arguments, field, -30_000_000, 30_000_000);
				}
				requireDuration(arguments, FIELD_DURATION_MS);
				if (arguments.has("mode")) requireOneOf(arguments, "mode", List.of("once", "hold", "inspect"));
				if (present(arguments, FIELD_HAND)) requireOneOf(arguments, FIELD_HAND, List.of("main", "off"));
				if (present(arguments, FIELD_EXPECTED_ITEM_ID)) requireIdentifier(arguments, FIELD_EXPECTED_ITEM_ID);
				if (present(arguments, FIELD_ACCEPT_LAVA_RISK)) requireBoolean(arguments, FIELD_ACCEPT_LAVA_RISK);
			}
			case WAIT -> requireDuration(arguments, FIELD_DURATION_MS);
			case BREAK_BLOCK -> validateBreakBlock(arguments);
			case PLACE_BLOCK -> validatePlaceBlock(arguments);
			case BUILD_SEQUENCE -> validateBuildSequence(arguments);
			case CHAT -> validateChat(arguments);
			case SET_DOOR -> {
				validateCoordinates(arguments, true);
				requireBoolean(arguments, FIELD_OPEN);
			}
			case PICK_UP_ITEM -> requireBoundedText(
					arguments, FIELD_TARGET_SELECTOR, ProtocolConstants.MAX_TARGET_SELECTOR_LENGTH, false
			);
			case DROP_ITEM -> validateDropItem(arguments);
			case NAVIGATE_TO -> validateNavigateTo(arguments);
			case DIG_TO -> validateDigTo(arguments);
			case BUILD_SHELTER -> {
				validateCoordinates(arguments, true);
				requireOneOf(arguments, "opening", List.of("north", "south", "east", "west"));
				requireIdentifier(arguments, FIELD_ITEM_ID);
				if (arguments.has("roof")) requireBoolean(arguments, "roof");
				requireDuration(arguments, FIELD_TIMEOUT_MS);
			}
			case CAST_OBSIDIAN -> {
				validateCoordinates(arguments, true);
				if (present(arguments, "axis")) requireOneOf(arguments, "axis", List.of("x", "z"));
				if (present(arguments, "frame")) requireBoolean(arguments, "frame");
				if (present(arguments, FIELD_COUNT)) requireIntegralRange(arguments, FIELD_COUNT, 1, 64);
				requireDuration(arguments, FIELD_TIMEOUT_MS);
			}
			case BARTER_UNTIL -> {
				requireIdentifier(arguments, FIELD_ITEM_ID);
				requireIntegralRange(arguments, FIELD_COUNT, 1, 64);
				requireDuration(arguments, FIELD_TIMEOUT_MS);
			}
			case TRAVEL_TO -> validateTravelTo(arguments);
			case FIGHT_TARGET -> validateFightTarget(arguments);
			case FIGHT_UNTIL -> validateFightUntil(arguments);
			case FLEE_FROM -> validateFleeFrom(arguments);
			case FOLLOW_ENTITY -> validateRangedTargetAction(arguments);
			case TRANSFER_CONTAINER -> validateTransferContainer(arguments);
			case CRAFT_INVENTORY -> validateCraftInventory(arguments);
			case CRAFT_TABLE -> validateCraftTable(arguments);
			case FURNACE_TRANSACTION -> validateFurnaceTransaction(arguments);
			case EQUIP_ITEM -> validateEquipItem(arguments);
			case SELECT_TOOL -> validateSelectTool(arguments);
			case BLOCK_WITH_SHIELD -> requireDuration(arguments, FIELD_DURATION_MS);
			case USE_RANGED -> validateUseRanged(arguments);
			case INTERACT_BLOCK -> validateInteractBlock(arguments);
			case INTERACT_ENTITY -> validateInteractEntity(arguments);
			case DISMOUNT, START_FALL_FLYING, WAKE_UP -> { }
			case SET_FLIGHT -> requireBoolean(arguments, "enabled");
			case WRITE_SIGN -> {
				validateCoordinates(arguments, true);
				requireBoolean(arguments, "front");
				validateTextArray(arguments, "lines", 4, 4, 384);
				validateTextArray(arguments, "expectedLines", 4, 4, 384);
			}
			case EDIT_BOOK -> {
				long slot = requireIntegralLong(arguments, "slot");
				if (slot != 40 && (slot < 0 || slot > 8)) throw invalidField("Book must be in hotbar or offhand");
				validateTextArray(arguments, "pages", 0, 100, 1024);
				if (present(arguments, "title")) requireBoundedText(arguments, "title", 32, false);
				requireBoundedText(arguments, "expectedFingerprint", 256, false);
			}
			case MENU_CLICK, MENU_CLOSE -> validateMenuInput(arguments, actionType == ActionType.MENU_CLICK);
			case BEACON_EFFECTS -> {
				validateMenuInput(arguments, false);
				requireIdentifier(arguments, "primaryEffectId");
				requireIdentifier(arguments, "secondaryEffectId");
			}
			case MENU_TRANSFER -> validateMenuTransfer(arguments);
			case MENU_BUTTON -> validateMenuButton(arguments);
			case ANVIL_RENAME -> validateAnvilRename(arguments);
			case RESPAWN -> { }
			case COMPLETE_GOAL -> requireBoundedText(
					arguments,
					FIELD_SUMMARY,
					ProtocolConstants.MAX_SUMMARY_LENGTH,
					false
			);
		}
		validateKnownArgumentFields(arguments, actionType);
		if (arguments.toString().getBytes(StandardCharsets.UTF_8).length > MAX_ACTION_ARGUMENT_BYTES) {
			throw new ProtocolException("ACTION_ARGUMENTS_TOO_LARGE", "Action arguments exceed "
					+ MAX_ACTION_ARGUMENT_BYTES + " serialized UTF-8 bytes");
		}

		JsonObject validatedArguments = new JsonObject();
		for (String field : ACTION_FIELDS.get(actionType)) {
			JsonElement value = arguments.get(field);
			if (value != null) validatedArguments.add(field, value.deepCopy());
		}
		return validatedArguments;
	}

	private static JsonObject copyActionArguments(JsonObject command, ActionType actionType) {
		JsonObject arguments = new JsonObject();
		for (String field : ACTION_FIELDS.get(actionType)) {
			if (command.has(field)) {
				arguments.add(field, command.get(field).deepCopy());
			}
		}
		return arguments;
	}

	private static void validateMoveTo(JsonObject command) throws ProtocolException {
		validateCoordinates(command, false);
		double tolerance = requireFiniteNumber(command, FIELD_TOLERANCE);
		if (tolerance < ProtocolConstants.MIN_MOVEMENT_TOLERANCE
				|| tolerance > ProtocolConstants.MAX_MOVEMENT_TOLERANCE) {
			throw outOfRange(
					FIELD_TOLERANCE,
					ProtocolConstants.MIN_MOVEMENT_TOLERANCE + " to "
							+ ProtocolConstants.MAX_MOVEMENT_TOLERANCE
			);
		}
		requireBoolean(command, FIELD_SPRINT);
	}

	private static void validateControl(JsonObject command) throws ProtocolException {
		requireFiniteRange(command, FIELD_FORWARD, -1.0D, 1.0D);
		requireFiniteRange(command, FIELD_STRAFE, -1.0D, 1.0D);
		for (String field : List.of(FIELD_JUMP, FIELD_SNEAK, FIELD_SPRINT, FIELD_ATTACK, FIELD_USE)) {
			requireBoolean(command, field);
		}
		requireFiniteRange(command, FIELD_YAW, -180.0D, 180.0D);
		requireFiniteRange(command, FIELD_PITCH, -90.0D, 90.0D);
		requireIntegralRange(command, FIELD_SELECTED_SLOT, 0L, 8L);
		requireOneOf(command, FIELD_HAND, List.of("main", "off"));
		requireIntegralRange(command, FIELD_TICKS, 1L, 200L);
		if (present(command, FIELD_INSTANT_LOOK)) requireBoolean(command, FIELD_INSTANT_LOOK);
	}

	private static boolean present(JsonObject arguments, String field) {
		return arguments.has(field) && !arguments.get(field).isJsonNull();
	}

	private static void validateControlSequence(JsonObject arguments) throws ProtocolException {
		requireIntegralRange(arguments, "maxTicks", 1, 2000);
		JsonElement value = requireField(arguments, "frames");
		if (!value.isJsonArray() || value.getAsJsonArray().isEmpty() || value.getAsJsonArray().size() > 64) {
			throw invalidField("frames must contain 1 to 64 input frames");
		}
		int size = value.getAsJsonArray().size();
		for (JsonElement element : value.getAsJsonArray()) {
			if (!element.isJsonObject()) throw invalidField("frame must be an object");
			JsonObject frame = element.getAsJsonObject();
			validateControl(frame);
			for (String key : frame.keySet()) if (!ACTION_FIELDS.get(ActionType.CONTROL).contains(key) && !"branches".equals(key)) throw invalidField("Unknown frame field " + key);
			if (!frame.has("branches")) continue;
			if (!frame.get("branches").isJsonArray() || frame.getAsJsonArray("branches").size() > 16) throw invalidField("branches must be an array of at most 16 conditions");
			for (JsonElement branchElement : frame.getAsJsonArray("branches")) {
				if (!branchElement.isJsonObject()) throw invalidField("branch must be an object");
				JsonObject branch = branchElement.getAsJsonObject();
				if (!branch.keySet().equals(Set.of("condition", "value", "nextFrame"))) throw invalidField("branch requires condition, value and nextFrame");
				String condition = requireIdentifier(branch, "condition");
				if (Set.of("health_below", "food_below", "air_below").contains(condition)) requireFiniteRange(branch, "value", 0, switch (condition) { case "health_below" -> 2048; case "food_below" -> 20; default -> 100000; });
				else if (Set.of("on_fire", "in_water", "on_ground", "horizontal_collision", "hurt", "using_item").contains(condition)) requireBoolean(branch, "value");
				else throw invalidField("Unsupported observed condition " + condition);
				requireIntegralRange(branch, "nextFrame", 0, size);
			}
		}
	}

	private static void validateMenuInput(JsonObject arguments, boolean click) throws ProtocolException {
		requireIdentifier(arguments, FIELD_MENU_ID);
		requireIntegralRange(arguments, "containerId", 0, Integer.MAX_VALUE);
		requireIntegralRange(arguments, "stateId", 0, Integer.MAX_VALUE);
		if (!click) return;
		long slot = requireIntegralLong(arguments, "slot");
		if (slot != -999 && (slot < 0 || slot > 255)) throw invalidField("slot must be -999 or 0 to 255");
		requireIntegralRange(arguments, "button", 0, 40);
		requireOneOf(arguments, "clickType", List.of("PICKUP", "QUICK_MOVE", "SWAP", "CLONE", "THROW", "QUICK_CRAFT", "PICKUP_ALL"));
		requireIdentifier(arguments, FIELD_EXPECTED_ITEM_ID);
		requireIntegralRange(arguments, "expectedCount", 0, Integer.MAX_VALUE);
		if (present(arguments, "expectedFingerprint")) requireBoundedText(arguments, "expectedFingerprint", 256, true);
	}

	private static void validateTextArray(JsonObject arguments, String field, int minimum, int maximum, int textLimit) throws ProtocolException {
		JsonElement value = requireField(arguments, field);
		if (!value.isJsonArray() || value.getAsJsonArray().size() < minimum || value.getAsJsonArray().size() > maximum) throw invalidField("Invalid " + field + " length");
		for (JsonElement entry : value.getAsJsonArray()) if (!entry.isJsonPrimitive() || !entry.getAsJsonPrimitive().isString() || entry.getAsString().length() > textLimit) throw invalidField("Invalid " + field + " text");
	}

	private static void validateHitOffsets(JsonObject arguments, double minimum, double maximum) throws ProtocolException {
		int count = 0;
		for (String key : List.of("hitX", "hitY", "hitZ")) {
			if (present(arguments, key)) { count++; requireFiniteRange(arguments, key, minimum, maximum); }
		}
		if (count != 0 && count != 3) throw invalidField("hitX, hitY and hitZ must be provided together");
	}

	private static void validateChat(JsonObject arguments) throws ProtocolException {
		requireBoundedCodePointText(arguments, FIELD_MESSAGE, ProtocolConstants.MAX_CHAT_LENGTH);
		String audience = arguments.has(FIELD_AUDIENCE) && !arguments.get(FIELD_AUDIENCE).isJsonNull()
				? requireBoundedText(arguments, FIELD_AUDIENCE, 32, false)
				: "public";
		if (!Set.of("public", "direct", "proximity").contains(audience)) {
			throw invalidField("Field 'audience' must be public, direct, or proximity");
		}
		if ("proximity".equals(audience)) {
			requireBoundedCodePointText(arguments, FIELD_MESSAGE, ProtocolConstants.MAX_VOICE_TEXT_LENGTH);
		}
		boolean hasRecipient = arguments.has(FIELD_RECIPIENT_ID) && !arguments.get(FIELD_RECIPIENT_ID).isJsonNull();
		if ("direct".equals(audience)) {
			if (!hasRecipient) throw new ProtocolException(ProtocolConstants.ERROR_MISSING_FIELD, "Required field 'recipientId' is missing");
			requireUuid(arguments, FIELD_RECIPIENT_ID);
		} else if (hasRecipient) {
			throw invalidField("Field 'recipientId' is only valid for direct chat");
		}
	}

	private static void validateAttack(JsonObject command) throws ProtocolException {
		requireUuid(command, FIELD_TARGET_ID);
		requireDuration(command, FIELD_TIMEOUT_MS);
	}

	private static void validateNavigateTo(JsonObject command) throws ProtocolException {
		validateMoveTo(command);
		requireDuration(command, FIELD_TIMEOUT_MS);
	}

	/** A staircase needs a target y; a tunnel needs a target x/z or a heading. */
	private static void validateDigTo(JsonObject command) throws ProtocolException {
		String pattern = present(command, "pattern") ? requireOneOf(command, "pattern", List.of("stairs_down", "steep_down", "stairs_up", "tunnel", "shaft")) : "stairs_down";
		if (present(command, FIELD_Y)) requireFiniteRange(command, FIELD_Y, -2048.0D, 2048.0D);
		if (present(command, FIELD_X)) requireFiniteRange(command, FIELD_X, -30_000_000.0D, 30_000_000.0D);
		if (present(command, FIELD_Z)) requireFiniteRange(command, FIELD_Z, -30_000_000.0D, 30_000_000.0D);
		if (present(command, "heading")) requireOneOf(command, "heading", List.of("north", "south", "east", "west"));
		if (present(command, "maxBlocks")) requireFiniteRange(command, "maxBlocks", 1.0D, 4096.0D);
		if (present(command, "throughCaves")) requireBoolean(command, "throughCaves");
		if (present(command, "maxShaftY")) requireFiniteRange(command, "maxShaftY", -2048.0D, 2048.0D);
		if (present(command, "stopWhenSeen")) requireIdentifier(command, "stopWhenSeen");
		if (!pattern.equals("tunnel") && !present(command, FIELD_Y)) throw invalidField("Field 'y' is required for " + pattern);
		if (pattern.equals("tunnel") && !present(command, FIELD_X) && !present(command, FIELD_Z) && !present(command, "heading"))
			throw invalidField("A tunnel needs x, z or heading");
		requireDuration(command, FIELD_TIMEOUT_MS);
	}

	/**
	 * A target position (x and z, y optional) or a heading (yaw degrees and distance), never both; tolerance is the
	 * horizontal arrival radius; build, stopWhenSeen, minHealth and timeoutMs are optional.
	 */
	private static void validateTravelTo(JsonObject command) throws ProtocolException {
		boolean position = present(command, FIELD_X) || present(command, FIELD_Z);
		boolean heading = present(command, FIELD_YAW) || present(command, FIELD_DISTANCE);
		if (position == heading) throw invalidField("travel_to needs either x and z (y optional) or yaw and distance");
		if (position) {
			requireFiniteNumber(command, FIELD_X);
			requireFiniteNumber(command, FIELD_Z);
			if (present(command, FIELD_Y)) requireFiniteNumber(command, FIELD_Y);
		} else {
			if (present(command, FIELD_Y)) throw invalidField("travel_to by heading takes no y");
			requireFiniteRange(command, FIELD_YAW, -180.0D, 180.0D);
			requireFiniteRange(command, FIELD_DISTANCE, 1.0D, 10_000.0D);
		}
		if (present(command, FIELD_TOLERANCE)) requireFiniteRange(command, FIELD_TOLERANCE, 1.0D, 64.0D);
		if (present(command, "build")) requireBoolean(command, "build");
  if (present(command,"retrace")) requireBoolean(command,"retrace");
  if (present(command,"dimension")) requireIdentifier(command,"dimension");
  if (present(command,"retrace") && command.get("retrace").getAsBoolean()) {
   if (!position) throw invalidField("retrace needs x,y,z, not a heading");
   requireFiniteNumber(command,FIELD_Y);
  }
  if (present(command,"dimension") && !(present(command,"retrace") && command.get("retrace").getAsBoolean())) throw invalidField("dimension requires retrace:true");
		if (present(command, "stopWhenSeen")) requireIdentifier(command, "stopWhenSeen");
		if (present(command, "minHealth")) requireFiniteRange(command, "minHealth", 0.0D, 20.0D);
		if (present(command, "fightThrough")) requireBoolean(command, "fightThrough");
		if (present(command, "fightThrough") && command.get("fightThrough").getAsBoolean() && present(command, "retrace") && command.get("retrace").getAsBoolean()) {
			throw invalidField("fightThrough does not apply to retrace:true");
		}
		if (present(command, FIELD_TIMEOUT_MS)) requireDuration(command, FIELD_TIMEOUT_MS);
	}

	/** Exact observed target like attack; desiredRange, fleeAtHealth, continueWithAttackers and targetPolicy are optional. */
	private static void validateFightTarget(JsonObject command) throws ProtocolException {
		if (present(command, FIELD_PURSUE)) requireBoolean(command, FIELD_PURSUE);
		if (present(command, FIELD_SNEAK)) requireBoolean(command, FIELD_SNEAK);
		if (present(command, "shield")) requireBoolean(command, "shield");
		if (present(command, "collect")) requireBoolean(command, "collect");
		requireUuid(command, FIELD_TARGET_ID);
		validateUntilCount(command);
		if (present(command, FIELD_DESIRED_RANGE)) requireFiniteRange(command, FIELD_DESIRED_RANGE, 1.0D, 6.0D);
		if (present(command, FIELD_FLEE_AT_HEALTH)) requireFiniteRange(command, FIELD_FLEE_AT_HEALTH, 0.0D, 2048.0D);
		if (present(command, FIELD_CONTINUE_WITH_ATTACKERS)) requireBoolean(command, FIELD_CONTINUE_WITH_ATTACKERS);
		if (present(command, FIELD_INCLUDE_PLAYERS)) requireBoolean(command, FIELD_INCLUDE_PLAYERS);
		if (present(command, FIELD_TARGET_POLICY) && !TARGET_POLICIES.contains(requireString(command, FIELD_TARGET_POLICY))) {
			throw invalidField("Field 'targetPolicy' must be named, highest_risk or nearest_attacker");
		}
		requireDuration(command, FIELD_TIMEOUT_MS);
	}

	private static void validateFleeFrom(JsonObject command) throws ProtocolException {
		requireUuid(command, FIELD_TARGET_ID);
		requireFiniteRange(command, FIELD_DISTANCE, 1.0D, 64.0D);
		requireDuration(command, FIELD_TIMEOUT_MS);
	}

	private static void validateRangedTargetAction(JsonObject command) throws ProtocolException {
		requireBoundedText(
				command,
				FIELD_TARGET_SELECTOR,
				ProtocolConstants.MAX_TARGET_SELECTOR_LENGTH,
				false
		);
		requireFiniteRange(command, FIELD_DISTANCE, 1.0D, 64.0D);
		requireDuration(command, FIELD_TIMEOUT_MS);
	}

	private static void validateBreakBlock(JsonObject command) throws ProtocolException {
		validateCoordinates(command, true);
		requireDuration(command, FIELD_TIMEOUT_MS);
		// Kept nullable at the wire boundary for legacy callers; the server executor
		// rejects a missing value before announcing or attempting the break.
		if (command.has(FIELD_EXPECTED_BLOCK_ID) && !command.get(FIELD_EXPECTED_BLOCK_ID).isJsonNull()) {
			requireIdentifier(command, FIELD_EXPECTED_BLOCK_ID);
		}
		if (present(command, FIELD_ACCEPT_LAVA_RISK)) requireBoolean(command, FIELD_ACCEPT_LAVA_RISK);
	}

	private static void validatePlaceBlock(JsonObject command) throws ProtocolException {
		validateCoordinates(command, true);
		String face = requireString(command, FIELD_FACE);
		if (!BLOCK_FACES.contains(face)) {
			throw invalidField(
					"Field '" + FIELD_FACE + "' must be one of " + String.join(", ", BLOCK_FACES)
			);
		}
		if (present(command, FIELD_FACE_MODE)) requireOneOf(command, FIELD_FACE_MODE, List.of("preferred", "strict"));
		requireIdentifier(command, FIELD_ITEM_ID);
		JsonElement desiredState = command.get(FIELD_DESIRED_STATE);
		if (desiredState != null && !desiredState.isJsonNull()) {
			requireBoundedText(command, FIELD_DESIRED_STATE, MAX_DESIRED_STATE_LENGTH, false);
		}
	}

	private static void validateBuildSequence(JsonObject command) throws ProtocolException {
		JsonElement placements = requireField(command, FIELD_PLACEMENTS);
		if (!placements.isJsonArray()) throw invalidField("Field 'placements' must be an array");
		int size = placements.getAsJsonArray().size();
		if (size < 1 || size > MAX_BUILD_SEQUENCE_PLACEMENTS) {
			throw outOfRange(FIELD_PLACEMENTS, "an array containing 1 to " + MAX_BUILD_SEQUENCE_PLACEMENTS + " entries");
		}
		for (int index = 0; index < size; index++) {
			JsonElement entry = placements.getAsJsonArray().get(index);
			if (!entry.isJsonObject()) throw invalidField("placements[" + index + "] must be an object");
			JsonObject placement = entry.getAsJsonObject();
			validatePlaceBlock(placement);
			validateKnownArgumentFields(placement, ActionType.PLACE_BLOCK);
		}
		requireDuration(command, FIELD_TIMEOUT_MS);
	}

	private static void validateCoordinates(JsonObject command, boolean integral) throws ProtocolException {
		for (String field : List.of(FIELD_X, FIELD_Y, FIELD_Z)) {
			if (integral) {
				requireIntegralBlockCoordinate(command, field);
			} else {
				requireFiniteNumber(command, field);
			}
		}
	}

	private static void validateDropItem(JsonObject arguments) throws ProtocolException {
		long slot = requireIntegralLong(arguments, FIELD_SLOT);
		long count = requireIntegralLong(arguments, FIELD_COUNT);
		if (slot < 0L || slot > 35L) throw invalidField("Field 'slot' must be between 0 and 35");
		if (count < 1L || count > 64L) throw invalidField("Field 'count' must be between 1 and 64");
	}

	private static void validateTransferContainer(JsonObject arguments) throws ProtocolException {
		validateCoordinates(arguments, true);
		requireOneOf(arguments, FIELD_SOURCE_KIND, List.of("player", "container"));
		requireNonnegativeInt(arguments, FIELD_SOURCE_SLOT);
		requireOneOf(arguments, FIELD_DESTINATION_KIND, List.of("player", "container"));
		requireNonnegativeInt(arguments, FIELD_DESTINATION_SLOT);
		requireStackCount(arguments);
		requireIdentifier(arguments, FIELD_EXPECTED_ITEM_ID);
		requireDuration(arguments, FIELD_TIMEOUT_MS);
	}

	private static void validateCraftInventory(JsonObject arguments) throws ProtocolException {
		requireIdentifier(arguments, FIELD_RECIPE_ID);
		requireStackCount(arguments);
		requireDuration(arguments, FIELD_TIMEOUT_MS);
	}

	private static void validateCraftTable(JsonObject arguments) throws ProtocolException {
		requireIdentifier(arguments, FIELD_RECIPE_ID);
		validateCoordinates(arguments, true);
		requireStackCount(arguments);
		requireDuration(arguments, FIELD_TIMEOUT_MS);
	}

	private static void validateFurnaceTransaction(JsonObject arguments) throws ProtocolException {
		validateCoordinates(arguments, true);
		requireOneOf(arguments, FIELD_OPERATION, List.of("load", "insert_input", "insert_fuel", "take_output"));
		String operation = arguments.get(FIELD_OPERATION).getAsString();
		if (!operation.equals("take_output") || arguments.has(FIELD_INVENTORY_SLOT)) {
			requireInventorySlot(arguments, FIELD_INVENTORY_SLOT);
			requireStackCount(arguments);
			requireIdentifier(arguments, FIELD_EXPECTED_ITEM_ID);
		} else if (arguments.has(FIELD_COUNT) || arguments.has(FIELD_EXPECTED_ITEM_ID)) {
			throw invalidField("take_output needs all stack fields together, or none to take all output");
		}
		if (operation.equals("load")) {
			requireInventorySlot(arguments, "fuelSlot");
			requireIntegralRange(arguments, "fuelCount", 1, 64);
			requireIdentifier(arguments, "expectedFuelItemId");
			if (arguments.get("fuelSlot").getAsInt() == arguments.get(FIELD_INVENTORY_SLOT).getAsInt()) {
				throw invalidField("Input and fuel must use different inventory slots");
			}
		} else if (arguments.has("fuelSlot") || arguments.has("fuelCount") || arguments.has("expectedFuelItemId")) {
			throw invalidField("Fuel fields require operation load");
		}
		requireDuration(arguments, FIELD_TIMEOUT_MS);
	}

	private static void validateEquipItem(JsonObject arguments) throws ProtocolException {
		requireInventorySlot(arguments, FIELD_SOURCE_SLOT);
		requireOneOf(arguments, FIELD_TARGET_SLOT, List.of("head", "chest", "legs", "feet", "offhand"));
		requireIdentifier(arguments, FIELD_EXPECTED_ITEM_ID);
	}

	private static void validateSelectTool(JsonObject arguments) throws ProtocolException {
		requireInventorySlot(arguments, FIELD_SOURCE_SLOT);
		requireIntegralRange(arguments, FIELD_HOTBAR_SLOT, 0L, 8L);
		requireIdentifier(arguments, FIELD_EXPECTED_ITEM_ID);
		requireNonnegativeInt(arguments, FIELD_MIN_REMAINING_DURABILITY);
	}

	private static void validateUseRanged(JsonObject arguments) throws ProtocolException {
		requireUuid(arguments, FIELD_TARGET_ID);
		requireDuration(arguments, FIELD_DRAW_DURATION_MS);
		boolean untilDead = arguments.has("untilDead") && requireBoolean(arguments, "untilDead");
		// untilItem+untilCount runs the fight_until engine with the bow; its timeout is the skill's (default 180 s, max 600 s).
		if (validateUntilCount(arguments)) {
			if (arguments.has(FIELD_TIMEOUT_MS)) requireDuration(arguments, FIELD_TIMEOUT_MS);
			if (arguments.has(FIELD_FLEE_AT_HEALTH)) requireFiniteRange(arguments, FIELD_FLEE_AT_HEALTH, 0.0D, 2048.0D);
			if (arguments.has("collect")) requireBoolean(arguments, "collect");
		// untilDead keeps shooting one target; its timeout defaults to 20 s and is capped at 60 s.
		} else if (untilDead) {
			if (arguments.has(FIELD_TIMEOUT_MS)) requireIntegralRange(arguments, FIELD_TIMEOUT_MS, ProtocolConstants.MIN_DURATION_MS, 60_000L);
			if (arguments.has(FIELD_FLEE_AT_HEALTH)) requireFiniteRange(arguments, FIELD_FLEE_AT_HEALTH, 0.0D, 2048.0D);
			if (arguments.has("collect")) requireBoolean(arguments, "collect");
		} else {
			requireDuration(arguments, FIELD_TIMEOUT_MS);
			for (String field : List.of("collect", FIELD_FLEE_AT_HEALTH)) {
				if (arguments.has(field)) throw new ProtocolException("INVALID_FIELD", "Field '" + field + "' applies only with untilDead:true");
			}
		}
		if (arguments.has("trackTarget")) requireBoolean(arguments, "trackTarget");
		if (arguments.has("aimX") || arguments.has("aimY") || arguments.has("aimZ")) {
			for (String field : List.of("aimX", "aimY", "aimZ")) requireFiniteRange(arguments, field, -30_000_000, 30_000_000);
			if (arguments.has("trackTarget") && arguments.get("trackTarget").getAsBoolean()) {
				throw new ProtocolException("INVALID_FIELD", "Fixed aim and target tracking are mutually exclusive");
			}
		}
	}

	private static long requireStackCount(JsonObject arguments) throws ProtocolException {
		return requireIntegralRange(arguments, FIELD_COUNT, 1L, 64L);
	}

	private static long requireInventorySlot(JsonObject arguments, String field) throws ProtocolException {
		return requireIntegralRange(arguments, field, 0L, 35L);
	}

	private static long requireNonnegativeInt(JsonObject arguments, String field) throws ProtocolException {
		return requireIntegralRange(arguments, field, 0L, Integer.MAX_VALUE);
	}

	/**
	 * fight_target and use_ranged count mode: untilItem and untilCount come together (the fight_until engine then runs
	 * with the named target first); roof (enderman only, checked at run time) needs the count. True in count mode.
	 */
	private static boolean validateUntilCount(JsonObject command) throws ProtocolException {
		boolean item = present(command, "untilItem"), count = present(command, "untilCount");
		if (item != count) throw invalidField("untilItem and untilCount go together");
		if (present(command, "roof")) {
			requireBoolean(command, "roof");
			if (!item) throw invalidField("Field 'roof' applies only with untilItem and untilCount");
		}
		if (!item) return false;
		requireIdentifier(command, "untilItem");
		requireIntegralRange(command, "untilCount", 1L, 2_304L);
		return true;
	}

	/** A mob type and an item count; weapon, collect, fleeAtHealth, spot x/y/z, radius, roof and timeoutMs are optional. */
	private static void validateFightUntil(JsonObject command) throws ProtocolException {
		requireIdentifier(command, "mob");
		requireIdentifier(command, "untilItem");
		requireIntegralRange(command, "untilCount", 1L, 2_304L);
		if (present(command, "weapon")) requireOneOf(command, "weapon", List.of("auto", "bow", "sword"));
		if (present(command, "collect")) requireBoolean(command, "collect");
		if (present(command, FIELD_FLEE_AT_HEALTH)) requireFiniteRange(command, FIELD_FLEE_AT_HEALTH, 0.0D, 2048.0D);
		boolean spot = present(command, FIELD_X) || present(command, FIELD_Y) || present(command, FIELD_Z);
		if (spot) {
			requireFiniteNumber(command, FIELD_X);
			requireFiniteNumber(command, FIELD_Y);
			requireFiniteNumber(command, FIELD_Z);
		}
		if (present(command, "radius")) requireFiniteRange(command, "radius", 2.0D, 48.0D);
		if (present(command, "roof")) requireBoolean(command, "roof");
		if (present(command, FIELD_TIMEOUT_MS)) requireDuration(command, FIELD_TIMEOUT_MS);
	}

	private static long requireIntegralRange(JsonObject arguments, String field, long minimum, long maximum)
			throws ProtocolException {
		long value = requireIntegralLong(arguments, field);
		if (value < minimum || value > maximum) throw outOfRange(field, minimum + " to " + maximum);
		return value;
	}

	private static String requireOneOf(JsonObject arguments, String field, List<String> allowed)
			throws ProtocolException {
		String value = requireString(arguments, field);
		if (!allowed.contains(value)) {
			throw invalidField("Field '" + field + "' must be one of " + String.join(", ", allowed));
		}
		return value;
	}

	private static double requireFiniteRange(
			JsonObject object,
			String field,
			double minimum,
			double maximum
	) throws ProtocolException {
		double value = requireFiniteNumber(object, field);
		if (value < minimum || value > maximum) {
			throw outOfRange(field, minimum + " to " + maximum);
		}
		return value;
	}

	private static int requireIntegralBlockCoordinate(JsonObject object, String field) throws ProtocolException {
		JsonPrimitive primitive = requireNumber(object, field);
		requireFiniteNumber(primitive, field);
		try {
			return new BigDecimal(primitive.getAsString()).intValueExact();
		} catch (ArithmeticException | NumberFormatException exception) {
			throw outOfRange(field, "an integral 32-bit block coordinate");
		}
	}

	private static String requireIdentifier(JsonObject command, String field) throws ProtocolException {
		return requireBoundedText(command, field, ProtocolConstants.MAX_IDENTIFIER_LENGTH, false);
	}

	private static String requireUuid(JsonObject object, String field) throws ProtocolException {
		String value = requireBoundedText(object, field, 36, false);
		try {
			UUID parsed = UUID.fromString(value);
			if (!parsed.toString().equalsIgnoreCase(value)) throw new IllegalArgumentException();
			return value;
		} catch (IllegalArgumentException exception) {
			throw invalidField("Field '" + field + "' must be a canonical UUID");
		}
	}

	private static long requireDuration(JsonObject command, String field) throws ProtocolException {
		long duration = requireIntegralLong(command, field);
		if (duration < ProtocolConstants.MIN_DURATION_MS || duration > ProtocolConstants.MAX_DURATION_MS) {
			throw outOfRange(
					field,
					ProtocolConstants.MIN_DURATION_MS + " to " + ProtocolConstants.MAX_DURATION_MS + " milliseconds"
			);
		}
		return duration;
	}

	private static long requirePositiveLong(JsonObject object, String field) throws ProtocolException {
		long value = requireIntegralLong(object, field);
		if (value <= 0L) {
			throw outOfRange(field, "a positive integer");
		}
		return value;
	}

	private static long requireIntegralLong(JsonObject object, String field) throws ProtocolException {
		JsonPrimitive primitive = requireNumber(object, field);
		try {
			return new BigDecimal(primitive.getAsString()).longValueExact();
		} catch (ArithmeticException | NumberFormatException exception) {
			throw outOfRange(field, "a 64-bit integer");
		}
	}

	private static double requireFiniteNumber(JsonObject object, String field) throws ProtocolException {
		JsonPrimitive primitive = requireNumber(object, field);
		return requireFiniteNumber(primitive, field);
	}

	private static double requireFiniteNumber(JsonPrimitive primitive, String field) throws ProtocolException {
		double value;
		try {
			value = primitive.getAsDouble();
		} catch (NumberFormatException exception) {
			throw invalidField("Field '" + field + "' must be a number");
		}
		if (!Double.isFinite(value)) {
			throw outOfRange(field, "a finite number");
		}
		return value;
	}

	private static JsonPrimitive requireNumber(JsonObject object, String field) throws ProtocolException {
		JsonElement element = requireField(object, field);
		if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isNumber()) {
			throw invalidField("Field '" + field + "' must be a number");
		}
		return element.getAsJsonPrimitive();
	}

	private static boolean requireBoolean(JsonObject object, String field) throws ProtocolException {
		JsonElement element = requireField(object, field);
		if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isBoolean()) {
			throw invalidField("Field '" + field + "' must be a boolean");
		}
		return element.getAsBoolean();
	}

	private static String requireBoundedText(
			JsonObject object,
			String field,
			int maximumLength,
			boolean emptyAllowed
	) throws ProtocolException {
		String value = requireString(object, field);
		if (!emptyAllowed && isProtocolBlank(value)) {
			throw invalidField("Field '" + field + "' must not be blank");
		}
		if (value.length() > maximumLength) {
			throw outOfRange(field, "at most " + maximumLength + " characters");
		}
		return value;
	}

	private static void validateInteractBlock(JsonObject arguments) throws ProtocolException {
		validateHitOffsets(arguments, 0, 1);
		validateCoordinates(arguments, true);
		requireOneOf(arguments, FIELD_FACE, BLOCK_FACES);
		requireOneOf(arguments, FIELD_HAND, List.of("main", "off"));
		requireIdentifier(arguments, FIELD_EXPECTED_ITEM_ID);
		if (present(arguments, FIELD_ACCEPT_LAVA_RISK)) requireBoolean(arguments, FIELD_ACCEPT_LAVA_RISK);
	}

	private static void validateInteractEntity(JsonObject arguments) throws ProtocolException {
		validateHitOffsets(arguments, -16, 16);
		requireUuid(arguments, FIELD_TARGET_ID);
		requireOneOf(arguments, FIELD_HAND, List.of("main", "off"));
		requireIdentifier(arguments, FIELD_EXPECTED_ITEM_ID);
	}

	private static void validateMenuTransfer(JsonObject arguments) throws ProtocolException {
		validateOptionalMenuSession(arguments);
		requireIdentifier(arguments, FIELD_MENU_ID);
		requireIntegralRange(arguments, FIELD_SOURCE_SLOT, 0, 255);
		requireIntegralRange(arguments, FIELD_DESTINATION_SLOT, 0, 255);
		requireIntegralRange(arguments, FIELD_COUNT, 1, 64);
		requireIdentifier(arguments, FIELD_EXPECTED_ITEM_ID);
		requireDuration(arguments, FIELD_TIMEOUT_MS);
	}

	private static void validateMenuButton(JsonObject arguments) throws ProtocolException {
		validateOptionalMenuSession(arguments);
		requireIdentifier(arguments, FIELD_MENU_ID);
		requireIntegralRange(arguments, FIELD_BUTTON_ID, 0, 255);
		requireDuration(arguments, FIELD_TIMEOUT_MS);
	}

	private static void validateAnvilRename(JsonObject arguments) throws ProtocolException {
		validateOptionalMenuSession(arguments);
		requireIdentifier(arguments, FIELD_MENU_ID);
		requireBoundedText(arguments, FIELD_NAME, 50, false);
		requireDuration(arguments, FIELD_TIMEOUT_MS);
	}

	private static void validateOptionalMenuSession(JsonObject arguments) throws ProtocolException {
		if (present(arguments, "containerId") != present(arguments, "stateId")) {
			throw invalidField("containerId and stateId must be supplied together");
		}
		if (present(arguments, "containerId")) {
			requireIntegralRange(arguments, "containerId", 0, Integer.MAX_VALUE);
			requireIntegralRange(arguments, "stateId", 0, Integer.MAX_VALUE);
		}
	}

	private static String requireBoundedCodePointText(JsonObject object, String field, int maximumLength)
			throws ProtocolException {
		String value = requireString(object, field);
		if (isProtocolBlank(value)) throw invalidField("Field '" + field + "' must not be blank");
		if (value.codePointCount(0, value.length()) > maximumLength) {
			throw outOfRange(field, "at most " + maximumLength + " code points");
		}
		return value;
	}

	private static boolean isProtocolBlank(String value) {
		return value.codePoints().allMatch(ProtocolCodec::isProtocolWhitespace);
	}

	private static boolean isProtocolWhitespace(int codePoint) {
		return (codePoint >= 0x0009 && codePoint <= 0x000d)
				|| (codePoint >= 0x001c && codePoint <= 0x0020)
				|| codePoint == 0x00a0
				|| codePoint == 0x1680
				|| (codePoint >= 0x2000 && codePoint <= 0x200a)
				|| codePoint == 0x2028
				|| codePoint == 0x2029
				|| codePoint == 0x202f
				|| codePoint == 0x205f
				|| codePoint == 0x3000
				|| codePoint == 0xfeff;
	}

	private static String requireString(JsonObject object, String field) throws ProtocolException {
		JsonElement element = requireField(object, field);
		if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
			throw invalidField("Field '" + field + "' must be a string");
		}
		return element.getAsString();
	}

	private static JsonElement requireField(JsonObject object, String field) throws ProtocolException {
		if (!object.has(field) || object.get(field).isJsonNull()) {
			throw new ProtocolException(
					ProtocolConstants.ERROR_MISSING_FIELD,
					"Required field '" + field + "' is missing"
			);
		}
		return object.get(field);
	}

	private static void validateKnownFields(JsonObject command, ActionType actionType) throws ProtocolException {
		Set<String> allowedFields = new HashSet<>(ENVELOPE_FIELDS);
		allowedFields.addAll(ACTION_FIELDS.get(actionType));
		for (String field : command.keySet()) {
			if (!allowedFields.contains(field)) {
				throw unknownField(field, actionType);
			}
		}
	}

	private static void validateKnownArgumentFields(JsonObject arguments, ActionType actionType)
			throws ProtocolException {
		List<String> allowedFields = ACTION_FIELDS.get(actionType);
		for (String field : arguments.keySet()) {
			if (!allowedFields.contains(field)) {
				throw unknownField(field, actionType);
			}
		}
	}

	private static ProtocolException unknownField(String field, ActionType actionType) {
		return new ProtocolException(
				ProtocolConstants.ERROR_UNKNOWN_FIELD,
				"Unknown field '" + field + "' for action '" + actionType.wireName() + "'"
		);
	}

	private static ProtocolException invalidField(String message) {
		return new ProtocolException(ProtocolConstants.ERROR_INVALID_FIELD, message);
	}

	private static ProtocolException outOfRange(String field, String expectedRange) {
		return new ProtocolException(
				ProtocolConstants.ERROR_OUT_OF_RANGE,
				"Field '" + field + "' must be " + expectedRange
		);
	}

	private static ProtocolException malformedJson(String message, Throwable cause) {
		return new ProtocolException(ProtocolConstants.ERROR_MALFORMED_JSON, message, cause);
	}

	private static Map<ActionType, List<String>> createActionFields() {
		Map<ActionType, List<String>> fields = new EnumMap<>(ActionType.class);
		fields.put(ActionType.MOVE_TO, List.of(FIELD_X, FIELD_Y, FIELD_Z, FIELD_TOLERANCE, FIELD_SPRINT));
		fields.put(ActionType.CONTROL, List.of(
				FIELD_FORWARD, FIELD_STRAFE, FIELD_JUMP, FIELD_SNEAK, FIELD_SPRINT,
				FIELD_ATTACK, FIELD_USE, FIELD_YAW, FIELD_PITCH, FIELD_SELECTED_SLOT, FIELD_HAND, FIELD_TICKS,
				FIELD_INSTANT_LOOK
		));
		fields.put(ActionType.LOOK_AT, List.of(FIELD_X, FIELD_Y, FIELD_Z));
		fields.put(ActionType.ATTACK, List.of(FIELD_TARGET_ID, FIELD_TIMEOUT_MS));
		fields.put(ActionType.SELECT_ITEM, List.of(FIELD_ITEM_ID));
		fields.put(ActionType.USE_ITEM, List.of(FIELD_DURATION_MS, FIELD_HAND, FIELD_EXPECTED_ITEM_ID, "mode", "aimX", "aimY", "aimZ", FIELD_ACCEPT_LAVA_RISK));
		fields.put(ActionType.CONTROL_SEQUENCE, List.of("frames", "maxTicks"));
		fields.put(ActionType.BREAK_BLOCK, List.of(FIELD_X, FIELD_Y, FIELD_Z, FIELD_TIMEOUT_MS, FIELD_EXPECTED_BLOCK_ID, FIELD_ACCEPT_LAVA_RISK));
		fields.put(ActionType.PLACE_BLOCK, List.of(FIELD_X, FIELD_Y, FIELD_Z, FIELD_FACE, FIELD_ITEM_ID, FIELD_DESIRED_STATE, FIELD_FACE_MODE));
		fields.put(ActionType.BUILD_SEQUENCE, List.of(FIELD_PLACEMENTS, FIELD_TIMEOUT_MS));
		fields.put(ActionType.CHAT, List.of(FIELD_MESSAGE, FIELD_AUDIENCE, FIELD_RECIPIENT_ID));
		fields.put(ActionType.WAIT, List.of(FIELD_DURATION_MS));
		fields.put(ActionType.SET_DOOR, List.of(FIELD_X, FIELD_Y, FIELD_Z, FIELD_OPEN));
		fields.put(ActionType.PICK_UP_ITEM, List.of(FIELD_TARGET_SELECTOR));
		fields.put(ActionType.DROP_ITEM, List.of(FIELD_SLOT, FIELD_COUNT));
		fields.put(ActionType.NAVIGATE_TO, List.of(
				FIELD_X, FIELD_Y, FIELD_Z, FIELD_TOLERANCE, FIELD_SPRINT, FIELD_TIMEOUT_MS
		));
		fields.put(ActionType.CAST_OBSIDIAN, List.of(FIELD_X, FIELD_Y, FIELD_Z, "axis", "frame", FIELD_COUNT, FIELD_TIMEOUT_MS));
		fields.put(ActionType.BARTER_UNTIL, List.of(FIELD_ITEM_ID, FIELD_COUNT, FIELD_TIMEOUT_MS));
		fields.put(ActionType.BUILD_SHELTER, List.of(FIELD_X, FIELD_Y, FIELD_Z, "opening", FIELD_ITEM_ID, "roof", FIELD_TIMEOUT_MS));
		fields.put(ActionType.DIG_TO, List.of("pattern", FIELD_Y, FIELD_X, FIELD_Z, "heading", "maxBlocks", "throughCaves", "maxShaftY", "stopWhenSeen", FIELD_TIMEOUT_MS));
		fields.put(ActionType.TRAVEL_TO, List.of(
				FIELD_X, FIELD_Y, FIELD_Z, FIELD_YAW, FIELD_DISTANCE, FIELD_TOLERANCE, "build", "retrace", "dimension", "stopWhenSeen", "minHealth", "fightThrough", FIELD_TIMEOUT_MS
		));
		fields.put(ActionType.FIGHT_TARGET, List.of(
				FIELD_TARGET_ID, FIELD_DESIRED_RANGE, FIELD_FLEE_AT_HEALTH, FIELD_CONTINUE_WITH_ATTACKERS, FIELD_TARGET_POLICY, FIELD_INCLUDE_PLAYERS, FIELD_PURSUE, FIELD_SNEAK, "shield", "collect", "untilItem", "untilCount", "roof", FIELD_TIMEOUT_MS
		));
		fields.put(ActionType.FIGHT_UNTIL, List.of(
				"mob", "untilItem", "untilCount", "weapon", "collect", FIELD_FLEE_AT_HEALTH, FIELD_X, FIELD_Y, FIELD_Z, "radius", "roof", FIELD_TIMEOUT_MS
		));
		fields.put(ActionType.FLEE_FROM, List.of(FIELD_TARGET_ID, FIELD_DISTANCE, FIELD_TIMEOUT_MS));
		fields.put(ActionType.FOLLOW_ENTITY, List.of(FIELD_TARGET_SELECTOR, FIELD_DISTANCE, FIELD_TIMEOUT_MS));
		fields.put(ActionType.TRANSFER_CONTAINER, List.of(
				FIELD_X, FIELD_Y, FIELD_Z, FIELD_SOURCE_KIND, FIELD_SOURCE_SLOT,
				FIELD_DESTINATION_KIND, FIELD_DESTINATION_SLOT, FIELD_COUNT, FIELD_EXPECTED_ITEM_ID, FIELD_TIMEOUT_MS
		));
		fields.put(ActionType.CRAFT_INVENTORY, List.of(FIELD_RECIPE_ID, FIELD_COUNT, FIELD_TIMEOUT_MS));
		fields.put(ActionType.CRAFT_TABLE, List.of(
				FIELD_RECIPE_ID, FIELD_X, FIELD_Y, FIELD_Z, FIELD_COUNT, FIELD_TIMEOUT_MS
		));
		fields.put(ActionType.FURNACE_TRANSACTION, List.of(
				FIELD_X, FIELD_Y, FIELD_Z, FIELD_OPERATION, FIELD_INVENTORY_SLOT,
				FIELD_COUNT, FIELD_EXPECTED_ITEM_ID, "fuelSlot", "fuelCount", "expectedFuelItemId", FIELD_TIMEOUT_MS
		));
		fields.put(ActionType.EQUIP_ITEM, List.of(FIELD_SOURCE_SLOT, FIELD_TARGET_SLOT, FIELD_EXPECTED_ITEM_ID));
		fields.put(ActionType.SELECT_TOOL, List.of(
				FIELD_SOURCE_SLOT, FIELD_HOTBAR_SLOT, FIELD_EXPECTED_ITEM_ID, FIELD_MIN_REMAINING_DURABILITY
		));
		fields.put(ActionType.BLOCK_WITH_SHIELD, List.of(FIELD_DURATION_MS));
		fields.put(ActionType.USE_RANGED, List.of(FIELD_TARGET_ID, FIELD_DRAW_DURATION_MS, FIELD_TIMEOUT_MS, "aimX", "aimY", "aimZ", "trackTarget", "untilDead", FIELD_FLEE_AT_HEALTH, "collect", "untilItem", "untilCount"));
		fields.put(ActionType.INTERACT_BLOCK, List.of(
				FIELD_X, FIELD_Y, FIELD_Z, FIELD_FACE, FIELD_HAND, FIELD_EXPECTED_ITEM_ID, "hitX", "hitY", "hitZ", FIELD_ACCEPT_LAVA_RISK
		));
		fields.put(ActionType.INTERACT_ENTITY, List.of(FIELD_TARGET_ID, FIELD_HAND, FIELD_EXPECTED_ITEM_ID, "hitX", "hitY", "hitZ"));
		fields.put(ActionType.DISMOUNT, List.of());
		fields.put(ActionType.START_FALL_FLYING, List.of());
		fields.put(ActionType.WAKE_UP, List.of());
		fields.put(ActionType.SET_FLIGHT, List.of("enabled"));
		fields.put(ActionType.WRITE_SIGN, List.of("x", "y", "z", "front", "lines", "expectedLines"));
		fields.put(ActionType.EDIT_BOOK, List.of("slot", "pages", "title", "expectedFingerprint"));
		fields.put(ActionType.MENU_CLICK, List.of(FIELD_MENU_ID, "containerId", "stateId", "slot", "button", "clickType", FIELD_EXPECTED_ITEM_ID, "expectedCount", "expectedFingerprint"));
		fields.put(ActionType.MENU_CLOSE, List.of(FIELD_MENU_ID, "containerId", "stateId"));
		fields.put(ActionType.BEACON_EFFECTS, List.of(FIELD_MENU_ID, "containerId", "stateId", "primaryEffectId", "secondaryEffectId"));
		fields.put(ActionType.MENU_TRANSFER, List.of(
				FIELD_MENU_ID, FIELD_SOURCE_SLOT, FIELD_DESTINATION_SLOT,
				FIELD_COUNT, FIELD_EXPECTED_ITEM_ID, FIELD_TIMEOUT_MS, "containerId", "stateId"
		));
		fields.put(ActionType.MENU_BUTTON, List.of(FIELD_MENU_ID, FIELD_BUTTON_ID, FIELD_TIMEOUT_MS, "containerId", "stateId"));
		fields.put(ActionType.ANVIL_RENAME, List.of(FIELD_MENU_ID, FIELD_NAME, FIELD_TIMEOUT_MS, "containerId", "stateId"));
		fields.put(ActionType.RESPAWN, List.of());
		fields.put(ActionType.COMPLETE_GOAL, List.of(FIELD_SUMMARY));
		return Map.copyOf(fields);
	}
}
