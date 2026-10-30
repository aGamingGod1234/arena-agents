package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.JsonObject;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.level.block.entity.SpawnerBlockEntity;

/** Reads the same spawn data sent to vanilla clients, without creating or selecting a display entity. */
final class SpawnerAppearance {
	private SpawnerAppearance() { }

	static JsonObject block(SpawnerBlockEntity spawner, HolderLookup.Provider registries) {
		// The server display cache survives setNextSpawnData; the update tag reflects the current miniature.
		var type = spawner.getUpdateTag(registries).getCompound("SpawnData")
				.flatMap(data -> data.getCompound("entity"))
				.flatMap(entity -> entity.getString("id"))
				.flatMap(id -> BuiltInRegistries.ENTITY_TYPE.getOptional(net.minecraft.resources.Identifier.tryParse(id)));
		if (type.isEmpty()) return null;
		JsonObject look = new JsonObject();
		look.addProperty("mob", BuiltInRegistries.ENTITY_TYPE.getKey(type.get()).toString());
		return look;
	}
}
