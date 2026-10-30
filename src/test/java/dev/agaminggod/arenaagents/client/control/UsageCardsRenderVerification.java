package dev.agaminggod.arenaagents.client.control;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.awt.image.BufferedImage;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import javax.imageio.ImageIO;
import javax.swing.JPanel;

/**
 * Renders the real terminal and plan windows (layout B: one usage card per agent, account lines, agent switcher)
 * offscreen with 1 and 4 agents and writes the PNGs to build/reports/usage-cards.
 */
public final class UsageCardsRenderVerification {
	private UsageCardsRenderVerification() {
	}

	private static final String SOL = """
			{"agentId":"00000000-0000-4000-8000-000000000001","provider":"codex","model":"gpt-6.1-sol","effort":"low","tier":"default","since":1,"calls":184,"busyMs":1,"busyPercent":61.2,
			 "tokens":{"input":9100000,"cached":7800000,"uncached":1300000,"cacheWrite":0,"output":92000,"reasoning":41000},"last":{"at":1,"input":48000,"cached":47000,"output":610,"reasoning":200,"ms":6100},
			 "costUsd":11.402,"listCostUsd":null,"free":false,"perMinute":{"calls":3.1,"tokensIn":150000,"tokensOut":1500,"costUsd":0.19,"listCostUsd":null},
			 "perHour":{"calls":184,"tokensIn":9000000,"tokensOut":90000,"costUsd":11.2,"listCostUsd":null},"goal":{"revision":3,"calls":40,"busyMs":1,"tokens":{"input":1,"cached":1,"uncached":0,"cacheWrite":0,"output":1,"reasoning":0},"costUsd":2.1}}""";

	private static String opencode(int index, String model, int calls, double busy, double list) {
		return """
				{"agentId":"00000000-0000-4000-8000-00000000000%d","provider":"opencode","model":"%s","effort":"low","tier":"priority","since":1,"calls":%d,"busyMs":1,"busyPercent":%s,
				 "tokens":{"input":5200000,"cached":4600000,"uncached":600000,"cacheWrite":0,"output":60000,"reasoning":33000},"last":null,
				 "costUsd":0,"listCostUsd":%s,"free":true,"perMinute":{"calls":3.2,"tokensIn":1,"tokensOut":1,"costUsd":0,"listCostUsd":0.03},
				 "perHour":{"calls":192,"tokensIn":1,"tokensOut":1,"costUsd":0,"listCostUsd":1.9},"goal":{"revision":1,"calls":1,"busyMs":1,"tokens":{"input":1,"cached":1,"uncached":0,"cacheWrite":0,"output":1,"reasoning":0},"costUsd":0}}"""
				.formatted(index, model, calls, busy, list);
	}

	private static final String OPUS = """
			{"agentId":"00000000-0000-4000-8000-000000000004","provider":"claude","model":"claude-opus-5-5","effort":"medium","tier":"priority","since":1,"calls":22,"busyMs":1,"busyPercent":34,
			 "tokens":{"input":2100000,"cached":1500000,"uncached":40000,"cacheWrite":560000,"output":18000,"reasoning":0},"last":null,
			 "costUsd":2.31,"listCostUsd":null,"free":false,"perMinute":{"calls":0.8,"tokensIn":1,"tokensOut":1,"costUsd":0.04,"listCostUsd":null},
			 "perHour":{"calls":48,"tokensIn":1,"tokensOut":1,"costUsd":2.4,"listCostUsd":null},"goal":{"revision":1,"calls":1,"busyMs":1,"tokens":{"input":1,"cached":1,"uncached":0,"cacheWrite":0,"output":1,"reasoning":0},"costUsd":0}}""";

