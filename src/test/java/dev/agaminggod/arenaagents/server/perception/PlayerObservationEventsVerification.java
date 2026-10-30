package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonObject;
import net.minecraft.world.phys.Vec3;

public final class PlayerObservationEventsVerification {
	private PlayerObservationEventsVerification() { }

	public static int verify() {
		JsonObject sound = PlayerObservationEvents.soundEvent("minecraft:entity.zombie.ambient", 0, 0, 4, 0);
		check(sound.get("direction").getAsString().equals("front"), "sound bearing is relative to the listener");
		check(sound.get("range").getAsString().equals("near"), "sound range is approximate");
		check(!sound.has("x") && !sound.has("z") && !sound.has("entityId"), "sound exposes no hidden coordinate or entity ID");
		JsonObject left = PlayerObservationEvents.soundEvent("sound", 10, 8, 0, 0);
		check(left.get("direction").getAsString().equals("left") && left.get("elevation").getAsString().equals("above"), "bearing and elevation survive without vision");
		PlayerObservationEvents.Stream first = new PlayerObservationEvents.Stream();
		PlayerObservationEvents.Stream other = new PlayerObservationEvents.Stream();
		first.record(sound, 1, "minecraft:overworld");
		first.record(sound, 1, "minecraft:overworld");
		check(first.snapshot().get("latestSequence").getAsLong() == 1, "same-tick duplicate packets coalesce");
		sound.addProperty("soundId", "changed");
		check(first.snapshot().getAsJsonArray("events").get(0).getAsJsonObject().get("soundId").getAsString().equals("minecraft:entity.zombie.ambient"), "event queue owns its facts");
		check(other.snapshot().getAsJsonArray("events").isEmpty(), "another player's stream cannot see these events");
		for (int index = 2; index <= 180; index++) first.text("system_message", "message " + index, index, "minecraft:overworld");
		JsonObject page = first.page(0, 0, 32);
		check(page.getAsJsonObject("coverage").get("total").getAsInt() == 128, "retention is bounded");
		check(page.getAsJsonObject("coverage").get("gap").getAsBoolean(), "expired history is reported as a gap");
		check(page.getAsJsonObject("coverage").get("earliestSequence").getAsLong() == 53, "oldest retained sequence remains explicit");
		check(first.snapshot().getAsJsonArray("events").size() == 8, "heartbeat carries only a small recent window");
		other.boss("bar", "Visible bar", 0.5F, false, 1, "minecraft:overworld");
		other.boss("bar", null, 0.501F, false, 2, "minecraft:overworld");
		check(other.snapshot().get("latestSequence").getAsLong() == 1, "sub-percent boss changes do not flood attention");
		other.boss("bar", null, 0.4F, false, 3, "minecraft:overworld");
		check(other.snapshot().getAsJsonArray("bossBars").get(0).getAsJsonObject().get("name").getAsString().equals("Visible bar"), "partial bar updates preserve its observed name");
		other.boss("bar", null, null, true, 4, "minecraft:overworld");
		check(other.snapshot().getAsJsonArray("bossBars").isEmpty(), "remove packet clears the visible bar");
		JsonObject before = new JsonObject();
		JsonObject after = new JsonObject();
		before.add("perception", new PlayerObservationEvents.Stream().snapshot());
		after.add("perception", other.snapshot());
		check(AttentionSignalPolicy.changedFacts(before, after).contains("perception"), "new entitled events request model attention");
		return 15 + verifyAttentionSequence() + verifyUnreadPublicChat() + verifyEyeFlight() + verifyEyeFlightEvidence() + verifyEyeFlightRetention() + verifyEyeLineCross();
	}

