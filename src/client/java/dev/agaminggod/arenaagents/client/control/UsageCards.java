package dev.agaminggod.arenaagents.client.control;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.control.AgentControlCatalog;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.Rectangle;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.Function;

/**
 * Layout B of the live windows: one card per agent (wrapping to more rows), then one line per account.
 * Everything comes from the task view's usage roster, so one request draws every agent. Sizes are GUI pixels;
 * drawing multiplies by the window scale.
 */
public final class UsageCards {
	/** Narrowest card whose lines all fit at full scale; cards in a row share the row width equally. */
	static final int MIN_CARD_W = 178, CARD_H = 70, COMPACT_H = 24, GAP = 4, LINE = 10, PAD = 6;
	private static final String SEP = " \u00b7 ";
	private static final Color CARD = new Color(0, 0, 0, 150), CARD_SELECTED = new Color(40, 40, 40, 200), TRACK = new Color(255, 255, 255, 40);

	private UsageCards() {
	}

	/** A painted card: the agent it belongs to and its bounds in screen pixels. */
	public record Hit(String agentId, Rectangle bounds) {
	}

	/** Cards per row: as many as fit at MIN_CARD_W, but never more than there are agents, so the row is filled. */
	static int columns(int width, int agents) {
		return Math.max(1, Math.min(agents, (width + GAP) / (MIN_CARD_W + GAP)));
	}

	static int cardWidth(int width, int columns) {
		return (width - GAP * (columns - 1)) / columns;
	}

	/** Height in GUI pixels the strip needs at this width: card rows plus every wrapped account line. */
	public static int height(JsonObject roster, int width, boolean compact) {
		if (roster == null || array(roster, "agents").isEmpty()) return LINE + 4;
		int agents = array(roster, "agents").size();
		int rows = (agents + columns(width, agents) - 1) / columns(width, agents);
		int lines = 0;
		if (!compact) for (JsonElement account : array(roster, "accounts")) lines += accountLines(account.getAsJsonObject(), width).size();
		return rows * ((compact ? COMPACT_H : CARD_H) + GAP) + lines * LINE + 2;
	}

	/**
	 * Draws the strip at (x, y) GUI pixels within width; compact cards (plan window switcher) show name and model only.
	 * Returns where each card was drawn, for click selection.
	 */
	public static List<Hit> paint(Graphics2D g, JsonObject roster, String selectedId, Function<String, String> names,
	                              int x, int y, int width, int scale, boolean compact) {
		List<Hit> hits = new ArrayList<>();
		if (roster == null || array(roster, "agents").isEmpty()) {
			McUi.text(g, "Usage appears after the first model call.", x * scale, (y + 2) * scale, McUi.GRAY, scale);
			return hits;
		}
		JsonArray accounts = array(roster, "accounts");
		int columns = columns(width, array(roster, "agents").size()), cardW = cardWidth(width, columns), cardHeight = compact ? COMPACT_H : CARD_H, index = 0;
		for (JsonElement element : array(roster, "agents")) {
			JsonObject agent = element.getAsJsonObject();
			String id = string(agent, "agentId", "");
			int cx = x + (index % columns) * (cardW + GAP), cy = y + (index / columns) * (cardHeight + GAP);
			boolean selected = id.equals(selectedId);
			Color providerColor = new Color(AgentControlCatalog.providerColor(string(agent, "provider", "")));
			McUi.panel(g, cx * scale, cy * scale, cardW * scale, cardHeight * scale, selected ? CARD_SELECTED : CARD, selected ? McUi.WHITE : providerColor.darker().darker());
			int inner = cardW - PAD * 2, tx = (cx + PAD) * scale, ty = cy + 4;
			String name = names.apply(id);
			McUi.text(g, McUi.ellipsize(name == null || name.isBlank() ? id.substring(0, Math.min(8, id.length())) : name, inner), tx, ty * scale, providerColor, scale);
			ty += LINE;
			McUi.text(g, fit(modelParts(agent), inner, true), tx, ty * scale, McUi.GRAY, scale);
			if (!compact) {
				ty += LINE;
				double busy = number(agent, "busyPercent", 0);
				McUi.text(g, fit(List.of(count(agent, "calls") + " calls", "busy " + percent(busy)), inner, false), tx, ty * scale, McUi.WHITE, scale);
				ty += LINE - 1;
				g.setColor(TRACK);
				g.fillRect(tx, ty * scale, inner * scale, 2 * scale);
				g.setColor(providerColor);
				g.fillRect(tx, ty * scale, (int) Math.round(inner * scale * Math.max(0, Math.min(100, busy)) / 100), 2 * scale);
				ty += 4;
				McUi.text(g, fit(tokenParts(agent), inner, false), tx, ty * scale, McUi.WHITE, scale);
				ty += LINE;
				McUi.text(g, fit(spendParts(agent), inner, false), tx, ty * scale, McUi.WHITE, scale);
				ty += LINE;
				JsonObject account = account(accounts, string(agent, "provider", ""));
				McUi.text(g, fit(cardLimitParts(account, agent), inner, false), tx, ty * scale, warningColor(account), scale);
			}
			hits.add(new Hit(id, new Rectangle(cx * scale, cy * scale, cardW * scale, cardHeight * scale)));
			index++;
		}
		if (compact) return hits;
		int rows = (index + columns - 1) / columns, ly = y + rows * (cardHeight + GAP) + 2;
		for (JsonElement element : accounts) {
			JsonObject account = element.getAsJsonObject();
			for (String line : accountLines(account, width)) {
				McUi.text(g, line, x * scale, ly * scale, warningColor(account), scale);
				ly += LINE;
			}
		}
		return hits;
	}

