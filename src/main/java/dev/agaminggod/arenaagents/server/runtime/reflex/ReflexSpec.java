package dev.agaminggod.arenaagents.server.runtime.reflex;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Model-authored reflex rules in their canonical wire form (the coordinator normalizes the model's input into this).
 * Pure data and validation, no Minecraft state, so the rules verify without a server. The condition and action
 * vocabularies are tables: a new condition or action registers its parameters here and its behaviour in
 * {@link ReflexSensors} / {@link ReflexActions}.
 */
public final class ReflexSpec {
	/** The model's own 12 rules plus the coordinator's 4 default survival rules (Lucas, Oct 28 ruling 16). */
	public static final int MAX_RULES = 16;
	public static final int MAX_CONDITIONS = 4;
	public static final int MAX_IDS = 8;
	public static final int MIN_PRIORITY = 1;
	public static final int MAX_PRIORITY = 9;
	public static final long MIN_MAX_MS = 250L;
	public static final long MAX_MAX_MS = 20_000L;
	public static final long MAX_SHIELD_STANCE_MS = 600_000L;
	public static final long DEFAULT_TRIGGER_MAX_MS = 4_000L;
	public static final long DEFAULT_STANCE_MAX_MS = 10_000L;
	public static final long MIN_COOLDOWN_MS = 250L;
	public static final long MAX_COOLDOWN_MS = 60_000L;
	public static final long DEFAULT_COOLDOWN_MS = 500L;
	public static final long MAX_TTL_MS = 3_600_000L;
	public static final long DEFAULT_TTL_MS = 600_000L;
	public static final int MAX_FIRINGS_LIMIT = 1_000;
	private static final Pattern RULE_ID = Pattern.compile("[A-Za-z0-9_-]{1,32}");
	private static final Pattern RESOURCE_ID = Pattern.compile("[a-z0-9_.-]+:[a-z0-9_./-]+");

	public enum Kind { TRIGGER, STANCE }

	public enum ParamKind { NUMBER, IDS, TOOL_KIND, ITEM_ID, PLACE_WHERE, CHOICE, BOOL, ENTITY_ID }

	/** {@code choices} lists the allowed words of a CHOICE parameter (empty for other kinds). */
	public record Param(String name, ParamKind kind, double min, double max, boolean required, List<String> choices) {
		public Param {
			Objects.requireNonNull(name, "name must not be null");
			Objects.requireNonNull(kind, "kind must not be null");
			choices = List.copyOf(choices);
		}

		public Param(String name, ParamKind kind, double min, double max, boolean required) {
			this(name, kind, min, max, required, List.of());
		}

		static Param choice(String name, String... choices) {
			return new Param(name, ParamKind.CHOICE, 0, 0, false, List.of(choices));
		}

		static Param flag(String name) {
			return new Param(name, ParamKind.BOOL, 0, 0, false);
		}
	}

	/** Directions relative to the body for edge sensing; {@code moving} is the direction the body is moving in. */
	public static final List<String> DIRECTIONS = List.of("ahead", "behind", "left", "right", "moving", "any");
	/** A cell coordinate parameter (blocks); reflex moves are short, the cap only keeps numbers sane. */
	private static final double COORDINATE = 30_000_000.0D;

	/** One vocabulary entry; {@code focus} conditions name the entity an action aims at. */
	public record Term(String type, List<Param> params, boolean focus) {
		public Term {
			Objects.requireNonNull(type, "type must not be null");
			params = List.copyOf(params);
		}
	}

	public static final Set<String> TOOL_KINDS = Set.of("pickaxe", "axe", "shovel", "hoe", "sword", "shield", "any");
	/** Where {@code place} puts the item: the cell under the feet, or the feet-level cell in front of the view. */
	public static final Set<String> PLACE_WHERE = Set.of("below", "ahead", "feet");

	private static final Map<String, Term> CONDITIONS = new LinkedHashMap<>();
	private static final Map<String, Term> ACTIONS = new LinkedHashMap<>();

	static {
		condition("incoming_projectile", true, new Param("withinS", ParamKind.NUMBER, 0.05D, 2.0D, false),
				new Param("projectiles", ParamKind.IDS, 0, 0, false));
		condition("hostile_near", true, new Param("within", ParamKind.NUMBER, 1.0D, 32.0D, true),
				new Param("mobs", ParamKind.IDS, 0, 0, false), new Param("targetId", ParamKind.ENTITY_ID, 0, 0, false));
		condition("target_in_reach", true, new Param("mobs", ParamKind.IDS, 0, 0, false));
		condition("health_below", false, new Param("value", ParamKind.NUMBER, 1.0D, 40.0D, true));
		condition("air_below", false, new Param("bubbles", ParamKind.NUMBER, 1.0D, 10.0D, true));
		condition("hunger_below", false, new Param("value", ParamKind.NUMBER, 1.0D, 20.0D, true));
		condition("tool_broke", false, new Param("tool", ParamKind.TOOL_KIND, 0, 0, false));
		condition("on_fire", false);
		condition("in_lava", false);
		// The body overlaps a fire block (flames at the feet), which re-ignites it every tick; on_fire alone also holds after.
		condition("in_fire", false);
		condition("on_hot_floor", false);
		// Work interruptions: the inventory grid, items lying in view, the durability bar, the fall, the hunger bar's
		// jitter (saturation gone), the sky, and the hotbar slot that just emptied.
		condition("inventory_full", false);
		condition("item_nearby", true, new Param("within", ParamKind.NUMBER, 1.0D, 8.0D, false),
				new Param("items", ParamKind.IDS, 0, 0, false));
		condition("tool_low", false, new Param("uses", ParamKind.NUMBER, 1.0D, 256.0D, true),
				new Param("tool", ParamKind.TOOL_KIND, 0, 0, false));
		condition("falling", false, new Param("blocks", ParamKind.NUMBER, 1.0D, 64.0D, true));
		condition("saturation_empty", false);
		condition("night", false);
		condition("stack_used_up", false, new Param("item", ParamKind.ITEM_ID, 0, 0, false));
		// Combat and hazard senses (rx-combat).
		condition("fireball_incoming", true, new Param("withinS", ParamKind.NUMBER, 0.05D, 3.0D, false), Param.flag("deflectable"));
		condition("creeper_fusing", true, new Param("within", ParamKind.NUMBER, 1.0D, 16.0D, false));
		condition("enderman_gaze", true, new Param("within", ParamKind.NUMBER, 1.0D, 64.0D, false));
		condition("enderman_provoked", true, new Param("within", ParamKind.NUMBER, 1.0D, 64.0D, false));
		condition("edge_near", true, new Param("within", ParamKind.NUMBER, 1.0D, 4.0D, false),
				Param.choice("direction", DIRECTIONS.toArray(String[]::new)), new Param("drop", ParamKind.NUMBER, 2.0D, 64.0D, false));
		condition("lava_near", true, new Param("within", ParamKind.NUMBER, 1.0D, 4.0D, false));
		// Seen lava whose spread (vanilla rules over the known cells) reaches the body's cells within withinS.
		condition("lava_flowing", true, new Param("withinS", ParamKind.NUMBER, 0.5D, 6.0D, false));
		condition("attacked_from_behind", true, new Param("within", ParamKind.NUMBER, 1.0D, 8.0D, false));
		condition("exposed", true, new Param("within", ParamKind.NUMBER, 1.0D, 48.0D, true), new Param("mobs", ParamKind.IDS, 0, 0, false));
		// End hazards (endgame): a dragon breath cloud you stand in or next to.
		condition("cloud_near", true, new Param("within", ParamKind.NUMBER, 0.0D, 4.0D, false));
		// The dragon seen flying at the body (its flight line passes within about 10 blocks in the next 3 s).
		condition("dragon_charging", true, new Param("within", ParamKind.NUMBER, 8.0D, 96.0D, false));
		// Digging (midgame): the head inside a solid block, as falling sand or gravel lands on it.
		condition("suffocating", false);
		action("shield", Param.flag("counter"));
		action("attack");
		action("step_back", new Param("blocks", ParamKind.NUMBER, 1.0D, 4.0D, false));
		action("eat");
		action("select", new Param("tool", ParamKind.TOOL_KIND, 0, 0, false), new Param("item", ParamKind.ITEM_ID, 0, 0, false));
		action("swim_up");
		action("pickup", new Param("within", ParamKind.NUMBER, 1.0D, 8.0D, false));
		action("place", new Param("item", ParamKind.ITEM_ID, 0, 0, true), new Param("where", ParamKind.PLACE_WHERE, 0, 0, true));
		action("stop");
		action("deflect");
		action("sprint_away", new Param("blocks", ParamKind.NUMBER, 2.0D, 24.0D, false));
		action("move_to_cell", new Param("x", ParamKind.NUMBER, -COORDINATE, COORDINATE, true),
				new Param("y", ParamKind.NUMBER, -2_048.0D, 2_048.0D, true), new Param("z", ParamKind.NUMBER, -COORDINATE, COORDINATE, true),
				Param.flag("sprint"));
		action("sneak");
		action("look_away");
		action("place_block", new Param("item", ParamKind.ITEM_ID, 0, 0, false), new Param("count", ParamKind.NUMBER, 1.0D, 2.0D, false));
		action("take_cover", new Param("within", ParamKind.NUMBER, 2.0D, 10.0D, false));
		action("away_from_edge", new Param("blocks", ParamKind.NUMBER, 2.0D, 12.0D, false));
		action("dig_out");
		action("leave_fire");
		action("leave_lava");
		action("brace");
	}

	private ReflexSpec() {
	}

	/** Registers a condition; its sensor is looked up by the same type in {@link ReflexSensors}. */
	public static synchronized void condition(String type, boolean focus, Param... params) {
		CONDITIONS.put(type, new Term(type, List.of(params), focus));
	}

	/** Registers an action; its behaviour is looked up by the same type in {@link ReflexActions}. */
	public static synchronized void action(String type, Param... params) {
		ACTIONS.put(type, new Term(type, List.of(params), false));
	}

	public static synchronized Set<String> conditionTypes() {
		return Set.copyOf(CONDITIONS.keySet());
	}

	public static synchronized Set<String> actionTypes() {
		return Set.copyOf(ACTIONS.keySet());
	}

	public record Condition(String type, boolean negated, JsonObject params) {
		public Condition {
			Objects.requireNonNull(type, "type must not be null");
			params = params == null ? new JsonObject() : params.deepCopy();
		}

		public double number(String name, double fallback) {
			return params.has(name) ? params.get(name).getAsDouble() : fallback;
		}

		public Set<String> ids(String name) {
			if (!params.has(name)) return Set.of();
			Set<String> ids = new LinkedHashSet<>();
			for (JsonElement element : params.getAsJsonArray(name)) ids.add(element.getAsString());
			return Set.copyOf(ids);
		}

		public String text(String name) {
			return params.has(name) ? params.get(name).getAsString() : null;
		}

		public boolean flag(String name) {
			return params.has(name) && params.get(name).getAsBoolean();
		}

		/** Whether this condition can supply the entity an action aims at (only when not negated). */
		public boolean focus() {
			Term term;
			synchronized (ReflexSpec.class) {
				term = CONDITIONS.get(type);
			}
			return !negated && term != null && term.focus();
		}
	}

	public record Action(String type, JsonObject params) {
		public Action {
			Objects.requireNonNull(type, "type must not be null");
			params = params == null ? new JsonObject() : params.deepCopy();
		}

		public double number(String name, double fallback) {
			return params.has(name) ? params.get(name).getAsDouble() : fallback;
		}

		public String text(String name) {
			return params.has(name) ? params.get(name).getAsString() : null;
		}

		public boolean flag(String name) {
			return params.has(name) && params.get(name).getAsBoolean();
		}
	}

	public record Rule(
			String id,
			Kind kind,
			int priority,
			List<Condition> when,
			Action action,
			List<Condition> until,
			long maxMs,
			long cooldownMs,
			long ttlMs,
			int maxFirings,
			boolean wake
	) {
		public Rule {
			Objects.requireNonNull(id, "id must not be null");
			Objects.requireNonNull(kind, "kind must not be null");
			when = List.copyOf(when);
			Objects.requireNonNull(action, "action must not be null");
			until = List.copyOf(until);
		}
	}

	public static final class InvalidRuleException extends IllegalArgumentException {
		private final String code;

		public InvalidRuleException(String code, String message) {
			super(message);
			this.code = code;
		}

		public String code() {
			return code;
		}
	}

	/** Parses a complete rule set (the coordinator always sends the whole set). */
	public static List<Rule> parseRules(JsonArray rules) {
		if (rules == null) throw invalid("rules must be an array");
		if (rules.size() > MAX_RULES) throw invalid("at most " + MAX_RULES + " reflex rules");
		List<Rule> parsed = new ArrayList<>(rules.size());
		Set<String> ids = new LinkedHashSet<>();
		for (int index = 0; index < rules.size(); index++) {
			JsonElement element = rules.get(index);
			if (!element.isJsonObject()) throw invalid("rules[" + index + "] must be an object");
			Rule rule = parseRule(element.getAsJsonObject(), "rules[" + index + "]");
			if (!ids.add(rule.id())) throw invalid("duplicate reflex id " + rule.id());
			parsed.add(rule);
		}
		return List.copyOf(parsed);
	}

	public static Rule parseRule(JsonObject value, String path) {
		requireKeys(value, path, Set.of("id", "kind", "priority", "when", "do", "until", "maxMs", "cooldownMs", "ttlMs", "maxFirings", "wake"));
		String id = string(value, "id", path);
		if (!RULE_ID.matcher(id).matches()) throw invalid(path + ".id must be 1..32 letters, digits, _ or -");
		String kindText = value.has("kind") ? string(value, "kind", path) : "trigger";
		Kind kind = switch (kindText) {
			case "trigger" -> Kind.TRIGGER;
			case "stance" -> Kind.STANCE;
			default -> throw invalid(path + ".kind must be trigger or stance");
		};
		int priority = (int) longValue(value, "priority", path, MIN_PRIORITY, MAX_PRIORITY, 5);
		if (!value.has("when")) throw invalid(path + ".when is required");
		List<Condition> when = conditions(value.get("when"), path + ".when");
		if (when.isEmpty()) throw invalid(path + ".when needs at least one condition");
		if (when.stream().allMatch(Condition::negated)) throw invalid(path + ".when needs at least one condition that is not negated");
		if (!value.has("do") || !value.get("do").isJsonObject()) throw invalid(path + ".do must be an action object");
		Action action = action(value.getAsJsonObject("do"), path + ".do");
		List<Condition> until = value.has("until") ? conditions(value.get("until"), path + ".until") : List.of();
		boolean shieldStance = kind == Kind.STANCE && "shield".equals(action.type());
		long maxMs = longValue(value, "maxMs", path, MIN_MAX_MS, shieldStance ? MAX_SHIELD_STANCE_MS : MAX_MAX_MS,
				shieldStance ? MAX_SHIELD_STANCE_MS : kind == Kind.STANCE ? DEFAULT_STANCE_MAX_MS : DEFAULT_TRIGGER_MAX_MS);
		long cooldownMs = longValue(value, "cooldownMs", path, MIN_COOLDOWN_MS, MAX_COOLDOWN_MS, DEFAULT_COOLDOWN_MS);
		long ttlMs = longValue(value, "ttlMs", path, 1_000L, MAX_TTL_MS, DEFAULT_TTL_MS);
		int maxFirings = (int) longValue(value, "maxFirings", path, 0, MAX_FIRINGS_LIMIT, 0);
		boolean wake = value.has("wake") && bool(value, "wake", path);
		return new Rule(id, kind, priority, when, action, until, maxMs, cooldownMs, ttlMs, maxFirings, wake);
	}

	private static List<Condition> conditions(JsonElement element, String path) {
		List<JsonObject> rows = new ArrayList<>();
		if (element.isJsonObject()) rows.add(element.getAsJsonObject());
		else if (element.isJsonArray()) {
			for (JsonElement row : element.getAsJsonArray()) {
				if (!row.isJsonObject()) throw invalid(path + " entries must be condition objects");
				rows.add(row.getAsJsonObject());
			}
		} else throw invalid(path + " must be a condition object or an array of them");
		if (rows.size() > MAX_CONDITIONS) throw invalid(path + " holds at most " + MAX_CONDITIONS + " conditions");
		List<Condition> parsed = new ArrayList<>(rows.size());
		for (int index = 0; index < rows.size(); index++) parsed.add(condition(rows.get(index), path + "[" + index + "]"));
		return List.copyOf(parsed);
	}

	static Condition condition(JsonObject value, String path) {
		String type = string(value, "type", path);
		Term term;
		synchronized (ReflexSpec.class) {
			term = CONDITIONS.get(type);
		}
		if (term == null) throw invalid(path + ".type " + type + " is not a reflex condition; use one of " + String.join(", ", conditionTypes()));
		boolean negated = value.has("not") && bool(value, "not", path);
		JsonObject params = params(value, term, path, Set.of("type", "not"));
		return new Condition(type, negated, params);
	}

	static Action action(JsonObject value, String path) {
		String type = string(value, "type", path);
		Term term;
		synchronized (ReflexSpec.class) {
			term = ACTIONS.get(type);
		}
		if (term == null) throw invalid(path + ".type " + type + " is not a reflex action; use one of " + String.join(", ", actionTypes()));
		JsonObject params = params(value, term, path, Set.of("type"));
		if ("select".equals(type) && params.has("tool") == params.has("item")) throw invalid(path + " select needs exactly one of tool or item");
		return new Action(type, params);
	}

	private static JsonObject params(JsonObject value, Term term, String path, Set<String> reserved) {
		JsonObject params = new JsonObject();
		Set<String> known = new LinkedHashSet<>(reserved);
		for (Param param : term.params()) known.add(param.name());
		requireKeys(value, path, known);
		for (Param param : term.params()) {
			if (!value.has(param.name())) {
				if (param.required()) throw invalid(path + "." + param.name() + " is required for " + term.type());
				continue;
			}
			JsonElement raw = value.get(param.name());
			String field = path + "." + param.name();
			switch (param.kind()) {
				case NUMBER -> {
					double number = number(raw, field);
					if (number < param.min() || number > param.max()) {
						throw invalid(field + " must be between " + trim(param.min()) + " and " + trim(param.max()));
					}
					params.addProperty(param.name(), number);
				}
				case IDS -> {
					if (!raw.isJsonArray() || raw.getAsJsonArray().isEmpty() || raw.getAsJsonArray().size() > MAX_IDS) {
						throw invalid(field + " must list 1.." + MAX_IDS + " ids like minecraft:blaze");
					}
					JsonArray ids = new JsonArray();
					for (JsonElement id : raw.getAsJsonArray()) ids.add(resourceId(id, field));
					params.add(param.name(), ids);
				}
				case TOOL_KIND -> {
					String kind = text(raw, field);
					if (!TOOL_KINDS.contains(kind)) throw invalid(field + " must be one of " + String.join(", ", TOOL_KINDS.stream().sorted().toList()));
					params.addProperty(param.name(), kind);
				}
				case ENTITY_ID -> {
					String id = text(raw, field);
					try { if (!java.util.UUID.fromString(id).toString().equalsIgnoreCase(id)) throw new IllegalArgumentException(); } catch (IllegalArgumentException invalid) { throw invalid(field + " must be a UUID"); }
					params.addProperty(param.name(), id.toLowerCase(Locale.ROOT));
				}
				case ITEM_ID -> params.addProperty(param.name(), resourceId(raw, field));
				case PLACE_WHERE -> {
					String where = text(raw, field);
					if (!PLACE_WHERE.contains(where)) throw invalid(field + " must be one of " + String.join(", ", PLACE_WHERE.stream().sorted().toList()));
					params.addProperty(param.name(), where);
				}
				case CHOICE -> {
					String word = text(raw, field);
					if (!param.choices().contains(word)) throw invalid(field + " must be one of " + String.join(", ", param.choices()));
					params.addProperty(param.name(), word);
				}
				case BOOL -> {
					if (!(raw instanceof JsonPrimitive primitive) || !primitive.isBoolean()) throw invalid(field + " must be boolean");
					params.addProperty(param.name(), primitive.getAsBoolean());
				}
			}
		}
		return params;
	}

	private static String resourceId(JsonElement raw, String field) {
		String id = text(raw, field).toLowerCase(Locale.ROOT);
		if (!id.contains(":")) id = "minecraft:" + id;
		if (!RESOURCE_ID.matcher(id).matches() || id.length() > 128) throw invalid(field + " has an invalid id " + id);
		return id;
	}

	private static void requireKeys(JsonObject value, String path, Set<String> allowed) {
		for (String key : value.keySet()) {
			if (!allowed.contains(key)) throw invalid(path + " has unknown field " + key + "; allowed: " + String.join(", ", allowed));
		}
	}

	private static String string(JsonObject value, String key, String path) {
		if (!value.has(key)) throw invalid(path + "." + key + " is required");
		return text(value.get(key), path + "." + key);
	}

	private static String text(JsonElement raw, String field) {
		if (!(raw instanceof JsonPrimitive primitive) || !primitive.isString()) throw invalid(field + " must be a string");
		return primitive.getAsString();
	}

	private static double number(JsonElement raw, String field) {
		if (!(raw instanceof JsonPrimitive primitive) || !primitive.isNumber()) throw invalid(field + " must be a number");
		double number = primitive.getAsDouble();
		if (!Double.isFinite(number)) throw invalid(field + " must be finite");
		return number;
	}

	private static boolean bool(JsonObject value, String key, String path) {
		JsonElement raw = value.get(key);
		if (!(raw instanceof JsonPrimitive primitive) || !primitive.isBoolean()) throw invalid(path + "." + key + " must be boolean");
		return primitive.getAsBoolean();
	}

	private static long longValue(JsonObject value, String key, String path, long min, long max, long fallback) {
		if (!value.has(key)) return fallback;
		double number = number(value.get(key), path + "." + key);
		if (number != Math.rint(number) || number < min || number > max) {
			throw invalid(path + "." + key + " must be an integer between " + min + " and " + max);
		}
		return (long) number;
	}

	private static String trim(double value) {
		return value == Math.rint(value) ? Long.toString((long) value) : Double.toString(value);
	}

	private static InvalidRuleException invalid(String message) {
		return new InvalidRuleException("INVALID_REFLEX", message);
	}
}
