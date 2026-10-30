package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.WeakHashMap;
import net.minecraft.network.chat.Component;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.protocol.game.ClientboundBossEventPacket;
import net.minecraft.network.protocol.game.ClientboundSetActionBarTextPacket;
import net.minecraft.network.protocol.game.ClientboundSetSubtitleTextPacket;
import net.minecraft.network.protocol.game.ClientboundSetTitleTextPacket;
import net.minecraft.network.protocol.game.ClientboundSoundEntityPacket;
import net.minecraft.network.protocol.game.ClientboundSoundPacket;
import net.minecraft.network.protocol.game.ClientboundSystemChatPacket;
import net.minecraft.network.protocol.game.ClientboundPlayerChatPacket;
import net.minecraft.network.protocol.game.ClientboundDisguisedChatPacket;
import net.minecraft.network.protocol.game.ClientboundDamageEventPacket;
import net.minecraft.network.protocol.game.ClientboundHurtAnimationPacket;
import net.minecraft.network.protocol.game.ClientboundPlayerInfoUpdatePacket;
import net.minecraft.network.protocol.game.ClientboundPlayerInfoRemovePacket;
import net.minecraft.network.protocol.game.ClientboundTabListPacket;
import net.minecraft.network.protocol.game.ClientboundTrackedWaypointPacket;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.BossEvent;

/** Observes only packets already addressed to this player, never global world events. */
public final class PlayerObservationEvents {
	private static final Map<ServerPlayer, Stream> PLAYERS = new WeakHashMap<>();
	private static final String[] DIRECTIONS = { "front", "front_right", "right", "back_right", "back", "back_left", "left", "front_left" };

	private PlayerObservationEvents() { }

