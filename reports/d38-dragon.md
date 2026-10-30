# d38-dragon: Sol kills the Ender Dragon

Branch `claude/d38-dragon`, base `81f5d9d8` (`claude/d22-int`). Implementation: `529a33e9`, `3995f7f7`, `1263fe0e`, `eaee88ff` (probe startup: `9bf6c5c7`, `3e448bbb`).

Sol killed the dragon at 43.93 minutes in Desktop game B, with no deaths. The final blow was its chosen bow shot. The four completed games produced one kill versus zero in the seven historical games; all four cleared the crystals. This is a successful fight, not established reliable survival or a matched live A/B improvement.

## What the seven games show

Sources are the five `w-desk-d38-endfix-r2-{a..e}-codex` games and the two `w-desk-d38-end90-{a,b}-codex` games. All use Sol low/default. The historical saves are v1; the requested new measurements use `6-end-v2.json`. Consequently the new live comparison includes both this patch and the v2 save-point improvement, and cannot isolate their individual effects.

The protocol was streamed on Desktop with Node `readline`, retaining only observations, action commands/results and reflex updates. Whole logs were never loaded into Desktop memory. Compact, compressed extracts, including original protocol filename and line numbers, are in `arena-beat-game/evals/d38-dragon/data/`. The longer games rotated away their earliest main protocol files; their complete `quality-protocol.jsonl` captures supply those observations and commands. Watcher truth is used only by these offline analyses and the measurement side of the probe, never by the player or scripted decision logic.

| Historical game | Crystals destroyed before the first End death | All crystals cleared at game minute | Best dragon HP | All deaths |
|---|---:|---:|---:|---:|
| endfix A | 10 | 12.49 | 128.0 | 0 |
| endfix B | 0 | never | 200.0 | 1 |
| endfix C | 0 | never | 200.0 | 3 |
| endfix D | 10 | 12.82 | 108.2 | 0 |
| endfix E | 10 | 14.50 | 100.2 | 0 |
| end90 A | 10 | 11.17 | 151.0 | 2 |
| end90 B | 5 | never | 191.0 | 6 |

The crystal count excludes a misleading zero when B fell below the island and the crystal chunks unloaded. It is not a crystal clear. These times use the first Watcher progress row as origin and can differ slightly from the long-run goal clock.

After crystal clearing, A lost a further 62 dragon HP over 27.92 minutes (2.22 HP/minute, 27.0 seconds/HP); D lost 91.8 over 27.50 minutes (3.34 HP/minute, 18.0 seconds/HP); E lost 89.8 over 25.67 minutes (3.50 HP/minute, 17.2 seconds/HP); end90 A lost 39 over 15.92 minutes (2.45 HP/minute, 24.5 seconds/HP). These are whole post-clear fight rates, including positioning, replies, recovery and misses. They are not DPS while swinging. No historical game killed the dragon.

### Damage and missed opportunities

Damage came from bow shots at the flying dragon and occasional head melee. No game used a bed explosion. The save kit has no bed or wool; logs show no End bed placement/use. A bed tactic remains possible only if the model obtains the materials and chooses it.

The bow already leads moving targets and can hit. A's `protocol.jsonl.2:352` reports: “7.9 blocks ahead of it); it struck the target, which flashed hurt”. There are 20 such shot confirmations in A, 21 in D, 15 in E, and 12 in end90 A, across the whole run including time before crystal clearing. These are hurt animations, not proof that every shot removed a specific amount of dragon HP. Confirmed arrow ownership alone is not a hit. A/E each have three explicit perched-arrow bounces and end90 A has six. This is a model timing/ammunition choice, not missing vanilla arrow damage at a perch.

The models normally chose the head UUID, not the dragon root. A has nine dragon `fight_target` calls, D twelve, E seven, and end90 A seven. The two early-void games and end90 B have no observed dragon melee commitment. Calls often start in flight, time out while approaching, or are cancelled. Counts include early dispatch rejection and cancellation, so a cancellation must not be read as zero damage.