	private static int verifyUnreadPublicChat() {
		PlayerObservationEvents.Stream stream = new PlayerObservationEvents.Stream();
		String longText = "x".repeat(400);
		for (int i = 0; i < 9; i++) {
			stream.publicChat("player", i == 0 ? longText : "chat " + i, i, "minecraft:overworld");
			for (int j = 0; j < 150; j++) stream.record(PlayerObservationEvents.soundEvent("footstep" + j, 0, 0, 2, 0), i, "minecraft:overworld");
		}
		check(stream.attentionSequence() == 0, "public chat and routine sounds never wake agents");
		try { stream.deliverPublicChat(chat -> { throw new IllegalStateException("disconnected"); }); }
		catch (IllegalStateException expected) { }
		var delivered = new java.util.ArrayList<PlayerObservationEvents.PublicChat>();
		stream.deliverPublicChat(delivered::add);
		check(delivered.size() == 9, "all nine unread messages survive disconnect and interleaved ring eviction");
		check(delivered.getFirst().text().equals(longText), "public text over 128 points reaches the conversation intact");
		stream.deliverPublicChat(delivered::add);
		check(delivered.size() == 9, "successful handoff consumes unread packets exactly once");
		for (int i = 0; i < 129; i++) stream.publicChat("player", "chat " + i, i, "minecraft:overworld");
		var bounded = new java.util.ArrayList<PlayerObservationEvents.PublicChat>();
		stream.deliverPublicChat(bounded::add);
		check(bounded.size() == 128 && bounded.getFirst().text().equals("chat 1"), "disconnected unread chat has a separate bounded 128-message window");
		return 5;
	}

	/** Footsteps arrive many times a second; only events that are facts of their own move the forced-observation sequence. */
	private static int verifyAttentionSequence() {
		PlayerObservationEvents.Stream stream = new PlayerObservationEvents.Stream();
		stream.record(PlayerObservationEvents.soundEvent("minecraft:block.grass.step", 0, 0, 2, 0), 1, "minecraft:overworld");
		stream.record(PlayerObservationEvents.soundEvent("minecraft:entity.zombie.ambient", 4, 0, 4, 0), 2, "minecraft:overworld");
		check(stream.snapshot().get("latestSequence").getAsLong() == 2, "sounds still advance the public sequence");
		check(stream.attentionSequence() == 0, "sounds do not move the attention sequence");
		stream.record(PlayerObservationEvents.soundEvent("minecraft:block.lava.extinguish", 1, 0, 1, 0), 3, "minecraft:overworld");
		check(stream.attentionSequence() == 3, "a lava sound is still an attention fact (the policy raises heard lava)");
		stream.text("system_message", "hello", 4, "minecraft:overworld");
		check(stream.attentionSequence() == 4, "chat advances the attention sequence");
		stream.record(PlayerObservationEvents.soundEvent("minecraft:block.grass.step", 0, 0, 2, 0), 5, "minecraft:overworld");
		check(stream.attentionSequence() == 4 && stream.snapshot().get("latestSequence").getAsLong() == 5, "later footsteps leave it where it was");
		stream.boss("bar", "Boss", 0.5F, false, 6, "minecraft:overworld");
		check(stream.attentionSequence() == 6, "boss bars advance the attention sequence");
		stream.text("player_chat", "<Human> hello", 7, "minecraft:overworld");
		check(stream.attentionSequence() == 6, "addressed player chat does not add an attention wake");
		stream.text("advancement_toast", "Advancement: Stone Age", 8, "minecraft:overworld");
		check(stream.attentionSequence() == 6, "advancement toasts do not add an attention wake");
		check(stream.snapshot().get("latestSequence").getAsLong() == 8, "quiet facts remain in the event stream");
		stream.text("system_message", "whisper", 9, "minecraft:overworld");
		check(stream.attentionSequence() == 9, "base system message and whisper attention is preserved");
		return 10;
	}