	public static void capture(ServerPlayer player, Packet<?> packet) {
		if (!(packet instanceof ClientboundSoundPacket || packet instanceof ClientboundSoundEntityPacket
				|| packet instanceof ClientboundBossEventPacket || packet instanceof ClientboundSystemChatPacket
				|| packet instanceof ClientboundSetActionBarTextPacket || packet instanceof ClientboundSetTitleTextPacket
				|| packet instanceof ClientboundSetSubtitleTextPacket || packet instanceof ClientboundPlayerChatPacket
				|| packet instanceof ClientboundDisguisedChatPacket || packet instanceof ClientboundDamageEventPacket
				|| packet instanceof ClientboundHurtAnimationPacket || packet instanceof ClientboundPlayerInfoUpdatePacket
				|| packet instanceof ClientboundPlayerInfoRemovePacket || packet instanceof ClientboundTabListPacket
				|| packet instanceof ClientboundTrackedWaypointPacket)) return;
		var server = player.level().getServer();
		if (!server.isSameThread()) { server.execute(() -> capture(player, packet)); return; }
		Stream stream = stream(player);
		long tick = player.level().getGameTime();
		String dimension = player.level().dimension().identifier().toString();
		if (packet instanceof ClientboundPlayerInfoUpdatePacket tab) {
			for (var entry : tab.entries()) stream.tabPlayer(entry, tab.actions());
		} else if (packet instanceof ClientboundPlayerInfoRemovePacket tab) {
			for (var id : tab.profileIds()) stream.tabPlayers.remove(id);
		} else if (packet instanceof ClientboundTabListPacket tab) {
			stream.tabHeader = ObservationDetails.bounded(tab.header().getString(), 512);
			stream.tabFooter = ObservationDetails.bounded(tab.footer().getString(), 512);
		} else if (packet instanceof ClientboundTrackedWaypointPacket locator) {
			Object operation = locator.operation();
			String id = locator.waypoint().id().toString();
			if ("UNTRACK".equals(operation.toString())) stream.waypoints.remove(id);
			else stream.waypoints.put(id, locator.waypoint());
		} else if (packet instanceof ClientboundSoundPacket sound) {
			String id = sound.getSound().value().location().toString();
			double range = sound.getSound().value().getRange(sound.getVolume());
			sound(player, stream, id, sound.getX(), sound.getY(), sound.getZ(), range, sound.getVolume(), tick, dimension);
			HearingPerception.heardPacket(player, id, sound.getSource().getName(), null, sound.getX(), sound.getY(), sound.getZ(), sound.getVolume(), range);
		} else if (packet instanceof ClientboundSoundEntityPacket sound) {
			var entity = player.level().getEntity(sound.getId());
			String id = sound.getSound().value().location().toString();
			double range = sound.getSound().value().getRange(sound.getVolume());
			if (entity != null) {
				sound(player, stream, id, entity.getX(), entity.getY(), entity.getZ(), range, sound.getVolume(), tick, dimension);
				HearingPerception.heardPacket(player, id, sound.getSource().getName(), entity, entity.getX(), entity.getY(), entity.getZ(), sound.getVolume(), range);
			}
		} else if (packet instanceof ClientboundPlayerChatPacket chat) {
			Component text = chat.filterMask().isEmpty()
					? chat.unsignedContent().orElseGet(() -> Component.literal(chat.body().content()))
					: chat.filterMask().applyWithFormatting(chat.body().content());
			if (text != null) stream.publicChat(chat.sender().toString(), chat.chatType().decorate(text).getString(), tick, dimension);
		} else if (packet instanceof ClientboundDisguisedChatPacket chat) {
			stream.publicChat("server", chat.chatType().decorate(chat.message()).getString(), tick, dimension);
		} else if (packet instanceof ClientboundDamageEventPacket damage) {
			if (damage.entityId() == player.getId()) stream.damage(damage.sourceType().unwrapKey()
					.map(key -> key.identifier().getPath()).orElse("unknown"), tick);
		} else if (packet instanceof ClientboundHurtAnimationPacket hurt) {
			if (hurt.id() == player.getId()) stream.damageDirection(hurt.yaw(), tick);
		} else if (packet instanceof ClientboundBossEventPacket boss) {
			boss.dispatch(new ClientboundBossEventPacket.Handler() {
				@Override public void add(UUID id, Component name, float progress, BossEvent.BossBarColor color,
						BossEvent.BossBarOverlay overlay, boolean darken, boolean music, boolean fog) {
					stream.boss(id.toString(), ObservationDetails.bounded(name.getString(), 256), progress, false, tick, dimension, color.getName(), overlay.getName());
				}
				@Override public void remove(UUID id) { stream.boss(id.toString(), null, null, true, tick, dimension); }
				@Override public void updateProgress(UUID id, float progress) { stream.boss(id.toString(), null, progress, false, tick, dimension); }
				@Override public void updateName(UUID id, Component name) { stream.boss(id.toString(), ObservationDetails.bounded(name.getString(), 256), null, false, tick, dimension); }
				@Override public void updateStyle(UUID id, BossEvent.BossBarColor color, BossEvent.BossBarOverlay overlay) { stream.boss(id.toString(), null, null, false, tick, dimension, color.getName(), overlay.getName()); }
			});
		} else if (packet instanceof ClientboundSystemChatPacket message) {
			stream.text(message.overlay() ? "action_bar" : "system_message", message.content().getString(), tick, dimension);
		} else if (packet instanceof ClientboundSetActionBarTextPacket message) {
			stream.text("action_bar", message.text().getString(), tick, dimension);
		} else if (packet instanceof ClientboundSetTitleTextPacket message) {
			stream.text("title", message.text().getString(), tick, dimension);
		} else if (packet instanceof ClientboundSetSubtitleTextPacket message) {
			stream.text("subtitle", message.text().getString(), tick, dimension);
		}
	}

	private static void sound(ServerPlayer player, Stream stream, String id, double x, double y, double z,
			double range, float volume, long tick, String dimension) {
		double dx = x - player.getX();
		double dy = y - player.getEyeY();
		double dz = z - player.getZ();
		double distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
		if (!(volume > 0) || distance > range) return;
		JsonObject event = soundEvent(id, dx, dy, dz, player.getYRot());
		stream.record(event, tick, dimension);
	}

	static JsonObject soundEvent(String id, double dx, double dy, double dz, float yaw) {
		JsonObject event = new JsonObject();
		event.addProperty("type", "sound");
		event.addProperty("soundId", ObservationDetails.bounded(id, 256));
		double bearing = Math.toDegrees(Math.atan2(-dx, dz)) - yaw;
		int sector = Math.floorMod((int) Math.round(bearing / 45.0D), DIRECTIONS.length);
		event.addProperty("direction", DIRECTIONS[sector]);
		double distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
		event.addProperty("range", distance < 8 ? "near" : distance < 24 ? "medium" : "far");
		event.addProperty("elevation", dy > 3 ? "above" : dy < -3 ? "below" : "level");
		return event;
	}

