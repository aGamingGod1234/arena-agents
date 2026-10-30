package dev.agaminggod.arenaagents.server;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Replays recorded public feed, without inventing the missing historical model summaries. */
public final class AgentFeedReplay {
	public static void main(String[] args) throws Exception {
		if (args.length < 1 || args.length > 2) throw new IllegalArgumentException("Usage: replay-activity-feed.sh <game-latest.log> [sample-start HH:mm:ss]");
		AgentFeedPolicy feed = new AgentFeedPolicy();
		Map<String, Set<String>> inventory = new HashMap<>();
		Pattern chat = Pattern.compile("^\\[(\\d\\d:\\d\\d:\\d\\d)\\].*\\[CHAT] (.*)$");
		Pattern agentLine = Pattern.compile("^\\[(GPT-6\\.1 Sol|Claude Opus 5\\.5)] (.*)$");
		Pattern collected = Pattern.compile("Collected \\d+ (minecraft:[a-z0-9_]+)");
		int before = 0, after = 0, problems = 0, candidates = 0, notableItems = 0;
		long first = -1, last = 0;
		List<String> sampleBefore = new ArrayList<>(), sampleAfter = new ArrayList<>();
		String sampleTime = args.length == 2 ? args[1] : "13:40:00";
		long sampleStart = LocalTime.parse(sampleTime).toSecondOfDay();
		for (String raw : Files.readAllLines(Path.of(args[0]))) {
			var line = chat.matcher(raw.replaceAll("§.", ""));
			if (!line.matches()) continue;
			String text = line.group(2).replaceFirst("^\\[\\d\\d:\\d\\d:\\d\\d] ", "").replaceFirst(" \\(x\\d+\\)$", "");
			boolean relevant = text.startsWith("[GPT-6.1 Sol]") || text.startsWith("[Claude Opus 5.5]")
					|| text.startsWith("<GPT-6.1 Sol>") || text.startsWith("<Claude Opus 5.5>")
					|| text.startsWith("GPT-6.1 Sol ") || text.startsWith("Claude Opus 5.5 ");
			if (!relevant || text.endsWith(" joined the game") || text.endsWith(" left the game")) continue;
			long seconds = LocalTime.parse(line.group(1)).toSecondOfDay();
			if (first < 0) first = seconds;
			last = seconds;
			before++;
			boolean sample = seconds >= sampleStart && seconds < sampleStart + 120;
			if (sample) sampleBefore.add(line.group(1) + " " + text);
			String output = null;
			var event = agentLine.matcher(text);
			if (!event.matches()) output = text; // Authored speech and vanilla advancements pass unchanged.
			else {
				String agent = event.group(1), body = event.group(2);
				int attention = body.indexOf(" needs attention: ");
				if (attention >= 0) {
					String detail = body.substring(attention + " needs attention: ".length());
					var item = collected.matcher(detail);
					if (item.find()) {
						Set<String> items = inventory.computeIfAbsent(agent, id -> { feed.items(id, Set.of()); return new HashSet<>(); });
						items.add(item.group(1));
						for (String acquired : feed.items(agent, items)) {
							output = "[" + agent + "] Obtained " + acquired.substring(10).replace('_', ' ') + ".";
							notableItems++;
						}
					} else {
						// Old chat lacks reason codes and terminal states. Count every non-collection
						// attention line as an unknown announceable failure rather than dropping it.
						var problem = AgentFeedPolicy.problem("finish " + body.substring(0, attention).toLowerCase(java.util.Locale.ROOT), "", detail);
						if (problem.isPresent()) candidates++;
						if (problem.isPresent() && feed.problem(agent, problem.get(), seconds * 1000)) {
							output = "[" + agent + "] " + problem.get();
							problems++;
						}
					}
				} else if (body.startsWith("Connection lost")) {
					output = text; // Severe lifecycle events bypass ordinary problem throttling.
				} else if (body.startsWith("Needs attention:")) {
					candidates++;
					// No code survives in this historical lifecycle line, so retain it conservatively.
					output = "[" + agent + "] Couldn't continue: the task stopped.";
					problems++;
				} else if (body.startsWith("Goal verified:") || body.startsWith("Task complete")) output = text;
			}
			if (output != null) {
				after++;
				if (sample) sampleAfter.add(line.group(1) + " " + output);
			}
		}
		if (before == 0 || last <= first) throw new IllegalArgumentException("No timed run-2 feed found");
		double minutes = (last - first) / 60.0;
		System.out.printf(java.util.Locale.ROOT, "Recorded feed replay: %.2f minutes; %d -> %d messages; %.2f -> %.2f lines/min; %d problems from %d failure candidates, %d recovered first items.%n", minutes, before, after, before / minutes, after / minutes, problems, candidates, notableItems);
		System.out.println("Historical reason codes/states are missing: all non-collection attention lines count as failures. Missing model summaries, health/hunger, and inventory events cannot be reconstructed; this is conservative routing evidence, not live traffic.");
		System.out.println("Two-minute recorded sample BEFORE (starting " + sampleTime + "):");
		sampleBefore.forEach(System.out::println);
		System.out.println("AFTER:");
		sampleAfter.forEach(System.out::println);
	}
}
