package dev.agaminggod.arenaagents.compat;

import net.minecraft.server.dedicated.DedicatedServer;

/** A DedicatedServer a fixture builds without a world (26.3 constructor). */
public abstract class TestDedicatedServerBase extends DedicatedServer {
	protected TestDedicatedServerBase() {
		super(null, null, null, null, java.util.Optional.empty(), null, null, null, null, null);
	}
}
