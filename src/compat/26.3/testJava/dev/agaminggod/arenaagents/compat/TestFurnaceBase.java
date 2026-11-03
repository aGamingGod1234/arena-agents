package dev.agaminggod.arenaagents.compat;

import dev.agaminggod.arenaagents.compat.mixin.FurnaceBurnDurationInvoker;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.FurnaceBlockEntity;

/** A furnace for verifications without mixins applied: it implements 26.3's burn-duration invoker itself. */
public abstract class TestFurnaceBase extends FurnaceBlockEntity implements FurnaceBurnDurationInvoker {
	protected TestFurnaceBase(BlockPos position) {
		super(position, Blocks.FURNACE.defaultBlockState());
	}

	@Override
	public int arenaagents$burnDuration(ServerLevel level, ItemStack stack) {
		return getBurnDuration(level, stack);
	}
}
