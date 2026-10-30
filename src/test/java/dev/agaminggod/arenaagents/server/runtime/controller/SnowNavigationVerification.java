package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import dev.agaminggod.arenaagents.client.navigation.LocalPathfinder;
import dev.agaminggod.arenaagents.client.navigation.PathOutcome;
import dev.agaminggod.arenaagents.client.navigation.PathPlan;
import dev.agaminggod.arenaagents.client.navigation.TraversalType;
import dev.agaminggod.arenaagents.client.navigation.WalkabilityView;
import dev.agaminggod.arenaagents.server.perception.SeenTerrain;
import dev.agaminggod.arenaagents.server.perception.SnowSightVerification;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.phys.Vec3;

public final class SnowNavigationVerification {
	private static int assertions;
	private SnowNavigationVerification() { }

	public static int verify() {
		assertions = 0;
		SeenNavigationVerification.World dusting = new SeenNavigationVerification.World();
		for (int x = -2; x <= 8; x++) for (int z = -3; z <= 3; z++) {
			dusting.states.put(new BlockPos(x, 64, z), snow(1));
		}
		MinecraftNavigationWorld sight = sight(dusting, new Vec3(0.5D, 64D, 0.5D));
		GridPosition start = new GridPosition(0, 64, 0), goal = new GridPosition(4, 64, 0);
		check(sight.cellAt(goal) == WalkabilityView.Cell.CLEAR, "one-layer snow is passable");
		check(sight.isStandable(goal), "visible snow dusting must not hide the supporting top surface");
		check(route(sight, start, goal).nodes().getLast().position().equals(goal), "actual sight admits the snow-covered path beyond body contact");

		for (int layers = 1; layers <= 8; layers++) {
			SeenNavigationVerification.World world = new SeenNavigationVerification.World();
			world.seenThrough = 8;
			for (int x = 0; x <= 5; x++) world.states.put(new BlockPos(x, 64, 0), snow(layers));
			MinecraftNavigationWorld known = SeenNavigationVerification.view(world, new SeenTerrain.Memory<>(), 1L);
			GridPosition node = new GridPosition(2, layers == 1 ? 64 : 65, 0);
			check(known.isStandable(node), "all snow layer counts support a player: " + layers);
			check(known.supportHeight(node, 2.5D, 0.5D) == 64D + (layers - 1) / 8D,
					"use vanilla collision height, including eight-layer snow: " + layers);
			check(sight(world, new Vec3(0.5D, 64D + (layers - 1) / 8D, 0.5D)).isStandable(node),
					"actual sight acquires standable snow surfaces for every layer count: " + layers);
		}
		for (BlockState plant : new BlockState[] {Blocks.SHORT_GRASS.defaultBlockState(), Blocks.FERN.defaultBlockState(),
				Blocks.LEAF_LITTER.defaultBlockState(), Blocks.DEAD_BUSH.defaultBlockState()}) {
			SeenNavigationVerification.World world = new SeenNavigationVerification.World();
			world.states.put(new BlockPos(2, 64, 0), plant);
			check(sight(world, new Vec3(0.5D, 64D, 0.5D)).isStandable(new GridPosition(2, 64, 0)),
					"ordinary collisionless plants allow walking: " + plant);
		}
		SeenNavigationVerification.World bank = new SeenNavigationVerification.World();
		bank.states.put(new BlockPos(0, 64, 0), snow(1));
		bank.states.put(new BlockPos(1, 64, 0), Blocks.GRASS_BLOCK.defaultBlockState());
		bank.states.put(new BlockPos(1, 65, 0), snow(1));
		GridPosition upper = new GridPosition(1, 65, 0);
		PathPlan ascent = route(sight(bank, new Vec3(0.5D, 64D, 0.5D)), start, upper);
		check(ascent.outcome() == PathOutcome.FOUND && ascent.nodes().getLast().position().equals(upper),
				"a visible one-block snowy bank can be jumped");
		check(ascent.nodes().getLast().traversal() == TraversalType.JUMP_UP, "one-block bank uses a jump");
		check(ServerNavigationController.jumpNeeded(TraversalType.JUMP_UP, 1D, 0.8D), "the bank jump reaches the motor trigger");
		bank.states.put(new BlockPos(1, 66, 0), Blocks.SPRUCE_LEAVES.defaultBlockState());
		check(!sight(bank, new Vec3(0.5D, 64D, 0.5D)).isStandable(upper), "leaves above the snowy landing still block headroom");
		bank.states.remove(new BlockPos(1, 66, 0));

		bank.states.put(new BlockPos(0, 64, 0), snow(2));
		MinecraftNavigationWorld fractional = SeenNavigationVerification.sweptView(bank);
		PathPlan fractionalAscent = route(fractional, new GridPosition(0, 65, 0), upper);
		check(fractionalAscent.nodes().getLast().traversal() == TraversalType.JUMP_UP,
				"snow to a bank in the same grid row still needs a jump for its 0.875-block physical rise");
		check(ServerNavigationController.jumpNeeded(fractionalAscent.nodes().getLast().traversal(), 0.875D, 0.8D),
				"a fractional-height bank asks the motor to jump");
		bank.states.put(new BlockPos(1, 64, 0), snow(4));
		PathPlan shallow = route(SeenNavigationVerification.sweptView(bank), new GridPosition(0, 65, 0), upper);
		check(shallow.nodes().getLast().traversal() == TraversalType.WALK, "a 0.25-block snow rise uses vanilla stepping");
		bank.states.put(new BlockPos(1, 64, 0), Blocks.SNOW_BLOCK.defaultBlockState());
		bank.states.remove(new BlockPos(1, 65, 0));
		check(SeenNavigationVerification.sweptView(bank).isStandable(upper), "solid snow blocks provide ordinary footing");
		bank.states.put(new BlockPos(1, 64, 0), Blocks.STONE.defaultBlockState());
		bank.states.put(new BlockPos(1, 65, 0), Blocks.SNOW_BLOCK.defaultBlockState());
		check(!SeenNavigationVerification.sweptView(bank).canJumpUp(new GridPosition(0, 65, 0), new GridPosition(1, 66, 0)),
				"snow does not make a bank taller than the physical jump rise reachable");

		SeenNavigationVerification.World obstacles = new SeenNavigationVerification.World();
		obstacles.states.put(new BlockPos(1, 64, 0), Blocks.SPRUCE_LEAVES.defaultBlockState());
		MinecraftNavigationWorld forest = sight(obstacles, new Vec3(0.5D, 64D, 0.5D));
		check(!forest.isStandable(new GridPosition(1, 64, 0)), "leaves at body height remain solid obstacles");
		check(forest.cellAt(new GridPosition(2, 63, 0)) == WalkabilityView.Cell.UNLOADED,
				"leaves still hide the ground behind them");
		check(sight.cellAt(new GridPosition(-2, 63, 0)) == WalkabilityView.Cell.UNLOADED,
				"nearby snow behind the player remains unseen");
		for (BlockState hazard : new BlockState[] {Blocks.POWDER_SNOW.defaultBlockState(), Blocks.LAVA.defaultBlockState(),
				Blocks.MAGMA_BLOCK.defaultBlockState()}) {
			dusting.states.put(new BlockPos(2, 63, 0), hazard);
			MinecraftNavigationWorld unsafe = sight(dusting, new Vec3(0.5D, 64D, 0.5D));
			check(!unsafe.isStandable(new GridPosition(2, 64, 0)), "snow dusting cannot launder dangerous footing: " + hazard);
		}
		dusting.states.put(new BlockPos(2, 63, 0), Blocks.AIR.defaultBlockState());
		check(!sight(dusting, new Vec3(0.5D, 64D, 0.5D)).isStandable(new GridPosition(2, 64, 0)),
				"a floating snow dusting cannot invent footing over a drop");
		dusting.states.put(new BlockPos(2, 63, 0), Blocks.WATER.defaultBlockState());
		check(!sight(dusting, new Vec3(0.5D, 64D, 0.5D)).isStandable(new GridPosition(2, 64, 0)),
				"water under snow is not dry ground");
		return assertions;
	}

	private static BlockState snow(int layers) { return Blocks.SNOW.defaultBlockState().setValue(BlockStateProperties.LAYERS, layers); }
	private static MinecraftNavigationWorld sight(SeenNavigationVerification.World world, Vec3 feet) {
		return new MinecraftNavigationWorld(world, SnowSightVerification.reader(world, feet, new Vec3(1D, -0.2D, 0)));
	}
	private static PathPlan route(MinecraftNavigationWorld world, GridPosition from, GridPosition to) {
		return SeenNavigationVerification.finish(new LocalPathfinder().beginSearch(from, Set.of(to), to, 12, Set.of()), world);
	}
	private static void check(boolean condition, String message) {
		assertions++;
		if (!condition) throw new AssertionError(message);
	}
}
