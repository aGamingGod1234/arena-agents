package dev.agaminggod.arenaagents.server.runtime.reflex;

import dev.agaminggod.arenaagents.protocol.ActionType;
import java.util.EnumSet;
import java.util.Set;

/**
 * Follows the agent's own command for its reflexes, without a server. A yield asked of a held shield waits to see
 * whether the command only moves (then the two compose); a yielded stance comes back once the command has ended; an
 * action that bails out (fire, lava, low health) hands the body to the agent's rules at once.
 */
final class CommandFollower {
	/**
	 * Actions that only walk, look and press keys through their input lease. Under a held shield they keep running and
	 * their movement passes through (a player walks with a raised shield, slowed by vanilla's item-use speed). A flee is
	 * not one: a player runs from melee mobs with the shield down, sprinting (live run d19-iron-a: flee_from under a held
	 * shield moved at a fifth of walking speed, two zombies stayed 1.4 blocks behind for 12 s and the flee timed out).
	 */
	static final Set<ActionType> MOVES_UNDER_HOLD = Set.copyOf(EnumSet.of(ActionType.MOVE_TO, ActionType.NAVIGATE_TO, ActionType.TRAVEL_TO,
			ActionType.FIGHT_TARGET, ActionType.FIGHT_UNTIL, ActionType.FOLLOW_ENTITY, ActionType.CONTROL, ActionType.CONTROL_SEQUENCE,
			ActionType.WAIT, ActionType.PICK_UP_ITEM, ActionType.SELECT_ITEM));
	/** An action that stops on these leaves the body to the model's reflexes instead of standing still until its turn. */
	static final Set<String> HANDOFF_CODES = Set.of("LOW_HEALTH_BAILOUT", "ON_FIRE", "IN_LAVA", "NAVIGATION_DAMAGED");
	/** A yielded stance fires again once the body has been without an action this long after the model's command. */
	static final long IDLE_RESUME_TICKS = 10L;
	/** How long a yield waits for the model's command to start (a held shield), or a yielded stance waits for it to. */
	static final long COMMAND_WAIT_TICKS = 20L;

	record Result(boolean yieldNow, boolean handedOff) {
		static final Result NONE = new Result(false, false);
	}

	/** The action running last tick, to see it end and how. */
	private String lastActionId;
	private long yieldRequestedAt = -1L;
	private String yieldBaselineActionId;
	private long yieldedAt = -1L;
	private boolean sawCommand;
	private long idleSince = -1L;

	/** A model command asks for the body; true means yield now, false means a held shield waits to see the command. */
	boolean requestYield(boolean heldPassesMovement, long now) {
		if (!heldPassesMovement) return true;
		yieldRequestedAt = now;
		yieldBaselineActionId = lastActionId;
		return false;
	}

	/** The firing was yielded: its stance stays down until the command ends (or its condition clears). */
	void yielded(long now) {
		yieldRequestedAt = -1L;
		yieldedAt = now;
		sawCommand = false;
		idleSince = -1L;
	}

	/**
	 * One tick. {@code activeId}/{@code activeType} name the running action (null when idle); {@code lastId} and
	 * {@code lastReason} the latest finished one.
	 */
	Result observe(ReflexScheduler scheduler, boolean heldPassesMovement, String activeId, ActionType activeType,
			String lastId, String lastReason, long now) {
		boolean handedOff = false;
		if (activeId == null && lastActionId != null && lastActionId.equals(lastId) && HANDOFF_CODES.contains(lastReason)) {
			scheduler.resume(now, true);
			yieldedAt = -1L;
			handedOff = true;
		}
		lastActionId = activeId;
		boolean yieldNow = false;
		if (yieldRequestedAt >= 0L) {
			boolean started = activeId != null && !activeId.equals(yieldBaselineActionId);
			if (!heldPassesMovement || now - yieldRequestedAt > COMMAND_WAIT_TICKS || started && movesUnderHold(activeType)) {
				yieldRequestedAt = -1L;
			} else if (started) {
				yieldNow = true;
			}
		}
		if (yieldedAt >= 0L) {
			if (activeId != null) {
				if (!movesUnderHold(activeType)) scheduler.suppressIdleShields();
				sawCommand = true;
				idleSince = -1L;
			} else {
				if (idleSince < 0L) idleSince = now;
				if ((sawCommand || now - yieldedAt >= COMMAND_WAIT_TICKS) && now - idleSince >= IDLE_RESUME_TICKS) scheduler.resume(now, false);
			}
			if (!scheduler.anySuppressed()) yieldedAt = -1L;
		}
		return yieldNow || handedOff ? new Result(yieldNow, handedOff) : Result.NONE;
	}

	static boolean movesUnderHold(dev.agaminggod.arenaagents.server.runtime.ServerActionRequest request) {
		if (request == null || !movesUnderHold(request.type())) return false;
		var args = request.arguments();
		if (request.type() == ActionType.CONTROL) return !usesHands(args);
		if (request.type() == ActionType.CONTROL_SEQUENCE) {
			// Reserve the hands for the whole authored sequence, including later and branched frames.
			for (var frame : args.getAsJsonArray("frames")) if (usesHands(frame.getAsJsonObject())) return false;
		}
		return true;
	}

	private static boolean usesHands(com.google.gson.JsonObject frame) {
		return frame.has("attack") && frame.get("attack").getAsBoolean()
				|| frame.has("use") && frame.get("use").getAsBoolean();
	}

	static boolean movesUnderHold(ActionType type) {
		return type != null && MOVES_UNDER_HOLD.contains(type);
	}
}
