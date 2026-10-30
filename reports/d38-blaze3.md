# d38-blaze3: model-selected blaze shelter

**Acceptance failed: 0/6 required repeats passed.** The shelter arm collected zero rods in every repeat and died twice. The conditional Sol games were not run.

## Implementation and artifact

Branch `claude/d38-blaze3` starts at `0671aeb1` and merges integration `a68669f5` in `c40fd9e3`. The selected runtime source is `5ba41d06`.

`build_shelter(x,y,z,opening,itemId,roof?,timeoutMs)` is one goal-directed body action, also available as `player.buildShelter`. The model chooses the interior feet cell, one cardinal opening, carried full solid blocks, and whether to add a roof. It is never called automatically and never begins combat. Combat facts and the control reference explain why players build enclosures and how to hold ground with `fight_target pursue:false`.

The body approaches and centers itself using ordinary movement, builds three two-high wall columns and a sill, and leaves an eye-height opening on the chosen side. A roof adds a supporting cap and a block over the body: nine placements, or seven without a roof. Existing full blocks count toward the shell. It uses acquired terrain, existing placement sight/reach/protection checks, carried inventory, and vanilla mining for partial obstructions. It leaves block entities intact, punches out touching fire, refuses damaging lava, and reports partial work after a failure. No hidden terrain or watcher observations enter the model channel.

Main implementation: `ServerShelterController.java`, `ServerActionExecutor.java`, protocol/action schemas, `combat-facts.mjs`, and the Minecraft control reference. Added geometry, schema, API, and executable-contract checks. The schema budget increased by exactly 116 bytes (30,706 to 30,822); serialized dynamic tools by exactly 116 (31,246 to 31,362); the API reference by exactly 69 (14,744 to 14,813).

Selected jar SHA-256: `9326a4121194d021519091ee3f421e903c5fb4960a9afb886d12e25b645d2307`. Baseline is the previous d38-blaze `final22.jar`, SHA-256 `df8ec53fdb562433aa17c71999c30fc0c4e662c6ddf06a98f625d4567aab73e8`.

## Measurement protocol

Both jars use harness SHA-256 `301a87b39e59a55609074fcd17825d9ec96883f52498dafde56ed425f144f38c`, seed `20261009`, real spawner `84,73,92`, broad-deck start `83.5,73,91.5`, original 3-fortress kit, 240 wall seconds, three repeats each for no gap and a five-second gap before every body action. Natural mob spawning is disabled; the vanilla block spawner stays enabled. Primary rods are the maximum inventory count strictly inside the measurement window. A death ends a trial.

The candidate stand-in calls the shelter action first with the opening facing east and a roof, then holds ground, chooses only visually perceived blazes, and collects witnessed drops close to the interior/opening. Baseline retains the previous pursuing/follow-through combat policy. Both arms explicitly install the stock hostile-near shield stance and stock incoming-projectile shield guard. These are model-callable primitives, not automatic product behavior. No model inference occurs in this mechanics benchmark.

Fixture corrections are shared by both jars: restore the pristine 3x3 shell and spawner with a fixture-only clone before each repeat, and place the body at the authored start after stance warm-up immediately before timing. Without restoration, mining a fence changed later trials; stance warm-up could also walk the body away from the authored start. The backup region is never supplied to the model. Earlier cohorts with different geometry, warm-up drift, or incomplete terrain reset are preliminary and excluded from the selected paired matrix.

## Paired real-spawner result

Both completed cohorts used the same harness hash above. The required bar is at least three rods and zero deaths in every candidate repeat.

| Gap | Repeat | Baseline rods / deaths | Shelter rods / deaths | Baseline / shelter seconds | Shelter minimum sampled HP |
|---|---:|---|---|---|---:|
| gap0 | 1 | 2 / 1 | 0 / 0 | 147 / 240 | 0.35 |
| gap0 | 2 | 3 / 1 | 0 / 0 | 98 / 240 | 13.52 |
| gap0 | 3 | 0 / 1 | 0 / 0 | 149 / 240 | 20.00 |
| gap5 | 1 | 1 / 1 | 0 / 0 | 159 / 240 | 20.00 |
| gap5 | 2 | 3 / 1 | 0 / 1 | 170 / 30 | 0.00 |
| gap5 | 3 | 0 / 1 | 0 / 1 | 116 / 229 | 0.00 |

