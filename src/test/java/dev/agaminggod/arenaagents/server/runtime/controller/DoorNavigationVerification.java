package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.LocalPathfinder;
import dev.agaminggod.arenaagents.client.navigation.PathOutcome;
import dev.agaminggod.arenaagents.client.navigation.PathPlan;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;

/**
 * Doors on a walk: before, navigation never planned through a closed door or gate (entering or leaving any building
 * cost extra model calls) and travel's tunnel could mine a wooden door. The fixture is a one-block corridor whose only
 * way on is a doorway; only the corridor is seen, so no detour exists.
 */
public final class DoorNavigationVerification {
	private static int assertions;

	private DoorNavigationVerification() {
	}

	public static int verify() {
		assertions = 0;
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		BlockState oak = Blocks.OAK_DOOR.defaultBlockState().setValue(BlockStateProperties.OPEN, false);
		BlockState iron = Blocks.IRON_DOOR.defaultBlockState().setValue(BlockStateProperties.OPEN, false);
		BlockState gate = Blocks.OAK_FENCE_GATE.defaultBlockState().setValue(BlockStateProperties.OPEN, false);
		BlockState trapdoor = Blocks.OAK_TRAPDOOR.defaultBlockState().setValue(BlockStateProperties.OPEN, false);
		check(MinecraftNavigationWorld.closedHandDoor(oak), "a closed oak door is opened by hand");
		check(MinecraftNavigationWorld.closedHandDoor(gate), "a closed fence gate is opened by hand");
		check(!MinecraftNavigationWorld.closedHandDoor(iron), "an iron door needs redstone, not a hand");
		check(!MinecraftNavigationWorld.closedHandDoor(trapdoor), "a trapdoor is no doorway");
		check(!MinecraftNavigationWorld.closedHandDoor(oak.setValue(BlockStateProperties.OPEN, true)), "an open door needs no opening");
		check(TravelBuilder.unmineable(oak) != null && TravelBuilder.unmineable(gate) != null && TravelBuilder.unmineable(trapdoor) != null,
				"travel's tunnel never mines a door, gate or trapdoor: " + TravelBuilder.unmineable(oak));
		check(TravelBuilder.unmineable(Blocks.STONE.defaultBlockState()) == null, "stone is still tunnelled");

		check(route(oak, false).outcome() == PathOutcome.NO_PATH, "without door opening a closed doorway has no route (before)");
		PathPlan through = route(oak, true);
		check(through.outcome() == PathOutcome.FOUND, "a walker that opens doors routes through the doorway: " + through.outcome());
		check(through.nodes().stream().anyMatch(node -> node.position().equals(new GridPosition(1, 64, 0))), "the route steps into the door's cell");
		check(route(gate, true).outcome() == PathOutcome.FOUND, "a closed fence gate is routed through");
		check(route(gate, false).outcome() == PathOutcome.NO_PATH, "without door opening the gate blocks the corridor");
		check(route(iron, true).outcome() == PathOutcome.NO_PATH, "an iron door still blocks the route");
		SeenNavigationVerification.World world = corridor(oak);
		MinecraftNavigationWorld view = SeenNavigationVerification.view(world, new SeenTerrain.Memory<>(), 1L);
		check(view.cellAt(new GridPosition(1, 64, 0)) == WalkabilityView.Cell.BLOCKED, "the default view still reads a closed door as a barrier");
		check(view.opensDoors().cellAt(new GridPosition(1, 65, 0)) == WalkabilityView.Cell.CLEAR, "both halves of the door are clear once opening is on");
		check(view.planesThroughDoors(), "the view reports that its walker opens doors");
		return assertions;
	}

	private static PathPlan route(BlockState door, boolean opens) {
		SeenNavigationVerification.World world = corridor(door);
		MinecraftNavigationWorld view = SeenNavigationVerification.view(world, new SeenTerrain.Memory<>(), 1L);
		if (opens) view.opensDoors();
		return new LocalPathfinder().findPath(view, new GridPosition(0, 64, 0), new GridPosition(3, 64, 0));
	}

	/** Floor at y63, a doorway at x1 (the door, or a gate with open head room); only the z0 corridor is seen. */
	private static SeenNavigationVerification.World corridor(BlockState door) {
		SeenNavigationVerification.World world = new SeenNavigationVerification.World();
		world.seenThrough = 3;
		world.states.put(new BlockPos(1, 64, 0), door);
		if (door.hasProperty(BlockStateProperties.DOUBLE_BLOCK_HALF))
			world.states.put(new BlockPos(1, 65, 0), door.setValue(BlockStateProperties.DOUBLE_BLOCK_HALF, DoubleBlockHalf.UPPER));
		return world;
	}

	private static void check(boolean value, String reason) {
		if (!value) throw new AssertionError(reason);
		assertions++;
	}
}
