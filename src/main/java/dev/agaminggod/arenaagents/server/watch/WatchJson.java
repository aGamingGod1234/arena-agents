package dev.agaminggod.arenaagents.server.watch;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;

/** Schema v1 lines for {@code arena-watch/<agentId>-episodes.jsonl} and {@code -forecasts.jsonl}. */
public final class WatchJson {
	public static final int VERSION = 1;
	private static final Gson GSON = new GsonBuilder().serializeNulls().disableHtmlEscaping().create();

	/** A forecast: a body action whose path or target meets a real hazard. */
	public record Forecast(String id, String agentId, long atMs, String action, String kind, int[] block, double distance, String detail) {
	}

	private WatchJson() {
	}

	public static String line(JsonObject object) {
		return GSON.toJson(object);
	}

	public static JsonObject episode(Episode episode) {
		JsonObject row = new JsonObject();
		row.addProperty("v", VERSION);
		row.addProperty("type", "episode");
		row.addProperty("id", episode.id);
		row.addProperty("agentId", episode.agentId);
		row.addProperty("dim", episode.dim);
		JsonObject pos = new JsonObject();
		pos.addProperty("x", round(episode.x));
		pos.addProperty("y", round(episode.y));
		pos.addProperty("z", round(episode.z));
		row.add("pos", pos);
		row.addProperty("kind", episode.kind);
		JsonObject source = new JsonObject();
		source.addProperty("type", episode.sourceType);
		source.addProperty("entityId", episode.entityId);
		source.add("block", block(episode.block));
		if (episode.sourcePos == null) source.add("pos", JsonNull.INSTANCE);
		else {
			JsonObject sourcePos = new JsonObject();
			sourcePos.addProperty("x", round(episode.sourcePos[0]));
			sourcePos.addProperty("y", round(episode.sourcePos[1]));
			sourcePos.addProperty("z", round(episode.sourcePos[2]));
			source.add("pos", sourcePos);
		}
		row.add("source", source);
		row.add("openedAt", at(episode.openedGameTime, episode.openedEpochMs));
		row.add("closedAt", at(episode.closedGameTime, episode.closedEpochMs));
		row.addProperty("minEtaS", Double.isFinite(episode.minEtaS) ? round(episode.minEtaS) : null);
		row.addProperty("minHealth", episode.minHealth == Float.MAX_VALUE ? null : round(episode.minHealth));
		row.addProperty("outcome", episode.outcome);
		row.addProperty("damage", round(episode.damage));
		row.addProperty("deathMessage", episode.deathMessage);
		JsonObject perceived = new JsonObject();
		perceived.addProperty("perceivable", episode.perceivable);
		perceived.addProperty("inObservation", episode.inObservation);
		perceived.addProperty("firstObservedAt", episode.firstObservedAt);
		row.add("perceived", perceived);
		JsonObject cover = new JsonObject();
		JsonArray armed = new JsonArray();
		episode.armed.forEach(armed::add);
		cover.add("armed", armed);
		JsonArray fired = new JsonArray();
		for (Episode.Firing firing : episode.fired) {
			JsonObject item = new JsonObject();
			item.addProperty("rule", firing.rule());
			item.addProperty("atMs", firing.atMs());
			item.addProperty("result", firing.result());
			fired.add(item);
		}
		cover.add("fired", fired);
		row.add("cover", cover);
		JsonObject body = new JsonObject();
		if (episode.action == null) body.add("action", JsonNull.INSTANCE);
		else {
			JsonObject action = new JsonObject();
			action.addProperty("actionType", episode.action);
			action.add("arguments", episode.actionArguments == null ? new JsonObject() : episode.actionArguments.deepCopy());
			body.add("action", action);
		}
		body.addProperty("causedByAction", episode.causedByAction);
		row.add("body", body);
		JsonObject model = new JsonObject();
		model.addProperty("lastReplyAgoS", episode.lastReplyAgoS == null ? null : round(episode.lastReplyAgoS));
		model.addProperty("wakeSent", episode.wakeSent);
		row.add("model", model);
		row.addProperty("forecastId", episode.forecastId);
		row.addProperty("diagnosis", episode.diagnosis);
		row.addProperty("evidence", episode.evidence);
		return row;
	}

	public static JsonObject forecast(Forecast forecast) {
		JsonObject row = new JsonObject();
		row.addProperty("v", VERSION);
		row.addProperty("type", "forecast");
		row.addProperty("id", forecast.id());
		row.addProperty("agentId", forecast.agentId());
		row.addProperty("atMs", forecast.atMs());
		row.addProperty("action", forecast.action());
		JsonObject hazard = new JsonObject();
		hazard.addProperty("kind", forecast.kind());
		hazard.add("block", block(forecast.block()));
		hazard.addProperty("distance", round(forecast.distance()));
		row.add("hazard", hazard);
		row.addProperty("detail", forecast.detail());
		return row;
	}

	private static JsonObject at(long gameTime, long epochMs) {
		JsonObject at = new JsonObject();
		at.addProperty("gameTime", gameTime);
		at.addProperty("epochMs", epochMs);
		return at;
	}

	private static com.google.gson.JsonElement block(int[] block) {
		if (block == null) return JsonNull.INSTANCE;
		JsonArray array = new JsonArray();
		for (int value : block) array.add(value);
		return array;
	}

	private static double round(double value) {
		return Math.round(value * 100.0D) / 100.0D;
	}
}
