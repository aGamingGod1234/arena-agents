package dev.agaminggod.arenaagents.server.runtime.input;

/** Button-up for a control segment: stop movement, keeping shift until ordinary friction stops drift. */
public final class SneakSettling {
	public static final int MAX_TICKS = 10;
	private boolean started;
	private int ticks;
	private boolean settled;
	public boolean hold(boolean wasSneaking, double horizontalSpeed) {
		if (!started) {
			if (!wasSneaking) return false;
			started = true;
		}
		settled = horizontalSpeed < 0.003D;
		if (ticks >= MAX_TICKS || settled) return false;
		ticks++;
		return true;
	}
	public String describe() { return started ? "; sneak settling=" + ticks + " ticks (limit 10), settled=" + settled + ", movement/use/attack released" : ""; }
}
