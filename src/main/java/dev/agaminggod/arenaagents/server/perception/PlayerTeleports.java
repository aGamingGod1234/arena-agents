package dev.agaminggod.arenaagents.server.perception;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerPlayer;

/**
 * A marker for each agent body's latest server-forced reposition: the position packet a real client receives on a
 * respawn, command or ender-pearl teleport, chorus fruit, end gateway or dimension change. A player sees the screen
 * jump, so the coordinator may know it too; it uses it to stop measuring one journey across the jump.
 */
public final class PlayerTeleports {
	/** Reported for this long after a teleport; a longer gap between two samples is treated as unobserved movement. */
	public static final long REPORT_TICKS = 400L;
	private static final int MAX_PLAYERS = 1024;
	// Keyed by UUID because a respawn replaces the ServerPlayer object while keeping the identity.
	private static final Map<UUID, Teleport> LATEST = new LinkedHashMap<>(16, 0.75F, true) {
		@Override protected boolean removeEldestEntry(Map.Entry<UUID, Teleport> eldest) { return size() > MAX_PLAYERS; }
	};

	/**
	 * tick is when it happened; mark is what the wire reports. The mark is the tick, or one more than the previous mark
	 * when several teleports share a tick, so every reposition stays distinct and never orders before its own tick.
	 */
	record Teleport(long tick, long mark) {
		static Teleport next(Teleport previous, long tick) {
			return new Teleport(tick, previous == null ? tick : Math.max(tick, previous.mark() + 1L));
		}
	}

	private PlayerTeleports() { }

	public static void record(ServerPlayer player) {
		long tick = Math.max(0L, player.level().getGameTime());
		synchronized (LATEST) { LATEST.merge(player.getUUID(), Teleport.next(null, tick), (previous, ignored) -> Teleport.next(previous, tick)); }
	}

	/** The latest teleport's mark when it is recent enough to report, otherwise null. */
	public static Long recent(ServerPlayer player) {
		Teleport teleport;
		synchronized (LATEST) { teleport = LATEST.get(player.getUUID()); }
		return recent(teleport, player.level().getGameTime());
	}

	static Long recent(Teleport teleport, long now) {
		return teleport != null && now - teleport.tick() <= REPORT_TICKS && now >= teleport.tick() ? teleport.mark() : null;
	}
}