The strongest successful example is E's fight ending at `coordinator.jsonl:6788`: a head fight with `pursue:true`, `shield:true`, `fleeAtHealth:12`, and a 20-second timeout was cancelled after 4.391 seconds. Watcher HP around it fell from 177.0 to 140.2, a 36.8-HP drop. Thus the body can deliver substantial melee damage during a short opening; the final cancellation receipt alone hides that progress. Concurrent/late projectiles and five-second Watcher sampling limit exact damage attribution.

The strongest body failure is D's `coordinator.jsonl:5719`: “hits 0” after 15.052 seconds with a head fight chosen. Its protocol starts the body around (-10.4,64.6,3.0) and the head at (3.14,65.91,-6.17). Over the next 15 seconds the body repeatedly moves between roughly x=-12..-7, z=3..8 while staying at 20 health and 15..19 blocks from the head. Perched wings push without contact damage. This is consistent with the approach going through the wings behind the head; the observations establish the repeated displacement and failed approach, not a measured per-tick collision source. D has four timed-out head fights and only occasional effective melee. A's nine head-fight windows have no sampled HP drop; seven are flight/visibility/reach failures, while the others are cancelled.

Observed stationary-on-fountain windows after the crystals are gone: A 21, D 22, E 20, end90 A 12. Median visible duration is 4.00, 5.75, 4.00, and 4.12 seconds respectively; D has ten windows longer than ten seconds and end90 A four. A/E have none. Windows are separated by a sampled flight label or a 15-second visibility gap. These are **visible windows**, not direct access to hidden dragon phase timers, so looking away can truncate or split a landing. The visible opportunity nevertheless often lasts less than a reply: decision-eval first-call medians were about 7.2–7.5 seconds. A/D/E/end90 A spent approximately 45%/34%/49%/43% of their sampled post-clear time more than 20 horizontal blocks from the fountain.

### Interruptions and responsibility

The historical End instruction regression was already fixed. The new task does not reintroduce `dragon_charging -> away_from_edge` advice. B/C die to the void about a minute in. End90 B dies to an enderman at about 4.7 minutes; end90 A dies to the dragon at about 27 minutes. Their later deaths are in the Overworld. Neither returns to finish the fight. The recovery branch and v2 save point own that recovery problem.

The survivors still spend time avoiding clouds and dragon contact, replacing interrupted programs, regaining health, and repositioning. Watcher labels much of the End damage `dragon`; its separate `dragon_breath` episode total is zero here. That does not establish that no breath damage occurred: do not recategorize all dragon-labelled damage as melee contact. Four nonlethal Enderman encounters in D also interrupt work. There is no evidence that beds or an exhausted hidden inventory were silently available.

E's model-created initial plan (`provider-turns.private.jsonl:1`, also `quality-initial-plan.json`) literally says “Place and use a bed before leaving the End; beds explode in the End.” It then adds “Use a bed beside the End portal before engaging the dragon.” This is a contradictory respawn prerequisite, not evidence of an executed bed tactic. E's model calls (`provider-turns.private.jsonl:11`) also include `fightTarget(...pursue:false...timeoutMs:6000)` followed by a pursuing replacement; line 15 explicitly moves to `(6,64,-7)` then calls a pursuing head fight. The model chose both positioning and the engagement; repeated displacement after the latter choice belongs to body execution.

The median gaps between observed post-clear landing starts are A 63.3 seconds, D 53.6, E 77.5, and end90 A 78.8. Visibility can split or omit a landing, so these are observed opportunities, not the hidden phase scheduler.

Model-side blockers: committing to a perch after its short opening, bowing a perched dragon, non-pursuing melee while out of reach, cancellations, waiting/repositioning away from the fountain, and treating a stronghold respawn bed as an End combat prerequisite. Body-side blocker: a chosen head approach from behind can be repeatedly displaced by the wings. The probe below isolates chosen fight execution from model latency.

## Change and validation

Commit `529a33e9` supplies fountain/perch facts before landing and removes a misplaced stronghold-bed requirement from the End fight plan. Additional Dragon-encounter facts explain that screaming endermen may be angry at the dragon and that the model's gaze guard must outrank movement reflexes.

