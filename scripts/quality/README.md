# Live scenario quality harness

The harness runs fixed-seed Minecraft scenarios against a real headless Fabric server, the live coordinator and a real model provider, then extracts token, cost, survival and progress metrics from the retained traces. Its paired mode compares two pinned builds (arm A and arm B) in counterbalanced order and produces one verdict.

## Requirements

Run from the repository root with:

- Node 22 or newer
- Java 25
- a built mod JAR (`.\gradlew.bat build`)
- a prepared Fabric server template (`scripts/prepare-headless-server-template.ps1`)
- a signed-in Claude or Codex CLI

## Paths and environment

| Setting | Argument | Environment variable | Default |
|---|---|---|---|
| JDK | `--java PATH` | `ARENA_HEADLESS_JAVA`, then `JAVA_HOME` (uses `bin/java`) | `runtime/toolchains/temurin-25/jdk-25.0.3+9/bin/java` in this checkout |
| Server template | `--server-template PATH` | `ARENA_HEADLESS_SERVER_TEMPLATE` | `runtime/server-template` in this checkout |
| Harness identity | `--harness-commit HASH` | `ARENA_QUALITY_HARNESS_COMMIT` | none |
| Output | `--out DIR` | none | `runtime/quality-results/quality-<time>` |

Arguments win over environment variables. `--port-base N` assigns bridge, RCON and Minecraft to `N`, `N+1` and `N+2`, and fails if one is occupied. Without it, the existing launcher allocates free ports. On a synced checkout without `.git`, pass `--source-commit HASH`; expected artifact fingerprints still attest the actual files, but Git cleanliness and HEAD cannot be verified there.

## Bed parity fixture

`test-bed-live.mjs` checks crafting from 3 wool + 3 planks, two-block placement, vanilla night skipping, the saved bed spawn, and daytime/nearby-monster rejection messages through production bridge actions. It uses an isolated flat-world fixture and no model calls; it does not measure model choices. Build the candidate first, then run with `JAVA_HOME` and `ARENA_HEADLESS_SERVER_TEMPLATE` set:

```bash
/home/agaminggod/Desktop/Projects/arena-beat-game/slot.sh live node scripts/quality/test-bed-live.mjs runtime/bed-live
```

Use a fresh output directory. `manifest.json` identifies the JAR; `actions.json`, `sleep-evidence.json`, `daytime.json`, `monster.json` and `server.log` retain the evidence. Ports come from `SLOT_PORT_BASE`.

## Barter fixture

`test-barter-live.mjs` checks piglin bartering through production actions: with a golden helmet worn, a gold ingot handed over with `interact_entity` and one dropped ahead with `drop_item` are each taken by a calm adult piglin and answered with a return that `pick_up_item` collects; a `drop_item` stack keeps the player as its thrower, as a vanilla Q drop does. No model calls. `BARTER_JAR=PATH` runs the same fixture on another build.

```bash
/home/agaminggod/Desktop/Projects/arena-beat-game/slot.sh live node scripts/quality/test-barter-live.mjs runtime/barter-live
```

### Barter and pearl odds

Loot rolls do not come from the piglin or the mob: piglin barters draw from the world's `minecraft:gameplay/piglin_bartering` random sequence and enderman drops from `minecraft:entities/enderman`, each seeded by the world seed and the table id alone. One save point therefore repeats the same barters and drops in every game (on 2026-10-23 three games from `9-nether-entry-sol-bed-gold10` all got the same 6 pearls from 10 gold). A save point's `setup.randomSalt` (a 32-bit integer) runs vanilla `random reset * <salt>` before the fixture commands, which reseeds every loot sequence; `run-long.mjs --checkpoint` picks a fresh salt per game and prints it (`loot salt N`), `--random-salt N` repeats one, `--random-salt none` keeps the world default. Structure chest contents are fixed when the chest generates and do not change with the salt; mob AI and spawns already differ per game.

`test-barter-odds-live.mjs` measures real barters with 8 adult piglins taking dropped ingots, reseeding the barter sequence per trial: 10, 30 and 60 ingot trials (`BARTER_TRIALS=10x40,30x15,60x10`), game seconds per ingot with one and with eight piglins, and two controls that must repeat exactly (the unsalted world default twice, one salt twice). Vanilla only; no agent body or model. `test-enderman-live.mjs` covers the enderman side: looking past a calm one versus at its head, fights with `fight_target` on open ground and from inside a 1-wide, 2-high tunnel (`ENDER_FIGHTS`), and the salted drop rate (`ENDER_KILLS`).

```bash
/home/agaminggod/Desktop/Projects/arena-beat-game/slot.sh live node scripts/quality/test-barter-odds-live.mjs /tmp/barter-odds
REFLEX_ONLY=look-past,look-at-head,fight-open,fight-tunnel,drop-odds /home/agaminggod/Desktop/Projects/arena-beat-game/slot.sh live node scripts/quality/test-enderman-live.mjs /tmp/enderman
```

## Forest flee fixture

`test-flee-forest-live.mjs` sends the production `flee_from` from six forest spots of a saved run world, a zombie 4 blocks away on each side (24 flees), and reports net ground speed, sprint share and outcome per flee in `flees.json` and `summary.json`. Set `FLEE_WORLD` to a saved world directory (copied, never modified); the d2b-iron-c world is the default fixture. Each flee starts with an empty seen-terrain memory, as after a respawn (`FLEE_FRESH=0` keeps it); `FLEE_ONLY=5,6` and `FLEE_REPEAT=N` select and repeat flees. No model calls.

```bash
FLEE_WORLD=/path/to/saved/world /home/agaminggod/Desktop/Projects/arena-beat-game/slot.sh live node scripts/quality/test-flee-forest-live.mjs runtime/flee-forest
```

## Single-arm runs

### Route ladder

