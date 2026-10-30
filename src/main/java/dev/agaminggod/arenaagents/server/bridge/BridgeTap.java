package dev.agaminggod.arenaagents.server.bridge;

import com.google.gson.JsonObject;
import dev.agaminggod.arenaagents.agent.AgentId;
import dev.agaminggod.arenaagents.server.runtime.ServerActionExecutor;
import java.util.Map;
import java.util.WeakHashMap;

/**
 * One-way taps out of the bridge for server-side audits: what was delivered to the coordinator and when the model
 * last sent work. Data only flows out; nothing a listener does can reach an observation, wake or tool result, and the
 * bridge does not know who listens.
 */
public final class BridgeTap {
	public interface Listener {
		/** An observation the coordinator accepted; the tree must only be read, never kept or changed. */
		void observationDelivered(AgentId agentId, JsonObject delivery);

		/** A model-authored message for the agent arrived (an action of a program, or a reflex rule set). */
		void modelMessage(AgentId agentId, String type, String programId, long programVersion);

		/** A terminal action result the bridge published (or a command it rejected) for the agent. */
		default void actionResult(AgentId agentId, String actionType, String state, String reasonCode) {
		}
	}

	private static volatile Listener listener;
	private static final Map<net.minecraft.server.MinecraftServer, ServerActionExecutor> EXECUTORS = new WeakHashMap<>();

	private BridgeTap() {
	}

	public static void listen(Listener value) {
		listener = value;
	}

	static synchronized void bind(net.minecraft.server.MinecraftServer server, ServerActionExecutor executor) {
		if (server != null) EXECUTORS.put(server, executor);
	}

	public static synchronized ServerActionExecutor executor(net.minecraft.server.MinecraftServer server) {
		return server == null ? null : EXECUTORS.get(server);
	}

	static void delivered(AgentId agentId, JsonObject delivery) {
		Listener current = listener;
		if (current == null) return;
		try {
			current.observationDelivered(agentId, delivery);
		} catch (RuntimeException ignored) {
			// An audit must never disturb delivery.
		}
	}

	static void result(AgentId agentId, String actionType, String state, String reasonCode) {
		Listener current = listener;
		if (current == null) return;
		try {
			current.actionResult(agentId, actionType, state, reasonCode);
		} catch (RuntimeException ignored) {
			// An audit must never disturb the bridge.
		}
	}

	static void model(AgentId agentId, String type, String programId, long programVersion) {
		Listener current = listener;
		if (current == null) return;
		try {
			current.modelMessage(agentId, type, programId, programVersion);
		} catch (RuntimeException ignored) {
			// An audit must never disturb the bridge.
		}
	}
}
