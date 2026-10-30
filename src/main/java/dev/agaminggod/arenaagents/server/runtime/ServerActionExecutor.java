package dev.agaminggod.arenaagents.server.runtime;

import carpet.helpers.EntityPlayerActionPack;
import carpet.script.utils.Tracer;
import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.agent.AgentDomainException;
import dev.agaminggod.arenaagents.agent.AgentId;
import dev.agaminggod.arenaagents.agent.AgentTransition;
import dev.agaminggod.arenaagents.protocol.ActionType;
import dev.agaminggod.arenaagents.server.runtime.BlockPlacementGeometry.Cause;
import dev.agaminggod.arenaagents.server.AgentChatReporter;
import dev.agaminggod.arenaagents.server.AgentRuntimeRouter;
import dev.agaminggod.arenaagents.server.CodexAgentManager;
import dev.agaminggod.arenaagents.server.OfflineAgentPlayers;
import dev.agaminggod.arenaagents.server.perception.ObservationVisibility;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import dev.agaminggod.arenaagents.server.conversation.ConversationAudience;
import dev.agaminggod.arenaagents.server.conversation.ServerAgentConversationRouter;
import dev.agaminggod.arenaagents.server.runtime.controller.HazardEntry;
import dev.agaminggod.arenaagents.server.runtime.controller.HazardExits;
import dev.agaminggod.arenaagents.server.runtime.controller.ServerController;
import dev.agaminggod.arenaagents.server.runtime.controller.ServerFightController;
import dev.agaminggod.arenaagents.server.runtime.controller.ServerFleeController;
import dev.agaminggod.arenaagents.server.runtime.controller.ServerNavigationController;
import dev.agaminggod.arenaagents.server.runtime.controller.ServerDigController;
import dev.agaminggod.arenaagents.server.runtime.controller.ServerItemPickupController;
import dev.agaminggod.arenaagents.server.runtime.controller.ServerLookController;
import dev.agaminggod.arenaagents.server.runtime.controller.ServerPathPlanner;
import dev.agaminggod.arenaagents.server.runtime.transaction.ServerTransactionAdapter;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputRuntime;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputState;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputStates;
import dev.agaminggod.arenaagents.server.runtime.input.ControlSequence;
import dev.agaminggod.arenaagents.server.runtime.input.SneakSettling;
import dev.agaminggod.arenaagents.server.runtime.controller.ThrowPreview;
import dev.agaminggod.arenaagents.server.runtime.controller.ServerRangedUseController;
import dev.agaminggod.arenaagents.server.runtime.input.InputLease;
import dev.agaminggod.arenaagents.server.runtime.input.InputOwner;
import dev.agaminggod.arenaagents.server.runtime.input.LeasedServerInputController;
import dev.agaminggod.arenaagents.mixin.EntityPlayerActionPackAccessor;
import dev.agaminggod.arenaagents.server.voice.VoiceReceipt;
import dev.agaminggod.arenaagents.server.voice.VoiceRequest;
import dev.agaminggod.arenaagents.server.voice.VoiceSubsystemRuntime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.context.BlockPlaceContext;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;
import net.minecraft.world.phys.shapes.VoxelShape;

public final class ServerActionExecutor {
	private static final org.slf4j.Logger LOGGER = org.slf4j.LoggerFactory.getLogger(ServerActionExecutor.class);
	/** The mixin issues a new receipt only for an actual successful removeBlock mutation. */
	public interface BlockBreakReceiptAccess {
		BlockBreakReceipt arenaagents$getBlockBreakReceipt();
	}

	public record BlockBreakReceipt(BlockPos position, BlockState before, BlockState after, List<ServerActionObservation.RevealedBlock> revealedBlocks,
			BreakOutcomeEvidence.Outcome outcome) {
		public BlockBreakReceipt {
			position = position.immutable();
			revealedBlocks = List.copyOf(revealedBlocks);
		}

		public BlockBreakReceipt(BlockPos position, BlockState before, BlockState after) {
			this(position, before, after, List.of(), null);
		}

		public BlockBreakReceipt(BlockPos position, BlockState before, BlockState after, List<ServerActionObservation.RevealedBlock> revealedBlocks) {
			this(position, before, after, revealedBlocks, null);
		}

		public BlockBreakReceipt withOutcome(BreakOutcomeEvidence.Outcome outcome) {
			return new BlockBreakReceipt(position, before, after, revealedBlocks, outcome);
		}

		boolean confirms(BlockBreakReceipt baseline, BlockPos target, String expectedBlockId, BlockState current) {
			return this != baseline && position.equals(target) && expectedBlockId.equals(blockId(before))
					&& before != after && after == before.getFluidState().createLegacyBlock() && current == after;
		}
	}
	private static final Set<ActionType> ARENA_SCRIPT_PRIMITIVES = Set.of(
			ActionType.MOVE_TO, ActionType.NAVIGATE_TO, ActionType.TRAVEL_TO, ActionType.DIG_TO, ActionType.BUILD_SHELTER, ActionType.CAST_OBSIDIAN, ActionType.BARTER_UNTIL, ActionType.CONTROL, ActionType.CONTROL_SEQUENCE, ActionType.LOOK_AT, ActionType.ATTACK,
			ActionType.SELECT_ITEM, ActionType.USE_ITEM, ActionType.BREAK_BLOCK, ActionType.PLACE_BLOCK,
			ActionType.CHAT, ActionType.WAIT, ActionType.SET_DOOR, ActionType.PICK_UP_ITEM, ActionType.DROP_ITEM,
			ActionType.TRANSFER_CONTAINER, ActionType.CRAFT_INVENTORY, ActionType.CRAFT_TABLE,
			ActionType.FURNACE_TRANSACTION, ActionType.EQUIP_ITEM, ActionType.SELECT_TOOL,
			ActionType.BLOCK_WITH_SHIELD, ActionType.USE_RANGED, ActionType.RESPAWN,
			ActionType.FIGHT_TARGET, ActionType.FIGHT_UNTIL, ActionType.FLEE_FROM
			, ActionType.INTERACT_BLOCK, ActionType.INTERACT_ENTITY, ActionType.DISMOUNT,
			ActionType.START_FALL_FLYING, ActionType.MENU_TRANSFER, ActionType.MENU_BUTTON,
			ActionType.ANVIL_RENAME, ActionType.MENU_CLICK, ActionType.MENU_CLOSE,
			ActionType.WAKE_UP, ActionType.SET_FLIGHT, ActionType.WRITE_SIGN, ActionType.EDIT_BOOK, ActionType.BEACON_EFFECTS
	);
	private static final Direction[] HORIZONTAL_PLACEMENT_DIRECTIONS = {
			Direction.NORTH, Direction.EAST, Direction.SOUTH, Direction.WEST
	};
	private static final long DEFAULT_TIMEOUT_MS = 60_000L;
	private static final long MOVEMENT_STALL_TIMEOUT_MS = 4_000L;
	private static final long PLACE_TIMEOUT_MS = 5_000L;
	/** A 180 degree turn takes about 6 ticks; past this something is fighting the view and the frame starts anyway. */
	static final int MAX_CONTROL_TURN_TICKS = 20;
	private static final double PROGRESS_EMISSION_DELTA = 0.05D;
	private static final long PROGRESS_HEARTBEAT_MS = 1_000L;
	static final int MAX_CLEANUP_ATTEMPTS = 8;

	private final CodexAgentManager manager;
	private final AgentRuntimeRouter router;
	private final Consumer<ServerActionResult> resultSink;
	private final RespawnResultSink respawnResultSink;
	private final Consumer<ServerActionProgress> progressSink;
	private final ServerProtectionPolicy protection;
	private final ResourceLeaseManager resourceLeases;
	private final AdvancedInteractionService advancedInteractions;
	private final ServerAgentConversationRouter conversationRouter;
	private final ActionSuccessLedger actionSuccessLedger;
	private final Map<AgentId, ActiveAction> active = new LinkedHashMap<>();
	private final Map<AgentId, ActiveAction> quarantinedActions = new LinkedHashMap<>();
	private final Map<AgentId, CleanupRetry<ServerActionResult>> pendingCompletions = new LinkedHashMap<>();
	/**
	 * Shift still held after a cancelled sneaking control frame: a player who stops a crouch-walk lets go of the
	 * movement key and keeps shift until drift stops, so a body hanging over a bridge edge does not slide off.
	 */
	private final Map<AgentId, ShiftHold> shiftHolds = new LinkedHashMap<>();

	private record ShiftHold(ServerPlayer player, InputLease lease, SneakSettling settling) {}
	// Keyed by the exact action so concurrent chat can neither reuse nor clear a physical action's retained result;
	// each completing publication keeps the action handle whose cleanup it finishes.
	private final Map<PublicationKey, TerminalPublication<ServerActionResult>> pendingPublications = new LinkedHashMap<>();
	private final Map<PublicationKey, ActiveAction> publicationOwners = new HashMap<>();
	private final Map<AgentId, PendingRespawn> pendingRespawns = new LinkedHashMap<>();
	private final Map<AgentId, String> quarantinedAgents = new LinkedHashMap<>();
	private final Map<AgentId, ServerActionResult> lastResults = new LinkedHashMap<>();
	private long coordinatorGeneration;
	private long pathfindingRoundRobinCursor;

	public ServerActionExecutor(CodexAgentManager manager, Consumer<ServerActionResult> resultSink) {
		this(manager, resultSink, progress -> { }, ServerProtectionPolicy.TRUSTED_LOCAL_OPERATOR);
	}

	public ServerActionExecutor(
			CodexAgentManager manager,
			Consumer<ServerActionResult> resultSink,
			Consumer<ServerActionProgress> progressSink
	) {
		this(manager, resultSink, progressSink, ServerProtectionPolicy.TRUSTED_LOCAL_OPERATOR);
	}

	public ServerActionExecutor(
			CodexAgentManager manager,
			Consumer<ServerActionResult> resultSink,
			ServerProtectionPolicy protection
	) {
		this(manager, resultSink, progress -> { }, protection);
	}

	public ServerActionExecutor(
			CodexAgentManager manager,
			Consumer<ServerActionResult> resultSink,
			Consumer<ServerActionProgress> progressSink,
			ServerProtectionPolicy protection
	) {
		this(manager, resultSink, progressSink, protection, (result, transition, commit) -> {
			resultSink.accept(result);
			commit.run();
		});
	}

	public ServerActionExecutor(
			CodexAgentManager manager,
			Consumer<ServerActionResult> resultSink,
			Consumer<ServerActionProgress> progressSink,
			ServerProtectionPolicy protection,
			RespawnResultSink respawnResultSink
	) {
		this(
				manager,
				resultSink,
				progressSink,
				protection,
				respawnResultSink,
				new ServerAgentConversationRouter(manager, (event, wakeGoal) -> { })
		);
	}

	public ServerActionExecutor(
			CodexAgentManager manager,
			Consumer<ServerActionResult> resultSink,
			Consumer<ServerActionProgress> progressSink,
			ServerProtectionPolicy protection,
			RespawnResultSink respawnResultSink,
			ServerAgentConversationRouter conversationRouter
	) {
		this.manager = Objects.requireNonNull(manager, "manager must not be null");
		this.router = new AgentRuntimeRouter(manager);
		this.resultSink = Objects.requireNonNull(resultSink, "resultSink must not be null");
		this.respawnResultSink = Objects.requireNonNull(respawnResultSink, "respawnResultSink must not be null");
		this.progressSink = Objects.requireNonNull(progressSink, "progressSink must not be null");
		this.protection = Objects.requireNonNull(protection, "protection must not be null");
		this.resourceLeases = new ResourceLeaseManager();
		this.advancedInteractions = new AdvancedInteractionService(protection, resourceLeases);
		this.conversationRouter = Objects.requireNonNull(conversationRouter, "conversationRouter must not be null");
		this.actionSuccessLedger = new ActionSuccessLedger();
	}

	public ActionSuccessLedger actionSuccessLedger() { return actionSuccessLedger; }

	/** Legacy scenario/operator path. Model-authored commands must use submitProgramPrimitive. */
	synchronized void submitLegacy(ServerActionRequest request) {
		Objects.requireNonNull(request, "request must not be null");
		if (request.type() == ActionType.RESPAWN) {
			submitVanillaRespawn(request);
			return;
		}
		String quarantineReason = quarantinedAgents.get(request.agentId());
		if (quarantineReason != null) {
			throw new AgentDomainException("ACTION_RUNTIME_QUARANTINED", quarantineReason);
		}
		if (actionInFlight(request.agentId())) {
			throw new AgentDomainException("ACTION_ALREADY_ACTIVE", "Agent already has an active action");
		}
		if (request.type() == ActionType.COMPLETE_GOAL) {
			emit(request, ServerActionState.FAILED, "SERVER_VERIFICATION_REQUIRED",
					"Goal completion must use the server-owned verification request", 0L, false, false);
			return;
		}

		router.actionAccepted(request.agentId(), request.goalRevision());
		ServerPlayer player = null;
		try {
			player = manager.findAgentPlayer(request.agentId()).orElseThrow(
					() -> new AgentDomainException("AGENT_PLAYER_MISSING", "Agent player is not loaded")
			);
			// Mining validation is deliberately completed before the activity reporter runs.
			// A rejected target must never be announced as an action that has started.
			ActiveAction preparedMining = request.type() == ActionType.BREAK_BLOCK
					? createAction(request, player) : null;
			AgentChatReporter.acting(manager, manager.registry().require(request.agentId()), request);
			releaseShiftHold(request.agentId());
			active.put(request.agentId(), preparedMining == null ? createAction(request, player) : preparedMining);
		} catch (RuntimeException exception) {
			try {
				router.actionFinished(request.agentId(), request.goalRevision());
			} catch (AgentDomainException stale) { }
			String reason = exception instanceof AgentDomainException domain ? domain.code() : "ACTION_REJECTED";
			ServerActionObservation rejectionObservation = request.type() == ActionType.BREAK_BLOCK && player != null
					? rejectedBreakObservation(player, request.arguments(), System.currentTimeMillis()) : null;
			emit(request, ServerActionState.FAILED, reason,
					FailureBlocker.withBlocker(player, request.type(), request.arguments(), reason, safeMessage(exception)), 0L, false, false,
					rejectionObservation, placementCause(request, exception));
		}
	}

	/**
	 * Reserves the agent's action slot; the vanilla body replacement starts on the executor tick, which holds agents
	 * whose acceptance is not durable yet. Starting it here would replace the body before its acceptance is journaled.
	 */
	private void submitVanillaRespawn(ServerActionRequest request) {
		if (actionInFlight(request.agentId())) {
			emit(request, ServerActionState.FAILED, "ACTION_ALREADY_ACTIVE", "Agent already has an active action", 0L, false, false);
			return;
		}
		pendingRespawns.put(request.agentId(), new PendingRespawn(
				request, null, new ElapsedTimeAccumulator(System.currentTimeMillis()), coordinatorGeneration
		));
	}

	private void startRespawn(PendingRespawn pending, long now) {
		AgentId agentId = pending.request().agentId();
		try {
			if (!isCurrentCoordinatorGeneration(pending.coordinatorGeneration(), coordinatorGeneration)) {
				pendingRespawns.remove(agentId, pending);
				return;
			}
			CodexAgentManager.VanillaRespawnAttempt attempt = manager.requestVerifiedRespawn(agentId);
			pendingRespawns.replace(agentId, pending, new PendingRespawn(
					pending.request(), attempt, pending.elapsedTime(), pending.coordinatorGeneration()));
			AgentChatReporter.acting(manager, attempt.deadRecord(), pending.request());
		} catch (RuntimeException exception) {
			pendingRespawns.remove(agentId, pending);
			String reason = exception instanceof AgentDomainException domain ? domain.code() : "RESPAWN_REJECTED";
			emit(pending.request(), ServerActionState.FAILED, reason, safeMessage(exception), pending.elapsedTime().advance(now), false, false);
		}
	}

	/** Executes only a model-authored physical primitive received through the coordinator bridge. */
	public synchronized void submitProgramPrimitive(ServerActionRequest request) {
		Objects.requireNonNull(request, "request must not be null");
		if (request.traceId() == null || request.provenance().traceId() == null) {
			throw new AgentDomainException("MISSING_TRACE_ID", "Model-authored actions require a non-null trace ID");
		}
		requireArenaScriptPrimitive(request.type());
		submitLegacy(request);
	}

	/** Delivers a validated direct or proximity reply without inventing an active goal for an idle agent. */
	public synchronized void submitConversationReply(ServerActionRequest request) {
		Objects.requireNonNull(request, "request must not be null");
		if (request.traceId() == null || request.provenance().traceId() == null) {
			throw new AgentDomainException("MISSING_TRACE_ID", "Model-authored actions require a non-null trace ID");
		}
		ConversationAudience audience = ConversationAudience.parse(nullableString(request.arguments(), "audience"));
		if (request.type() != ActionType.CHAT
				|| (audience != ConversationAudience.DIRECT && audience != ConversationAudience.PROXIMITY)) {
			throw new AgentDomainException(
					"INVALID_CONVERSATION_REPLY",
					"Detached conversation replies must use direct or proximity chat"
			);
		}
		if (actionInFlight(request.agentId())) {
			throw new AgentDomainException("ACTION_ALREADY_ACTIVE", "Agent already has an active action");
		}
		long startedAt = System.currentTimeMillis();
		try {
			manager.findAgentPlayer(request.agentId()).orElseThrow(
					() -> new AgentDomainException("AGENT_PLAYER_MISSING", "Agent player is not loaded")
			);
			AgentChatReporter.acting(manager, manager.registry().require(request.agentId()), request);
			sendConversation(request, request.arguments());
			emit(request, ServerActionState.SUCCEEDED, "ACTION_COMPLETED", "Action completed",
					System.currentTimeMillis() - startedAt, true, false);
		} catch (RuntimeException exception) {
			String reason = exception instanceof AgentDomainException domain ? domain.code() : "ACTION_REJECTED";
			emit(request, ServerActionState.FAILED, reason, safeMessage(exception),
					System.currentTimeMillis() - startedAt, true, false);
		}
	}

	/** Delivers say while a physical action owns the per-agent body slot, without replacing or waiting on it. */
	public synchronized void submitConcurrentChat(ServerActionRequest request) {
		Objects.requireNonNull(request, "request must not be null");
		if (request.traceId() == null || request.provenance().traceId() == null) {
			throw new AgentDomainException("MISSING_TRACE_ID", "Model-authored chat requires a non-null trace ID");
		}
		if (request.type() != ActionType.CHAT) {
			throw new AgentDomainException("INVALID_CONCURRENT_CHAT", "Only chat may bypass a physical action's body slot");
		}
		String quarantineReason = quarantinedAgents.get(request.agentId());
		if (quarantineReason != null) throw new AgentDomainException("ACTION_RUNTIME_QUARANTINED", quarantineReason);
		long startedAt = System.currentTimeMillis();
		try {
			manager.findAgentPlayer(request.agentId()).orElseThrow(
					() -> new AgentDomainException("AGENT_PLAYER_MISSING", "Agent player is not loaded")
			);
			sendConversation(request, request.arguments());
			emit(request, ServerActionState.SUCCEEDED, "ACTION_COMPLETED", "Action completed",
					System.currentTimeMillis() - startedAt, true, false);
		} catch (RuntimeException exception) {
			String reason = exception instanceof AgentDomainException domain ? domain.code() : "ACTION_REJECTED";
			emit(request, ServerActionState.FAILED, reason, safeMessage(exception),
					System.currentTimeMillis() - startedAt, true, false);
		}
	}

	public static boolean isArenaScriptPrimitive(ActionType type) {
		return ARENA_SCRIPT_PRIMITIVES.contains(Objects.requireNonNull(type, "type must not be null"));
	}

	public static void requireArenaScriptPrimitive(ActionType type) {
		if (!isArenaScriptPrimitive(type)) {
			throw new AgentDomainException("UNSUPPORTED_ARENA_SCRIPT_ACTION", "ArenaScript cannot invoke " + type.wireName());
		}
	}

	public synchronized void tick() {
		tick(Set.of());
	}

	/** Ticks every action except those of the held agents, whose acceptance is not durable yet. */
	public synchronized void tick(Set<AgentId> held) {
		tick(held, Set.of());
	}

	/**
	 * As {@link #tick(Set)}; actions of {@code paused} agents (a reflex holds the body) are not ticked either, and the
	 * time they wait there does not count toward their timeouts or stall limits.
	 */
	public synchronized void tick(Set<AgentId> held, Set<AgentId> paused) {
		tick(held, paused, ignored -> null);
	}

	/** As {@link #tick(Set, Set)}; {@code firingRule} names the reflex rule holding a paused agent (for the result text). */
	public synchronized void tick(Set<AgentId> held, Set<AgentId> paused, java.util.function.Function<AgentId, String> firingRule) {
		long now = System.currentTimeMillis();
		retryPendingPublications();
		tickShiftHolds();
		List<ActiveAction> actions = new ArrayList<>(active.values());
		try (ServerPathPlanner.TickScope ignored = ServerPathPlanner.beginServerTick()) {
			for (PendingRespawn pending : new ArrayList<>(pendingRespawns.values())) {
				if (held.contains(pending.request().agentId())) continue;
				if (pending.attempt() == null) startRespawn(pending, now);
				else tickRespawn(pending, now);
			}
			for (ActiveAction action : new ArrayList<>(quarantinedActions.values())) {
				CleanupRetry<ServerActionResult> pending = pendingCompletions.get(action.request().agentId());
				if (pending != null) finish(action, pending.pending());
			}
			if (actions.isEmpty()) return;
			long serverTick = manager.server() == null ? 0L : manager.server().getTickCount();
			int start = roundRobinStart(pathfindingRoundRobinCursor, actions.size());
			pathfindingRoundRobinCursor++;
			for (int offset = 0; offset < actions.size(); offset++) {
				ActiveAction action = actions.get((start + offset) % actions.size());
				long sinceLastLoop = action.lastLoopMs == 0L ? 0L : Math.max(0L, now - action.lastLoopMs);
				action.lastLoopMs = now;
				if (paused.contains(action.request().agentId())) {
					action.pausedMs += sinceLastLoop;
					action.pauseUnder(firingRule.apply(action.request().agentId()));
					continue;
				}
				if (held.contains(action.request().agentId())) continue;
				if (hasPendingPublication(action.request().agentId())) continue;
				CleanupRetry<ServerActionResult> pending = pendingCompletions.get(action.request().agentId());
				if (pending != null) {
					finish(action, pending.pending());
					continue;
				}
				ServerActionResult result;
				action.serverTick = serverTick;
				long restore = ElapsedTimeAccumulator.pausedFor(action.pausedMs);
				try {
					try {
						action.resumeAfterPause();
						// The ground an acting body walks stays known behind it (a backstep, a retreat).
						if (action.player != null && action.player.isAlive()) dev.agaminggod.arenaagents.server.perception.SeenTerrain.feel(action.player);
						result = action.tick(now);
					} catch (RuntimeException exception) {
						// A non-domain exception is a bug: its stack names the source (an expired input lease had none in the result).
						if (!(exception instanceof AgentDomainException))
							LOGGER.warn("Action {} {} failed with ACTION_EXCEPTION", action.request().type().wireName(), action.request().actionId(), exception);
						result = action.result(ServerActionState.FAILED, failureReason(exception), safeMessage(exception), now)
							.withCause(placementCause(action.request(), exception));
					}
					if (result != null) {
						finish(action, result);
					} else {
						ServerActionProgress progress = action.progress(now);
						if (progress != null) publishProgressBestEffort(progressSink, progress);
					}
				} finally {
					ElapsedTimeAccumulator.pausedFor(restore);
				}
			}
		}
	}

	/** Fences coordinator-owned physical work when the authenticated session disappears. */
	public synchronized void coordinatorDisconnected() {
		coordinatorGeneration++;
		// Disconnect transitions cancel goal actions, but an idle or completed agent's lifecycle does not change,
		// so its detached action must be fenced here: nobody would hear its result or stop it otherwise.
		for (ActiveAction action : new ArrayList<>(active.values())) {
			if (action.isControl()) continue;
			AgentId agentId = action.request().agentId();
			boolean detached;
			try {
				detached = dev.agaminggod.arenaagents.agent.AgentLifecycleReducer.isDetachedActionState(
						manager.registry().require(agentId).state());
			} catch (RuntimeException unknown) {
				detached = false;
			}
			if (detached) {
				try {
					cancel(agentId, "Coordinator disconnected");
				} catch (RuntimeException ignored) {
					// Best effort, like the control neutralization below.
				}
			}
		}
		for (ActiveAction action : new ArrayList<>(active.values())) {
			if (!action.isControl()) continue;
			try {
				finishDisconnectedControl(
						active,
						action.request().agentId(),
						action,
						() -> {
							ServerTransactionAdapter.runBestEffort(
									() -> pendingCompletions.remove(action.request().agentId()),
									action::neutralizeDisconnectedControl,
									() -> releaseResourceLease(action)
							);
						},
						() -> {
							try {
								router.actionFinished(action.request().agentId(), action.request().goalRevision());
							} catch (AgentDomainException stale) { }
						}
				);
			} catch (RuntimeException ignored) {
				// Every neutralization step is best effort and the action has already been fenced from later ticks.
			}
		}
		for (PendingRespawn pending : new ArrayList<>(pendingRespawns.values())) {
			finishDisconnectedRespawn(
					pendingRespawns,
					pending.request().agentId(),
					pending,
					() -> { if (pending.attempt() != null) AgentChatReporter.respawnDisconnected(manager, pending.attempt().deadRecord()); }
			);
		}
	}

	static boolean finishDisconnectedControl(
			Map<AgentId, ?> activeActions,
			AgentId agentId,
			Object action,
			Runnable neutralize,
			Runnable lifecycleFinish
	) {
		if (!activeActions.remove(agentId, action)) return false;
		try {
			neutralize.run();
		} finally {
			lifecycleFinish.run();
		}
		return true;
	}

	static boolean finishDisconnectedRespawn(
			Map<AgentId, ?> pendingRespawns,
			AgentId agentId,
			Object pending,
			Runnable terminalReport
	) {
		if (!pendingRespawns.remove(agentId, pending)) return false;
		terminalReport.run();
		return true;
	}

	private void tickRespawn(PendingRespawn pending, long now) {
		try {
			if (!isCurrentCoordinatorGeneration(pending.coordinatorGeneration(), coordinatorGeneration)) {
				pendingRespawns.remove(pending.request().agentId(), pending);
				return;
			}
			CodexAgentManager.VerifiedRespawnState state = manager.verifiedRespawnState(pending.attempt());
			if (state == CodexAgentManager.VerifiedRespawnState.PENDING) return;
			pendingRespawns.remove(pending.request().agentId(), pending);
			if (state == CodexAgentManager.VerifiedRespawnState.SUCCEEDED) {
				quarantinedAgents.remove(pending.request().agentId());
				emit(pending.request(), ServerActionState.SUCCEEDED, "VANILLA_RESPAWNED",
						"Respawned at the vanilla target", pending.elapsedTime().advance(now), true, true);
			} else {
				emit(pending.request(), ServerActionState.FAILED, "RESPAWN_REJECTED",
						"The server-owned respawn did not complete", pending.elapsedTime().advance(now), false, false);
			}
		} catch (RuntimeException exception) {
			pendingRespawns.remove(pending.request().agentId(), pending);
			if (!isCurrentCoordinatorGeneration(pending.coordinatorGeneration(), coordinatorGeneration)
					|| isCoordinatorDisconnected(exception)) return;
			String reason = exception instanceof AgentDomainException domain ? domain.code() : "RESPAWN_REJECTED";
			emit(pending.request(), ServerActionState.FAILED, reason, safeMessage(exception), pending.elapsedTime().advance(now), false, false);
		}
	}

	private static boolean isCoordinatorDisconnected(RuntimeException exception) {
		return exception instanceof dev.agaminggod.arenaagents.server.bridge.BridgeProtocolException bridge
				&& "COORDINATOR_DISCONNECTED".equals(bridge.code());
	}

