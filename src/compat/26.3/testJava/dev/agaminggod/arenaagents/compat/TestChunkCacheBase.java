package dev.agaminggod.arenaagents.compat;

import net.minecraft.server.level.ServerChunkCache;

/** A chunk cache fixture: its constructor arguments are all unused by the verifications and differ between targets. */
public abstract class TestChunkCacheBase extends ServerChunkCache {
	protected TestChunkCacheBase() {
		super(null, null, null, null, null, null, 0, 0, false, null);
	}
}
