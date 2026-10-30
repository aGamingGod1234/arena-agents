# d38-measure results

Implemented on `claude/d38-measure`, based on `claude/d22-int` at `a68669f5`. No gameplay, player instructions, model settings, or Java sources changed.

## What changed

- `stage-score.mjs` streams samples, protocol, Watcher episodes and coordinator logs into first-life and post-death sections. It preserves observed deaths when later observation is censored.
- Launcher stop paths persist operator time and reason before signalling or force-killing. `run-long.mjs` embeds the ending, stage score and stop provenance. Reviewable external launcher copies, including Windows `stop.ps1`, are versioned under `scripts/quality/launchers/api/`.
- Resource records distinguish supplied inventory and reserve supplies, earned, held, spent, loss at death, and unclassified changes. Recipes conserve resource equivalents. Milestones distinguish first observation from holdings at stage end; endpoint requirements are six rod equivalents and twelve pearls/eyes.
- Every observed first-life death gets a trace with first-sensed hazard evidence, nonexpired server reflex statuses, dispatches, receipts, controller/input snapshots and damage evidence. Missing proof stays unknown.
- Ladder fallback rejects foreign, undated and out-of-window log advancements, and cannot substitute a different server goal predicate. Long-run advancement events are agent/window scoped. Old unbound server/log passes cannot survive rescoring.
- Decision `eval.md` and comparison reports count missing continuations and mark zero-good paired cases uninformative. Codex freezes timing before a tool response replaces the input timestamp. Reports use completed decision segments and preserve call/token counts.

## Demonstration

The same command was applied to original Desktop artifacts: `node scripts/quality/stage-score.mjs --demo ROOT --out RESULTS_DIR`. The scorer had a 256 MB heap limit. The snapshot contains **44 retained output directories, 23 with sampled gameplay, and 15 observed first-life deaths**. All 15 deaths have traces with retained protocol and live server reflex status. Unsampled directories are not proof that a game started, and are not counted as played failures.

`evals/d38-baseline` and `evals/d38-recover` reference the matching baseline/recover rows; those are not extra independent games. Five failed/unobserved first-generation End outputs and ten unobserved Dragon outputs are also retained in the full table.

| Cohort | Retained directories | With samples | First-life deaths |
|---|---:|---:|---:|
| Baseline | 14 | 8 | 6 |
| Recovery | 4 | 4 | 2 |
| End 40 min | 5 | 5 | 2 |
| End 90 min | 2 | 2 | 2 |
| Dragon r2 | 4 | 4 | 3 |

The 23 sampled outputs have 21 budget endings, one infrastructure failure and one unknown early ending. All unobserved continuation is censored. Builds, seeds, starting supplies and budgets differ; these rows are not a controlled gameplay comparison.

On baseline A, the original preferred usage-event stream has a **3 ms** median; completed decision segments have a **4,196.6 ms** median on the same logs. This corrects the measurement boundary and is not a speed improvement. The current training corpus has **261/275 cases without continuation**, versus the audit's historical 256/270; scripted replies are still not live execution. A synthetic 0/3 versus 0/3 comparison remains a regression-gate PASS but is visibly **UNINFORMATIVE** in the report.

See [the complete table](demonstration.md), [machine-readable scores](demonstration.json), and the individual per-run JSON files for supplies, stage-end holdings, loss estimates, timing and fatal traces. The five 40-minute End rows end with 9, 0, 0, 8 and 8 pearls/eyes respectively. First possession of the supplied two pearls therefore does not represent earned or retained progression.

## Verification

All coordinator checks ran on the Desktop, BelowNormal, restricted to 14/16 logical CPUs. No Minecraft game, server, build, or decision-model call was started for this task. Mini PC work was limited to editing, light scoring/packaging and a dummy sleep-process stop check.

- `npm test`: 7,012 passed, 16 failed, 15 skipped (7,043 tests). The unmodified base reproduced **the exact same 16 failure locations** across the corresponding 60 tests. These are the existing Windows lifecycle/smoke failures, missing Python, and OpenCode fixture expectations. This is a comparison of failure locations, not a full baseline suite rerun.
- `npm run test:contracts`: **634/634 passed**.
- Focused checks: **210 passed, one skipped**; shipping stage/long-run checks **37/37 passed**; final scorer/receipt-output checks **6/6 passed**.
- Linux and Windows stop-entry smoke checks stopped only owned dummy workers and verified persisted time/reason. Windows also updated `long-run.json` before stopping the worker. The Windows fixture used the actual versioned `stop.ps1`.
- No Java changed, so Gradle was not required. No byte budgets were raised.

## Evidence limits and deployment

The retained protocol does not expose definitive hands/aim owner identities or complete attributed damage-dealt quantities. All 15 traces include controller/reflex/input evidence and mark those missing proofs explicitly. Earned/spent resource quantities also remain unknown where causal quantity receipts are absent: gains are not automatically earnings, and disappearance is not automatically spending. Death-associated loss uses the last living sample and normal survival drops; it does not prove destruction. Samples cannot reconstruct invisible changes between samples.

Historical stop explanations cannot be recovered if nobody recorded them. Explicit `.done` stop times are preserved with an unavailable-reason label. An unexplained SIGTERM is not called an operator stop.

The external local `arena-beat-game/api` sources were updated and their reviewable copies are committed. The Windows wrapper sends the reviewed local stop source for each stop invocation, so recording works with older installed runners without deploying their scripts. A real wrapper-entry smoke check confirmed the reason, request/stop times, run-record update, worker-tree termination and stale-PID rejection. Failed taskkill attempts remain failures rather than stopped games. Desktop-installed launcher scripts and running games were not deployed or changed. This branch contains implementation and evidence for the orchestrator to integrate.
