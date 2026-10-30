package dev.agaminggod.arenaagents.server.conversation;

import dev.agaminggod.arenaagents.agent.AgentDomainException;
import dev.agaminggod.arenaagents.agent.AgentId;
import dev.agaminggod.arenaagents.agent.AgentLifecycleState;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

/** Server rules for a model's takeTask: who may turn a delivered request into the agent's goal. */
public final class ModelTaskAdoptionVerification {
	private static final AgentId AGENT = new AgentId(UUID.fromString("00000000-0000-0000-0000-0000000000a1"));
	private static final UUID PLAYER = UUID.fromString("11111111-1111-4111-8111-111111111111");
	private static final UUID OPERATOR = UUID.fromString("22222222-2222-4222-8222-222222222222");

	private ModelTaskAdoptionVerification() {
	}

	public static int verify() {
		return verifyOperations() + verifySpokenRequests() + verifyRequesterConfirmation();
	}

	private static int verifyOperations() {
		int assertions = 0;
		for (AgentLifecycleState state : new AgentLifecycleState[] { AgentLifecycleState.IDLE, AgentLifecycleState.COMPLETED }) {
			assertEquals(ModelTaskAdoption.Operation.START, ModelTaskAdoption.operation(state, false, true, false),
					"the operator can start work on a " + state + " agent");
			assertRefused("NOT_OPERATOR", state, false, false, false);
			assertions += 2;
		}
		assertEquals(ModelTaskAdoption.Operation.RESUME, ModelTaskAdoption.operation(AgentLifecycleState.PAUSED, true, true, false),
				"the operator may ask a paused agent to continue its task");
		assertRefused("NOT_OPERATOR", AgentLifecycleState.PAUSED, true, false, false);
		assertRefused("NOT_OPERATOR", AgentLifecycleState.PAUSED, false, false, false);
		assertEquals(ModelTaskAdoption.Operation.START, ModelTaskAdoption.operation(AgentLifecycleState.PAUSED, false, true, false),
				"an operator may put a new task over a paused one, as with speech");
		assertRefused("NOTHING_TO_RESUME", AgentLifecycleState.COMPLETED, true, true, false);
		assertions += 5;
		for (AgentLifecycleState state : new AgentLifecycleState[] {
				AgentLifecycleState.STARTING, AgentLifecycleState.PLANNING, AgentLifecycleState.ACTING }) {
			assertRefused("NOT_OPERATOR", state, false, false, false);
			assertRefused("AGENT_BUSY", state, false, true, false);
			assertions += 2;
		}
		assertRefused("AGENT_TAKEN_OVER", AgentLifecycleState.IDLE, false, true, true);
		assertRefused("AGENT_TAKEN_OVER", AgentLifecycleState.PAUSED, true, true, true);
		assertRefused("AGENT_UNAVAILABLE", AgentLifecycleState.DEAD, false, true, false);
		assertRefused("NOT_OPERATOR", AgentLifecycleState.ERROR, false, false, false);
		return assertions + 4;
	}

	private static int verifySpokenRequests() {
		ModelTaskAdoption.SpokenRequests spoken = new ModelTaskAdoption.SpokenRequests();
		spoken.record(event(PLAYER.toString(), ConversationKind.PLAYER_MESSAGE, 3L, 7L));
		spoken.record(event(OPERATOR.toString(), ConversationKind.PROXIMITY_SPEECH, 3L, 8L));
		spoken.record(event(AGENT.toString(), ConversationKind.AGENT_MESSAGE, 3L, 9L));
		spoken.record(event("not-a-player", ConversationKind.PLAYER_MESSAGE, 3L, 10L));
		ModelTaskAdoption.requireSpokenBy(spoken.find(AGENT, 7L), PLAYER, 3L, "go get iron");
		assertCode("REQUESTER_MISMATCH", () -> ModelTaskAdoption.requireSpokenBy(spoken.find(AGENT, 7L), OPERATOR, 3L, "go get iron"));
		assertCode("STALE_REQUEST", () -> ModelTaskAdoption.requireSpokenBy(spoken.find(AGENT, 7L), PLAYER, 4L, "go get iron"));
		assertCode("UNKNOWN_REQUEST", () -> ModelTaskAdoption.requireSpokenBy(spoken.find(AGENT, 9L), PLAYER, 3L, "go get iron"));
		assertCode("UNKNOWN_REQUEST", () -> ModelTaskAdoption.requireSpokenBy(spoken.find(AGENT, 10L), PLAYER, 3L, "go get iron"));
		assertCode("REQUEST_MISMATCH", () -> ModelTaskAdoption.requireSpokenBy(spoken.find(AGENT, 8L), OPERATOR, 3L, "give iron to Alex"));
		spoken.record(new ConversationEvent(AGENT, OPERATOR.toString(), AGENT.toString(), ConversationAudience.DIRECT,
				ConversationKind.PLAYER_MESSAGE, "hello", 3L, 1_000L, 11L, "minecraft:overworld"));
		assertCode("REQUEST_MISMATCH", () -> ModelTaskAdoption.requireSpokenBy(spoken.find(AGENT, 11L), OPERATOR, 3L, "give iron to Alex"));
		spoken.record(new ConversationEvent(AGENT, OPERATOR.toString(), "", ConversationAudience.PUBLIC,
				ConversationKind.PLAYER_MESSAGE, "go get iron", 3L, 1_000L, 12L, "minecraft:overworld"));
		assertEquals(Optional.empty(), spoken.find(AGENT, 12L), "public operator chat cannot be adopted as work");
		assertCode("REQUEST_MISMATCH", () -> ModelTaskAdoption.requireRequestedOperation("hello", true));
		ModelTaskAdoption.requireRequestedOperation("continue", true);
		ModelTaskAdoption.requireRequestedOperation("Please resume", true);
		spoken.consume(AGENT, 7L);
		assertCode("UNKNOWN_REQUEST", () -> ModelTaskAdoption.requireSpokenBy(spoken.find(AGENT, 7L), PLAYER, 3L, "go get iron"));
		for (long sequence = 100; sequence < 100 + ModelTaskAdoption.SpokenRequests.PER_AGENT + 1; sequence++) {
			spoken.record(event(PLAYER.toString(), ConversationKind.PLAYER_MESSAGE, 3L, sequence));
		}
		assertEquals(Optional.empty(), spoken.find(AGENT, 100L), "only a bounded window of messages is retained");
		assertEquals(true, spoken.find(AGENT, 100L + ModelTaskAdoption.SpokenRequests.PER_AGENT).isPresent(), "newest message retained");
		return 14;
	}

