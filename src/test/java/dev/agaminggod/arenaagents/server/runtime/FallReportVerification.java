package dev.agaminggod.arenaagents.server.runtime;

/**
 * Wave-2 drop-ahead: an action result says the fall that happened while it ran. In final-3 a 40-tick forward jump
 * dropped the body 9 blocks for 7 health and its result read only "Control segment completed".
 */
public final class FallReportVerification {
	private static int assertions;

	private FallReportVerification() {
	}

	public static void main(String[] args) {
		System.out.println("FallReportVerification: " + verify() + " assertions passed");
	}

	public static int verify() {
		assertions = 0;
		verifyMixedLandings();
		verifyHurtfulFall();
		verifyHarmlessMoves();
		verifyFluidAndSources();
		return assertions;
	}

	/** Stands at {@code from}, falls through the air, lands at {@code to} losing {@code damage} to the fall. */
	private static void fall(FallReport report, double from, double to, float health, float damage, String fluid) {
		report.observe(from, true, null, health, false);
		for (double y = from - 1.0D; y > to; y -= 1.0D) report.observe(y, false, null, health, false);
		report.observe(to, fluid == null, fluid, health - damage, damage > 0.0F);
	}

	private static void verifyHurtfulFall() {
		FallReport report = new FallReport();
		fall(report, 81.0D, 72.0D, 20.0F, 7.0F, null);
		check("; fell 9 blocks; fall HP sum 7.0".equals(report.describe()), "a 9-block fall and its damage: " + report.describe());
		// Damage that shows on the tick after landing still counts while the last hurt is the fall.
		FallReport late = new FallReport();
		fall(late, 81.0D, 72.0D, 20.0F, 0.0F, null);
		late.observe(72.0D, true, null, 13.0F, true);
		check("; fell 9 blocks; fall HP sum 7.0".equals(late.describe()), "damage a tick after landing: " + late.describe());
		FallReport two = new FallReport();
		fall(two, 81.0D, 76.0D, 20.0F, 2.0F, null);
		fall(two, 76.0D, 66.0D, 18.0F, 7.0F, null);
		check("; fell 10 blocks; fall HP sum 9.0".equals(two.describe()), "the worst drop and the total fall damage: " + two.describe());
	}

	private static void verifyHarmlessMoves() {
		FallReport jump = new FallReport();
		jump.observe(81.0D, true, null, 20.0F, false);
		jump.observe(82.2D, false, null, 20.0F, false);
		jump.observe(81.0D, true, null, 20.0F, false);
		check(jump.describe().isEmpty(), "a jump back to the same ground adds nothing");
		FallReport step = new FallReport();
		fall(step, 81.0D, 78.0D, 20.0F, 0.0F, null);
		check(step.describe().isEmpty(), "a 3-block drop does no damage and adds nothing");
		FallReport midair = new FallReport();
		midair.observe(90.0D, false, null, 20.0F, false);
		midair.observe(70.0D, true, null, 20.0F, false);
		check(midair.describe().isEmpty(), "a fall begun before the action started has no known ground to measure from");
	}

	private static void verifyFluidAndSources() {
		FallReport water = new FallReport();
		fall(water, 81.0D, 71.0D, 20.0F, 0.0F, "water");
		check("; fell 10 blocks into water".equals(water.describe()), "a fall into water is named without damage: " + water.describe());
		FallReport arrow = new FallReport();
		arrow.observe(81.0D, true, null, 20.0F, false);
		arrow.observe(80.0D, false, null, 16.0F, false);
		arrow.observe(79.0D, true, null, 16.0F, false);
		check(arrow.describe().isEmpty(), "health lost to something else is not called fall damage");
		FallReport bump = new FallReport();
		bump.observe(81.0D, true, null, 20.0F, false);
		bump.observe(81.0D, true, null, 19.0F, true);
		check("; fall HP sum 1.0".equals(bump.describe()), "fall damage without a measured hurtful drop is still said: " + bump.describe());
	}

	private static void verifyMixedLandings() {
		FallReport report = new FallReport();
		fall(report, 81.0D, 72.0D, 20.0F, 7.0F, null);
		fall(report, 72.0D, 62.0D, 13.0F, 0.0F, "water");
		check("; fell 10 blocks into water; fall HP sum 7.0".equals(report.describe()),
				"the water landing and action's total fall damage are separate facts: " + report.describe());
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
