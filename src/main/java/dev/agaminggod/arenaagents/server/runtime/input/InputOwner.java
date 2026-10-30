package dev.agaminggod.arenaagents.server.runtime.input;

public enum InputOwner {
	DIRECT_CONTROL,
	NAVIGATION,
	COMBAT,
	INTERACTION,
	TRANSACTION,
	SYSTEM,
	/** A model-authored reflex firing; above actions, below an operator takeover. */
	REFLEX,
	/** A human operator driving the body during a POV takeover; acquired above every model owner. */
	OPERATOR
}
