# d38: death recovery

**Final body: 9/9 scripted returns reached the drop point, plus 3/3 ladder returns. Four 60-minute Sol games recorded three deaths; the next pick arrived after 0.81, 0.37 and 2.46 minutes.** Mining without a pick totalled 0.158 min (9.5 seconds). These live results combine this change with the v2 camps, ladders and spare kits. They do not isolate route memory.

Branch `claude/d38-recover`, based on `bc23e272`. Integration `81f5d9d8`, including End fix `cba90f01` and v2 checkpoint support, was merged at `45d78f8b`. Final tested runtime is `a70614d5`; the documentation commit follows it. No push, PR or integration merge was performed.

Final installed jar SHA-256: `bb1d1549c1fffbf35c4130814a018ac65a7edd8c1c13e87015dd93daf5bc3b0a`. It matched all four fixture worlds. External artifacts: `arena-beat-game/evals/d38-recover/`.

## Implementation

- `RouteMemory.java` and `WalkedRoute.java` retain actual grounded, swimming and climbable movement per player UUID and dimension. Death and large discontinuities disconnect routes. Portal transitions connect dimensions; End entry is one way. Returned waypoints preserve turns and compact straight segments. Entry joins use the same standing height. Memory survives respawn for the server session; it is not persisted across server restarts or fabricated from checkpoint terrain.
- `ServerRetraceController.java` implements `travelTo({x,y,z,dimension,retrace:true})`. It follows remembered waypoints through ordinary travel, navigation and shaft controllers with their fresh terrain, lava, brink and construction checks. The model chooses the goal and `build` permission. Missing routes return `NO_ROUTE`. Portal crossings use the existing dimension-transition cancellation; the caller reissues after crossing.
- The live ladder investigation added remembered climbable cells, alignment before a vertical entry, guarded viewing of the entry/exit, and one navigation leg through a ladder column to its supported landing. Ordinary navigation cannot finish midway up a ladder. This also handles a remembered jump into a higher rung from adjacent ground. The body uses remembered contact information, not an unseen block scan.
- Death capture remains authoritative after the old body relocates to spawn. Standing-height rounding and the travel controller’s support anchor avoid below-floor and overhanging portal-rim waypoints. Exact vertical travel legs use the existing pillar/shaft mechanics.
- `respawn-recovery.mjs`, its wake wrapper, the observation adapter and wire schema expose route length, remembered hazards and tool requirements; nearest seen wood/planks/table/chest; and the basic-tool path. Sightings come only from blocks already emitted to the player and remain last-seen, availability-unverified facts.
- Void losses are gone. Lava facts distinguish burned drops from possible drops beside the pool. The wake no longer expires unloaded drops solely from wall time. The five-minute clock remains a proximity/simulation-distance estimate of loaded ticking time, not a hidden chunk-state query.
- Nether recovery warns when no gold is worn, distinguishes carried/lost gold from armour, and explains that brutes attack through gold. The End platform sentence is reused exactly from the integrated End fix. Stronghold planks supply wood and blocks; bookshelves drop books, so they are not counted as planks.
- `plan-checks.mjs` and `live-task-view.mjs` support measurable distance (`near:minecraft:the_nether@27,83,25*4`), held-item and tool-tier checks. Distance and tool rank provide intermediate progress to the existing wake tracker. The facts give concrete check examples; the model still authors the plan. No automatic recovery/crafting routine was added.
- Native tool definitions, protocol normalization, generated control reference and regression witnesses were updated. The decision launcher has an explicit same-family-judge opt-in because this task requests a Codex player and judge; its default guard remains.

## Scripted production-body bar

`scripts/quality/test-route-recovery-live.mjs` boots the real Fabric server, registers a scripted stand-in through the production bridge, walks a route, kills it, respawns it and chooses retrace to the recorded death point. Portal transitions are reissued through the normal lifecycle. No model is called. Fixture commands construct the course, supply the pre-death kit and cause death; item-side inspection is operator-only and never drives movement.