`ladder.json` defines 23 short route links and alternative branches from empty inventory to the dragon. `run-ladder.mjs` accepts the single-arm options below, defaults to all ladder IDs and one repetition, and adds `--scenarios L-A1,L-A3`, `--scenario-file FILE`, and `--parallel N` (1..8). Parallel runs require `--port-base`: worker 0 owns base/base+1/base+2, worker 1 owns base+10/base+11/base+12, and so on. Every attempt uses the existing launcher, a separate template copy, fresh fixed-seed world, unique artifacts and provider workspace. Port conflicts fail the attempt; unrelated servers stay running. Allow at least 2 GiB heap plus coordinator/model overhead per worker. Paired A/B runs retain the original sequential runner.

```powershell
node scripts/quality/run-ladder.mjs --scenarios L-A1,L-A3 --provider codex --model gpt-6.1-sol --service-tier default --parallel 2 --port-base 28100 --jar BUILD.jar --server-template TEMPLATE --java JDK/bin/java.exe --out runtime/ladder-subset
node scripts/quality/run-ladder.mjs --provider claude --model claude-opus-5-5 --parallel 2 --port-base 28300 --jar BUILD.jar --server-template TEMPLATE --java JDK/bin/java.exe --out runtime/ladder-claude
node scripts/quality/run-ladder.mjs --report runtime/ladder-subset/results.json runtime/ladder-claude/results.json
```

### Linux live ladder

Build with `JAVA_HOME=/usr/lib/jvm/temurin-25-jdk-amd64 ./gradlew build`, then run `npm ci` in `coordinator/`. The single-arm quality runner selects the Node POSIX launcher on Linux and keeps the existing PowerShell launcher on Windows. The POSIX launcher supports fresh natural worlds with one repetition per matrix scenario (the ladder expands `--runs` into independent attempts); it uses the same scenario runner, spawn validation, observer, evaluator and capture closeout. Paired acceptance runs still require the Windows launcher.

Use a clean prepared template at `runtime/server-template`: `fabric-server-launch.jar`, `server.jar`, its `libraries/`, `mods/fabric-api-*.jar`, `mods/fabric-carpet-*.jar`, `eula.txt` and `server.properties`. A template prepared on Windows is reusable on Linux; copy it without saved worlds, symlinks, logs or its old `arena-agents-*.jar`. Check its `template-manifest.json` against this checkout's `gradle.properties`. The launcher installs the `--jar` candidate into each isolated copy and binds the offline game and bridge to loopback.

On the shared Mini PC, **every server must hold its own machine-wide slot**. Use one ladder lane per wrapped process; run separate wrapped processes for concurrency. The slot's port variable must expand inside the wrapper:

```bash
export JAVA_HOME=/usr/lib/jvm/temurin-25-jdk-amd64
/home/agaminggod/Desktop/Projects/arena-beat-game/slot.sh live bash -c '
  exec node scripts/quality/run-ladder.mjs \
    --scenarios L-A2 --runs 1 --parallel 1 \
    --provider codex --model gpt-6.1-sol --effort low --service-tier default \
    --port-base "$SLOT_PORT_BASE" --jar build/libs/arena-agents-0.2.0.jar \
    --server-template runtime/server-template --out runtime/ladder-L-A2
'
```

For unattended use on Linux, launch that wrapper in a detached session with stdout/stderr redirected to a file. The Node launcher owns separate process groups for its server, coordinator (including provider children), and runner; closeout drains captures, stops the server and terminates only those owned groups. `--out` and the retained `runtime/headless-runs/` directories provide on-disk progress and evidence.

`results.json` preserves full extracted metrics and failed launches. `ladder-report.md` and `ladder-report.json` give each scenario/provider/model/repetition's pass/fail, goal minutes, deaths, body-busy percentage and tool failures. PASS requires authoritative server completion. Measurement status remains separate; unavailable values remain unknown. Failed attempts have no time-to-goal, with observed duration retained in JSON. Body-busy reuses the existing goal-window action interval union, excluding chat. A verified subtask does not certify the method used or an unassisted full run. Read each scenario's notes for supplied resources, random drop risks, alternate branches and predicate limits. Source/fixture identities and raw evidence remain in per-attempt reports beneath the output directory.

Run setup validation with no model calls on its own disposable server:

```powershell
powershell -File scripts/quality/validate-ladder.ps1 -Java JDK/bin/java.exe -ServerTemplate TEMPLATE -Jar BUILD.jar -Out runtime/ladder-fixtures -PortBase 28200
```

The setup-only check verifies locate receipts, dimension, inventory, each armour slot, natural/structure footing after two physics ticks, declared mobs, and the End's natural dragon and ten crystals. It records commands and NBT in `fixture-validation.json`. It reuses one disposable world, so it checks setup, not fresh-world goal completion. `validate-ladder-fixtures.mjs` can also connect to an already owned disposable RCON server with `--rcon-port`, `--password-file`, `--out` and optional `--scenarios`. Do not point it at a shared trial. Setup fields `airBlock` (air variant), `standingOn` (block/tag), `loadChunks` (up to eight dimension/position pairs) and `settleTicks` (1..100) support structure interiors, cross-dimension construction and natural boss initialization. Extra chunk tickets are removed even if setup fails.

For unattended measured runs, `launch-scenarios.ps1 -Runner run-ladder.mjs` supports the same arguments-file and on-disk status/log contract as other quality runners.

```powershell
node scripts/quality/run-scenarios.mjs --scenarios S1,S5 --provider claude --model claude-opus-5-5 --effort low --runs 2 --jar build/libs/arena-agents-0.2.0.jar --out runtime/quality-baseline
node scripts/quality/compare-scenarios.mjs runtime/quality-baseline/results.json runtime/quality-after/results.json
```