	/** A thrown eye becomes one seen-flight fact: its bearing from the throw point, rise or sink, and how it ended. */
	private static int verifyEyeFlight() {
		Vec3 origin = new Vec3(100.5D, 65.5D, -20.5D);
		// Thrown toward a stronghold to the north-east (-Z, +X): yaw -135 in Minecraft's convention.
		JsonObject rose = EyeFlightObservation.event(origin, new Vec3(108.5D, 73.5D, -28.5D), 65.6D, 73.5D, "dropped");
		check(rose.get("yaw").getAsDouble() == -135.0D && rose.get("heading").getAsString().equals("northeast"), "flight bearing is the seen horizontal direction from the throw point");
		check(rose.get("vertical").getAsString().equals("rose") && rose.get("outcome").getAsString().equals("dropped"), "a far-off destination shows as a rising eye that dropped");
		check(rose.get("flewBlocks").getAsDouble() == 11.3D, "horizontal flight length is reported");
		check(rose.getAsJsonObject("from").get("x").getAsDouble() == 100.5D && rose.getAsJsonObject("to").get("z").getAsDouble() == -28.5D, "throw point and last seen position are kept");
		check(!rose.has("target") && !rose.has("strongholdX") && rose.size() == 8, "no hidden destination or derived stronghold position");
		JsonObject sank = EyeFlightObservation.event(origin, new Vec3(100.5D, 61.0D, -15.5D), 61.0D, 65.5D, "shattered");
		check(sank.get("vertical").getAsString().equals("sank") && sank.get("heading").getAsString().equals("south"), "a near destination shows as a sinking eye");
		// Live: a throw six blocks from the stronghold was last seen 1.1 blocks lower, entering the ground.
		JsonObject intoGround = EyeFlightObservation.event(origin, new Vec3(99.3D, 64.8D, -20.6D), 64.8D, 65.5D, "shattered");
		check(intoGround.get("vertical").getAsString().equals("sank"), "an eye lost into the ground just below the throw counts as sinking");
		JsonObject unseen = EyeFlightObservation.event(origin, null, 0, 0, "unseen");
		check(!unseen.has("yaw") && !unseen.has("to") && unseen.get("outcome").getAsString().equals("unseen"), "an eye never seen gives no bearing");
		PlayerObservationEvents.Stream stream = new PlayerObservationEvents.Stream();
		stream.record(rose, 10, "minecraft:overworld");
		for (int tick = 11; tick <= 30; tick++) stream.record(PlayerObservationEvents.soundEvent("minecraft:entity.cow.ambient", tick, 0, 2, 0), tick, "minecraft:overworld");
		var window = stream.snapshot().getAsJsonArray("events");
		check(window.size() == 8 && window.get(0).getAsJsonObject().get("type").getAsString().equals("eye_of_ender_flight"), "later sounds do not push a recent flight out of the wake window");
		check(window.get(1).getAsJsonObject().get("sequence").getAsLong() > window.get(0).getAsJsonObject().get("sequence").getAsLong(), "the pinned window stays in sequence order");
		stream.record(PlayerObservationEvents.soundEvent("minecraft:entity.cow.ambient", 1, 0, 2, 0), 10 + PlayerObservationEvents.Stream.EYE_FLIGHT_PIN_TICKS + 1, "minecraft:overworld");
		check(!stream.snapshot().getAsJsonArray("events").get(0).getAsJsonObject().get("type").getAsString().equals("eye_of_ender_flight"), "an old flight leaves the window after 30 seconds");
		check(stream.attentionSequence() == 1, "a flight is an attention fact that wakes the model");
		return 12;
	}