	static boolean isCurrentCoordinatorGeneration(long actionGeneration, long currentGeneration) {
		return actionGeneration == currentGeneration;
	}

	static int roundRobinStart(long cursor, int activeActionCount) {
		if (activeActionCount <= 0) return 0;
		return (int) Math.floorMod(cursor, activeActionCount);
	}

	static void publishProgressBestEffort(
			Consumer<ServerActionProgress> progressSink,
			ServerActionProgress progress
	) {
		try {
			progressSink.accept(progress);
		} catch (RuntimeException ignored) {
			// Progress is advisory telemetry; bridge backpressure must never abort the server tick.
		}
	}

	/** Fails an action that was admitted but has not ticked yet, so the model can retry it. */
	public synchronized boolean rejectUnstarted(ServerActionRequest request, String reasonCode, String message) {
		PendingRespawn respawn = pendingRespawns.get(request.agentId());
		if (respawn != null && respawn.attempt() == null && respawn.request().equals(request)) {
			pendingRespawns.remove(request.agentId(), respawn);
			emit(request, ServerActionState.FAILED, reasonCode, message, respawn.elapsedTime().advance(System.currentTimeMillis()), false, false);
			return true;
		}
		ActiveAction action = active.get(request.agentId());
		if (action == null || !action.request().equals(request)) return false;
		finish(action, action.result(ServerActionState.FAILED, reasonCode, message, System.currentTimeMillis()));
		return true;
	}

	public synchronized boolean cancel(AgentId agentId, String reason) {
		PendingRespawn respawn = pendingRespawns.remove(agentId);
		if (respawn != null) {
			long elapsedMs = respawn.elapsedTime().advance(System.currentTimeMillis());
			// An unstarted respawn has no attempt to roll back; cancelling it only frees the slot.
			if (respawn.attempt() == null || manager.cancelVerifiedRespawn(respawn.attempt())) {
				emit(respawn.request(), ServerActionState.CANCELLED, "ACTION_CANCELLED",
						reason == null ? "Action cancelled" : reason, elapsedMs, false, false);
			} else {
				CodexAgentManager.VerifiedRespawnState state = manager.verifiedRespawnState(respawn.attempt());
				if (state == CodexAgentManager.VerifiedRespawnState.SUCCEEDED) {
					quarantinedAgents.remove(agentId);
					emit(respawn.request(), ServerActionState.SUCCEEDED, "VANILLA_RESPAWNED",
							"Respawned at the vanilla target", elapsedMs, true, true);
				} else {
					emit(respawn.request(), ServerActionState.FAILED, "RESPAWN_REJECTED",
							"The server-owned respawn did not complete", elapsedMs, false, false);
				}
			}
			return true;
		}
		ActiveAction action = active.get(agentId);
		if (action == null) action = quarantinedActions.get(agentId);
		if (hasPendingPublication(agentId)) return true;
		if (action == null) return false;
		String cancellationReason = reason == null ? "Action cancelled" : reason;
		CleanupRetry<ServerActionResult> pending = pendingCompletions.get(agentId);
		if (pending != null) {
			finish(action, pending.pending());
			return true;
		}
		// A menu move or craft that already committed (its linger) reports that work, not a cancel, so the
		// model never repeats a move whose items already went across.
		ServerTransactionAdapter.TickResult committed = action.committedTransactionResult();
		ServerActionResult result = committed != null
				? action.result(ServerActionState.SUCCEEDED, committed.reasonCode(), committed.message(), System.currentTimeMillis())
				: action.result(ServerActionState.CANCELLED, "ACTION_CANCELLED", cancellationReason, System.currentTimeMillis());
		try {
			ShiftHold hold = committed == null ? action.detachShiftHold() : null;
			if (hold != null) shiftHolds.put(agentId, hold);
			action.cancel(cancellationReason);
		} catch (RuntimeException teardownFailure) {
			CleanupRetry<ServerActionResult> retry = new CleanupRetry<>();
			retry.retain(result);
			retry.recordFailure();
			pendingCompletions.put(agentId, retry);
			return true;
		}
		if (committed == null && action.controller instanceof ServerFightController fight) {
			result = action.result(ServerActionState.CANCELLED, "ACTION_CANCELLED",
					cancellationReason + fight.stoppedBodyFacts(action.player), System.currentTimeMillis());
		} else if (committed == null && action.controller instanceof ServerNavigationController navigation) {
			result = action.result(ServerActionState.CANCELLED, "ACTION_CANCELLED",
					cancellationReason + navigation.stoppedBodyFacts(action.player), System.currentTimeMillis());
		}
		complete(action, result);
		return true;
	}