Use `--provider codex --model gpt-6.1-sol` for descriptive GPT measurements. The paired acceptance gate is Claude only: Codex currently lacks native per-call rows and cannot establish per-call savings. Defaults are `--runs 8 --scenarios S1,S1-deltas,S5`, with each scenario's own `durationBudgetMs` (240,000 ms for S1 through S6, 1,800,000 ms for S7). An explicit `--budget-ms` or `--play-window-ms` applies to every selected scenario and prints a warning for each scenario whose data budget it replaces. Argument parsing refuses more than 40 scenario/repetition pairs, the exact sign-flip ceiling.

The runner copies the template, starts one owned headless server at a time with `-Xmx2G`, runs the existing coordinator and provider matrix, and keeps that launcher's process-identity cleanup. It never stops unrelated processes or Gradle daemons.

## Scenario data

`scenarios.json` defines seed, dimension, position, surface placement, inventory, worn armour, effects, time, mobs, setup commands, goal, and budget. Commands use `{agent}` for the generated player name. Edit data to add scenarios, without adding scenario branches to the runner. Setup occurs before the real goal starts. Creative mode is used only during fixture construction, followed by survival before measurement. S1, S1-deltas, S3 and S6 freeze world ticks through goal preparation, then the observer unfreezes on the authoritative goal start; preparation and release timestamps are retained. This prevents fixture threats killing an idle player before measurement. No fixture facts or evaluator milestones are added to the model's goal.

| ID | Starting situation | Goal |
|---|---|---|
| S1 | Natural Nether wastes ground at (68.5, 42, 64.5), worn diamond armour, diamond sword/pickaxe, 16 steak | Beat the game |
| S1-deltas | Natural basalt deltas ground at (0.5, 81, 0.5), same gear and food | Beat the game |
| S2 | Dark carved cave at Y=-40, empty inventory | Beat the game |
| S3 | Overworld night, wooden tools, two zombies, skeleton and creeper | Survive the night and get iron gear |
| S4 | Overworld beside a lit portal, iron gear, 10 pearls, 16 bread | Beat the game |
| S5 | Surface logs, persistent stationary husk on a ledge 18 blocks above | Gather 10 logs |
| S5b | Versioned S5 variant: husk at the pad-facing edge of one support block, 8 blocks above; initial view faces it | Gather 10 logs |
| S6 | One-block ledge above a 30-block drop, approaching zombie at night | Survive and reach safe ground |
| S7 v2 | Fresh normal survival, seed `-6693307816407771325`, surface at X134.5/Z488.5, morning, empty inventory | Beat the game by defeating the Ender Dragon |

S1 through S6 generate a fresh normal world from seed `20261009`. Small authored fixtures provide repeatable starts within natural terrain. S1 reproduces a recorded live session's dimension, biome, gear and food. Two persistent piglins are placed on verified natural ground near authored offsets, at least five horizontal blocks from the player, and their entity positions are recorded before the goal starts. This guarantees the intended threat without depending on natural spawn timing. Placement searches the surrounding natural terrain and fails instead of editing it. S1-deltas keeps the original X/Z as a separate hazard start. Both validate biome and footing without terrain edits. Their explicit Y coordinates use `surface:false` because the Nether heightmap selects the roof. Surface fixtures clear a small starting patch so summons are not buried inside terrain. S5 uses a daylight-proof husk so its elevated hostile remains present for the whole budget. World generation repeats; provider choices, tick scheduling and natural mob spawning remain variable.

S7 is an opt-in versioned long-goal scenario with no terrain edits, planted resources or supplied equipment. Its default play window is 30 minutes after authoritative `goal_control start`, with a separate five-minute preparation budget. Death does not end its measurement; the coordinator's normal respawn behavior continues. Setup `respawnAtStart` sets the world spawn at the placed start, so the player starts, respawns (with vanilla spawn-radius scatter) and finds its compass target at one point, as a fresh vanilla player does. Version 1 respawned at the seed's original world spawn, about 232 blocks away. Completion, errors and the play deadline still end the run. Other scenarios keep their existing definitions and clocks unless `--play-window-ms` is supplied. A 60-minute run uses `--play-window-ms 3600000`:

```powershell
node scripts/quality/run-scenarios.mjs --scenarios S7 --provider codex --model gpt-6.1-sol --effort low --service-tier default --runs 1 --play-window-ms 1800000 --out runtime/quality-s7
```

`--seed INTEGER --spawn X,Y,Z` overrides the seed and start coordinates of scenarios whose data sets `runPolicy.overridableStart` (currently S7); other scenarios refuse them. Surface placement resolves Y from the world heightmap; it can land on a canopy. These settings are recorded in the run definition and paired retry configuration. `--service-tier` is recorded in the requested profile and remains subject to provider attestation. Provider defaults are Codex `default` (standard tier; `priority` and `fast` use the 2x-usage Fast tier and must be passed explicitly) and Claude `priority` (normal speed). Paired runs retain the minimum of three repetitions and all capture/accounting checks.

### Long runs: beat the game on a random seed

`run-long.mjs` is the north-star confirmation run. It plays one fresh normal survival world on a random seed (or `--seed`). The player starts at the generated world spawn with an empty inventory, and the only goal is `Beat the game`. The game clock is frozen until the model's first decision, and the player stays in survival throughout setup. Death continues play by vanilla respawn. The run ends at the first of: the server-verified dragon kill attributed to this agent, the `--budget-minutes` window (at most 240), or its spend cap. The kill credit proves who killed the dragon, not that the run was unassisted. This runner's own setup freezes the tick, places the player, clears effects, sets the time and game mode, and unfreezes at goal start. The server's intervention audit (`codex audit <agent>`) cannot tell these mutations from help without attributing commands again, so a long run always reports `assisted`. Certified autonomy comes from the headless natural capability runner (`headless-capabilities.mjs`). It creates a fresh world, applies only pre-agent world rules and a temporary spawn ticket, and then starts one goal.

