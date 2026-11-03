package dev.agaminggod.arenaagents.server.runtime.reflex;

import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import javax.tools.ToolProvider;

/** Executes LeaveFire's production afterburn dispatch and hold with a deterministic placement/recovery fixture. */
public final class LeaveFireDouseRecoveryVerification {
	private LeaveFireDouseRecoveryVerification() {
	}

	public static void main(String[] args) throws Exception {
		System.out.println("LeaveFire douse recovery: " + verify() + " scenarios passed");
	}

	public static int verify() throws Exception {
		// A Windows checkout gives Java sources CRLF line endings; the anchors below are written with \n.
		String source = Files.readString(Path.of("src/main/java/dev/agaminggod/arenaagents/server/runtime/reflex/ReflexActions.java")).replace("\r\n", "\n");
		String leaveFire = source.substring(source.indexOf("static final class LeaveFire"));
		String dispatch = between(leaveFire, "\t\t\tif (afterburn != null) {", "\t\t\tif (walk != null && hazard.equals");
		String hold = between(leaveFire, "\t\tprivate Step holdBurning(", "\n\t\t/**\n\t\t * The exit among");
		Path directory = Files.createTempDirectory("leave-fire-douse-regression-");
		try {
			Path fixture = directory.resolve("DouseRecoveryFixture.java");
			Files.writeString(fixture, FIXTURE.replace("/* DISPATCH */", dispatch).replace("/* HOLD */", hold));
			int result = ToolProvider.getSystemJavaCompiler().run(null, null, null, "-d", directory.toString(), fixture.toString());
			if (result != 0) throw new AssertionError("production control-flow fixture did not compile: " + result);
			try (URLClassLoader loader = new URLClassLoader(new java.net.URL[] { directory.toUri().toURL() })) {
				try {
					return (Integer) loader.loadClass("DouseRecoveryFixture").getMethod("verify").invoke(null);
				} catch (java.lang.reflect.InvocationTargetException failure) {
					throw new AssertionError("production control-flow regression", failure.getCause());
				}
			}
		} finally {
			try (var paths = Files.walk(directory)) {
				for (Path path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.delete(path);
			}
		}
	}

	private static String between(String source, String start, String end) {
		int from = source.indexOf(start);
		int to = source.indexOf(end, from);
		if (from < 0 || to < 0) throw new AssertionError("production extraction anchors changed");
		return source.substring(from, to);
	}

	private static final String FIXTURE = """
			import java.util.function.Consumer;
			public class DouseRecoveryFixture {
			 enum Status { RUNNING, DONE, FAILED }
			 static class ReflexScheduler {
			  static class ActionStatus { static final Status RUNNING = Status.RUNNING; }
			 }
			 record Step(Status status, String detail) {
			  static Step running(String detail) { return new Step(Status.RUNNING, detail); }
			  static Step done(String detail) { return new Step(Status.DONE, detail); }
			 }
			 enum InteractionHand { MAIN_HAND }
			 record AgentInputState(float forward, float strafe, boolean jump, boolean sneak, boolean sprint,
			     boolean attack, boolean use, float yaw, float pitch, int slot, InteractionHand hand) {}
			 static class ServerPlayer {
			  boolean burning = true, safe = true, bucket = true;
			  boolean isOnFire() { return burning; }
			  float getYRot() { return 0; }
			  float getXRot() { return 0; }
			  ServerPlayer getInventory() { return this; }
			  int getSelectedSlot() { return 0; }
			 }
			 record Context(ServerPlayer player) {}
			 // Water physics and Place are stubbed. Its first tick places; later ticks aim and then scoop.
			 static class Place {
			  int calls;
			  boolean source;
			  Status finish = Status.DONE;
			  Place(String item, String where) {}
			  Step tick(Context context, Consumer<AgentInputState> input) {
			   calls++;
			   if (calls == 1) { source = true; return Step.running("placed water below; landing"); }
			   if (calls == 2) return Step.running("landed; aiming at the placed water");
			   if (finish == Status.DONE) source = false;
			   return new Step(finish, finish == Status.DONE ? "scooped it back" : "recovery failed");
			  }
			 }
			 Place douse;
			 boolean doused;
			 String afterburn;
			 Object walk = new Object();
			 static final String WATER_BUCKET = "minecraft:water_bucket";
			 static boolean canDouse(ServerPlayer player) { return player.bucket; }
			 static boolean safeFooting(ServerPlayer player) { return player.safe; }
			 static String burnRemaining(ServerPlayer player) { return "; burning"; }
			 /* HOLD */
			 Step tick(Context context, Consumer<AgentInputState> input) {
			  ServerPlayer player = context.player();
			  /* DISPATCH */
			  return Step.running("escape hazard");
			 }
			 static void check(boolean condition, String message) {
			  if (!condition) throw new AssertionError(message);
			 }
			 public static int verify() {
			  Consumer<AgentInputState> input = state -> {};
			  var player = new ServerPlayer();
			  var context = new Context(player);
			  var action = new DouseRecoveryFixture();
			  check(action.holdBurning("out of fire", context, player, input).status() == Status.RUNNING, "place starts");
			  Place recovery = action.douse;
			  player.burning = false; // Water contact extinguishes between server ticks.
			  check(action.tick(context, input).status() == Status.RUNNING, "extinguished player must finish aiming before completion");
			  check(recovery.calls == 2 && recovery.source, "active recovery gets the next tick");
			  check(action.tick(context, input).status() == Status.DONE, "complete once scooped");
			  check(recovery.calls == 3 && !recovery.source && action.douse == null, "source recovered before completion");

			  action = new DouseRecoveryFixture();
			  player.burning = true;
			  action.holdBurning("out of lava", context, player, input);
			  recovery = action.douse;
			  player.burning = false;
			  player.safe = false;
			  check(action.tick(context, input).detail().equals("escape hazard"), "renewed hazard takes priority over recovery");
			  check(recovery.calls == 1 && action.afterburn == null && action.walk == null, "escape clears stale footing without scooping");

			  action = new DouseRecoveryFixture();
			  player.safe = true;
			  action.afterburn = "out of fire";
			  check(action.tick(context, input).status() == Status.DONE && action.douse == null, "no active recovery completes immediately when extinguished");

			  action = new DouseRecoveryFixture();
			  player.burning = true;
			  player.bucket = false;
			  action.holdBurning("out of fire", context, player, input);
			  check(action.tick(context, input).status() == Status.RUNNING && action.douse == null, "burn without bucket still holds footing");

			  for (boolean stillBurning : new boolean[] {false, true}) {
			   action = new DouseRecoveryFixture();
			   player.burning = true;
			   player.bucket = true;
			   action.holdBurning("out of fire", context, player, input);
			   recovery = action.douse;
			   recovery.finish = Status.FAILED;
			   player.burning = stillBurning;
			   check(action.tick(context, input).status() == Status.RUNNING, "recovery failure fixture first aims");
			   check(action.tick(context, input).status() == (stillBurning ? Status.RUNNING : Status.DONE), "failed recovery preserves burn hold policy");
			   check(action.douse == null && action.doused, "terminal recovery is cleared and tried only once");
			  }
			  return 6;
			 }
			}
			""";
}
