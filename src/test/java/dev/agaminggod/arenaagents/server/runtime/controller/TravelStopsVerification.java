package dev.agaminggod.arenaagents.server.runtime.controller;

import java.util.List;

/**
 * travel_to's hand-backs: which hostiles and which damage end a trip. Before this rule every new hostile within 16
 * and every hit (even 0.5 from a berry bush) handed the trip back, so a night trip became a long series of model turns.
 * The fixture replays one night trip's encounters, sampled every quarter second as the controller samples them, and
 * counts the hand-backs under the old rule and the new one.
 */
public final class TravelStopsVerification {
	private static int assertions;

	private TravelStopsVerification() {
	}

	public static void main(String[] arguments) {
		System.out.println("PASS: " + verify() + " travel stop assertions");
	}

	public static int verify() {
		assertions = 0;
		verifyHostiles();
		verifyDamage();
		verifyNightTrip();
		return assertions;
	}

	private static void verifyHostiles() {
		check(TravelStops.stopsFor(false, 5.9D, null, false, "minecraft:zombie"), "anything within 6 stops the trip, targeting or not");
		check(TravelStops.stopsFor(true, 4.0D, 6.5D, false, "minecraft:spider"), "a known one still stops it up close");
		check(!TravelStops.stopsFor(false, 12.0D, null, false, "minecraft:zombie"), "a zombie in view that is not after the body is passed");
		check(!TravelStops.stopsFor(false, 12.0D, null, true, "minecraft:zombie"), "the first sample of a targeting zombie waits for the next to judge closing");
		check(TravelStops.stopsFor(false, 11.5D, 12.0D, true, "minecraft:zombie"), "a targeting zombie closing in stops the trip");
		check(!TravelStops.stopsFor(false, 12.4D, 12.0D, true, "minecraft:zombie"), "a targeting zombie falling behind the sprint is passed");
		check(!TravelStops.stopsFor(false, 11.9D, 12.0D, true, "minecraft:zombie"), "drifting a tenth of a block nearer is not closing in");
		check(TravelStops.stopsFor(false, 14.0D, null, true, "minecraft:skeleton"), "a targeting skeleton stops it at once: it shoots from where it stands");
		check(!TravelStops.stopsFor(false, 14.0D, null, false, "minecraft:skeleton"), "a skeleton not targeting the body is passed");
		check(TravelStops.stopsFor(false, 9.0D, 10.0D, true, "minecraft:creeper"), "a creeper coming at the body stops the trip");
		check(!TravelStops.stopsFor(true, 9.0D, 10.0D, true, "minecraft:creeper"), "one known at the start stops it only up close, as before");
	}

	private static void verifyDamage() {
		check(TravelStops.shrugsOff("sweetBerryBush", false, 0.5F, 0.0F, 19.5F, 8.0F), "a berry-bush scratch is shrugged off");
		check(TravelStops.shrugsOff("cactus", false, 1.0F, 0.5F, 18.5F, 8.0F), "a cactus prick is shrugged off");
		check(TravelStops.shrugsOff("fall", false, 2.0F, 0.0F, 18.0F, 8.0F), "a short drop (2 damage) is shrugged off");
		check(!TravelStops.shrugsOff("fall", false, 3.0F, 0.0F, 17.0F, 8.0F), "a 3-damage fall hands back");
		check(!TravelStops.shrugsOff("sweetBerryBush", false, 1.0F, 3.5F, 15.0F, 8.0F), "past 4 shrugged off on the trip, it hands back");
		check(!TravelStops.shrugsOff("cactus", false, 1.0F, 0.0F, 8.0F, 8.0F), "never once health is at minHealth");
		check(!TravelStops.shrugsOff("mob", true, 0.5F, 0.0F, 19.5F, 8.0F), "any hit from a mob hands back");
		check(!TravelStops.shrugsOff("arrow", true, 1.0F, 0.0F, 19.0F, 8.0F), "an arrow hands back");
		for (String msgId : List.of("onFire", "inFire", "lava", "drown", "inWall", "hotFloor", "freeze", "magic"))
			check(!TravelStops.shrugsOff(msgId, false, 0.5F, 0.0F, 19.5F, 8.0F), msgId + " hands back however small");
		check(!TravelStops.shrugsOff(null, false, 0.5F, 0.0F, 19.5F, 8.0F), "an unknown source hands back");
	}

	/** One mob's distance at each quarter-second sample while it is in range, and whether it targets the body. */
	private record Track(String type, boolean targeting, double... distances) {
	}

	/**
	 * A night trip's encounters: two zombies that never notice the body, two that target it but fall behind the sprint,
	 * a spider crossing at a distance, a skeleton that targets it, a creeper that comes at it; then a berry bush, a cactus
	 * and a 2-damage drop. Before, each was a hand-back (10); now the skeleton and the creeper are (2).
	 */
	private static void verifyNightTrip() {
		List<Track> mobs = List.of(
				new Track("minecraft:zombie", false, 15.0D, 14.0D, 13.5D, 14.5D, 16.0D),
				new Track("minecraft:zombie", false, 12.0D, 11.0D, 10.5D, 11.0D),
				new Track("minecraft:zombie", true, 10.0D, 10.6D, 11.3D, 12.0D, 13.0D),
				new Track("minecraft:husk", true, 15.5D, 15.6D, 16.0D),
				new Track("minecraft:spider", false, 9.0D, 8.0D, 7.5D, 8.5D),
				new Track("minecraft:skeleton", true, 14.0D, 14.0D),
				new Track("minecraft:creeper", true, 11.0D, 10.2D, 9.4D));
		int before = 0, after = 0;
		for (Track mob : mobs) {
			boolean stoppedBefore = false, stoppedAfter = false;
			Double previous = null;
			for (double distance : mob.distances()) {
				// The rule before: any hostile new to the trip and in range handed back on its first sample.
				stoppedBefore = true;
				if (!stoppedAfter && TravelStops.stopsFor(false, distance, previous, mob.targeting(), mob.type())) stoppedAfter = true;
				previous = distance;
			}
			before += stoppedBefore ? 1 : 0;
			after += stoppedAfter ? 1 : 0;
		}
		float shrugged = 0.0F;
		float health = 20.0F;
		for (Object[] hit : new Object[][] { { "sweetBerryBush", 0.5F }, { "cactus", 1.0F }, { "fall", 2.0F } }) {
			float lost = (Float) hit[1];
			health -= lost;
			before++;
			if (TravelStops.shrugsOff((String) hit[0], false, lost, shrugged, health, 8.0F)) shrugged += lost;
			else after++;
		}
		check(before == 10, "the old rule handed this night trip back 10 times: " + before);
		check(after == 2, "the new rule hands it back twice (the skeleton and the creeper): " + after);
	}

	private static void check(boolean value, String reason) {
		if (!value) throw new AssertionError(reason);
		assertions++;
	}
}