Strict mode is the default for a Claude player. It compiles the exact dragon completion predicate locally, disables auxiliary translation, voice and live judging, and permits only gateway-routed Claude calls. Other goals that need model translation are rejected before launch. The coordinator must use this runner's enforcement build; older or mismatched enforcement files are refused.

Every supported text Messages request reserves its maximum token charge before forwarding. Strict accounting uses the published Opus 5.5 or Sonnet 5.5 list prices from 2026-10-13, including the dearer one-hour cache-write rate. Unsupported models, non-text input, server tools, price modifiers and other API routes are refused. Interrupted responses retain their output allowance. Comparison metrics elsewhere retain their historical proxy rates; the ledger's gate charge is authoritative for this cap.

The run reserves everything the shared ledger leaves, or `--run-reserve-usd` if smaller. `--ledger` persists spend and outstanding reservations across invocations; `--prior-spend-usd` seeds a new ledger once. Abandoned locks fail closed. Adding `--codex-observer-cap yes` opts into estimates that can overspend, including auxiliary calls, and is not strict mode.

```powershell
node scripts/quality/run-long.mjs --arms arms.json --arm B --provider claude --model claude-opus-5-5 --effort low --service-tier priority --budget-minutes 180 --max-total-cost-usd 85 --ledger LEDGER.json --port-base 26900 --java JDK/bin/java.exe --server-template TEMPLATE --out runtime/long-run-1
```

For a multi-hour run, start it through the detached launcher so it survives an SSH disconnect. ARGS.json is the same argument list as a JSON array of strings. Status and logs go to `JOB/status.json` and `JOB/worker.log`:

```powershell
powershell -File scripts/quality/launch-scenarios.ps1 -ProjectRoot PROJECT -ArgumentsFile ARGS.json -Runner run-long.mjs -JobDirectory NEW_JOB_DIR
```

`long-run.json` and `long-run.md` hold the seed, the stop reason and the milestone timeline. The chain is wood, planks, crafting table, wooden pickaxe, cobblestone, stone pickaxe, furnace, cooked food, iron ingot, iron pickaxe, iron armour, bucket, diamond, obsidian, flint and steel, Nether, fortress, blaze rod, ender pearl, blaze powder, eye of ender, stronghold, End and dragon. Each milestone records its first time from sampled inventory and dimension, bridge observations or advancements. It also records the model calls, tokens and cost of the segment that led to it and the cumulative totals. Deaths list their time, cause and cumulative cost. Milestone cost estimates come from trace comparison rates; the top-level run/ledger charge uses the strict gateway accounting. Dragon success in strict mode requires server completion of the locally compiled attributed-kill predicate; an advancement or client claim alone is insufficient. Raw artifacts stay in `run/` as for other scenarios.

Long captures journal `quality-protocol.jsonl`, `quality-samples.jsonl`, `quality-usage.jsonl` and `quality-provider-usage.jsonl` during play, before report extraction. JSONL is read and written record by record. Long-run memory retains inventory, lifecycle and usage evidence; detailed scenario quality metrics are not extracted for LONG. Protocol rotation is tracked by file identity, draining the old descriptor before reading its replacement. Runner and observer RCON commands share a per-run lock because Minecraft shares its response buffer across RCON connections. A failed lock is reported as `RCON_LOCK_TIMEOUT`; an incomplete reply records `RCON_INCOMPLETE`, the command, response size and completeness flags. Launcher diagnostics survive into the final report. SIGINT/SIGTERM stop the owned launcher and write the observed partial timeline; after an uncatchable kill, regenerate from the journals.

Rebuild a report without starting a server or settling a ledger:

```bash
node scripts/quality/run-long.mjs --report /path/to/raw/headless-run/scenario --out /path/to/rebuilt-report
```

The raw directory contains `manifest.json`, `report.json` and captures. `long-run-context.json` preserves the window/profile for new runs. Legacy runs can use retained `protocol.jsonl.N` files and complete observations recorded in provider inputs. Missing prefixes and malformed records remain visible as evidence limits; “not observed” does not mean never obtained, and recovered first-seen times can be late. A regeneration with incomplete evidence writes both reports and exits 1. Use a fresh output directory to preserve an original failed report. Omitted `--ledger` defaults to `OUT/spend-ledger.json`; use a unique explicit ledger for independent games. Codex dollar amounts are token-price estimates, not ChatGPT plan invoices.

S5 retains its original definition for comparisons. Its wide elevated slab hides the husk from the pad. S5b is an opt-in fixture (`--scenarios S5b`) for new benchmarks: it clears the whole sight corridor, uses one support block with the husk near its front edge, and starts the camera facing it. It retains the same goal, logs, empty inventory and seed. The target begins beyond melee reach with no stairs or bridge from the pad. It is frozen during preparation and uses a distinct target tag. Default benchmark selection remains S1,S1-deltas,S5; compare S5b only against matching S5b runs.

## Outputs and interpretation

The output folder contains `results.json`, one `S*-r*.json` per attempt, and a short tool timeline per attempt. Raw artifacts live under this checkout's ignored `runtime/headless-runs/`, including server logs, provider turns, coordinator traces, notebook receipts, fixture setup evidence, sampled entity NBT/stat counters, and timestamped protocol rows. Launcher stdout/stderr are under `runtime/quality/<run>/`. Failed infrastructure and unavailable providers remain in results with their classification; budget exhaustion is expected for unfinished long goals and does not invalidate measured play.