	/**
	 * Joins parts with " · " while they fit; parts that do not fit are dropped whole, never cut mid-value. Only an
	 * identity first part (a model name) may be shortened, when even it alone is too wide.
	 */
	static String fit(List<String> parts, int width, boolean shortenFirst) {
		String line = "";
		for (String part : parts) {
			String next = line.isEmpty() ? part : line + SEP + part;
			if (McUi.width(next) <= width) line = next;
			else if (line.isEmpty() && shortenFirst) return McUi.ellipsize(part, width);
			else break;
		}
		return line;
	}

	/**
	 * The account line wrapped to the width. A limit (used or left, time left, rates) moves to the next line whole
	 * when it does not fit after the previous one; a single part is never split unless it alone is wider than the line.
	 */
	static List<String> accountLines(JsonObject account, int width) {
		List<List<String>> groups = accountGroups(account);
		List<String> lines = new ArrayList<>();
		String line = groups.getFirst().getFirst();
		boolean header = true;
		for (List<String> group : groups.subList(1, groups.size())) {
			String joined = String.join(SEP, group);
			if (McUi.width(line + (header ? " " : SEP) + joined) <= width) line += (header ? " " : SEP) + joined;
			else if (McUi.width("  " + joined) <= width) { lines.add(line); line = "  " + joined; }
			else for (String part : group) {
				if (McUi.width(line + (header ? " " : SEP) + part) <= width) line += (header ? " " : SEP) + part;
				else { lines.add(line); line = "  " + part; }
				header = false;
			}
			header = false;
		}
		lines.add(line);
		List<String> fitted = new ArrayList<>();
		for (String value : lines) fitted.addAll(McUi.width(value) <= width ? List.of(value) : McUi.wrap(value, width));
		return fitted;
	}

	static List<String> modelParts(JsonObject agent) {
		List<String> parts = new ArrayList<>();
		parts.add(modelLabel(string(agent, "provider", ""), string(agent, "model", "?")));
		String effort = string(agent, "effort", "");
		if (!effort.isBlank()) parts.add(effort);
		String tier = string(agent, "tier", "");
		if (tier.equals("fast") || tier.equals("priority") && "codex".equals(string(agent, "provider", ""))) parts.add("fast");
		return parts;
	}

	/** The catalog's display name, else the model id without its provider prefix. */
	static String modelLabel(String provider, String model) {
		try {
			return AgentControlCatalog.displayName(provider, model);
		} catch (RuntimeException notInCatalog) {
			return model.substring(model.lastIndexOf('/') + 1);
		}
	}

	static List<String> tokenParts(JsonObject agent) {
		JsonObject tokens = object(agent, "tokens");
		if (tokens == null) return List.of("no tokens yet");
		return List.of("in " + tokens(number(tokens, "input", 0)) + " (" + tokens(number(tokens, "cached", 0)) + " cached)", "out " + tokens(number(tokens, "output", 0)));
	}

