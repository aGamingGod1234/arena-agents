package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonObject;
import java.util.Map;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.projectile.EyeOfEnder;
import net.minecraft.world.phys.Vec3;

/**
 * Remembers what the thrower saw of their own eye of ender: where it was thrown from, where it was last seen and how it
 * ended. A player simply watches the four-second flight; the model may still be thinking, so the sight becomes one
 * perception event on its next wake. Only seen positions are kept; the eye's hidden target is never read.
 */
public final class EyeFlightObservation {
	private static final String[] COMPASS = { "south", "southwest", "west", "northwest", "north", "northeast", "east", "southeast" };
	private static final int MAX_TRACKED_FLIGHTS = 128;
	private static final Map<EyeOfEnder, Flight> FLIGHTS = new java.util.LinkedHashMap<>();
	private static final Map<java.util.UUID, BearingLines> LINES = new java.util.HashMap<>();

	private EyeFlightObservation() { }

	public static void register() {
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents.END_SERVER_TICK.register(server -> {
			var iterator = FLIGHTS.entrySet().iterator();
			while (iterator.hasNext()) {
				var entry = iterator.next();
				EyeOfEnder eye = entry.getKey();
				Flight flight = entry.getValue();
				if (eye.level().getServer() != server) continue;
				long now = eye.level().getGameTime();
				if (flight.player.isRemoved() || !flight.player.isAlive() || flight.player.level() != eye.level()
						|| now < flight.thrownAt || now - flight.thrownAt > PlayerObservationEvents.Stream.EYE_FLIGHT_PIN_TICKS) {
					iterator.remove();
					continue;
				}
				// Removal need not run the eye's tick tail, for example when its chunk unloads.
				if (eye.isRemoved() && !flight.ended) {
					flight.ended = true;
					publish(eye, flight);
				}
				if (flight.drop != null && !flight.drop.isRemoved() && visible(flight.player, flight.drop)) {
					flight.facts.dropped(flight.drop.position(), true, flight.drop.onGround());
					publish(eye, flight);
				}
			}
		});
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents.SERVER_STOPPED.register(server -> {
			FLIGHTS.entrySet().removeIf(entry -> entry.getKey().level().getServer() == server);
			LINES.clear();
		});
	}

	public static void thrown(ServerPlayer player, EyeOfEnder eye) {
		FLIGHTS.put(eye, new Flight(player, eye.position()));
		while (FLIGHTS.size() > MAX_TRACKED_FLIGHTS) FLIGHTS.remove(FLIGHTS.keySet().iterator().next());
	}

	/** The item identity associates later visible evidence with this throw, but is never itself exported. */
	public static void dropped(EyeOfEnder eye, net.minecraft.world.entity.item.ItemEntity item) {
		Flight flight = FLIGHTS.get(eye);
		if (flight != null) flight.drop = item;
	}

	/** Called only when vanilla actually emits its shatter particles, never for the shared death sound. */
	public static void shattered(EyeOfEnder eye) {
		Flight flight = FLIGHTS.get(eye);
		if (flight != null) flight.facts.shattered(visible(flight.player, eye));
	}

	public static void ticked(EyeOfEnder eye) {
		Flight flight = FLIGHTS.get(eye);
		if (flight == null) return;
		flight.facts.seen(eye.position(), visible(flight.player, eye));
		if (flight.drop != null) flight.facts.dropped(flight.drop.position(), visible(flight.player, flight.drop), flight.drop.onGround());
		if (eye.isRemoved()) {
			flight.ended = true;
			publish(eye, flight);
		}
	}

	private static boolean visible(ServerPlayer player, Entity entity) {
		return !player.isRemoved() && player.isAlive() && player.level() == entity.level()
				&& ObservationVisibility.frame((ServerLevel) player.level(), player).canSeeEntity(entity);
	}

	private static void publish(EyeOfEnder eye, Flight flight) {
		JsonObject event = flight.facts.event();
		if (event == null) return;
		String dimension = eye.level().dimension().identifier().toString();
		double[] bearing = flight.facts.bearing();
		if (bearing != null) {
			BearingLines lines = LINES.computeIfAbsent(flight.player.getUUID(), ignored -> new BearingLines());
			lines.record(eye.getId(), dimension, flight.facts.origin, bearing);
			lines.addCross(event, eye.getId(), dimension);
		}
		if (event.equals(flight.published)) return;
		flight.published = event.deepCopy();
		event.addProperty("flightId", eye.getId());
		PlayerObservationEvents.eyeFlight(flight.player, event, eye.level().dimension().identifier().toString());
	}

