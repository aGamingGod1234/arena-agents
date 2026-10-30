package dev.agaminggod.arenaagents.server.runtime.controller;

import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;

public final class DigPlanVerification {
	private DigPlanVerification() {
	}

	public static void main(String[] arguments) {
		System.out.println("PASS: " + verify() + " dig plan assertions");
	}

	public static int verify() {
		int assertions = 0;
		BlockPos feet = new BlockPos(10, 64, -3);
		for (Direction heading : List.of(Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST)) {
			for (ServerDigController.Pattern pattern : ServerDigController.Pattern.values()) {
				if (pattern == ServerDigController.Pattern.SHAFT) continue;
				for (BlockPos cell : ServerDigController.stepCells(pattern, feet, heading)) {
					check(!(cell.getX() == feet.getX() && cell.getZ() == feet.getZ() && cell.getY() < feet.getY()),
							pattern + " never opens the block the body stands on or anything below it");
					assertions++;
				}
			}
		}
		check(ServerDigController.stepCells(ServerDigController.Pattern.STAIRS_DOWN, feet, Direction.EAST)
				.equals(List.of(new BlockPos(11, 65, -3), new BlockPos(11, 64, -3), new BlockPos(11, 63, -3))),
				"a step down opens head, feet and the cell below, ahead, top first");
		assertions++;
		check(ServerDigController.stepTarget(ServerDigController.Pattern.STAIRS_DOWN, feet, Direction.EAST).equals(new BlockPos(11, 63, -3)),
				"a step down lands one block ahead and one lower");
		assertions++;
		check(ServerDigController.stepCells(ServerDigController.Pattern.STEEP_DOWN, feet, Direction.SOUTH)
				.equals(List.of(new BlockPos(10, 65, -2), new BlockPos(10, 64, -2), new BlockPos(10, 63, -2), new BlockPos(10, 62, -2))),
				"a steep step opens four cells ahead, top first");
		assertions++;
		check(ServerDigController.stepTarget(ServerDigController.Pattern.STEEP_DOWN, feet, Direction.SOUTH).equals(new BlockPos(10, 62, -2)),
				"a steep step drops two blocks: no fall damage");
		assertions++;
		check(ServerDigController.stepCells(ServerDigController.Pattern.STAIRS_UP, feet, Direction.NORTH)
				.equals(List.of(new BlockPos(10, 65, -4), new BlockPos(10, 66, -4), new BlockPos(10, 66, -3))),
				"a step up opens the next step's feet at eye level, then its head, then the jump headroom over the body");
		assertions++;
		check(ServerDigController.stepTarget(ServerDigController.Pattern.STAIRS_UP, feet, Direction.NORTH).equals(new BlockPos(10, 65, -4)),
				"a step up stands on the block ahead");
		assertions++;
		check(ServerDigController.stepCells(ServerDigController.Pattern.TUNNEL, feet, Direction.WEST)
				.equals(List.of(new BlockPos(9, 65, -3), new BlockPos(9, 64, -3))), "a tunnel opens two cells ahead");
		assertions++;
		check(ServerDigController.stepCells(ServerDigController.Pattern.SHAFT, feet, Direction.WEST).equals(List.of(new BlockPos(10, 63, -3)))
				&& ServerDigController.stepTarget(ServerDigController.Pattern.SHAFT, feet, Direction.WEST).equals(new BlockPos(10, 63, -3)),
				"a shaft step breaks only the block underfoot and drops one block into it, whatever the heading");
		assertions++;
		check(ServerDigController.Pattern.parse("shaft").down() && !ServerDigController.Pattern.STAIRS_UP.down(), "the shaft digs down");
		assertions++;
		check(ServerDigController.DEFAULT_MAX_SHAFT_Y == -20, "a shaft goes on as steep_down from y-20 down by default");
		assertions++;
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		check(net.minecraft.world.level.block.Blocks.SNOW_BLOCK.defaultDestroyTime() <= ServerDigController.HAND_BREAKS
				&& net.minecraft.world.level.block.Blocks.SNOW.defaultDestroyTime() <= ServerDigController.HAND_BREAKS
				&& net.minecraft.world.level.block.Blocks.STONE.defaultDestroyTime() > ServerDigController.HAND_BREAKS,
				"snow is dug by hand without a shovel; stone still needs its pickaxe");
		assertions++;
		check(TravelCheckpoints.left(0.5D, 60.0D, 0.5D, 0.5D, 40.0D, 0.5D, 3.0D) == 17.0D
				&& TravelCheckpoints.left(0.5D, 60.0D, 0.5D, 10.5D, Double.NaN, 0.5D, 3.0D) == 10.0D,
				"travel_to counts the height past its arrival band toward a target y as distance left (a cave floor below)");
		assertions++;
		check(ServerDigController.towardTarget(20, -1, feet) == Direction.EAST, "the larger remaining axis is dug first");
		assertions++;
		check(ServerDigController.towardTarget(11, -30, feet) == Direction.NORTH, "north is -z");
		assertions++;
		check(ServerDigController.towardTarget(null, null, feet) == null && ServerDigController.towardTarget(10, -3, feet) == null,
				"no x/z left keeps the given heading");
		assertions++;
		check(ServerDigController.dropDamage(3) == 0.0F && ServerDigController.dropDamage(ServerDigController.MAX_DROP) == 4.0F,
				"a drop of 3 does no fall damage; the deepest chosen drop costs 4");
		assertions++;
		check(ServerDigController.DROP_HEALTH_LEFT - ServerDigController.dropDamage(ServerDigController.MAX_DROP) > ServerDigController.LOW_HEALTH,
				"a chosen drop never brings health to LOW_HEALTH");
		assertions++;
		check(ServerDigController.Pattern.parse(null) == ServerDigController.Pattern.STAIRS_DOWN, "stairs_down is the default pattern");
		assertions++;
		boolean rejected = false;
		try {
			new ServerDigController(ServerDigController.Pattern.STAIRS_DOWN, null, null, null, null, 10, 1000L, 0L, null);
		} catch (IllegalArgumentException expected) {
			rejected = true;
		}
		check(rejected, "a staircase without a target y is refused");
		assertions++;
		return assertions;
	}

	private static void check(boolean value, String reason) {
		if (!value) throw new AssertionError(reason);
	}
}
