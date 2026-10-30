# d38 End instruction fix

Branch `claude/d38-endfix`, based on `bb227cbcea782b9416da80903786f6c2ce684836`.
Implementation commit: `fae8af21ecf6d6a9bf6d31485d84c71d89eb5393`.

## Changes

- Removed exactly the End paragraph sentence beginning “A throw near a drop is the void: dragon_charging” from `coordinator/config/minecraft-agent/AGENTS.md`, including its above-work ranking and “maxS about 10”. Updated the paragraph's contract snapshot and identity in `coordinator/test/contracts/claims.json`. The paragraph shrank by 283 UTF-8 bytes. Java fight footwork, reflex vocabulary, and edge-near escape controls remain unchanged.
- Added exactly this sentence to the End-only return of `recoveryRoute()` in `coordinator/src/respawn-recovery.mjs`: “The platform is usually 20-30 blocks of void from the island; without blocks or a pearl, it is a dead end over the void.” This adds 121 bytes to that source file. No other recovery facts changed. `d38-recover` was given the exact wording and commit for reuse.
- Updated the existing route assertion and wake-rendering assertion in `coordinator/test/respawn-route-facts.test.mjs`. No byte budgets changed.

## Gates

- `./gradlew build verifyCore --offline`: PASS, 34 tasks, 3m 43s; 2,557,872 protocol/core assertions and 442 voice-addon assertions reported.
- `npm test`: 7,028 tests; 6,942 pass, 75 skipped, 11 known platform failures documented by the shared brief. Exit 1; not a fully green cross-platform suite. Failures are Windows-path, PowerShell, matrix CLI and native child-module diagnostics, unrelated to the changed files.
- `npm run test:contracts`: 631/631 PASS.
- Existing respawn-route tests: 7/7 PASS, including the real wake renderer carrying the added fact. This verifies text delivery, not live no-kit survival.

Full logs: `evals/d38-endfix/{gradle,npm-test,contracts}.log` in arena-beat-game.

## Build and Desktop deployment

- Mini PC run checkout: `/home/agaminggod/Desktop/Projects/aa-run-fae8af21`, detached at the implementation commit, with its own `npm ci`. The Mini PC long-game root and queue were not changed.
- Jar: `arena-beat-game/jars/d38-fae8af21.jar`, 5,879,761 bytes, SHA-256 `5b5f6ba7c45201635a68ff931a07b0958adeb90a0c5da970b780b86cbe147d57`.
- Verified the jar ZIP and compared its packaged AGENTS.md and respawn module byte-for-byte with the implementation checkout.
- Verified the SSH alias `desktop-lan` reports `Desktop`. No Arena long games were active; initially 23.2 GB RAM and 739.7 GB disk were free.
- Deployment used an incremental git bundle from bb227cbc plus task-specific `upd.ps1`, then `npm ci` on Desktop. Runner scripts refreshed with `api/win-long.sh desktop-lan install`.
- Desktop root: `C:\Users\player\arena-runner\aa-run-fae8af21`.
- Desktop jar: `C:\Users\player\arena-runner\jars\d38-fae8af21.jar`. `long-root.txt` and `long-jar.txt` point to those paths. The completed jar hash matches the Mini PC jar. Transfer: 5.88 MB in 2.10 s, 2.80 MB/s.
- Checkpoint: `long/checkpoints/6-end.json`, seed `20261009`, arrival `(100.5,49,0.5)`. Desktop/local SHA-256 both `fe67d41caa3536e7c678d52a22d690282fc52ab428e5b7b1eb2b9249e5af63d3`. The lava portal-room checkpoint was not used.
- Five concurrent detached WMI workers: `w-desk-d38-endfix-r2-a` through `-e`, port bases 30000–30400, each 40 minutes, model `gpt-6.1-sol`, reasoning low, service tier default, cost cap 1000. Exact entry point: `api/win-long.sh desktop-lan start <tag> 6-end.json 40 1000 <port-base>`.
- An initial five-game pilot was stopped and excluded: the jar had been copied while Gradle was still writing it. After the completed build passed, the final jar was checked, transferred, and all five measurements restarted with fresh r2 tags. Pilot output was preserved separately.
- Windows logs/status live under `arena-runner/sub/long/<tag>-codex*`; synced artifacts under `arena-beat-game/sub/long/<tag>-codex/run-artifacts`. Sync excludes the credential home, auth files, server worlds, protocol logs and RCON password. Archives were checked for credential paths before transfer. No other Desktop project was touched.

## Live result and comparison

**The enderman regression did not recur in this check:** 0 enderman deaths in 2.033 End-hours, compared with Oct 24's 5.7/h and Oct 23's 0.5/h. All End deaths fell to 0.98/h, from Oct 24 first-life 8.5/h and Oct 23 2.0/h. This supports keeping the small patch; it does not prove the old underlying risk is gone. The model still authored the charge rule because another runtime cue advertises it (below).

The requested five concurrent games each supplied 40.00 minutes of samples, 200.00 game-minutes total. All five final reports confirm Sol low/default, the final jar hash and the 2,400,000 ms window. Three bodies survived their whole first End life; the other two fell into the void in their first 1.2 minutes and never re-entered. Two additional zombie deaths in C occurred in the Overworld and are excluded from End rates.

Rates below use **time sampled in the End**, not the 200 total game-minutes. Each cause cell is count (deaths per End-hour). Historical values are those in d37-end-regress/REPORT.md, rounded there.