The baseline died in all six repeats. The shelter arm survived four full windows, but killed only one blaze across the six repeats and never held a rod. The second gap repeat returned `ACTION_EXCEPTION: input lease is no longer active` during construction and died after 30 seconds. The third gap repeat completed the shelter and later died after 229 seconds. The first no-gap repeat fell to 0.35 HP before recovering; its survival is not evidence that construction was reliably safe. Five of six shelter requests returned `SHELTER_BUILT`; all nine requested cells were completed in each successful request.

This action provides usable enclosure construction, melee reach, and nearby pickup mechanics. It does not establish a reliable fortress visit. Hold-ground fight receipts repeatedly reported out-of-view or out-of-reach targets, often roughly 3–4 blocks away, and explicitly waited for the target to enter reach. Low kill volume and the drop location explain the missing yield. The one kill reported a visible falling rod at `86,74,90`, outside the opening-local pickup region, and no pickup call succeeded. The selected real-spawner cohort did not produce a natural rod inside or at the opening. The separate diagnostic drops test that pickup geometry.

## Held-out mechanics

The final jar passed four live construction cases on an open stone platform: north/cobblestone/roof; east/nether bricks/roof with a fence obstruction; south/cobbled deepslate/roof with fire ignited during construction; west/cobblestone/no roof. All four returned `SHELTER_BUILT`, killed a stationary visible blaze through the opening using `fight_target pursue:false`, and picked up exactly two diagnostic rods placed inside and on the sill. The fence and fire each recorded one cleared block. These tests establish construction, melee reach, and pickup mechanics, not natural rod yield or safety against AI blazes.

## d31 combat replays

Both jars replayed the same ten recorded `incidents-d31c` incidents through the actual server with the default 12-second danger window. Baseline: 10 survived, zero deaths, zero errors. Selected candidate jar: 10 survived, zero deaths, zero errors. No regression was observed in this completed pass; it is not a repeated statistical guarantee. Seven fixtures restored their recorded world snapshots and the other three used the harness seed reconstruction.

## Preliminary survival and fixture teardown

The selected jar's first 240-second pilot built all nine blocks in about 2.6 seconds, remained on the chosen deck in the saved samples, with minimum sampled health 20 HP, killed one blaze late in the window, and collected zero rods. It failed the yield requirement. The subsequent removal of its surviving body exposed an existing reflex lifecycle crash (`Unknown agent` from `ReflexEngine.endBehaviour`). The harness now clears the prior body's rules and verifies the empty rule set before removing a living body; dead bodies do not produce ready observations. A separate 20-second, two-repeat survival probe passed both repeats and the intervening teardown, with one natural rod in total. It is excluded from acceptance. This only changes between-trial cleanup. The runtime removal bug remains a follow-up: `CodexAgentManager.remove` deletes the record while `ReflexEngine.endBehaviour` can still call `findAgentPlayer`, which requires that record. Those runtime paths were not edited here. The completed paired cohorts used the identical corrected harness; excluded pilots remain preserved.

## Stale-lease investigation and rejected change

The construction exception is a real remaining defect, but its exact origin was not reproduced. A proposed shelter-only reacquisition change was committed in `e833bf07`, built as `candidate5.jar`, and then withdrawn in `e6f6cf6b`. The selected runtime source remains byte-for-byte identical to `5ba41d06` in `src/main/java`.

The forced 3.5-second shield-pause case passed on both jars, including the original selected jar. Source inspection showed that `ReflexEngine` calls `renew(agentId)` for paused input leases, so a normal reflex pause did not establish the proposed cause. Both diagnostic artifacts are preserved as `construction-expiry-before/` and `construction-expiry-after/`; they are not evidence that the speculative change fixed the observed exception. The speculative acceptance/replay workers were stopped and excluded. No unknown-cause retry remains in the selected implementation.

## External controller audit