	static List<String> spendParts(JsonObject agent) {
		if (agent.has("free") && agent.get("free").getAsBoolean()) {
			return List.of(has(agent, "listCostUsd") ? "$0 (list " + dollars(number(agent, "listCostUsd", 0)) + ")" : "$0");
		}
		if (!has(agent, "costUsd")) return List.of("$ unknown");
		JsonObject perHour = object(agent, "perHour");
		return perHour != null && has(perHour, "costUsd")
				? List.of(dollars(number(agent, "costUsd", 0)), dollars(number(perHour, "costUsd", 0)) + "/h")
				: List.of(dollars(number(agent, "costUsd", 0)));
	}

	/** The account's tightest limit for a card: used or left, then time left. */
	static List<String> cardLimitParts(JsonObject account, JsonObject agent) {
		if (account == null) return List.of("no limit data");
		JsonObject window = tightestWindow(account);
		JsonObject credits = object(account, "credits");
		List<String> parts = new ArrayList<>();
		if (window != null) {
			parts.add(windowName(window) + " " + percent(number(window, "usedPercent", 0)) + " used");
			left(window, parts);
		} else if (credits != null && has(credits, "remaining")) {
			parts.add("credits " + whole(number(credits, "remaining", 0)) + " left");
			left(credits, parts);
		} else if ("requests".equals(string(account, "limitKind", "unknown"))) {
			JsonObject requests = object(account, "requests");
			long limited = requests == null ? 0 : (long) number(object(requests, "rateLimited"), "lastHour", 0);
			if (agent.has("free") && agent.get("free").getAsBoolean()) parts.add("free");
			parts.add(limited > 0 ? limited + " rate-limited (1 h)" : "no limit hit");
		} else parts.add("no limit data");
		return parts;
	}

	static String cardLimitLine(JsonObject account, JsonObject agent) {
		return String.join(SEP, cardLimitParts(account, agent));
	}

	static String spendLine(JsonObject agent) {
		return String.join(SEP, spendParts(agent));
	}

	/**
	 * Every number the account exposes, one group per limit in reading order: used or left, time left, rate per hour,
	 * rate per minute. The first group is the account name; then windows, credits and request counts.
	 */
	static List<List<String>> accountGroups(JsonObject account) {
		List<List<String>> groups = new ArrayList<>();
		String who = string(account, "label", string(account, "provider", "")) + (has(account, "account") ? " (" + string(account, "account", "") + (has(account, "plan") ? ", " + string(account, "plan", "") : "") + ")" : "");
		groups.add(List.of((string(account, "warning", "none").equals("none") ? "" : "! ") + who + ":"));
		for (JsonElement element : array(account, "windows")) {
			JsonObject window = element.getAsJsonObject();
			List<String> parts = new ArrayList<>();
			parts.add(windowName(window) + " " + percent(number(window, "usedPercent", 0)) + " used");
			left(window, parts);
			if (has(window, "perHour")) parts.add(signed(number(window, "perHour", 0), "%/h"));
			if (has(window, "perMinute")) parts.add(signed(number(window, "perMinute", 0), "%/min"));
			groups.add(parts);
		}
		JsonObject credits = object(account, "credits");
		if (credits != null && has(credits, "remaining")) {
			List<String> parts = new ArrayList<>();
			parts.add("credits " + whole(number(credits, "remaining", 0)) + " left");
			left(credits, parts);
			if (has(credits, "perHour")) parts.add("-" + decimal(number(credits, "perHour", 0)) + "/h");
			if (has(credits, "perMinute")) parts.add("-" + decimal(number(credits, "perMinute", 0)) + "/min");
			groups.add(parts);
		}
		JsonObject requests = object(account, "requests");
		if (requests != null && (groups.size() == 1 || "requests".equals(string(account, "limitKind", "")))) {
			JsonObject limited = object(requests, "rateLimited");
			List<String> parts = new ArrayList<>();
			parts.add(limited == null || number(limited, "total", 0) == 0 ? "no limit hit" : whole(number(limited, "total", 0)) + " rate-limited");
			parts.add(whole(number(requests, "perHour", 0)) + " req/h");
			if (has(requests, "perMinute")) parts.add(decimal(number(requests, "perMinute", 0)) + " req/min");
			groups.add(parts);
		}
		if (groups.size() == 1) groups.add(List.of("no limit data from this CLI"));
		return groups;
	}