JSON summary reports remain bounded to 262,144 UTF-8 bytes. Large call, timeline, sample and other detail collections live in content-addressed `report-artifacts/*.json` files beside each summary. Their `reportArtifact` references contain a relative path, byte count, SHA-256 and array count when applicable. When a summary still exceeds the bound, scalars (numbers, booleans, null and strings up to 256 UTF-8 bytes, such as ids, statuses and terminations) never move while any non-scalar detail is inline: non-structural arrays, longer strings and records without scalars move largest first, but only when the reference is smaller. Only if the scalars alone still exceed the bound do records holding scalars move, first nested ones, then an entry's direct records, then whole collections; each such reference carries `scalarFallback: true`. Reports are UTF-8 end to end, including the PowerShell launcher's read and rewrite. The observer records an unreadable or tampered runner report as an observer error instead of treating it as absent. Keep that directory when copying a report. `readArtifactReport(file)` in `coordinator/src/benchmark/report-artifacts.mjs` restores the original report and verifies every reference; missing or changed artifacts fail the read. Comparison, re-extraction, paired retries and launcher packaging use this reader. Direct JSON consumers must resolve references before treating a referenced field as an array. Scalar totals and legacy metric calculations remain unchanged; in-memory extractor results retain complete details.

`metrics.progressV1` adds PAIR1's progression measures without changing legacy values: first stone pickaxe, iron ingot, iron pickaxe, bucket and successful furnace transaction; confirmed smelted/looted/unknown provenance for the first iron ingot; placed tables/furnaces; stations left by more than eight blocks without a return within four or reclamation before cutoff; literal and broader path-failure-to-movement-control proxies; and sampled travel between successive camps more than sixteen blocks apart. Samples and raw inventory observations supply first-resource times across deaths. Camp travel excludes dimension and death/respawn jumps. Missing observations preserve unknown times or distances. Station and control counts are trace proxies with evidence and definitions, not claims about intent or permanent abandonment.

Goal completion comes from authoritative server `goal_control` operation `complete` or a verified `goal_completion_result`. Coordinator `goal_completed` messages request verification and can be rejected, so they do not end measurement or count as success.

The comparison prints JSON with per-scenario/profile means, deltas, percentages, token categories, and full per-run detail. Each numeric metric also reports n, median, minimum, maximum and range. It includes every attempt and calculates numeric means only from measured runs, preserving missing values as null. Completion comes from authoritative goal completion, with a separate completion rate and completed-goal cost/time. Per-minute rates use measured play time. Missing identities flag a comparison as unverifiable; unequal budgets, scenario definitions or extraction identities reject it. Coordinator and JAR hash changes are shown as arm differences because those are the intended comparison variables.

Metrics join physical action IDs across coordinator traces, protocol commands/results, and notebook receipts. Play and goal-spec/planning tokens use the same comparison price proxy from `coordinator/src/call-cost.mjs`; this is an empirical comparison proxy, not a claim about current API prices. Provider-reported overhead USD remains separate as `overheadReportedCostUsd`. Missing token categories or unknown rates preserve unknown totals as null; measured play categories remain available. Native turn summaries are not counted twice. Wall time includes goal-spec/planning and play, excluding fixture construction; play time is also reported separately.

First-response capture is enabled only for these fixture runs. It records the first Claude text/tool content of a native turn, or the first Codex agent message, in the existing private provider-turn artifact. It does not record thinking content. The first plan snapshot and later first `say` are separate. Dimension and gear matches are lexical hints for manual review, not a semantic quality judge. Tool-only responses and missing plans remain visible in coverage.

The shared first-response capture hooks originate in commit `b725a2a9`, in `coordinator/src/dynamic-main.mjs` and `coordinator/src/claude-service.mjs`; Codex uses its existing `agent_message` source. Port those hooks rather than the whole harness commit. Preflight checks the selected provider. Both paired arms require verified capture; descriptive single runs record `qualityCapture.verified=false` and a reason when hooks are missing, so their first-response evidence may remain unavailable. Enable identical instrumentation in both arm coordinators before committing and repinning their hashes. Historical responses that were never recorded remain unavailable. Existing `say` text is kept separately and is not substituted for an initial response.

The observer captures plans on polling, independently of RCON sampling and player death. `quality-initial-plan.json` preserves the earliest available original goal-spec plan or plan snapshot as bounded text with its source (32 KiB maximum). A goal-spec plan is advisory preparation, not a gameplay model response. Versioned first-response evidence is UTF-8 bounded to 8 KiB and marks late captures as unverified initial responses. Live private response records retain the existing 8,192-character limit.

Server-side samples, roughly once per second, measure positions, health, fall distance, inventory/equipment, vanilla `damage_taken` and `deathCount`, and advancement milestones. Damage uses the vanilla statistic in tenths of health points. Individual health drops record their source as unknown unless the data explicitly supplies one. The last-attacker relation is retained as evidence and can be stale. Death causes come from authoritative goal-control events. Falls count sampled fall-distance crossings above three blocks; brief falls may be missed.

Path length excludes dimension transitions and death-to-respawn jumps. Net displacement is null when start/end dimensions differ. Stuck time counts stationary sampled intervals entirely inside movement actions. Unreachable attacks use a sampled target height delta above three blocks or an explicit no-path result. Missing target samples are reported as missing coverage. Low-health eating requires a finite health value <=8 and joins an eating action, including `use_item` after selection of food; it distinguishes a started attempt from a successful action and retains recovery without eating. Milestones include inventory thresholds, worn iron armour, dimension visits, fortress/bastion discovery and dragon death. Progress already supplied at setup is recorded as reached at the first sample. Inventory milestones also use server bridge observations, preserving terminal progress when goal completion removes the player before the next RCON sample. Malformed JSONL and scoreboard gaps are counted; observer errors mark a run incomplete.

Re-extraction shares the live goal window, audits raw JSONL, and records an extractor fingerprint including pricing dependencies without changing the original live coordinator hash. Rerun extraction against retained artifacts without another provider run:

```powershell
node scripts/quality/reextract-scenarios.mjs runtime/quality-baseline/results.json
```