	public static JsonObject snapshot(ServerPlayer player) { return stream(player).snapshot(player.level().getGameTime(), player.level().dimension().identifier().toString()); }
	public static JsonObject recentDamage(ServerPlayer player) { return stream(player).recentDamage(player.level().getGameTime()); }
	public static JsonObject tabList(ServerPlayer player) { return stream(player).tabList(player.level().getScoreboard()); }
	public static JsonArray locator(ServerPlayer player) {
		JsonArray result = new JsonArray();
		var camera = new net.minecraft.world.waypoints.TrackedWaypoint.Camera() {
			@Override public float yaw() { return player.getYRot(); }
			@Override public net.minecraft.world.phys.Vec3 position() { return player.getEyePosition(); }
		};
		for (var waypoint : stream(player).waypoints.values()) {
			if (waypoint.id().left().filter(id -> id.equals(player.getUUID())).isPresent()) continue;
			double yaw = waypoint.yawAngleToCamera(player.level(), camera, entity -> 1.0F);
			// Vanilla only draws locator icons in this forward window. Packet positions and UUIDs stay private.
			if (!(yaw > -60 && yaw <= 60)) continue;
			JsonObject icon = new JsonObject();
			icon.addProperty("direction", yaw < -15 ? "left" : yaw > 15 ? "right" : "front");
			waypoint.icon().color.ifPresent(color -> icon.addProperty("color", color));
			result.add(icon);
		}
		return result;
	}
	public static void advancementToast(ServerPlayer player, String title) {
		stream(player).text("advancement_toast", "Advancement: " + title, player.level().getGameTime(), player.level().dimension().identifier().toString());
	}
	/** What this player watched of their own thrown eye of ender; see {@link EyeFlightObservation}. */
	public static void eyeFlight(ServerPlayer player, JsonObject event) {
		eyeFlight(player, event, player.level().dimension().identifier().toString());
	}
	public static void eyeFlight(ServerPlayer player, JsonObject event, String dimension) {
		stream(player).record(event, player.level().getGameTime(), dimension);
	}
	public static JsonObject page(ServerPlayer player, long afterSequence, int offset, int limit) {
		Stream stream = stream(player);
		stream.expireFlights(player.level().getGameTime(), player.level().dimension().identifier().toString());
		return stream.page(afterSequence, offset, limit);
	}
	public static long sequence(ServerPlayer player) {
		synchronized (PLAYERS) {
			Stream current = PLAYERS.get(player);
			return current == null ? 0 : current.sequence;
		}
	}

	/**
	 * Sequence of the newest attention event: system messages, titles, boss bars and lava sounds. Other sounds only
	 * reach the model through the heard section, so they wait for the next heartbeat instead of forcing an observation.
	 */
	public static long attentionSequence(ServerPlayer player) {
		synchronized (PLAYERS) {
			Stream current = PLAYERS.get(player);
			return current == null ? 0 : current.attentionSequence;
		}
	}

	public record PublicChat(String sourceId, String text) { }

	/** Only remove a packet after the conversation transport accepted it. */
	public static void deliverPublicChat(ServerPlayer player, java.util.function.Consumer<PublicChat> deliver) {
		stream(player).deliverPublicChat(deliver);
	}

	private static Stream stream(ServerPlayer player) {
		synchronized (PLAYERS) { return PLAYERS.computeIfAbsent(player, ignored -> new Stream()); }
	}

	static final class Stream {
		static final int MAX_EVENTS = 128;
		static final int MAX_UNREAD_CHAT = 128;
		private final ArrayDeque<PublicChat> unreadChat = new ArrayDeque<>();

		void publicChat(String sourceId, String text, long tick, String dimension) {
			String bounded = ObservationDetails.bounded(text.strip(), 512);
			if (bounded.isEmpty()) return;
			unreadChat.addLast(new PublicChat(sourceId, bounded));
			while (unreadChat.size() > MAX_UNREAD_CHAT) unreadChat.removeFirst();
			text("player_chat", text, tick, dimension);
		}

		void deliverPublicChat(java.util.function.Consumer<PublicChat> deliver) {
			while (!unreadChat.isEmpty()) {
				deliver.accept(unreadChat.getFirst());
				unreadChat.removeFirst();
			}
		}

