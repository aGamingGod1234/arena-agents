package dev.agaminggod.arenaagents.compat;

import java.util.List;
import java.util.concurrent.Executor;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.CustomSpawner;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.dimension.LevelStem;
import net.minecraft.world.level.storage.LevelStorageSource;
import net.minecraft.world.level.storage.ServerLevelData;

/** A ServerLevel fixture base: 26.3 needs nothing extra (fuel is an item component, see TestCompat.setFuel). */
public abstract class TestServerLevelBase extends ServerLevel {
	protected TestServerLevelBase(MinecraftServer server, Executor executor, LevelStorageSource.LevelStorageAccess storage, ServerLevelData data,
			ResourceKey<Level> dimension, LevelStem stem, boolean debug, long seed, List<CustomSpawner> spawners, boolean tickTime) {
		super(server, executor, storage, data, dimension, stem, debug, seed, spawners, tickTime);
	}
}
