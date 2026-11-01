package dev.agaminggod.arenaagents.compat;

import java.util.List;
import java.util.concurrent.Executor;
import net.minecraft.core.HolderLookup;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.flag.FeatureFlags;
import net.minecraft.world.level.CustomSpawner;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.FuelValues;
import net.minecraft.world.level.dimension.LevelStem;
import net.minecraft.world.level.storage.LevelStorageSource;
import net.minecraft.world.level.storage.ServerLevelData;

/** A ServerLevel fixture base: before 26.3 the level's fuel table (from its server) gives burn times; here the fixture's. */
public abstract class TestServerLevelBase extends ServerLevel {
	protected TestServerLevelBase(MinecraftServer server, Executor executor, LevelStorageSource.LevelStorageAccess storage, ServerLevelData data,
			ResourceKey<Level> dimension, LevelStem stem, boolean debug, long seed, List<CustomSpawner> spawners, boolean tickTime) {
		super(server, executor, storage, data, dimension, stem, debug, seed, spawners, tickTime);
	}

	@Override
	public FuelValues fuelValues() {
		FuelValues.Builder builder = new FuelValues.Builder(HolderLookup.Provider.create(java.util.stream.Stream.of(net.minecraft.core.registries.BuiltInRegistries.ITEM)), FeatureFlags.DEFAULT_FLAGS);
		TestCompat.FUEL.forEach(builder::add);
		return builder.build();
	}
}