	private static final String CODEX_ACCOUNT = """
			{"provider":"codex","label":"Codex","account":"agam...","plan":"pro","limitKind":"plan_percent",
			 "windows":[{"id":"primary","windowMins":10080,"usedPercent":84,"resetsAt":null,"perMinute":0.01,"perHour":0.4,"hoursToLimit":40,"resetsFirst":false}],
			 "credits":{"remaining":4288.05,"unlimited":false,"perMinute":4.8,"perHour":285,"hoursToLimit":2.6},
			 "requests":{"perMinute":3.1,"perHour":184,"rateLimited":{"total":0,"lastHour":0,"lastAt":null}},"hoursToLimit":2.6,"warning":"yellow",
			 "warningReason":"credits 4288.05 left, about 2.6 h at this rate","agents":["00000000-0000-4000-8000-000000000001"]}""";
	private static final String OPENCODE_ACCOUNT = """
			{"provider":"opencode","label":"OpenCode","account":"OpenCode api","plan":"Zen","limitKind":"requests","windows":[],"credits":null,
			 "requests":{"perMinute":4.6,"perHour":276,"rateLimited":{"total":0,"lastHour":0,"lastAt":null}},"hoursToLimit":null,"warning":"none","warningReason":null,"agents":[]}""";
	private static final String CLAUDE_ACCOUNT = """
			{"provider":"claude","label":"Claude","account":"agam...","plan":"max","limitKind":"plan_percent",
			 "windows":[{"id":"five_hour","windowMins":300,"usedPercent":91,"resetsAt":null,"perMinute":0.3,"perHour":18,"hoursToLimit":0.5,"resetsFirst":false}],
			 "credits":null,"requests":{"perMinute":0.8,"perHour":48,"rateLimited":{"total":0,"lastHour":0,"lastAt":null}},"hoursToLimit":0.5,"warning":"red",
			 "warningReason":"5-hour window 91% used","agents":["00000000-0000-4000-8000-000000000004"]}""";

