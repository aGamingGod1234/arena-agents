package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.server.OfflineAgentPlayers;
import dev.agaminggod.arenaagents.server.runtime.input.AgentInputStates;
import java.util.Objects;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.phys.Vec3;

/**
 * Turns the agent's view toward a point over a few ticks, the way a player flicks the mouse, instead of
 * writing the final rotation in one tick (which spectators see as a camera snap). The last step is
 * Carpet's exact lookAt, so the action finishes with the same rotation the immediate write produced and
 * a following mine still sees the exact crosshair target.
 */
public final class ServerLookController implements ServerController {
	/** A 180 degree turn settles in about 6 ticks; this only guards against something fighting the turn. */
	static final int MAX_TURN_TICKS = 40;

	private final Vec3 target;
	private int ticks;

	public ServerLookController(Vec3 target) {
		this.target = Objects.requireNonNull(target, "target must not be null");
	}

	@Override
	public TickResult tick(ServerPlayer player, long nowEpochMs) {
		Objects.requireNonNull(player, "player must not be null");
		Angles exact = anglesTo(player.getEyePosition(), target);
		// The exact line on a calm enderman's eyes provokes it as a player's stare does: settle just off its head.
		float pitch = EndermanGaze.nearClearPitch(player, exact.yaw(), exact.pitch(), target);
		Angles goal = new Angles(exact.yaw(), pitch);
		Angles next = guarded(player, new Angles(player.getYRot(), player.getXRot()), goal, target);
		if (next.equals(goal)) {
			if (pitch == exact.pitch()) {
				OfflineAgentPlayers.actions(player).lookAt(target);
				return TickResult.succeeded("ACTION_COMPLETED", "Action completed");
			}
			OfflineAgentPlayers.actions(player).look(goal.yaw(), goal.pitch());
			var enderman = EndermanGaze.staredAt(player, exact.yaw(), exact.pitch(), target);
			return TickResult.succeeded("ACTION_COMPLETED", String.format(java.util.Locale.ROOT,
					"View settled %.0f degree(s) %s the point: the exact line meets calm enderman %s's eyes%s, and a stare turns it hostile",
					Math.abs(pitch - exact.pitch()), pitch > exact.pitch() ? "below" : "above",
					enderman == null ? "" : enderman.getStringUUID(),
					enderman == null ? "" : String.format(java.util.Locale.ROOT, " %.0f blocks away", player.distanceTo(enderman))));
		}
		if (++ticks >= MAX_TURN_TICKS) {
			return TickResult.failed("LOOK_NOT_SETTLED", "The view did not settle on the requested point", 0.0D);
		}
		OfflineAgentPlayers.actions(player).look(next.yaw(), next.pitch());
		return TickResult.running(Math.min(0.99D, (double) ticks / 8.0D));
	}

	/**
	 * One eased view step toward {@code point} outside a look_at action (bow aim); the arrival step is Carpet's
	 * exact lookAt. Returns true once the view is on the point.
	 */
	public static boolean turnToward(ServerPlayer player, Vec3 point) {
		Angles goal = anglesTo(player.getEyePosition(), point);
		Angles next = guarded(player, new Angles(player.getYRot(), player.getXRot()), goal, point);
		if (next.equals(goal)) {
			OfflineAgentPlayers.actions(player).lookAt(point);
			return true;
		}
		OfflineAgentPlayers.actions(player).look(next.yaw(), next.pitch());
		return false;
	}

	/**
	 * The eased step, its sweep kept off calm endermen's eyes (a turn across the End horizon brushed three in run
	 * d9-end-b): mid-turn the pitch bends away; once the yaw has arrived the view goes straight to the goal pitch.
	 */
	static Angles guarded(ServerPlayer player, Angles current, Angles goal, Vec3 onPurpose) {
		Angles next = step(current, goal);
		if (next.equals(goal) || EndermanGaze.staredAt(player, next.yaw(), next.pitch(), onPurpose) == null) return next;
		if (AgentInputStates.shortestAngleDelta(next.yaw(), goal.yaw()) == 0.0F) return goal;
		return new Angles(next.yaw(), EndermanGaze.clearPitch(player, next.yaw(), next.pitch()));
	}

	/** Advances one eased tick; returns {@code goal} itself once both axes arrive. */
	static Angles step(Angles current, Angles goal) {
		float yaw = AgentInputStates.turnYaw(current.yaw(), goal.yaw());
		float pitch = AgentInputStates.turnPitch(current.pitch(), goal.pitch());
		boolean yawArrived = AgentInputStates.shortestAngleDelta(yaw, goal.yaw()) == 0.0F;
		return yawArrived && pitch == goal.pitch() ? goal : new Angles(yaw, pitch);
	}

	/** Same math as Entity.lookAt, so the arrival check compares like with like. */
	static Angles anglesTo(Vec3 eye, Vec3 point) {
		double dx = point.x - eye.x;
		double dy = point.y - eye.y;
		double dz = point.z - eye.z;
		double horizontal = Math.sqrt(dx * dx + dz * dz);
		float yaw = Mth.wrapDegrees((float) (Mth.atan2(dz, dx) * Mth.RAD_TO_DEG) - 90.0F);
		float pitch = Mth.clamp(Mth.wrapDegrees((float) (-(Mth.atan2(dy, horizontal) * Mth.RAD_TO_DEG))), -90.0F, 90.0F);
		return new Angles(yaw, pitch);
	}

	record Angles(float yaw, float pitch) {
	}
}