	private static int verifyRequesterConfirmation() {
		ModelTaskAdoption.Requesters requesters = new ModelTaskAdoption.Requesters();
		UUID goal = UUID.randomUUID();
		UUID draft = UUID.randomUUID();
		requesters.startedGoal(AGENT, goal, PLAYER);
		assertEquals(true, requesters.mayConfirm(AGENT, Optional.of(goal), PLAYER, true), "the requester confirms their task");
		assertEquals(false, requesters.mayConfirm(AGENT, Optional.of(goal), OPERATOR, true), "another non-operator cannot");
		assertEquals(false, requesters.mayConfirm(AGENT, Optional.of(UUID.randomUUID()), PLAYER, true), "a later goal is not theirs");
		requesters.pendingDraft(AGENT, draft, PLAYER);
		assertEquals(false, requesters.mayConfirm(AGENT, Optional.of(goal), PLAYER, true), "a pending draft confirms nothing yet");
		UUID translated = UUID.randomUUID();
		requesters.draftActivated(AGENT, UUID.randomUUID(), translated);
		assertEquals(false, requesters.mayConfirm(AGENT, Optional.of(translated), PLAYER, true), "another draft's activation is ignored");
		requesters.draftActivated(AGENT, draft, translated);
		assertEquals(true, requesters.mayConfirm(AGENT, Optional.of(translated), PLAYER, true), "the translated goal stays the requester's");
		assertEquals(false, requesters.mayConfirm(AGENT, Optional.of(translated), PLAYER, false), "de-op revokes authority despite retained draft requester");
		requesters.startedGoal(AGENT, goal, PLAYER);
		assertEquals(false, requesters.mayConfirm(AGENT, Optional.of(goal), PLAYER, false), "de-op revokes adopted-goal confirmation");
		return 8;
	}

	private static ConversationEvent event(String sourceId, ConversationKind kind, long goalRevision, long sequence) {
		ConversationAudience audience = kind == ConversationKind.PROXIMITY_SPEECH ? ConversationAudience.PROXIMITY : ConversationAudience.DIRECT;
		return new ConversationEvent(AGENT, sourceId, AGENT.toString(), audience, kind, "go get iron", goalRevision,
				1_000L, sequence, "minecraft:overworld");
	}

	private static void assertRefused(String code, AgentLifecycleState state, boolean resume, boolean operator, boolean reserved) {
		assertCode(code, () -> ModelTaskAdoption.operation(state, resume, operator, reserved));
	}

	private static void assertCode(String code, Runnable action) {
		try {
			action.run();
		} catch (AgentDomainException exception) {
			assertEquals(code, exception.code(), "refusal code");
			if (exception.getMessage() == null || exception.getMessage().isBlank()) {
				throw new AssertionError(code + " must carry a message the model can relay");
			}
			return;
		}
		throw new AssertionError("expected " + code);
	}

	private static void assertEquals(Object expected, Object actual, String label) {
		if (!Objects.equals(expected, actual)) {
			throw new AssertionError(label + ": expected " + expected + " but was " + actual);
		}
	}
}