| Population | Games | End-hours | All deaths (/h) | Fall/void/drop (/h) | Dragon (/h) | Enderman (/h) |
|---|---:|---:|---:|---:|---:|---:|
| Oct 23, first lives | 36 | 17.22 | 35 (2.0) | 19 (1.1) | 7 (0.4) | 9 (0.5) |
| Oct 24, first lives | 9 | 1.06 | 9 (8.5) | 3 (2.8) | 0 (0.0) | 6 (5.7) |
| Oct 24, no-kit re-entries | 5 | 0.59 | 8 (13.6) | 4 (6.8) | 3 (5.1) | 1 (1.7) |
| d38-endfix, first lives | 5 | 2.033 | 2 (0.98) | 2 (0.98) | 0 (0.00) | 0 (0.00) |
| d38-endfix, no-kit re-entries | 0 | 0.000 | 0 (not measured) | 0 (not measured) | 0 (not measured) | 0 (not measured) |

| Measured game suffix | Sample minutes | First-life End minutes | End deaths | Other deaths | Best dragon health | Dragon killed |
|---|---:|---:|---|---:|---:|---|
| a | 40.00 | 40.00 | 0 | 0 | 128.0/200 | no |
| b | 40.00 | 0.87 | fall/void/drop | 0 | 200.0/200 | no |
| c | 40.00 | 1.11 | fall/void/drop | 2 | 200.0/200 | no |
| d | 40.00 | 40.00 | 0 | 0 | 108.2/200 | no |
| e | 40.00 | 40.00 | 0 | 0 | 100.2/200 | no |

Best dragon health: **100.2/200** in E. **No dragon kill** (no kill advancement and each authoritativeDragon flag false). A, D and E destroyed all ten crystals. Watcher recorded four Enderman episodes, all in D, none lethal.

Both End deaths were kit-equipped first lives. Their fall-clutch reports timed out saying “ground not in reach yet”; B died near (66.45,40.51,37.79), C near (69.26,47.21,34.74). These are counted as void deaths, without attributing them to a pearl landing from Watcher alone.

## What the model actually armed

All five copied model AGENTS.md files hash to `cdda8194c9533408e9b140d0aee3b58c4c1e312c443bd794736655d4e605b350`, exactly the edited source; none contains the removed sentence. Captured tool arguments still author `dragon_charging -> away_from_edge` in 5/5 games. Successful reflex-set events install it in 4/5 (A,C,D,E); B's captured attempt is not a successful set event.

| Game | Charge priority | Charge maxS | Gaze priority | Charge installed |
|---|---:|---:|---:|---|
| a | 8 | 4 (default) | 8 | yes |
| b | 9 | 3 | 8 | no |
| c | 8 | 4 (default) | 8 | yes |
| d | 8 | 3 | 7 | yes |
| e | 9 | 3 | 8 | yes |

The duration is **3 or 4 seconds rather than the old 10**, and A/C tie the gaze rule's priority instead of outranking it. Omitting the action's `blocks` also uses its default 6 instead of the removed sentence's 8. These are observed differences; this five-game test does not isolate which accounts for the survival gain.

A second cue remains in `coordinator/src/danger-contexts.mjs:29,51,184`: the End context advertises “dragon throws off edges (ender_dragon): no rule: dragon_charging -> away_from_edge”. This exact text occurs in A's captured input before it arms charge. Removing only the AGENTS sentence therefore does **not** suppress the rule itself. The remaining cue is reported as a follow-up, preserving this task's narrow scope, reflex vocabulary and edge-near escape advice.

## Measurement and limits

- `scan.py` integrates adjacent `quality-samples.jsonl` wall-clock intervals whose earlier sample is in `minecraft:the_end`, matching d37's denominator. It separates the first End life from later entries, checking armour on entry. There were no later End entries of either population in this batch.
- Watcher episode copies in run artifacts and output archives are deduplicated by episode **id**. All-dimension Watcher death totals reconcile exactly with quality-sample death counters: A 0, B 1, C 3, D 0, E 0. Only the End-dimension subset enters this table.
- The long-run reports label all five `TIMEOUT`/`INCOMPLETE`, with `WALL_CLOCK_BUDGET` and playedMs 2,400,001–2,400,013. A/D/E have no observer errors; B/C report “Quality player disappeared during sampling”. All five sample files still span 40.00 minutes and the deaths reconcile, so these are complete timed observations for this rate calculation, **not** a passing full-game score.
- This is one seed/save point, five stochastic runs, and a historical comparison rather than a simultaneous randomized A/B. Zero enderman deaths does not establish a true zero rate or precisely restore 0.5/h: the one-sided 95% Poisson upper limit is 1.47/h over this exposure.
- The no-kit platform sentence is verified through unit/wake rendering only. **Its effect on live re-entry survival is unmeasured**, because no game re-entered the End. The recovery helper owns broader route/respawn work.
- No body fix was made for the two first-life void deaths, remaining runtime cue, pearl arrival footing or slow dragon damage.

## Evidence files

Under `arena-beat-game/evals/d38-endfix/`: this report, `scan.py`, `rules.py`, `finalize.py`, `results.json`, `authored-rules.json`, `deployment.json`, `transfer.json`, `status.log`, and gate logs. Source run artifacts are under `arena-beat-game/sub/long/w-desk-d38-endfix-r2-{a,b,c,d,e}-codex/run-artifacts/`. All five final archives were checked to contain zero auth.json/.codex-home paths before copying. The Mini PC long-game configuration and Desktop FORK-Tools queue were untouched.