Three lives per scenario share a fresh scenario world, seed `20261024`. Peaceful difficulty controls ordinary combat. The End course has an existing end-stone bridge/landing. Combat performance and construction of a missing End bridge are not measured. Respawn must reach the prepared camp. No replacement tools or blocks are granted after death.

| Route | Seconds to drop point, runs 1 / 2 / 3 | Arrival | Pick held after pickup phase |
|---|---|---:|---:|
| cave | 10.831 / 10.700 / 10.716 | 3/3 | 3/3 |
| nether | 20.942 / 21.206 / 21.154 | 3/3 | 3/3 |
| end | 11.836 / 11.645 / 10.900 | 3/3 | 3/3 |
| 20-block ladder | 12.990 / 13.053 / 12.997 | 3/3 | 1/3 |

All arrivals were within one block of the recorded death point. Main bar: **9/9 arrivals and 9/9 picks**. Additional ladder bar: **3/3 arrivals and 1/3 picks**; some drops scattered off the landing. Arrival is the requested route-success criterion. Optional pickup is reported separately; an earlier fixture incorrectly treated a missed scattered item as a route failure. Raw inventories and all failed attempts remain available.

Artifacts: `model-free/current/results.json`, `model-free/ladder-current/results.json`, and `installed-jar-hashes.jsonl`. Earlier accepted jars also passed 9/9; they are not substituted for this final artifact.

An independent real-action tool benchmark measured **11.312 s for three adjacent logs**, **14.944 s (0.25 min) to a wooden pick**, and **21.544 s total (0.36 min) to a stone pick**. Travel and model thinking are extra. A real eight-block dig-down/retrace-up trial passed through the existing shaft and construction controllers (`model-free/tool-path.json`, `model-free/shaft.json`).

## Decision evaluation

Player: Codex `gpt-6.1-sol`, low effort, default tier. Judge: Codex, medium effort, same-family judging explicitly enabled in both arms. Baseline: `bc23e272`. The final coordinator is unchanged from the `988a3dfa` prefix tested in development replay v5; later changes are Java/body and fixture changes.

### Fresh final check

Four unused Oct24 snapshots were frozen after implementation and evaluated without further code tuning. They cover an underground respawn, a Nether death and two End re-entries. They were not sampled in development v1-v5. Corpus SHA-256: `3722c299df0d8263d1abc7c9454390194f40a003db29f9b92fb370a67f53c5c7`.

| Fresh case | Base good | Candidate good |
|---|---:|---:|
| fresh-oct24-underground | 0/3 | 0/3 |
| fresh-oct24-nether | 0/3 | 0/3 |
| fresh-oct24-end-2 | 1/3 | 2/3 |
| fresh-oct24-end-3 | 0/3 | 0/3 |
| **Total** | **1/12** | **2/12** |

The harness regression gate passed. This is weak absolute performance, not evidence of a better recovery policy. The first attempt failed during baseline Codex SQLite initialization before baseline choices; candidate-only output and the failure log were retained. The unchanged frozen corpus then completed in fresh worktrees at concurrency 2 (one provider session per arm), with no render/provider sample errors. Artifacts: `decision-fresh/`, `decision-fresh-retry/`.

### Published d31 and development replays

The nine d31 cases are published historical replays, not newly unseen holdouts. Four initial Oct24 snapshots were frozen before implementation, but this 13-case set was sampled repeatedly during development. Corpus SHA-256: `f3259de9dfe7d9e9e8445d5b06d017089cd7fd91739c786c77afb7efe17c4bfb`. Screening and independent confirmation each used three samples per case. Baseline samples used the harness cache.

| Primary case | Base good, both rounds | Candidate good, both rounds |
|---|---:|---:|
| respawn-kit-end-void-04 | 5/6 | 2/6 |
| respawn-kit-nether-05 | 5/6 | 6/6 |
| respawn-kit-nether-06 | 6/6 | 6/6 |
| respawn-kit-nether-07 | 6/6 | 6/6 |
| respawn-nether-lava-01 | 0/6 | 4/6 |
| respawn-nether-lava-02 | 0/6 | 3/6 |
| oct24-underground-empty | 0/6 | 0/6 |
| oct24-lava-kit-loss | 0/6 | 0/6 |
| oct24-nether-no-gold | 0/6 | 0/6 |
| oct24-end-no-kit-return | 0/6 | 3/6 |
| **Primary ten** | **22/60** | **30/60** |

