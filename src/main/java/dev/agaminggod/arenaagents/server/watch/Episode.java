package dev.agaminggod.arenaagents.server.watch;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * One dangerous episode for one agent: what was really there (opened by {@link EpisodeTracker}), what the system knew
 * (filled by {@link Watcher} while it is open) and, once closed, its outcome and diagnosis. Server thread only.
 */
public final class Episode {
	public record Firing(String rule, long atMs, String result) {
	}

	final String id;
	final String agentId;
	final String key;
	final String kind;
	final String sourceType;
	final String entityId;
	int[] block;
	String dim;
	double x;
	double y;
	double z;
	final long openedGameTime;
	final long openedEpochMs;
	long closedGameTime;
	long closedEpochMs;
	long lastActiveTick;
	double minEtaS = Double.POSITIVE_INFINITY;
	float minHealth = Float.MAX_VALUE;
	float damage;
	long firstHarmEpochMs = -1L;
	boolean died;
	String deathMessage;
	/** Burning or in lava at some point during the episode. */
	boolean burnedOrInLava;
	boolean closed;

	// What the system knew.
	boolean perceivable;
	boolean inObservation;
	boolean inThreatFacts;
	/** It reached the agent as a row at least once (not only as a sound). */
	boolean seenRow;
	Long firstObservedAt;
	/** Ids of rules armed at open whose trigger covers this kind. */
	final Set<String> armed = new LinkedHashSet<>();
	final List<Firing> fired = new ArrayList<>();
	/** The body's action type when the danger was closest (null when none ran). */
	String action;
	/** That action's arguments, so a replay can re-run it. */
	com.google.gson.JsonObject actionArguments;
	/** Where the source entity was at open (null for terrain and body-state sources). */
	double[] sourcePos;
	boolean causedByAction;
	/** The id of the body action that moved toward the hazard (set with {@link #causedByAction}). */
	String causedActionId;
	Double lastReplyAgoS;
	boolean wakeSent;
	String forecastId;
	String diagnosis;
	String evidence;
	String outcome;

	Episode(String id, String agentId, Danger danger, long gameTime, long epochMs) {
		this.id = id;
		this.agentId = agentId;
		this.key = danger.key();
		this.kind = danger.kind();
		this.sourceType = danger.sourceType();
		this.entityId = danger.entityId();
		this.block = danger.block();
		this.openedGameTime = gameTime;
		this.openedEpochMs = epochMs;
		this.lastActiveTick = gameTime;
	}

	public String id() { return id; }
	public String kind() { return kind; }
	public String key() { return key; }
	public String outcome() { return outcome; }
	public String diagnosis() { return diagnosis; }
	public String evidence() { return evidence; }
	public float damage() { return damage; }
	public double minEtaS() { return minEtaS; }
	public boolean closed() { return closed; }
	public int[] block() { return block; }
	public String entityId() { return entityId; }
	public long openedEpochMs() { return openedEpochMs; }
	public long firstHarmEpochMs() { return firstHarmEpochMs; }
	public List<Firing> fired() { return fired; }
	public Set<String> armed() { return armed; }
}
