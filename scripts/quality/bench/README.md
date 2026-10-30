# Reflex bench

Eight rooms in `../reflex-rooms.json`, each 3–6 minutes. The model authors its own policy. The bench only builds fixtures and observes server facts. Kits represent mining, Nether entry, or End entry progression; no objective items are supplied. R-FLOOD reuses W-FLOOD geometry and kit.

| Room | Server predicate | Window |
|---|---|---|
| R-BLAZE | 3 blaze rods | 5 min |
| R-GHAST | Within 2 blocks of gold marker, no deaths | 5 min |
| R-CREEPER | 6 raw iron AND 4800 game ticks, no deaths | 5 min |
| R-SKELETON | 4800 game ticks, no deaths | 5 min |
| R-FLOOD | 6 raw iron, no deaths | 6 min |
| R-VOID | Within 2 blocks of far bridge marker, no deaths | 5 min |
| R-TOOLBREAK | 8 raw iron; held pick has 2 durability, spare supplied | 3 min |
| R-PIGLIN | A barter output not present in starting gear AND 3600 ticks, no deaths | 5 min |

Every room sets `requireSampledSuccess`: factual completion of a different model goal cannot bypass its evaluator predicate. Ticks measure survival at normal server speed (4800 = 4 minutes). Position and inventory predicates stop early. Task provenance is not guaranteed: these are inventory checks, so inspect the trace when provenance matters. Legitimate building, cover, retreat and other model choices remain allowed. Skeleton uses the brief's survival alternative. Ghast uses the marked-spot alternative. Main 37724669 has no reflex layer, so its firing count is unknown.

The copies under `/home/agaminggod/Desktop/Projects/arena-beat-game/api/` are runnable. The tracked versions here are the source for those copies. Reinstall after merging with `cp scripts/quality/bench/{bench.sh,bench-ladder.sh,bench-score.py} /home/agaminggod/Desktop/Projects/arena-beat-game/api/`.

```bash
B=/home/agaminggod/Desktop/Projects/arena-beat-game
# Fresh tag required. Sequential rooms; one live slot at a time, subscription auth, medium effort.
"$B/api/bench.sh" trial /absolute/main.jar "$PWD" claude R-TOOLBREAK R-BLAZE
# Default selection: all eight rooms.
"$B/api/bench.sh" all-rooms /absolute/main.jar "$PWD" claude
# Full 23-step ladder, same scorer (or append specific L-steps).
"$B/api/bench-ladder.sh" ladder /absolute/main.jar "$PWD" claude
python3 "$B/api/bench-score.py" trial
```

For unattended work wrap the command in `systemd-run --user --collect --unit=aa-UNIQUE ...`; `ladder-sub.sh` owns live-slot admission. Codex is refused unless that launcher explicitly selects `--service-tier default`. There is no priority or fast tier override in this bench. Do not run more than two owned benches at once. Run build and test checks before live measurement: Python tests can create cache files under fingerprinted coordinator sources, which invalidates concurrent measurements. Existing run artifacts are never overwritten; a fresh tag is required even for retries. Logs and `.done` markers remain in `sub/runs/<tag>-<provider>-<room>-r1*`. The scorer reads only the top-level results once, resolves content-addressed report details, retains incomplete measurement status, and reports absent telemetry as `?`. Minutes are played wall time, including failures; totals preserve unknown counts. Reflex counts use `metrics.reflexFirings` or `metrics.reflexFiringsCount` when available. Unavailable runs have a row rather than disappearing.

Provider-free validation launches an isolated server with coordinator autostart disabled. It proves setup and hazards, verifies the initial predicate is false, changes the real server inventory/position and fast-steps survival ticks, then verifies success and death rejection. It removes hazards only for these controlled predicate transitions. This is not a model performance test.

```bash
export JAVA_HOME=/usr/lib/jvm/temurin-25-jdk-amd64
"$B/slot.sh" live python3 scripts/quality/validate-reflex-rooms.py \
  /absolute/main.jar /absolute/server-template /absolute/FRESH-validation-dir
# Existing owned disposable server alternative:
node scripts/quality/validate-reflex-rooms.mjs --rcon-port 28002 \
  --password-file /absolute/password-file --out /absolute/validation.json
node --test coordinator/test/quality-reflex-rooms.test.mjs coordinator/test/quality-ladder.test.mjs
python3 scripts/quality/bench/test_bench_score.py
```