This subset is descriptive, not a separately powered significance gate. The four initial Oct24 cases score **0/24 base versus 3/24 candidate**, all three good candidate choices in End preparation. New Nether cases still show unsafe portal entry despite the warning. The valid End-void case remains in the primary set, including its regression from 5/6 to 2/6.

The three legacy End-entry rubrics reward immediate portal entry with empty inventory. They contradict the eight Oct24 no-kit platform deaths, so they are reported separately, as requested. Their data/rubrics were unchanged and facts were not tuned to pass them.

| Separate legacy unsafe End rubric | Base good | Candidate good |
|---|---:|---:|
| respawn-kit-end-01 | 6/6 | 0/6 |
| respawn-kit-end-02 | 6/6 | 0/6 |
| respawn-kit-end-03 | 6/6 | 0/6 |
| **Separate total** | **18/18** | **0/18** |

All thirteen: screening **19/39 base, 12/39 candidate**; confirmation **21/39 base, 18/39 candidate**. Final v5 regression gate **PASS**, confirmation p(worse)=0.2817. Earlier results remain: v1 8/39 vs19/39; v2 confirmation18/39 vs21/39 PASS; v3 confirmation12/39 vs21/39 FAIL; v4 screening16/39 vs19/39 PASS. Repetition and small samples limit any improvement claim.

The evaluator stops at the first accepted call. Task-context requests and broad surveys can be neutral before a concrete recovery action appears. These replays test wake decisions, not execution of a complete recovery plan or new body route memory.

## Four live Desktop games

All used `api/win-long.sh desktop-lan`, Sol low/default, a 60-minute game window and the updated v2 coordinator. Runtime/checkpoint provenance and source immutability were verified in every captured result: checkout `0ab48956`, jar SHA `74fc0c57a943f71b9f3119af936e7f4772dbf2a755e50410fcb7b0ed0303c2e5`, quality capture verified, `sourceChangedDuringRun=false`.

| Game | Checkpoint | Observed ready min | Deaths | Death → next pick, min | Mining with no pick, min |
|---|---|---:|---:|---|---:|
| a | `8-lava-pool-v2.json` | 60.368 | 0 | no death | 0.000000 |
| b | `9-nether-entry-sol-bed-gold-v2.json` | 60.482 | 0 | no death | 0.000000 |
| c | `8-lava-pool-123456789-v2.json` | 60.336 | 1 | 0.8134 | 0.000000 |
| d | `9-nether-entry-8675309-v2.json` | 60.238 | 2 | 0.3675 / 2.4600 | 0.158383 |

Full tags are `w-desk-d38-recover-a/b/c/d`. All runs ended at the time budget; this is not a game-completion result. Total recorded ready time: **241.425 min**, including small setup/closure margins around the four 60-minute windows. Three deaths: lava once, piglin brute twice. The first two recoveries took stone picks from the prepared chests. The final recovery crafted a wooden pick from birch. **3/3 had a pick within 2.46 min; median 0.8134 min.** Full prior gear-type sets were not restored.

Mining without any pick in inventory: **0.158383 min (9.503 s)**. Its empty-hand subset was **0.053383 min (3.203 s)**. Deep Overworld (y−60…−40) no-pick mining: **0**. Maximum ready-observation gap was **7.971 s**. These are sampled wall-time estimates, not exact game-tick measurements.

The model issued **12 retrace calls**: 3 arrived, 7 refused with `NO_ROUTE`, 1 timed out and 1 was cancelled. These include trips to remembered places, not only drop retrieval. The first Nether re-entry after death wore gold and carried 194 blocks; it occurred 20.42 min after the death. Both Nether deaths were to brutes, which gold does not pacify. No live End death occurred.

