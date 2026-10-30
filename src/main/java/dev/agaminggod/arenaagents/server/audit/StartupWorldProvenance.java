package dev.agaminggod.arenaagents.server.audit;

import java.io.IOException;
import java.io.StringReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Whether the dedicated server's world directory held any saved state when this mod initialized. Fabric runs mod
 * initializers from its patch at the start of Minecraft's server Main, before Main opens the level storage
 * (validateAndCreateAccess), discovers packs and saves level.dat for a new world. That earlier observation, not
 * the files present at SERVER_STARTING, decides whether this server is creating the world.
 */
public final class StartupWorldProvenance {
	private static final Logger LOGGER = LoggerFactory.getLogger(StartupWorldProvenance.class);
	private static volatile Observation observed;

	/** dir: the absolute, normalized world directory; fresh: absent, or containing no regular file. */
	public record Observation(Path dir, boolean fresh) {
	}

	private StartupWorldProvenance() {
	}

	/** Mod initialization: resolve the level folder from launch arguments and server.properties, then look at it. */
	public static void capture(Path gameDir, String[] launchArguments) {
		try {
			Path properties = gameDir.resolve("server.properties");
			String text = Files.isRegularFile(properties) ? Files.readString(properties) : null;
			Path dir = resolveWorldDirectory(gameDir, text, launchArguments);
			observed = new Observation(dir, !hasSavedState(dir));
		} catch (IOException | RuntimeException exception) {
			LOGGER.warn("Intervention audit could not observe the world directory before startup", exception);
			observed = null;
		}
	}

	public static Observation observed() {
		return observed;
	}

	static void observe(Observation observation) {
		observed = observation;
	}

	/**
	 * The audit's world verdict at SERVER_STARTING: the early observation must exist, name this server's world
	 * directory and have found no saved state; the directory may since hold only what Main writes for a new world.
	 */
	public static AgentInterventionAudit.World decide(Observation early, Path root, java.util.List<String> filesNow, boolean initialized) {
		if (early == null || !early.dir().equals(root)) return AgentInterventionAudit.World.UNKNOWN;
		if (!early.fresh()) return AgentInterventionAudit.World.EXISTING;
		return ContentBaseline.newWorldFilesAtStart(filesNow) && !initialized ? AgentInterventionAudit.World.FRESH : AgentInterventionAudit.World.EXISTING;
	}

	/** Minecraft's own resolution: --universe (default the game directory) / --world (default level-name, else "world"). */
	public static Path resolveWorldDirectory(Path gameDir, String serverProperties, String[] arguments) throws IOException {
		String universe = argument(arguments, "--universe");
		String world = argument(arguments, "--world");
		if (world == null && serverProperties != null) {
			Properties properties = new Properties();
			properties.load(new StringReader(serverProperties));
			world = properties.getProperty("level-name");
		}
		if (world == null || world.isEmpty()) world = "world";
		Path base = universe == null ? gameDir : gameDir.resolve(universe);
		return base.resolve(world).toAbsolutePath().normalize();
	}

	static boolean hasSavedState(Path dir) throws IOException {
		if (!Files.exists(dir)) return false;
		try (Stream<Path> walk = Files.walk(dir)) {
			return walk.anyMatch(Files::isRegularFile);
		}
	}

	private static String argument(String[] arguments, String name) {
		if (arguments == null) return null;
		for (int index = 0; index < arguments.length; index++) {
			String value = arguments[index];
			if (value.equals(name) && index + 1 < arguments.length) return arguments[index + 1];
			if (value.startsWith(name + "=")) return value.substring(name.length() + 1);
		}
		return null;
	}
}
