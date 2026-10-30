package dev.agaminggod.arenaagents.server.watch;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The episode state machine for one agent, without a server. A danger opens an episode when its time-to-harm drops
 * below {@link #OPEN_ETA_S}; the same source keeps the same episode; an episode closes after {@link #GRACE_TICKS} with
 * no active danger from its source, or at once on death. Damage and death come from real damage events and are
 * attributed to the matching open episode (same source, or a compatible hazard kind), or open their own.
 */
public final class EpisodeTracker {
	public static final double OPEN_ETA_S = 3.0D;
	public static final double CLOSE_CALL_ETA_S = 1.0D;
	public static final float CLOSE_CALL_HEALTH = 6.0F;
	public static final long GRACE_TICKS = 40L;
	public static final int MAX_OPEN = 16;

	/** Damage kinds and the episode kinds they can belong to when the source key does not match. */
	static final Map<String, Set<String>> DAMAGE_MATCH = Map.of(
			"lava", Set.of("lava", "lava_hidden", "burning", "fire"),
			"fire", Set.of("fire", "burning", "lava", "lava_hidden"),
			"burning", Set.of("burning", "fire", "lava", "lava_hidden"),
			"fall", Set.of("drop", "fall", "void"),
			"void", Set.of("void", "drop", "fall"),
			"drowning", Set.of("drowning"),
			"dragon_breath", Set.of("dragon_breath"),
			"starving", Set.of("low_health"));

	private final String agentId;
	private final Map<String, Episode> open = new LinkedHashMap<>();
	private long sequence;

	public EpisodeTracker(String agentId) {
		this.agentId = agentId;
	}

	public Iterable<Episode> open() {
		return open.values();
	}

	public boolean hasOpen() {
		return !open.isEmpty();
	}

	/** Episodes that opened during the last {@link #observe} or damage call; the caller fills what the system knew. */
	private final List<Episode> opened = new ArrayList<>();

	public List<Episode> takeOpened() {
		List<Episode> result = List.copyOf(opened);
		opened.clear();
		return result;
	}

	/**
	 * One scan's dangers. {@code health} and {@code burning} update every open episode. Returns the episodes that closed.
	 */
	public List<Episode> observe(List<Danger> dangers, long gameTime, long epochMs, float health, boolean burning) {
		for (Danger danger : dangers) {
			Episode episode = open.get(danger.key());
			boolean active = danger.etaS() < OPEN_ETA_S;
			if (episode == null) {
				if (!active || open.size() >= MAX_OPEN) continue;
				episode = start(danger, gameTime, epochMs);
			}
			if (active) episode.lastActiveTick = gameTime;
			if (danger.etaS() < episode.minEtaS) {
				episode.minEtaS = danger.etaS();
				if (danger.block() != null) episode.block = danger.block();
			}
		}
		for (Episode episode : open.values()) {
			episode.minHealth = Math.min(episode.minHealth, health);
			if (burning) episode.burnedOrInLava = true;
		}
		return closeExpired(gameTime, epochMs);
	}

	private Episode start(Danger danger, long gameTime, long epochMs) {
		Episode episode = new Episode(agentId + "-" + epochMs + "-" + (++sequence), agentId, danger, gameTime, epochMs);
		open.put(danger.key(), episode);
		opened.add(episode);
		return episode;
	}

	private List<Episode> closeExpired(long gameTime, long epochMs) {
		List<Episode> closed = new ArrayList<>();
		for (Iterator<Episode> iterator = open.values().iterator(); iterator.hasNext(); ) {
			Episode episode = iterator.next();
			if (gameTime - episode.lastActiveTick < GRACE_TICKS) continue;
			iterator.remove();
			close(episode, gameTime, epochMs);
			closed.add(episode);
		}
		return closed;
	}

	/**
	 * Real damage taken. {@code sourceKey} is the attacker's or projectile owner's key when there is one; {@code
	 * damageKind} the hazard kind the damage type names. Returns the episode it was attributed to.
	 */
	public Episode damage(String sourceKey, String damageKind, String sourceType, String entityId, int[] block, float amount,
			float healthAfter, long gameTime, long epochMs) {
		Episode episode = attribute(sourceKey, damageKind, sourceType, entityId, block, gameTime, epochMs);
		episode.damage += Math.max(0.0F, amount);
		if (episode.firstHarmEpochMs < 0L) episode.firstHarmEpochMs = epochMs;
		episode.minEtaS = 0.0D;
		episode.minHealth = Math.min(episode.minHealth, healthAfter);
		episode.lastActiveTick = gameTime;
		return episode;
	}

	/** The agent died: the matching episode records the death; every open episode closes now. */
	public List<Episode> death(String sourceKey, String damageKind, String sourceType, String entityId, int[] block, String message,
			long gameTime, long epochMs) {
		Episode episode = attribute(sourceKey, damageKind, sourceType, entityId, block, gameTime, epochMs);
		episode.died = true;
		episode.deathMessage = message;
		episode.minEtaS = 0.0D;
		episode.minHealth = 0.0F;
		if (episode.firstHarmEpochMs < 0L) episode.firstHarmEpochMs = epochMs;
		List<Episode> closed = new ArrayList<>(open.values());
		open.clear();
		for (Episode each : closed) close(each, gameTime, epochMs);
		return closed;
	}

	/** Closes everything (agent left, server stopping). */
	public List<Episode> closeAll(long gameTime, long epochMs) {
		List<Episode> closed = new ArrayList<>(open.values());
		open.clear();
		for (Episode each : closed) close(each, gameTime, epochMs);
		return closed;
	}

	private Episode attribute(String sourceKey, String damageKind, String sourceType, String entityId, int[] block, long gameTime, long epochMs) {
		if (sourceKey != null) {
			Episode byKey = open.get(sourceKey);
			if (byKey != null) return byKey;
		}
		Set<String> kinds = DAMAGE_MATCH.get(damageKind);
		Episode best = null;
		if (kinds != null) {
			for (Episode candidate : open.values()) {
				if (!kinds.contains(candidate.kind)) continue;
				if (best == null || candidate.minEtaS < best.minEtaS) best = candidate;
			}
		}
		if (best != null) return best;
		// Unforeseen: nothing the scan tracked explains this harm, so it is its own episode.
		String key = sourceKey != null ? sourceKey : damageKind;
		Episode existing = open.get(key);
		if (existing != null) return existing;
		return start(new Danger(key, damageKind, sourceType, entityId, block, 0.0D, 0.0D), gameTime, epochMs);
	}

	private static void close(Episode episode, long gameTime, long epochMs) {
		episode.closed = true;
		episode.closedGameTime = gameTime;
		episode.closedEpochMs = epochMs;
		episode.outcome = outcome(episode);
	}

	/** death | damage | close_call (got within a second, health fell to 6 or less, or burned) | avoided. */
	static String outcome(Episode episode) {
		if (episode.died) return "death";
		if (episode.damage > 0.0F) return "damage";
		if (episode.minEtaS < CLOSE_CALL_ETA_S || episode.minHealth <= CLOSE_CALL_HEALTH || episode.burnedOrInLava) return "close_call";
		return "avoided";
	}
}