	private void tickShiftHolds() {
		for (var iterator = shiftHolds.entrySet().iterator(); iterator.hasNext(); ) {
			var entry = iterator.next();
			ShiftHold hold = entry.getValue();
			ServerPlayer player = hold.player();
			boolean keep = !active.containsKey(entry.getKey()) && player.isAlive() && !player.isRemoved() && player.onGround()
					&& player.hurtTime == 0 && !player.isInWater() && !player.onClimbable()
					&& hold.settling().hold(true, player.getDeltaMovement().horizontalDistance());
			try {
				LeasedServerInputController input = AgentInputRuntime.controller(player);
				if (keep) input.apply(hold.lease(), new AgentInputState(0, 0, false, true, false, false, false,
						player.getYRot(), player.getXRot(), player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
				else input.release(hold.lease());
			} catch (LeasedServerInputController.StaleInputLeaseException ignored) {
				// A lifecycle clear already revoked it.
				keep = false;
			}
			if (!keep) iterator.remove();
		}
	}

	private void releaseShiftHold(AgentId agentId) {
		ShiftHold hold = shiftHolds.remove(agentId);
		if (hold == null) return;
		try {
			AgentInputRuntime.controller(hold.player()).release(hold.lease());
		} catch (LeasedServerInputController.StaleInputLeaseException ignored) {
			// A lifecycle clear already revoked it.
		}
	}

	public synchronized boolean cancel(AgentId agentId, long goalRevision, String actionId, String reason) {
		Objects.requireNonNull(agentId, "agentId must not be null");
		Objects.requireNonNull(actionId, "actionId must not be null");
		ActiveAction action = active.get(agentId);
		if (action == null) action = quarantinedActions.get(agentId);
		PendingRespawn respawn = pendingRespawns.get(agentId);
		if (action == null && respawn == null) return false;
		if (respawn != null) {
			if (!matchesCancellation(respawn.request(), goalRevision, actionId)) throw new AgentDomainException("STALE_ACTION", "Cancellation does not match the active action");
			return cancel(agentId, reason);
		}
		if (!matchesCancellation(action.request(), goalRevision, actionId)) {
			throw new AgentDomainException("STALE_ACTION", "Cancellation does not match the active action");
		}
		return cancel(agentId, reason);
	}

	static boolean matchesCancellation(ServerActionRequest request, long goalRevision, String actionId) {
		Objects.requireNonNull(request, "request must not be null");
		return request.goalRevision() == goalRevision && request.actionId().equals(actionId);
	}

	private void complete(ActiveAction action, ServerActionResult result) {
		TerminalPublication<ServerActionResult> publication = retainPublication(result, action);
		attemptPublication(action, publication);
	}

	private boolean actionInFlight(AgentId agentId) {
		return active.containsKey(agentId)
				|| quarantinedActions.containsKey(agentId)
				|| pendingCompletions.containsKey(agentId)
				|| hasPendingPublication(agentId)
				|| pendingRespawns.containsKey(agentId);
	}

	public synchronized ServerActionResult lastResult(AgentId agentId) {
		return lastResults.get(agentId);
	}

	/** Returns the active request for one agent without materializing the full active set. */
	public synchronized ServerActionRequest activeRequest(AgentId agentId) {
		Objects.requireNonNull(agentId, "agentId must not be null");
		ActiveAction action = active.get(agentId);
		return action == null ? null : action.request();
	}

	/** The running navigation's planned route (feet cells ahead), empty when none. Read-only, for audits. */
	public synchronized java.util.List<dev.agaminggod.arenaagents.client.navigation.GridPosition> activeRoute(AgentId agentId) {
		ActiveAction action = active.get(agentId);
		return action != null && action.controller instanceof ServerNavigationController navigation ? navigation.plannedRoute() : java.util.List.of();
	}

	/** The running action's block target or destination block, or null. Read-only, for audits. */
	public synchronized BlockPos activeTarget(AgentId agentId) {
		ActiveAction action = active.get(agentId);
		if (action == null) return null;
		if (action.block != null) return action.block;
		return action.destination == null ? null : BlockPos.containing(action.destination);
	}

	public com.google.gson.JsonArray furnaceFacts(ServerPlayer player) {
		return advancedInteractions.furnaces.sample(player);
	}

	private ActiveAction createAction(ServerActionRequest request, ServerPlayer player) {
		JsonObject arguments = request.arguments();
		if ((request.type() == ActionType.FIGHT_TARGET || request.type() == ActionType.USE_RANGED) && arguments.has("untilItem"))
			return countFight(request, player, arguments);
		if (request.type() == ActionType.USE_RANGED
				&& !(player.getMainHandItem().getItem() instanceof net.minecraft.world.item.BowItem)
				&& !(player.getOffhandItem().getItem() instanceof net.minecraft.world.item.BowItem)) {
			InteractionHand throwingHand = ThrowPreview.supported(player.getMainHandItem()) ? InteractionHand.MAIN_HAND
					: ThrowPreview.supported(player.getOffhandItem()) ? InteractionHand.OFF_HAND : null;
			if (throwingHand != null) {
				if (arguments.has("untilDead") && bool(arguments, "untilDead"))
					throw new AgentDomainException("BOW_NOT_EQUIPPED", "untilDead keeps drawing a bow; a thrown item is one use per call");
				Entity target = resolveExactObservedTarget(player, string(arguments, "targetId"));
				ServerRangedUseController.TargetFacts targetFacts = ServerRangedUseController.TargetFacts.from(target, protection.mayUseRangedWeapon(player, target));
				if (!targetFacts.eligible())
					throw new AgentDomainException("RANGED_TARGET_DENIED", "Ranged target is protected or not projectile-hittable");
				ActiveAction action = ActiveAction.use(request, player, integer(arguments, "timeoutMs"), throwingHand, null, true);
				Vec3 fixedAim = arguments.has("aimX") ? new Vec3(number(arguments, "aimX"), number(arguments, "aimY"), number(arguments, "aimZ"))
						: TargetSightline.rangedEntity(player, target);
				action.useAim = arguments.has("trackTarget") && bool(arguments, "trackTarget")
						? () -> TargetSightline.rangedEntity(player, resolveExactObservedTarget(player, string(arguments, "targetId"))) : () -> fixedAim;
				return action;
			}
		}
		return switch (request.type()) {
			case CONTROL -> ActiveAction.control(
					request,
					player,
					new AgentInputState(
							(float) number(arguments, "forward"),
							(float) number(arguments, "strafe"),
							bool(arguments, "jump"),
							bool(arguments, "sneak"),
							bool(arguments, "sprint"),
							bool(arguments, "attack"),
							bool(arguments, "use"),
							(float) number(arguments, "yaw"),
							(float) number(arguments, "pitch"),
							integer(arguments, "selectedSlot"),
							hand(arguments)
					),
					integer(arguments, "ticks"),
					ControlSequence.instantLook(arguments)
			);
			case CONTROL_SEQUENCE -> ActiveAction.controlSequence(request, player, ControlSequence.parse(arguments));
			case MOVE_TO, NAVIGATE_TO -> {
				Vec3 requested = new Vec3(number(arguments, "x"), number(arguments, "y"), number(arguments, "z"));
				Vec3 standing = ServerNavigationController.standingInColumn(
						new dev.agaminggod.arenaagents.server.runtime.controller.MinecraftNavigationWorld(player.level(), player), requested);
				ActiveAction action = ActiveAction.controller(
						request,
						player,
						new ServerNavigationController(
								standing == null ? requested : standing,
								number(arguments, "tolerance"),
								bool(arguments, "sprint"),
								System.currentTimeMillis(),
								arguments.has("timeoutMs") ? integer(arguments, "timeoutMs") : DEFAULT_TIMEOUT_MS,
								true
						)
				);
				if (standing != null) action.destinationNote = String.format(java.util.Locale.ROOT,
						"; requested %s is %s, so the target became the standing spot %.1f,%.0f,%.1f", cell(BlockPos.containing(requested)),
						standing.y > requested.y ? "a seen solid block" : "open air over seen ground", standing.x, standing.y, standing.z);
				yield action;
			}
			case TRAVEL_TO -> {
				double[] target = arguments.has("x") ? new double[] {number(arguments, "x"), number(arguments, "z")}
						: dev.agaminggod.arenaagents.server.runtime.controller.ServerTravelController.headingTarget(
								player.position(), number(arguments, "yaw"), number(arguments, "distance"));
				if (arguments.has("retrace") && bool(arguments, "retrace")) {
     yield ActiveAction.controller(request, player, new dev.agaminggod.arenaagents.server.runtime.controller.ServerRetraceController(
       arguments.has("dimension") ? string(arguments,"dimension") : player.level().dimension().identifier().toString(),
       target[0], number(arguments,"y"), target[1], arguments.has("tolerance") ? number(arguments,"tolerance") : 1,
       arguments.has("timeoutMs") ? integer(arguments,"timeoutMs") : 300_000L,
       !arguments.has("build") || bool(arguments,"build"), nullableString(arguments,"stopWhenSeen"),
       arguments.has("minHealth") ? (float)number(arguments,"minHealth") : null,
       (body, cell) -> protection.mayModifyBlock(body,body.level(),cell),
       toY -> {
        JsonObject shaft=new JsonObject();shaft.addProperty("pattern","shaft");shaft.addProperty("y",toY);shaft.addProperty("maxShaftY",toY);shaft.addProperty("throughCaves",false);shaft.addProperty("timeoutMs",arguments.has("timeoutMs")?integer(arguments,"timeoutMs"):300_000L);
        return digController(shaft);
       },System.currentTimeMillis()));
    }
    yield ActiveAction.controller(request, player, new dev.agaminggod.arenaagents.server.runtime.controller.ServerTravelController(
      target[0], arguments.has("y") ? number(arguments, "y") : Double.NaN, target[1],
						arguments.has("tolerance") ? number(arguments, "tolerance") : 3.0D,
						arguments.has("timeoutMs") ? integer(arguments, "timeoutMs")
								: dev.agaminggod.arenaagents.server.runtime.controller.ServerTravelController.DEFAULT_TIMEOUT_MS,
						!arguments.has("build") || bool(arguments, "build"),
						nullableString(arguments, "stopWhenSeen"),
						arguments.has("minHealth") ? (float) number(arguments, "minHealth") : null,
						(body, cell) -> protection.mayModifyBlock(body, body.level(), cell),
						System.currentTimeMillis()).fightThrough(arguments.has("fightThrough") && bool(arguments, "fightThrough")));
			}
			case DIG_TO -> ActiveAction.controller(request, player, digController(arguments));
			case BUILD_SHELTER -> ActiveAction.controller(request, player, shelterController(request, arguments));
			// Model-chosen goal skills: the model picks the site or item and the count; the body repeats the clicks.
			case CAST_OBSIDIAN -> ActiveAction.controller(request, player, new ServerCastObsidianController(
					BlockPos.containing(number(arguments, "x"), number(arguments, "y"), number(arguments, "z")),
					nullableString(arguments, "axis"), arguments.has("frame") && bool(arguments, "frame"),
					arguments.has("count") ? integer(arguments, "count") : 4, integer(arguments, "timeoutMs"), System.currentTimeMillis(),
					(body, cell) -> protection.mayModifyBlock(body, body.level(), cell)));
			case BARTER_UNTIL -> ActiveAction.controller(request, player, new ServerBarterController(
					string(arguments, "itemId"), integer(arguments, "count"), integer(arguments, "timeoutMs"), System.currentTimeMillis()));
			// Turns over a few ticks like a player instead of snapping; finishes on the exact lookAt rotation.
			case LOOK_AT -> ActiveAction.controller(request, player, new ServerLookController(new Vec3(
					number(arguments, "x"),
					number(arguments, "y"),
					number(arguments, "z")
			)));
			// Aim like a player first (eased turn, settled look), then the vanilla hit.
			case ATTACK -> ActiveAction.aimedAtEntity(request, player,
					() -> resolveExactObservedTarget(player, string(arguments, "targetId")),
					() -> attack(player, string(arguments, "targetId")));
			// Persistent model-chosen combat: the model decides to fight or flee, the controller makes it effective.
			case FIGHT_TARGET -> ActiveAction.controller(request, player, strikePart(player, string(arguments, "targetId"), new ServerFightController(
					combatTarget(player, string(arguments, "targetId")),
					arguments.has("desiredRange") ? number(arguments, "desiredRange") : null,
					arguments.has("fleeAtHealth") ? (float) number(arguments, "fleeAtHealth") : null,
					continueWithAttackers(arguments),
					// The model chooses the policy; the controller only applies it (named by default).
					dev.agaminggod.arenaagents.server.runtime.controller.CombatPlanning.TargetPolicy.parse(
							nullableString(arguments, "targetPolicy")),
					// Players are follow-through or policy candidates only when the model opts in.
					arguments.has("includePlayers") && bool(arguments, "includePlayers"),
					!arguments.has("pursue") || bool(arguments, "pursue"),
					arguments.has("sneak") && bool(arguments, "sneak"),
					arguments.has("shield") && bool(arguments, "shield"),
					integer(arguments, "timeoutMs"), System.currentTimeMillis())
					.collectDrops(arguments.has("collect") && bool(arguments, "collect") ? protection::mayTakeEntity : null)));
			// Model-chosen goal skill (Lucas, Oct 28): fight one mob type until an item count, each engagement a fight_target or volley.
			case FIGHT_UNTIL -> ActiveAction.controller(request, player, new dev.agaminggod.arenaagents.server.runtime.controller.ServerFightUntilController(
					player, arguments, protection, System.currentTimeMillis(), "fight_until", null, roofing(request)));
			case FLEE_FROM -> ActiveAction.controller(request, player, new ServerFleeController(
					resolveCombatTarget(player, string(arguments, "targetId")),
					number(arguments, "distance"), integer(arguments, "timeoutMs"), System.currentTimeMillis()));
			case SELECT_ITEM -> ActiveAction.immediate(request, player,
					() -> selectItem(player, string(arguments, "itemId")));
			case USE_ITEM -> {
				ActiveAction action = ActiveAction.use(request, player, integer(arguments, "durationMs"),
						nullableString(arguments, "hand") != null ? hand(arguments) : InteractionHand.MAIN_HAND,
						nullableString(arguments, "expectedItemId"), "once".equals(nullableString(arguments, "mode")));
				action.inspectThrow = "inspect".equals(nullableString(arguments, "mode"));
				if (arguments.has("aimX")) action.useAim = () -> new Vec3(number(arguments, "aimX"), number(arguments, "aimY"), number(arguments, "aimZ"));
				action.acceptLavaRisk = arguments.has("acceptLavaRisk") && bool(arguments, "acceptLavaRisk");
				yield action;
			}
			case INTERACT_BLOCK -> ActiveAction.aimed(request, player, () -> {
				BlockPos position = blockPosition(arguments);
				return blockInteractionAimPoint(player, position, Direction.byName(string(arguments, "face")), arguments);
			}, () -> interactBlock(
					player,
					blockPosition(arguments),
					Direction.byName(string(arguments, "face")),
					hand(arguments),
					string(arguments, "expectedItemId"), arguments
			));
			case INTERACT_ENTITY -> ActiveAction.aimed(request, player,
					() -> entityInteractionAimPoint(player, resolveExactObservedTarget(player, string(arguments, "targetId")), arguments),
					() -> interactEntity(
					player,
					string(arguments, "targetId"),
					hand(arguments),
					string(arguments, "expectedItemId"), arguments
			));
			case DISMOUNT -> ActiveAction.immediate(request, player, () -> dismount(player));
			case START_FALL_FLYING -> ActiveAction.immediate(request, player, () -> startFallFlying(player));
			case WAKE_UP -> ActiveAction.immediate(request, player, () -> {
				if (!player.isSleeping()) throw new AgentDomainException("NOT_SLEEPING", "Player is not sleeping");
				player.stopSleepInBed(false, true);
				if (player.isSleeping()) throw new AgentDomainException("WAKE_NOT_CONFIRMED", "Vanilla wake-up was not observed");
			});
			case SET_FLIGHT -> {
				boolean enabled = bool(arguments, "enabled");
				if (enabled && !player.getAbilities().mayfly) throw new AgentDomainException("FLIGHT_NOT_ALLOWED", "Current player abilities do not permit flight");
				// Enabling is confirmed a tick later: landing ends flight, so a body that cannot rise reports it.
				yield enabled
						? ActiveAction.controller(request, player, new dev.agaminggod.arenaagents.server.runtime.controller.ServerFlightController())
						: ActiveAction.immediate(request, player, () -> {
							player.getAbilities().flying = false;
							player.onUpdateAbilities();
						});
			}
			case WRITE_SIGN -> {
				ActiveAction action = ActiveAction.transaction(request, player, PlayerTextInteraction.writeSign(player, arguments, protection));
				action.transactionAimTarget = () -> TargetSightline.block(player, blockPosition(arguments), null);
				yield action;
			}
			case EDIT_BOOK -> ActiveAction.transaction(request, player, PlayerTextInteraction.editBook(player, arguments));
			case BREAK_BLOCK -> {
				BlockPos position = blockPosition(arguments);
				String requestedExpectation = optionalExpectedBlockId(arguments);
				BreakTarget target = validateBreakTarget(player, position, requestedExpectation);
				// An omitted or tag expectation is resolved to the block actually there; the running action then guards that id.
				String expectedBlockId = target.blockId();
				String lava = arguments.has("acceptLavaRisk") && bool(arguments, "acceptLavaRisk") ? null : lavaBehind(player, position);
				if (lava != null) {
					throw new AgentDomainException("LAVA_BEHIND", "Lava is " + lava + "; breaking it may let lava flow in."
							+ " Not swung; acceptLavaRisk:true breaks it anyway");
				}
				String unseen = arguments.has("acceptLavaRisk") && bool(arguments, "acceptLavaRisk") ? null : unseenDropUnderFeet(player, position);
				if (unseen != null) throw new AgentDomainException("UNSEEN_BELOW", unseen + " Not swung; acceptLavaRisk:true breaks it anyway");
				ActiveAction action = ActiveAction.breakBlock(
						request, player, position, integer(arguments, "timeoutMs"), target.blockId(), expectedBlockId, target.aim());
				action.plantProtection = at -> {
					if (!protection.mayModifyBlock(player, player.level(), at)
							|| !player.level().mayInteract(player, at)
							|| player.level().getServer().isUnderSpawnProtection(player.level(), at, player)) {
						throw new AgentDomainException("PROTECTION_DENIED", "Clearing the obstructing plant was denied");
					}
				};
				action.breakNamesBlock = requestedExpectation == null || requestedExpectation.startsWith("#");
				yield action;
			}
			case PLACE_BLOCK -> {
				BlockPos position = blockPosition(arguments);
				String itemId = string(arguments, "itemId");
				SeenTerrain.Reader<BlockState> placementSeen = SeenTerrain.of(player);
				String initialBlockId = placementSeen.seesNow(position.getX(), position.getY(), position.getZ())
						? blockId(perceivedPlacementState(placementSeen, position)) : null;
				String expectedBlockId = expectedBlockId(itemId);
				DesiredBlockState desiredBlockState = DesiredBlockState.parse(
						arguments.has("desiredState") && !arguments.get("desiredState").isJsonNull()
								? arguments.get("desiredState").getAsString() : null,
						expectedBlockId
				);
				Direction requestedFace = Direction.byName(string(arguments, "face"));
				boolean strictFace = arguments.has("faceMode") && "strict".equals(arguments.get("faceMode").getAsString());
				if (initialBlockId != null && !desiredBlockState.acceptsBlockId(initialBlockId)) {
					validatePlaceBlock(protection, player, position, requestedFace, itemId, strictFace, desiredBlockState);
				}
				int initialItemCount = inventoryItemCount(player, itemId);
				String resourceKey = blockResourceKey(player, position);
				if (!resourceLeases.acquire(
						resourceKey,
						request.agentId(),
						System.currentTimeMillis(),
						PLACE_TIMEOUT_MS
				)) {
					throw new AgentDomainException("RESOURCE_BUSY", "Another agent is already placing at this target");
				}
				try {
					ActiveAction action = ActiveAction.placeBlock(
							request,
							player,
							() -> placeBlock(protection, player, position, requestedFace, itemId, desiredBlockState, strictFace),
							position,
							initialBlockId,
							expectedBlockId,
							desiredBlockState,
							requestedFace,
							itemId,
							initialItemCount
					);
					action.placementStrictFace = strictFace;
					action.resourceLeaseKey = resourceKey;
					yield action;
				} catch (RuntimeException exception) {
					resourceLeases.release(resourceKey, request.agentId());
					throw exception;
				}
			}
			case CHAT -> ActiveAction.immediate(request, player, () -> sendConversation(request, arguments));
			case WAIT -> ActiveAction.waitFor(request, player, integer(arguments, "durationMs"));
			case SET_DOOR -> ActiveAction.aimed(request, player, () -> TargetSightline.block(player, blockPosition(arguments), null), () -> requireResult(
					advancedInteractions.setDoor(
							request.agentId(),
							player,
							blockPosition(arguments),
							bool(arguments, "open")
					)
			));
			case PICK_UP_ITEM -> {
				ItemEntity item;
				try {
					item = findItem(player, string(arguments, "targetSelector"));
				} catch (AgentDomainException unavailable) {
					if (!"ITEM_ALREADY_PICKED_UP".equals(unavailable.code())) throw unavailable;
					yield ActiveAction.controller(request, player, collectedPickup(unavailable.getMessage()));
				}
				requireResult(advancedInteractions.validatePickUp(player, item));
				yield ActiveAction.controller(request, player,
						new ServerItemPickupController(player, item, System.currentTimeMillis()));
			}
			case DROP_ITEM -> ActiveAction.immediate(request, player, () -> requireResult(
					advancedInteractions.drop(player, integer(arguments, "slot"), integer(arguments, "count"))
			));
			case TRANSFER_CONTAINER, CRAFT_INVENTORY, CRAFT_TABLE, FURNACE_TRANSACTION,
					EQUIP_ITEM, SELECT_TOOL, BLOCK_WITH_SHIELD, USE_RANGED,
					MENU_TRANSFER, MENU_BUTTON, ANVIL_RENAME, MENU_CLICK, MENU_CLOSE, BEACON_EFFECTS -> {
				ActiveAction action = ActiveAction.transaction(
						request,
						player,
						advancedInteractions.begin(player, request, arguments)
				);
				if (request.type() == ActionType.CRAFT_TABLE || request.type() == ActionType.FURNACE_TRANSACTION
						|| request.type() == ActionType.TRANSFER_CONTAINER) {
					action.transactionAimTarget = () -> TargetSightline.block(player, blockPosition(arguments), null);
				}
				yield action;
			}
			case RESPAWN, COMPLETE_GOAL -> throw new IllegalStateException("respawn and complete_goal are handled before action creation");
			default -> throw new AgentDomainException(
					"UNSUPPORTED_ACTION",
					"Action type is not supported by the server executor: " + request.type().wireName()
			);
		};
	}

	private void finish(ActiveAction action, ServerActionResult result) {
		AgentId agentId = action.request().agentId();
		CleanupRetry<ServerActionResult> retry = pendingCompletions.computeIfAbsent(agentId, ignored -> new CleanupRetry<>());
		retry.retain(result);
		ServerActionResult completed;
		try {
			completed = retry.complete(action::cleanup);
		} catch (RuntimeException teardownFailure) {
			if (retry.exhausted(MAX_CLEANUP_ATTEMPTS) && !quarantinedAgents.containsKey(agentId)) {
				quarantine(action, teardownFailure);
			}
			return;
		}
		if (quarantinedAgents.containsKey(agentId)) {
			recoverQuarantined(action);
			return;
		}
		complete(action, completed);
	}

	private void quarantine(ActiveAction action, RuntimeException teardownFailure) {
		AgentId agentId = action.request().agentId();
		String message = "Action cleanup failed after " + MAX_CLEANUP_ATTEMPTS
				+ " attempts; physical actions are quarantined while cleanup retries automatically: "
				+ safeMessage(teardownFailure);
		quarantinedAgents.put(agentId, message);
		active.remove(agentId, action);
		quarantinedActions.put(agentId, action);
		publish(action.result(ServerActionState.FAILED, "ACTION_CLEANUP_FAILED", message, System.currentTimeMillis()));
	}

	private void recoverQuarantined(ActiveAction action) {
		AgentId agentId = action.request().agentId();
		releaseResourceLease(action);
		try {
			router.actionFinished(agentId, action.request().goalRevision());
		} catch (AgentDomainException stale) { }
		quarantinedActions.remove(agentId, action);
		pendingCompletions.remove(agentId);
		quarantinedAgents.remove(agentId);
	}

	private TerminalPublication<ServerActionResult> retainPublication(
			ServerActionResult result,
			ActiveAction completedAction
	) {
		PublicationKey key = PublicationKey.of(result);
		TerminalPublication<ServerActionResult> existing = pendingPublications.get(key);
		if (existing != null) return existing;
		TerminalPublication<ServerActionResult> publication = new TerminalPublication<>(result, completedAction != null);
		pendingPublications.put(key, publication);
		if (completedAction != null) publicationOwners.put(key, completedAction);
		return publication;
	}

	private boolean hasPendingPublication(AgentId agentId) {
		for (PublicationKey key : pendingPublications.keySet()) if (key.agentId().equals(agentId)) return true;
		return false;
	}

	private void retryPendingPublications() {
		for (var entry : new ArrayList<>(pendingPublications.entrySet())) {
			attemptPublication(publicationOwners.get(entry.getKey()), entry.getValue());
		}
	}

	private void attemptPublication(
			ActiveAction action,
			TerminalPublication<ServerActionResult> publication
	) {
		try {
			boolean delivered = publication.publish(
					() -> preparePublication(action, publication.value()),
					resultSink
			);
			if (!delivered) return;
		} catch (RuntimeException publicationFailure) {
			return;
		}
		ServerActionResult result = publication.value();
		if (action != null) {
			active.remove(result.agentId(), action);
			pendingCompletions.remove(result.agentId());
		}
		PublicationKey key = PublicationKey.of(result);
		if (pendingPublications.remove(key, publication)) publicationOwners.remove(key);
	}

	private void preparePublication(ActiveAction action, ServerActionResult result) {
		if (action != null) {
			releaseResourceLease(action);
			try {
				router.actionFinished(result.agentId(), result.goalRevision());
			} catch (AgentDomainException stale) { }
		}
		lastResults.put(result.agentId(), result);
		actionSuccessLedger.record(result);
		try {
			AgentChatReporter.result(manager, manager.registry().require(result.agentId()), result);
		} catch (RuntimeException ignored) {
			// Terminal delivery must survive presentation or agent-removal races.
		}
	}

	static final class CleanupRetry<T> {
		private T pending;
		private int failureCount;

		synchronized void retain(T candidate) {
			Objects.requireNonNull(candidate, "candidate must not be null");
			if (pending == null) pending = candidate;
		}

		synchronized boolean hasPending() {
			return pending != null;
		}

		synchronized T pending() {
			if (pending == null) throw new IllegalStateException("no cleanup result is pending");
			return pending;
		}

		synchronized T complete(Runnable cleanup) {
			Objects.requireNonNull(cleanup, "cleanup must not be null");
			T retained = pending();
			try {
				cleanup.run();
			} catch (RuntimeException failure) {
				failureCount++;
				throw failure;
			}
			pending = null;
			return retained;
		}

		synchronized int failureCount() {
			return failureCount;
		}

		synchronized void recordFailure() {
			failureCount++;
		}

		synchronized boolean exhausted(int maximumAttempts) {
			if (maximumAttempts <= 0) throw new IllegalArgumentException("maximumAttempts must be positive");
			return failureCount >= maximumAttempts;
		}
	}

	static final class TerminalPublication<T> {
		private enum Phase { NEW, PREPARING, READY, DELIVERING, DELIVERED }

		private final T value;
		private final boolean completesAction;
		private Phase phase = Phase.NEW;

		TerminalPublication(T value) {
			this(value, false);
		}

		TerminalPublication(T value, boolean completesAction) {
			this.value = Objects.requireNonNull(value, "value must not be null");
			this.completesAction = completesAction;
		}

		synchronized T value() {
			return value;
		}

		synchronized boolean hasPending() {
			return phase != Phase.DELIVERED;
		}

		boolean completesAction() {
			return completesAction;
		}

		synchronized boolean publish(Runnable preparation, Consumer<T> sink) {
			Objects.requireNonNull(preparation, "preparation must not be null");
			Objects.requireNonNull(sink, "sink must not be null");
			if (phase == Phase.DELIVERED) return true;
			if (phase == Phase.PREPARING || phase == Phase.DELIVERING) return false;
			if (phase == Phase.NEW) {
				phase = Phase.PREPARING;
				try {
					preparation.run();
					phase = Phase.READY;
				} catch (RuntimeException failure) {
					phase = Phase.NEW;
					throw failure;
				}
			}
			phase = Phase.DELIVERING;
			try {
				sink.accept(value);
				phase = Phase.DELIVERED;
				return true;
			} catch (RuntimeException failure) {
				phase = Phase.READY;
				throw failure;
			}
		}
	}

	private void releaseResourceLease(ActiveAction action) {
		if (action.resourceLeaseKey != null) {
			resourceLeases.release(action.resourceLeaseKey, action.request().agentId());
		}
	}

	private void emit(
			ServerActionRequest request,
			ServerActionState state,
			String reasonCode,
			String message,
			long elapsedMs,
			boolean executionStarted,
			boolean physicalAttempted
	) {
		emit(request, state, reasonCode, message, elapsedMs, executionStarted, physicalAttempted, null);
	}

	private void emit(
			ServerActionRequest request,
			ServerActionState state,
			String reasonCode,
			String message,
			long elapsedMs,
			boolean executionStarted,
			boolean physicalAttempted,
			ServerActionObservation actionObservation
	) {
		emit(request, state, reasonCode, message, elapsedMs, executionStarted, physicalAttempted, actionObservation, null);
	}

	private void emit(ServerActionRequest request, ServerActionState state, String reasonCode, String message,
			long elapsedMs, boolean executionStarted, boolean physicalAttempted, ServerActionObservation actionObservation, String cause) {
		message = placementFailureContext(request, message);
		publish(new ServerActionResult(
				request.agentId(),
				request.goalRevision(),
				request.actionId(),
				request.type(),
				request.traceId(),
				state,
				reasonCode,
				message == null ? "" : message,
				elapsedMs,
				System.currentTimeMillis(),
				executionStarted,
				physicalAttempted,
				actionObservation
		).withCause(cause));
	}

	private void publish(ServerActionResult result) {
		attemptPublication(null, retainPublication(result, null));
	}

	private void publishRespawn(ServerActionResult result, AgentTransition transition, Runnable commit) {
		respawnResultSink.publish(result, transition, commit);
		lastResults.put(result.agentId(), result);
		try {
			AgentChatReporter.result(manager, manager.registry().require(result.agentId()), result);
		} catch (AgentDomainException ignored) { }
	}

	private static ServerActionResult result(
			ServerActionRequest request,
			ServerActionState state,
			String reasonCode,
			String message,
			long elapsedMs,
			boolean executionStarted,
			boolean physicalAttempted
	) {
		return new ServerActionResult(request.agentId(), request.goalRevision(), request.actionId(), request.type(), request.traceId(), state,
				reasonCode, message == null ? "" : message, Math.max(0L, elapsedMs), System.currentTimeMillis(), executionStarted, physicalAttempted);
	}

	@FunctionalInterface
	public interface RespawnResultSink {
		void publish(ServerActionResult result, AgentTransition transition, Runnable commit);
	}

	private record PublicationKey(AgentId agentId, long goalRevision, String actionId) {
		static PublicationKey of(ServerActionResult result) {
			return new PublicationKey(result.agentId(), result.goalRevision(), result.actionId());
		}
	}

	private record PendingRespawn(
			ServerActionRequest request,
			CodexAgentManager.VanillaRespawnAttempt attempt,
			ElapsedTimeAccumulator elapsedTime,
			long coordinatorGeneration
	) { }

	private void attack(ServerPlayer player, String targetId) {
		Entity target = resolveExactObservedTarget(player, targetId);
		if (target instanceof ServerPlayer targetPlayer
				&& (targetPlayer.isCreative() || targetPlayer.isSpectator())) {
			throw new AgentDomainException("TARGET_INVULNERABLE", "Creative and spectator players cannot be valid combat targets");
		}
		if (!protection.mayInteractWithEntity(player, target)) {
			throw new AgentDomainException("PROTECTION_DENIED", "Attack was denied");
		}
		if (!player.isWithinAttackRange(player.getMainHandItem(), target.getBoundingBox(), 0.0D)) {
			throw new AgentDomainException("TARGET_TOO_FAR", "Attack target is out of reach");
		}
		Vec3 aimPoint = attackAimPoint(player, target);
		player.lookAt(net.minecraft.commands.arguments.EntityAnchorArgument.Anchor.EYES, aimPoint);
		HitResult hit = Tracer.rayTrace(player, 1.0F,
				Math.max(player.entityInteractionRange(), player.getEyePosition().distanceTo(aimPoint) + 0.1D), false);
		if (!(hit instanceof EntityHitResult entityHit) || !ObservedEntityTarget.matchesHit(target, entityHit)) {
			throw new AgentDomainException("TARGET_OBSTRUCTED", "Attack target is not under the requested aim ray");
		}
		player.attack(target);
		ArmSwing.attack(player, net.minecraft.world.InteractionHand.MAIN_HAND);
	}

	/** Retains the named target and aims at an exposed part within this held weapon's vanilla reach. */
	private static Vec3 attackAimPoint(ServerPlayer player, Entity target) {
		if (!player.isWithinAttackRange(player.getMainHandItem(), target.getBoundingBox(), 0.0D)) {
			throw new AgentDomainException("TARGET_TOO_FAR", "Attack target is out of reach");
		}
		return TargetSightline.entity(player, target, player.getAttackRangeWith(player.getMainHandItem()).effectiveMaxRange(player));
	}

	/**
	 * True when the crosshair ray from {@code eye} along {@code look} meets {@code box} (or the eye is inside it), the
	 * way a player's crosshair turns red on a mob. Reach is not judged here; the vanilla attack still checks it.
	 */
	static boolean crosshairOnBox(Vec3 eye, Vec3 look, net.minecraft.world.phys.AABB box) {
		if (box.contains(eye)) return true;
		double length = eye.distanceTo(box.getCenter()) + box.getSize();
		return box.clip(eye, eye.add(look.normalize().scale(length))).isPresent();
	}

	private static Vec3 entityInteractionAimPoint(ServerPlayer player, Entity target, JsonObject arguments) {
		return arguments.has("hitX") && !arguments.get("hitX").isJsonNull() ? target.position().add(
				number(arguments, "hitX"), number(arguments, "hitY"), number(arguments, "hitZ")
		) : TargetSightline.entity(player, target, player.entityInteractionRange());
	}

	private net.minecraft.world.entity.LivingEntity combatTarget(ServerPlayer player, String targetId) {
		Entity target = resolveCombatTarget(player, targetId);
		// A player fights the dragon by hitting its parts: a named part is fought through, the dragon is what dies.
		if (target instanceof net.minecraft.world.entity.boss.enderdragon.EnderDragonPart part) target = part.parentMob;
		if (!(target instanceof net.minecraft.world.entity.LivingEntity living)) {
			throw new AgentDomainException("TARGET_NOT_LIVING", "fight_target needs a living entity or a dragon part");
		}
		if (target instanceof ServerPlayer targetPlayer && (targetPlayer.isCreative() || targetPlayer.isSpectator())) {
			throw new AgentDomainException("TARGET_INVULNERABLE", "Creative and spectator players cannot be valid combat targets");
		}
		if (!protection.mayInteractWithEntity(player, target)) {
			throw new AgentDomainException("PROTECTION_DENIED", "Attack was denied");
		}
		return living;
	}

	/** A fight named by a dragon part walks to and swings at that part (vanilla hits land on parts, never the whole dragon). */
	private static ServerFightController strikePart(ServerPlayer player, String targetId, ServerFightController fight) {
		return resolveCombatTarget(player, targetId) instanceof net.minecraft.world.entity.boss.enderdragon.EnderDragonPart part
				? fight.strikingPart(part) : fight;
	}

	/**
	 * Exact UUID like attack, but a reported threat (an enemy targeting, hurting or with sight of the agent within
	 * 16 blocks) is accepted even outside the view cone: the model must be able to fight or flee what is behind it.
	 */
	static Entity resolveCombatTarget(ServerPlayer player, String targetId) {
		try {
			return resolveExactObservedTarget(player, targetId);
		} catch (AgentDomainException hidden) {
			if (!"TARGET_NOT_VISIBLE".equals(hidden.code())) throw hidden;
			Entity target = player.level().getEntity(java.util.UUID.fromString(targetId));
			if (target != null && dev.agaminggod.arenaagents.server.perception.ThreatPerception.isSensedThreat(player, target)) return target;
			// Outside the view cone with a clear line to it, a player turns to what it just saw, as use_ranged does
			// (End runs 2026-10-21: 8 fights on a perched dragon's head failed here at once).
			try {
				return ObservedEntityTarget.resolveInSight(player, targetId);
			} catch (AgentDomainException outOfSight) {
				if (!"TARGET_NOT_VISIBLE".equals(outOfSight.code())) throw outOfSight;
			}
			throw new AgentDomainException("TARGET_NOT_VISIBLE",
					"Target is neither visible nor currently sensed; threat signals can persist after contact. Reacquire it before retrying");
		}
	}

	/** Resolves only the exact UUID supplied from the agent's retained observation. */
	static Entity resolveExactObservedTarget(ServerPlayer player, String targetId) {
		return ObservedEntityTarget.resolve(player, targetId);
	}

	private static void selectItem(ServerPlayer player, String itemId) {
		Identifier identifier = Identifier.tryParse(itemId);
		if (identifier == null || !BuiltInRegistries.ITEM.containsKey(identifier)) {
			throw new AgentDomainException("UNKNOWN_ITEM", "Unknown item: " + itemId);
		}
		int found = selectionSlot(player.getInventory().getContainerSize(), player.getInventory()::getItem, identifier);
		if (found < 0 && player.isCreative()) {
			found = player.getInventory().getSelectedSlot();
			if (!player.getInventory().getItem(found).isEmpty()) {
				throw new AgentDomainException("HOTBAR_SLOT_OCCUPIED", "Select an empty hotbar slot before taking a creative item");
			}
			player.getInventory().setItem(found, new ItemStack(BuiltInRegistries.ITEM.getValue(identifier)));
		}
		if (found < 0) throw new AgentDomainException("ITEM_NOT_FOUND", "Agent does not have " + itemId);
		if (found > 8) throw new AgentDomainException("ITEM_NOT_IN_HOTBAR", notInHotbarMessage(itemId, found));
		OfflineAgentPlayers.actions(player).setSlot(found + 1);
	}

	/** Equal stacks are interchangeable; differing components still require an explicit slot decision. */
	static int selectionSlot(int size, java.util.function.IntFunction<ItemStack> items, Identifier itemId) {
		int found = -1;
		for (int slot = 0; slot < size; slot++) {
			ItemStack stack = items.apply(slot);
			if (stack.isEmpty() || !BuiltInRegistries.ITEM.getKey(stack.getItem()).equals(itemId)) continue;
			if (found >= 0 && !ItemStack.isSameItemSameComponents(items.apply(found), stack)) {
				throw new AgentDomainException("AMBIGUOUS_ITEM", "Matching stacks have different components or durability; choose an exact slot with select_tool or menu_click");
			}
			if (found < 0) found = slot;
		}
		return found;
	}

	static ServerController collectedPickup(String receipt) {
		Objects.requireNonNull(receipt, "collection receipt must be present");
		return (player, now) -> ServerController.TickResult.succeeded("ITEM_ALREADY_PICKED_UP", receipt);
	}

	/** Prepare the hand only for the synchronous placement click; an unclicked selection is reversible. */
	static PlacementSelection selectPlacementItem(ServerPlayer player, String itemId) {
		int previous = player.getInventory().getSelectedSlot();
		if (BuiltInRegistries.ITEM.getKey(player.getMainHandItem().getItem()).toString().equals(itemId))
			return new PlacementSelection(player, previous, -1, previous, "");
		int source = -1;
		for (int slot = 0; slot < 36; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (!stack.isEmpty() && BuiltInRegistries.ITEM.getKey(stack.getItem()).toString().equals(itemId)) { source = slot; break; }
		}
		if (source < 0) {
			if (!player.isCreative()) throw new AgentDomainException("ITEM_NOT_FOUND", "Agent does not have " + itemId);
			selectItem(player, itemId);
			return new PlacementSelection(player, previous, -2, previous, "Selected " + itemId);
		}
		int hotbar = source < 9 ? source : placementHotbarSlot(player);
		if (source >= 9) {
			if (player.containerMenu != player.inventoryMenu) player.closeContainer();
			var failure = AdvancedInteractionService.swapIntoHotbar(player, source, hotbar);
			if (failure != null) throw new AgentDomainException(failure.reasonCode(), failure.message());
		}
		player.getInventory().setSelectedSlot(hotbar);
		return new PlacementSelection(player, previous, source >= 9 ? source : -1, hotbar,
				source < 9 ? "Selected hotbar slot " + hotbar + " for " + itemId
				: "Swapped inventory slot " + source + " with hotbar slot " + hotbar + " and selected " + itemId);
	}

	private static int placementHotbarSlot(ServerPlayer player) {
		for (int slot = 0; slot < 9; slot++) if (player.getInventory().getItem(slot).isEmpty()) return slot;
		for (int slot = 0; slot < 9; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (!stack.isDamageableItem() && !stack.has(net.minecraft.core.component.DataComponents.TOOL)
					&& !stack.has(net.minecraft.core.component.DataComponents.WEAPON)) return slot;
		}
		return player.getInventory().getSelectedSlot();
	}

	static final class PlacementSelection implements AutoCloseable {
		private final ServerPlayer player;
		private final int previous, source, hotbar;
		private final String message;
		private boolean clicked, restored;
		PlacementSelection(ServerPlayer player, int previous, int source, int hotbar, String message) {
			this.player = player; this.previous = previous; this.source = source; this.hotbar = hotbar; this.message = message;
		}
		String message() { return message; }
		void clicked() { clicked = true; }
		@Override public void close() { if (!clicked) restore(); }
		void restore() {
			if (restored) return;
			if (source >= 9) {
				var failure = AdvancedInteractionService.swapIntoHotbar(player, source, hotbar);
				if (failure != null) throw new AgentDomainException(failure.reasonCode(), "Placement did not click; restore failed: " + failure.message());
			} else if (source == -2) player.getInventory().setItem(hotbar, ItemStack.EMPTY);
			player.getInventory().setSelectedSlot(previous);
			restored = true;
		}
	}

	private static ItemStack placementStack(ServerPlayer player, String itemId) {
		Identifier identifier = Identifier.tryParse(itemId);
		if (identifier == null || !BuiltInRegistries.ITEM.containsKey(identifier)) throw new AgentDomainException("UNKNOWN_ITEM", "Unknown item: " + itemId);
		ItemStack held = player.getMainHandItem();
		if (!held.isEmpty() && BuiltInRegistries.ITEM.getKey(held.getItem()).equals(identifier)) return held;
		for (int slot = 0; slot < 36; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (!stack.isEmpty() && BuiltInRegistries.ITEM.getKey(stack.getItem()).equals(identifier)) return stack;
		}
		if (player.isCreative()) return new ItemStack(BuiltInRegistries.ITEM.getValue(identifier));
		throw new AgentDomainException("ITEM_NOT_FOUND", "Agent does not have " + itemId);
	}

	static String placementSupportMessage(BlockPos destination, Direction face) {
		if (face == null) return "Destination " + cell(destination) + " needs a reachable visible neighbour face; none found";
		return "Destination " + cell(destination) + " needs the " + face.getSerializedName() + " face of support at "
				+ cell(destination.relative(face.getOpposite())) + "; no reachable visible face there. Move to see that face or choose another support/face";
	}

	/** Names the carried slot so the repair can copy it; slots past 35 are armor/offhand, which select_tool cannot take. */
	static String notInHotbarMessage(String itemId, int slot) {
		return slot <= 35
				? itemId + " is in inventory slot " + slot + ", not hotbar 0-8; select_tool sourceSlot " + slot + " moves it into a hotbar slot"
				: itemId + " is in equipment slot " + slot + ", not hotbar 0-8; move it with menu_click";
	}

	/** Admission must not reveal an occupied or already-satisfied cell hidden from the player. */
	private static BlockState perceivedPlacementState(ServerPlayer player, BlockPos position) {
		return perceivedPlacementState(SeenTerrain.of(player), position);
	}

	static BlockState perceivedPlacementState(SeenTerrain.Reader<BlockState> seen, BlockPos position) {
		if (!seen.seesNow(position.getX(), position.getY(), position.getZ())) {
			throw new AgentDomainException("TARGET_NOT_VISIBLE", "Placement destination is not currently seen or touched");
		}
		return seen.known(position.getX(), position.getY(), position.getZ());
	}

	private static void validatePlaceBlock(
			ServerProtectionPolicy protection,
			ServerPlayer player,
			BlockPos position,
			Direction requestedFace,
			String itemId,
			boolean strictFace,
			DesiredBlockState desiredBlockState
	) {
		requirePlacementProtection(protection, player, player.level(), position);
		if (!perceivedPlacementState(player, position).canBeReplaced()) {
			if (!player.isWithinBlockInteractionRange(position, 0.0D)) {
				throw placementFailure("TARGET_TOO_FAR", Cause.OUT_OF_REACH, position, requestedFace, "Placement target is out of reach");
			}
			Direction outward = requestedFace != null ? requestedFace : Direction.UP;
			throw placementFailure("TARGET_OCCUPIED", Cause.DESTINATION_OCCUPIED, position, requestedFace,
					occupiedPlacementMessage(SeenTerrain.of(player), position, outward) + "; replaceable=false");
		}
		Identifier identifier = Identifier.tryParse(itemId);
		if (identifier == null || !BuiltInRegistries.ITEM.containsKey(identifier)) {
			throw new AgentDomainException("UNKNOWN_ITEM", "Unknown item: " + itemId);
		}
		if (!(BuiltInRegistries.ITEM.getValue(identifier) instanceof BlockItem)) {
			throw new AgentDomainException("ITEM_NOT_PLACEABLE", itemId + " is not a block item");
		}
		ItemStack stack = placementStack(player, itemId);
		BlockHitResult hit = placementHit(player, position, requestedFace, stack, strictFace, desiredBlockState);
		requirePlacementGates(protection, player, position, hit, requestedFace);
	}

	/** Why holding use with this hand's item eats nothing now, or null when it is not food or can be eaten. */
	static String fullHungerRefusal(ServerPlayer player, InteractionHand hand) {
		ItemStack stack = player.getItemInHand(hand);
		net.minecraft.world.food.FoodProperties food = stack.get(net.minecraft.core.component.DataComponents.FOOD);
		if (food == null) return null;
		return fullHungerRefusal(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString(),
				player.canEat(food.canAlwaysEat()), player.getFoodData().getFoodLevel());
	}

	/** Vanilla's rule: ordinary food needs hunger below 20; foods marked always-edible (golden apples, chorus fruit) do not. */
	static String fullHungerRefusal(String itemId, boolean canEatNow, int foodLevel) {
		if (canEatNow) return null;
		return "Nothing consumed: hunger is full (food " + foodLevel + "/20); " + itemId + " can be eaten only below 20";
	}

	static String useFeedback(String receipt, String foodRefusal, boolean useStarted) {
		return foodRefusal != null && !useStarted ? receipt + ". " + foodRefusal : receipt;
	}

	/** Only current perception can describe current occupancy, including an empty adjacent cell. */
	static String occupiedPlacementMessage(SeenTerrain.Reader<BlockState> seen, BlockPos target, Direction face) {
		if (!seen.seesNow(target.getX(), target.getY(), target.getZ())) {
			throw new AgentDomainException("TARGET_NOT_VISIBLE", "Placement target is not currently seen or touched");
		}
		BlockState targetState = seen.known(target.getX(), target.getY(), target.getZ());
		BlockPos beyond = target.relative(face);
		BlockPos emptyBeyond = null;
		if (seen.seesNow(beyond.getX(), beyond.getY(), beyond.getZ())
				&& seen.known(beyond.getX(), beyond.getY(), beyond.getZ()).canBeReplaced()) emptyBeyond = beyond;
		return occupiedPlacementMessage(target, blockId(targetState), face, emptyBeyond);
	}

	/** The refusal for an occupied target; {@code emptyBeyond} is the free cell on the requested face, or null. */
	static String occupiedPlacementMessage(BlockPos target, String blockId, Direction face, BlockPos emptyBeyond) {
		String message = "Placement target " + cell(target) + " contains " + blockId
				+ "; repair=clear this occupied cell or choose an empty destination; x,y,z is the empty cell the block goes into, not the block you click";
		return emptyBeyond == null ? message
				: message + ". Empty cell on its " + face.getSerializedName() + " face: " + cell(emptyBeyond);
	}

	static String missingPlacementSupport(BlockPos destination, Direction face) {
		return "No reachable visible support face places into " + cell(destination)
				+ " (requested face " + (face == null ? "any" : face.getSerializedName()) + ")"
				+ "; support=" + (face == null ? "unspecified" : cell(placementSupport(destination, face)));
	}

	private static AgentDomainException placementFailure(String code, Cause cause, BlockPos destination, Direction face, String facts) {
		return new AgentDomainException(code, "cause=" + cause + "; destination=" + cell(destination)
				+ "; requestedSupport=" + (face == null ? "unspecified" : cell(placementSupport(destination, face)))
				+ "; requestedFace=" + (face == null ? "any" : face.getSerializedName())
				+ "; repair=" + placementRepair(cause) + "; " + facts, cause.name());
	}

	static String placementRepair(Cause cause) {
		return switch (cause) {
			case NO_SUPPORT -> "build an adjacent solid support before retrying";
			case SUPPORT_NOT_OBSERVED -> "look at the support from dry reachable footing before retrying";
			case SUPPORT_FACE_HIDDEN -> "no usable support face into this cell is visible from here; move your eye to the destination side of the requested support face with a clear line (top faces need eyes above them), see requestedFaceView";
			case OUT_OF_REACH -> "move closer or build higher dry footing with clear headroom";
			case DESTINATION_OCCUPIED -> "clear the occupied destination or choose an empty cell";
			case BODY_IN_DESTINATION -> "move your body clear of the destination before retrying";
			case PLACEMENT_CONTEXT_MISMATCH -> "choose a visible support face that places into the intended empty cell";
			case PLACEMENT_STATE_MISMATCH -> "change the click face or look direction to produce the requested block state";
		};
	}

	private static AgentDomainException placementSupportFailure(ServerPlayer player, BlockPos destination, Direction requested, boolean strict, List<String> stateRefusals) {
		boolean stateRejected = !stateRefusals.isEmpty();
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		List<String> neighbours = new ArrayList<>(), visible = new ArrayList<>();
		boolean allKnown = true, anySupport = false, anyInReach = false, allowedFaceVisible = false;
		boolean allowedSupport = false, allowedUnknown = false;
		for (Direction face : Direction.values()) {
			BlockPos support = placementSupport(destination, face);
			if (!seen.seesNow(support.getX(), support.getY(), support.getZ())) {
				neighbours.add(cell(support) + "=unobserved");
				allKnown = false;
				if (!strict || face == requested) allowedUnknown = true;
				continue;
			}
			BlockState state = seen.known(support.getX(), support.getY(), support.getZ());
			neighbours.add(cell(support) + "=" + blockId(state) + " replaceable=" + state.canBeReplaced());
			if (state.canBeReplaced() || state.getShape(player.level(), support).isEmpty()) continue;
			anySupport = true;
			if (!strict || face == requested) {
				allowedSupport = true;
				anyInReach |= player.isWithinBlockInteractionRange(support, 0.0D);
			}
			for (Direction side : Direction.values()) {
				if (TargetSightline.block(player.level(), CollisionContext.of(player), player.getEyePosition(), support,
						player.blockInteractionRange(), side) != null) {
					visible.add(cell(support) + ":" + side.getSerializedName());
					if (side == face && (!strict || face == requested)) allowedFaceVisible = true;
				}
			}
		}
		Cause cause = stateRejected ? Cause.PLACEMENT_STATE_MISMATCH
				: allKnown && !anySupport ? Cause.NO_SUPPORT
				: !player.isWithinBlockInteractionRange(destination, 0.0D) || allowedSupport && !anyInReach ? Cause.OUT_OF_REACH
				: !allowedSupport && allowedUnknown ? Cause.SUPPORT_NOT_OBSERVED
				: !allowedSupport || allowedFaceVisible ? Cause.PLACEMENT_CONTEXT_MISMATCH : Cause.SUPPORT_FACE_HIDDEN;
		String requestedView = "";
		if (requested != null && cause != Cause.NO_SUPPORT && !stateRejected) {
			BlockPos support = placementSupport(destination, requested);
			VoxelShape shape = null;
			boolean empty = false;
			if (seen.seesNow(support.getX(), support.getY(), support.getZ())) {
				BlockState state = seen.known(support.getX(), support.getY(), support.getZ());
				shape = state.getShape(player.level(), support, CollisionContext.of(player));
				empty = state.canBeReplaced() || shape.isEmpty();
			}
			if (!empty) requestedView = "; requestedFaceView=" + BlockPlacementGeometry.requestedFaceView(player.level(),
					CollisionContext.of(player), player.getEyePosition(), player.blockInteractionRange(), destination, requested, shape);
		}
		return placementFailure(stateRejected ? "PLACEMENT_STATE_MISMATCH" : cause == Cause.OUT_OF_REACH ? "TARGET_TOO_FAR" : "NO_PLACEMENT_SUPPORT",
				cause, destination, requested, (stateRejected ? "stateRefusals=" + stateRefusals + "; " : "") + "eye=" + ActionResultFacts.coordinates(player.getEyePosition())
				+ requestedView + "; visibleFaces=" + visible + "; neighbours=" + neighbours
				+ (stateRejected ? "; alternate visible click changes the vanilla block state or cannot produce the requested state" : ""));
	}

	static String placementBodyObstruction(net.minecraft.world.level.BlockGetter world, BlockPos destination,
			BlockState predicted, net.minecraft.world.phys.AABB playerBounds) {
		boolean overlaps = predicted.getCollisionShape(world, destination).toAabbs().stream()
				.anyMatch(box -> box.move(destination).intersects(playerBounds));
		return overlaps ? "; your body overlaps the placed block at " + cell(destination)
				+ "; body x " + bodySpan(playerBounds.minX, playerBounds.maxX) + " y " + bodySpan(playerBounds.minY, playerBounds.maxY)
				+ " z " + bodySpan(playerBounds.minZ, playerBounds.maxZ)
				+ "; move clear of that cell before placing again" : "";
	}

	private static String bodySpan(double min, double max) {
		return String.format(java.util.Locale.ROOT, "%.2f..%.2f", min, max);
	}

	private static String placementCause(ServerActionRequest request, RuntimeException failure) {
		if (request.type() != ActionType.PLACE_BLOCK || !(failure instanceof AgentDomainException domain)) return null;
		return domain.causeCode() != null ? domain.causeCode()
				: domain.code().equals("PLACEMENT_STATE_MISMATCH") ? domain.code() : null;
	}

	private static String placementFailureContext(ServerActionRequest request, String message) {
		if (request.type() != ActionType.PLACE_BLOCK || message == null || message.contains("requestedSupport=")) return message;
		Direction face = Direction.byName(string(request.arguments(), "face"));
		return message + "; requestedSupport=" + cell(placementSupport(blockPosition(request.arguments()), face))
				+ "; requestedFace=" + face.getSerializedName();
	}

	private static String cell(BlockPos position) {
		return position.getX() + "," + position.getY() + "," + position.getZ();
	}

	static void requirePlacementProtection(
			ServerProtectionPolicy policy,
			ServerPlayer player,
			ServerLevel level,
			BlockPos position
	) {
		if (policy == null || !policy.mayModifyBlock(player, level, position)) {
			throw new AgentDomainException("PROTECTION_DENIED", "Block placement denied");
		}
	}

	/**
	 * fight_target / use_ranged with untilItem+untilCount: the fight_until engine, the named target fought first and its
	 * type the mob. fight_target chooses weapons as fight_until's auto does, use_ranged keeps the bow; collect defaults
	 * to true (false with pursue:false); the run lasts timeoutMs but at least fight_until's default (180 s), at most 600 s (the coordinator's planner
	 * lease budgets the same: agent-planner.mjs nativeToolLeaseMs). The model's pursue, shield, sneak, desiredRange,
	 * drawDurationMs, trackTarget, targetPolicy, continueWithAttackers and includePlayers are kept for every engagement
	 * and retarget (CountFightChoices).
	 */
	private ActiveAction countFight(ServerActionRequest request, ServerPlayer player, JsonObject arguments) {
		net.minecraft.world.entity.LivingEntity first = combatTarget(player, string(arguments, "targetId"));
		JsonObject until = new JsonObject();
		until.addProperty("mob", BuiltInRegistries.ENTITY_TYPE.getKey(first.getType()).toString());
		until.addProperty("untilItem", string(arguments, "untilItem"));
		until.addProperty("untilCount", integer(arguments, "untilCount"));
		until.addProperty("weapon", request.type() == ActionType.USE_RANGED ? "bow" : "auto");
		// collect: the model's own, else the engine's default (on, off when the model chose pursue:false).
		if (arguments.has("collect")) until.addProperty("collect", bool(arguments, "collect"));
		if (arguments.has("fleeAtHealth")) until.addProperty("fleeAtHealth", number(arguments, "fleeAtHealth"));
		long timeout = arguments.has("timeoutMs") ? integer(arguments, "timeoutMs") : 0L;
		until.addProperty("timeoutMs", Math.min(dev.agaminggod.arenaagents.server.runtime.controller.ServerFightUntilController.MAX_TIMEOUT_MS,
				Math.max(dev.agaminggod.arenaagents.server.runtime.controller.ServerFightUntilController.DEFAULT_TIMEOUT_MS, timeout)));
		if (arguments.has("roof")) until.addProperty("roof", bool(arguments, "roof"));
		// The model's own fight options apply to every engagement and retarget of the run (pursue, shield, sneak, desiredRange,
		// targetPolicy, continueWithAttackers, includePlayers; the bow's draw and tracking).
		dev.agaminggod.arenaagents.server.runtime.controller.CountFightChoices.copy(arguments, until);
		return ActiveAction.controller(request, player, new dev.agaminggod.arenaagents.server.runtime.controller.ServerFightUntilController(
				player, until, protection, System.currentTimeMillis(), request.type().wireName(), first, roofing(request)));
	}

	/** roof:true construction for the fight engine: build_shelter's placement and clearing with a carried block. */
	private dev.agaminggod.arenaagents.server.runtime.controller.ServerFightUntilController.Roofing roofing(ServerActionRequest parent) {
		return new dev.agaminggod.arenaagents.server.runtime.controller.ServerFightUntilController.Roofing() {
			public String blockItem(ServerPlayer body) {
				java.util.Map<net.minecraft.world.item.Item, Integer> counts = new java.util.HashMap<>();
				for (int slot = 0; slot < body.getInventory().getContainerSize(); slot++) {
					ItemStack stack = body.getInventory().getItem(slot);
					if (shelterBlock(stack.getItem()) && !stack.is(net.minecraft.world.item.Items.OBSIDIAN) && !stack.is(net.minecraft.world.item.Items.CRYING_OBSIDIAN))
						counts.merge(stack.getItem(), stack.getCount(), Integer::sum);
				}
				return counts.entrySet().stream().max(java.util.Map.Entry.comparingByValue())
						.map(entry -> BuiltInRegistries.ITEM.getKey(entry.getKey()).toString()).orElse(null);
			}
			public dev.agaminggod.arenaagents.server.runtime.controller.ServerController shelter(BlockPos center, Direction opening, String itemId, boolean sneak, long timeoutMs, long now) {
				return new dev.agaminggod.arenaagents.server.runtime.controller.ServerShelterController(center, opening, true, false, timeoutMs, now,
						shelterEnvironment(parent, itemId)).crouched(sneak);
			}
			public Vec3 aim(ServerPlayer body, BlockPos at, Direction face, String itemId) {
				return shelterEnvironment(parent, itemId).aim(body, at, face);
			}
			public String place(ServerPlayer body, BlockPos at, Direction face, String itemId) {
				return shelterEnvironment(parent, itemId).place(body, at, face);
			}
		};
	}

	private static boolean shelterBlock(net.minecraft.world.item.Item item) {
		return item instanceof BlockItem blockItem && !(blockItem.getBlock() instanceof net.minecraft.world.level.block.FallingBlock)
				&& !(blockItem.getBlock() instanceof net.minecraft.world.level.block.EntityBlock)
				&& blockItem.getBlock().defaultBlockState().isCollisionShapeFullBlock(net.minecraft.world.level.EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
	}

	/** Model-selected enclosure; construction reuses the ordinary placement gates and inventory selection. */
	private dev.agaminggod.arenaagents.server.runtime.controller.ServerShelterController shelterController(ServerActionRequest parent, JsonObject arguments) {
		String item = string(arguments, "itemId");
		var block = BuiltInRegistries.ITEM.getValue(net.minecraft.resources.Identifier.parse(item));
		if (!(block instanceof BlockItem blockItem) || blockItem.getBlock() instanceof net.minecraft.world.level.block.FallingBlock
				|| !blockItem.getBlock().defaultBlockState().isCollisionShapeFullBlock(net.minecraft.world.level.EmptyBlockGetter.INSTANCE, BlockPos.ZERO))
			throw new AgentDomainException("INVALID_SHELTER_BLOCK", "Shelter walls need a carried full solid block that does not fall");
		return new dev.agaminggod.arenaagents.server.runtime.controller.ServerShelterController(blockPosition(arguments),
				Direction.byName(string(arguments, "opening")), !arguments.has("roof") || bool(arguments, "roof"),
				integer(arguments, "timeoutMs"), System.currentTimeMillis(), shelterEnvironment(parent, item));
	}

	private dev.agaminggod.arenaagents.server.runtime.controller.ServerShelterController.Environment shelterEnvironment(ServerActionRequest parent, String item) {
		return new dev.agaminggod.arenaagents.server.runtime.controller.ServerShelterController.Environment() {
			public Vec3 aim(ServerPlayer body, BlockPos at, Direction face) {
				try (PlacementSelection selection = selectPlacementItem(body, item)) {
					return placementHit(body, at, face, body.getMainHandItem(), false, DesiredBlockState.parse(null, expectedBlockId(item))).getLocation();
				}
			}
			public dev.agaminggod.arenaagents.server.runtime.controller.ServerController clear(ServerPlayer body, BlockPos at, boolean sneak, long timeoutMs) {
				if (!protection.mayModifyBlock(body, body.level(), at) || !body.level().mayInteract(body, at)
						|| body.level().getServer().isUnderSpawnProtection(body.level(), at, body))
					throw new AgentDomainException("PROTECTION_DENIED", "Clearing the shelter obstruction was denied");
				BreakTarget target = validateBreakTarget(body, at, null);
				String lava = target.blockId().equals("minecraft:fire") || target.blockId().equals("minecraft:soul_fire") ? null : lavaBehind(body, at);
				if (lava != null) throw new AgentDomainException("LAVA_BEHIND", "Lava is " + lava + "; not clearing the shelter obstruction");
				JsonObject args = new JsonObject();
				args.addProperty("x", at.getX()); args.addProperty("y", at.getY()); args.addProperty("z", at.getZ());
				args.addProperty("timeoutMs", timeoutMs); args.addProperty("expectedBlockId", target.blockId());
				ServerActionRequest internal = new ServerActionRequest(parent.agentId(), parent.goalRevision(), parent.actionId(),
						ActionType.BREAK_BLOCK, args, parent.provenance(), parent.traceId());
				ActiveAction mine = ActiveAction.breakBlock(internal, body, at, timeoutMs, target.blockId(), target.blockId(), target.aim());
				mine.breakSneak = sneak;
				return new dev.agaminggod.arenaagents.server.runtime.controller.ServerController() {
					public TickResult tick(ServerPlayer player, long now) {
						ServerActionResult result = mine.tick(now);
						if (result == null) return TickResult.running(0.0D);
						mine.cleanup();
						return result.state() == ServerActionState.SUCCEEDED ? TickResult.succeeded(result.reasonCode(), result.message())
								: TickResult.failed(result.reasonCode(), result.message(), 0.0D);
					}
					public void cancel(ServerPlayer player) { mine.cancel("Shelter construction ended"); }
				};
			}
			public String place(ServerPlayer body, BlockPos at, Direction face) {
				return placeBlock(protection, body, at, face, item, DesiredBlockState.parse(null, expectedBlockId(item)), false).placed()
						? null : "Vanilla placement did not place a block";
			}
		};
	}

	private ServerDigController digController(JsonObject arguments) {
		Integer y = arguments.has("y") ? (int) Math.floor(number(arguments, "y")) : null;
		Integer x = arguments.has("x") ? (int) Math.floor(number(arguments, "x")) : null;
		Integer z = arguments.has("z") ? (int) Math.floor(number(arguments, "z")) : null;
		String heading = nullableString(arguments, "heading");
		ServerDigController.Environment environment = new ServerDigController.Environment() {
			@Override
			public String lavaBehind(ServerPlayer player, BlockPos cell) {
				return ServerActionExecutor.lavaBehind(player, cell);
			}

			@Override
			public String place(ServerPlayer player, BlockPos cell, Direction face, String itemId) {
				try {
					return placeBlock(protection, player, cell, face, itemId, DesiredBlockState.parse(null, expectedBlockId(itemId)), false).placed()
							? null : "the click did not place it";
				} catch (AgentDomainException refused) {
					return refused.code() + ": " + refused.getMessage();
				}
			}
		};
		try {
			return new ServerDigController(ServerDigController.Pattern.parse(nullableString(arguments, "pattern")), y, x, z,
					heading == null ? null : Direction.byName(heading),
					arguments.has("maxBlocks") ? integer(arguments, "maxBlocks") : 1024,
					arguments.has("timeoutMs") ? integer(arguments, "timeoutMs") : 600_000L, System.currentTimeMillis(), environment,
					!arguments.has("throughCaves") || bool(arguments, "throughCaves"),
					arguments.has("maxShaftY") ? (int) Math.floor(number(arguments, "maxShaftY")) : ServerDigController.DEFAULT_MAX_SHAFT_Y,
					nullableString(arguments, "stopWhenSeen")).acceptUnseenBelow(arguments.has("throughCaves") && bool(arguments, "throughCaves"));
		} catch (IllegalArgumentException invalid) {
			throw new AgentDomainException("INVALID_DIG_GOAL", invalid.getMessage());
		}
	}

	private static PlacementClick placeBlock(
			ServerProtectionPolicy protection,
			ServerPlayer player,
			BlockPos position,
			Direction requestedFace,
			String itemId,
			DesiredBlockState desiredBlockState,
			boolean strictFace
	) {
		validatePlaceBlock(protection, player, position, requestedFace, itemId, strictFace, desiredBlockState);
		try (PlacementSelection selection = selectPlacementItem(player, itemId)) {
			BlockHitResult hit = placementHit(player, position, requestedFace, player.getMainHandItem(), strictFace, desiredBlockState);
			ItemStack stack = player.getMainHandItem();
			// The aim phase already turned the view to a look that yields the requested state; vanilla reads it here.
			BlockState predicted = predictedPlacementState(player, (BlockItem) stack.getItem(), stack, hit);
			if (predicted == null || !desiredBlockState.matches(predicted)) {
				throw new AgentDomainException("PLACEMENT_STATE_MISMATCH",
						"Requested block state cannot be produced by vanilla placement context from the current look; support=" + cell(hit.getBlockPos()) + " face=" + hit.getDirection());
			}
			if (hit.getDirection() != requestedFace || !hit.getBlockPos().equals(placementSupport(position, requestedFace))) {
				BlockPos preferred = placementSupport(position, requestedFace);
				BlockHitResult reference = new BlockHitResult(placementLookTarget(preferred, requestedFace), requestedFace, preferred, false);
				if (!BlockPlacementGeometry.equivalent(placementPredictionAtAim(player, (BlockItem) stack.getItem(), stack, reference, desiredBlockState), predicted)) {
					throw placementFailure("PLACEMENT_STATE_MISMATCH", Cause.PLACEMENT_STATE_MISMATCH, position, requestedFace,
							"support=" + cell(hit.getBlockPos()) + "; actual look changes the substituted click's stable block state; actualPrediction=" + placementStateFact(predicted));
				}
			}
			requirePlacementGates(protection, player, position, hit, requestedFace);
			String body = placementBodyObstruction(player.level(), position, predicted, player.getBoundingBox());
			if (!body.isEmpty()) throw placementFailure("PLACEMENT_NOT_CONFIRMED", Cause.BODY_IN_DESTINATION, position,
					requestedFace, "support=" + cell(hit.getBlockPos()) + body);
			VoxelShape shape = predicted.getCollisionShape(player.level(), position, CollisionContext.placementContext(player));
			if (!shape.isEmpty() && !player.level().isUnobstructed(player, shape.move(position.getX(), position.getY(), position.getZ()))) {
				throw placementFailure("PLACEMENT_NOT_CONFIRMED", Cause.BODY_IN_DESTINATION, position, requestedFace,
						"support=" + cell(hit.getBlockPos()) + "; another entity overlaps the placement collision shape");
			}
			BlockState before = player.level().getBlockState(position);
			InteractionResult result = withSecondaryUse(player, interactiveSupport(player.level().getBlockState(hit.getBlockPos())), () -> {
				selection.clicked();
				return player.gameMode.useItemOn(player, player.level(), stack, InteractionHand.MAIN_HAND, hit);
			});
			if (result.consumesAction()) ArmSwing.use(player, InteractionHand.MAIN_HAND);
			BlockState after = player.level().getBlockState(position);
			return new PlacementClick(result.consumesAction(),
					result.consumesAction() || placementRefusalMayClear(player, hit, stack, predicted),
					placedByClick(result.consumesAction(), before, after, desiredBlockState), selection.message()
						+ "; used face=" + hit.getDirection().getSerializedName() + " support=" + cell(hit.getBlockPos()));
		}
	}

	/**
	 * What one placement click did: whether the server consumed it, whether a refusal could still clear, and whether
	 * this click itself changed the destination to the requested block (the action's own placement receipt).
	 */
	record PlacementClick(boolean consumed, boolean mayClear, boolean placed, String selection) {
		PlacementClick(boolean consumed, boolean mayClear, boolean placed) { this(consumed, mayClear, placed, ""); }
		PlacementClick(boolean consumed, boolean mayClear) { this(consumed, mayClear, false, ""); }
	}

	/**
	 * The destination changed during this synchronous vanilla click into the requested state: this action placed it.
	 * Inventory totals separated by ticks cannot prove that, because a matching pickup can cancel the one-item drop.
	 */
	static boolean placedByClick(boolean consumed, BlockState before, BlockState after, DesiredBlockState desired) {
		return consumed && !before.equals(after) && desired.matches(after);
	}

	/**
	 * A refused click may succeed on a later one only when something temporary caused it: another entity standing in
	 * the space the block needs (it can walk out) or the item's use cooldown. Anything else repeats identically: no
	 * replaceable target, an unsupported state, a protected area, or the placing body itself in the way (the action
	 * holds the body still).
	 */
	private static boolean placementRefusalMayClear(ServerPlayer player, BlockHitResult hit, ItemStack stack, BlockState predicted) {
		if (player.getCooldowns().isOnCooldown(stack)) return true;
		BlockPos target = new BlockPlaceContext(player, InteractionHand.MAIN_HAND, stack, hit).getClickedPos();
		VoxelShape shape = predicted.getCollisionShape(player.level(), target, CollisionContext.placementContext(player));
		return !shape.isEmpty() && !player.level().isUnobstructed(player, shape.move(target.getX(), target.getY(), target.getZ()));
	}

	private static BlockHitResult placementHit(ServerPlayer player, BlockPos position, Direction requestedFace, ItemStack stack,
			boolean strictFace, DesiredBlockState desired) {
		java.util.Map<Direction, BlockHitResult> hits = new java.util.EnumMap<>(Direction.class);
		List<String> stateRefusals = new ArrayList<>();
		BlockHitResult reference = new BlockHitResult(placementLookTarget(placementSupport(position, requestedFace), requestedFace),
				requestedFace, placementSupport(position, requestedFace), false);
		Direction face = BlockPlacementAttemptPolicy.chooseFace(requestedFace, strictFace, candidate -> {
			BlockHitResult hit = BlockPlacementGeometry.candidate(player.level(), CollisionContext.of(player), player.getEyePosition(),
					player.blockInteractionRange(), position, candidate, click -> placementLandsAt(player, click, position, stack));
			if (hit == null || !player.isWithinBlockInteractionRange(hit.getBlockPos(), 0.0D)) return false;
			if ((candidate != requestedFace || !hit.getBlockPos().equals(reference.getBlockPos())) && stack.getItem() instanceof BlockItem item) {
				BlockState original = placementPredictionAtAim(player, item, stack, reference, desired);
				BlockState alternate = placementPredictionAtAim(player, item, stack, hit, desired);
				if (!BlockPlacementGeometry.equivalent(original, alternate)) {
					stateRefusals.add("support=" + cell(hit.getBlockPos()) + " face=" + candidate.getSerializedName()
							+ " requestedPrediction=" + placementStateFact(original) + " alternatePrediction=" + placementStateFact(alternate));
					return false;
				}
			}
			hits.put(candidate, hit);
			return true;
		});
		if (face == null) throw placementSupportFailure(player, position, requestedFace, strictFace, stateRefusals);
		return hits.get(face);
	}

	private static String placementStateFact(BlockState state) {
		return state == null ? "unavailable" : blockId(state) + DesiredBlockState.stableProperties(state);
	}

	private static BlockState placementPredictionAtAim(ServerPlayer player, BlockItem item, ItemStack stack,
			BlockHitResult hit, DesiredBlockState desired) {
		AgentInputState aim = AgentInputStates.lookingAt(player, hit.getLocation(), 0, 0, false, false, false, false, false, InteractionHand.MAIN_HAND);
		Look look = new Look(aim.yaw(), aim.pitch());
		try {
			Look required = requiredPlacementLook(player, item, stack, hit, desired, look);
			if (required != null) look = required;
			float yaw = player.getYRot(), head = player.getYHeadRot(), pitch = player.getXRot();
			try {
				player.setYRot(look.yaw()); player.setYHeadRot(look.yaw()); player.setXRot(look.pitch());
				return predictedPlacementState(player, item, stack, hit);
			} finally {
				player.setYRot(yaw); player.setYHeadRot(head); player.setXRot(pitch);
			}
		} catch (AgentDomainException mismatch) { return null; }
	}

	private static void requirePlacementGates(
			ServerProtectionPolicy protection,
			ServerPlayer player,
			BlockPos target,
			BlockHitResult hit,
			Direction requestedFace
	) {
		ServerLevel level = player.level();
		BlockPos support = hit.getBlockPos();
		requirePlacementProtection(protection, player, level, target);
		requirePlacementProtection(protection, player, level, support);
		if (level.getServer().isUnderSpawnProtection(level, target, player)
				|| level.getServer().isUnderSpawnProtection(level, support, player)
				|| !level.mayInteract(player, target)
				|| !level.mayInteract(player, support)) {
			throw new AgentDomainException("PROTECTION_DENIED", "Vanilla placement protection denied the target or support block");
		}
		if (!player.isWithinBlockInteractionRange(support, 0.0D)
				|| !isValidPlacementHit(support, hit.getLocation())) {
			throw placementFailure("TARGET_TOO_FAR", Cause.OUT_OF_REACH, target, requestedFace, "support=" + cell(support) + "; placement hit is out of reach");
		}
	}

	static boolean isValidPlacementHit(BlockPos support, Vec3 hitLocation) {
		Vec3 offset = hitLocation.subtract(Vec3.atCenterOf(support));
		return Math.abs(offset.x()) < 1.0000001D
				&& Math.abs(offset.y()) < 1.0000001D
				&& Math.abs(offset.z()) < 1.0000001D;
	}

	static float directionalPlacementYaw(Direction direction) {
		if (direction == null || !direction.getAxis().isHorizontal()) {
			throw new IllegalArgumentException("direction must be horizontal");
		}
		return direction.toYRot();
	}

	/** A view direction: yaw and pitch in degrees. */
	record Look(float yaw, float pitch) {
	}

	/** Largest yaw offset from a cardinal direction tried before the leveled cardinal looks. */
	static final float PLACEMENT_LOOK_OFFSET_DEGREES = 40.0F;
	/** Steepest pitch tried for a horizontal facing; below about 35 degrees the nearest look direction is horizontal. */
	static final float PLACEMENT_LEVEL_PITCH_DEGREES = 30.0F;

	/**
	 * The look a player needs so vanilla places {@code desiredBlockState}, as close as possible to {@code aim} (the
	 * look at the support face): the aim itself, then the aim pulled into each horizontal quadrant, then the leveled
	 * cardinal looks (pistons and observers take facing from the nearest look direction, so a steep aim at a floor
	 * would win over the yaw). Returns null when no particular look is required. The player's rotation is only
	 * changed for same-tick prediction and is always restored. Throws PLACEMENT_STATE_MISMATCH when no look works.
	 */
	static Look requiredPlacementLook(
			ServerPlayer player,
			BlockItem blockItem,
			ItemStack stack,
			BlockHitResult hit,
			DesiredBlockState desiredBlockState,
			Look aim
	) {
		String requestedFacing = desiredBlockState.properties().get("facing");
		Direction requestedDirection = requestedFacing == null ? null : Direction.byName(requestedFacing);
		boolean horizontal = requestedDirection != null && requestedDirection.getAxis().isHorizontal();
		if (!horizontal) {
			if (placementMatchesAt(player, blockItem, stack, hit, desiredBlockState, aim)) return null;
			throw new AgentDomainException("PLACEMENT_STATE_MISMATCH",
					"Requested block state cannot be produced by vanilla placement context");
		}
		List<Look> candidates = new ArrayList<>();
		candidates.add(aim);
		List<Look> pulled = new ArrayList<>();
		for (Direction direction : HORIZONTAL_PLACEMENT_DIRECTIONS) {
			float center = directionalPlacementYaw(direction);
			float offset = net.minecraft.util.Mth.clamp(net.minecraft.util.Mth.wrapDegrees(aim.yaw() - center),
					-PLACEMENT_LOOK_OFFSET_DEGREES, PLACEMENT_LOOK_OFFSET_DEGREES);
			pulled.add(new Look(net.minecraft.util.Mth.wrapDegrees(center + offset),
					net.minecraft.util.Mth.clamp(aim.pitch(), -PLACEMENT_LEVEL_PITCH_DEGREES, PLACEMENT_LEVEL_PITCH_DEGREES)));
		}
		pulled.sort(java.util.Comparator.comparingDouble(look -> lookDistance(aim, look)));
		candidates.addAll(pulled);
		for (Direction direction : HORIZONTAL_PLACEMENT_DIRECTIONS) {
			candidates.add(new Look(directionalPlacementYaw(direction), 0.0F));
		}
		for (Look look : candidates) {
			if (placementMatchesAt(player, blockItem, stack, hit, desiredBlockState, look)) return look;
		}
		throw new AgentDomainException(
				"PLACEMENT_STATE_MISMATCH",
				"Requested directional state cannot be produced by vanilla placement context"
		);
	}

	static double lookDistance(Look from, Look to) {
		return Math.abs(AgentInputStates.shortestAngleDelta(from.yaw(), to.yaw())) + Math.abs(to.pitch() - from.pitch());
	}

	/** Predicts vanilla placement with the player briefly at {@code look}; the rotation is restored in the same tick. */
	static boolean placementMatchesAt(
			ServerPlayer player,
			BlockItem blockItem,
			ItemStack stack,
			BlockHitResult hit,
			DesiredBlockState desiredBlockState,
			Look look
	) {
		float yaw = player.getYRot();
		float headYaw = player.getYHeadRot();
		float pitch = player.getXRot();
		try {
			player.setYRot(look.yaw());
			player.setYHeadRot(look.yaw());
			player.setXRot(look.pitch());
			BlockState predicted = predictedPlacementState(player, blockItem, stack, hit);
			return predicted != null && desiredBlockState.matches(predicted);
		} finally {
			player.setYRot(yaw);
			player.setYHeadRot(headYaw);
			player.setXRot(pitch);
		}
	}

	private static BlockState predictedPlacementState(
			ServerPlayer player,
			BlockItem blockItem,
			ItemStack stack,
			BlockHitResult hit
	) {
		return withSecondaryUse(player, interactiveSupport(player.level().getBlockState(hit.getBlockPos())), () -> {
			BlockPlaceContext context = blockItem.updatePlacementContext(
					new BlockPlaceContext(player, InteractionHand.MAIN_HAND, stack, hit)
			);
			return context == null ? null : blockItem.getBlock().getStateForPlacement(context);
		});
	}

	/**
	 * A support whose own click does something (opens a menu, toggles a door or lever): a player sneak-clicks it to
	 * place against it, so the placement holds secondary use for the prediction and the click.
	 */
	static boolean interactiveSupport(BlockState state) {
		net.minecraft.world.level.block.Block block = state.getBlock();
		return state.hasBlockEntity()
				|| block instanceof net.minecraft.world.level.block.DoorBlock || block instanceof net.minecraft.world.level.block.TrapDoorBlock
				|| block instanceof net.minecraft.world.level.block.FenceGateBlock || block instanceof net.minecraft.world.level.block.ButtonBlock
				|| block instanceof net.minecraft.world.level.block.BedBlock || block instanceof net.minecraft.world.level.block.AnvilBlock
				|| block instanceof net.minecraft.world.level.block.AbstractCauldronBlock
				|| state.is(Blocks.LEVER) || state.is(Blocks.CRAFTING_TABLE) || state.is(Blocks.STONECUTTER)
				|| state.is(Blocks.LOOM) || state.is(Blocks.GRINDSTONE) || state.is(Blocks.CARTOGRAPHY_TABLE)
				|| state.is(Blocks.SMITHING_TABLE) || state.is(Blocks.NOTE_BLOCK) || state.is(Blocks.REPEATER)
				|| state.is(Blocks.COMPARATOR) || state.is(Blocks.COMPOSTER) || state.is(Blocks.RESPAWN_ANCHOR)
				|| state.is(Blocks.CAKE) || state.is(Blocks.FLOWER_POT);
	}

	/** Runs {@code action} with the shift key held when {@code active} (vanilla's secondary use), then restores it. */
	private static <T> T withSecondaryUse(ServerPlayer player, boolean active, java.util.function.Supplier<T> action) {
		if (!active && dev.agaminggod.arenaagents.server.runtime.controller.BrinkGuard.holdsSneak(player) && player.isShiftKeyDown()) {
			// The brink guard's crouch is not the model's: the interaction opens the block, as an upright click does.
			player.setShiftKeyDown(false);
			try {
				return action.get();
			} finally {
				player.setShiftKeyDown(true);
			}
		}
		if (!active || player.isShiftKeyDown()) return action.get();
		player.setShiftKeyDown(true);
		try {
			return action.get();
		} finally {
			player.setShiftKeyDown(false);
		}
	}

	private static Direction placementFace(ServerPlayer player, BlockPos position, Direction requestedFace) {
		return BlockPlacementAttemptPolicy.chooseFace(requestedFace, candidate -> placesAgainst(player, position, candidate, player.getMainHandItem()));
	}

	/**
	 * The one placement-support rule, shared by placement and by the placeable faces an observation lists: clicking
	 * {@code face} of the block beside {@code position} places {@code item} into {@code position} for this player now.
	 * Some point of that face must be the first thing the crosshair meets within reach, the support must have an
	 * outline (vanilla places against any clicked outline face, so a non-sturdy slab or fence top counts), and the
	 * item's own placement context at that visible point must fill {@code position}: a slab clicked on a bottom slab
	 * merges into it, and a support the click replaces (grass, one snow layer, any snow for a snow item) is replaced.
	 */
	public static boolean placesAgainst(ServerPlayer player, BlockPos position, Direction face, ItemStack item) {
		BlockPos support = placementSupport(position, face);
		Vec3 aim = TargetSightline.block(player.level(), CollisionContext.of(player), player.getEyePosition(), support,
				player.blockInteractionRange(), face);
		if (aim == null) return false;
		BlockState supportState = player.level().getBlockState(support);
		if (supportState.getShape(player.level(), support).isEmpty()) return false;
		BlockHitResult hit = new BlockHitResult(aim, face, support, false);
		if (!placementLandsAt(player, hit, position, item)) return false;
		if (!(item.getItem() instanceof BlockItem blockItem)) return true;
		// Support alone is not a placeable face when the resulting shape intersects this player's body.
		// Predict with the same aimed click as placement; partial blocks must not be rejected as whole cubes.
		BlockState predicted = placementPredictionAtAim(player, blockItem, item, hit,
				new DesiredBlockState(BuiltInRegistries.BLOCK.getKey(blockItem.getBlock()).toString(), java.util.Map.of()));
		return predicted != null && placementBodyObstruction(player.level(), position, predicted, player.getBoundingBox()).isEmpty();
	}

	/** Whether vanilla's placement context for this exact click fills {@code position} (non-block items: always). */
	private static boolean placementLandsAt(ServerPlayer player, BlockHitResult hit, BlockPos position) {
		return placementLandsAt(player, hit, position, player.getMainHandItem());
	}

	private static boolean placementLandsAt(ServerPlayer player, BlockHitResult hit, BlockPos position, ItemStack held) {
		if (!(held.getItem() instanceof BlockItem blockItem)) return true;
		BlockPlaceContext context = withSecondaryUse(player, interactiveSupport(player.level().getBlockState(hit.getBlockPos())),
				() -> blockItem.updatePlacementContext(new BlockPlaceContext(player, InteractionHand.MAIN_HAND, held, hit)));
		return context != null && context.getClickedPos().equals(position) && context.canPlace();
	}

	private static int inventoryItemCount(ServerPlayer player, String itemId) {
		Identifier identifier = Identifier.tryParse(itemId);
		if (identifier == null || !BuiltInRegistries.ITEM.containsKey(identifier)) return 0;
		int count = 0;
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (!stack.isEmpty() && BuiltInRegistries.ITEM.getKey(stack.getItem()).equals(identifier)) {
				count += stack.getCount();
			}
		}
		return count;
	}

	static BlockPos placementSupport(BlockPos destination, Direction face) {
		return destination.relative(face.getOpposite());
	}

	static Vec3 placementLookTarget(BlockPos support, Direction face) {
		Vec3 center = Vec3.atCenterOf(support);
		return center.add(
				face.getStepX() * 0.499D,
				face.getStepY() * 0.499D,
				face.getStepZ() * 0.499D
		);
	}

	private static String expectedBlockId(String itemId) {
		Identifier identifier = Identifier.tryParse(itemId);
		if (identifier == null || !BuiltInRegistries.ITEM.containsKey(identifier)) {
			throw new AgentDomainException("UNKNOWN_ITEM", "Unknown item: " + itemId);
		}
		if (!(BuiltInRegistries.ITEM.getValue(identifier) instanceof BlockItem blockItem)) {
			throw new AgentDomainException("ITEM_NOT_PLACEABLE", itemId + " is not a block item");
		}
		return BuiltInRegistries.BLOCK.getKey(blockItem.getBlock()).toString();
	}

	private static String blockId(net.minecraft.world.level.block.state.BlockState state) {
		return BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
	}

	/**
	 * The optional break expectation: null (break whatever mineable block is there), "#namespace:tag" (any block in the
	 * tag), or an exact block id (unchanged strict match).
	 */
	private static String optionalExpectedBlockId(JsonObject arguments) {
		if (!arguments.has("expectedBlockId") || arguments.get("expectedBlockId").isJsonNull()) return null;
		String expected = arguments.get("expectedBlockId").getAsString().trim();
		return expected.isEmpty() ? null : expected;
	}

	/** Blocks a wildcard (omitted or tag) expectation never breaks: fluids, unbreakable blocks, and anything with stored contents. */
	private static String wildcardRefusal(ServerPlayer player, BlockPos position, BlockState state) {
		if (state.getBlock() instanceof net.minecraft.world.level.block.LiquidBlock) {
			return "is a fluid";
		}
		if (state.getDestroySpeed(player.level(), position) < 0.0F) return "is unbreakable";
		if (state.hasBlockEntity()) return "holds stored contents or settings (chest, spawner, sign, ...)";
		return null;
	}

	/** A break request's current block id and the point the crosshair turns to. */
	private record BreakTarget(String blockId, Vec3 aim, BlockPos plant, String plantId) {
		BreakTarget(String blockId, Vec3 aim) { this(blockId, aim, null, null); }
	}

	/**
	 * Admission gate for a break request, by vanilla's rule: the block must be within interaction range and some point
	 * of its outline must be the first thing a crosshair ray from the current eye meets within reach (a partly hidden
	 * block counts). The aim is where the crosshair already sits on it, else that visible point; the action turns there
	 * at player speed. Coordinates alone are never sufficient to start a mining action.
	 */
	private static BreakTarget validateBreakTarget(ServerPlayer player, BlockPos position, String expectedBlockId) {
		if (!player.isWithinBlockInteractionRange(position, 0.0D)) {
			throw new AgentDomainException("TARGET_TOO_FAR", "Block is out of reach");
		}
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		if (seen.seesNow(position.getX(), position.getY(), position.getZ())
				&& seen.known(position.getX(), position.getY(), position.getZ()).isAir()) {
			requireBreakIdentity(position, seen.known(position.getX(), position.getY(), position.getZ()), expectedBlockId);
		}
		HitResult hit = breakRayTarget(player);
		Vec3 aim = hit instanceof BlockHitResult blockHit && position.equals(blockHit.getBlockPos())
				? hit.getLocation() : TargetSightline.block(player.level(), CollisionContext.of(player), player.getEyePosition(),
						position, player.blockInteractionRange(), null);
		if (aim == null) {
			BlockState remembered = seen.known(position.getX(), position.getY(), position.getZ());
			BlockHitResult plant = BreakSightline.plantToClear(player.level(), CollisionContext.of(player),
					player.getEyePosition(), position, player.blockInteractionRange());
			// A remembered target authorizes aiming through a plant, never reading or substituting a hidden block.
			boolean rememberedMatches = remembered != null && !remembered.isAir() && (expectedBlockId == null ? true
					: expectedBlockId.startsWith("#") ? remembered.is(net.minecraft.tags.TagKey.create(net.minecraft.core.registries.Registries.BLOCK,
							Identifier.parse(expectedBlockId.substring(1)))) : expectedBlockId.equals(blockId(remembered)));
			if (plant != null && rememberedMatches) {
				BlockPos at = plant.getBlockPos();
				Vec3 plantAim = TargetSightline.block(player.level(), CollisionContext.of(player), player.getEyePosition(),
						at, player.blockInteractionRange(), null);
				if (plantAim != null) return new BreakTarget(blockId(remembered), plantAim, at, blockId(player.level().getBlockState(at)));
			}
			throw new AgentDomainException("TARGET_NOT_VISIBLE", hiddenBreakTargetMessage(player, position));
		}
		BlockState state = player.level().getBlockState(position);
		requireBreakIdentity(position, state, expectedBlockId);
		String currentBlockId = blockId(state);
		boolean wildcard = expectedBlockId == null || expectedBlockId.startsWith("#");
		if (wildcard) {
			if (expectedBlockId != null) {
				net.minecraft.tags.TagKey<net.minecraft.world.level.block.Block> tag = net.minecraft.tags.TagKey.create(
						net.minecraft.core.registries.Registries.BLOCK, Identifier.parse(expectedBlockId.substring(1)));
				if (!state.is(tag)) {
					throw new AgentDomainException("TARGET_CHANGED",
							"Expected a block in " + expectedBlockId + " at " + position + " but found " + currentBlockId);
				}
			}
			String refusal = wildcardRefusal(player, position, state);
			if (refusal != null) {
				throw new AgentDomainException("TARGET_CHANGED",
						currentBlockId + " at " + position + " " + refusal + "; name its exact expectedBlockId to break it");
			}
		}
		if (player.blockActionRestricted(player.level(), position, player.gameMode.getGameModeForPlayer())) {
			throw new AgentDomainException("GAME_MODE_RESTRICTED", "The current game mode cannot break this block");
		}
		return new BreakTarget(currentBlockId, aim);
	}

	static void requireBreakIdentity(BlockPos position, BlockState state, String expectedBlockId) {
		if (state.isAir()) {
			throw new AgentDomainException("TARGET_AIR", "Target is already air at " + position
					+ "; nothing to break and no removal or drops credited. Use fresh block facts before mining again");
		}
		String currentBlockId = blockId(state);
		if (expectedBlockId != null && !expectedBlockId.startsWith("#") && !expectedBlockId.equals(currentBlockId)) {
			throw new AgentDomainException("TARGET_CHANGED", "Expected " + expectedBlockId + " at " + position + " but found " + currentBlockId
					+ "; no target substituted. Use the current observed blockId if you still want this cell");
		}
	}

	static String inTheWay(ServerPlayer player, BlockPos at) {
		return blockId(player.level().getBlockState(at)) + " at " + coordinates(at) + " is in the way";
	}

	/**
	 * A validation ray may name its hit only when perceived now. Remembered terrain cannot establish that a hidden
	 * live hit is an obstruction, even when its remembered ID is preserved.
	 */
	static String seenBlocker(SeenTerrain.Reader<BlockState> seen, BlockPos at) {
		if (!seen.seesNow(at.getX(), at.getY(), at.getZ())) return null;
		BlockState known = seen.known(at.getX(), at.getY(), at.getZ());
		return known == null || known.isAir() ? null : blockId(known) + " at " + coordinates(at) + " is in the way";
	}

	/** What the crosshair rests on instead, as the player sees it. */
	static String crosshairNow(ServerPlayer player, HitResult hit) {
		if (hit instanceof EntityHitResult entityHit) {
			return BuiltInRegistries.ENTITY_TYPE.getKey(entityHit.getEntity().getType()) + " is under it now";
		}
		if (hit instanceof BlockHitResult blockHit && hit.getType() == HitResult.Type.BLOCK) {
			BlockPos at = blockHit.getBlockPos();
			return blockId(player.level().getBlockState(at)) + " at " + coordinates(at) + " is under it now";
		}
		return "nothing within reach is under it now";
	}

	/**
	 * Why no part of the block is visible, in facts the player has: the block first on the line to its center when the
	 * current eye ray hits that block, and the nearest standing cell from which the terrain the player has seen shows part
	 * of the target within reach. Only on failure, never every tick.
	 */
	static String hiddenBreakTargetMessage(ServerPlayer player, BlockPos target) {
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		StringBuilder message = new StringBuilder("No part of it is visible within reach from this eye");
		// Name a blocker only when both perception gates agree: the seen-terrain sightline and the loaded, not-through-lava gate.
		BlockHitResult blocker = BreakSightline.visibleBlocker(player.level(), CollisionContext.of(player),
				player.getEyePosition(), target, breakRayTarget(player));
		BlockPos gated = FailureBlocker.sightBlocker(player.level(), CollisionContext.of(player),
				player.getEyePosition(), target, breakRayTarget(player), player.level()::isLoaded);
		if (blocker != null && gated != null && gated.equals(blocker.getBlockPos())) {
			BlockPos at = blocker.getBlockPos();
			message.append("; ").append(inTheWay(player, at));
		}
		ServerLevel level = player.level();
		BlockPos spot = BreakSightline.standingSpot(new BreakSightline.SeenWorld(level.getMinY(), level.getHeight()) {
			@Override
			BlockState knownState(BlockPos position) {
				return seen.known(position.getX(), position.getY(), position.getZ());
			}
		}, player.position(), target, player.blockInteractionRange(),
				player.getEyeHeight(net.minecraft.world.entity.Pose.STANDING));
		return message.append(spot == null
				? "; no standing spot in seen terrain within reach of it sees it"
				: "; seen terrain shows it from feet at " + coordinates(spot)).toString();
	}

	private static String coordinates(BlockPos position) {
		return position.getX() + "," + position.getY() + "," + position.getZ();
	}

	/**
	 * Lava the agent heard within about 2 blocks of the target (where the sound came from, not any lava it did not hear),
	 * or sees beside it with no other lava in the way, which opening the block may let flow in. Names where it is relative
	 * to the block: lava above an opening falls through it onto the cells below.
	 */
	/**
	 * Decision 11 on a break under the feet: where water evaporates (the Nether, no water clutch), breaking the only
	 * block the body stands on drops it through a floor whose underside it has not seen, onto what may be lava 20 blocks
	 * down (lava library h-sol9-dig: break_block twice down through a fortress deck). Null when another block still
	 * carries the body, water would not evaporate, or the eye has seen a landing within a safe fall under it.
	 */
	static String unseenDropUnderFeet(ServerPlayer player, BlockPos target) {
		if (!player.onGround() || target.getY() != net.minecraft.util.Mth.floor(player.getY() + 1.0E-4D) - 1) return null;
		net.minecraft.world.phys.AABB box = player.getBoundingBox();
		boolean under = false;
		for (int x = net.minecraft.util.Mth.floor(box.minX + 1.0E-7D); x <= net.minecraft.util.Mth.floor(box.maxX - 1.0E-7D); x++) {
			for (int z = net.minecraft.util.Mth.floor(box.minZ + 1.0E-7D); z <= net.minecraft.util.Mth.floor(box.maxZ - 1.0E-7D); z++) {
				BlockPos support = new BlockPos(x, target.getY(), z);
				if (support.equals(target)) { under = true; continue; }
				if (!player.level().getBlockState(support).getCollisionShape(player.level(), support).isEmpty()) return null;
			}
		}
		if (!under) return null;
		if (!player.level().environmentAttributes().getValue(net.minecraft.world.attribute.EnvironmentAttributes.WATER_EVAPORATES, target)) return null;
		// A seen floor within a fall the body survives at its health is a step down a player takes (review c4).
		dev.agaminggod.arenaagents.server.runtime.controller.BrinkGuard.Fall drop = dev.agaminggod.arenaagents.server.runtime.controller.BrinkGuard.dropThroughFloor(player);
		if (drop == null) return null;
		if (drop.unknown()) return "It is the block you stand on and the bottom of the drop under it is not seen; water evaporates here, so the drop may end in lava.";
		return "It is the block you stand on and the drop under it ends in " + drop.below() + " " + (drop.drop() + 1) + " block(s) down"
				+ ("drop".equals(drop.below()) ? ", a fall that kills at your health." : ".");
	}

	static String lavaBehind(ServerPlayer player, BlockPos target) {
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		for (Direction side : Direction.values()) {
			BlockPos neighbour = target.relative(side);
			// "seen": the eye's own sight, not body contact.
			if (seen.eyeSeesNow(neighbour.getX(), neighbour.getY(), neighbour.getZ())
					&& seen.known(neighbour.getX(), neighbour.getY(), neighbour.getZ()).getFluidState().is(net.minecraft.tags.FluidTags.LAVA)) {
				return "seen " + lavaSide(side.getStepY()) + " this block at " + coordinates(neighbour) + fallsNote(side.getStepY());
			}
		}
		Vec3 heard = dev.agaminggod.arenaagents.server.perception.HearingPerception.lavaHeardPoint(player, target, 2.5D);
		if (heard == null) return null;
		double dy = heard.y - (target.getY() + 0.5D);
		int side = dy > 0.75D ? 1 : dy < -0.75D ? -1 : 0;
		return "heard " + lavaSide(side) + " this block, about " + Math.max(1L, Math.round(heard.distanceTo(Vec3.atCenterOf(target))))
				+ " block(s) away" + fallsNote(side);
	}

	private static String lavaSide(int dy) {
		return dy > 0 ? "above" : dy < 0 ? "below" : "beside";
	}

	private static String fallsNote(int dy) {
		return dy > 0 ? " (lava above falls through the opening onto whoever stands below)" : "";
	}

	/** Lava now in sight beside the block just broken, which flows into the opening after its spread delay. */
	static String lavaOpened(ServerPlayer player, BlockPos opened) {
		Vec3 eye = player.getEyePosition();
		for (Direction side : Direction.values()) {
			BlockPos neighbour = opened.relative(side);
			if (!player.level().getFluidState(neighbour).is(net.minecraft.tags.FluidTags.LAVA)) continue;
			// The face it shows the opening (centre and four inset points): lava has no outline, so a clear ray to any of
			// them means it is in view.
			Vec3 face = Vec3.atCenterOf(neighbour).subtract(side.getStepX() * 0.499D, side.getStepY() * 0.499D, side.getStepZ() * 0.499D);
			boolean inView = false;
			for (double[] offset : new double[][] { { 0, 0 }, { -0.3, -0.3 }, { -0.3, 0.3 }, { 0.3, -0.3 }, { 0.3, 0.3 } }) {
				Vec3 point = switch (side.getAxis()) {
					case X -> face.add(0, offset[0], offset[1]);
					case Y -> face.add(offset[0], 0, offset[1]);
					case Z -> face.add(offset[0], offset[1], 0);
				};
				if (player.level().clip(new net.minecraft.world.level.ClipContext(eye, point, net.minecraft.world.level.ClipContext.Block.VISUAL,
						net.minecraft.world.level.ClipContext.Fluid.NONE, player)).getType() == HitResult.Type.MISS) {
					inView = true;
					break;
				}
			}
			if (!inView) continue;
			double seconds = net.minecraft.world.level.material.Fluids.LAVA.getTickDelay(player.level()) / 20.0D;
			return "lava now open " + lavaSide(side.getStepY()) + " the opening at " + coordinates(neighbour) + "; it flows in after about "
					+ String.format(java.util.Locale.ROOT, "%.1f", seconds) + " s" + fallsNote(side.getStepY());
		}
		return null;
	}

	private static HitResult breakRayTarget(ServerPlayer player) {
		double reach = player.blockInteractionRange();
		return Tracer.rayTrace(player, 1.0F, reach, false);
	}

	private static ServerActionObservation rejectedBreakObservation(
			ServerPlayer player,
			JsonObject arguments,
			long now
	) {
		try {
			BlockPos target = blockPosition(arguments);
			BlockState currentState = player.level().getBlockState(target);
			String currentBlockId = blockId(currentState);
			String expectedBlockId = arguments.has("expectedBlockId")
					&& !arguments.get("expectedBlockId").isJsonNull()
					&& !arguments.get("expectedBlockId").getAsString().isBlank()
					? arguments.get("expectedBlockId").getAsString() : null;
			HitResult hit = breakRayTarget(player);
			Vec3 eye = player.getEyePosition();
			ServerActionObservation.RayTarget lookedAt;
			if (hit instanceof BlockHitResult blockHit) {
				BlockPos hitPosition = blockHit.getBlockPos();
				lookedAt = new ServerActionObservation.RayTarget(
						"block",
						new ServerActionObservation.Position(hitPosition.getX(), hitPosition.getY(), hitPosition.getZ()),
						blockId(player.level().getBlockState(hitPosition)),
						blockHit.getDirection().getSerializedName(),
						eye.distanceTo(hit.getLocation())
				);
			} else {
				lookedAt = new ServerActionObservation.RayTarget(
						hit.getType().name().toLowerCase(java.util.Locale.ROOT),
						null, null, null, eye.distanceTo(hit.getLocation())
				);
			}
			Vec3 velocity = player.getDeltaMovement();
			double maxReach = player.blockInteractionRange();
			double distance = Math.sqrt(player.distanceToSqr(Vec3.atCenterOf(target)));
			return new ServerActionObservation(
					Math.max(0L, player.level().getGameTime()),
					now,
					new ServerActionObservation.Position(player.getX(), player.getY(), player.getZ()),
					new ServerActionObservation.Position(velocity.x(), velocity.y(), velocity.z()),
					player.getYRot(),
					player.getXRot(),
					new ServerActionObservation.Collision(
							player.horizontalCollision, player.verticalCollision, player.isInWall()),
					lookedAt,
					new ServerActionObservation.Reach(
							distance, maxReach, player.isWithinBlockInteractionRange(target, 1.0D)),
					new ServerActionObservation.Target(
							"block",
							new ServerActionObservation.Position(target.getX(), target.getY(), target.getZ()),
							expectedBlockId,
							currentBlockId,
							currentBlockId,
							currentBlockId,
							false,
							Math.max(0.0D, distance - maxReach),
							null,
							null
					),
					new ServerActionObservation.Progress(0.0D, "none", true)
			);
		} catch (RuntimeException ignored) {
			return null;
		}
	}

	private static String blockResourceKey(ServerPlayer player, BlockPos position) {
		return "block:" + player.level().dimension().identifier() + ":" + position.asLong();
	}

	private static ItemEntity findItem(ServerPlayer player, String selector) {
		if (!"nearest_item".equals(EntityTargetSelector.normalize(selector))) {
			try {
				Entity entity = player.level().getEntity(UUID.fromString(EntityTargetSelector.normalize(selector)));
				if (entity instanceof ItemEntity item && item.isAlive() && !item.getItem().isEmpty()
						&& (ObservationVisibility.canSeeEntity(player, item)
							|| dev.agaminggod.arenaagents.server.perception.ObservedDrops.recall(player, item.getUUID()) != null)) return item;
			} catch (IllegalArgumentException exception) {
				throw new AgentDomainException("ITEM_NOT_FOUND", "Invalid item target selector: " + selector);
			}
			String receipt = dev.agaminggod.arenaagents.server.perception.PickupReceipts.describe(player,
					UUID.fromString(EntityTargetSelector.normalize(selector)));
			throw new AgentDomainException(receipt == null ? "ITEM_NOT_FOUND" : "ITEM_ALREADY_PICKED_UP",
					receipt == null ? ActionResultFacts.unavailableDrop(player, null, null) : receipt);
		}
		return player.level().getEntitiesOfClass(
						ItemEntity.class,
						player.getBoundingBox().inflate(64.0D),
						Entity::isAlive
				).stream()
				.filter(item -> ObservationVisibility.canSeeEntity(player, item))
				.min(Comparator.comparingDouble(player::distanceToSqr))
				.orElseThrow(() -> new AgentDomainException("ITEM_NOT_FOUND", "No dropped item is currently visible"));
	}

	private static void requireResult(AdvancedInteractionService.Result result) {
		if (!result.succeeded()) throw new AgentDomainException(result.reasonCode(), result.message());
	}

	private static BlockPos blockPosition(JsonObject arguments) {
		return BlockPos.containing(number(arguments, "x"), number(arguments, "y"), number(arguments, "z"));
	}

	private static String string(JsonObject object, String field) {
		return object.get(field).getAsString();
	}

	private void sendConversation(ServerActionRequest request, JsonObject arguments) {
		ConversationAudience audience = ConversationAudience.parse(nullableString(arguments, "audience"));
		String recipientId = nullableString(arguments, "recipientId");
		String message = string(arguments, "message");
		if (audience != ConversationAudience.PROXIMITY || !VoiceSubsystemRuntime.available(manager.server())) {
			if (audience == ConversationAudience.PROXIMITY) {
				VoiceSubsystemRuntime.reportAvailabilityFallback(manager.server(), request.agentId());
			}
			conversationRouter.deliverAgentMessage(request.agentId(), audience, recipientId, message);
			return;
		}
		conversationRouter.deliverAgentMessageToAgents(request.agentId(), audience, recipientId, message);
		long sequence = VoiceSubsystemRuntime.nextConversationSequence(manager.server(), request.agentId());
		VoiceRequest voiceRequest = new VoiceRequest(
				request.agentId(),
				message,
				"voice.auto.v1",
				(int) ServerAgentConversationRouter.DEFAULT_PROXIMITY_RANGE,
				sequence
		);
		VoiceSubsystemRuntime.speak(manager.server(), voiceRequest).whenComplete((receipt, failure) -> {
			boolean fallback = failure != null || receipt == null || receipt.requiresTextFallback();
			if (!fallback) return;
			manager.server().execute(() -> {
				try {
					conversationRouter.deliverAgentMessageToPlayers(
							request.agentId(), ConversationAudience.PROXIMITY, recipientId, message
					);
				} catch (RuntimeException ignored) {
					// The speaker may have despawned before an asynchronous provider failure.
				}
			});
		});
	}

	private void interactBlock(
			ServerPlayer player,
			BlockPos position,
			Direction face,
			InteractionHand hand,
			String expectedItemId,
			JsonObject arguments
	) {
		ServerLevel level = player.level();
		if (face == null) throw new AgentDomainException("INVALID_FACE", "Interaction face is invalid");
		if (!level.hasChunkAt(position)) throw new AgentDomainException("TARGET_NOT_LOADED", "Target chunk is not loaded");
		if (!player.isWithinBlockInteractionRange(position, 0.0D)) {
			throw new AgentDomainException("TARGET_TOO_FAR", "Block interaction target is out of reach");
		}
		// Both gates apply: the custom policy and the native click gate a player's packet passes (spawn protection, border).
		if (!protection.mayInteractWithBlock(player, level, position) || !level.mayInteract(player, position)) {
			throw new AgentDomainException("PROTECTION_DENIED", "Block interaction was denied");
		}
		ItemStack held = player.getItemInHand(hand);
		requireHeldItem(held, expectedItemId);
		Vec3 hitLocation = blockInteractionAimPoint(player, position, face, arguments);
		Vec3 eye = player.getEyePosition();
		boolean fluidCell = isFluidCell(level, position);
		BlockHitResult hit;
		if (fluidCell) {
			player.lookAt(net.minecraft.commands.arguments.EntityAnchorArgument.Anchor.EYES, hitLocation);
			var fluidMode = held.is(net.minecraft.world.item.Items.BUCKET)
					? net.minecraft.world.level.ClipContext.Fluid.SOURCE_ONLY : BreakSightline.fluidRay(level, position);
			// This is also the validation for explicit hit coordinates, which bypass the automatic aim search.
			hit = VanillaItemRay.hit(player, fluidMode);
		} else {
			hit = level.clip(new net.minecraft.world.level.ClipContext(eye,
					hitLocation.add(hitLocation.subtract(eye).normalize().scale(0.001D)),
					net.minecraft.world.level.ClipContext.Block.OUTLINE, net.minecraft.world.level.ClipContext.Fluid.NONE, player));
		}
		if (hit.getType() != HitResult.Type.BLOCK || !hit.getBlockPos().equals(position) || hit.getDirection() != face) {
			throw new AgentDomainException("TARGET_OBSTRUCTED", fluidCell
					? "Full fluid ray hits " + hit.getType() + " at " + hit.getBlockPos() + " face " + hit.getDirection()
							+ "; requested " + position + " face " + face
					: "Requested block face is not reachable along the supplied hit ray");
		}
		if (!fluidCell) player.lookAt(net.minecraft.commands.arguments.EntityAnchorArgument.Anchor.EYES, hitLocation);
		// A player's right click: the crosshair ignores fluids, so a fluid target's click lands on whatever outline lies
		// behind it within reach, or on nothing.
		BlockHitResult crosshair = fluidCell ? crosshairBlock(player, level) : hit;
		boolean wasUsing = player.isUsingItem();
		InteractionResult result = crosshair == null ? InteractionResult.PASS
				: player.gameMode.useItemOn(player, level, held, hand, crosshair);
		// Vanilla's client then uses the held item itself when the block did not take the click: buckets fill and
		// empty along their own ray, which is the only way they act.
		if (!result.consumesAction() && !(result instanceof InteractionResult.Fail) && !held.isEmpty()) {
			String lavaAtBody = arguments.has("acceptLavaRisk") && bool(arguments, "acceptLavaRisk") ? null : BucketUse.lavaPourAtBody(player, held);
			if (lavaAtBody != null) throw new AgentDomainException("LAVA_POUR_AT_BODY", lavaAtBody);
			result = player.gameMode.useItem(player, level, held, hand);
			if (result.consumesAction() && player.isUsingItem() && !wasUsing) {
				// A click releases on the next tick, so a held-use item (food, bow, shield) does nothing here.
				player.releaseUsingItem();
				throw new AgentDomainException("HELD_USE_REQUIRED", "This item acts only while use is held; use_item holds it");
			}
		}
		if (!result.consumesAction()) {
			throw new AgentDomainException("INTERACTION_REJECTED", "Vanilla block interaction was not accepted");
		}
		ArmSwing.use(player, hand);
	}

	/** An outline-less cell holding fluid: water or lava, source or flowing. Waterlogged blocks keep their outline. */
	private static boolean isFluidCell(ServerLevel level, BlockPos position) {
		BlockState state = level.getBlockState(position);
		return !state.getFluidState().isEmpty() && state.getShape(level, position).isEmpty();
	}

	/** The block outline the current crosshair meets within reach, ignoring fluids as vanilla's pick does. */
	private BlockHitResult crosshairBlock(ServerPlayer player, ServerLevel level) {
		Vec3 eye = player.getEyePosition();
		BlockHitResult hit = level.clip(new net.minecraft.world.level.ClipContext(eye,
				eye.add(player.getViewVector(1.0F).scale(player.blockInteractionRange())),
				net.minecraft.world.level.ClipContext.Block.OUTLINE, net.minecraft.world.level.ClipContext.Fluid.NONE, player));
		if (hit.getType() != HitResult.Type.BLOCK || !player.isWithinBlockInteractionRange(hit.getBlockPos(), 0.0D)
				|| !protection.mayInteractWithBlock(player, level, hit.getBlockPos())
				|| !level.mayInteract(player, hit.getBlockPos())) return null;
		return hit;
	}

	private static Vec3 blockInteractionAimPoint(ServerPlayer player, BlockPos position, Direction face, JsonObject arguments) {
		if (face == null) throw new AgentDomainException("INVALID_FACE", "Interaction face is invalid");
		if (arguments.has("hitX") && !arguments.get("hitX").isJsonNull()) {
			return blockInteractionHitLocation(position, face, arguments, net.minecraft.world.phys.shapes.Shapes.empty());
		}
		if (isFluidCell(player.level(), position)) return TargetSightline.fluid(player, position, face);
		return TargetSightline.block(player, position, face);
	}

	static Vec3 blockInteractionHitLocation(BlockPos position, Direction face, JsonObject arguments, VoxelShape outline) {
		if (arguments.has("hitX") && !arguments.get("hitX").isJsonNull()) {
			return Vec3.atLowerCornerOf(position).add(number(arguments, "hitX"), number(arguments, "hitY"), number(arguments, "hitZ"));
		}
		if (outline.isEmpty()) throw new AgentDomainException("TARGET_OBSTRUCTED", "The requested block has no interaction outline");
		var bounds = outline.bounds();
		return Vec3.atLowerCornerOf(position).add(bounds.getCenter()).add(
				face.getStepX() * bounds.getXsize() * 0.5D,
				face.getStepY() * bounds.getYsize() * 0.5D,
				face.getStepZ() * bounds.getZsize() * 0.5D);
	}

	private void interactEntity(
			ServerPlayer player,
			String targetId,
			InteractionHand hand,
			String expectedItemId,
			JsonObject arguments
	) {
		Entity target = resolveExactObservedTarget(player, targetId);
		if (!player.isWithinEntityInteractionRange(target, 0.0D)) {
			throw new AgentDomainException("TARGET_TOO_FAR", "Entity interaction target is out of reach");
		}
		if (!protection.mayInteractWithEntity(player, target)) {
			throw new AgentDomainException("PROTECTION_DENIED", "Entity interaction was denied");
		}
		requireHeldItem(player.getItemInHand(hand), expectedItemId);
		Vec3 requestedHit = entityInteractionAimPoint(player, target, arguments);
		if (!target.getBoundingBox().inflate(0.001D).contains(requestedHit)) {
			throw new AgentDomainException("INVALID_HIT", "Entity hit must be inside the observed entity bounds");
		}
		player.lookAt(net.minecraft.commands.arguments.EntityAnchorArgument.Anchor.EYES, requestedHit);
		HitResult traced = Tracer.rayTrace(player, 1.0F, player.entityInteractionRange(), false);
		if (!(traced instanceof EntityHitResult entityHit) || entityHit.getEntity() != target) {
			throw new AgentDomainException("TARGET_OBSTRUCTED", "Entity is not reachable along the supplied hit ray");
		}
		Vec3 relativeHit = traced.getLocation().subtract(target.position());
		InteractionResult result = target.interact(player, hand, relativeHit);
		if (!result.consumesAction()) result = player.interactOn(target, hand, relativeHit);
		if (!result.consumesAction()) {
			throw new AgentDomainException("INTERACTION_REJECTED", "Vanilla entity interaction was not accepted");
		}
		ArmSwing.use(player, hand);
	}

	private static void requireHeldItem(ItemStack held, String expectedItemId) {
		String actualItemId = held.isEmpty() ? "minecraft:air" : BuiltInRegistries.ITEM.getKey(held.getItem()).toString();
		if (!actualItemId.equals(expectedItemId)) {
			throw new AgentDomainException(
					"HELD_ITEM_MISMATCH",
					"Expected " + expectedItemId + " in the selected hand but observed " + actualItemId
			);
		}
	}

	static InteractionHand hand(JsonObject arguments) {
		return switch (string(arguments, "hand")) {
			case "main" -> InteractionHand.MAIN_HAND;
			case "off" -> InteractionHand.OFF_HAND;
			default -> throw new AgentDomainException("INVALID_HAND", "Hand must be main or off");
		};
	}

	private static void dismount(ServerPlayer player) {
		if (!player.isPassenger()) throw new AgentDomainException("NOT_RIDING", "Agent is not riding an entity");
		player.stopRiding();
		if (player.isPassenger()) throw new AgentDomainException("DISMOUNT_NOT_CONFIRMED", "Vanilla dismount was not observed");
	}

	private static void startFallFlying(ServerPlayer player) {
		if (!player.tryToStartFallFlying() || !player.isFallFlying()) {
			throw new AgentDomainException("ELYTRA_START_REJECTED", "Vanilla elytra flight preconditions were not met");
		}
	}

	private static String nullableString(JsonObject object, String field) {
		return object.has(field) && !object.get(field).isJsonNull() ? object.get(field).getAsString() : null;
	}

	private static int integer(JsonObject object, String field) {
		return object.get(field).getAsInt();
	}

	private static double number(JsonObject object, String field) {
		return object.get(field).getAsDouble();
	}

	private static boolean continueWithAttackers(JsonObject arguments) {
		return dev.agaminggod.arenaagents.server.runtime.controller.CombatPlanning.followThrough(
				arguments.has("continueWithAttackers") ? bool(arguments, "continueWithAttackers") : null,
				dev.agaminggod.arenaagents.server.runtime.controller.CombatPlanning.TargetPolicy.parse(nullableString(arguments, "targetPolicy")));
	}

	private static boolean bool(JsonObject object, String field) {
		return object.get(field).getAsBoolean();
	}

	private static String safeMessage(Throwable throwable) {
		String message = throwable.getMessage();
		return message == null || message.isBlank() ? throwable.getClass().getSimpleName() : message;
	}

	static String failureReason(Throwable throwable) {
		return throwable instanceof AgentDomainException domain ? domain.code() : "ACTION_EXCEPTION";
	}

	private static final class ActiveAction {
		private enum Mode { IMMEDIATE, AIMED, CONTROL, CONTROL_SEQUENCE, MOVE, USE, BREAK, PLACE, WAIT, CONTROLLER, TRANSACTION }

		private final ServerActionRequest request;
		private final ServerPlayer player;
		private final Mode mode;
		private final ElapsedTimeAccumulator elapsedTime;
		/** Game time of this action's first tick: brink guard events from then on are named in its result. */
		private long brinkSince = -1L;
		private final net.minecraft.resources.ResourceKey<net.minecraft.world.level.Level> startingDimension;
		private final long timeoutMs;
		private final Runnable immediate;
		private final Vec3 destination;
		private final double tolerance;
		private final boolean sprint;
		private final BlockPos block;
		private final ActionProgressTracker progress;
		private final ActionProgressEmissionPolicy progressEmission =
				new ActionProgressEmissionPolicy(PROGRESS_EMISSION_DELTA, PROGRESS_HEARTBEAT_MS);
		private ServerController controller;
		private ServerTransactionAdapter.ActiveTransaction transaction;
		private String initialBlockId;
		private String expectedBlockId;
		private DesiredBlockState desiredBlockState;
		private Direction placementRequestedFace;
		private boolean placementStrictFace;
		private BlockHitResult placementAimHit;
		private String placementItemId;
		private int initialPlacementItemCount;
		private String resourceLeaseKey;
		private int placementAttempts;
		private java.util.function.Supplier<PlacementClick> placementClick;
		/** Set when one of this action's own clicks changed the destination into the requested state. */
		private boolean placementReceipt;
		/** Consecutive clicks the server refused for a reason that cannot clear; see BlockPlacementAttemptPolicy. */
		private int finalRefusals;
		private AimGate aimGate = new AimGate();
		private java.util.function.Supplier<Entity> immediateAimEntity;
		private long aimReadyElapsedMs = -1L;
		private java.util.function.Supplier<Vec3> transactionAimTarget;
		/** Look a directional placement needs; held while placing, then the view eases back to the face aim. */
		private Look placementLook;
		private Look placementRestoreLook;
		private ServerActionResult placementCompleted;
		private int placementRestoreTicks;
		private java.util.function.Supplier<Vec3> immediateAimTarget;
		private boolean breakInputIssued;
		/** An enclosing body controller may require crouching through its clearing clicks. */
		private boolean breakSneak;
		/** Set when the inventory holds a strictly faster tool for this block; appended to the success message. */
		private String breakSpeedNote;
		private BreakOutcomeEvidence.Tool breakTool;
		/** Structured break evidence for programs and scripts; the message carries the same facts for the model. */
		private BreakOutcomeEvidence.Summary breakSummary;
		/** The break expectation was omitted or a tag, so the result names the block that was actually broken. */
		private boolean breakNamesBlock;
		private final BreakOutcomeEvidence.Tally controlBreaks = new BreakOutcomeEvidence.Tally();
		private BlockBreakReceipt controlReceiptSeen;
		private boolean controlReceiptPrimed;
		private boolean breakObservedInCarpet;
		private BlockBreakReceipt breakReceiptBaseline;
		private int breakTicks;
		private ServerActionObservation lastObservation;
		private boolean executionStarted;
		private boolean physicalAttempted;
		private final long acceptedAtEpochMs = System.currentTimeMillis();
		/** Wall time this action waited paused under reflex firings, and when the tick loop last saw it. */
		private long pausedMs;
		/** Reflex firings that paused this action (rule id -> times), whether one holds it now, and how often it resumed. */
		private final java.util.LinkedHashMap<String, Integer> pausedBy = new java.util.LinkedHashMap<>();
		private boolean pausedNow;
		private int resumes;
		private long lastLoopMs;
		private long startedAtEpochMs;
		private long startedTick;
		private long serverTick;
		private double lastProgress;
		private InputLease inputLease;
		private AgentInputState controlState;
		private int controlDurationTicks;
		private int controlElapsedTicks;
		/** The model asked for its view at once; otherwise a frame's look is reached at player speed first. */
		private boolean instantLook;
		private boolean controlLookSettled;
		private int controlTurnTicks;
		private int sequenceTurnFrame = -1;
		private int sequenceTurnTicks;
		private int sequenceTotalTurnTicks;
		private int breakAimTicks;
		/** A point of the block's outline the crosshair meets first from this eye; the view turns there before mining. */
		private Vec3 breakAim;
		private BlockPos clearingPlant;
		private String clearingPlantId;
		private Consumer<BlockPos> plantProtection = at -> {
			throw new AgentDomainException("PROTECTION_DENIED", "Plant clearing requires an explicit protection policy");
		};
		private static final int MAX_CLEARED_PLANTS = 8;
		private static final int MAX_BREAK_REAIMS = 2;
		private int breakReaims;
		private final List<String> clearedPlants = new ArrayList<>();
		private ControlSequence controlSequence;
		private final SneakSettling sneakSettling = new SneakSettling();
		private boolean settlingControl;
		private boolean inspectThrow;
		private boolean useInputIssued;
		private java.util.function.Supplier<Vec3> useAim;
		private JsonObject throwPreview;
		private InteractionHand useHand;
		private int useDurationTicks;
		private int useElapsedTicks;
		private long useAcceptedBaseline;
		private boolean useOnce;
		private boolean useStartObserved;
		/** A bucket's resolved look, what its ray met as use was pressed, and the hand item then. */
		private Vec3 bucketAim;
		private String bucketRay;
		private String bucketHeldBefore;
		/** acceptLavaRisk: empty a lava bucket even where its uncast flow would reach the body. */
		private boolean acceptLavaRisk;
		/** Why held use cannot eat the held food, sampled while the input holds use. */
		private String useFoodRefusal;
		/** How a navigation request was read when its cell could not be stood in (see standingInColumn), or null. */
		String destinationNote;
		private final HazardEntry hazardEntry = new HazardEntry();
		private final FallReport falls = new FallReport();

		private ActiveAction(
				ServerActionRequest request,
				ServerPlayer player,
				Mode mode,
				long timeoutMs,
				Runnable immediate,
				Vec3 destination,
				double tolerance,
				boolean sprint,
				BlockPos block
		) {
			this.request = request;
			this.player = player;
			this.mode = mode;
			this.startingDimension = player == null ? null : player.level().dimension();
			long startedAt = System.currentTimeMillis();
			this.elapsedTime = new ElapsedTimeAccumulator(startedAt);
			this.timeoutMs = Math.max(1L, timeoutMs);
			this.immediate = immediate;
			this.destination = destination;
			this.tolerance = tolerance;
			this.sprint = sprint;
			this.block = block;
			this.progress = mode == Mode.MOVE
					? new ActionProgressTracker(player.position().distanceTo(destination), startedAt, MOVEMENT_STALL_TIMEOUT_MS)
					: null;
		}

		static ActiveAction immediate(ServerActionRequest request, ServerPlayer player, Runnable operation) {
			return new ActiveAction(request, player, Mode.IMMEDIATE, DEFAULT_TIMEOUT_MS, operation, null, 0.0D, false, null);
		}

		/** A one-tick vanilla interaction that waits for the view to turn onto {@code aimTarget} and settle first. */
		static ActiveAction aimed(ServerActionRequest request, ServerPlayer player, java.util.function.Supplier<Vec3> aimTarget,
				Runnable operation) {
			ActiveAction action = new ActiveAction(request, player, Mode.AIMED, DEFAULT_TIMEOUT_MS, operation, null, 0.0D, false, null);
			action.immediateAimTarget = Objects.requireNonNull(aimTarget, "aimTarget must not be null");
			return action;
		}

		/**
		 * A melee swing: the view turns toward the target's exposed hitbox part at player speed and swings once the crosshair
		 * is on the hitbox for {@link AimGate#ATTACK_SETTLE_TICKS} tick, instead of settling within 3 degrees for {@link AimGate#SETTLE_TICKS} ticks.
		 */
		static ActiveAction aimedAtEntity(ServerActionRequest request, ServerPlayer player,
				java.util.function.Supplier<Entity> target, Runnable operation) {
			ActiveAction action = aimed(request, player, () -> attackAimPoint(player, target.get()), operation);
			action.immediateAimEntity = target;
			action.aimGate = new AimGate(AimGate.ATTACK_SETTLE_TICKS);
			return action;
		}

		static ActiveAction control(
				ServerActionRequest request,
				ServerPlayer player,
				AgentInputState state,
				int durationTicks,
				boolean instantLook
		) {
			ActiveAction action = new ActiveAction(
					request, player, Mode.CONTROL, DEFAULT_TIMEOUT_MS, null, null, 0.0D, false, null
			);
			action.controlState = Objects.requireNonNull(state, "control state must not be null");
			if (durationTicks < 1 || durationTicks > 200) {
				throw new IllegalArgumentException("control duration must be 1..200 ticks");
			}
			action.controlDurationTicks = durationTicks;
			action.instantLook = instantLook;
			return action;
		}

		static ActiveAction move(
				ServerActionRequest request,
				ServerPlayer player,
				Vec3 destination,
				double tolerance,
				boolean sprint,
				long timeoutMs
		) {
			return new ActiveAction(request, player, Mode.MOVE, timeoutMs, null, destination, tolerance, sprint, null);
		}

		static ActiveAction controlSequence(ServerActionRequest request, ServerPlayer player, ControlSequence sequence) {
			ActiveAction action = new ActiveAction(request, player, Mode.CONTROL_SEQUENCE,
					DEFAULT_TIMEOUT_MS, null, null, 0.0D, false, null);
			action.controlSequence = Objects.requireNonNull(sequence, "sequence must not be null");
			return action;
		}

		static ActiveAction use(ServerActionRequest request, ServerPlayer player, long durationMs,
				InteractionHand hand, String expectedItemId, boolean once) {
			if (expectedItemId != null) requireHeldItem(player.getItemInHand(hand), expectedItemId);
			ActiveAction action = new ActiveAction(request, player, Mode.USE, durationMs, null, null, 0.0D, false, null);
			action.useOnce = once;
			action.useHand = hand;
			action.useDurationTicks = Math.toIntExact(Math.max(1L, (durationMs + 49L) / 50L));
			return action;
		}

		static ActiveAction breakBlock(
				ServerActionRequest request,
				ServerPlayer player,
				BlockPos block,
				long timeoutMs,
				String initialBlockId,
				String expectedBlockId,
				Vec3 aim
		) {
			ActiveAction action = new ActiveAction(request, player, Mode.BREAK, timeoutMs, null, null, 0.0D, false, block);
			action.initialBlockId = Objects.requireNonNull(initialBlockId, "initialBlockId must not be null");
			action.expectedBlockId = Objects.requireNonNull(expectedBlockId, "expectedBlockId must not be null");
			action.breakAim = Objects.requireNonNull(aim, "aim must not be null");
			return action;
		}

		static ActiveAction placeBlock(
				ServerActionRequest request,
				ServerPlayer player,
				java.util.function.Supplier<PlacementClick> click,
				BlockPos block,
				String initialBlockId,
				String expectedBlockId,
				DesiredBlockState desiredBlockState,
				Direction placementRequestedFace,
				String itemId,
				int initialItemCount
		) {
			ActiveAction action = new ActiveAction(
					request,
					player,
					Mode.PLACE,
					PLACE_TIMEOUT_MS,
					null,
					null,
					0.0D,
					false,
					block
			);
			action.placementClick = Objects.requireNonNull(click, "click must not be null");
			action.initialBlockId = initialBlockId;
			action.expectedBlockId = Objects.requireNonNull(expectedBlockId, "expectedBlockId must not be null");
			action.desiredBlockState = Objects.requireNonNull(desiredBlockState, "desiredBlockState must not be null");
			action.placementRequestedFace = placementRequestedFace;
			action.placementItemId = Objects.requireNonNull(itemId, "itemId must not be null");
			action.initialPlacementItemCount = Math.max(0, initialItemCount);
			return action;
		}

		static ActiveAction waitFor(ServerActionRequest request, ServerPlayer player, long durationMs) {
			return new ActiveAction(request, player, Mode.WAIT, durationMs, null, null, 0.0D, false, null);
		}

		static ActiveAction controller(
				ServerActionRequest request,
				ServerPlayer player,
				ServerController controller
		) {
			ActiveAction action = new ActiveAction(
					request,
					player,
					Mode.CONTROLLER,
					DEFAULT_TIMEOUT_MS,
					null,
					null,
					0.0D,
					false,
					null
			);
			action.controller = Objects.requireNonNull(controller, "controller must not be null");
			return action;
		}

		static ActiveAction transaction(
				ServerActionRequest request,
				ServerPlayer player,
				ServerTransactionAdapter.ActiveTransaction transaction
		) {
			ActiveAction action = new ActiveAction(
					request,
					player,
					Mode.TRANSACTION,
					DEFAULT_TIMEOUT_MS,
					null,
					null,
					0.0D,
					false,
					null
			);
			action.transaction = Objects.requireNonNull(transaction, "transaction must not be null");
			return action;
		}

		ServerActionRequest request() {
			return request;
		}

		ServerActionResult tick(long now) {
			if (startingDimension != null && !startingDimension.equals(player.level().dimension())) {
				// A move onto a portal it targeted ends by going through: that crossing is the arrival.
				if (controller instanceof ServerNavigationController navigation && navigation.targetsPortal()) {
					return result(ServerActionState.SUCCEEDED, "DESTINATION_REACHED", "Stepped into the targeted portal and crossed from "
							+ startingDimension.identifier() + " to " + player.level().dimension().identifier(), now);
				}
				return result(ServerActionState.CANCELLED, "DIMENSION_TRANSITION",
						"Player changed dimension from " + startingDimension.identifier() + " to " + player.level().dimension().identifier()
								+ "; this action stopped and its original outcome is unconfirmed", now);
			}
			falls.observe(player);
			// Ruling 12: a model-commanded move, use, placement or controller is a stance the brink guard may walk back.
			if (mode == Mode.MOVE || mode == Mode.USE || mode == Mode.PLACE || mode == Mode.CONTROLLER)
				dev.agaminggod.arenaagents.server.runtime.controller.BrinkGuard.commandedAction(player);
			if (brinkSince < 0L) brinkSince = player.level().getGameTime();
			if (isControl()) collectControlBreaks();
			if (!player.isAlive()) {
				// A transaction that already committed (a craft whose result was taken) still reports its success.
				if (mode == Mode.TRANSACTION && executionStarted) {
					ServerTransactionAdapter.TickResult settled = transaction.tick(now);
					if (settled.state() == ServerTransactionAdapter.TickState.SUCCEEDED) {
						return result(ServerActionState.SUCCEEDED, settled.reasonCode(), settled.message(), now);
					}
				}
				return result(ServerActionState.FAILED, "AGENT_DEAD", "Agent player died", now);
			}
			long elapsed = elapsedTime.advance(now);
			ServerActionResult hazard = hazardStop(now);
			if (hazard != null) return hazard;
			if (!executionStarted) {
				executionStarted = true;
				startedAtEpochMs = now;
				startedTick = serverTick;
				switch (mode) {
					case IMMEDIATE -> {
						physicalAttempted = true;
						immediate.run();
					}
					case CONTROL -> {
						physicalAttempted = true;
						applyControlFrame();
						return null;
					}
					case CONTROL_SEQUENCE -> { }
					case MOVE -> {
						physicalAttempted = true;
						applyLookingInput(InputOwner.NAVIGATION, 100, destination, 1.0F, true, false, false);
					}
					case USE -> {
						useAcceptedBaseline = AgentInputRuntime.controller(player).acceptedUses(request.agentId());
					}
					case BREAK -> {
						configureBreakTarget(validateBreakTarget(player, block, expectedBlockId));
						breakReceiptBaseline = ((BlockBreakReceiptAccess) (Object) player.gameMode).arenaagents$getBlockBreakReceipt();
						physicalAttempted = true;
					}
					case PLACE, AIMED -> {
					}
					case WAIT -> {
					}
					case CONTROLLER -> {
					}
					case TRANSACTION -> {
					}
				}
				if (mode == Mode.IMMEDIATE) {
					if (request.type() == ActionType.ATTACK) return result(ServerActionState.SUCCEEDED,
							"ATTACK_APPLIED", "Vanilla attack applied to the requested target; damage or death is not confirmed", now);
					return result(ServerActionState.SUCCEEDED, "ACTION_COMPLETED", "Action completed", now);
				}
			}

			if (mode == Mode.CONTROL_SEQUENCE) return tickControlSequence(now);
			if (mode == Mode.USE) {
				if (!useInputIssued) {
					Vec3 aim = useAim == null ? null : useAim.get();
					if (inspectThrow) {
						throwPreview = ThrowPreview.sample(player, player.getItemInHand(useHand), aim);
						return result(throwPreview == null ? ServerActionState.FAILED : ServerActionState.SUCCEEDED,
								throwPreview == null ? "THROWABLE_REQUIRED" : "THROW_PREVIEW", "Throw inspection; no use input issued", now);
					}
					ItemStack held = player.getItemInHand(useHand);
					if (aim != null && BucketUse.is(held)) {
						if (bucketAim == null) bucketAim = BucketUse.aim(player, held.getItem(), aim);
						aim = bucketAim;
					}
					if (aim != null) {
						AimGate.State aiming = aimAt(aim);
						if (aiming == AimGate.State.FAILED) return result(ServerActionState.FAILED, "AIM_NOT_SETTLED", "Throw aim did not settle", now);
						if (aiming != AimGate.State.READY) return null;
					}
					throwPreview = ThrowPreview.sample(player, held, aim);
					String lavaAtBody = acceptLavaRisk ? null : BucketUse.lavaPourAtBody(player, held);
					if (lavaAtBody != null) return result(ServerActionState.FAILED, "LAVA_POUR_AT_BODY", lavaAtBody, now);
					physicalAttempted = true;
					if (BucketUse.is(held)) {
						bucketHeldBefore = BuiltInRegistries.ITEM.getKey(held.getItem()).toString();
						bucketRay = BucketUse.ray(player, held);
					}
					applyUseInput();
					useInputIssued = true;
					return null;
				}
				useElapsedTicks++;
				useStartObserved |= player.isUsingItem() && player.getUsedItemHand() == useHand;
				long accepted = Math.max(0L, AgentInputRuntime.controller(player).acceptedUses(request.agentId()) - useAcceptedBaseline);
				if (useElapsedTicks >= useDurationTicks || useOnce && accepted > 0) {
					if (!useStartObserved) useFoodRefusal = fullHungerRefusal(player, useHand);
					releaseInput();
					if (bucketRay != null) {
						ItemStack after = player.getItemInHand(useHand);
						String hand = "hand " + bucketHeldBefore + " -> "
								+ (after.isEmpty() ? "minecraft:air" : BuiltInRegistries.ITEM.getKey(after.getItem()).toString());
						return accepted > 0
								? result(ServerActionState.SUCCEEDED, "USE_INPUT_CONFIRMED", "Held use for " + useElapsedTicks
										+ " server ticks; accepted interactions=" + accepted + "; bucket ray met " + bucketRay + "; " + hand
										// Held use repeats every 4 ticks, as a held right click does: a bucket acts again on what it just did.
										+ (accepted > 1 ? "; held use repeats like a held right click, so the bucket acted " + accepted
												+ " times; mode:\"once\" acts once" : ""), now)
								: result(ServerActionState.FAILED, "USE_NOT_ACCEPTED", "The bucket did not act; its ray met "
										+ bucketRay + "; " + hand, now);
					}
					return accepted > 0
							? result(ServerActionState.SUCCEEDED, "USE_INPUT_CONFIRMED",
									useFeedback("Held use for " + useElapsedTicks + " server ticks; accepted interactions=" + accepted
											+ ", using state observed=" + useStartObserved + ", input released=true; downstream effects are unconfirmed",
											useFoodRefusal, useStartObserved), now)
							: result(ServerActionState.FAILED, "USE_NOT_ACCEPTED", Objects.requireNonNullElse(
									useFoodRefusal, "Held use input was released without an accepted vanilla interaction"), now);
				}
				applyUseInput();
				lastProgress = (double) useElapsedTicks / useDurationTicks;
				return null;
			}
			if (mode == Mode.CONTROL) {
				if (settlingControl) return settleControl() ? null : controlCompleted(now);
				ServerActionResult edge = voidEdgeStop(controlState, now);
				if (edge != null) return edge;
				physicalAttempted = true;
				// The frame's ticks run once its look is reached, so a turn never shortens the held input.
				boolean frameWasHeld = controlLookSettled;
				applyControlFrame();
				if (frameWasHeld) controlElapsedTicks++;
				if (controlState.use()) {
					useStartObserved |= player.isUsingItem();
					if (frameWasHeld && useFoodRefusal == null) useFoodRefusal = fullHungerRefusal(player, controlHand());
				}
				lastProgress = (double) controlElapsedTicks / controlDurationTicks;
				if (controlElapsedTicks >= controlDurationTicks) {
					settlingControl = true;
					return settleControl() ? null : controlCompleted(now);
				}
				return null;
			} else if (mode == Mode.MOVE) {
				double distance = player.position().distanceTo(destination);
				lastProgress = progress.progress(distance);
				physicalAttempted = true;
				applyLookingInput(InputOwner.NAVIGATION, 100, destination, 1.0F, true, false, false);
				if (distance <= tolerance) {
					return result(ServerActionState.SUCCEEDED, "DESTINATION_REACHED", "Destination reached", now);
				}
				if (progress.stalled(distance, now)) {
					return result(
							ServerActionState.FAILED,
							"PATH_BLOCKED",
							"Agent made no progress for 4 seconds; replanning around the obstacle",
							now
					);
				}
			} else if (mode == Mode.BREAK) {
				physicalAttempted = true;
				if (clearingPlant != null) {
					if (elapsed >= timeoutMs) return result(ServerActionState.TIMED_OUT, "ACTION_TIMED_OUT", "Timed out clearing the obstructing plant", now);
					BlockState state = player.level().getBlockState(clearingPlant);
					BlockBreakReceipt receipt = ((BlockBreakReceiptAccess) (Object) player.gameMode).arenaagents$getBlockBreakReceipt();
					try {
						if (!advancePlantClearing(state, receipt, () -> validateBreakTarget(player, block, expectedBlockId))) {
							applyBreakInput(true);
						}
					} catch (AgentDomainException rejected) {
						return result(ServerActionState.FAILED, rejected.code(), rejected.getMessage(), now);
					}
					return null;
				}
				if (!breakInputIssued) {
					// Look before swinging: mine from wherever the crosshair already sits on the block (a look_at
					// usually aimed at one face), or turn at player speed to a visible point of it first: its center,
					// or the visible part of a partly hidden block. Re-aiming every break at the exact center was a
					// small snap after each look_at, and a large one without it.
					if (!crosshairOn(block)) {
						AgentInputState desired = AgentInputStates.lookingAt(
								player, breakAim, 0.0F, 0.0F, false, false, false, false, false, InteractionHand.MAIN_HAND);
						// Already looking at the aim point (the eased turn lands exactly) yet the ray hits something else:
						// aim again from this eye, else report what is in the way.
						if (Math.abs(AgentInputStates.shortestAngleDelta(player.getYRot(), desired.yaw())) <= 0.5F
								&& Math.abs(player.getXRot() - desired.pitch()) <= 0.5F) {
							HitResult blocking = breakRayTarget(player);
							Vec3 again = blocking instanceof EntityHitResult ? null : BreakSightline.visiblePoint(player.level(),
									CollisionContext.of(player), player.getEyePosition(), block, player.blockInteractionRange(), breakAim);
							if (again == null) {
								lastObservation = breakObservation(now, blocking,
										blockId(player.level().getBlockState(block)), 0.0D, false);
								String why = blocking instanceof EntityHitResult entityHit
										? BuiltInRegistries.ENTITY_TYPE.getKey(entityHit.getEntity().getType()) + " is in the way"
										: "No aim at its visible outline survived player-angle rounding; " + hiddenBreakTargetMessage(player, block);
								return result(ServerActionState.FAILED, "TARGET_NOT_VISIBLE", why, now);
							}
							breakAim = again;
						}
						if (++breakAimTicks > AimGate.MAX_TICKS) {
							return result(ServerActionState.FAILED, "AIM_NOT_REACHED",
									"The agent's view did not settle on the target block", now);
						}
						applyBreakInput(false);
						return null;
					}
					clearPostBreakDelay();
					breakSpeedNote = BreakSpeedAdvisor.advise(player, block, player.level().getBlockState(block));
					breakTool = BreakOutcomeEvidence.tool(player, player.level().getBlockState(block));
					breakInputIssued = true;
				}
				// Renew the deadman lease without restarting Carpet's continuous attack.
				// Slow blocks such as logs take longer than the 40-tick lease window.
				applyBreakInput(true);
				breakTicks++;
				BlockState currentState = player.level().getBlockState(block);
				String currentBlockId = blockId(currentState);
				HitResult hit = breakRayTarget(player);
				boolean exactRayTarget = hit instanceof BlockHitResult blockHit && block.equals(blockHit.getBlockPos());
				BlockBreakReceipt receipt = ((BlockBreakReceiptAccess) (Object) player.gameMode).arenaagents$getBlockBreakReceipt();
				boolean ownedTransition = breakInputIssued && receipt != null
						&& receipt.confirms(breakReceiptBaseline, block, expectedBlockId, currentState);
				if (ownedTransition) {
					lastObservation = breakObservation(now, hit, currentBlockId, 1.0D, true).withRevealedBlocks(receipt.revealedBlocks());
					// A fact, not a refusal: lava the agent hears beside the opened block can now flow in.
					String broken = breakNamesBlock ? "Broken " + blockId(receipt.before()) : "Broken";
					if (receipt.outcome() != null) {
						// The speed advice already names the held item.
						broken += (breakSpeedNote == null ? " " : "; ") + BreakOutcomeEvidence.note(receipt.outcome(), breakSpeedNote != null);
						BreakOutcomeEvidence.Tally tally = new BreakOutcomeEvidence.Tally();
						tally.add(receipt.outcome());
						breakSummary = tally.summary(BreakOutcomeEvidence.itemId(player.getMainHandItem()));
					}
					String opened = lavaOpened(player, block);
					if (opened != null) broken += "; " + opened;
					else if (dev.agaminggod.arenaagents.server.perception.HearingPerception.lavaHeardNear(player, block, 2.5D)) {
						broken += "; lava is heard within 2 blocks";
					}
					return result(ServerActionState.SUCCEEDED, "BLOCK_BROKEN",
							(breakSpeedNote == null ? broken : broken + "; " + breakSpeedNote), now);
				}
				if (!currentState.isAir() && !expectedBlockId.equals(currentBlockId)) {
					lastObservation = breakObservation(now, hit, currentBlockId, 0.0D, false);
					return result(ServerActionState.FAILED, "TARGET_CHANGED", "The observed block changed before it was broken", now);
				}
				if (currentState.isAir()) {
					lastObservation = breakObservation(now, hit, currentBlockId, 0.0D, false);
					return result(ServerActionState.FAILED, "TARGET_CHANGED", "The target is now air without this action's removal receipt; no break or drops credited. Do not retry this empty cell", now);
				}
				if (!exactRayTarget) {
					if (BreakSightline.plantToClear(player.level(), CollisionContext.of(player), player.getEyePosition(), block,
							player.blockInteractionRange()) != null) {
						try {
							BreakTarget retry = validateBreakTarget(player, block, expectedBlockId);
							if (retryBreakTarget(retry)) {
								breakReceiptBaseline = receipt;
								return null;
							}
						} catch (AgentDomainException rejected) {
							return result(ServerActionState.FAILED, rejected.code(), rejected.getMessage(), now);
						}
					}
					lastObservation = breakObservation(now, hit, currentBlockId, lastProgress, false);
					return result(ServerActionState.FAILED, "TARGET_NOT_VISIBLE",
							"The target is no longer under the crosshair; " + crosshairNow(player, hit), now);
				}
				EntityPlayerActionPack actionPack = OfflineAgentPlayers.actions(player);
				EntityPlayerActionPackAccessor accessor = (EntityPlayerActionPackAccessor) (Object) actionPack;
				BlockPos carpetTarget = accessor.arenaagents$getCurrentBlock();
				if (block.equals(carpetTarget)) {
					breakObservedInCarpet = true;
					lastProgress = Math.max(0.0D, Math.min(1.0D, accessor.arenaagents$getCurrentBlockDamage()));
				} else {
					lastProgress = 0.0D;
					if (breakTicks > 1 && carpetTarget != null) {
						lastObservation = breakObservation(now, hit, currentBlockId, 0.0D, false);
						return result(ServerActionState.FAILED, "TARGET_NOT_STARTED", "Carpet is mining a different block", now);
					}
				}
				lastObservation = breakObservation(now, hit, currentBlockId, lastProgress, breakObservedInCarpet);
			} else if (mode == Mode.PLACE) {
				if (initialBlockId == null) {
					// Turn to the authored cell before acquiring its current occupancy. Hidden state never supplies an outcome.
					Vec3 entryAim = TargetSightline.block(player.level(), CollisionContext.of(player), player.getEyePosition(),
							block, player.blockInteractionRange(), null);
					if (entryAim == null) entryAim = placementAimTarget();
					AimGate.State admissionAim = aimAt(entryAim);
					if (admissionAim == AimGate.State.FAILED) return result(ServerActionState.FAILED, "AIM_NOT_REACHED",
							"The agent's view did not settle on the placement destination", now);
					if (admissionAim == AimGate.State.AIMING) return null;
					initialBlockId = blockId(perceivedPlacementState(player, block));
					aimGate = new AimGate();
				}
				if (placementCompleted != null) {
					if (stepLookToward(placementRestoreLook) || ++placementRestoreTicks >= MAX_CONTROL_TURN_TICKS) {
						return placementCompleted;
					}
					return null;
				}
				boolean placementOwned = player.isCreative()
						? placementAttempts > 0
						: placementReceipt || inventoryItemCount(player, placementItemId) == initialPlacementItemCount - 1;
				BlockPlacementPostcondition.Decision decision = BlockPlacementPostcondition.evaluate(
						initialBlockId,
						player.level().getBlockState(block),
						desiredBlockState,
										placementOwned,
										elapsed >= timeoutMs,
										BlockPlacementAttemptPolicy.countedAttempts(placementAttempts, finalRefusals)
								);
				if (decision == BlockPlacementPostcondition.Decision.ALREADY_SATISFIED) {
					return result(ServerActionState.SUCCEEDED, "TARGET_ALREADY_SATISFIED", "Requested block was already present", now);
				}
				if (decision == BlockPlacementPostcondition.Decision.SUCCEEDED) {
					ServerActionResult placed = result(ServerActionState.SUCCEEDED, "BLOCK_PLACED", "Block placement confirmed" + (placementSelection.isEmpty() ? "" : "; " + placementSelection), now);
					if (placementLook == null) return placed;
					// The facing needed a particular look; ease back to the support-face aim, as a player would.
					placementCompleted = placed;
					placementRestoreLook = lookToward(placementAimHit.getLocation());
					return null;
				}
				if (decision == BlockPlacementPostcondition.Decision.CONFLICT) {
					return result(ServerActionState.FAILED, "PLACEMENT_CONFLICT", placementFailureMessage(
							"A different block or state occupied the target"), now);
				}
				if (decision == BlockPlacementPostcondition.Decision.TIMED_OUT
						|| decision == BlockPlacementPostcondition.Decision.EXHAUSTED) {
					return result(ServerActionState.TIMED_OUT, "PLACEMENT_NOT_CONFIRMED", placementFailureMessage(
							finalRefusals >= BlockPlacementAttemptPolicy.FINAL_REFUSAL_LIMIT
									? "Block placement was not confirmed; the server refused " + finalRefusals
											+ " clicks and nothing in the way can clear"
									: "Block placement was not confirmed"), now);
				}
				// Look at the support face first, like a player, then place with an arm swing. Retries are timed
				// from the moment the view settled so a slow turn does not use up the attempt budget.
				Look faceAim = lookToward(placementAimTarget());
				if (!aimGate.ready()) placementLook = directionalPlacementLook(faceAim);
				Look aimLook = placementLook == null ? faceAim : placementLook;
				AimGate.State aim = aimAtLook(aimLook);
				if (aim == AimGate.State.FAILED) {
					return result(ServerActionState.FAILED, "AIM_NOT_REACHED",
							"The agent's view did not settle on the placement face", now);
				}
				if (aim == AimGate.State.READY) {
					// Within the gate's 3 degrees: land exactly on the look the facing was predicted from.
					if (placementLook != null) applyExactLook(placementLook);
					if (aimReadyElapsedMs < 0L) aimReadyElapsedMs = elapsed;
					if (BlockPlacementAttemptPolicy.shouldAttempt(elapsed - aimReadyElapsedMs,
							BlockPlacementAttemptPolicy.countedAttempts(placementAttempts, finalRefusals))) {
						physicalAttempted = true;
						PlacementClick click = placementClick.get();
						if (!click.selection().isEmpty()) placementSelection = click.selection();
						placementReceipt |= click.placed();
						placementAttempts += 1;
						finalRefusals = click.mayClear() ? 0 : finalRefusals + 1;
					}
				}
			} else if (mode == Mode.AIMED) {
				AimGate.State aim = immediateAimEntity == null ? aimAt(immediateAimTarget.get()) : aimAtEntity(immediateAimEntity.get());
				if (aim == AimGate.State.FAILED) {
					return result(ServerActionState.FAILED, "AIM_NOT_REACHED",
							"The agent's view did not settle on the target", now);
				}
				if (aim == AimGate.State.READY) {
					physicalAttempted = true;
					releaseInput();
					immediate.run();
					if (request.type() == ActionType.ATTACK) return result(ServerActionState.SUCCEEDED,
							"ATTACK_APPLIED", "Vanilla attack applied to the requested target; damage or death is not confirmed", now);
					return result(ServerActionState.SUCCEEDED, "ACTION_COMPLETED", "Action completed", now);
				}
			} else if (mode == Mode.WAIT && elapsed >= timeoutMs) {
				return result(ServerActionState.SUCCEEDED, "ACTION_COMPLETED", "Action completed", now);
			}
			if (mode == Mode.CONTROLLER) {
				physicalAttempted = true;
				ServerController.TickResult controllerResult = requireControllerResult(
						controller.tick(player, now), lastProgress, controller.getClass().getSimpleName());
				if ("ITEM_ALREADY_PICKED_UP".equals(controllerResult.reasonCode())) physicalAttempted = false;
				lastProgress = controllerResult.progress();
				if (controller instanceof ServerNavigationController navigation) {
					lastObservation = navigationObservation(navigation.authoritativeState(player, now), now);
				}
				String controllerMessage = controllerResult.message();
				if (destinationNote != null && controllerResult.state() != ServerController.State.RUNNING) controllerMessage += destinationNote;
				if (controllerResult.state() != ServerController.State.RUNNING && controllerResult.state() != ServerController.State.SUCCEEDED
						&& (request.type() == ActionType.MOVE_TO || request.type() == ActionType.NAVIGATE_TO)) {
					JsonObject args = request.arguments();
					controllerMessage = ActionResultFacts.destinationMessage(controllerResult.reasonCode(), controllerMessage,
							ActionResultFacts.blockedDestination(player, new Vec3(number(args, "x"), number(args, "y"), number(args, "z"))));
				}
				if ((controller instanceof ServerNavigationController
						|| controller instanceof dev.agaminggod.arenaagents.server.runtime.controller.ServerTravelController)
						&& controllerResult.state() != ServerController.State.RUNNING)
					controllerMessage += dev.agaminggod.arenaagents.server.perception.EdgeExposure.describe(player)
							+ dev.agaminggod.arenaagents.server.perception.EdgeExposure.lavaNote(player);
				return switch (controllerResult.state()) {
					case RUNNING -> null;
					case SUCCEEDED -> result(
							ServerActionState.SUCCEEDED,
							controllerResult.reasonCode(),
							controllerMessage,
							now
					);
					case FAILED -> result(
							ServerActionState.FAILED,
							controllerResult.reasonCode(),
							controllerMessage,
							now
					);
					case TIMED_OUT -> result(
							ServerActionState.TIMED_OUT,
							controllerResult.reasonCode(),
							controllerMessage,
							now
					);
				};
			}
			if (mode == Mode.TRANSACTION) {
				if (transactionAimTarget != null) {
					// Block menus (crafting table, furnace, chest) open only after the agent has turned to face the
					// block; the look is held while the menu is in use.
					AimGate.State aim = aimAt(transactionAimTarget.get());
					if (aim == AimGate.State.FAILED) {
						return result(ServerActionState.FAILED, "AIM_NOT_REACHED",
								"The agent's view did not settle on the target block", now);
					}
					if (aim == AimGate.State.AIMING) return null;
				}
				physicalAttempted = true;
				ServerTransactionAdapter.TickResult transactionResult = transaction.tick(now);
				lastProgress = timedProgress(elapsed);
				return switch (transactionResult.state()) {
					case RUNNING -> null;
					case SUCCEEDED -> result(ServerActionState.SUCCEEDED, transactionResult.reasonCode(), transactionResult.message(), now);
					case FAILED -> result(ServerActionState.FAILED, transactionResult.reasonCode(), transactionResult.message(), now);
					case CANCELLED -> result(ServerActionState.CANCELLED, transactionResult.reasonCode(), transactionResult.message(), now);
					case TIMED_OUT -> result(ServerActionState.TIMED_OUT, transactionResult.reasonCode(), transactionResult.message(), now);
				};
			}

			if (elapsed >= timeoutMs) {
				return result(ServerActionState.TIMED_OUT, "ACTION_TIMED_OUT", "Action timed out", now);
			}
			if (mode != Mode.MOVE && mode != Mode.CONTROLLER && mode != Mode.TRANSACTION && mode != Mode.BREAK) {
				lastProgress = timedProgress(elapsed);
			}
			return null;
		}

		ServerActionProgress progress(long now) {
			// Navigation can replan between its tick result and authoritative snapshot.
			// Publish the snapshot's fraction with that snapshot, not the prior endpoint's.
			double bounded = lastObservation != null && lastObservation.progress() != null
					? lastObservation.progress().value()
					: Math.max(0.0D, Math.min(lastObservation == null ? 0.99D : 1.0D, lastProgress));
			if (!progressEmission.shouldEmit(bounded, now)) return null;
			return new ServerActionProgress(
					request.agentId(),
					request.goalRevision(),
					request.actionId(),
					request.type(),
					request.traceId(),
					bounded,
					elapsedTime.advance(now),
					now,
					lastObservation
			);
		}

		private double timedProgress(long elapsed) {
			return Math.max(0.0D, Math.min(0.99D, (double) elapsed / timeoutMs));
		}

		private ServerActionObservation breakObservation(
				long now,
				HitResult hit,
				String currentBlockId,
				double progressValue,
				boolean verified
		) {
			Vec3 velocity = player.getDeltaMovement();
			Vec3 eye = player.getEyePosition();
			double maxReach = player.blockInteractionRange();
			double distance = Math.sqrt(player.distanceToSqr(Vec3.atCenterOf(block)));
			ServerActionObservation.RayTarget rayTarget;
			if (hit instanceof BlockHitResult blockHit) {
				BlockPos hitPosition = blockHit.getBlockPos();
				rayTarget = new ServerActionObservation.RayTarget(
						"block",
						new ServerActionObservation.Position(hitPosition.getX(), hitPosition.getY(), hitPosition.getZ()),
						blockId(player.level().getBlockState(hitPosition)),
						blockHit.getDirection().getSerializedName(),
						eye.distanceTo(hit.getLocation())
				);
			} else {
				rayTarget = new ServerActionObservation.RayTarget(
						hit.getType().name().toLowerCase(java.util.Locale.ROOT),
						null,
						null,
						null,
						eye.distanceTo(hit.getLocation())
				);
			}
			boolean worldChanged = !initialBlockId.equals(currentBlockId);
			String progressBasis = worldChanged ? "world_mutation" : "block_damage";
			return new ServerActionObservation(
					Math.max(0L, player.level().getGameTime()),
					now,
					new ServerActionObservation.Position(player.getX(), player.getY(), player.getZ()),
					new ServerActionObservation.Position(velocity.x(), velocity.y(), velocity.z()),
					player.getYRot(),
					player.getXRot(),
					new ServerActionObservation.Collision(player.horizontalCollision, player.verticalCollision, player.isInWall()),
					rayTarget,
					new ServerActionObservation.Reach(distance, maxReach, player.isWithinBlockInteractionRange(block, 1.0D)),
					new ServerActionObservation.Target(
							"block",
							new ServerActionObservation.Position(block.getX(), block.getY(), block.getZ()),
							expectedBlockId,
							currentBlockId,
							initialBlockId,
							currentBlockId,
							worldChanged,
							Math.max(0.0D, distance - maxReach),
							null,
							null
					),
					new ServerActionObservation.Progress(
							Math.max(0.0D, Math.min(1.0D, progressValue)), progressBasis, verified
					)
			);
		}

		private ServerActionObservation navigationObservation(
				ServerNavigationController.AuthoritativeState state,
				long now
		) {
			Vec3 velocity = player.getDeltaMovement();
			HitResult hit = breakRayTarget(player);
			Vec3 endpoint = state.resolvedEndpoint() == null ? state.requestedDestination() : state.resolvedEndpoint();
			return new ServerActionObservation(
					Math.max(0L, player.level().getGameTime()),
					now,
					new ServerActionObservation.Position(state.position().x(), state.position().y(), state.position().z()),
					new ServerActionObservation.Position(velocity.x(), velocity.y(), velocity.z()),
					player.getYRot(),
					player.getXRot(),
					new ServerActionObservation.Collision(
							player.horizontalCollision, player.verticalCollision, state.inWall()),
					rayTargetObservation(hit),
					null,
					new ServerActionObservation.Target(
							"position",
							endpoint == null ? null : new ServerActionObservation.Position(endpoint.x(), endpoint.y(), endpoint.z()),
							null,
							null,
							null,
							null,
							null,
							state.distanceToEndpoint(),
							state.tolerance(),
							state.endpointStandable()
					),
					new ServerActionObservation.Progress(state.progress(), "world_position", true),
					// Standing only counts on a block: a body in a fluid, riding or gliding is not standing even when vanilla says onGround.
					state.onGround() && !player.isInWater() && !player.isInLava() && !player.isPassenger() && !player.isFallFlying() && !player.isSwimming(),
					dev.agaminggod.arenaagents.server.perception.PlayerTeleports.recent(player)
			);
		}

		private ServerActionObservation.RayTarget rayTargetObservation(HitResult hit) {
			Vec3 eye = player.getEyePosition();
			if (hit instanceof BlockHitResult blockHit) {
				BlockPos hitPosition = blockHit.getBlockPos();
				return new ServerActionObservation.RayTarget(
						"block",
						new ServerActionObservation.Position(hitPosition.getX(), hitPosition.getY(), hitPosition.getZ()),
						blockId(player.level().getBlockState(hitPosition)),
						blockHit.getDirection().getSerializedName(),
						eye.distanceTo(hit.getLocation())
				);
			}
			return new ServerActionObservation.RayTarget(
					hit.getType().name().toLowerCase(java.util.Locale.ROOT),
					null,
					null,
					null,
					eye.distanceTo(hit.getLocation())
			);
		}

		private String placementFailureMessage(String prefix) {
			var currentState = player.level().getBlockState(block);
			String actual = blockId(currentState) + DesiredBlockState.stableProperties(currentState);
			Direction face = placementAimHit == null ? placementRequestedFace : placementAimHit.getDirection();
			BlockPos support = placementAimHit == null ? placementSupport(block, face) : placementAimHit.getBlockPos();
			double distance = Math.sqrt(player.distanceToSqr(Vec3.atCenterOf(block)));
			BlockHitResult hit = placementAimHit;
			BlockState predicted = hit != null && player.getMainHandItem().getItem() instanceof BlockItem item
					? predictedPlacementState(player, item, player.getMainHandItem(), hit) : null;
			String collision = predicted == null ? "" : placementBodyObstruction(player.level(), block, predicted, player.getBoundingBox());
			return prefix + collision
					+ "; expected=" + desiredBlockState.blockId() + desiredBlockState.properties()
					+ ", actual=" + actual
					+ ", support=" + (support == null ? "none" : support + " face=" + face)
					+ ", distance=" + String.format(java.util.Locale.ROOT, "%.3f", distance)
					+ ", itemCount=" + inventoryItemCount(player, placementItemId);
		}

		/** The irreversible success of a started transaction still lingering, else null. */
		ServerTransactionAdapter.TickResult committedTransactionResult() {
			if (mode != Mode.TRANSACTION || !executionStarted || transaction == null) return null;
			ServerTransactionAdapter.TickResult committed = transaction.committedResult();
			return committed != null && committed.state() == ServerTransactionAdapter.TickState.SUCCEEDED ? committed : null;
		}

		void cancel(String reason) {
			ServerTransactionAdapter.runBestEffort(
					() -> { if (transaction != null) transaction.cancel(reason); },
					() -> { if (controller != null) controller.cancel(player); },
					// Cancelling aborts a held use: a drawn bow must not fire as the lease releases (that is a button-up).
					this::abortHeldUse,
					this::releaseInput
			);
		}

		private void abortHeldUse() {
			if (isControl() && controlState != null && controlState.use() && player.isUsingItem()) player.stopUsingItem();
		}

		void cleanup() {
			ServerTransactionAdapter.runBestEffort(
					() -> { if (transaction != null) transaction.cleanup(); },
					() -> { if (controller != null) controller.cancel(player); },
					this::releaseInput
			);
		}

		private void applyLookingInput(
				InputOwner owner,
				int priority,
				Vec3 target,
				float forward,
				boolean jump,
				boolean attack,
				boolean use
		) {
			LeasedServerInputController input = AgentInputRuntime.controller(player);
			if (inputLease == null) inputLease = input.acquire(request.agentId(), owner, priority);
			input.apply(inputLease, AgentInputStates.lookingAt(
					player, target, forward, 0.0F, jump, false,
					sprint && player.getFoodData().getFoodLevel() > 6,
					attack, use, InteractionHand.MAIN_HAND
			));
		}

		private boolean crosshairOn(BlockPos target) {
			return breakRayTarget(player) instanceof BlockHitResult hit && target.equals(hit.getBlockPos());
		}

		/**
		 * Holds the view while the crosshair is on the block, else takes one player-speed step toward its center;
		 * the attack key is held only once mining has begun and only while the crosshair is on the block, so a
		 * re-aim never mines whatever the crosshair crosses on the way.
		 */
		/**
		 * Carpet sets a 5-tick blockHitDelay after every break and spends it before the next attack starts. That is
		 * vanilla's destroyDelay, which only throttles a held attack key: startDestroyBlock ignores it, so a freshly
		 * pressed key (every break action presses anew) starts at once. The break time itself is untouched.
		 */
		private void clearPostBreakDelay() {
			((EntityPlayerActionPackAccessor) (Object) OfflineAgentPlayers.actions(player)).arenaagents$setBlockHitDelay(0);
		}

		/** A changed plant counts only with this action's removal receipt; the next target is revalidated afterward. */
		private boolean advancePlantClearing(BlockState state, BlockBreakReceipt receipt,
				java.util.function.Supplier<BreakTarget> nextTarget) {
			if (receipt != null && receipt.confirms(breakReceiptBaseline, clearingPlant, clearingPlantId, state)) {
				clearedPlants.add(clearingPlantId + " at " + coordinates(clearingPlant));
				releaseInput();
				configureBreakTarget(nextTarget.get());
				breakReceiptBaseline = receipt;
				return true;
			}
			if (!clearingPlantId.equals(blockId(state))) {
				throw new AgentDomainException("TARGET_CHANGED", "Obstructing plant changed without this action's removal receipt; observe before retrying");
			}
			plantProtection.accept(clearingPlant);
			return false;
		}

		private boolean retryBreakTarget(BreakTarget retry) {
			if (retry.plant() == null && breakReaims++ >= MAX_BREAK_REAIMS) return false;
			releaseInput();
			configureBreakTarget(retry);
			return true;
		}

		private void configureBreakTarget(BreakTarget target) {
			breakAim = target.aim();
			clearingPlant = target.plant();
			clearingPlantId = target.plantId();
			breakInputIssued = false;
			breakAimTicks = 0;
			if (clearingPlant != null) {
				if (clearedPlants.size() >= MAX_CLEARED_PLANTS) {
					throw new AgentDomainException("TARGET_NOT_VISIBLE", "Stopped after clearing 8 obstructing plants; observe before another break action");
				}
				plantProtection.accept(clearingPlant);
			}
		}

		private void applyBreakInput(boolean attack) {
			float yaw = player.getYRot();
			float pitch = player.getXRot();
			boolean onTarget = crosshairOn(clearingPlant == null ? block : clearingPlant);
			if (!onTarget) {
				AgentInputState desired = AgentInputStates.lookingAt(
						player, breakAim, 0.0F, 0.0F, false, false, false, false, false, InteractionHand.MAIN_HAND);
				yaw = AgentInputStates.turnYaw(yaw, desired.yaw());
				pitch = AgentInputStates.turnPitch(pitch, desired.pitch());
			}
			LeasedServerInputController input = AgentInputRuntime.controller(player);
			if (inputLease == null) inputLease = input.acquire(request.agentId(), InputOwner.INTERACTION, 300);
			input.apply(inputLease, new AgentInputState(0.0F, 0.0F, false, breakSneak, false, attack && onTarget, false,
					yaw, pitch, player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
		}

		private Look lookToward(Vec3 target) {
			AgentInputState desired = AgentInputStates.lookingAt(
					player, target, 0.0F, 0.0F, false, false, false, false, false, InteractionHand.MAIN_HAND);
			return new Look(desired.yaw(), desired.pitch());
		}

		/** The look a directional placement needs, or null; null too when the item or support is not ready yet. */
		private Look directionalPlacementLook(Look faceAim) {
			ItemStack stack = placementContextStack();
			if (!(stack.getItem() instanceof BlockItem blockItem)
					|| !BuiltInRegistries.ITEM.getKey(stack.getItem()).toString().equals(placementItemId)) return null;
			BlockHitResult hit = placementHit(player, block, placementRequestedFace, stack, placementStrictFace, desiredBlockState);
			if (hit == null) return null;
			return requiredPlacementLook(player, blockItem, stack, hit, desiredBlockState, faceAim);
		}

		/** One player-speed step toward {@code look} through the interaction lease; true once the view is on it. */
		private boolean stepLookToward(Look look) {
			float yaw = AgentInputStates.turnYaw(player.getYRot(), look.yaw());
			float pitch = AgentInputStates.turnPitch(player.getXRot(), look.pitch());
			applyExactLook(new Look(yaw, pitch));
			return Math.abs(AgentInputStates.shortestAngleDelta(yaw, look.yaw())) <= 0.01F
					&& Math.abs(pitch - look.pitch()) <= 0.01F;
		}

		private void applyExactLook(Look look) {
			LeasedServerInputController input = AgentInputRuntime.controller(player);
			if (inputLease == null) inputLease = input.acquire(request.agentId(), InputOwner.INTERACTION, 300);
			input.apply(inputLease, new AgentInputState(0.0F, 0.0F, false, false, false, false, false,
					look.yaw(), look.pitch(), player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
		}

		/** Drives the view toward {@code look} through the normal input lease and reports whether it has settled. */
		private AimGate.State aimAtLook(Look look) {
			stepLookToward(look);
			return aimGate.observe(player.getYRot(), player.getXRot(), look.yaw(), look.pitch());
		}

		/** Drives the view toward the target through the normal input lease and reports whether it has settled. */
		private AimGate.State aimAt(Vec3 target) {
			AgentInputState desired = AgentInputStates.lookingAt(
					player, target, 0.0F, 0.0F, false, false, false, false, false, InteractionHand.MAIN_HAND);
			// One eased step per tick from the current view, so spectators see a turn rather than a snap.
			LeasedServerInputController input = AgentInputRuntime.controller(player);
			if (inputLease == null) inputLease = input.acquire(request.agentId(), InputOwner.INTERACTION, 300);
			input.apply(inputLease, new AgentInputState(0.0F, 0.0F, false, false, false, false, false,
					AgentInputStates.turnYaw(player.getYRot(), desired.yaw()),
					AgentInputStates.turnPitch(player.getXRot(), desired.pitch()),
					player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			return aimGate.observe(player.getYRot(), player.getXRot(), desired.yaw(), desired.pitch());
		}

		/** Turns toward the target's exposed hitbox part; ready only on the exact live crosshair hit. */
		private AimGate.State aimAtEntity(Entity target) {
			Vec3 center = attackAimPoint(player, target);
			AgentInputState desired = AgentInputStates.lookingAt(
					player, center, 0.0F, 0.0F, false, false, false, false, false, InteractionHand.MAIN_HAND);
			LeasedServerInputController input = AgentInputRuntime.controller(player);
			if (inputLease == null) inputLease = input.acquire(request.agentId(), InputOwner.INTERACTION, 300);
			input.apply(inputLease, new AgentInputState(0.0F, 0.0F, false, false, false, false, false,
					AgentInputStates.turnYaw(player.getYRot(), desired.yaw()),
					AgentInputStates.turnPitch(player.getXRot(), desired.pitch()),
					player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			HitResult hit = Tracer.rayTrace(player, 1.0F, player.getAttackRangeWith(player.getMainHandItem()).effectiveMaxRange(player), false);
			return aimGate.observeAligned(hit instanceof EntityHitResult entityHit && ObservedEntityTarget.matchesHit(target, entityHit));
		}

		private String placementSelection = "";

		private ItemStack placementContextStack() {
			ItemStack held = player.getMainHandItem();
			if (!held.isEmpty() && BuiltInRegistries.ITEM.getKey(held.getItem()).toString().equals(placementItemId)) return held;
			for (int slot = 0; slot < 36; slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (!stack.isEmpty() && BuiltInRegistries.ITEM.getKey(stack.getItem()).toString().equals(placementItemId)) return stack;
			}
			// After the last block is placed, finishing the look restoration still needs its placement context.
			return new ItemStack(BuiltInRegistries.ITEM.getValue(Identifier.parse(placementItemId)));
		}

		private Vec3 placementAimTarget() {
			BlockHitResult hit = placementHit(player, block, placementRequestedFace, placementContextStack(), placementStrictFace, desiredBlockState);
			placementAimHit = hit;
			return hit.getLocation();
		}

		private void applyUseInput() {
			LeasedServerInputController input = AgentInputRuntime.controller(player);
			if (inputLease == null) inputLease = input.acquire(request.agentId(), InputOwner.INTERACTION, 300);
			input.apply(inputLease, new AgentInputState(0.0F, 0.0F, false, player.isShiftKeyDown(),
					player.isSprinting(), false, true, player.getYRot(), player.getXRot(),
					player.getInventory().getSelectedSlot(), useHand));
		}

		private ServerActionResult tickControlSequence(long now) {
			ControlSequence.Step step = controlSequence.next(new ControlSequence.Facts(player.getHealth(),
					player.getFoodData().getFoodLevel(), player.getAirSupply(), player.isOnFire(), player.isInWater(),
					player.onGround(), player.horizontalCollision, player.hurtTime > 0, player.isUsingItem()));
			lastProgress = (double) step.elapsedTicks() / step.maxTicks();
			if (step.status() == ControlSequence.Status.RUNNING) {
				physicalAttempted = true;
				if (step.frameIndex() != sequenceTurnFrame) {
					sequenceTurnFrame = step.frameIndex();
					sequenceTurnTicks = 0;
				}
				// The view turns onto each frame's look at player speed first; those ticks hold no movement or clicks
				// and do not count against the frame, so a pillar or attack frame acts only once it is aimed. Turning is
				// bounded per frame and, in total, by the sequence budget.
				ControlTick control = controlTick(player.getYRot(), player.getXRot(), step.input(), step.instantLook(),
						sequenceTotalTurnTicks >= step.maxTicks() ? MAX_CONTROL_TURN_TICKS : sequenceTurnTicks);
				if (control.counts()) {
					sequenceTurnTicks = 0;
				} else {
					controlSequence.refundTick();
					sequenceTurnTicks++;
					sequenceTotalTurnTicks++;
				}
				controlState = control.input();
				ServerActionResult edge = voidEdgeStop(step.input(), now);
				if (edge != null) return edge;
				applyControlInput();
				return null;
			}
			if (step.status() == ControlSequence.Status.COMPLETED && settleControl()) return null;
			String detail = "Model-authored control sequence stopped at frame " + step.frameIndex()
					+ " after " + step.elapsedTicks() + " server ticks; no task outcome is implied"
					+ dev.agaminggod.arenaagents.server.perception.DropAhead.describe(player)
					+ dev.agaminggod.arenaagents.server.perception.GroundAhead.describe(player);
			return switch (step.status()) {
				case COMPLETED -> result(ServerActionState.SUCCEEDED, "CONTROL_SEQUENCE_COMPLETED", detail, now);
				case BRANCH_STOPPED -> result(ServerActionState.SUCCEEDED, "CONTROL_SEQUENCE_STOPPED", detail, now);
				case BUDGET_EXHAUSTED -> result(ServerActionState.TIMED_OUT, "CONTROL_SEQUENCE_BUDGET_EXHAUSTED", detail, now);
				case RUNNING -> throw new IllegalStateException("Running input has no terminal result");
			};
		}

		/**
		 * Stops this model action when the body enters lava or walks into fire while it runs, and names the exits
		 * ({@link HazardEntry}: the same rule fight and flee apply to themselves). Eating and drinking keep running.
		 */
		private ServerActionResult hazardStop(long now) {
			// Actions that never stop on a hazard skip the contact test; fight and flee run the same rule themselves.
			if (!stopsOnHazard(mode, controller)) return null;
			String code = hazardEntry.observe(player);
			if (code == null) return null;
			boolean lava = HazardEntry.IN_LAVA.equals(code);
			return result(ServerActionState.FAILED, code, HazardExits.stopMessage(player, lava), now);
		}

		/**
		 * Stops a raw control frame before its held walking input carries the grounded body off an edge into the void
		 * ({@link dev.agaminggod.arenaagents.server.perception.VoidEdge}); a player sees that edge before pressing forward,
		 * while a frame runs open-loop on facts its author saw seconds earlier. Sneak and jump frames are never stopped.
		 */
		private ServerActionResult voidEdgeStop(AgentInputState frame, long now) {
			if (frame == null) return null;
			BlockPos voidCell = dev.agaminggod.arenaagents.server.perception.VoidEdge.ahead(
					player, frame.forward(), frame.strafe(), frame.yaw(), frame.jump(), frame.sneak());
			if (voidCell == null) return null;
			return result(ServerActionState.FAILED, "VOID_EDGE", dev.agaminggod.arenaagents.server.perception.VoidEdge.stopMessage(voidCell), now);
		}

		static boolean stopsOnHazard(Mode mode, ServerController controller) {
			return switch (mode) {
				case MOVE, CONTROL, CONTROL_SEQUENCE, BREAK, PLACE, WAIT -> true;
				// A shaft pours its water bucket on lava it drops into before it hands back (its own IN_LAVA).
				case CONTROLLER -> !(controller instanceof dev.agaminggod.arenaagents.server.runtime.controller.ServerShelterController)
						&& !(controller instanceof ServerFightController) && !(controller instanceof ServerFleeController)
						// The count fight steps off fire and fights on, and stops on lava itself (d41 floor fixture: walking
						// into a fireball's fire ended the whole count fight ON_FIRE mid-engagement).
						&& !(controller instanceof dev.agaminggod.arenaagents.server.runtime.controller.ServerFightUntilController)
						&& !(controller instanceof ServerDigController dig && dig.pattern() == ServerDigController.Pattern.SHAFT);
				case IMMEDIATE, AIMED, USE, TRANSACTION -> false;
			};
		}

		boolean isControl() {
			return mode == Mode.CONTROL || mode == Mode.CONTROL_SEQUENCE;
		}

		void neutralizeDisconnectedControl() {
			ServerTransactionAdapter.runBestEffort(
					// Abort item use first: releasing the lease or clearing input is a button-up that fires a drawn bow.
					player::stopUsingItem,
					this::releaseInput,
					() -> AgentInputRuntime.clear(player),
					() -> OfflineAgentPlayers.actions(player).stopAll()
			);
		}

		/**
		 * Applies the control frame. Unless the model asked for an instant look, the view first turns toward the
		 * frame's yaw and pitch at player speed (see {@link #controlTick}); movement and clicks start once it arrives,
		 * so the frame moves in the direction the model chose for exactly its ticks and a click lands where it aimed.
		 */
		private void applyControlFrame() {
			ControlTick control = controlTick(player.getYRot(), player.getXRot(), controlState, instantLook || controlLookSettled,
					controlTurnTicks);
			if (control.counts()) controlLookSettled = true;
			else controlTurnTicks++;
			LeasedServerInputController input = AgentInputRuntime.controller(player);
			if (inputLease == null) inputLease = input.acquire(request.agentId(), InputOwner.DIRECT_CONTROL, 250);
			input.apply(inputLease, control.input());
		}

		private ServerActionResult controlCompleted(long now) {
			String completed = controlTurnTicks == 0 ? "Control segment completed"
					: "Control segment completed after a " + controlTurnTicks + "-tick view turn";
			return result(ServerActionState.SUCCEEDED, "CONTROL_SEGMENT_COMPLETED",
					useFeedback(completed, useFoodRefusal, useStartObserved)
							+ dev.agaminggod.arenaagents.server.perception.DropAhead.describe(player)
							+ dev.agaminggod.arenaagents.server.perception.GroundAhead.describe(player), now);
		}

		/**
		 * On a cancel: a sneaking frame still drifting on the ground keeps shift (movement, use and attack released)
		 * under the executor's {@link ShiftHold}; its lease leaves this action, so the cancel's release skips it.
		 */
		ShiftHold detachShiftHold() {
			if (!isControl() || controlState == null || !controlState.sneak() || inputLease == null || player == null) return null;
			if (!player.onGround() || player.hurtTime > 0 || player.isInWater() || player.onClimbable()) return null;
			if (player.getDeltaMovement().horizontalDistance() < 0.003D) return null;
			InputLease lease = inputLease;
			try {
				AgentInputRuntime.controller(player).apply(lease, new AgentInputState(0, 0, false, true, false, false, false,
						player.getYRot(), player.getXRot(), player.getInventory().getSelectedSlot(), controlHand()));
			} catch (LeasedServerInputController.StaleInputLeaseException stale) {
				return null;
			}
			inputLease = null;
			return new ShiftHold(player, lease, new SneakSettling());
		}

		private boolean settleControl() {
			var motion = player.getDeltaMovement();
			// Preserve only an authored crouch on ordinary completion. Shift descends in water/on ladders;
			// danger and branch stops must return control to the model immediately.
			if (player.hurtTime > 0 || player.isOnFire() || player.onClimbable() || player.isInWater()) return false;
			boolean hold = sneakSettling.hold(controlState != null && controlState.sneak(), Math.hypot(motion.x, motion.z));
			if (hold) {
				LeasedServerInputController input = AgentInputRuntime.controller(player);
				if (inputLease == null) inputLease = input.acquire(request.agentId(), InputOwner.DIRECT_CONTROL, 250);
				input.apply(inputLease, new AgentInputState(0, 0, false, true, false, false, false,
						player.getYRot(), player.getXRot(), player.getInventory().getSelectedSlot(), controlHand()));
			}
			return hold;
		}

		private InteractionHand controlHand() {
			return controlState == null || controlState.hand() == null ? InteractionHand.MAIN_HAND : controlState.hand();
		}

		private void applyControlInput() {
			LeasedServerInputController input = AgentInputRuntime.controller(player);
			if (inputLease == null) inputLease = input.acquire(request.agentId(), InputOwner.DIRECT_CONTROL, 250);
			input.apply(inputLease, controlState);
		}

		private void releaseInput() {
			if (inputLease == null) return;
			try {
				AgentInputRuntime.controller(player).release(inputLease);
			} catch (LeasedServerInputController.StaleInputLeaseException ignored) {
				// A lifecycle clear may already have invalidated every lease.
			}
			inputLease = null;
		}

		/** A reflex firing holds the body this tick; the first paused tick of a firing records which rule took it. */
		void pauseUnder(String ruleId) {
			if (pausedNow) return;
			pausedNow = true;
			pausedBy.merge(ruleId == null || ruleId.isBlank() ? "reflex" : ruleId, 1, Integer::sum);
		}

		/** The firing ended and this action ticks again: its controller continues from the body's new state. */
		void resumeAfterPause() {
			if (!pausedNow) return;
			pausedNow = false;
			resumes++;
			if (controller != null && player != null) controller.resumed(player);
		}

		/** What paused this action and whether it resumed, for the model (empty when no firing paused it). */
		String pauseNote() {
			if (pausedBy.isEmpty()) return "";
			StringBuilder rules = new StringBuilder();
			int pauses = 0;
			for (Map.Entry<String, Integer> entry : pausedBy.entrySet()) {
				if (rules.length() > 0) rules.append(", ");
				rules.append(entry.getKey());
				if (entry.getValue() > 1) rules.append(" x").append(entry.getValue());
				pauses += entry.getValue();
			}
			return String.format(java.util.Locale.ROOT, "; paused %d time(s) by reflex %s for %.1f s, resumed %d time(s)%s",
					pauses, rules, pausedMs / 1000.0D, resumes, pausedNow ? ", ended while paused" : "");
		}

		ServerActionResult result(ServerActionState state, String reasonCode, String message, long now) {
			if (state != ServerActionState.SUCCEEDED) message = placementFailureContext(request, message);
			if (message != null) message += pauseNote();
			// The model sees in the result what the brink guard did during this action (a refused jump, a walk-back).
			String brink = player == null || brinkSince < 0L ? null : dev.agaminggod.arenaagents.server.runtime.controller.BrinkGuard.savedSince(player, brinkSince);
			if (brink != null) message = Objects.requireNonNullElse(message, "") + "; " + brink;
			if (throwPreview != null) message = "throwPreview=" + throwPreview + "; " + Objects.requireNonNullElse(message, "");
			if (isControl()) message = Objects.requireNonNullElse(message, "") + sneakSettling.describe();
			if (!clearedPlants.isEmpty() && message != null) message += "; cleared obstructing plants: " + String.join(", ", clearedPlants);
			if (mode == Mode.BREAK && breakTool != null && state != ServerActionState.SUCCEEDED && message != null) {
				message += "; attempted " + breakTool.note();
				breakSummary = new BreakOutcomeEvidence.Summary(0, breakTool.itemId(), !breakTool.missingCorrectTool(), false,
						player != null && !Objects.equals(BreakOutcomeEvidence.itemId(player.getMainHandItem()), breakTool.itemId()));
			}
			if (isControl() && player != null) {
				collectControlBreaks();
				if (!controlBreaks.isEmpty()) {
					if (message != null) message += controlBreaks.note();
					breakSummary = controlBreaks.summary(BreakOutcomeEvidence.itemId(player.getMainHandItem()));
				}
			}
			ActionTimelines.remember(request.agentId(), request.actionId(),
					new ActionTimelines.Timeline(acceptedAtEpochMs, startedAtEpochMs, startedTick, serverTick));
			return new ServerActionResult(
					request.agentId(),
					request.goalRevision(),
					request.actionId(),
					request.type(),
					request.traceId(),
					state,
					reasonCode,
					message == null || player == null ? message : (state == ServerActionState.FAILED || state == ServerActionState.TIMED_OUT
							? FailureBlocker.withBlocker(player, request.type(), request.arguments(), reasonCode, message) : message) + falls.describe(),
					elapsedTime.advance(now),
				now,
				executionStarted,
				physicalAttempted,
				lastObservation,
				breakSummary
			);
		}

		/** Held attack can break blocks; each new removal receipt is one break, at most one per player tick. */
		private void collectControlBreaks() {
			BlockBreakReceipt receipt = ((BlockBreakReceiptAccess) (Object) player.gameMode).arenaagents$getBlockBreakReceipt();
			if (!controlReceiptPrimed) {
				controlReceiptPrimed = true;
				controlReceiptSeen = receipt;
				return;
			}
			if (receipt == controlReceiptSeen) return;
			controlReceiptSeen = receipt;
			if (receipt != null && receipt.outcome() != null) controlBreaks.add(receipt.outcome());
		}
	}

	/** The input for one tick of a control frame, and whether that tick counts as one of the frame's ticks. */
	record ControlTick(AgentInputState input, boolean counts) {
	}

	/**
	 * One tick of a control frame from the current view. With an instant look, once the look arrives this tick, or after
	 * {@code turnTicks} reaches {@link #MAX_CONTROL_TURN_TICKS}, the frame's full input applies and the tick counts.
	 * Before that the view eases toward the frame's look with movement, jump, sprint and clicks released (sneak and the
	 * hotbar slot kept, so an edge stays guarded): keys held against a half-turned view would walk the wrong way, so the
	 * agent turns and then walks, as a player does. Turning ticks do not count, so movement lasts exactly the frame's ticks.
	 */
	static ControlTick controlTick(float yaw, float pitch, AgentInputState frame, boolean instantLook, int turnTicks) {
		if (instantLook) return new ControlTick(frame, true);
		AgentInputState eased = easedControlLook(yaw, pitch, frame, true);
		if (eased.yaw() == frame.yaw() && eased.pitch() == frame.pitch() || turnTicks >= MAX_CONTROL_TURN_TICKS) {
			return new ControlTick(frame, true);
		}
		return new ControlTick(new AgentInputState(0.0F, 0.0F, false, frame.sneak(), false, false, false,
				eased.yaw(), eased.pitch(), frame.selectedSlot(), frame.hand()), false);
	}

	/**
	 * One player-speed view step from ({@code yaw}, {@code pitch}) toward the frame's look, with the frame's keys.
	 * The arrival step returns the frame's own yaw (not a wrapped equivalent) so callers can test arrival exactly.
	 */
	static AgentInputState easedControlLook(float yaw, float pitch, AgentInputState frame, boolean keepClicks) {
		float nextYaw = AgentInputStates.turnYaw(yaw, frame.yaw());
		if (AgentInputStates.shortestAngleDelta(nextYaw, frame.yaw()) == 0.0F) nextYaw = frame.yaw();
		float nextPitch = AgentInputStates.turnPitch(pitch, frame.pitch());
		return new AgentInputState(frame.forward(), frame.strafe(), frame.jump(), frame.sneak(), frame.sprint(),
				keepClicks && frame.attack(), keepClicks && frame.use(), nextYaw, nextPitch, frame.selectedSlot(), frame.hand());
	}

	static ServerController.TickResult requireControllerResult(
			ServerController.TickResult result,
			double lastProgress,
			String controllerName
	) {
		if (result != null) return result;
		String readable = controllerName == null || controllerName.isBlank()
				? "Controller" : controllerName.replace("Server", "").replace("Controller", " controller").trim();
		if (!readable.toLowerCase(java.util.Locale.ROOT).endsWith("controller")) readable += " controller";
		return ServerController.TickResult.failed(
				"CONTROLLER_NO_RESULT",
				readable + " returned no result",
				Math.max(0.0D, Math.min(1.0D, lastProgress))
		);
	}
}