	private static int verifyEyeFlightEvidence() {
		Vec3 origin = new Vec3(0, 65, 0);
		Vec3 observed = new Vec3(0, 70, 8);
		Vec3 hidden = new Vec3(0, 73, 12);
		var flight = new EyeFlightObservation.ObservedFlight(origin);
		flight.seen(hidden, false);
		flight.shattered(false);
		flight.dropped(hidden, false, true);
		check(flight.event() == null, "unseen eye and ending produce no hidden facts even within hearing range");
		flight.seen(observed, true);
		flight.seen(hidden, false);
		flight.shattered(false);
		JsonObject partial = flight.event();
		check(partial.get("outcome").getAsString().equals("unseen"), "common death sound and occluded shatter leave outcome unknown");
		check(partial.getAsJsonObject("to").get("z").getAsDouble() == 8, "unload or removal preserves only the visible trajectory prefix");
		check(partial.get("yaw").getAsDouble() == 0, "partial trajectory preserves its observed bearing");
		flight.dropped(hidden, false, true);
		check(flight.event().equals(partial), "occluded dropped item cannot resolve unknown ending or supply coordinates");
		flight.dropped(new Vec3(0, 66, 12), true, false);
		check(flight.event().get("outcome").getAsString().equals("dropped"), "later visible item resolves the ending");
		check(flight.event().getAsJsonObject("droppedAt").get("y").getAsDouble() == 66, "only observed item coordinates are published");
		check(flight.event().getAsJsonObject("to").equals(partial.getAsJsonObject("to")), "falling item does not change the observed flight bearing");
		JsonObject falling = flight.event();
		flight.dropped(new Vec3(0, 65.5, 12), true, false);
		check(flight.event().equals(falling), "each falling item tick does not create attention or changing facts");
		flight.dropped(new Vec3(0, 64, 12), true, true);
		check(flight.event().getAsJsonObject("droppedAt").get("y").getAsDouble() == 64, "visible landing updates pickup location");
		var shattered = new EyeFlightObservation.ObservedFlight(origin);
		shattered.seen(observed, true);
		shattered.shattered(true);
		check(shattered.event().get("outcome").getAsString().equals("shattered") && !shattered.event().has("droppedAt"), "visible shatter particles establish shattering without an item location");
		// Live d4 search: eyes seen for under a second before leaving view were reported level and read as "near".
		var glimpse = new EyeFlightObservation.ObservedFlight(origin);
		for (int tick = 1; tick <= 4; tick++) glimpse.seen(new Vec3(-0.5D * tick, 65.1D, 0), true);
		for (int tick = 5; tick <= 40; tick++) glimpse.seen(new Vec3(-0.5D * tick, 70, 0), false);
		check(!glimpse.event().has("vertical") && glimpse.event().get("outcome").getAsString().equals("unseen"),
				"a short sighting that stayed level does not claim the eye stayed level");
		var watched = new EyeFlightObservation.ObservedFlight(origin);
		for (int tick = 1; tick <= 20; tick++) watched.seen(new Vec3(-0.1D * tick, 65.2D, 0), true);
		check(watched.event().get("vertical").getAsString().equals("level"), "an eye watched past the climb window can be level");
		var quickRise = new EyeFlightObservation.ObservedFlight(origin);
		quickRise.seen(new Vec3(0, 66.5D, 2), true);
		check(quickRise.event().get("vertical").getAsString().equals("rose"), "a rise is a finding even from a short sighting");
		check(!ObservationVisibility.isWithinViewCone(new Vec3(0, 65, 0), new Vec3(0, 0, -1), observed), "eye behind the player's current view is not observed");
		check(ObservationVisibility.isWithinViewCone(new Vec3(0, 65, 0), new Vec3(0, 0, 1), observed), "turning toward the flight admits visible evidence");
		check(!ObservationVisibility.isWithinViewCone(new Vec3(0, 65, 20), new Vec3(0, 0, 1), observed), "moving beyond the eye changes visibility using the current player position");
		return 17;
	}

	/** Live d4e search: eyes 89 and 111 degrees from two throw points 250 blocks apart already pinned the stronghold. */
	private static int verifyEyeLineCross() {
		Vec3 stronghold = new Vec3(256.5D, 0, 2544.5D);
		Vec3 first = new Vec3(845.4D, 65.6D, 2537.3D);
		Vec3 second = new Vec3(637.7D, 63.6D, 2688.5D);
		var lines = new EyeFlightObservation.BearingLines();
		lines.record(911, "minecraft:overworld", first, toward(first, stronghold));
		JsonObject alone = new JsonObject();
		lines.addCross(alone, 911, "minecraft:overworld");
		check(!alone.has("cross"), "one throw gives a bearing but no crossing");
		lines.record(1750, "minecraft:overworld", second, toward(second, stronghold));
		JsonObject later = new JsonObject();
		lines.addCross(later, 1750, "minecraft:overworld");
		check(later.getAsJsonObject("cross").get("x").getAsDouble() == 257 && later.getAsJsonObject("cross").get("z").getAsDouble() == 2545,
				"two throws from different spots cross at the stronghold start");
		check(later.get("crossBlocks").getAsLong() == 407 && later.get("crossFlightId").getAsInt() == 911, "the crossing names its distance and the earlier eye");
		JsonObject otherDimension = new JsonObject();
		lines.record(1800, "minecraft:the_nether", second.add(30, 0, 30), toward(second.add(30, 0, 30), stronghold));
		lines.addCross(otherDimension, 1800, "minecraft:the_nether");
		check(!otherDimension.has("cross"), "lines from another dimension never cross");
		Vec3 along = new Vec3(700.0D, 64, 2540.0D);
		JsonObject sameLine = new JsonObject();
		var straight = new EyeFlightObservation.BearingLines();
		straight.record(1, "minecraft:overworld", first, toward(first, stronghold));
		straight.record(2, "minecraft:overworld", along, toward(first, stronghold));
		straight.addCross(sameLine, 2, "minecraft:overworld");
		check(!sameLine.has("cross"), "walking along the first line gives parallel bearings and no crossing");
		check(EyeFlightObservation.cross(0, 0, new double[] { 1, 0 }, 10, 10, new double[] { 0, 1 }) == null, "lines meeting behind a throw point do not cross");
		var lost = new EyeFlightObservation.ObservedFlight(first);
		lost.seen(first.add(-0.6D, 0.3D, 0), true);
		for (int tick = 2; tick <= 80; tick++) lost.seen(first.add(-0.15D * tick, 0.1D * tick, 0), false);
		check(lost.event().get("lostFromView").getAsBoolean() && !lost.event().has("flewBlocks") && lost.event().has("yaw"),
				"an eye lost from view keeps its exact bearing but claims no travel length");
		lost.dropped(first.add(-12.4D, 0, 1), true, true);
		check(!lost.event().has("lostFromView") && lost.event().get("flewBlocks").getAsDouble() == 12.4D, "a seen drop gives the eye's whole travel");
		return 9;
	}

