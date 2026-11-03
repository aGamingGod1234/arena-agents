package dev.agaminggod.arenaagents.compat;

import dev.agaminggod.arenaagents.compat.mixin.FurnaceBurnDurationInvoker;
import net.minecraft.core.BlockPos;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.FuelValues;
import net.minecraft.world.level.block.entity.FurnaceBlockEntity;

/** A furnace for verifications without mixins applied: it delegates the invoker to the virtual method. */
public abstract class TestFurnaceBase extends FurnaceBlockEntity implements FurnaceBurnDurationInvoker {
	protected TestFurnaceBase(BlockPos position) {
		super(position, Blocks.FURNACE.defaultBlockState());
	}

	@Override
	public int arenaagents$burnDuration(FuelValues values, ItemStack stack) {
		return getBurnDuration(values, stack);
	}
}