The candidate body change routes a model-chosen dragon-part melee approach around currently visible wing contact volumes. It adds no target selection, unseen terrain, new combat routine, or Watcher input. Other targets keep their original path costs. Five pure movement assertions cover the detour and preservation of unknown terrain. The model-free stand-in uses only observations and ordinary model actions; RCON health/phase is measurement only. The real v2 kit and terrain are used with crystals removed before timing and full player health at the start.

### Primary model-free probe

Four Desktop trials, one east-side and one west-side start per arm, 240 seconds each. The same stand-in source (`30ec1bb33ac00aac4bd0d9d7369a7807791cca91b4d853b3a9e7481f1212d29a`), checkpoint, kit, reflex rules and action policy drive both arms. All start at player health 20 and dragon health 190 after the pre-clock crystal explosions. The real fight and dragon AI run normally during timing; only the scripted observation-driven model stand-in chooses actions. There are no provider calls.

| Start | Base HP/min | Candidate HP/min | Base / candidate deaths | Minimum player HP, base / candidate |
|---|---:|---:|---:|---:|
| East | 7.051 | 2.743 | 0 / 0 | 16.5 / 17.2 |
| West (held-out approach side) | 2.939 | 13.668 | 0 / 0 | 16.5 / 5.0 |
| Time-weighted combined | **4.986** | **8.143** | **0 / 0** | |

Combined progress is 63% higher, but the east trial regresses and the west candidate gets low before recovering. This is two approach sides in one world, not a proven general damage or survival improvement. The positive held-out-side result supports keeping the visible-wing cost for live validation; it does not establish a safe complete fight. Base measured best HP is 161.47 east and 178 west; candidate 178.74 east and 135.16 west. No probe killed the dragon. Artifacts: `arena-beat-game/evals/d38-dragon/probes/d38-dragon-v9-*` (explicit result/server logs only, no secret files).

An earlier Mini PC east pair before reservation measured 5.269 base versus 6.946 candidate HP/min, both zero deaths. Its west baseline timed out and that incomplete pair is excluded. Other early exploratory stand-ins defended distant screaming endermen and do not isolate the dragon approach. Desktop v8 failed before the measured clock: the default 30-second bridge wait expired during a 42-second initial chunk save. The test helper now accepts a longer startup-only wait and cleans a failed boot; the measured action timing is unchanged. None of these setup failures count as fight outcomes.

Decision screen on Desktop: eight post-clear moments from A/D/E/end90 A, six fresh samples per arm, final candidate `1263fe0e` **16/48 good (33.3%) versus baseline 14/48 (29.2%)**, +4.2 points, PASS, p(worse)=0.904, zero errors or ungraded samples. Player: `gpt-6.1-sol` low/default; judge: the same model medium with `AA_JUDGE_ALLOW_SAME_FAMILY=1`. Total concurrency two; candidate 48 fresh samples and baseline 48 cached samples from its unchanged source/fixture/profile. The current raw observations remain unchanged, and the recorded reflex rules and prior flying observation are restored through production rendering. A disclosed derived two-step stage plan acknowledges the actual ten own crystal breaks; earlier bed/recovery steps are omitted to isolate finishing decisions. The renderer describes that manual crystal completion as reported/unverified. Earlier conversation and exact original wakes are not reconstructed; observations within one game are correlated. Six cases remain below their 50% threshold. This passes the regression screen but does not establish an improvement or a held-out seed result.

Artifacts: `arena-beat-game/evals/d38-dragon/{postclear-cases.json,decision-final/}`. Source file/line, raw observation hash, prior observation provenance and replay diagnostics are retained. The previous `3995f7f7` screen before moving the anger fact measured 20/48 versus 14/48. The final result above supersedes it. An earlier ten-moment screen without restored reflex context gave 11/30 versus 8/30; it is secondary. The Desktop run's “model calls=0” counter is unavailable instrumentation, not zero provider requests: 48 final candidate samples were asked and 48 unchanged baseline samples were cached. Most player samples lack priced usage; $0.23 is the recorded final billed total, not a complete cost estimate.

### Save-point entry failure and repair

