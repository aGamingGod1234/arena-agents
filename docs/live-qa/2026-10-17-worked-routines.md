# Optional construction and blaze examples

The `control:routines` capability topic contains a shared prelude and four ArenaScript bodies: bucket casting/ignition, pillaring, bridging (including a Nether mode with three-wide footing and rails), and a shield/cover combat exchange. The skill points to it during safe preparation. The model chooses whether to read/adapt a body and supplies the geometry, material, target, route and thresholds. No gameplay policy was added to the mod or coordinator.

The portal example includes a two-waterfall mold pattern and bounded batches. Its tests supply the mold, dry scaffold and lava tray. They establish the casting, water recovery, drainage and ignition mechanics; they do not establish that an AI constructs that mold or completes L-A5 autonomously. The blaze example performs one shot or sword swing and returns to cover, leaving repeated exchanges and rod collection to the model. A stopped program leaves its next defense to the model or an already chosen standing guard.

## Reproduce the live mechanics check

Run `npm ci` in `coordinator/`, build the current JAR, and supply a clean Fabric server template compatible with that JAR. From the repository root:

```bash
export JAVA_HOME=/usr/lib/jvm/temurin-25-jdk-amd64
export ARENA_HEADLESS_SERVER_TEMPLATE='/path/to/clean/server-template'
/home/agaminggod/Desktop/Projects/arena-beat-game/slot.sh live \
  node scripts/quality/test-routines-live.mjs runtime/routines/fresh-run
```

The output directory must be fresh. The script copies the template, uses `SLOT_PORT_BASE`, launches an isolated server, and executes the exact Markdown code fences through `NativeProgramExecutor`, the production executor behind `runProgram`, and the authenticated production bridge. Fixtures use operator commands for setup; the programs use ordinary survival actions and player-visible queries. There is no AI provider call in this check. The server is stopped in `finally`.

`manifest.json` records JAR/reference hashes; `routine-examples.md` preserves the tested reference. `results.json` retains parameters, source hashes, terminal receipts, fresh observations and per-case verdicts. `actions.json`, `server.log` and blaze before/after health witnesses provide detail. `secret.txt` and the copied server properties are private fixture credentials, not report artifacts.

Default coverage is three pillar heights, three bridge directions/lengths, three Nether crossings, three water molds, a ten-block frame in four batches with source recovery/ignition, and melee/short-bow/long-bow exchanges. A pass requires natural program exhaustion and the physical predicate: reached height/segment destination, verified obsidian, or undamaged return with observed enemy health loss. Final portal ignition additionally verifies a purple portal block in the program. A checkpoint or danger handoff is recorded as a failed completion, even when stopping was the intended safe response.

Use `ROUTINES_ONLY=pillar|bridge|nether|portal|frame|blaze` to select a group. `ROUTINES_WATCH=1` is an explicit development mode: after a group, write the next group (or `stop`) to `<out>/next`; it waits at most ten minutes and keeps its live slot until cleanup.

Node coverage checks capability pagination, compilation of the published sources, 24 initial danger cases and refusal to step from a changed support. The decision-eval smoke at `arena-beat-game/evals/routines-1` ended with signal/exit 143 before producing a complete report; it supplies no model-selection or before/after claim.

Final replay: `runtime/routines/final/summary.json` records **19/19 passing checks**, all at 20 HP: pillar heights 1/2/3 (3/3), bridge spans 2/3/4 in three directions (3/3), Nether railed spans (3/3), east/south/falling-water molds (3/3), one complete ten-block frame in four batches with two water recoveries and verified ignition (4/4 batches, 1/1 frame), and one melee plus bow exchanges at roughly 7/10 blocks (3/3). Blaze health fell from 20 to 14/10/13 while the player returned to cover at 20 HP. All 19 recorded program source hashes match the shipped reference; the server exited after the replay. Prepared fixtures and the missing autonomous selection/build/Nether-entry measurement remain the limits.