For paired reports, replace `PAIRED_REPORT` with the input report path and `OUTPUT_DIRECTORY` with an absolute directory outside the repository. This reads the original reports, raw protocol, samples, private provider rows and notebook receipts, then writes only the new output directory. It also re-extracts first attempts and retry history while retaining their attempt identities:

```powershell
node scripts/quality/reextract-scenarios.mjs PAIRED_REPORT --out OUTPUT_DIRECTORY
node scripts/quality/compare-scenarios.mjs OUTPUT_DIRECTORY/results.json
```

Legacy top-level metrics and acceptance gates keep their definitions. Corrected metrics live under `metrics.qualityV2`, and comparisons expose `qualityV2` separately. `quality-v2-summary.json` reports descriptive totals per arm across all attempts with retained evidence; comparison means use only measured attempts. Every run retains evidence arrays and coverage gaps.

Death-counter increments and respawns are reconciled one to one. When a counter proves a death but its exact time is absent, a health rise inside that interval cannot prove healing: the first such recovery becomes a conservative death upper bound, with timing provenance retained. Multiple inferred deaths advance through separate observed recovery windows. Inferred death causes remain unknown.

| Versioned field | Definition |
| --- | --- |
| `failedFightRequestsByCode` | Failed, timed-out or non-stop-cancelled fight/attack requests by result code, without requiring a target sample. |
| `attacksOnUnreachableTargets` | Failed, timed-out or non-stop-cancelled fight/attack requests with explicit path/visibility/approach failure codes, including `APPROACH_BLOCKED`, `TARGET_NOT_VISIBLE`, `NO_SEEN_ROUTE`, or sampled target height above 3 blocks. Unsampled targets remain separately counted as unknown coverage. |
| `lowHealthOutcomes` | HP <=8 opens an episode. HP >8 closes recovery with observed food use (`recoveredByHealing`) or without it (`recoveredWithoutEating`). Death, a death-counter increase or respawn closes `died`; unfinished episodes are `censored`. Observed food use does not prove the cause of health recovery. |
| `repeatedIdenticalFailingRequests` | Excess failed requests with the same tool, full canonical arguments and failure code, within 0.4m in 3D and no intervening movement, death or successful equal request. Position evidence must be at most 2s old. Camera turns do not change the position. |
| `stationarySprintSeconds` | Sum raw-observation streaks of active sprint movement input, lasting at least 3s, within 0.4m horizontally of the initial position, with no observation gap above 2s, dimension change or death. Missing raw positions produce null. |
| `foodUsedBelow6HpBeforeDeath` | Per death, yes/no/null for a food-use request or raw held-food use while HP is strictly below 6, scoped to that life. Selecting food with `use:false` does not count. Successful requests are recorded separately from attempted use; consumption is not inferred. |
| `hazardDeathsByType` | Authoritative cause text grouped as lava, fire, fall, mob, other or unknown. Stale attacker evidence does not establish a mob death. Counter/respawn-inferred deaths retain unknown causes. |

Terminal RCON closure is reconciled against authoritative completion or stop observed after a sampling race. Re-extraction can reclassify legacy untimed `RCON client is closed` errors only when server completion is verified and no malformed JSONL was dropped. Original errors remain in `observerErrors`, and `terminalObserverErrors` records the classification and its evidence. Other read failures remain incomplete.

## Paired benchmark

`--jar` selects the Java build and `--coordinator-root` selects a separate checkout's live coordinator and configuration. The evaluator runner, scenario setup, observer and extraction remain in this harness checkout. Reports fingerprint coordinator sources, model instructions, configuration, package.json, package-lock.json and JAR before and after the run. A changed source or JAR invalidates measurement. The separate instrumentation hash also covers RCON, provider recording, launchers and sourced PowerShell helpers.

Prepare two checkouts, one per arm, each with its own built JAR and installed coordinator dependencies. Both arm coordinators must carry the trace-schema patches; Claude also requires per-call accounting (`d0f2ac08` and `24654d05` on this branch); preflight refuses an arm without them. Plain main lacks interrupted-call rows and partial-message evidence and will be incomplete on death runs. Describe the arms in a JSON file outside tracked sources, for example `runtime/quality/arms.json`:

```json
{
  "A": {
    "commit": "A_CHECKOUT_COMMIT",
    "coordinatorRoot": "../arm-a",
    "jar": "../arm-a/build/libs/arena-agents-0.2.0.jar",
    "expectedJarSha256": "A_JAR_SHA256",
    "expectedCoordinatorSha256": "A_COORDINATOR_SHA256"
  },
  "B": {
    "commit": "B_CHECKOUT_COMMIT",
    "coordinatorRoot": "../arm-b",
    "jar": "../arm-b/build/libs/arena-agents-0.2.0.jar",
    "expectedJarSha256": "B_JAR_SHA256",
    "expectedCoordinatorSha256": "B_COORDINATOR_SHA256"
  }
}
```

Paired runs reject mismatched JAR or coordinator SHA-256 values before launching. Checkouts carrying `.git` also require a clean tree and HEAD matching the supplied commit prefix. Identical A/B artifact hashes are refused. Then run:

```powershell
node scripts/quality/run-scenarios.mjs --arms runtime/quality/arms.json --scenarios S1,S1-deltas,S5 --provider claude --model claude-opus-5-5 --effort low --runs 8 --budget-ms 240000 --harness-commit HARNESS_COMMIT --out runtime/quality-paired
node scripts/quality/compare-scenarios.mjs runtime/quality-paired/results.json > runtime/quality-paired/comparison.json
```

With these defaults the benchmark is S1, S1-deltas and S5, eight pairs each: 24 pairs, 48 fresh-world runs. Odd-numbered repetitions run A/B; even-numbered repetitions run B/A, so each arm runs first 12 times. One server runs at a time. A and B reports and the combined schedule are saved before launch and after every attempt, so an interruption leaves explicit partial evidence. At least three repetitions are required; infrastructure failures make the verdict inconclusive. New benchmarks require a fresh output directory.

