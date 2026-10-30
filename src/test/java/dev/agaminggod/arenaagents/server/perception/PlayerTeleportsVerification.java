package dev.agaminggod.arenaagents.server.perception;

public final class PlayerTeleportsVerification {
	private PlayerTeleportsVerification() { }

	public static int verify() {
		int checks = 0;
		PlayerTeleports.Teleport first = PlayerTeleports.Teleport.next(null, 100L);
		checks += check(PlayerTeleports.recent(null, 100L) == null, "no teleport is not reported");
		checks += check(Long.valueOf(100L).equals(PlayerTeleports.recent(first, 100L)), "a teleport this tick is reported");
		checks += check(Long.valueOf(100L).equals(PlayerTeleports.recent(first, 100L + PlayerTeleports.REPORT_TICKS)), "a teleport is reported for the whole window");
		checks += check(PlayerTeleports.recent(first, 101L + PlayerTeleports.REPORT_TICKS) == null, "an old teleport is no longer reported");
		checks += check(PlayerTeleports.recent(first, 99L) == null, "a tick from another clock is not reported");
		// Review round 3: two repositions in one tick must not share a marker, or the second reads as walking.
		PlayerTeleports.Teleport second = PlayerTeleports.Teleport.next(first, 100L);
		PlayerTeleports.Teleport third = PlayerTeleports.Teleport.next(second, 100L);
		checks += check(Long.valueOf(101L).equals(PlayerTeleports.recent(second, 100L)), "a second teleport in the same tick gets the next mark, reported at once");
		checks += check(Long.valueOf(102L).equals(PlayerTeleports.recent(third, 100L)), "every further teleport in that tick is distinct too");
		checks += check(Long.valueOf(100L + PlayerTeleports.REPORT_TICKS + 1L).equals(PlayerTeleports.recent(PlayerTeleports.Teleport.next(third, 100L + PlayerTeleports.REPORT_TICKS + 1L), 100L + PlayerTeleports.REPORT_TICKS + 1L)), "a later tick reports its own tick again");
		checks += check(PlayerTeleports.recent(second, 101L + PlayerTeleports.REPORT_TICKS) == null, "the window follows the real tick, not the mark");
		return checks;
	}

	private static int check(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
		return 1;
	}
}
