# d38 save points

The `checkpoints/` directory is the committed source of the version 2 fixtures. Identical files live alongside the originals in `arena-beat-game/long/checkpoints/`. Keep the original JSON files for reproducing past results.

Use this branch's coordinator root, or an integration checkout containing its `usedBedSpawn` support. An older coordinator does not restore these vanilla bed spawns.

```bash
B=/home/agaminggod/Desktop/Projects/arena-beat-game
ROOT=/home/agaminggod/Desktop/Projects/aa-d38-savepoints
CHECKPOINT="$B/long/checkpoints/9-nether-entry-sol-bed-gold-v2.json" \
  "$B/api/long-sub.sh" d38-nether "$B/jars/d25-bb227cbc.jar" "$ROOT" codex 90
```

For independent seeds, select `9-nether-entry-{20261024,8675309,123456789,987654321}-v2.json`. Matching natural lava-pool starts are `8-lava-pool-<seed>-v2.json`. Prefer `6-end-portal-room-v2.json` when measuring the agent's first End crossing; it lets the model enter the portal itself. The two direct End variants now begin after a player has secured the arrival route and dug an island shelter.

Regenerate the fixture JSON from unchanged originals and the committed evaluator surveys:

```bash
python3 scripts/quality/build-savepoints-v2.py \
  "$B/long/checkpoints" evals/d38-savepoints/surface-survey.json \
  evals/d38-savepoints/checkpoints
```

The generator also reads `lava-survey.json` beside its output directory. `manifest.json` records the originals' hashes. `surface-survey.json`, `nether-survey.json`, `lava-survey.json`, `portal-room-truth.json` and `structure-truth.json` are evaluator-only truth, never agent memory. `run-long.mjs` passes only the fixture setup to preparation and keeps the player's goal unchanged.

For a model-free fresh-world check, under a live slot:

```bash
export JAVA_HOME=/usr/lib/jvm/temurin-25-jdk-amd64
export ARENA_HEADLESS_SERVER_TEMPLATE='/home/agaminggod/.t3/worktrees/agents arena/t3-ba7399a1/runtime/server-template'
"$B/slot.sh" live node scripts/quality/test-savepoints-live.mjs \
  evals/d38-savepoints/checkpoints/6-end-portal-room-v2.json \
  /tmp/d38-savepoints-my-check "$B/jars/d25-bb227cbc.jar"
```

`verify-savepoints-v2.sh` checks a directory, optionally sharded. Run the launcher with `setsid -f` when unattended; it writes server logs, `result.json`, and `status-<shard>.txt` under its output directory. Original exploratory runs and retries remain under the external evaluation directory. Accepted results in this repository are selected only when their SHA-256 matches the current fixture.

The checker keeps monsters and the dragon enabled. It samples at least 60 wall seconds and 1,200 game ticks, checks the carried and spare kits, uses the real body respawn action, climbs recovery shafts with vanilla movement, and removes the bed before another death. In the disposable test copy only, a distinctive world spawn on a safe platform proves fallback. The current body's respawn action can report `CANCELLED` during its transition to `STARTING`; the checker verifies the living player's actual position and records that receipt.