	/**
	 * Ticks an eye must stay in view before "level" is a finding. A far eye climbs past +1 block within about 11 ticks
	 * and a near one sinks past -0.5 within about 8, so a shorter sighting that stayed level says nothing about distance.
	 */
	static final int LEVEL_JUDGED_TICKS = 15;
	/** Vanilla removes an eye after 80 ticks of life; a sighting this long saw essentially the whole flight. */
	static final int FULL_FLIGHT_TICKS = 75;
	/** Two bearings closer than this barely cross; the second throw should stand further to the side. */
	static final double MIN_CROSS_DEGREES = 1.0D;
	static final double MIN_CROSS_BASELINE = 8.0D;

	static JsonObject event(Vec3 origin, Vec3 lastSeen, double minY, double maxY, String outcome) {
		return event(origin, lastSeen, minY, maxY, LEVEL_JUDGED_TICKS, outcome);
	}

	static JsonObject event(Vec3 origin, Vec3 lastSeen, double minY, double maxY, int seenUntilTick, String outcome) {
		JsonObject event = new JsonObject();
		event.addProperty("type", "eye_of_ender_flight");
		event.add("from", position(origin));
		if (lastSeen != null) {
			double dx = lastSeen.x - origin.x;
			double dz = lastSeen.z - origin.z;
			double horizontal = Math.sqrt(dx * dx + dz * dz);
			event.add("to", position(lastSeen));
			if (horizontal >= 0.5D) {
				// Minecraft yaw: the facing that looks along the flight, the same convention control and moveTo use.
				double yaw = Math.toDegrees(Math.atan2(-dx, dz));
				event.addProperty("yaw", Math.round(yaw * 10.0D) / 10.0D);
				event.addProperty("heading", COMPASS[Math.floorMod((int) Math.round(yaw / 45.0D), COMPASS.length)]);
			}
			// An eye lost from view before its ending was seen travelled further than its seen part: that length says nothing
			// about distance to the stronghold, so only the flag is given (live: "Eye travelled only 1.9 blocks: anchor nearby").
			if ("unseen".equals(outcome) && seenUntilTick < FULL_FLIGHT_TICKS) event.addProperty("lostFromView", true);
			else event.addProperty("flewBlocks", Math.round(horizontal * 10.0D) / 10.0D);
			// It climbs while far from its destination and sinks toward it when close. Thrown from mid-body height, a sinking
			// eye leaves sight once it enters the ground about 0.9 blocks lower, so half a block already counts as sinking.
			String vertical = maxY - origin.y > 1.0D ? "rose" : minY - origin.y < -0.5D ? "sank"
					: seenUntilTick >= LEVEL_JUDGED_TICKS ? "level" : null;
			if (vertical != null) event.addProperty("vertical", vertical);
		}
		event.addProperty("outcome", outcome);
		return event;
	}

	private static JsonObject position(Vec3 value) {
		JsonObject position = new JsonObject();
		position.addProperty("x", Math.round(value.x * 10.0D) / 10.0D);
		position.addProperty("y", Math.round(value.y * 10.0D) / 10.0D);
		position.addProperty("z", Math.round(value.z * 10.0D) / 10.0D);
		return position;
	}

	/** Evidence accumulator shared by the runtime and the core reproduction checks. */
	static final class ObservedFlight {
		final Vec3 origin;
		private Vec3 lastSeen;
		private Vec3 droppedAt;
		private boolean landed;
		private double minY = Double.POSITIVE_INFINITY;
		private double maxY = Double.NEGATIVE_INFINITY;
		private String outcome = "unseen";
		private int ticks;
		private int lastSeenTick;

		ObservedFlight(Vec3 origin) { this.origin = origin; }

		void seen(Vec3 position, boolean visible) {
			ticks++;
			if (!visible) return;
			lastSeenTick = ticks;
			lastSeen = position;
			minY = Math.min(minY, position.y);
			maxY = Math.max(maxY, position.y);
		}

		void shattered(boolean visible) { if (visible) outcome = "shattered"; }