	private static double[] toward(Vec3 from, Vec3 target) {
		double dx = target.x - from.x;
		double dz = target.z - from.z;
		double length = Math.hypot(dx, dz);
		return new double[] { dx / length, dz / length };
	}

	private static int verifyEyeFlightRetention() {
		var stream = new PlayerObservationEvents.Stream();
		JsonObject flight = EyeFlightObservation.event(Vec3.ZERO, new Vec3(0, 8, 12), 0, 8, "unseen");
		flight.addProperty("flightId", 100);
		stream.record(flight, 10, "minecraft:overworld");
		flight.addProperty("flightId", 101);
		stream.record(flight, 11, "minecraft:overworld");
		for (int tick = 12; tick <= 150; tick++) stream.record(PlayerObservationEvents.soundEvent("minecraft:entity.cow.ambient", 1, 0, 2, 0), tick, "minecraft:overworld");
		var events = stream.snapshot(150, "minecraft:overworld").getAsJsonArray("events");
		check(events.size() == 8 && events.get(0).getAsJsonObject().get("flightId").getAsInt() == 100 && events.get(1).getAsJsonObject().get("flightId").getAsInt() == 101, "two flights survive more than 128 routine sounds independently");
		check(stream.page(0, 0, 2).getAsJsonObject("coverage").get("total").getAsInt() == 130, "pinned flights survive sound eviction in paged history");
		check(stream.page(0, 0, 2).getAsJsonObject("coverage").get("gap").getAsBoolean(), "retained old flights do not hide a gap from routine event eviction");
		flight.addProperty("outcome", "dropped");
		stream.record(flight, 151, "minecraft:overworld");
		events = stream.snapshot(151, "minecraft:overworld").getAsJsonArray("events");
		check(events.size() == 8 && events.get(7).getAsJsonObject().get("outcome").getAsString().equals("dropped"), "new evidence replaces the same flight instead of accumulating contradictory outcomes");
		check(stream.page(0, 0, 2).getAsJsonObject("coverage").get("total").getAsInt() == 130, "same flight update does not consume another retained flight slot");
		JsonObject stable = stream.snapshot(151, "minecraft:overworld");
		check(stream.snapshot(200, "minecraft:overworld").equals(stable), "elapsed time alone leaves retained flight fields byte-stable");
		events = stream.snapshot(752, "minecraft:overworld").getAsJsonArray("events");
		check(events.asList().stream().noneMatch(row -> row.getAsJsonObject().has("flightId")), "quiet-world snapshot expires old flights against the clock");
		var bounded = new PlayerObservationEvents.Stream();
		for (int index = 0; index < 20; index++) {
			flight.addProperty("flightId", index);
			bounded.record(flight, 10 + index, "minecraft:overworld");
		}
		check(bounded.snapshot(30, "minecraft:overworld").getAsJsonArray("events").size() == PlayerObservationEvents.Stream.MAX_EYE_FLIGHTS, "independent flight memory is bounded");
		check(bounded.snapshot(30, "minecraft:the_nether").getAsJsonArray("events").isEmpty(), "dimension change expires prior-dimension flight memory");
		bounded.record(flight, 100, "minecraft:overworld");
		check(bounded.snapshot(1, "minecraft:overworld").getAsJsonArray("events").isEmpty(), "clock reset cannot make retained flights immortal");
		return 10;
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
