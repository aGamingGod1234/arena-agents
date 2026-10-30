package dev.agaminggod.arenaagents.server.runtime.controller;

import java.util.List;
import net.minecraft.world.phys.Vec3;

public final class HazardExitsVerification {
	private HazardExitsVerification() {
	}

	public static void main(String[] arguments) {
		System.out.println("PASS: " + verify() + " hazard exit assertions");
	}

	public static int verify() {
		int assertions = 0;
		for (var campfire : List.of(net.minecraft.world.level.block.Blocks.CAMPFIRE, net.minecraft.world.level.block.Blocks.SOUL_CAMPFIRE)) {
			var state = campfire.defaultBlockState();
			assertTrue(HazardExits.hazard(state.setValue(net.minecraft.world.level.block.state.properties.BlockStateProperties.LIT, true)) == HazardExits.Cell.HOT,
					"a lit campfire is hot ground");
			assertTrue(HazardExits.hazard(state.setValue(net.minecraft.world.level.block.state.properties.BlockStateProperties.LIT, false)) == null,
					"an extinguished campfire does not trigger hot-floor contact");
			assertions += 2;
		}

		// A 3x3 lava pool on a stone floor (y65). West of it is open ground at the pool's level; east is a wall one
		// block high (a step up); a pillar stands at (0,66,-2) north of the body.
		HazardExits.Cells pool = (x, y, z) -> {
			if (y <= 65) return HazardExits.Cell.SOLID;
			if (y == 66 && Math.abs(x) <= 1 && Math.abs(z) <= 1) return HazardExits.Cell.LAVA;
			if (y == 66 && x >= 2) return HazardExits.Cell.SOLID;
			if (x == 0 && z == -2 && y <= 67) return HazardExits.Cell.SOLID;
			return HazardExits.Cell.OPEN;
		};
		Vec3 body = new Vec3(0.5D, 66.2D, 0.5D);
		List<HazardExits.Exit> exits = HazardExits.scan(pool, body, 0.0F);
		assertTrue(!exits.isEmpty() && exits.size() <= HazardExits.MAX_EXITS, "a body in a pool gets up to four exits");
		assertions++;
		assertTrue(exits.stream().map(HazardExits.Exit::direction).distinct().count() == exits.size(), "at most one exit per direction");
		assertions++;
		HazardExits.Exit west = exits.stream().filter(exit -> exit.x() == -2 && exit.z() == 0).findFirst().orElse(null);
		assertTrue(west != null, "open ground beyond the pool edge is an exit");
		assertions++;
		assertEquals("right", west.direction(), "facing south, west is on the right");
		assertions++;
		assertEquals(0, west.up(), "level ground needs no step up");
		assertions++;
		assertEquals(1, west.lavaCells(), "the pool cell between the body and the edge is counted");
		assertions++;
		assertEquals("right 2.0m 1lava (-2,66,0)", HazardExits.describe(west), "compact exit text");
		assertions++;
		// A 1x1 lava hole one block deep: every way out is a step up, and the cells beyond the rim are behind it.
		HazardExits.Cells hole = (x, y, z) -> {
			if (y <= 65) return HazardExits.Cell.SOLID;
			if (y == 66) return x == 0 && z == 0 ? HazardExits.Cell.LAVA : HazardExits.Cell.SOLID;
			return HazardExits.Cell.OPEN;
		};
		List<HazardExits.Exit> rim = HazardExits.scan(hole, body, 0.0F);
		assertEquals(4, rim.size(), "a hole offers its four nearest rim cells");
		assertions++;
		assertTrue(rim.stream().allMatch(exit -> exit.up() == 1 && exit.y() == 67 && exit.lavaCells() == 0), "every rim exit is a step up");
		assertions++;
		assertTrue(rim.stream().anyMatch(exit -> "left 1.0m up1 (1,67,0)".equals(HazardExits.describe(exit))), "a step up is named");
		assertions++;
		assertTrue(exits.stream().noneMatch(exit -> exit.x() == 0 && exit.z() == -3),
				"a cell behind a wall at body height is not offered as a straight-line exit");
		assertions++;
		for (int index = 1; index < exits.size(); index++) {
			assertTrue(HazardExits.cost(exits.get(index - 1)) <= HazardExits.cost(exits.get(index)), "exits are cheapest first");
			assertions++;
		}
		assertTrue(!HazardExits.standable(pool, 0, 66, 0), "a lava cell is not standable");
		assertions++;
		assertTrue(!HazardExits.standable((x, y, z) -> y <= 65 || y == 67 ? HazardExits.Cell.SOLID : HazardExits.Cell.OPEN, 3, 66, 0),
				"a cell without head room is not standable");
		assertions++;
		assertTrue(!HazardExits.standable((x, y, z) -> y <= 65 ? HazardExits.Cell.HOT : HazardExits.Cell.OPEN, 3, 66, 0),
				"magma or a campfire is not a safe floor");
		assertions++;
		HazardExits.Cells sea = (x, y, z) -> y <= 65 ? HazardExits.Cell.SOLID : y == 66 ? HazardExits.Cell.LAVA : HazardExits.Cell.OPEN;
		assertTrue(HazardExits.scan(sea, body, 0.0F).isEmpty(), "a lava sea wider than the scan has no exits");
		assertions++;
		assertEquals("none seen within 3 blocks", HazardExits.describe(List.of()), "no exits is said plainly");
		assertions++;

		// Review r1 P1-1: only seen cells certify an exit. West of the body was never seen.
		HazardExits.Cells halfSeen = (x, y, z) -> x < 0 ? HazardExits.Cell.UNKNOWN : pool.at(x, y, z);
		assertTrue(HazardExits.scan(halfSeen, body, 0.0F).stream().noneMatch(exit -> exit.x() < 0), "an unseen floor or head room is no exit");
		assertions++;
		// The floor and head room are seen, but a cell on the way is not: the exit is named with that said.
		HazardExits.Cells hiddenPath = (x, y, z) -> x == -1 && z == 0 && y >= 65 ? HazardExits.Cell.UNKNOWN : pool.at(x, y, z);
		HazardExits.Exit hidden = HazardExits.scan(hiddenPath, body, 0.0F).stream().filter(exit -> exit.x() == -2 && exit.z() == 0).findFirst().orElse(null);
		assertTrue(hidden != null && hidden.unseen(), "a partly unseen line is flagged");
		assertions++;
		assertEquals("right 2.0m unseen (-2,66,0)", HazardExits.describe(hidden), "unseen is named in the exit text");
		assertions++;

		// Review r2 P2-1: cells seen 3 s ago (the player has since turned away) give an exit that says it is remembered.
		HazardExits.Cells remembered = new HazardExits.Cells() {
			@Override
			public HazardExits.Cell at(int x, int y, int z) {
				return pool.at(x, y, z);
			}

			@Override
			public int secondsSinceSeen(int x, int y, int z) {
				return x < 0 ? 3 : 0;
			}
		};
		List<HazardExits.Exit> recalled = HazardExits.scan(remembered, body, 0.0F);
		HazardExits.Exit westRemembered = recalled.stream().filter(exit -> exit.x() == -2 && exit.z() == 0).findFirst().orElse(null);
		assertEquals("right 2.0m 1lava remembered 3s (-2,66,0)", westRemembered == null ? null : HazardExits.describe(westRemembered),
				"an exit on remembered cells names their age");
		assertions++;
		assertTrue(recalled.stream().filter(exit -> exit.x() > 0).allMatch(exit -> exit.seenAgoS() == 0), "an exit seen now carries no age");
		assertions++;

		// Review r1 P2-1 fixture: lava at the body, stone under the body and at x=3 only; columns 1 and 2 have no floor.
		HazardExits.Cells islands = (x, y, z) -> y == 65 && x == 0 && z == 0 ? HazardExits.Cell.LAVA
				: y == 64 && (x == 0 && z == 0 || x == 3 && z == 0) ? HazardExits.Cell.SOLID : HazardExits.Cell.OPEN;
		List<HazardExits.Exit> across = HazardExits.scan(islands, new Vec3(0.5D, 65.0D, 0.5D), 0.0F);
		assertEquals("left 3.0m 2gap (3,65,0)", HazardExits.describe(across), "a landing across a shaft names the gap");
		assertions++;
		HazardExits.Cells diagonal = (x, y, z) -> y == 64 && x == 3 && z == 3 ? HazardExits.Cell.SOLID : HazardExits.Cell.OPEN;
		assertTrue(HazardExits.scan(diagonal, new Vec3(0.5D, 65.0D, 0.5D), 0.0F).isEmpty(), "a cell 4.2 blocks away is outside the 3-block radius");
		assertions++;
		// Two blocks touching only at a corner leave no room for a 0.6-wide body to walk between them.
		HazardExits.Cells corner = (x, y, z) -> {
			if (y <= 65) return HazardExits.Cell.SOLID;
			if (y <= 67 && (x == 1 && z == 0 || x == 0 && z == 1)) return HazardExits.Cell.SOLID;
			return HazardExits.Cell.OPEN;
		};
		assertTrue(HazardExits.scan(corner, new Vec3(0.5D, 66.0D, 0.5D), 0.0F).stream().noneMatch(exit -> exit.x() == 1 && exit.z() == 1),
				"the swept body cannot pass between corner-touching blocks");
		assertions++;
		// A sunk body can remember a landing above the old one-block step range. This is a landing, not a walk route.
		HazardExits.Cells raised = (x, y, z) -> x == 1 && z == 0 && y == 68 ? HazardExits.Cell.SOLID
				: y < 69 ? HazardExits.Cell.LAVA : HazardExits.Cell.OPEN;
		HazardExits.Exit high = HazardExits.scan(raised, new Vec3(0.5D, 66.0D, 0.5D), 0.0F).stream()
				.filter(exit -> exit.x() == 1 && exit.y() == 69 && exit.z() == 0).findFirst().orElse(null);
		assertTrue(high != null && high.up() == 3 && high.unseen(), "a known higher landing is reported without claiming a route");
		assertions++;
		assertTrue(HazardExits.describe(high).contains("up3 landing"), "a higher landing says its actual height, never up1");
		assertions++;
		HazardExits.Cells overhead = (x, y, z) -> x == 0 && z == 0 && y == 67 ? HazardExits.Cell.SOLID
				: y < 68 ? HazardExits.Cell.LAVA : HazardExits.Cell.OPEN;
		assertTrue(HazardExits.scan(overhead, body, 0.0F).stream().anyMatch(exit -> exit.x() == 0 && exit.z() == 0 && exit.up() == 2),
				"a landing directly above is not lost by the horizontal-origin exclusion");
		assertions++;
		HazardExits.Cells distant = new HazardExits.Cells() {
			@Override
			public HazardExits.Cell at(int x, int y, int z) {
				return x == -5 && z == 0 && y == 75 ? HazardExits.Cell.SOLID
						: x == -5 && z == 0 && (y == 76 || y == 77) ? HazardExits.Cell.OPEN : HazardExits.Cell.UNKNOWN;
			}
			@Override
			public long[] rememberedPositions() {
				return new long[] { net.minecraft.core.BlockPos.asLong(-5, 76, 0) };
			}
			@Override
			public int recalledAge(int x, int y, int z) {
				return 7;
			}
		};
		List<HazardExits.Exit> distantExits = HazardExits.scan(distant, body, -90.0F);
		assertEquals("back 5.0m up10 landing route unknown remembered 7s (-5,76,0)", HazardExits.describe(distantExits),
				"a lake reports a remembered landing up and back, not an unseen shore or a jumpable step");
		assertions++;
		HazardExits.Cells blockedLanding = new HazardExits.Cells() {
			@Override
			public HazardExits.Cell at(int x, int y, int z) {
				if (x == 1 && z == 0 && y >= 65 && y <= 70) return HazardExits.Cell.SOLID;
				if (x == 2 && z == 0 && y == 65) return HazardExits.Cell.SOLID;
				if (x == 2 && z == 0 && (y == 66 || y == 67)) return HazardExits.Cell.OPEN;
				return HazardExits.Cell.UNKNOWN;
			}
			@Override
			public long[] rememberedPositions() {
				return new long[] { net.minecraft.core.BlockPos.asLong(2, 66, 0) };
			}
		};
		assertTrue(HazardExits.scan(blockedLanding, body, 0.0F).isEmpty(),
				"a known wall-blocked local landing cannot reappear through recall as an unseen path");
		assertions++;
		assertEquals("back 5.0m up10 landing route unknown (-5,76,0)", HazardExits.describe(new HazardExits.Exit(
				-5, 76, 0, "back", 5.0D, 10, 0, 0, true, 0)),
				"a current landing keeps route uncertainty separate from remembered terrain");
		assertions++;
		HazardExits.Cells belowBody = new HazardExits.Cells() {
			@Override
			public HazardExits.Cell at(int x, int y, int z) {
				if (x != 0 || z != 0) return HazardExits.Cell.UNKNOWN;
				return y == 63 ? HazardExits.Cell.SOLID : y == 64 || y == 65 ? HazardExits.Cell.OPEN : HazardExits.Cell.UNKNOWN;
			}
			@Override
			public long[] rememberedPositions() {
				return new long[] { net.minecraft.core.BlockPos.asLong(0, 64, 0) };
			}
			@Override
			public int recalledAge(int x, int y, int z) {
				return 2;
			}
		};
		assertEquals("below 0.0m down2 landing route unknown remembered 2s (0,64,0)",
				HazardExits.describe(HazardExits.scan(belowBody, body, 0.0F)), "a remembered own-column landing says below, not front");
		assertions++;
		assertEquals("above 0.0m up2 landing route unknown (0,68,0)",
				HazardExits.describe(HazardExits.scan(overhead, body, 90.0F)), "a vertical landing's label does not depend on facing");
		assertions++;
		return assertions;
	}

	private static void assertTrue(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
	}

	private static void assertEquals(Object expected, Object actual, String label) {
		if (!java.util.Objects.equals(expected, actual)) {
			throw new AssertionError(label + ": expected <" + expected + "> but was <" + actual + ">");
		}
	}
}
