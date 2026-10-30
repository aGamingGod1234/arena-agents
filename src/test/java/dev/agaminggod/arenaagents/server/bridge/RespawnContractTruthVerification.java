package dev.agaminggod.arenaagents.server.bridge;

import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.agent.AgentDeathSnapshot;
import dev.agaminggod.arenaagents.agent.AgentDomainException;
import dev.agaminggod.arenaagents.agent.AgentRecord;
import dev.agaminggod.arenaagents.protocol.ActionType;
import dev.agaminggod.arenaagents.server.runtime.ActionProvenance;
import dev.agaminggod.arenaagents.server.runtime.ServerActionRequest;
import java.lang.reflect.InvocationTargetException;
import java.util.Optional;

/** Executes the bridge admission gate; revision and lifecycle are distinct facts. */
public final class RespawnContractTruthVerification {
	private RespawnContractTruthVerification() { }

	public static int verify() throws Exception {
		var manager = MultiplexedServerBridgeVerification.uninitializedManager();
		AgentRecord initial = manager.registry().create("gpt-5.6-sol", "high", Optional.of("RespawnTruth"), 1_000L);
		manager.registry().start(initial.agentId(), "retain this goal", 1_001L);
		try (var bridge = MultiplexedServerBridge.withPreparedSecret(manager, 0, "0123456789abcdef0123456789abcdef")) {
			AgentRecord alive = manager.registry().require(initial.agentId());
			rejected(bridge, request(alive, alive.goalRevision()), "AGENT_NOT_DEAD");
			rejected(bridge, request(alive, alive.goalRevision() + 1), "STALE_REVISION");
			var snapshot = MultiplexedServerBridgeVerification.class.getDeclaredMethod("deathSnapshot", long.class);
			snapshot.setAccessible(true);
			manager.registry().die(alive.agentId(), (AgentDeathSnapshot) snapshot.invoke(null, 1_002L), 1_002L);
			AgentRecord dead = manager.registry().require(alive.agentId());
			rejected(bridge, request(dead, dead.goalRevision() + 1), "STALE_REVISION");
			Object admitted = validate(bridge, request(dead, dead.goalRevision()));
			if (!dead.equals(admitted)) throw new AssertionError("Current dead-player request preserves the authoritative record");
		}
		return 4;
	}

	private static ServerActionRequest request(AgentRecord record, long revision) {
		var profile = record.profile();
		var provenance = new ActionProvenance(profile.provider(), profile.model(), profile.reasoning(), profile.serviceTier(),
				"respawn-contract", 1, "respawn-step", 0);
		return new ServerActionRequest(record.agentId(), revision, "respawn-contract", ActionType.RESPAWN, new JsonObject(), provenance);
	}

	private static Object validate(MultiplexedServerBridge bridge, ServerActionRequest request) throws Exception {
		var method = MultiplexedServerBridge.class.getDeclaredMethod("validateActionProvenance", ServerActionRequest.class);
		method.setAccessible(true);
		return method.invoke(bridge, request);
	}

	private static void rejected(MultiplexedServerBridge bridge, ServerActionRequest request, String code) throws Exception {
		try {
			validate(bridge, request);
			throw new AssertionError("Expected " + code);
		} catch (InvocationTargetException failure) {
			if (!(failure.getCause() instanceof AgentDomainException domain) || !code.equals(domain.code())) {
				throw new AssertionError("Expected exact respawn admission " + code, failure.getCause());
			}
		}
	}
}
