package dev.agaminggod.arenaagents.server.runtime;

import java.util.Collections;
import java.util.List;
import net.minecraft.world.phys.Vec3;

public final class ActionResultFactsVerification {
	private ActionResultFactsVerification() {
	}

	public static int verify() {
		String row = ActionResultFacts.dropRow("drop-id", "minecraft:oak_log", 3);
		assertEquals("drop-id 3 minecraft:oak_log", row, "visible candidate includes UUID, count and item identity");
		assertEquals("; seen: " + row, ActionResultFacts.dropSummary(List.of(row)), "visible candidates do not assert a merger chain");
		assertEquals("", ActionResultFacts.dropSummary(List.of()), "an empty candidate scan adds no payload or unseen loot claim");
		assertEquals(true, ActionResultFacts.dropRow("drop-id", "minecraft:oak_log", 1).equals("drop-id 1 minecraft:oak_log"), "candidate rows omit transient coordinates and a landing claim");
		String bounded = ActionResultFacts.dropSummary(Collections.nCopies(100, row));
		assertEquals(true, bounded.length() < 1_100 && bounded.contains("more seen"), "terminal budget keeps complete identities and reports omitted visible rows");
		Vec3 target = new Vec3(0.5D, 64D, 0.5D);
		Vec3 near = new Vec3(1.5D, 64D, 0.5D);
		Vec3 far = new Vec3(2.5D, 64D, 0.5D);
		assertEquals(near, ActionResultFacts.nearestCell(target, cell -> cell.equals(near) || cell.equals(far)), "nearest seen standing cell is selected by distance");
		assertEquals(far, ActionResultFacts.nearestCell(target, far::equals), "an unseen nearer cell is never suggested");
		assertEquals(null, ActionResultFacts.nearestCell(target, ignored -> false), "unseen or unsupported terrain gives no invented destination");
		assertEquals(null, ActionResultFacts.nearestCell(target, new Vec3(3.5D, 64D, 3.5D)::equals), "the stated horizontal search radius excludes diagonal cells beyond it");
		assertEquals(null, ActionResultFacts.nearestCell(target, new Vec3(0.5D, 66D, 0.5D)::equals), "the stated vertical search radius is honoured");
		assertEquals("10,64,0.5", ActionResultFacts.coordinates(new Vec3(10D, 64D, 0.5D)), "coordinate compaction removes only fractional padding");
		assertEquals("-4.75,64.12,-0.25", ActionResultFacts.coordinates(new Vec3(-4.751D, 64.124D, -0.25D)), "coordinate compaction preserves the existing two-decimal rounding and signs");
		assertEquals("Drop not visible", ActionResultFacts.unavailableDropMessage(""), "empty local scan makes no claim about distant or nonmatching drops");
		assertEquals("Drop not visible; seen: " + row, ActionResultFacts.unavailableDropMessage(ActionResultFacts.dropSummary(List.of(row))), "candidates remain alternatives without a merger assertion");
		assertEquals("Seen obstruction", ActionResultFacts.destinationMessage("NO_STANDABLE_PATH", "Destination has no supported arrival region that can be approached within the requested tolerance", "Seen obstruction"), "specific occupancy replaces redundant generic arrival prose");
		assertEquals("Seen frontier; Seen obstruction", ActionResultFacts.destinationMessage("REACHED_FRONTIER", "Seen frontier", "Seen obstruction"), "frontier reason is retained alongside occupancy");
		assertEquals("No seen route; Seen obstruction", ActionResultFacts.destinationMessage("NO_SEEN_ROUTE", "No seen route", "Seen obstruction"), "future no-seen-route result retains navigation feedback");
		assertEquals("Generic failure", ActionResultFacts.destinationMessage("NO_PATH", "Generic failure", ""), "unseen destinations supply no new facts");
		assertEquals("Start unsupported; Seen obstruction", ActionResultFacts.destinationMessage("NO_STANDABLE_PATH", "Start unsupported", "Seen obstruction"), "a failure at the starting cell is retained");
		assertEquals("Seen obstruction; magma", ActionResultFacts.destinationMessage("NO_STANDABLE_PATH", "Destination has no supported arrival region that can be approached within the requested tolerance; magma", "Seen obstruction"), "arrival hazard details survive prose compaction");
		return 20 + FailureBlockerVerification.verify() + dev.agaminggod.arenaagents.server.runtime.controller.AcquiredResultTerrainVerification.verify();
	}

	private static void assertEquals(Object expected, Object actual, String message) {
		if (!java.util.Objects.equals(expected, actual)) throw new AssertionError(message + " expected=" + expected + " actual=" + actual);
	}
}
