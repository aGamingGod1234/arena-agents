package dev.agaminggod.arenaagents.server.audit;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;

/**
 * What a certifiable run may start from: a world this server is creating, the exact mod set this repository runs
 * (Fabric Loader and its built-ins, Fabric API with the modules it contains, Carpet, this mod and the jars it
 * contains), their data packs plus vanilla, and the default overworld generator. Anything else is a coverage gap,
 * so the run is unverifiable rather than autonomous.
 */
public final class ContentBaseline {
	/** Root mods by exact id; any other mod is accepted only when one of these contains it (jar-in-jar). */
	static final Set<String> ROOT_MODS = Set.of("minecraft", "java", "fabricloader", "mixinextras", "fabric-api", "carpet", "arenaagents");

	private ContentBaseline() {
	}

	/** Regular files a brand-new world has at SERVER_STARTING: Main's storage lock and its first level.dat save. */
	public static boolean newWorldFilesAtStart(Collection<String> files) {
		return files.stream().allMatch(file -> file.equals("session.lock") || file.equals("level.dat"));
	}

	/** modId to the id of the mod that contains it, if any. */
	public static Set<String> allowedMods(Map<String, Optional<String>> mods) {
		Set<String> allowed = new TreeSet<>();
		for (String mod : mods.keySet()) if (allowedMod(mod, mods, 0)) allowed.add(mod);
		return allowed;
	}

	public static List<String> modGaps(Map<String, Optional<String>> mods) {
		Set<String> allowed = allowedMods(mods);
		List<String> gaps = new ArrayList<>();
		for (String mod : new TreeSet<>(mods.keySet())) if (!allowed.contains(mod)) gaps.add("mod " + mod);
		return gaps;
	}

	/** Packs must be vanilla, Fabric's grouped mod pack, or a pack named for an allowed mod. */
	public static List<String> packGaps(Collection<String> selectedPacks, Set<String> allowedMods) {
		List<String> gaps = new ArrayList<>();
		for (String pack : selectedPacks) {
			if (!pack.equals("vanilla") && !pack.equals("fabric") && !allowedMods.contains(pack)) gaps.add("data pack " + pack);
		}
		return gaps;
	}

	public static List<String> generatorGaps(boolean defaultOverworldSettings, boolean multiNoiseBiomes) {
		return defaultOverworldSettings && multiNoiseBiomes ? List.of() : List.of("non-default overworld generation");
	}

	private static boolean allowedMod(String mod, Map<String, Optional<String>> mods, int depth) {
		if (ROOT_MODS.contains(mod) && mods.getOrDefault(mod, Optional.empty()).isEmpty()) return true;
		Optional<String> parent = mods.getOrDefault(mod, Optional.empty());
		return depth < 8 && parent.isPresent() && allowedMod(parent.get(), mods, depth + 1);
	}
}