There is a fixed 60-second gap after the previous run finishes and before every next arm, including the initial run and retries. Reports record requested and actual gap timing. Provider cache lifetime is unknown, so this gap does not prove equal warmth. First-play-call cache reads and writes record actual warmth; the comparison reports warmth for each pair and counts mismatches without gating or retrying on warmth.

Retry only ineligible or missing pairs with the same arguments and output directory plus `--retry-failed`. Both arms of each selected pair rerun in their original A/B or B/A order. Active reports retain original execution order and arm position, and add retry flags and actual execution order. Superseded runs remain in `history`; `sequence` retains every attempt and each artifact folder uses `attempt-N`. Each arm report also retains `firstAttemptRuns`, so comparisons report first-attempt ineligible runs by termination and measurement status. Any excess B failures count as a conservative quality regression, including after successful retries. Missing original-attempt evidence makes the verdict inconclusive. The retry refuses changes to profile, scenarios, repetitions, budget, harness identity, instrumentation or pinned builds.

### Verdict

Every run stores `modelCallDetails` (preparation and play, input, cache write, output, cache read, duration and proxy USD), category means per call, total tokens/min, calls, cost, death events with causes, verified completion, unreachable attacks and time to first observed progress. Progress means a relevant resource gain above fixture inventory, a new dimension, or an advancement. Starting gear and starting dimension do not count. Null means no progress observed; it does not mean instant progress.

The comparison has one explicit pooled `verdict`. Primary metrics are steady-state charged tokens per play call and per minute, excluding preparation and the first play call. The minute window starts at the end of the first play call. Preparation cost, first-call cache warmth, full-window token rates and cost proxies remain separate secondary results. Calls are checked per category against coordinator thread totals; a discrepancy above 2%, missing accounting evidence or rejected Claude partial messages makes measurement incomplete. Only gameplay calls are checked against the gameplay model profile.

The cost gates use per-pair log(B/A) ratios with 95% Student t intervals, pooling all scenarios with equal weight per pair. The per-call interval upper bound must be below zero, the tokens/min upper bound must be at most +5%, and a one-sided sign-flip permutation check must agree. Per-scenario intervals are descriptive. Healthy termination, attestation and rate-limit checks determine eligibility. Missing, incomplete or nonadjacent pairs yield `INCONCLUSIVE`. Quality guards cover completion, deaths, calls/min and progress; a passing cost gate with a regression yields `COST_PASS_QUALITY_REGRESSION`. The calls/min guard counts a stall only when a noncompleted B run has more than 20% fewer calls and also more than 20% fewer actions/min or loses observed progress, because fewer model calls alone can reflect useful programs or watchers. Quality guards use one-sided exact paired sign tests at p < .05, except the conservative first-attempt excess-B failure guard. No-progress runs are censored at the measured window length, and death causes are summarized per arm. A single smoke run cannot establish the gates. A call still in flight at the stop may be billed while absent from the steady-state numerator; its time remains in the denominator for both arms.

### Unattended launch

`launch-scenarios.ps1` starts the runner as a hidden process that survives the launching SSH session. Save the runner arguments as a JSON array, including an explicit `--java` path because the worker does not inherit the session's environment:

```json
["--arms", "runtime/quality/arms.json", "--scenarios", "S1,S1-deltas,S5", "--provider", "claude", "--model", "claude-opus-5-5", "--effort", "low", "--runs", "8", "--budget-ms", "240000", "--out", "runtime/quality-paired", "--java", "PATH_TO_JDK_25/bin/java.exe", "--harness-commit", "HARNESS_COMMIT"]
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/quality/launch-scenarios.ps1 -ProjectRoot $PWD -ArgumentsFile $PWD/runtime/quality/paired-arguments.json -JobDirectory $PWD/runtime/quality-paired-job
```

Pass absolute paths, as above, because the launcher resolves them outside the PowerShell location. `worker.log` combines stdout/stderr, `status.json` records the final exit code, and `pid.txt` records the worker's PID. New jobs require new directories. The argument file is copied into the job folder before launch. No scheduled tasks or services are installed. Benchmark checkpoints remain under the `--out` directory, and a fresh job directory may point to an existing benchmark output for `--retry-failed`.

## Tests

```powershell
cd coordinator
node --test test/quality-*.test.mjs
node --test test/claude-service.test.mjs test/claude-trace.test.mjs test/call-cost.test.mjs
npm test
```

The 135 KB fixture contains selected unmodified records from a real Nether session trace, with a neutral agent ID, and every notebook action delta. It verifies exact call/token/action counts and preserves missing position/health history as null. Synthetic extraction tests cover movement, stuck intervals, damage, falls, low-health eating, unreachable targets, failure codes, plan statuses, matrix setup and comparisons. Setup tests use a mocked RCON transport; S1/S5 verification uses the real Fabric/coordinator/provider entry point. S2/S3/S4/S6 need live verification before claiming comparable quality results.

`coordinator/src/benchmark/live-speed-benchmark.mjs` comes from `claude/opt-bench` at `db73c505`. Launcher/template isolation and append observation follow that branch's runner. The existing headless world/spawn, RCON, matrix and cave-navigation harnesses provide the real server path; no simulated model policy is introduced.

## Generality suite

`run-generality.mjs` in explicit observer mode runs versioned train fixtures with bounded concurrency (1–4), paired or single-arm runs, objective trace markers, and two independent judgments. Judges default to Sol for Claude play and Opus for Codex play, at medium effort, with opposite evidence order. Numeric scores require action timestamps; unexercised recovery and runs without actions stay unscored. Each failed paid judgment retains metering and gets one retry per pass. The total launch budget includes preparation, play, successful judgments and failed attempts; truly unknown spend stops further launches.

