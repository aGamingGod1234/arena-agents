package dev.agaminggod.arenaagents.server.runtime.controller;

import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.food.FoodData;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

/** Exercises travel's descent handoff and the real dig tick through its first staircase cell calculation. */
public final class VerticalDescentHeadingVerification {
	private static int assertions;
	private static final BlockPos FEET = new BlockPos(10, 64, 10);
	private static final PlanningReached PLANNING_REACHED = new PlanningReached();

	public static void main(String[] args) throws Exception {
		System.out.println("PASS: " + verify() + " vertical descent heading assertions");
	}

	public static int verify() throws Exception {
		assertions = 0;
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		for (Direction facing : List.of(Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST)) {
			verifyDescent(10.5, 10.5, facing, facing);
		}
		verifyDescent(20.5, 10.5, Direction.NORTH, Direction.EAST);
		verifyDescent(10.5, -20.5, Direction.EAST, Direction.NORTH);
		return assertions;
	}

	private static void verifyDescent(double x, double z, Direction facing, Direction expected) throws Exception {
		Field access = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
		access.setAccessible(true);
		var unsafe = (sun.misc.Unsafe) access.get(null);
		FixturePlayer player = (FixturePlayer) unsafe.allocateInstance(FixturePlayer.class);
		player.fixtureLevel = (FixtureLevel) unsafe.allocateInstance(FixtureLevel.class);
		player.facing = facing;
		player.food = new FoodData();
		player.tickCount = 1; // No periodic sight/threat scan needed for the initial heading calculation.
		Field grounded = Entity.class.getDeclaredField("onGround");
		grounded.setAccessible(true);
		grounded.setBoolean(player, true);
		ServerDigController[] nested = new ServerDigController[1];
		var travel = new ServerTravelController(x, 40, z, 3, 10_000, true, null, null,
				(body, cell) -> true, 0).descend((y, tx, tz, timeout) -> {
			check(y == 40 && tx == (int) Math.floor(x) && tz == (int) Math.floor(z),
					"travel supplies the target column, including a directly below target");
			// Matches the executor's stairs_down factory: x/z supplied, heading omitted.
			nested[0] = new ServerDigController(ServerDigController.Pattern.STAIRS_DOWN, y, tx, tz,
					null, 100, timeout, 0, null);
			return nested[0];
		});
		// Enter the actual descent method after route/look exhaustion; no simulated navigation or dig planner.
		var entry = ServerTravelController.class.getDeclaredMethod("startDig", ServerPlayer.class, long.class);
		entry.setAccessible(true);
		try {
			entry.invoke(travel, player, 1L);
			throw new AssertionError("expected the fixture to stop after staircase cells were calculated");
		} catch (InvocationTargetException failure) {
			if (failure.getCause() != PLANNING_REACHED) throw new AssertionError("descent failed before planning its first step", failure.getCause());
		}
		check(field(nested[0], "heading") == expected, "heading follows facing for vertical travel and remaining x/z otherwise");
		BlockPos ahead = FEET.relative(expected);
		check(field(nested[0], "cells").equals(List.of(ahead.above(), ahead, ahead.below())),
				"real first-step planning opens a staircase ahead, never the support underfoot");
	}

	private static Object field(Object target, String name) throws Exception {
		Field field = target.getClass().getDeclaredField(name);
		field.setAccessible(true);
		return field.get(target);
	}

	private static void check(boolean condition, String message) {
		assertions++;
		if (!condition) throw new AssertionError(message);
	}

	private static final class PlanningReached extends Error { }

	private static final class FixturePlayer extends ServerPlayer {
		FixtureLevel fixtureLevel;
		Direction facing;
		FoodData food;
		FixturePlayer() { super(null, null, null, null); }
		@Override public ServerLevel level() { return fixtureLevel; }
		@Override public BlockPos blockPosition() { return FEET; }
		@Override public Direction getDirection() { return facing; }
		@Override public float getHealth() { return 20; }
		@Override public boolean isUnderWater() { return false; }
		@Override public FoodData getFoodData() { return food; }
	}

	private static final class FixtureLevel extends ServerLevel {
		FixtureLevel() { super(null, null, null, null, null, null, false, 0L, List.of(), false); }
		@Override public BlockState getBlockState(BlockPos at) {
			if (at.equals(FEET.below())) return Blocks.STONE.defaultBlockState();
			// The next world read follows stepCells in production plan(). Stop before mining/input services.
			if (at.equals(FEET)) throw PLANNING_REACHED;
			throw new AssertionError("unexpected terrain read: " + at);
		}
	}
}
