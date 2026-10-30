package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonObject;
import com.mojang.authlib.GameProfile;
import dev.agaminggod.arenaagents.server.runtime.input.RidingJumpInput;
import java.util.Set;
import java.util.UUID;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.numbers.FixedFormat;
import net.minecraft.network.protocol.game.ClientboundPlayerInfoUpdatePacket;
import net.minecraft.world.level.GameType;
import net.minecraft.world.scores.DisplaySlot;
import net.minecraft.world.scores.ScoreHolder;
import net.minecraft.world.scores.Scoreboard;
import net.minecraft.world.scores.criteria.ObjectiveCriteria;

public final class PlayerHudExtrasVerification {
	private PlayerHudExtrasVerification() { }

	public static int verify() {
		check(PlayerHudInspection.jumpPixels(0) == 0, "unheld mount jump has no filled pixels");
		check(PlayerHudInspection.jumpPixels(0.5F) == 91, "mount jump fill follows vanilla discrete interpolation");
		check(PlayerHudInspection.jumpPixels(1) == 182, "fully charged mount jump fills the visible bar");
		RidingJumpInput jump = new RidingJumpInput();
		jump.tick(true, true);
		for (int tick = 0; tick < 5; tick++) jump.tick(true, true);
		check(PlayerHudInspection.jumpPixels(jump.jumpScale()) == 91, "HUD reads the actual authored riding input charge");
		check(jump.tick(false, true) == 50, "reading charge does not change the release action");
		jump.reset();
		check(jump.jumpScale() == 0, "cancelled input clears the displayed riding charge");
		check(PlayerObservationEvents.Stream.pingBars(-1) == 0, "unknown latency shows the vanilla unknown icon");
		check(PlayerObservationEvents.Stream.pingBars(149) == 5 && PlayerObservationEvents.Stream.pingBars(150) == 4, "first ping boundary matches vanilla");
		check(PlayerObservationEvents.Stream.pingBars(299) == 4 && PlayerObservationEvents.Stream.pingBars(300) == 3, "second ping boundary matches vanilla");
		check(PlayerObservationEvents.Stream.pingBars(599) == 3 && PlayerObservationEvents.Stream.pingBars(600) == 2, "third ping boundary matches vanilla");
		check(PlayerObservationEvents.Stream.pingBars(999) == 2 && PlayerObservationEvents.Stream.pingBars(1000) == 1, "fourth ping boundary matches vanilla");
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		PlayerObservationEvents.Stream stream = new PlayerObservationEvents.Stream();
		UUID id = UUID.randomUUID();
		stream.tabPlayer(tab(id, "Visible", true, 149, GameType.SURVIVAL), Set.of(
				ClientboundPlayerInfoUpdatePacket.Action.ADD_PLAYER, ClientboundPlayerInfoUpdatePacket.Action.UPDATE_LISTED,
				ClientboundPlayerInfoUpdatePacket.Action.UPDATE_LATENCY, ClientboundPlayerInfoUpdatePacket.Action.UPDATE_GAME_MODE));
		check(first(stream.tabList()).get("pingBars").getAsInt() == 5, "addressed initial latency supplies displayed ping bars");
		stream.tabPlayer(tab(id, null, false, 650, null), Set.of(ClientboundPlayerInfoUpdatePacket.Action.UPDATE_LATENCY));
		JsonObject updated = first(stream.tabList());
		check(updated.get("pingBars").getAsInt() == 2 && !updated.has("latency") && !updated.has("latencyMs"), "latency update preserves listing and exposes no exact milliseconds");
		Scoreboard scoreboard = new Scoreboard();
		var list = scoreboard.addObjective("shown", ObjectiveCriteria.DUMMY, Component.literal("Hidden objective title"), ObjectiveCriteria.RenderType.INTEGER, false, new FixedFormat(Component.literal("Shown value")));
		scoreboard.getOrCreatePlayerScore(ScoreHolder.forNameOnly("Visible"), list).set(13);
		check(!first(stream.tabList(scoreboard)).has("score"), "undisplayed scoreboard objectives are absent");
		scoreboard.setDisplayObjective(DisplaySlot.LIST, list);
		JsonObject scored = first(stream.tabList(scoreboard));
		check(scored.get("score").getAsString().equals("Shown value"), "tab score uses the displayed objective's number format");
		check(!scored.toString().contains("13") && !scored.toString().contains("Hidden objective title"), "formatted scores expose no hidden raw value or undisplayed title");
		scoreboard.getOrCreatePlayerScore(ScoreHolder.forNameOnly("Visible"), list).numberFormatOverride(new FixedFormat(Component.literal("Own format")));
		check(first(stream.tabList(scoreboard)).get("score").getAsString().equals("Own format"), "per-player displayed number format is honored");
		var hearts = scoreboard.addObjective("hearts", ObjectiveCriteria.DUMMY, Component.literal("Health"), ObjectiveCriteria.RenderType.HEARTS, false, null);
		scoreboard.getOrCreatePlayerScore(ScoreHolder.forNameOnly("Visible"), hearts).set(9);
		scoreboard.setDisplayObjective(DisplaySlot.LIST, hearts);
		check(first(stream.tabList(scoreboard)).get("scoreHearts").getAsDouble() == 4.5, "heart-rendered list scores report visible half hearts");
		stream.tabPlayer(tab(id, null, false, 0, GameType.SPECTATOR), Set.of(ClientboundPlayerInfoUpdatePacket.Action.UPDATE_GAME_MODE));
		check(!first(stream.tabList(scoreboard)).has("scoreHearts"), "vanilla spectator tab rows do not display scores");
		UUID playingId = UUID.randomUUID();
		stream.tabPlayer(tab(playingId, "Zed", true, 0, GameType.SURVIVAL), Set.of(ClientboundPlayerInfoUpdatePacket.Action.ADD_PLAYER, ClientboundPlayerInfoUpdatePacket.Action.UPDATE_LISTED));
		check(first(stream.tabList(scoreboard)).get("name").getAsString().equals("Zed"), "spectator rows sort after playing rows before the visible eighty-player cut");
		stream.tabPlayer(tab(playingId, null, false, 0, null), Set.of(ClientboundPlayerInfoUpdatePacket.Action.UPDATE_LISTED));
		stream.tabPlayer(tab(id, null, false, 0, null), Set.of(ClientboundPlayerInfoUpdatePacket.Action.UPDATE_LISTED));
		check(stream.tabList(scoreboard).getAsJsonArray("entries").isEmpty(), "unlisted players have neither ping nor score rows");
		return 21;
	}

	private static ClientboundPlayerInfoUpdatePacket.Entry tab(UUID id, String name, boolean listed, int latency, GameType mode) {
		return new ClientboundPlayerInfoUpdatePacket.Entry(id, name == null ? null : new GameProfile(id, name), listed, latency, mode, null, true, 0, null);
	}

	private static JsonObject first(JsonObject tab) { return tab.getAsJsonArray("entries").get(0).getAsJsonObject(); }
	private static void check(boolean condition, String label) { if (!condition) throw new AssertionError(label); }
}
