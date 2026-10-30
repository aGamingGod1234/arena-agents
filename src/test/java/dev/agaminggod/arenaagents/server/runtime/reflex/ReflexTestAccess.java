package dev.agaminggod.arenaagents.server.runtime.reflex;

import dev.agaminggod.arenaagents.client.navigation.GridPosition;
import java.util.List;
import java.util.Set;

/** Package-private reflex rules for verifications in other packages. */
public final class ReflexTestAccess {
	private ReflexTestAccess() {
	}

	public static GridPosition newFlow(List<GridPosition> ahead, Set<GridPosition> accepted, Set<GridPosition> flows) {
		return ReflexActions.PathWalk.newFlow(ahead, accepted, flows);
	}
}
