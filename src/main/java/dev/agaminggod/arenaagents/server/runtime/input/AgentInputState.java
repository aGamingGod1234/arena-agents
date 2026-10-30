package dev.agaminggod.arenaagents.server.runtime.input;

import java.util.Objects;
import net.minecraft.world.InteractionHand;

public record AgentInputState(
		float forward,
		float strafe,
		boolean jump,
		boolean sneak,
		boolean sprint,
		boolean attack,
		boolean use,
		float yaw,
		float pitch,
		int selectedSlot,
		InteractionHand hand,
		MovementBasis movementBasis
) {
	/** Original axes and view before a held shield rotates the body; vanilla scales these axes before rotation. */
	public record MovementBasis(float forward, float strafe, float yaw) {
		public MovementBasis {
			if (!Float.isFinite(forward) || !Float.isFinite(strafe) || !Float.isFinite(yaw)
					|| Math.abs(forward) > 1.0F || Math.abs(strafe) > 1.0F) throw new IllegalArgumentException("invalid movement basis");
		}
	}

	public AgentInputState(float forward, float strafe, boolean jump, boolean sneak, boolean sprint, boolean attack,
			boolean use, float yaw, float pitch, int selectedSlot, InteractionHand hand) {
		this(forward, strafe, jump, sneak, sprint, attack, use, yaw, pitch, selectedSlot, hand, null);
	}

	public AgentInputState withMovementBasis(AgentInputState source) {
		MovementBasis basis = source.movementBasis != null ? source.movementBasis : new MovementBasis(source.forward, source.strafe, source.yaw);
		return new AgentInputState(forward, strafe, jump, sneak, sprint, attack, use, yaw, pitch, selectedSlot, hand, basis);
	}

	public AgentInputState {
		if (!Float.isFinite(forward) || forward < -1.0F || forward > 1.0F) {
			throw new IllegalArgumentException("forward must be finite and in [-1, 1]");
		}
		if (!Float.isFinite(strafe) || strafe < -1.0F || strafe > 1.0F) {
			throw new IllegalArgumentException("strafe must be finite and in [-1, 1]");
		}
		if (!Float.isFinite(yaw) || !Float.isFinite(pitch) || pitch < -90.0F || pitch > 90.0F) {
			throw new IllegalArgumentException("look angles must be finite and pitch must be in [-90, 90]");
		}
		if (selectedSlot < 0 || selectedSlot > 8) throw new IllegalArgumentException("selectedSlot must be in [0, 8]");
		Objects.requireNonNull(hand, "hand must not be null");
	}

	public static AgentInputState idle(float yaw, float pitch, int selectedSlot) {
		return new AgentInputState(
				0.0F, 0.0F, false, false, false, false, false,
				yaw, pitch, selectedSlot, InteractionHand.MAIN_HAND
		);
	}
}
