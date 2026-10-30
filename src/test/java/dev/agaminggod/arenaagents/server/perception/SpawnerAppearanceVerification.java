package dev.agaminggod.arenaagents.server.perception;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Optional;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.RegistryAccess;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.entity.monster.Blaze;
import net.minecraft.world.level.BaseSpawner;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.SpawnData;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.SpawnerBlockEntity;

/** Regression for the server display cache retaining a mob after the next-spawn update. */
public final class SpawnerAppearanceVerification {
	private SpawnerAppearanceVerification() { }

	public static int verify() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
		try {
			var registries = RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY);
			var block = new SpawnerBlockEntity(BlockPos.ZERO, Blocks.SPAWNER.defaultBlockState());
			var spawner = block.getSpawner();
			Field next = BaseSpawner.class.getDeclaredField("nextSpawnData");
			next.setAccessible(true);
			check(SpawnerAppearance.block(block, registries) == null, "unselected spawn data has no appearance");
			check(next.get(spawner) == null, "observation must not select the next spawn");

			// Invoke the actual SpawnerBlockEntity override used by normal weighted-spawner updates.
			Method update = spawner.getClass().getDeclaredMethod("setNextSpawnData", Level.class, BlockPos.class, SpawnData.class);
			update.setAccessible(true);
			update.invoke(spawner, null, BlockPos.ZERO, data("minecraft:blaze"));
			check("minecraft:blaze".equals(SpawnerAppearance.block(block, registries).get("mob").getAsString()), "first miniature is blaze");

			// A constructor-free sentinel represents an already-created display entity. Observation never uses it.
			Field singleton = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
			singleton.setAccessible(true);
			var stale = ((sun.misc.Unsafe) singleton.get(null)).allocateInstance(Blaze.class);
			Field display = BaseSpawner.class.getDeclaredField("displayEntity");
			display.setAccessible(true);
			display.set(spawner, stale);
			update.invoke(spawner, null, BlockPos.ZERO, data("minecraft:enderman"));
			check(display.get(spawner) == stale, "normal update preserves the stale server cache and reproduces the bug");
			check("minecraft:enderman".equals(SpawnerAppearance.block(block, registries).get("mob").getAsString()), "next miniature follows current spawn data despite stale cache");
			update.invoke(spawner, null, BlockPos.ZERO, data(null));
			check(SpawnerAppearance.block(block, registries) == null, "empty data removes the previous miniature");
			update.invoke(spawner, null, BlockPos.ZERO, data("minecraft:missing_entity"));
			check(SpawnerAppearance.block(block, registries) == null, "unknown entity does not produce a miniature");
			check(display.get(spawner) == stale, "observations do not mutate the display cache");
			return 8;
		} catch (ReflectiveOperationException failure) {
			throw new AssertionError("spawner update regression fixture", failure);
		}
	}

	private static SpawnData data(String id) {
		CompoundTag entity = new CompoundTag();
		if (id != null) entity.putString("id", id);
		return new SpawnData(entity, Optional.empty(), Optional.empty());
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