		static final long EYE_FLIGHT_PIN_TICKS = 600;
		static final int MAX_EYE_FLIGHTS = 8;
		private final LinkedHashMap<String, JsonObject> flights = new LinkedHashMap<>();
		private final ArrayDeque<JsonObject> events = new ArrayDeque<>();
		private final LinkedHashMap<String, JsonObject> bars = new LinkedHashMap<>();
		private long sequence;
		private long attentionSequence;
		private String lastSignature;
		private long lastTick = -1;
		private String damageCause;
		private long damageTick = Long.MIN_VALUE;
		private String damageDirection;
		private long directionTick = Long.MIN_VALUE;
		private final LinkedHashMap<UUID, TabPlayer> tabPlayers = new LinkedHashMap<>();
		private final LinkedHashMap<String, net.minecraft.world.waypoints.TrackedWaypoint> waypoints = new LinkedHashMap<>();
		private String tabHeader = "";
		private String tabFooter = "";
		private record TabPlayer(String name, String display, boolean listed, int order, int pingBars, boolean spectator) { }

		void tabPlayer(ClientboundPlayerInfoUpdatePacket.Entry entry, java.util.Set<ClientboundPlayerInfoUpdatePacket.Action> actions) {
			var before = tabPlayers.get(entry.profileId());
			boolean added = actions.contains(ClientboundPlayerInfoUpdatePacket.Action.ADD_PLAYER);
			if (before == null && !added) return;
			String name = added && entry.profile() != null ? entry.profile().name() : before.name();
			String display = actions.contains(ClientboundPlayerInfoUpdatePacket.Action.UPDATE_DISPLAY_NAME) ? entry.displayName() == null ? null : entry.displayName().getString() : before == null ? null : before.display();
			boolean listed = actions.contains(ClientboundPlayerInfoUpdatePacket.Action.UPDATE_LISTED) ? entry.listed() : before != null && before.listed();
			int order = actions.contains(ClientboundPlayerInfoUpdatePacket.Action.UPDATE_LIST_ORDER) ? entry.listOrder() : before == null ? 0 : before.order();
			int ping = actions.contains(ClientboundPlayerInfoUpdatePacket.Action.UPDATE_LATENCY) ? pingBars(entry.latency()) : before == null ? 5 : before.pingBars();
			boolean spectator = actions.contains(ClientboundPlayerInfoUpdatePacket.Action.UPDATE_GAME_MODE) ? entry.gameMode() == net.minecraft.world.level.GameType.SPECTATOR : before != null && before.spectator();
			tabPlayers.put(entry.profileId(), new TabPlayer(name, display, listed, order, ping, spectator));
		}

		JsonObject tabList() { return tabList(null); }

		JsonObject tabList(net.minecraft.world.scores.Scoreboard scoreboard) {
			JsonObject result = new JsonObject();
			JsonArray names = new JsonArray();
			JsonArray entries = new JsonArray();
			var objective = scoreboard == null ? null : scoreboard.getDisplayObjective(net.minecraft.world.scores.DisplaySlot.LIST);
			var ordering = java.util.Comparator.comparingInt(TabPlayer::order).reversed()
					.thenComparingInt(row -> row.spectator() ? 1 : 0)
					.thenComparing(row -> scoreboard == null || scoreboard.getPlayersTeam(row.name()) == null ? "" : scoreboard.getPlayersTeam(row.name()).getName())
					.thenComparing(TabPlayer::name, String.CASE_INSENSITIVE_ORDER);
			var listed = tabPlayers.values().stream().filter(TabPlayer::listed).sorted(ordering).toList();
			listed.stream().limit(80).forEach(row -> {
				String name = row.display() != null ? row.display() : scoreboard == null ? row.name()
						: net.minecraft.world.scores.PlayerTeam.formatNameForTeam(scoreboard.getPlayersTeam(row.name()), Component.literal(row.name())).getString();
				name = ObservationDetails.bounded(name, 256);
				names.add(name);
				JsonObject entry = new JsonObject();
				entry.addProperty("name", name);
				entry.addProperty("pingBars", row.pingBars());
				if (row.pingBars() == 0) entry.addProperty("pingUnknown", true);
				if (objective != null && !row.spectator()) {
					var score = scoreboard.getPlayerScoreInfo(net.minecraft.world.scores.ScoreHolder.forNameOnly(row.name()), objective);
					if (objective.getRenderType() == net.minecraft.world.scores.criteria.ObjectiveCriteria.RenderType.HEARTS) {
						entry.addProperty("scoreHearts", PlayerHudInspection.halfHearts(score == null ? 0 : score.value()));
					} else {
						var format = objective.numberFormatOrDefault(net.minecraft.network.chat.numbers.StyledFormat.PLAYER_LIST_DEFAULT);
						entry.addProperty("score", ObservationDetails.bounded((score != null ? score.formatValue(format) : format.format(0)).getString(), 256));
					}
				}
				entries.add(entry);
			});
			result.add("names", names);
			result.add("entries", entries);
			result.addProperty("omitted", Math.max(0, listed.size() - names.size()));
			if (!tabHeader.isEmpty()) result.addProperty("header", tabHeader);
			if (!tabFooter.isEmpty()) result.addProperty("footer", tabFooter);
			return result;
		}

