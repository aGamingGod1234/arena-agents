package dev.agaminggod.arenaagents.pov;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import net.fabricmc.api.EnvType;
import net.fabricmc.loader.impl.launch.knot.Knot;

/**
 * Proves that every POV mixin applies under Fabric by loading each target class through Knot.
 * A mis-targeted injector fails here (defaultRequire is 1) instead of at first game launch.
 * Minecraft's main is never invoked; classes are loaded without initialization.
 */
public final class PovMixinVerification {
	private static final String TARGETS_RESOURCE = "pov-mixin-targets.txt";
	private static final String COMPAT_TARGETS_RESOURCE = "pov-mixin-targets-compat.txt";
	/**
	 * Handlers whose absence would silently fall back to the operator's own state, listed per target in the compat
	 * resource as "class: handler, handler".
	 */
	private static final java.util.Map<String, List<String>> REQUIRED_HANDLERS = new java.util.HashMap<>();

	private PovMixinVerification() {
	}

	public static void main(String[] args) throws Exception {
		List<String> targets = readTargets();
		if (targets.isEmpty()) throw new AssertionError("No POV mixin targets are listed in " + TARGETS_RESOURCE);
		ClassLoader target = new Knot(EnvType.CLIENT).init(args);
		List<String> failures = new ArrayList<>();
		for (String name : targets) {
			try {
				Class<?> loaded = Class.forName(name, false, target);
				// Touching the declared members forces the transformed class to be fully defined.
				java.lang.reflect.Method[] methods = loaded.getDeclaredMethods();
				for (String handler : REQUIRED_HANDLERS.getOrDefault(name, List.of())) {
					if (java.util.Arrays.stream(methods).noneMatch(method -> method.getName().contains(handler))) {
						failures.add(name + ": missing merged handler " + handler);
					}
				}
			} catch (Throwable error) {
				StringBuilder chain = new StringBuilder(name).append(": ").append(error);
				// Mixin's own reason (a missing target, a bad descriptor) is in the cause chain, not the wrapper.
				for (Throwable cause = error.getCause(); cause != null && cause != cause.getCause(); cause = cause.getCause()) chain.append("\n    caused by ").append(cause);
				failures.add(chain.toString());
			}
		}
		if (!failures.isEmpty()) {
			throw new AssertionError("POV mixins failed to apply:\n" + String.join("\n", failures));
		}
		System.out.println("POV mixin verification passed (" + targets.size()
				+ " target classes transformed); Minecraft client main was not invoked.");
	}

	private static List<String> readTargets() throws Exception {
		List<String> targets = new ArrayList<>();
		readTargets(TARGETS_RESOURCE, targets);
		// The classes only one Minecraft target has (src/compat/<target>/testResources).
		readTargets(COMPAT_TARGETS_RESOURCE, targets);
		return targets;
	}

	private static void readTargets(String resource, List<String> targets) throws Exception {
		try (InputStream stream = PovMixinVerification.class.getClassLoader().getResourceAsStream(resource)) {
			if (stream == null) throw new AssertionError("Missing test resource " + resource);
			try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
				String line;
				while ((line = reader.readLine()) != null) {
					String trimmed = line.trim();
					if (trimmed.isEmpty() || trimmed.startsWith("#")) continue;
					int colon = trimmed.indexOf(':');
					String name = colon < 0 ? trimmed : trimmed.substring(0, colon).trim();
					if (colon >= 0) REQUIRED_HANDLERS.put(name, java.util.Arrays.stream(trimmed.substring(colon + 1).split(",")).map(String::trim).toList());
					targets.add(name);
				}
			}
		}
	}
}
