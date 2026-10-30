# Stage measurement (d38-measure)

Run `node scripts/quality/stage-score.mjs RUN_DIR --out score.json`. `RUN_DIR` can be the long-run output directory or its raw `q-*` artifact directory. On the source machine the scorer follows the recorded artifact path. On a copied run it searches the `run-artifacts/run-*/q-*` tree. It never opens provider credentials or starts a game. JSONL and legacy sample arrays are streamed; terrain and entity NBT history are discarded. Compact timing values and the fatal encounter are retained.

For the dated cohort: `node scripts/quality/stage-score.mjs --demo ARENA_BEAT_GAME_ROOT --out RESULTS_DIR`. This includes every `sub/long/w-desk-d38-*` directory, including failed launches and partial observations. Baseline and recovery evaluation reports refer to these same games, so they are not additional independent trials. Keep build, seed, checkpoint, provider settings and observation coverage alongside any denominator.

## Endings and stages

`ending.kind` distinguishes `stopped`, `budget_end`, `failure`, `completed` and `unknown`. The independent `operator-stop.json` records time, reason and requester before a process is signalled or forcibly killed. Historical `.done` stop markers preserve the recorded time; an absent explanation remains explicitly unavailable. SIGTERM or an incomplete capture alone does not establish operator intent. Cleanup failures are reported separately from a budget already observed to expire.

The first life ends at its first observed death. Its failure remains recorded when the subsequent recovery is stopped or its budget expires. `afterDeath` contains everything after that death, including subsequent lives. Unobserved continuation is censored; this is not a fresh-world success/failure rate. Death timestamps from samples are upper observation bounds when exact lifecycle evidence is absent.

## Resources and milestones

Resources use rod equivalents (rod=1, powder=0.5, eye=0.5), pearl/eye equivalents, and barterable gold ingots (block=9, nugget=1/9). This avoids treating recipe conversions as earnings or losses. Supplied inventory and supplied reserve-container contents are separate.

Each stage reports supplied, earned, held, spent and lost fields. **Earned and spent are unknown when no causal quantity receipt establishes them.** Observed gains are not automatically earnings: they can be supplies, transfers, dropped-item recovery or gifts. Other inventory decreases are not automatically barters or consumption. Bounds have an unknown maximum because multiple changes can happen between samples. Loss at death is inferred from the last living holdings under normal survival inventory drops, and is not proof of destruction. A dropped stack can appear again in recovery.

Milestones preserve first observation as a diagnostic and separately report `heldAtStageEnd`. Acquisition alone does not establish retention. The scorer also reports whether six rod equivalents and twelve pearls/eyes are held at the endpoint. Missing inventories are unknown.

## Fatal encounter evidence

Each first-life death gets a trace joining Watcher first-sensed times, live server reflex status, commands, action receipts, controller/input snapshots, damage counter deltas and Watcher hazard damage. Only nonexpired, nondisabled server statuses count as live at that observation; Watcher advertised rule names alone do not. Rule status can be older than death, so observation age is reported. Matching Watcher hazard names distinguish covering rules from other live rules.

Hands/aim owners remain null unless the protocol records them. An active action, input vector or reflex firing is included as evidence, not converted into an invented ownership claim. Damage dealt remains unknown without attributed damage evidence. An attack dispatch is not a landed hit. Watcher hazard damage can overlap between episodes and must not be summed; vanilla damage counters use tenths of HP, while health-drop observations are lower bounds.

## Advancement and decision reporting

Ladder log fallback requires the exact player name and an absolute timestamp within the goal window. Date-free `HH:mm:ss` logs cannot prove that window. A server completion of another predicate cannot substitute for the requested check. Rescoring cannot preserve an old unbound server/log pass. Long-run protocol advancements are scoped to the selected agent and goal window.

Decision reports count cases without continuation and list cases where both arms score zero as uninformative, even when the statistical regression gate says PASS. Scripted continuations still do not execute Minecraft. Timing reports use completed provider decision segments and show usage-notification bookkeeping separately. Call counts and tokens retain their existing meaning. Codex freezes the input-to-tool-request timing before tool execution can replace the input timestamp; usage without an observed boundary carries tokens without an invented latency.

## Launcher sources

The external `arena-beat-game/api` directory has no Git repository. Reviewable launcher copies live under `scripts/quality/launchers/api/`, including their standalone stop recorder. The corresponding local workspace scripts were updated. The Windows wrapper sends the reviewed local stop source for that invocation, so it works with older installed runners without an installation step. No running game or Desktop-installed launcher was changed during implementation. Failed Windows taskkill attempts are marked stop_failed; stale worker PIDs are rejected before recording a new stop.

Stop forms:

- `api/win-long.sh desktop-lan stop TAG "reason"`
- `api/long-sub.sh stop TAG codex "reason"`
- `api/sol-queue.sh stop TAG "reason"`

The Windows stop script is UTF-8 with CRLF; stop records are UTF-8 without a BOM. `run-long.mjs` also records externally received signals, allowing the scenario runner to keep owning cleanup. A force kill still requires the external launcher record.
