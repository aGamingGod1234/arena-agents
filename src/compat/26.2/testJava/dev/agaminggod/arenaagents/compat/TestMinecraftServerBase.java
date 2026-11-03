package dev.agaminggod.arenaagents.compat;

import net.minecraft.server.MinecraftServer;

/** A MinecraftServer a fixture allocates or builds without a world; 26.2 constructor and the spam thresholds 26.2 made abstract. */
public abstract class TestMinecraftServerBase extends MinecraftServer {
	protected TestMinecraftServerBase() {
		super(null, null, null, null, java.util.Optional.empty(), java.net.Proxy.NO_PROXY, null, null, null, false, null);
	}

	@Override public int getCommandSpamThresholdSeconds() { return 0; }
	@Override public int getChatSpamThresholdSeconds() { return 0; }
}
