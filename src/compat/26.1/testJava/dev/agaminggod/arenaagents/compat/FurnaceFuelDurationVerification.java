package dev.agaminggod.arenaagents.compat;

import dev.agaminggod.arenaagents.compat.mixin.FurnaceBurnDurationInvoker;
import dev.agaminggod.arenaagents.server.perception.FurnaceMemory;
import net.minecraft.core.BlockPos;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.flag.FeatureFlags;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.AbstractFurnaceBlockEntity;
import net.minecraft.world.level.block.entity.BlastFurnaceBlockEntity;
import net.minecraft.world.level.block.entity.FuelValues;
import net.minecraft.world.level.block.entity.SmokerBlockEntity;

/** Real vanilla virtual methods, with explicit invoker bridges because this main runs without Fabric mixins. */
public final class FurnaceFuelDurationVerification {
	private static int checks;

	public static void main(String[] args) throws Exception {
		System.out.println("Furnace fuel duration checks=" + verify());
	}

	public static int verify() throws Exception {
		checks = 0;
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		var field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
		field.setAccessible(true);
		var unsafe = (sun.misc.Unsafe) field.get(null);
		var level = (FuelLevel) unsafe.allocateInstance(FuelLevel.class);
		var holder = Items.COAL.builtInRegistryHolder();
		boolean bindCoal = !holder.areComponentsBound();
		if (bindCoal) holder.bindComponents(net.minecraft.core.component.DataComponentMap.builder()
				.set(net.minecraft.core.component.DataComponents.MAX_STACK_SIZE, 64).build());
		try {
			return verifyFurnaces(level);
		} finally {
			if (bindCoal) {
				var components = net.minecraft.core.Holder.Reference.class.getDeclaredField("components");
				components.setAccessible(true);
				components.set(holder, null);
			}
		}
	}

	private static int verifyFurnaces(ServerLevel level) {
		var coal = new ItemStack(Items.COAL);
		check(McCompat.burnDuration(level, null, coal) == 1600, "null furnace retains raw fuel duration");
		check(McCompat.burnDuration(level, new Normal(), coal) == 1600, "normal furnace retains raw fuel duration");
		for (AbstractFurnaceBlockEntity furnace : new AbstractFurnaceBlockEntity[]{new Smoker(), new Blast()}) {
			int ticks = McCompat.burnDuration(level, furnace, coal);
			check(ticks == 800, furnace.getClass().getSimpleName() + " halves fuel duration (actual=" + ticks + ")");
			var sample = new FurnaceMemory.Sample(new FurnaceMemory.Stack("minecraft:raw_iron", 16),
					new FurnaceMemory.Stack("minecraft:coal", 1), new FurnaceMemory.Stack("minecraft:air", 0), 0, 0, 100, ticks);
			check(sample.readyCount() == 8, "one coal supports eight fast-furnace outputs");
			check(sample.readyInMs() == null, "insufficient fuel cannot promise a full batch");
			check(sample.partialReadyInMs() == 40_000L, "partial estimate uses the adjusted budget");
			check(McCompat.burnDuration(level, furnace, ItemStack.EMPTY) == 0, "empty stack supplies no fuel");
		}
		check(McCompat.burnDuration(level, new Custom(), coal) == 533, "custom virtual overrides survive the shim");
		return checks;
	}

	private static void check(boolean value, String message) {
		checks++;
		if (!value) throw new AssertionError(message);
	}

	private static class Normal extends TestFurnaceBase {
		Normal() { super(BlockPos.ZERO); }
	}

	private static final class Custom extends Normal {
		@Override protected int getBurnDuration(FuelValues values, ItemStack stack) {
			return super.getBurnDuration(values, stack) / 3;
		}
	}

	private static final class Smoker extends SmokerBlockEntity implements FurnaceBurnDurationInvoker {
		Smoker() { super(BlockPos.ZERO, Blocks.SMOKER.defaultBlockState()); }
		@Override public int arenaagents$burnDuration(FuelValues values, ItemStack stack) {
			return getBurnDuration(values, stack);
		}
	}

	private static final class Blast extends BlastFurnaceBlockEntity implements FurnaceBurnDurationInvoker {
		Blast() { super(BlockPos.ZERO, Blocks.BLAST_FURNACE.defaultBlockState()); }
		@Override public int arenaagents$burnDuration(FuelValues values, ItemStack stack) {
			return getBurnDuration(values, stack);
		}
	}

	private static final class FuelLevel extends ServerLevel {
		private FuelLevel() { super(null, null, null, null, null, null, false, 0L, java.util.List.of(), false); }
		@Override public FuelValues fuelValues() {
			return new FuelValues.Builder(HolderLookup.Provider.create(java.util.stream.Stream.of(BuiltInRegistries.ITEM)),
					FeatureFlags.DEFAULT_FLAGS).add(Items.COAL, 1600).build();
		}
	}
}