	static List<String> accountParts(JsonObject account) {
		return accountGroups(account).stream().flatMap(List::stream).toList();
	}

	static String accountLine(JsonObject account) {
		List<String> parts = accountParts(account);
		return parts.getFirst() + " " + String.join(SEP, parts.subList(1, parts.size()));
	}

	static Color warningColor(JsonObject account) {
		return switch (account == null ? "none" : string(account, "warning", "none")) {
			case "red" -> McUi.RED;
			case "yellow" -> McUi.YELLOW;
			default -> McUi.GREEN;
		};
	}

	private static JsonObject tightestWindow(JsonObject account) {
		JsonObject best = null;
		for (JsonElement element : array(account, "windows")) {
			JsonObject window = element.getAsJsonObject();
			if (best == null || number(window, "usedPercent", 0) > number(best, "usedPercent", 0)) best = window;
		}
		return best;
	}

	private static String windowName(JsonObject window) {
		double minutes = number(window, "windowMins", 0);
		if (minutes == 300) return "5-hour";
		if (minutes == 10_080) return "weekly";
		if (minutes > 0) return whole(minutes) + "-min";
		return string(window, "id", "plan");
	}

	private static void left(JsonObject limit, List<String> parts) {
		if (limit.has("resetsFirst") && limit.get("resetsFirst").getAsBoolean()) { parts.add("resets first"); return; }
		if (!has(limit, "hoursToLimit")) return;
		double hours = number(limit, "hoursToLimit", 0);
		parts.add("~" + (hours < 1 ? Math.max(1, Math.round(hours * 60)) + " min" : decimal(hours) + " h") + " left");
	}

	static String tokens(double value) {
		if (value >= 1_000_000) return String.format(Locale.ROOT, "%.1fM", value / 1_000_000);
		if (value >= 1_000) return String.format(Locale.ROOT, "%.0fk", value / 1_000);
		return whole(value);
	}

	static String dollars(double value) {
		return value >= 100 ? String.format(Locale.ROOT, "$%.0f", value) : value >= 0.1 ? String.format(Locale.ROOT, "$%.2f", value) : String.format(Locale.ROOT, "$%.3f", value);
	}

	private static String percent(double value) {
		return value == Math.rint(value) ? whole(value) + "%" : String.format(Locale.ROOT, "%.1f%%", value);
	}

	private static String signed(double value, String unit) {
		return (value >= 0 ? "+" : "") + decimal(value) + unit;
	}

	private static String decimal(double value) {
		if (Math.abs(value) >= 100) return whole(value);
		if (Math.abs(value) >= 10) return String.format(Locale.ROOT, "%.1f", value).replaceAll("\\.0$", "");
		return String.format(Locale.ROOT, "%.2f", value).replaceAll("0$", "").replaceAll("\\.0$", "");
	}

	private static String whole(double value) {
		return String.format(Locale.ROOT, "%,d", Math.round(value));
	}

	private static String count(JsonObject object, String key) {
		return whole(number(object, key, 0));
	}

	static JsonObject account(JsonArray accounts, String provider) {
		for (JsonElement element : accounts) if (string(element.getAsJsonObject(), "provider", "").equals(provider)) return element.getAsJsonObject();
		return null;
	}

	private static JsonArray array(JsonObject object, String key) {
		JsonElement value = object == null ? null : object.get(key);
		return value != null && value.isJsonArray() ? value.getAsJsonArray() : new JsonArray();
	}

	private static JsonObject object(JsonObject object, String key) {
		JsonElement value = object == null ? null : object.get(key);
		return value != null && value.isJsonObject() ? value.getAsJsonObject() : null;
	}

	private static boolean has(JsonObject object, String key) {
		JsonElement value = object == null ? null : object.get(key);
		return value != null && !value.isJsonNull();
	}

	private static double number(JsonObject object, String key, double fallback) {
		JsonElement value = object == null ? null : object.get(key);
		return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isNumber() ? value.getAsDouble() : fallback;
	}

	private static String string(JsonObject object, String key, String fallback) {
		JsonElement value = object == null ? null : object.get(key);
		return value != null && value.isJsonPrimitive() ? value.getAsString() : fallback;
	}
}
