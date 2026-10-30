package dev.agaminggod.arenaagents.server;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Allows one problem per agent per window, including alternating errors with changing coordinates.
 */
final class FailureChatThrottle {
	static final long WINDOW_MILLIS = 30_000L;
	private static final int MAX_ENTRIES = 256;

	private final Map<String, Long> lastShown = new LinkedHashMap<>();

	synchronized boolean allow(String agentId, String message, long nowMillis) {
		Objects.requireNonNull(message, "message must not be null");
		String key = Objects.requireNonNull(agentId, "agentId must not be null");
		Long previous = lastShown.get(key);
		if (previous != null && nowMillis - previous < WINDOW_MILLIS) return false;
		lastShown.remove(key);
		lastShown.put(key, nowMillis);
		prune(nowMillis);
		return true;
	}

	private void prune(long nowMillis) {
		Iterator<Map.Entry<String, Long>> entries = lastShown.entrySet().iterator();
		while (entries.hasNext()) {
			Map.Entry<String, Long> entry = entries.next();
			if (lastShown.size() > MAX_ENTRIES || nowMillis - entry.getValue() >= WINDOW_MILLIS) entries.remove();
			else break;
		}
	}
}