The first four Desktop launches (`w-desk-d38-dragon-{a..d}`) stopped during fixture setup with `QUALITY_SETUP_BED_NOT_USED: Found no elements matching respawn`. They never supplied a usable play window and are excluded from the four-game result. The live protocol showed the player crouching at the Overworld bed with no active action. A direct setup before goal start succeeded, ruling out goal ordering alone.

A controlled Desktop comparison then changed only the held item during a crouched click at a second bed. With an iron pickaxe held, the respawn stayed at the old head `(324,-28,2553)`; with an empty hand, vanilla set it to the new head `(322,-28,2553)`, without a forced flag. Crouch-use with a held item bypasses bed activation. Evidence: `arena-beat-game/evals/d38-dragon/{bed-beforegoal.json,bed-sneak.json}`.

`eaee88ff` moves kit granting after the real bed interaction in `coordinator/src/benchmark/quality-scenarios.mjs`. The player is cleared before bed use, then receives the same requested items and armour. The original unforced-head-position assertion remains. No checkpoint JSON, forced spawn, timed-play input or player decision changed. The existing fixture test now checks that bed use precedes granting the pickaxe. Post-fix checks: 49/49 PASS, contracts 632/632 PASS. All four retries passed setup and completed their configured play windows or stopped on the kill.

### Artifact and verification

Final Java/production coordinator jar: `d38-dragon-1263fe0e.jar`, 5,946,983 bytes, SHA-256 `12b3bab389192bad5769ffa4d832747548cb071fc9fd4d868aa8059417fafc5c`. The three edited packaged fact/planner modules match the source byte-for-byte. The probed and final jars have identical fight-controller and terrain classes; only one other anonymous terrain-reader class differs in bytes, with identical `javap -c -p` output. Metadata/disassembly evidence is in the evaluation directory.

Desktop Java build and verification PASS: 2,557,920 protocol/core assertions and 442 voice assertions, 34 tasks, 5m45s. It used one Gradle worker and 512 MiB caps on JavaExec verification tasks under a 2.5 GiB RAM reservation. The Windows distribution-only Node acquisition task was excluded after its downloaded executable could not be moved because of a file lock; that distribution step remains unverified. The previous uncapped portable Java/core build also passed. The bed repair changes only the benchmark setup module and its test, both excluded from the production jar, so the same verified jar pairs with the repaired runner checkout.

Final full Desktop coordinator suite on `eaee88ff`, in a separate check checkout: 7,031 tests, 7,002 pass, 16 fail, zero cancelled, 13 skipped. The three earlier appearance-budget regressions were repaired; all relevant fact/budget checks pass without raising a limit. Remaining failures concern the machine's OpenCode parent-instruction isolation, missing Python for speech fixtures, a transport byte-count assertion, and paired/strict launcher cleanup, timeout and integrity checks. This is not a fully green suite and is not the eleven known Linux platform failures. Logs: `arena-beat-game/evals/d38-dragon/desktop-final-eaa-{npm-test,contracts}.utf8.log`; final contracts also pass 632/632.

### Desktop live validation

Four retries use `C:\Users\player\arena-runner\aa-run-eaee88ff` with the verified jar above, the unchanged `6-end-v2.json` checkpoint, Sol `gpt-6.1-sol` low/default and a 75-minute limit. Tags: `w-desk-d38-dragon-r2-{a..d}`, ports 47000–47300. A started at 01:53:55 SGT, B/C/D at 01:57:39/45/53 on Oct 25. Each launch's actual process arguments were checked for the intended root, jar, model, tier, duration and checkpoint. Launches use `api/win-long.sh desktop-lan` and its 10% RAM guard, BelowNormal priority and 14-of-16 CPU affinity. Shared root/jar selectors were restored after each worker captured its pair.

At the Mini PC reservation no task Java, Node, Gradle or Minecraft workers remained there. All subsequent heavy work ran on Desktop. Only lightweight file analysis, editing, git and remote-control commands ran on the Mini PC. Watcher monitoring streams JSONL with bounded memory and never supplies its truth to the player. All four reports are final. A/C/D played 75.00 goal minutes and stopped at the wall-clock budget. B stopped its goal on the kill after 43.94 minutes; its server subsequently drained to the configured launcher deadline. The last positive Watcher dragon sample is not used as the kill predicate.