```powershell
node scripts/quality/run-generality.mjs --arms arms.json --arm B --scenarios T02,T12,T14 --runs 1 --concurrency 3 --port-base 26900 --out runtime/generality --max-total-cost-usd 5 --codex-observer-cap yes
```

Use `--provider codex --model gpt-6.1-sol` for Codex play. The original stacks may lack native per-call accounting; an `INCOMPLETE` token reconciliation must remain visible even when the objective and thread-total spend are available. Full fixtures retain their 5–10 minute windows. `--smoke-window-ms 60000` explicitly shortens a train-only pipeline check to 30–120 seconds and retains the declared window in its job data; it does not establish a performance baseline.

The Observer activates first-decision hazards using the outer protocol row's `observedAtMs`, then releases world ticks. Setup holds the player safely, disables command feedback before mode changes, removes nearby phantom give drops, and does not alter natural regeneration. Captured setup feedback, fixture text or modified gamerules fail measurement. Survival goals use the fresh end state at the played window's end: alive, no deaths, and the fixture's hazard-clear conditions. Shelter uses a bounded flood-fill with ordinary solid walls/roof, excluding leaves and fluids, and RCON commands that fit the server receive buffer.

Held-out definitions and traces belong in the evaluator-only research folder, never shared notes or public archives. Held-out runs require an explicit private fixture file and `--expect-fixture-sha256`; a different hash fails before launch. On the shared Desktop, stage private definitions and evidence temporarily, copy them back to the evaluator-only folder, then delete every staged private definition, trace, world and report after each evaluator run. Preserve train-only evidence separately. The setup validator is an unpaid setup check and does not prove the real Observer or provider pipeline.


## Supervised strict cap-and-stop smoke

After live execution is authorized, use the committed driver instead of the plain long-run command. From the project root:

```powershell
node scripts/quality/strict-smoke.mjs --provider claude --model claude-opus-5-5 --effort low --budget-minutes 1 --max-total-cost-usd 3 --ledger runtime/strict-smoke-ledger.json --port-base 26900 --java "C:/Users/player/Desktop/Projects/agents arena/runtime/toolchains/temurin-25/jdk-25.0.3+9/bin/java.exe" --server-template "C:/Users/player/Desktop/Projects/agents arena/runtime/server-template" --out runtime/strict-smoke
```

Output and ledger paths must be fresh. The Windows-only driver uses the real launcher and Anthropic transport. It records every upstream attempt in `gateway-outbound.jsonl` without credentials or prompt bodies and records the local gateway address in `gateway.json`. After server goal-start and a metered gameplay call, it sends the million-character boundary probe, requires local refusal, closes the gate through the production Observer, and requires a following ordinary request to be refused. It injects failures only into the observer's stop command, leaving gameplay and other RCON operations intact, so the production watchdog must escalate.

Immediately before termination, a smoke-only witness suspends members validated against the owned job, retaining the same process handles. It repeats the census until every member is frozen, closes its query-only job handle, and lets the ordinary retained launcher handle perform termination. The witness confirms every captured process has exited. It cannot terminate processes and resumes surviving members on failure. A sentinel started outside the job must survive; the driver then stops that sentinel through its retained handle.

`strict-smoke.json` reports PASS, FAIL, or INCOMPLETE, with each acceptance check and its evidence. Missing goal/gameplay/refusal sequence never passes. Exit codes are 0, 1, and 2 respectively. Admission reserves the one-hour cache-write ceiling; exact settlement and reconciliation distinguish five-minute and one-hour usage. Unknown duration cannot pass reconciliation. A pass confirms this supervised integration only, not multi-hour progression or a dragon win. Live model execution remains prohibited while NO CLAUDE applies.


Round 8 requires a provider-side census before PASS. The gateway journal and coordinator rows cannot prove absence of opaque direct calls. Without an independent provider export, collection reports INCOMPLETE. No provider account export integration or OS egress confinement is assumed. Do not manufacture an audit by copying the gateway journal.

After collection, obtain a complete provider-reported census covering the owned workload's entire interval in `smoke-scope.json`. Use an isolated account/window, or provider-side workload attribution that covers every helper. Include all billing evidence available. Import it as a JSON document with this shape (values below are illustrative, not usable evidence):

```json
{
  "schemaVersion": 1,
  "source": "provider",
  "complete": true,
  "scope": { "runId": "copy-from-smoke-scope", "startedAt": 1, "endedAt": 2 },
  "generatedAt": 3,
  "calls": [{
    "responseId": "provider-message-id",
    "model": "claude-opus-5-5",
    "usage": { "input_tokens": 10, "output_tokens": 100, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 },
    "billedUsd": 0.00204
  }],
  "billingTotalUsd": 0.00204
}
```

`scope` must match the captured run exactly; `generatedAt` must follow the completed interval. Each call needs the provider response identity and raw usage. Cache creation needs both `cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` when writes are nonzero. `billedUsd` and `billingTotalUsd` are optional only when that billing evidence is unavailable. Extra calls, mismatched usage/charges, incomplete coverage or a damaged export cannot pass. If the provider cannot supply this coverage, the smoke remains INCOMPLETE and cannot authorize the multi-hour run.

Verify without starting another workload:

```powershell
node scripts/quality/strict-smoke.mjs --verify runtime/strict-smoke/strict-smoke.json --provider-audit runtime/provider-smoke-audit.json
```

This writes `strict-smoke-verified.json` and checks the captured accounting files still match their hashes. A collector running independently can also supply `--provider-audit FILE` to the collection command; the driver reads it only after its workload stops. Server goal identity, native response identity, observation order, both probes inside the one-minute window, raw log integrity, Observer errors, source stability and underlying measured status must all be consistent.