		static int pingBars(int latency) { return latency < 0 ? 0 : latency < 150 ? 5 : latency < 300 ? 4 : latency < 600 ? 3 : latency < 1000 ? 2 : 1; }

		void damage(String cause, long tick) {
			damageCause = cause;
			damageTick = tick;
		}

		void damageDirection(float hurtYaw, long tick) {
			// Vanilla hurt tilt is atan2(source dz, source dx) - view yaw, 90 degrees from the view bearing.
			damageDirection = DIRECTIONS[Math.floorMod((int) Math.round((hurtYaw - 90.0D) / 45.0D), DIRECTIONS.length)];
			directionTick = tick;
		}

		JsonObject recentDamage(long tick) {
			boolean causeRecent = damageCause != null && tick >= damageTick && tick - damageTick <= 100;
			boolean directionRecent = damageDirection != null && tick >= directionTick && tick - directionTick <= 100;
			if (!causeRecent && !directionRecent) return null;
			JsonObject result = new JsonObject();
			if (causeRecent) result.addProperty("cause", damageCause);
			// An environmental hit after an attack must not inherit that attack's direction.
			if (directionRecent && (!causeRecent || Math.abs(directionTick - damageTick) <= 1)) result.addProperty("direction", damageDirection);
			result.addProperty("secondsAgo", (tick - Math.max(causeRecent ? damageTick : Long.MIN_VALUE, directionRecent ? directionTick : Long.MIN_VALUE)) / 20L);
			return result;
		}

		void record(JsonObject event, long tick, String dimension) {
			String signature = event.toString() + dimension;
			if (tick == lastTick && signature.equals(lastSignature)) return;
			lastTick = tick;
			lastSignature = signature;
			JsonObject owned = event.deepCopy();
			owned.addProperty("sequence", ++sequence);
			if (carriesAttention(event)) attentionSequence = sequence;
			owned.addProperty("gameTime", tick);
			owned.addProperty("dimension", dimension);
			owned.addProperty("observedAtEpochMs", System.currentTimeMillis());
			if (isEyeFlight(owned)) {
				expireFlights(tick, dimension);
				String key = dimension + ":" + (owned.has("flightId") ? owned.get("flightId").getAsString() : owned.get("sequence").getAsString());
				flights.remove(key);
				flights.put(key, owned);
				while (flights.size() > MAX_EYE_FLIGHTS) flights.remove(flights.keySet().iterator().next());
			} else events.addLast(owned);
			while (events.size() > MAX_EVENTS) events.removeFirst();
		}

		long attentionSequence() {
			return attentionSequence;
		}

		/** Lava stays an attention fact (the policy raises "heard" for it); every other sound is routine. */
		private static boolean carriesAttention(JsonObject event) {
			String type = event.get("type").getAsString();
			if ("player_chat".equals(type) || "advancement_toast".equals(type)) return false;
			if (!"sound".equals(type)) return true;
			return event.has("soundId") && HearingPerception.isLava(event.get("soundId").getAsString());
		}

		void text(String kind, String value, long tick, String dimension) {
			JsonObject event = new JsonObject();
			event.addProperty("type", kind);
			event.addProperty("text", ObservationDetails.bounded(value, 512));
			event.addProperty("textTruncated", value.codePointCount(0, value.length()) > 512);
			record(event, tick, dimension);
		}

		void boss(String id, String name, Float progress, boolean remove, long tick, String dimension) {
			boss(id, name, progress, remove, tick, dimension, null, null);
		}

