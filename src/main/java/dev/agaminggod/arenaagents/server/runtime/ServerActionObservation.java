package dev.agaminggod.arenaagents.server.runtime;

import java.util.List;
import java.util.Objects;

/**
 * A compact snapshot of the server facts that justify an action's progress.
 * Null nested values mean that a fact is not applicable to the action, never
 * that an executor timer may be used as a substitute. onGround is true only
 * when standing on a block, not in a fluid, riding or gliding; teleportTick is
 * the latest forced reposition, only while it is recent.
 */
public record ServerActionObservation(
		Long worldTick,
		long observedAtEpochMs,
		Position position,
		Position velocity,
		double yaw,
		double pitch,
		Collision collision,
		RayTarget lookedAt,
		Reach reach,
		Target target,
		Progress progress,
		Boolean onGround,
		Long teleportTick,
		List<RevealedBlock> revealedBlocks
) {
	public ServerActionObservation {
		if (worldTick != null && worldTick < 0L) throw new IllegalArgumentException("worldTick must be non-negative");
		if (observedAtEpochMs < 0L) throw new IllegalArgumentException("observedAtEpochMs must be non-negative");
		finite(yaw, "yaw");
		finite(pitch, "pitch");
		if (teleportTick != null && teleportTick < 0L) throw new IllegalArgumentException("teleportTick must be non-negative");
		if (revealedBlocks != null) {
			if (revealedBlocks.size() > 6) throw new IllegalArgumentException("At most six newly exposed faces are allowed");
			revealedBlocks = List.copyOf(revealedBlocks);
		}
	}

	/** Actions without break exposure evidence. */
	public ServerActionObservation(Long worldTick, long observedAtEpochMs, Position position, Position velocity, double yaw, double pitch,
			Collision collision, RayTarget lookedAt, Reach reach, Target target, Progress progress, Boolean onGround, Long teleportTick) {
		this(worldTick, observedAtEpochMs, position, velocity, yaw, pitch, collision, lookedAt, reach, target, progress, onGround, teleportTick, null);
	}

	public ServerActionObservation withRevealedBlocks(List<RevealedBlock> blocks) {
		return new ServerActionObservation(worldTick, observedAtEpochMs, position, velocity, yaw, pitch, collision, lookedAt, reach, target, progress,
				onGround, teleportTick, blocks);
	}

	/** Actions without body grounding or teleport facts. */
	public ServerActionObservation(Long worldTick, long observedAtEpochMs, Position position, Position velocity, double yaw, double pitch,
			Collision collision, RayTarget lookedAt, Reach reach, Target target, Progress progress) {
		this(worldTick, observedAtEpochMs, position, velocity, yaw, pitch, collision, lookedAt, reach, target, progress, null, null);
	}

	public record Position(double x, double y, double z) {
		public Position {
			finite(x, "position.x");
			finite(y, "position.y");
			finite(z, "position.z");
		}
	}

	public record RevealedBlock(Position position, String blockId, String face) {
		public RevealedBlock {
			Objects.requireNonNull(position, "revealed block position must not be null");
			blockId = identifier(blockId, "revealedBlock.blockId");
			if (!List.of("down", "up", "north", "south", "west", "east").contains(face)) {
				throw new IllegalArgumentException("revealedBlock.face must be a block face");
			}
		}
	}

	public record Collision(boolean horizontal, boolean vertical, boolean inWall) {
	}

	public record RayTarget(
			String type,
			Position position,
			String id,
			String face,
			double hitDistance
	) {
		public RayTarget {
			type = identifier(type, "lookedAt.type");
			if (id != null) id = identifier(id, "lookedAt.id");
			if (face != null) face = identifier(face, "lookedAt.face");
			finite(hitDistance, "lookedAt.hitDistance");
			if (hitDistance < 0.0D) throw new IllegalArgumentException("lookedAt.hitDistance must be non-negative");
		}
	}

	public record Reach(double distance, double max, boolean within) {
		public Reach {
			finite(distance, "reach.distance");
			finite(max, "reach.max");
			if (distance < 0.0D || max < 0.0D) throw new IllegalArgumentException("reach distances must be non-negative");
		}
	}

	public record Target(
			String kind,
			Position position,
			String expectedId,
			String currentId,
			String beforeId,
			String afterId,
			Boolean worldChanged,
			Double distanceRemaining,
			Double tolerance,
			Boolean standable
	) {
		public Target {
			kind = identifier(kind, "target.kind");
			if (expectedId != null) expectedId = identifier(expectedId, "target.expectedId");
			if (currentId != null) currentId = identifier(currentId, "target.currentId");
			if (beforeId != null) beforeId = identifier(beforeId, "target.beforeId");
			if (afterId != null) afterId = identifier(afterId, "target.afterId");
			if (distanceRemaining != null) nonnegative(distanceRemaining, "target.distanceRemaining");
			if (tolerance != null) nonnegative(tolerance, "target.tolerance");
		}
	}

	public record Progress(double value, String basis, boolean verified) {
		public Progress {
			finite(value, "progress.value");
			if (value < 0.0D || value > 1.0D) throw new IllegalArgumentException("progress.value must be in [0, 1]");
			basis = identifier(basis, "progress.basis");
			if (!basis.equals("world_position") && !basis.equals("block_damage")
					&& !basis.equals("world_mutation") && !basis.equals("none")) {
				throw new IllegalArgumentException("Unsupported progress basis: " + basis);
			}
		}
	}

	private static String identifier(String value, String name) {
		if (value == null || value.isBlank() || value.length() > 128) {
			throw new IllegalArgumentException(name + " must be nonblank and at most 128 characters");
		}
		return value;
	}

	private static void nonnegative(double value, String name) {
		finite(value, name);
		if (value < 0.0D) throw new IllegalArgumentException(name + " must be non-negative");
	}

	private static void finite(double value, String name) {
		if (!Double.isFinite(value)) throw new IllegalArgumentException(name + " must be finite");
	}
}