| Game (`w-desk-d38-dragon-r2-`) | Goal minutes | Crystals destroyed | Best dragon HP | Kills | All deaths | End deaths |
|---|---:|---:|---:|---:|---:|---:|
| A | 75.00 | 10 | 134.0 | 0 | 4 | 4 |
| B | 43.94 | 10 | **0** | **1** | **0** | **0** |
| C | 75.00 | 10 | 169.0 | 0 | 5 | 4 |
| D | 75.00 | 10 | 105.5 | 0 | 2 | 1 |

Compared with the seven historical games: kills **1/4 versus 0/7**; full crystal clears **4/4 versus 4/7**. The new games have 11 deaths over 268.95 goal minutes (2.45/h), versus 12 over 380 configured historical minutes (1.89/h). New first-life End exposure is 127.45 minutes with three fatal first lives, 1.41/h; the supplied five-game End-fix reference was 0.98/h. These small, unmatched samples do not establish a survival improvement. New saves, longer windows, and more successful returns change exposure as well as the implementation.

A died to a fall, two endermen, then dragon magic. C died to the void, an enderman, dragon magic, dragon contact, then an Overworld skeleton. D died to the dragon, then an Overworld creeper. A and C repeatedly returned to the End; D also returned near the deadline. Returning without the original kit still consumes much of the remaining window. None used a bed explosion or received supplies during play.

Death counts match exactly between goal-control protocol and Watcher episodes (4/0/5/2), filtered to the goal window. Crystal clearing is measured on the island with the dragon present; A/B/D also have ten explicit own crystal-break receipts. C has nine explicit break receipts and an early cancelled crystal shot; its Watcher count reaches zero at 14.29 minutes and stays zero during the active End fight. The cancelled receipt alone does not establish a miss. The source-numbered extracts retain that evidence limit.

All reports preserve `measurementStatus: INCOMPLETE`: the long-run metric object lacks the token-reconciliation field required by the generic quality-status checker. B/C have no observer errors. A records two “Quality player disappeared during sampling” warnings; D records two “RCON command timed out” warnings. No report has a run failure. These are retained, not relabelled as fully measured token accounting. Goal starts/stops, the advancement, HP/crystal samples and death cross-checks supply the outcome evidence independently.

All four report the same jar SHA above and coordinator SHA `3d88362cd99f05be20a9e4e345c6d1316b30788806d3425b42b2676c4863cfe2`. The runner checkout remained clean at `eaee88ff`. The live monitor exited normally after all four launchers finished. Evidence: `arena-beat-game/evals/d38-dragon/live/w-desk-d38-dragon-r2-{a..d}/` contains resolved long reports, setup/initial-plan receipts, streamed Watcher files, and compressed selected protocol rows with source line numbers. `analyze-live.py` recreates per-game `analysis.json`. The selected final archive is 6,451,200 bytes; no world, auth, credential or provider-home files were transferred.

B’s initial plan (`quality-initial-plan.json`) says “Wait near the central fountain for a perch, then finish the dragon”, after clearing crystals, with no End-bed prerequisite. B cleared all ten crystals at 10.90 goal minutes, with dragon HP 200. It then removed 200 HP in 33.03 minutes, 6.06 HP/minute (9.91 seconds/HP), including all replies, misses, repositioning and healing. It chose 25 head `fight_target` calls and 70 dragon `use_ranged` calls (58 head, nine body, three neck), with 21 confirmed dragon-arrow hurt receipts. Both melee and bow contributed; it used no bed. A 43.6-HP Watcher drop around 18.5 minutes overlaps a pursuing head fight; sampled damage cannot be assigned per swing. The final model-chosen body-target bow command is `quality-protocol.jsonl:17163`; its result at line 17180 says “it struck the target, which flashed hurt”. The same player receives `minecraft:end/kill_dragon` at line 17176, observed at epoch 1792867345876. Play stops at line 17185. These source-numbered extracts are retained under `arena-beat-game/evals/d38-dragon/live/w-desk-d38-dragon-r2-b/`. The Watcher drops dead entities, so its last positive sample is 1.1 HP; confirmed kill evidence makes the reported best HP zero.