	public static int verify() throws Exception {
		Path output = Path.of("build/reports/usage-cards");
		Files.createDirectories(output);
		JsonObject one = JsonParser.parseString("{\"generatedAt\":1,\"agents\":[" + SOL + "],\"accounts\":[" + CODEX_ACCOUNT + "]}").getAsJsonObject();
		JsonObject four = JsonParser.parseString("{\"generatedAt\":1,\"agents\":[" + SOL + "," + opencode(2, "opencode/deepseek-v4.1-flash-free", 97, 78, 1.9) + ","
				+ opencode(3, "opencode/glm-5.3-flash-free", 41, 88, 0.7) + "," + OPUS + "],\"accounts\":[" + CODEX_ACCOUNT + "," + OPENCODE_ACCOUNT + "," + CLAUDE_ACCOUNT + "]}").getAsJsonObject();
		LiveAgentWindows.names = id -> switch (id.charAt(id.length() - 1)) {
			case '1' -> "Sol-1"; case '2' -> "Deep-1"; case '3' -> "GLM-1"; case '5' -> "GLM-2"; case '6' -> "Deep-2"; default -> "Opus-1"; };
		JsonObject six = four.deepCopy();
		six.getAsJsonArray("agents").add(JsonParser.parseString(opencode(5, "opencode/glm-5.3-flash-free", 12, 40, 0.2)));
		six.getAsJsonArray("agents").add(JsonParser.parseString(opencode(6, "opencode/deepseek-v4.1-flash-free", 8, 22, 0.1)));
		int checks = 0;
		checks += terminal(one, 1, output.resolve("terminal-1-agent.png"));
		checks += terminal(four, 4, output.resolve("terminal-4-agents.png"));
		checks += terminal(six, 6, output.resolve("terminal-6-agents.png"));
		checks += plan(four, output.resolve("plan-4-agents.png"));
		// Card text: free models show $0 plus the list-price equivalent; limit lines carry the projection.
		JsonObject deep = four.getAsJsonArray("agents").get(1).getAsJsonObject();
		expect(UsageCards.spendLine(deep).equals("$0 (list $1.90)"), "free model spend line: " + UsageCards.spendLine(deep));
		expect(UsageCards.spendLine(one.getAsJsonArray("agents").get(0).getAsJsonObject()).equals("$11.40 · $11.20/h"), "paid model spend line");
		expect(UsageCards.cardLimitLine(UsageCards.account(four.getAsJsonArray("accounts"), "codex"), deep).equals("weekly 84% used · ~40 h left"), "card limit line: " + UsageCards.cardLimitLine(UsageCards.account(four.getAsJsonArray("accounts"), "codex"), deep));
		expect(UsageCards.accountLine(four.getAsJsonArray("accounts").get(0).getAsJsonObject()).contains("credits 4,288 left · ~2.6 h left · -285/h · -4.8/min"), "account credit line: " + UsageCards.accountLine(four.getAsJsonArray("accounts").get(0).getAsJsonObject()));
		expect(UsageCards.warningColor(four.getAsJsonArray("accounts").get(2).getAsJsonObject()).equals(McUi.RED), "red under 1 h");
		expect(UsageCards.warningColor(four.getAsJsonArray("accounts").get(0).getAsJsonObject()).equals(McUi.YELLOW), "yellow under 3 h");
		// Nothing on a card or an account line is cut off at the narrowest card or at the 1-agent window width.
		int inner = UsageCards.MIN_CARD_W - UsageCards.PAD * 2;
		for (var element : six.getAsJsonArray("agents")) {
			JsonObject agent = element.getAsJsonObject();
			JsonObject account = UsageCards.account(six.getAsJsonArray("accounts"), agent.get("provider").getAsString());
			for (List<String> parts : List.of(UsageCards.tokenParts(agent), UsageCards.spendParts(agent), UsageCards.cardLimitParts(account, agent)))
				expect(UsageCards.fit(parts, inner, false).equals(String.join(" · ", parts)), "card line fits whole: " + parts);
		}
		for (var element : six.getAsJsonArray("accounts")) {
			List<String> lines = UsageCards.accountLines(element.getAsJsonObject(), 480 - 12);
			for (String line : lines) expect(McUi.width(line) <= 468, "account line fits the strip: " + line);
			for (String part : UsageCards.accountParts(element.getAsJsonObject()))
				expect(lines.stream().anyMatch(line -> line.contains(part)), "account line wraps instead of cutting: " + part);
		}
		expect(String.join(" ", UsageCards.accountLines(one.getAsJsonArray("accounts").get(0).getAsJsonObject(), 468)).contains("~2.6 h left"), "time left survives on the 1-agent account line");
		return checks + 7 + 3 * 6 + 3;
	}