		void boss(String id, String name, Float progress, boolean remove, long tick, String dimension, String color, String overlay) {
			if (remove) {
				if (bars.remove(id) == null) return;
				JsonObject event = new JsonObject();
				event.addProperty("type", "boss_bar_removed");
				event.addProperty("barId", id);
				record(event, tick, dimension);
				return;
			}
			JsonObject before = bars.get(id);
			JsonObject bar = before == null ? new JsonObject() : before.deepCopy();
			bar.addProperty("barId", id);
			if (name != null) bar.addProperty("name", name);
			if (color != null) bar.addProperty("color", color);
			if (overlay != null) bar.addProperty("overlay", overlay);
			if (progress != null) bar.addProperty("progress", Math.round(Math.max(0, Math.min(1, progress)) * 100) / 100.0);
			if (bar.equals(before)) return;
			bars.put(id, bar);
			while (bars.size() > 16) bars.remove(bars.keySet().iterator().next());
			JsonObject event = bar.deepCopy();
			event.addProperty("type", "boss_bar");
			record(event, tick, dimension);
		}

		JsonObject snapshot() { return snapshot(lastTick, null); }

		JsonObject snapshot(long tick, String dimension) {
			expireFlights(tick, dimension);
			JsonObject value = new JsonObject();
			value.addProperty("latestSequence", sequence);
			JsonArray recent = new JsonArray();
			List<JsonObject> routine = new ArrayList<>(events);
			int routineSlots = Math.max(0, 8 - flights.size());
			List<JsonObject> window = new ArrayList<>(routine.subList(Math.max(0, routine.size() - routineSlots), routine.size()));
			window.addAll(flights.values());
			window.sort(java.util.Comparator.comparingLong(event -> event.get("sequence").getAsLong()));
			for (JsonObject retainedEvent : window) {
				JsonObject event = retainedEvent.deepCopy();
				if (event.has("text") && event.get("text").getAsString().length() > 128) {
					event.addProperty("text", ObservationDetails.bounded(event.get("text").getAsString(), 128));
					event.addProperty("textTruncated", true);
				}
				recent.add(event);
			}
			value.add("events", recent);
			JsonArray bossBars = new JsonArray();
			bars.values().forEach(bar -> {
				JsonObject compact = bar.deepCopy();
				if (compact.has("name") && compact.get("name").getAsString().length() > 96) {
					compact.addProperty("name", ObservationDetails.bounded(compact.get("name").getAsString(), 96));
					compact.addProperty("nameTruncated", true);
				}
				bossBars.add(compact);
			});
			value.add("bossBars", bossBars);
			value.addProperty("earliestSequence", earliestSequence());
			return value;
		}

		private static boolean isEyeFlight(JsonObject event) {
			return "eye_of_ender_flight".equals(event.get("type").getAsString());
		}

		void expireFlights(long tick, String dimension) {
			flights.values().removeIf(event -> tick < event.get("gameTime").getAsLong()
					|| tick - event.get("gameTime").getAsLong() > EYE_FLIGHT_PIN_TICKS
					|| dimension != null && !dimension.equals(event.get("dimension").getAsString()));
		}

		private List<JsonObject> retainedEvents() {
			List<JsonObject> result = new ArrayList<>(events);
			result.addAll(flights.values());
			result.sort(java.util.Comparator.comparingLong(event -> event.get("sequence").getAsLong()));
			return result;
		}

		private long earliestSequence() {
			List<JsonObject> retained = retainedEvents();
			return retained.isEmpty() ? sequence + 1 : retained.getFirst().get("sequence").getAsLong();
		}

		JsonObject page(long afterSequence, int offset, int limit) {
			List<JsonObject> retained = retainedEvents().stream().filter(event -> event.get("sequence").getAsLong() > afterSequence).toList();
			JsonObject value = ObservationPage.collect(retained.size(), offset, limit, index -> retained.get(index).deepCopy(), "packets_addressed_to_this_player");
			JsonObject coverage = value.getAsJsonObject("coverage");
			long earliest = earliestSequence();
			coverage.addProperty("earliestSequence", earliest);
			coverage.addProperty("latestSequence", sequence);
			boolean gap = afterSequence >= 0 && afterSequence < earliest - 1;
			long previous = afterSequence;
			for (JsonObject event : retained) {
				long current = event.get("sequence").getAsLong();
				if (previous >= 0 && current > previous + 1) gap = true;
				previous = current;
			}
			coverage.addProperty("gap", gap);
			return value;
		}
	}
}