Read `arena-beat-game/evals/astra-review/review.txt`, section 1, and `appendices.txt`, reviews 15, 81 and 97, then compared the cited paths with this branch. The shelter branch does not merge or modify `claude/d38-controller` or the shared `ReflexActions`, `ReflexEngine`, or `CommandFollower` paths.

- **Shield replacing raw attack/use:** present in the cited composition path, but not a direct explanation for this probe's zero yield. The probe issues `fight_target`, not attack-bearing `control`/`control_sequence`. `ReflexEngine` has a fight-specific offhand-shield deferral, and `ServerFightController` lowers its shield for an eligible direct `player.attack`. One real-spawner kill and all four stationary-blaze kills occurred. The receipts chiefly showed targets outside clear melee reach. This does not prove that every fighting volley is correctly arbitrated, only that the audited raw-control defect should not be substituted for a traced fight failure.
- **Shield movement snapping:** the same `keysFor` algorithm remains: it discards small movement and snaps other requests to full keyboard directions. This can affect the baseline's pursuing movement under a held shield and is a plausible contributor to its deck drift. The sampled positions and action receipts do not record per-tick requested versus applied keys, so they do not establish that it caused a particular fall. During construction, `BUILD_SHELTER` is outside `MOVES_UNDER_HOLD`, so a held shield pauses the action rather than composing its movement. During the candidate fights, `pursue:false` intentionally asks for no pursuit. Shelter failures cannot all be assigned to this snapping defect.

A comparison after the independent controller fixes would need fresh artifact-specific measurements. No result from those unfinished fixes is claimed here.

## Gates and limitations

All gates ran on the Desktop under the task root, using the runner JDK and Node:

- Gradle `build verifyCore --offline`: passed, 2,558,171 protocol/core assertions, plus entrypoint/mixin and packaging checks.
- `npm run test:contracts`: 639 passed, zero failed.
- Focused affected coordinator checks: 172 passed.
- Full `npm test`: 7,009 passed, 26 failed, 15 skipped, 7,050 total. This is a failed gate, not a clean full-suite claim. The source export has no `.git`/historical refs; several decision CLI and successor tests require those. Other failures include absent Python, the host ancestor `AGENTS.md`, POSIX mode expectations on Windows, paired-process cleanup/deadline assertions, and strict-smoke integrity/trace assertions. Those paths were not changed here. No matched baseline full-suite run establishes that every remaining failure predates this change. Detailed failures and raw logs are preserved.

Heavy work ran only on Desktop, under `C:\Users\player\arena-runner\d38-blaze3`, with ports 34000–34900. Detached workers keep logs and status on disk, use BelowNormal priority, initially shared a four-logical-CPU affinity, reduced to two after a high CPU sample, and require a 3 GB job budget plus 10% free RAM. Admission also checks CPU headroom. A transient CPU saturation during earlier parallel work was caught and own jobs were restricted; this does not support a claim that every Desktop sample remained below 90%. No other project, global runner configuration, auth data, or named-device power state was changed. Zero heavy jobs ran on Mini PC.

No push, pull request, or merge into integration was performed. The two Sol-low/default 45-minute games were not run because the six-repeat acceptance bar failed. All selected cohort workers exited with code zero; zero is harness completion, not gameplay acceptance. Speculative workers were stopped, and final process checks found no remaining d38-blaze3 Minecraft server.

## Evidence and handoff

Local artifacts: `/home/agaminggod/Desktop/Projects/arena-beat-game/evals/d38-blaze3/`. Selected evidence is `selected-summary.json`, `baseline-final4/`, `candidate-final4/`, `candidate4.jar`, `construction-selected/shelter.json`, `baseline-d31.json`, `candidate4-d31.json`, `build-selected.log`, `contracts-selected.log`, and `npm-final.log`. The Desktop copies and detached-worker status are under `C:\Users\player\arena-runner\d38-blaze3\evals\d38-blaze3`.

The earlier d38-blaze rounds remain the historical comparison, not additional current-jar repeats. Pilots, abandoned geometry, failed setup, and the speculative jar are excluded from the selected six-versus-six matrix. The stale-lease construction exception, the late shelter death, the unfulfilled rod-yield requirement, and the 26 full-suite failures remain open. No real Sol game has demonstrated that the model chooses this new action or uses it effectively.