	private static int terminal(JsonObject roster, int agents, Path file) throws Exception {
		Class<?> outer = LiveAgentWindows.class;
		set(outer, "roster", roster);
		set(outer, "selected", roster.getAsJsonArray("agents").get(0).getAsJsonObject().get("agentId").getAsString());
		set(outer, "latest", JsonParser.parseString("""
				{"goalRevision":3,"goal":"Beat the game","active":true,"verified":false,"revision":2,"generatedAt":1,"plan":null,"lastObserved":{},"usage":null,"allowance":null,
				 "events":[{"stage":"live_tool","message":"minecraft.mine {\\"block\\":\\"iron_ore\\"}","sequence":1,"at":1},
				  {"stage":"live_agent_message","message":"Heading down the staircase to the lava pool level.","sequence":2,"at":2}]}""").getAsJsonObject());
		var constructor = Class.forName(outer.getName() + "$TerminalView").getDeclaredConstructor();
		constructor.setAccessible(true);
		JPanel view = (JPanel) constructor.newInstance();
		view.setSize(960, 620);
		BufferedImage image = new BufferedImage(960, 620, BufferedImage.TYPE_INT_ARGB);
		var g = image.createGraphics();
		view.paint(g);
		g.dispose();
		ImageIO.write(image, "png", file.toFile());
		@SuppressWarnings("unchecked") List<UsageCards.Hit> hits = (List<UsageCards.Hit>) get(outer, "terminalHits");
		boolean overflow = (int) get(view, "stripOverflow") > 0;
		expect(overflow ? hits.size() >= 2 && hits.size() <= agents : hits.size() == agents, "terminal draws one card per agent, or the visible ones when the strip scrolls (" + hits.size() + ")");
		int footerTop = (int) get(view, "footerTopPx");
		expect(footerTop - (30 + 6) * 2 >= (6 * 10 + 8) * 2, "the log keeps at least six lines");
		if (overflow) {
			var wheel = new java.awt.event.MouseWheelEvent(view, java.awt.event.MouseEvent.MOUSE_WHEEL, 0, 0, 10, footerTop + 4, 0, false, java.awt.event.MouseWheelEvent.WHEEL_UNIT_SCROLL, 1, 30);
			for (var listener : view.getMouseWheelListeners()) listener.mouseWheelMoved(wheel);
			expect((int) get(view, "stripScroll") > 0, "the wheel over the cards scrolls the strip");
			BufferedImage scrolled = new BufferedImage(960, 620, BufferedImage.TYPE_INT_ARGB);
			var sg = scrolled.createGraphics();
			view.paint(sg);
			sg.dispose();
			ImageIO.write(scrolled, "png", file.resolveSibling(file.getFileName().toString().replace(".png", "-scrolled.png")).toFile());
		}
		for (UsageCards.Hit hit : hits) expect(hit.bounds().y + hit.bounds().height <= 620 && hit.bounds().x + hit.bounds().width <= 960, "cards fit the window");
		var hitAt = outer.getDeclaredMethod("hitAt", List.class, int.class, int.class);
		hitAt.setAccessible(true);
		UsageCards.Hit last = hits.getLast();
		expect(last.agentId().equals(hitAt.invoke(null, hits, last.bounds().x + 3, last.bounds().y + 3)), "a click on a card finds its agent");
		return 4 + hits.size();
	}

	private static int plan(JsonObject roster, Path file) throws Exception {
		Class<?> outer = LiveAgentWindows.class;
		set(outer, "roster", roster);
		var graphClass = Class.forName(outer.getName() + "$Graph");
		var graphConstructor = graphClass.getDeclaredConstructor();
		graphConstructor.setAccessible(true);
		JPanel graph = (JPanel) graphConstructor.newInstance();
		set(outer, "graph", graph);
		var viewConstructor = Class.forName(outer.getName() + "$PlanView").getDeclaredConstructor(graphClass);
		viewConstructor.setAccessible(true);
		JPanel view = (JPanel) viewConstructor.newInstance(graph);
		view.setSize(1180, 720);
		view.doLayout();
		BufferedImage image = new BufferedImage(1180, 720, BufferedImage.TYPE_INT_ARGB);
		var g = image.createGraphics();
		view.paint(g);
		g.dispose();
		ImageIO.write(image, "png", file.toFile());
		@SuppressWarnings("unchecked") List<UsageCards.Hit> hits = (List<UsageCards.Hit>) get(outer, "planHits");
		expect(hits.size() == 4, "the plan window has the same agent switcher");
		expect(graph.getY() + graph.getHeight() <= hits.getFirst().bounds().y, "the plan map stays above the switcher");
		return 2;
	}

	private static void set(Class<?> owner, String name, Object value) throws ReflectiveOperationException {
		var field = owner.getDeclaredField(name);
		field.setAccessible(true);
		field.set(null, value);
	}

	private static Object get(Class<?> owner, String name) throws ReflectiveOperationException {
		var field = owner.getDeclaredField(name);
		field.setAccessible(true);
		return field.get(null);
	}

	private static Object get(Object instance, String name) throws ReflectiveOperationException {
		var field = instance.getClass().getDeclaredField(name);
		field.setAccessible(true);
		return field.get(instance);
	}

	private static void expect(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
