package dev.agaminggod.arenaagents.server.perception;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class PortalFrameSightVerification {
	private PortalFrameSightVerification() {
	}

	public static int verify() {
		int passed = 0;
		PortalFrameSight.Cell eye = new PortalFrameSight.Cell(110, 65, 690);

		// A complete 2x3 interior frame in the plane z=693, interior from x=111..112, y=64..66.
		List<PortalFrameSight.Cell> full = frame(true, 111, 64, 693, 2, 3);
		Map<PortalFrameSight.Cell, String> world = new HashMap<>();
		PortalFrameSight.Fit fit = PortalFrameSight.best(full, sight(world, "air"), eye);
		passed += check(fit != null && fit.alongX() && fit.x() == 111 && fit.y() == 64 && fit.z() == 693, "complete frame fits its interior corner");
		passed += check(fit.obsidian() == 10 && fit.needed() == 10 && fit.missing().isEmpty() && fit.blocked().isEmpty(), "complete frame has nothing missing");

		// Bottom two and the left pillar: the rest is missing and says what is seen there.
		ArrayList<PortalFrameSight.Cell> partial = new ArrayList<>(List.of(
				new PortalFrameSight.Cell(111, 63, 693), new PortalFrameSight.Cell(112, 63, 693),
				new PortalFrameSight.Cell(110, 64, 693), new PortalFrameSight.Cell(110, 65, 693), new PortalFrameSight.Cell(110, 66, 693)));
		world.put(new PortalFrameSight.Cell(113, 64, 693), "lava source");
		world.put(new PortalFrameSight.Cell(112, 65, 693), "cobblestone");
		fit = PortalFrameSight.best(partial, sight(world, null), eye);
		passed += check(fit != null && fit.obsidian() == 5 && fit.missing().size() == 5, "partial frame lists five missing cells");
		passed += check(fit.missing().stream().anyMatch(c -> (int) c[0] == 113 && (int) c[1] == 64 && "lava source".equals(c[3])), "missing cell shows its seen lava");
		passed += check(fit.missing().stream().anyMatch(c -> "unseen".equals(c[3])), "unseen missing cells are not guessed");
		passed += check(fit.blocked().size() == 1 && "cobblestone".equals(fit.blocked().getFirst()[3]), "interior blocker reported");
		passed += check(fit.unseenInterior() == 5, "unseen interior cells counted");

		// A cooled pool: one flat obsidian sheet is not a frame.
		ArrayList<PortalFrameSight.Cell> sheet = new ArrayList<>();
		for (int x = 116; x <= 120; x++) for (int z = 695; z <= 699; z++) sheet.add(new PortalFrameSight.Cell(x, 63, z));
		passed += check(PortalFrameSight.best(sheet, sight(new HashMap<>(), "air"), eye) == null, "flat obsidian sheet is no frame");

		// A frame along z (plane x=120).
		fit = PortalFrameSight.best(frame(false, 700, 70, 120, 2, 3), sight(new HashMap<>(), "air"), eye);
		passed += check(fit != null && !fit.alongX() && fit.x() == 120 && fit.z() == 700 && fit.missing().isEmpty(), "frame along z fits");

		// A lit portal.
		Map<PortalFrameSight.Cell, String> lit = new HashMap<>();
		for (int y = 64; y <= 66; y++) for (int x = 111; x <= 112; x++) lit.put(new PortalFrameSight.Cell(x, y, 693), "nether_portal");
		fit = PortalFrameSight.best(full, sight(lit, "air"), eye);
		passed += check(fit.lit() && fit.blocked().isEmpty(), "portal blocks mark the frame lit");

		// Two obsidian are not enough to name a frame.
		passed += check(PortalFrameSight.best(List.of(new PortalFrameSight.Cell(111, 63, 693), new PortalFrameSight.Cell(110, 64, 693)),
				sight(new HashMap<>(), "air"), eye) == null, "two obsidian are no frame");
		return passed;
	}

	private static List<PortalFrameSight.Cell> frame(boolean alongX, int u, int y, int plane, int width, int height) {
		return PortalFrameSight.frameCells(alongX, u, y, plane, width, height);
	}

	private static PortalFrameSight.Sight sight(Map<PortalFrameSight.Cell, String> world, String fallback) {
		return cell -> world.getOrDefault(cell, fallback);
	}

	private static int check(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
		return 1;
	}
}
