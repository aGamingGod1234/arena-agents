# Routine action replay provenance

`routine-action-replay.json` copies `source`, `state.observation` and the last
`state.previousObservations` entry from the existing train case
`melee-threat-low-health-01` in the q8 decision-eval corpus. Its source metadata
identifies the trace, line 1262, observation hash and source moment. The original
corpus observation is retained without edits in this fixture; the source hash is
the corpus's trace provenance, not a hash of this newly formatted JSON file.

`routine-action-replay.test.mjs` makes the following documented derived contract
variants. They are not independent source moments or additional decision samples.

| Variant | Edits shared with the recorded moment |
| --- | --- |
| `routine-travel-damage` | Dispatch an authored `navigate_to` to the observed final position plus 30 X and 40 Z; retain the two recorded player health values and positions. |
| `routine-fight-damage` | Dispatch an authored `fight_target` for the recorded last attacker, with `fleeAtHealth:6`. |
| `routine-travel-storm` | Travel variant with open sky, rain and thunder in both observations. |
| `routine-travel-clock-covered` | Travel variant under cover with rain and a clock in otherwise unused hotbar slot 7 in both observations. A clock has no relevant item tags, so tag counts remain unchanged. |
| `routine-travel-reduced-debug` | Travel variant with reduced debug info enabled in both observations. The authored destination is unseen and no target entity or observed marker grants its distance. |
| `routine-travel-other-handle` | Travel dispatch with a distinct observed action handle, proving the prior runtime arguments are not assigned to another running action. |

All variants use the same goal revision and day time 11000 in both observations.
Open sky is explicit except in the covered variant. Rain, thunder and reduced
debug values are set consistently in both observations. The earlier observation
is first delivered inactive to start a model turn. The test submits `act` through
the production normalizer and coordinator `executeTool`, captures the emitted
`action_command` handle, and delivers a quiet running heartbeat with that handle
before the recorded health decline. Sequences are renumbered monotonically.
The changed-handle variant deliberately uses a different observed handle.

The runtime owns all authored arguments. No destination, bailout threshold or
synthetic argument property is injected into the observation wire. Assertions
inspect the actual production steer input at the planner boundary. The final
cancellation acknowledgement is test cleanup, not an invented game outcome or
a decision-eval canned reply. In-memory planner and bridge replace the model and
server; no model, network or live game runs.

Run from `coordinator`:

```sh
node --test --test-timeout=30000 test/routine-action-replay.test.mjs
```

The stock q8 decision-eval renderer replays prior observations and plan/memory
tools but never dispatches prior model actions. Consequently these six names are
contract test variants, not accepted `--ids` for that renderer. An action-bearing
decision gate requires extending its setup state to execute authored tools and
remap their emitted handles. Copying these variants into the train directory
alone would silently omit the arguments again. Until that renderer support exists,
new action-bearing model decision coverage remains owed; these tests establish
production input coverage only.
