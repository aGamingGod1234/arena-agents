package dev.agaminggod.arenaagents.server.runtime;

import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.Half;
import net.minecraft.world.level.block.state.properties.StairsShape;

public final class BlockPlacementPostconditionVerification {
	private BlockPlacementPostconditionVerification() {
	}

	public static void main(String[] args) {
		System.out.println("PASS: " + verify() + " block placement postcondition assertions");
	}

	public static int verify() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		DesiredBlockState expectedStairs = DesiredBlockState.parse(
				"minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]",
				"minecraft:oak_stairs"
		);
		BlockState correctStairs = Blocks.OAK_STAIRS.defaultBlockState()
				.setValue(BlockStateProperties.HORIZONTAL_FACING, Direction.NORTH)
				.setValue(BlockStateProperties.HALF, Half.BOTTOM)
				.setValue(BlockStateProperties.STAIRS_SHAPE, StairsShape.STRAIGHT)
				.setValue(BlockStateProperties.WATERLOGGED, false);
		assertEquals(
				BlockPlacementPostcondition.Decision.SUCCEEDED,
				BlockPlacementPostcondition.evaluate(
						"minecraft:air", correctStairs, expectedStairs, true, false
				),
				"matching requested properties succeed"
		);
		assertEquals(
				BlockPlacementPostcondition.Decision.CONFLICT,
				BlockPlacementPostcondition.evaluate(
						"minecraft:air",
						correctStairs.setValue(BlockStateProperties.HORIZONTAL_FACING, Direction.SOUTH),
						expectedStairs,
						true,
						false
				),
				"wrong requested facing is rejected"
		);
		DesiredBlockState torch = DesiredBlockState.parse(null, "minecraft:torch");
		assertEquals(
				BlockPlacementPostcondition.Decision.SUCCEEDED,
				BlockPlacementPostcondition.evaluate("minecraft:air", Blocks.WALL_TORCH.defaultBlockState()
						.setValue(BlockStateProperties.HORIZONTAL_FACING, Direction.EAST), torch, true, false),
				"a torch clicked on a side face becomes vanilla's wall torch, which is the requested placement"
		);
		assertEquals(
				BlockPlacementPostcondition.Decision.CONFLICT,
				BlockPlacementPostcondition.evaluate("minecraft:air", Blocks.REDSTONE_WALL_TORCH.defaultBlockState(), torch, true, false),
				"another item's wall block is still a conflict"
		);
		assertEquals(
				BlockPlacementPostcondition.Decision.ALREADY_SATISFIED,
				BlockPlacementPostcondition.evaluate("minecraft:wall_torch", Blocks.WALL_TORCH.defaultBlockState(), torch, false, false),
				"an existing wall torch already satisfies a torch placement"
		);
		DesiredBlockState facedSign = DesiredBlockState.parse("minecraft:oak_sign[rotation=4]", "minecraft:oak_sign");
		assertEquals(
				BlockPlacementPostcondition.Decision.CONFLICT,
				BlockPlacementPostcondition.evaluate("minecraft:air", Blocks.OAK_WALL_SIGN.defaultBlockState(), facedSign, true, false),
				"requested properties keep the exact requested block"
		);
		assertEquals(
				BlockPlacementPostcondition.Decision.CONFLICT,
				BlockPlacementPostcondition.evaluate("minecraft:air", Blocks.COBBLESTONE.defaultBlockState(),
						DesiredBlockState.parse(null, "minecraft:stone"), true, false),
				"blocks that only drop the item are not its placement"
		);
		assertEquals(
				BlockPlacementPostcondition.Decision.EXHAUSTED,
				BlockPlacementPostcondition.evaluate(
						"minecraft:air", Blocks.AIR.defaultBlockState(), expectedStairs, false, false, 8
				),
				"eighth unsuccessful attempt terminates without waiting for timeout"
		);
		assertEquals(
				BlockPlacementPostcondition.Decision.SUCCEEDED,
				BlockPlacementPostcondition.evaluate(
						"minecraft:air",
						"minecraft:oak_log",
						"minecraft:oak_log",
						true,
						false
				),
				"expected placed block succeeds"
		);
		assertEquals(
				BlockPlacementPostcondition.Decision.SUCCEEDED,
				BlockPlacementPostcondition.evaluate(
						"minecraft:air", "minecraft:oak_log", "minecraft:oak_log", false
				),
				"legacy block-id postcondition remains compatible"
		);
		assertEquals(
				BlockPlacementPostcondition.Decision.CONFLICT,
				BlockPlacementPostcondition.evaluate(
						"minecraft:oak_log", "minecraft:oak_log", "minecraft:oak_log", false
				),
				"legacy block-id postcondition preserves occupied-target conflict"
		);
		assertEquals(
				BlockPlacementPostcondition.Decision.WAITING,
				BlockPlacementPostcondition.evaluate(
						"minecraft:air",
						"minecraft:air",
						"minecraft:oak_log",
						false,
						false
				),
				"unchanged world waits for the server action"
		);
		assertEquals(
				BlockPlacementPostcondition.Decision.CONFLICT,
				BlockPlacementPostcondition.evaluate(
						"minecraft:air",
						"minecraft:stone",
						"minecraft:oak_log",
						false,
						false
				),
				"unexpected world mutation is not reported as success"
		);
		assertEquals(
				BlockPlacementPostcondition.Decision.TIMED_OUT,
				BlockPlacementPostcondition.evaluate(
						"minecraft:air",
						"minecraft:air",
						"minecraft:oak_log",
						false,
						true
				),
				"unchanged placement eventually times out"
		);
		assertEquals(
				BlockPlacementPostcondition.Decision.ALREADY_SATISFIED,
				BlockPlacementPostcondition.evaluate(
						"minecraft:oak_log",
						"minecraft:oak_log",
						"minecraft:oak_log",
						false,
						false
				),
				"an already-present target is not credited to this action"
		);
		assertEquals(
				BlockPlacementPostcondition.Decision.CONFLICT,
				BlockPlacementPostcondition.evaluate(
						"minecraft:air",
						"minecraft:oak_log",
						"minecraft:oak_log",
						false,
						false
				),
				"a matching world block without an owned placement is a conflict"
		);
		assertEquals(
				BlockPlacementPostcondition.Decision.CONFLICT,
				BlockPlacementPostcondition.evaluate(
						"minecraft:oak_log",
						"minecraft:air",
						"minecraft:oak_log",
						false,
						false
				),
				"an already-satisfied target removed before confirmation is a conflict"
		);
		return 10;
	}

	private static void assertEquals(Object expected, Object actual, String label) {
		if (!expected.equals(actual)) {
			throw new AssertionError(label + ": expected <" + expected + "> but was <" + actual + ">");
		}
	}
}
