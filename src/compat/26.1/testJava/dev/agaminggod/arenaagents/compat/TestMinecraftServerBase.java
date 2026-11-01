package dev.agaminggod.arenaagents.compat;

import net.minecraft.server.MinecraftServer;

/** A MinecraftServer a fixture allocates or builds without a world; 26.1 constructor. */
public abstract class TestMinecraftServerBase extends MinecraftServer {
	protected TestMinecraftServerBase() {
		super(null, null, null, null, java.util.Optional.empty(), java.net.Proxy.NO_PROXY, null, null, null, false);
	}
}
