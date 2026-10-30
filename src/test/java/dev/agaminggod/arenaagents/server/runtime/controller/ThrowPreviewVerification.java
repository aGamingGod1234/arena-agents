package dev.agaminggod.arenaagents.server.runtime.controller;

import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.Shapes;

public final class ThrowPreviewVerification {
	private ThrowPreviewVerification() { }
	public static int verify() {
		var start = new Vec3(0.5, 2.5, 0.5);
		ThrowPreview.Terrain ground = cell -> cell.getY() == 0 ? Shapes.block() : Shapes.empty();
		var flat = ThrowPreview.predict(ground, start, new Vec3(1.5, 0, 0), -64);
		check(flat.get("status").getAsString().equals("observed_impact"), "flat ground has a predicted collision");
		check(flat.getAsJsonObject("impactCell").get("y").getAsInt() == 0, "flat ground impact cell is the floor");
		check(flat.get("footing").getAsBoolean() && flat.get("headroom").getAsString().equals("clear"), "floor supports a standing body");
		check(flat.get("distance").getAsDouble() > 10 && flat.get("ticks").getAsInt() == 10, "flight uses vanilla gravity before inertia and movement");
		var voidFlight = ThrowPreview.predict(cell -> Shapes.empty(), start, new Vec3(1.5, 0, 0), -64);
		check(voidFlight.get("status").getAsString().equals("void") && !voidFlight.get("footing").getAsBoolean(), "known empty terrain ends in void without a fake landing");
		var wall = ThrowPreview.predict(cell -> cell.getX() == 3 ? Shapes.block() : Shapes.empty(), start, new Vec3(1.5, 0, 0), -64);
		check(wall.getAsJsonObject("impactCell").get("x").getAsInt() == 3 && wall.get("face").getAsString().equals("west"), "wall stops the swept trajectory before the nominal ground");
		check(!wall.get("footing").getAsBoolean() && wall.get("below").getAsString().equals("void"), "wall collision over void is not solid footing");
		// ThrownEnderpearl.onHit teleports to oldPosition(): the pearl's place when the striking tick began, in the air beside a
		// wall face, from where the thrower drops to whatever lies under it.
		var ledge = ThrowPreview.predict(cell -> cell.getX() == 3 || cell.getY() == -10 ? Shapes.block() : Shapes.empty(), start, new Vec3(1.5, 0, 0), -64);
		var arrival = ledge.getAsJsonObject("arrival");
		check(arrival.get("x").getAsDouble() < 3.0D - 0.5D, "arrival is where the pearl was before the striking tick, short of the face: " + ledge);
		check(ledge.get("footing").getAsBoolean() && ledge.get("below").getAsString().equals("solid")
				&& Math.abs(ledge.get("dropAfterArrival").getAsDouble() - (arrival.get("y").getAsDouble() + 9.0D)) < 0.11D,
				"a wall hit over a floor ten blocks down drops the thrower to it: " + ledge);
		var hidden = ThrowPreview.predict(cell -> cell.getX() >= 3 ? null : Shapes.empty(), start, new Vec3(1.5, 0, 0), -64);
		check(hidden.get("status").getAsString().equals("unknown_terrain") && !hidden.has("impactCell"), "unknown flight never invents an impact or footing");
		check(hidden.getAsJsonObject("unknownCell").get("x").getAsInt() == 3, "unknown frontier is identified");
		var ceiling = ThrowPreview.predict(cell -> cell.getY() == 0 || cell.getY() == 2 ? Shapes.block() : Shapes.empty(),
				new Vec3(0.5, 1.5, 0.5), new Vec3(1.5, -0.5, 0), -64);
		check(ceiling.get("headroom").getAsString().equals("blocked"), "solid landing beneath a low ceiling reports blocked headroom");
		// The End case: aimed at the island top (y54) 30 blocks out, the arc dips under its edge at y41, 6 blocks past the aim point.
		var shortThrow = new com.google.gson.JsonObject();
		var cell = new com.google.gson.JsonObject(); cell.addProperty("x", 64); cell.addProperty("y", 40); cell.addProperty("z", 0);
		shortThrow.add("impactCell", cell);
		ThrowPreview.addAimOffset(shortThrow, new Vec3(100.5, 50.6, 0.5), new Vec3(70.5, 54, 0.5));
		var offset = shortThrow.getAsJsonObject("aimOffset");
		check(offset.get("below").getAsLong() == 13 && offset.get("short").getAsLong() == -6, "a low impact past the aim point reports blocks below and a negative short: " + offset);
		var noImpact = new com.google.gson.JsonObject(); noImpact.addProperty("status", "void");
		ThrowPreview.addAimOffset(noImpact, Vec3.ZERO, new Vec3(1, 1, 1));
		check(!noImpact.has("aimOffset"), "a flight with no impact cell reports no aim offset");
		return 14;
	}
	private static void check(boolean value, String reason) { if (!value) throw new AssertionError(reason); }
}
