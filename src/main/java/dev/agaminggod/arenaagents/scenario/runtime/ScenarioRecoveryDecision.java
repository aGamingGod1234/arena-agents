package dev.agaminggod.arenaagents.scenario.runtime;

import dev.agaminggod.arenaagents.scenario.ScenarioPresets;
import java.util.List;
import java.util.Objects;
import java.util.Set;

public record ScenarioRecoveryDecision(
		boolean recoverable,
		String dimensionId,
		List<String> boundAgentsToRemove,
		String failureReason
) {
	public ScenarioRecoveryDecision {
		dimensionId = Objects.requireNonNull(dimensionId, "dimensionId must not be null");
		boundAgentsToRemove = List.copyOf(Objects.requireNonNull(boundAgentsToRemove, "boundAgentsToRemove must not be null"));
		failureReason = Objects.requireNonNull(failureReason, "failureReason must not be null");
		if (recoverable && (!boundAgentsToRemove.isEmpty() || !failureReason.isEmpty())) {
			throw new IllegalArgumentException("recoverable decision must not remove agents or have a failure");
		}
	}

	public static ScenarioRecoveryDecision evaluate(ScenarioRunSnapshot snapshot, Set<String> availableDimensions) {
		Objects.requireNonNull(snapshot, "snapshot must not be null");
		Set<String> dimensions = Set.copyOf(Objects.requireNonNull(availableDimensions, "availableDimensions must not be null"));
		boolean installedMapMatches = ScenarioPresets.all().stream()
				.anyMatch(preset -> preset.id().equals(snapshot.scenarioId())
						&& preset.mapVersion().equals(snapshot.mapVersion()));
		if (!installedMapMatches) {
			// A save from an older installed map cannot be restored; fail closed instead of throwing on the server tick.
			return failed(snapshot, "UNSUPPORTED_SCENARIO_VERSION");
		}
		if (dimensions.contains(snapshot.dimensionId())) {
			return new ScenarioRecoveryDecision(true, snapshot.dimensionId(), List.of(), "");
		}
		return failed(snapshot, "MISSING_SCENARIO_DIMENSION");
	}

	private static ScenarioRecoveryDecision failed(ScenarioRunSnapshot snapshot, String reason) {
		return new ScenarioRecoveryDecision(
				false,
				snapshot.dimensionId(),
				snapshot.boundAgentIds().stream().sorted().toList(),
				reason
		);
	}
}
