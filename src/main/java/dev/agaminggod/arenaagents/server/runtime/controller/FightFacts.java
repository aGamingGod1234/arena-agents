package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.phys.Vec3;

/** Observed options after a fight stops. No option here moves the body or promises safety from attackers. */
final class FightFacts {
	private FightFacts() { }

	static String stop(ServerPlayer player) {
		var server = player.level().getServer();
		var controller = server == null ? java.util.Optional.<dev.agaminggod.arenaagents.server.runtime.input.LeasedServerInputController>empty()
				: dev.agaminggod.arenaagents.server.runtime.input.AgentInputRuntime.existingController(server);
		var input = controller.flatMap(value -> dev.agaminggod.arenaagents.server.runtime.input.AgentInputRuntime.findAgentId(player)
				.flatMap(value::currentState));
		boolean idle = input.isEmpty() || idle(input.get());
		return body(idle, player.getDeltaMovement().length(), player.isOnFire(), player.getRemainingFireTicks(),
				HazardExits.contact(player)) + options(player);
	}

	static boolean idle(dev.agaminggod.arenaagents.server.runtime.input.AgentInputState input) {
		return input.forward() == 0 && input.strafe() == 0 && !input.jump() && !input.attack() && !input.use();
	}

	static String body(boolean idle, double speed, boolean onFire, int fireTicks, HazardExits.Contact contact) {
		return String.format(Locale.ROOT, "; body: input %s, motion %s, onFire=%s (%.1fs), contact=%s",
				idle ? "idle" : "active", speed < 1.0E-4D ? "stationary" : "moving", onFire,
				Math.max(0, fireTicks) / 20.0D, contact == null ? "none" : contact.wire);
	}

	static GridPosition nearest(Iterable<GridPosition> candidates, Vec3 from, Predicate<GridPosition> eligible) {
		GridPosition best = null;
		double distance = Double.POSITIVE_INFINITY;
		for (GridPosition candidate : candidates) {
			double d = distance(from, candidate);
			if (d < distance && eligible.test(candidate)) {
				best = candidate;
				distance = d;
			}
		}
		return best;
	}

	static double distance(Vec3 from, GridPosition cell) {
		return from.distanceTo(new Vec3(cell.x() + .5D, cell.y(), cell.z() + .5D));
	}

	static String location(GridPosition cell) {
		return String.format(Locale.ROOT, "(%.1f,%d,%.1f)", cell.x() + .5D, cell.y(), cell.z() + .5D);
	}

	private static String options(ServerPlayer player) {
		var seen = SeenTerrain.of(player);
		ObservedTerrain view = ObservedTerrain.of(player);
		return options(seen, view, player.position(), CombatMoveText.feet(player));
	}

	static String options(SeenTerrain.Reader<net.minecraft.world.level.block.state.BlockState> seen,
			ObservedTerrain view, Vec3 position, GridPosition feet) {
		Set<GridPosition> candidates = new LinkedHashSet<>();
		for (int x = -3; x <= 3; x++) for (int y = -1; y <= 1; y++) for (int z = -3; z <= 3; z++) {
			candidates.add(feet.offset(x, y, z));
		}
		for (long key : seen.rememberedPositions()) candidates.add(new GridPosition(BlockPos.getX(key), BlockPos.getY(key), BlockPos.getZ(key)));
		// Nearest first keeps geometry/sight work to candidates that can improve the answer.
		var ordered = candidates.stream().sorted(Comparator.comparingDouble(cell -> distance(position, cell))).toList();
		GridPosition water = nearest(ordered, position, cell -> {
			var state = seen.known(cell.x(), cell.y(), cell.z());
			return state != null && (state.getFluidState().is(FluidTags.WATER)
					|| state.getFluidState().getType().isSame(net.minecraft.world.level.material.Fluids.WATER)) && view.isTraversable(cell);
		});
		GridPosition ground = nearest(ordered, position, cell -> {
			if (!view.isStandable(cell)) return false;
			var state = seen.known(cell.x(), cell.y(), cell.z());
			return state != null && state.getFluidState().isEmpty();
		});
		return "; nearest known water: " + option(water, position, seen) + "; non-burning ground: "
				+ option(ground, position, seen) + " (ground does not extinguish; routes unverified; hazards/attackers may remain)";
	}

	private static String option(GridPosition cell, Vec3 position, SeenTerrain.Reader<?> seen) {
		if (cell == null) return "none known";
		int age = Math.max(seen.recalledAge(cell.x(), cell.y(), cell.z()),
				Math.max(seen.recalledAge(cell.x(), cell.y() - 1, cell.z()), seen.recalledAge(cell.x(), cell.y() + 1, cell.z())));
		return String.format(Locale.ROOT, "%s %.1fm%s", location(cell), distance(position, cell),
				age > 0 ? " remembered " + age + "s" : "");
	}
}
