package dev.agaminggod.arenaagents.compat;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.FurnaceBlockEntity;

/** A furnace for verifications without mixins applied (26.2 burn times come from the level's fuel table). */
public abstract class TestFurnaceBase extends FurnaceBlockEntity {
	protected TestFurnaceBase(BlockPos position) {
		super(position, Blocks.FURNACE.defaultBlockState());
	}
}