		void dropped(Vec3 position, boolean visible, boolean onGround) {
			if (!visible || droppedAt != null && (!onGround || landed && droppedAt.distanceToSqr(position) < 1.0D)) return;
			outcome = "dropped";
			droppedAt = position;
			landed = onGround;
		}

		JsonObject event() {
			if (lastSeen == null && "unseen".equals(outcome)) return null;
			JsonObject result = EyeFlightObservation.event(origin, lastSeen, minY, maxY, lastSeenTick, outcome);
			if (droppedAt != null) {
				result.add("droppedAt", position(droppedAt));
				// The item appears where the eye ended, so a seen drop gives the eye's whole horizontal travel.
				double dropped = Math.hypot(droppedAt.x - origin.x, droppedAt.z - origin.z);
				if (!result.has("flewBlocks") || dropped > result.get("flewBlocks").getAsDouble()) result.addProperty("flewBlocks", Math.round(dropped * 10.0D) / 10.0D);
			}
			return result;
		}

		/** Unit horizontal direction of the seen flight. Vanilla steers the eye straight at its target, so even a short sighting is exact. */
		double[] bearing() {
			if (lastSeen == null) return null;
			double dx = lastSeen.x - origin.x;
			double dz = lastSeen.z - origin.z;
			double length = Math.sqrt(dx * dx + dz * dz);
			return length < 0.5D ? null : new double[] { dx / length, dz / length };
		}
	}

	/**
	 * Where two bearing lines meet ahead of both throw points, or null when they are nearly parallel or meet behind one.
	 * A player does this on paper from two throws; each eye heads for the same stronghold start.
	 */
	static double[] cross(double ax, double az, double[] a, double bx, double bz, double[] b) {
		double denominator = a[0] * b[1] - a[1] * b[0];
		if (Math.abs(denominator) < Math.sin(Math.toRadians(MIN_CROSS_DEGREES))) return null;
		double ex = bx - ax;
		double ez = bz - az;
		double alongA = (ex * b[1] - ez * b[0]) / denominator;
		double alongB = (ex * a[1] - ez * a[0]) / denominator;
		if (alongA <= 0.0D || alongB <= 0.0D) return null;
		return new double[] { ax + a[0] * alongA, az + a[1] * alongA };
	}

	/** Each player's recent seen bearing lines, newest last, so a later throw elsewhere reports where the two lines cross. */
	static final class BearingLines {
		private static final int MAX_LINES = 8;
		private record Line(int flightId, String dimension, double x, double z, double[] direction) { }
		private final java.util.ArrayList<Line> lines = new java.util.ArrayList<>();

		void record(int flightId, String dimension, Vec3 origin, double[] direction) {
			lines.removeIf(line -> line.flightId == flightId);
			lines.add(new Line(flightId, dimension, origin.x, origin.z, direction));
			while (lines.size() > MAX_LINES) lines.removeFirst();
		}

		void addCross(JsonObject event, int flightId, String dimension) {
			Line current = lines.stream().filter(line -> line.flightId == flightId).findFirst().orElse(null);
			if (current == null) return;
			for (int index = lines.size() - 1; index >= 0; index--) {
				Line earlier = lines.get(index);
				if (earlier.flightId == flightId || !earlier.dimension.equals(dimension)
						|| Math.hypot(earlier.x - current.x, earlier.z - current.z) < MIN_CROSS_BASELINE) continue;
				double[] point = cross(current.x, current.z, current.direction, earlier.x, earlier.z, earlier.direction);
				if (point == null) continue;
				JsonObject cross = new JsonObject();
				cross.addProperty("x", Math.round(point[0]));
				cross.addProperty("z", Math.round(point[1]));
				event.add("cross", cross);
				event.addProperty("crossBlocks", Math.round(Math.hypot(point[0] - current.x, point[1] - current.z)));
				event.addProperty("crossFlightId", earlier.flightId);
				return;
			}
		}
	}

	private static final class Flight {
		private final ServerPlayer player;
		private final ObservedFlight facts;
		private final long thrownAt;
		private boolean ended;
		private net.minecraft.world.entity.item.ItemEntity drop;
		private JsonObject published;

		private Flight(ServerPlayer player, Vec3 origin) {
			this.player = player;
			this.facts = new ObservedFlight(origin);
			this.thrownAt = player.level().getGameTime();
		}
	}
}