The live ladder climb exposed omitted off-ground history (53 cells unchanged from y−49 to y60). This was fixed afterward, together with same-height route joins and climb-to-landing execution. **Those final ladder/body corrections were tested with the scripted trials, not another four live games.** The live results therefore do not certify the final ladder changes under model control. Adoption of the new measurable plan checks was not separately quantified.

A/B/C wrappers exited 0. D exited 1 with `failureCategory=budget`, `classification=TIMEOUT`, `factualSuccess=true`, and clean cleanup at the wall-clock deadline. Its complete 60.238-minute observation stream and worst recovery were retained. This was not excluded as a successful-only sample.

### Against the supplied Oct24 evidence

The brief reports **307 min of bare-hand mining (24%)**, **214 min at y−60…−40**, and **40/62 deaths without a pick 10 minutes later** across 27 games. The four new games instead recorded three pick replacements within 2.46 min and 9.5 seconds of no-pick mining. Definitions, coverage and v2 starting supplies differ; this is not a randomized comparison.

For a consistent measurement, the same streaming script was applied to 18 available recordings that started on Oct24 in Asia/Singapore. All were verified Codex Sol low/default. They contain **906.502 observed min, 35 recorded deaths, 206.900 no-pick mining min (22.824%), and 104.123 deep-Overworld no-pick min**. The new four contain **0.158 / 241.425 min (0.0656%)**. A broader 22-recording historical subset also remains; four of those started the previous evening and are not silently included in the same-day comparison.

`recovery-metrics.mjs` streams protocol rows. It counts observed active `break_block`/`dig_to`, or control attack aimed at a block, while inventory has no pick. The first ready inventory containing a pick ends the death-to-pick clock. Observation gaps are reported rather than capped. A synthetic interval check verified exclusion of entity-directed attack and the replacement-pick clock. All metrics are operator analysis and never feed the model. Artifacts: `d38-recover-live-metrics.json`, `live-action-audit.json`, `oct24-starts-same-metric.json`, `historical-profiles.json`.

## Gates and remaining limits

- Final `./gradlew build verifyCore --offline`: PASS, **2,557,894** protocol/core assertions and **442** voice-addon assertions.
- Coordinator `npm test`: **6,950 pass, 11 known Linux/Windows platform failures, 75 skipped**. An earlier run had one extra timing-sensitive executor failure; focused rerun5/5 and the final full run passed it. The coordinator has not changed since that full run.
- `npm run test:contracts`: **634/634 PASS**. Focused final recovery facts: **11/11 PASS**. Native action, distance/progress and route-graph regressions passed.
- Dynamic-tool byte budget rose exactly **317**, 30,929→31,246; generated API reference **22**, 14,722→14,744; plan schema **36**, 1,392→1,428. Matching tool-schema budget: 30,389→30,706. No unrelated margin was added.
- Live means real installed mod, production coordinator and provider; the scripted route tests mean real server/body with a model-free caller. Pure core/contract tests are backend checks. The eleven platform-specific unit failures were not separately validated on Windows.
- Route memory is session-only. Routes and resource sightings may have changed. Missing/broken terrain can still require a fresh model decision. The loaded-item clock is an estimate. Combat, arbitrary item scattering, missing End-bridge construction and a live End recovery remain unverified here.
- The small fresh decision check remains weak (2/12 versus1/12). The task adds capability and facts; it does not guarantee that Sol follows them.

## Operations and reproducibility

Launchers and frozen corpora are under `evals/d38-recover/launchers/` and the external evaluation directory. Heavy Mini PC jobs used live/eval/Gradle slots. Desktop jobs used guarded starts and bounded resource settings. A refused test start was left refused; a duplicate queued Mini test was cancelled when Desktop capacity became available. Protocols stayed on Desktop; streaming derived metrics and the standard credential-excluding result packer supplied the report.

The custom launcher initially restored a saved PowerShell metadata wrapper instead of a plain runner path. The exact malformed restoration was repaired to the prior `fae8af21` root/jar, and future captures cast plain strings. Running games had already selected their immutable checkout and were unaffected. No other worker or the FORK-Tools queue was stopped.
