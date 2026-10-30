# Technical catalogue

The hard technical problems in Arena Agents, how each was solved, and what changed, in the order they were tackled. Written for the YouTube deep-dive: plain problem, solution and result, with numbers labelled measured or estimated.

Reconstructed on 2026-10-08 from the merged pull requests, the repository's plans and benchmark reports, and the T3 Code sessions where the work happened. Where a number could not be verified it says so. New entries are added with each pull request (see `AGENTS.md`).

## PRs #1 to #11 (Aug 18 to 29, 2026)

Dates are the PR merge date (UTC). PR #7 and #8 were never merged; #8 was split into #9, #10 and #11, so its content is credited to those.

### Testing real AI players without opening Minecraft
*PR #3 · Aug 19*
- **Problem:** The only way to know whether an AI agent really played was to watch Minecraft by hand. Random terrain made valid movement fail, the bridge used a fixed port, an open TCP port was mistaken for a logged-in coordinator, and a "pass" could be recorded even when Minecraft later said the action failed.
- **Solution:** A headless runner that boots a throwaway Fabric server per scenario, waits for an authenticated handshake, builds a flat test platform, sends a real task to a real provider, and only passes when Minecraft's own final action result says it succeeded. Everything is torn down afterwards, including the Windows process tree.
- **Result:** One live run on Fabric 26.1.2 with `gpt-5.6-sol` (high reasoning, fast tier) passed end to end: move_to `SUCCEEDED / DESTINATION_REACHED`, chat `SUCCEEDED / ACTION_COMPLETED`, program `FINISHED`, lifecycle `COMPLETED` (measured, PR description). 373 coordinator tests and 6,110 Java assertions passed (measured). No latency benchmark recorded.
- **Sources:** PR #3; T3 thread "Run Minecraft Testing System"

### Importing Minecraft structures from the internet without trusting them
*PR #4 · Aug 19*
- **Problem:** The arena needed a tower built from community map data, but downloaded archives can be malicious or corrupt, block data differs between Minecraft versions, and AI-generated map data had been only weakly validated.
- **Solution:** A fail-closed map pipeline: licensed sources only, no redirects, safe archive extraction, crash-safe journals, bounded parsing, and exact block-state checks against Minecraft 26.1.2. Four verified, upgraded Re-Structured modules plus a project-owned starter room make a five-stage "Thinking Tower"; structures containing entities, loot, jigsaw or control blocks are rejected.
- **Result:** Repeated conversion is byte-identical (measured, PR description); the pinned 26.1.2 catalog holds 29,873 validated block states (measured); 55/55 Python map tests, 422/422 coordinator tests, 8,633 Java assertions passed (measured). The same PR added 64 distinct validated agent skins. Live in-game visual QA was explicitly left as follow-up. No latency benchmark recorded.
- **Sources:** PR #4

### Agents that took 30 seconds or more to do anything
*PR #5 · Aug 23*
- **Problem:** Agents often waited 30 s or longer before a first visible action or a reply to a direct message. The old path asked the model for a big serialized plan, then pushed it through several scheduling layers, and each action's result only came back at the next planning call. Urgent player messages also sat behind the active model turn.
- **Solution:** The chosen model became the agent's only brain. Each agent keeps a persistent tool-enabled Codex thread, prewarms it as soon as it is ready, and calls Minecraft tools (observe, move, mine, craft, chat, short sequences) inside the same live turn. Urgent events are steered into the running turn instead of waiting.
- **Result:** Single-agent first visible action: 53 s, then 141.8 s, and a commonly observed 30 s floor on the Desktop (measured, earlier real-game runs) → 1.71 s (Luna low) / 1.87 s (Luna xhigh) warm (measured, authenticated Codex with simulated Minecraft results). That is 93.8-98.8% faster by the thread's own arithmetic, but it is a provider-path number, not an end-to-end game run. 16 concurrent agents: typical first actions 1.4-2.7 s (Luna low) and 1.8-2.9 s (Luna xhigh); steering accepted in about 1 ms (measured). Cold-thread first action stayed slow at 6.67 s low / 5.77 s xhigh (measured). A 10-trial alternating A/B on Luna xhigh showed no broad regression: warm DM first action 1.829 → 1.766 s (-3.4%), mine 4.386 → 4.012 s (-8.5%), but cold DM first action 4.949 → 5.560 s (+12.3%) (measured, P50). Open limit: the model cannot issue another tool while a Minecraft result is unresolved. Not measured: live provider load at 8 and 16 agents in a real Minecraft server.
- **Sources:** PR #5; `reports/native-tool-loop-performance-2026-08-22.json`; `reports/native-tool-loop-three-runs-2026-08-22.json`; `reports/native-tool-steering-ab-2026-08-23.json`; T3 thread "Run Minecraft Testing System" (comparison table, Aug 22)

### The "optimization" that made 16 agents 3.4 times slower
*PR #5 · Aug 23*
- **Problem:** An earlier optimized build looked fine for 1 to 4 agents but got far worse when 16 agents planned at once. The comparison was also confounded, because the baseline allowed 16 simultaneous planning slots and the optimized build only 4.
- **Solution:** The team kept a before-implementation baseline file with the exact commits and stated the confound, then normalized and re-measured the fixed scheduler, and eventually replaced the planning queue with the per-agent persistent loop above.
- **Result:** 16-agent stone task 3.184 s → 10.721 s (+236.7%) and 16-agent DM 2.640 s → 10.127 s (+283.6%); planning p95 3.3 ms → 7,529 ms (measured, deterministic simulator with delayed provider replay, 5 reps per cell, 50/50 passed). The fixed ArenaScript scheduler came back to 3.279 s (stone) and 2.708 s (DM) normalized (measured, per the thread's table). 1-4 agent cells were within about 1% (measured). One real Desktop baseline run of "gather wood, craft a wooden pickaxe" also failed: first action at 53 s, reported complete at 143 s, but the pickaxe was not in the inventory (measured, single run).
- **Sources:** `reports/performance-baseline-2026-08-22.json`; PR #5; T3 thread "Run Minecraft Testing System"

### Tests all green, real game broken
*PR #5 (fixes made on this branch, Aug 21-22; merged Aug 23)*
- **Problem:** The full suite passed (6,263 Java assertions, 359 coordinator tests) yet the first real laptop play-through failed in ways no simulator caught: the Create button always failed after launch, an agent cancelled its own walking action, one crafting script looped on a doomed recipe, and a server crash occurred on the first real launch.
- **Solution:** Each failure was reproduced as a red test from the live trace, then fixed. The coordinator now publishes the Codex model list immediately instead of waiting for Gemini and Kimi discovery. Ordinary movement observations no longer count as "attention" events that cancel the current action. Identical consecutive terminal failures stop a program. Respawn waits until Carpet has actually removed the old fake player. Lucas's rule afterwards: no build is "ready" until a live acceptance gate passes.
- **Result:** Startup race: auxiliary provider discovery could take up to 30 s sequentially while Minecraft was already authenticated (from the agent's code reading in the thread, not a timed run). Self-cancel: movement action cancelled after about 3 s (measured from live trace). Craft loop reproduced as `failedCrafts: 28`; the live trace held 32 identical invalid `break_block` attempts, 20 identical 10 s timeout retries and 26 repeated crafts (measured from trace). A DM took about 216 s to the first action although the command then reached the bridge in 5 ms (measured from trace). After the fixes the clean gate rose to 6,270 Java assertions and 368 coordinator tests. No before/after latency benchmark was recorded for these fixes.
- **Sources:** T3 thread "Run Minecraft Testing System" (positions about 437-500); PR #5

### Keeping the coordinator's child processes from escaping on Windows
*PR #10 · Aug 29*
- **Problem:** If the coordinator's root process exited, Windows reparented its children, so a short gap in process-tree polling (about 100 ms) let a provider process escape and survive as an orphan. A harmless startup failure, like a port conflict, could also be counted as a corrupt build and cause a healthy version to be quarantined.
- **Solution:** On Windows the coordinator starts inside a named kill-on-close Job Object before any coordinator code runs, so every descendant stays owned even after the root exits, and a replacement supervisor can reopen the same job without touching unrelated processes. Quarantine now needs the same attempt to authenticate and reconcile before a failure counts against the build. On Linux an equivalent session-ownership fix was proven on Ubuntu/WSL.
- **Result:** A provider spawned inside the old 100 ms gap is now killed after its root exits while an unrelated process survives (measured on WSL, per the thread). PR #10 coordinator 730/730, 8,843 Java assertions, 81 voice assertions; exact #9 to #11 integration 1,169/1,169 coordinator tests and 13,737 Java assertions (measured). No latency benchmark recorded.
- **Sources:** PR #10; T3 thread "Fix Agent Spawner and Group UI" (about positions 1360-1383)

### Minecraft decides when a goal is done, not the model
*PR #11 · Aug 29*
- **Problem:** Agents would acknowledge a task, do one action, stop, time out against a wall, or claim success when the item did not exist. Progress also got lost across reconnects and recovery.
- **Solution:** Goals are stored as frozen predicates (for example "block at X Y Z is air") that the game state itself checks, with evidence recorded. Unfinished work keeps a bounded recovery lease. Movement uses loaded waypoints, elevation-aware routing, hazard avoidance and progress supervision. Kill counts are server-authored so the model cannot weaken them.
- **Result:** Behavior change, not timed: an agent keeps working until Minecraft verifies the result, and asks for clarification when a goal cannot be represented safely. 1,088/1,088 coordinator tests, 13,158 Java assertions (measured). No benchmark recorded for completion rate or movement failure rate.
- **Sources:** PR #11; T3 thread "Fix Agent Spawner and Group UI"

## PRs #15 to #27 (Aug 29 to Sep 4, 2026)

### Shaving the coordinator's hot path, one allocation at a time
*PRs #15, #16, #17, #19, #20 · Aug 29, 2026*
- **Problem:** Every observation (a ~34 KB snapshot of nearby blocks, entities and inventory) passes through the same pipeline many times per second. The protocol guard that rejects duplicate JSON keys cost about 6x more than parsing the JSON itself, the fact-tree safety walk allocated a path string and an entry pair for every key, and the Minecraft server thread ran a full raycast on up to 512 candidate blocks only to throw most of them away.
- **Solution:** Each fix keeps output identical: visibility is checked lazily inside the ordered quota walk, the JSON scanner reads character codes instead of allocating strings and regexes, fragmented frames are no longer re-copied, labels and entry pairs are built only when an error is thrown, and inventory changes and item tags are tracked and cached instead of rebuilt every tick. Every PR is guarded by a differential test that compares against the old implementation.
- **Result:** (measured, 33.5 KB frame, 4000 iterations, 3 runs) JSON frame scan + parse 0.63 ms → 0.29 ms per frame; the duplicate-key scan alone was ~0.53 ms vs ~0.09 ms for JSON.parse. (measured, 33.8 KB fact payload, 300 iterations, alternating against main) per-watcher fact canonicalisation 1.57-1.63 ms → 1.01-1.06 ms (about 35%). Lazy visibility on a saturated test case tested 3 candidates instead of 41 (test case, not live game). Equivalence tests: 132 assertions (lazy selection, 64 seeded sets), 24 hand-picked + 2,000 random frames (JSON decoder), 44 adversarial + 400 random fact trees. No in-game benchmark recorded for #15; #19 and #20 state no figures (#19 added a fragmentation benchmark script). Caveat: a later audit (Optimize Agent Arena Latency thread) judged JSON framing "unlikely to move end-to-end latency", because model calls take seconds and coordinator work takes milliseconds.
- **Sources:** PR #15, #16, #17, #19, #20; T3 thread "Optimize Agent Arena Latency"

### Stopping actions that went stale in flight
*PR #18 · Aug 29, 2026*
- **Problem:** Minecraft kept reporting "Coordinator action revision is stale". The coordinator checked an action was still valid, then awaited the handoff to the game; during that gap a goal change or agent lifecycle event could advance the revision, so an obsolete command crossed the bridge and was only rejected by the server.
- **Solution:** The coordinator re-reads the live agent state immediately before sending, in both the native-tool and ArenaScript paths, and drops stale or disposed actions locally. The server-side check stays as the final authority.
- **Result:** No benchmark recorded. Observable outcome: a stale action no longer enqueues any bridge command (regression test), while a genuine bridge-originated STALE_PLAN is still reported. 64 focused tests passed.
- **Sources:** PR #18

### Giving agents real player controls, with a deadman switch
*PR #22 · Aug 30, 2026*
- **Problem:** Agents only had high-level actions, so they could not do precise jumps, strafing, attack timing or aiming like a human player. A stalled agent holding an input could also leave its player walking or attacking forever, and arena matches ignored their configured duration.
- **Solution:** A strict `control` action sends one bounded frame of raw input (movement, jump, sneak, sprint, attack, use, yaw, pitch, hotbar slot) for a set number of server ticks, with a 40-tick deadman that releases held controls and hands input back if the owner goes silent. Scenario clocks now finish exactly once at the configured duration, and parkour courses gained sideways variation.
- **Result:** No benchmark recorded. Observable: stalled control expires after 40 server ticks (2 s at 20 TPS, computed from tick rate); matches end on schedule with a recorded reason. PR reports 1,198 coordinator tests, 14,072 Java core assertions and 260 voice assertions passing. Third-party map geometry was kept out of the repo for lack of license evidence.
- **Sources:** PR #22

### A 19-finding security audit, fixed the same day
*PR #23 · Aug 30, 2026*
- **Problem:** Nine parallel reviewers audited the whole project and, after deduplication, found 19 issues (0 critical, 3 high, 12 medium, 4 low). The highs: ordinary players could start or replace operator-controlled agent goals through chat or voice; Gemini planning handed untrusted game text to a CLI with no enforceable no-tool boundary; and builds ran a mutable Fabric Loom snapshot. Others included reusable bridge secrets exposed to spoofed loopback services, unbounded queues, and provider subprocesses inheriting unrelated credentials.
- **Solution:** Replaced the shared bearer secret with nonce-bound mutual HMAC authentication, separated bridge and voice credentials, gave each provider only its own environment variables, bounded every queue and body, restricted control actions to operators, and pinned and checksum-verified dependencies. A separate bypass review after the first patch found more gaps (pre-auth socket eviction DoS, Windows ACL handling, journal growth), fixed before the PR. Gemini was disabled in production rather than shipped unsafe. SEC-001 was knowingly accepted and left unchanged.
- **Result:** (measured, from PR and thread) SEC-002 to SEC-019 fixed; `npm audit --omit=dev` 0 vulnerabilities; 1,217 coordinator tests passed (2 skipped); 14,144 Java core and 271 voice assertions passed. Rollout caveat: Java and Node protocol must deploy together. No exploit-success numbers exist.
- **Sources:** PR #23; T3 thread "Agent Arena Security Audit"

### Making agents react faster under load, and refusing to claim a 2x it could not prove
*PR #24 · Aug 30, 2026*
- **Problem:** The goal was agents deciding about 2x faster. An audit found warm model turns re-sent a large planner prompt, observations were built every tick even for idle agents, urgent work (damage, speech) queued behind routine thinking, the coordinator slept a fixed 3 s at startup, and voice endpoints published late. An earlier experiment showed that capping planning concurrency from 16 to 4 made 16-agent runs about 3x slower, so a blunt cap was ruled out.
- **Solution:** Warm provider sessions with compact prompts, priority scheduling with reserved urgent capacity and cancellation fencing, raycast limits and trusted-fact reuse, cached protocol frames, faster voice endpoint publication, and removal of the startup delay for the owned coordinator. A paired A/B benchmark was built to fail closed on incomplete or mismatched runs. An adversarial review of the combined branch found regressions that normal tests missed (planner calls exceeding concurrency after an ignored abort, one speech channel falsely healthy, an occluded-world raycast spike), all fixed before the PR.
- **Result:** (measured, fixtures stated in the PR) repeated planner contract 8,681 → 485 bytes on durable continuations, i.e. warm prompt payload 94.4% smaller; voice endpoint published 140 ms earlier; ArenaScript fact reuse 0/50 → 50/50; 16-watcher fixture 27 → 438 stable observations per second; 8x fewer entity line-of-sight checks in crowded scenes. The deterministic A/B run (8 arms, 40 repetitions) matched outcome hashes but showed no overall 2x wall-clock gain, and the PR says so. Baseline warm first-tool latency was ~1.7-2.4 s and cold first action ~5-8 s (existing repo evidence, mostly model time). The 438/s and 140 ms figures are quoted from the PR; I did not find the raw artifacts.
- **Sources:** PR #24; docs/plans/2026-08-30-agent-latency-performance-optimization-plan.html; T3 thread "Optimize Agent Arena Latency"

### Surviving crashes, reconnects and bad installs
*PRs #25 and #26 · Aug 30 and Aug 31, 2026*
- **Problem:** A nine-agent reliability audit found failure paths where a finished result could be lost across a disconnect, completion retries stopped forever after a bridge outage longer than five seconds, cleanup could leave stuck inputs or items, one player's voice overload could hit unrelated players, and installs could leave the coordinator and bundled Node on different versions. A follow-up audit added: action results were not durable across a crash, arena resets had no safe confirmation or evacuation, and offline test servers could bind beyond loopback.
- **Solution:** Acknowledged terminal-result replay, a checksummed append-and-fsync action journal with torn-tail recovery, transactional input leases, per-player voice backoff, confirmation before destructive arena rebuilds, loopback-only validation, and transactional distribution updates that roll back as one unit with a pinned, checksum-verified Node.js 22.23.2. New Windows and Ubuntu CI gates exposed platform assumptions in existing tests (Windows paths, timing on shared runners).
- **Result:** (measured, from PRs) #25: 1,221 coordinator tests, 14,290 Java and 277 voice assertions, 119 embedded coordinator files verified in the jar, rollback tested at injected failure points. #26: 1,320 coordinator tests (1,317 passed, 3 skipped), 18,908 Java and 298 voice assertions, Windows distribution 0.2.0 with 142 files, and a real staged Fabric boot with the bundled coordinator. No recovery-time or failure-rate benchmark recorded.
- **Sources:** PRs #25, #26; docs/plans/2026-08-30-application-reliability-sweep.html; T3 thread "Improve Agent Arena Reliability"

### Agents that only claim what the world confirms
*PR #27 · opened Sep 3, merged Sep 4, 2026*
- **Problem:** Agents looked functional while the game disagreed. Clicking Create once could spawn five agents because a regression left the button live. Movement could report arrival while blocked, mining could advance while aiming at air, proximity voice entered "processing" without real speech, and agents inherited Lucas's global Codex instructions instead of arena rules.
- **Solution:** Success is now decided from what Minecraft shows (observed position and collision, target in reach, live break progress, verified block change) rather than timers or controller intent. Creation uses a one-shot gate that rejects duplicate submits and releases only on a failed send; each agent gets an isolated Codex home; voice requires sustained speech and reports explicit listening, processing and no-speech states; release installs became transactional across both jars, the coordinator and Node.
- **Result:** (measured, real headless Minecraft) exact oak-log mining passed 3/3 with an independent RCON check that the block was air; a movement run reported arrival in 10.4 s only after a verified standing position (thread report). Create gate: 5 attempts → exactly 1 dispatch and 1 close, and a failed send allows one retry (unit test, not an in-game demo). Suites: 1,341 coordinator tests (1,338 passed, 3 skipped), 374 voice assertions. A live mining run also showed that adding the word "action" to a goal changed its completion check to operator confirmation, which the factual check correctly refused to skip.
- **Sources:** PR #27; T3 threads "Prevent Duplicate Agent Creation", "Fix Voice Chat and Goal Responses"

## PRs #30 to #37 (Sep 4 to 20, 2026) and the Ender Dragon feasibility run

### An agent that treats death as a brand-new game
*PR #31 · Sep 4*
- **Problem:** When an LLM agent died, it behaved like a new episode. It re-crafted a stone pickaxe it had just lost on its corpse, and once it had tools it stalled instead of going to look for Nether or structure facts. Minecraft is an exploration game, and death is the same run.
- **Solution:** A coordinator-side wrap, with no extra planner call and no new Java tactics. It remembers the last live state across death and disconnects, separates what is on the agent now from what it lost, and offers hints such as recover corpse, explore frontier or interact with a cue. These are options only. The wrap never dispatches an action, so the model still decides.
- **Result:** Observable outcome only: death keeps the goal alive, and "already have" is computed from current inventory, not corpse loot. Tests: 74 coordinator wrap and native-tool tests passed (measured, PR description). The PR diff was +2,731 / -40 lines over 15 files. No live before/after benchmark recorded.
- **Sources:** PR #31

### Making a fake player look like ChatGPT, Claude or Gemini
*PR #32 · Sep 5*
- **Problem:** Agents were visually generic, and the in-world bodies are Carpet fake players, so changing the old entity texture path changed nothing the audience would see. Staging a repeatable short scene also needed hand-placing every actor.
- **Solution:** Generated deterministic 64x64 pixel-art brand skins, with each logo confined to the 8x8 front-face UV square. These are routed through the identity lookup that the roster, fake players and legacy renderer all use. On top came an opt-in, world-persisted, server-authoritative Skit Mode with named summons, placement, saved timelines and playback.
- **Result:** Brand skins for ChatGPT/OpenAI, Claude, DeepSeek, Gemini and Kimi. DeepSeek has a skin but no model backend, and the PR says so. Verified with the skin generator `--check` and `verifyCore`: 19,003 protocol and bridge assertions passed (measured). The PR diff was +3,479 / -89 lines over 173 files. No rendering benchmark recorded.
- **Sources:** PR #32; docs/plans/2026-09-04-agent-skit-mode.html; docs/agent-logo-skins.md; T3 thread "Add Agent Skins and Skit Mode"

### Deleting 12,881 lines without losing a feature
*PR #33 · Sep 5*
- **Problem:** A retired fixed two-client control stack still sat beside the live provider paths. It bloated the release and kept expensive observation and journal work on hot paths even when nothing had changed.
- **Solution:** Parallel Luna subagents in isolated worktrees removed the legacy client stack and dead executor branches. Idle agents now get per-agent heartbeat cadence and an unchanged-observation fast path. Bridge messages are sized by exact UTF-8 length, and the action journal compacts by streaming. A retained-feature audit script checked that camera, skit, voice, map and pathfinder features survived.
- **Result:** Footprint (measured by git): +889 / -12,881 lines over 107 files. The post-merge audit reported 11,992 fewer tracked lines, 7,437 fewer production-source lines, and main/client Java down from 67,138 to 59,714 lines (measured, audit pasted by Lucas). Production packaging went to 96 coordinator files. Coordinator tests were 1,410 passed, 3 skipped, 0 failed. One idle agent "schedules roughly 90% fewer observations" (estimated from the audit; the method is not in the sources). No CPU or FPS benchmark recorded; PR #34 says live gains still need one.
- **Sources:** PR #33; T3 thread "Optimize Performance, Reduce Code"

### Proving a cache is safe: stationary agents stop re-casting 91 rays
*PR #34 · Sep 5*
- **Problem:** Every observation rebuilt the same 91-ray landmark fan for an agent that had not moved, and re-asked the level whether the same chunks were loaded. A naive cache would serve stale terrain after a block changed.
- **Solution:** A bounded cache keyed on exact eye pose, view angles, dimension and collision context, plus bounded regional mutation revisions. Block writes, chunk loads and animated shapes (shulkers, pistons) invalidate it, and a secondary line-of-sight check stays fresh. The coordinator also shares one cloned observation instead of two.
- **Result:** A 200-update observation benchmark with the same 13,467-byte observation went from 600 to 400 structuredClone calls (measured, independently reproduced). A headless Fabric boot reached "Done", and 10 transformed-runtime assertions covered same-tick writes, direct chunk writes, distant mutations and shulker/piston animation (measured). A first live smoke failed because the access interface sat in Fabric's reserved mixin package; it was moved and then passed. No CPU, FPS or TPS figure was recorded.
- **Sources:** PR #34; T3 thread "Optimize Performance, Reduce Code"

### A twelve-reviewer audit that hunted bugs at chunk borders
*PR #35 · Sep 7*
- **Problem:** Failed control actions could leave physical keys held down or throw out of the server tick. Sight rays could load unloaded chunks at exact chunk boundaries, because vanilla clipping expands its start backwards. Invisible light blocks leaked into observations, and camera playback broke on respawn.
- **Solution:** Twelve subagents reviewed all 31 changed files and the adjacent callers in two waves, each fix had a separate file owner, and the primary agent reviewed them together. Fixes: cleanup survives partial input failures, camera sweeps are supervised, the sight guard covers the backward expansion and corner chunks, invisible blocks need a visible fluid, and camera playback stops on player replacement.
- **Result:** A fixed-seed 100,000-ray traversal found no returned endpoint entering an unloaded chunk after the fixes (measured). Java checks: 14,726 core assertions and 385 voice assertions. Coordinator suite: 1,428 total, 1,425 passed, 3 platform skips, 0 failures. Five camera-mixin checks ran under real Fabric class transformation. CI passed on the final head. Not measured: live provider sessions, FPS/TPS, speech playback.
- **Sources:** PR #35; reports/pr35-followup-audit-2026-09-07.md; T3 thread "Deep Audit PR 35 Improvements"

### Playing Minecraft with zero vision
*PR #37 · Sep 8*
- **Problem:** Agents had to do ordinary player tasks through text and tools alone, but inputs were missing, observations were sparse, menus were incomplete, and action outcomes got lost. An independent safety controller also picked some reactions outside the model, which broke the rule that the AI is always the brain.
- **Solution:** Native tools and ArenaScript now share one validated action contract with focused observation queries and bounded model-written programs. Added: richer inventory, menu, recipe and event facts, ordinary menu clicks, boat and mounted-jump inputs, persistent world-scoped memory, and action receipts that reconcile unknown outcomes. A compact "hold N items from this set" goal lets the model express category goals. The tactical safety controller was removed.
- **Result:** Production-bridge mechanics: 9 of 9 checks passed on Minecraft 26.1.2 with no model involved (measured). Node suite 1,656 passed, 3 skipped. Java: 15,291 core assertions and 385 voice assertions. In a natural world, Codex Sol (low reasoning, priority tier) collected a log in 68 seconds through nine model-written actions (measured). Kimi K3 timed out at the 240-second budget during goal translation, before any gameplay action (the 240 s figure comes from the dragon thread). Full-game completion was not proved. The PR diff was +16,069 / -3,148 lines over 176 files.
- **Sources:** PR #37; docs/plans/2026-09-08-zero-vision-player-capability.html; T3 threads "Universal Game-Playing Agent Tools" and "Agent Feasibility: Ender Dragon Run"

### Can the agent kill the Ender Dragon? An audit that found the tools could not hit it
*Investigation after PR #37 · Sep 9-12 (branch codex/zero-vision-player-capabilities; no merged PR in range)*
- **Problem:** Lucas asked whether the tools could guide an agent to beat the game on a random seed. A read-only audit found the convenient combat tools could not target dragon body parts, a bed-explosion kill had no player in its damage source so credit would fail, and all 169 saved observations replayed through the formatter exceeded the 16 KB result limit (38 lost a non-empty entity list). A re-audit also found that dragon kill credit could vanish if the game was paused or reconnected during the death animation.
- **Solution:** A shared resolver for dragon-part targets, melee aimed at the part's true center (its eye position can sit outside its hitbox), and deterministic handling where head and neck hitboxes overlap. Kill credit now follows the logical goal and survives reloads. Added single-use item controls, explicit bow aiming, causal credit for bed explosions, and filtered queries.
- **Result:** Controlled fixtures: 14 of 14 live mechanics checks passed (measured). The dragon kill goal completed 10.05 s after the lethal hit, and 10.03 s with a pause/resume and a world save during the death animation (measured). Nether bed-explosion credit passed. Totals: 15,313 Java core assertions and 1,672 Node tests. The 14-check run took 30.1 s. A random-seed win was not attempted; the thread says it "remains unproven".
- **Sources:** T3 thread "Agent Feasibility: Ender Dragon Run"

### Rehearsing a 5-minute demo: 160 seconds down to 63
*Investigation after PR #37 · Sep 10-12*
- **Problem:** For a stage demo (collect four logs, return, deposit in a chest), the first isolated rehearsal with a real Codex agent failed Lucas's zero-error bar: 5 failed tool calls out of 27 plus 3 failed completion checks (measured), and 3 min 13 s including the operator-confirmation wait. Causes included stale plans arriving after goal completion, a "Fast" tier the provider confirms as "priority", and a mining tool description that said "visible" when it needed the exact block under the crosshair.
- **Solution:** Goal completion now interrupts the turn so stale calls are blocked. Pickup, mining and movement results carry fresh inventory and nearby-item facts. The agent runs in its own workspace with its own AGENTS.md and skill, with global instructions kept out. A broken Windows trace-file helper was fixed. Five parallel subagents handled navigation, tool feedback, instructions, isolation and measurement.
- **Result:** Same task and model settings, headless real-agent runs, timed by the agent (measured): 193 s (first run, 5 of 27 calls failed), 118 s, 160 s (one `NO_STANDABLE_PATH`, recovered), then 63 s and 107 s on the final build. The 63 s run had 12 successful server actions and none failed, about 61% less than the previous 160 s run. The 107 s run recovered from 2 gameplay failures. All final runs had four logs verified in the chest and no schema or transport errors. Log collection alone went from 135 s to 41 s in one trial. Node tests grew from 1,681 to 1,704. This is two final runs only, so consistency is not established, and the on-screen desktop rehearsal was blocked by a firewall prompt.
- **Sources:** T3 thread "Agent Feasibility: Ender Dragon Run"

### Filming a skit: saved work, honest errors and a tripod camera
*PR #36 · Sep 20*
- **Problem:** Staging a skit mixed staged actors with autonomous agents, and a cached name from another world blocked a summon because the code treated "in the shared profile cache" as "owned". Server command failures were hidden behind the Director screen, background updates interrupted typing, and a hardcore respawn pushed actors into Spectator and changed a global gamerule.
- **Solution:** A persistent Director cast with per-world name indexes, a correlated request/result channel so the form shows the server's real rejection, and a cast-only respawn path that keeps identity and returns Survival. Also added a wheeled tripod camera with lens height, pan, tilt and dolly controls, and saved camera paths.
- **Result:** Java: 15,655 core assertions, 387 voice assertions and 9 camera/presentation mixin checks (measured). Node 22 suite: 1,670 passed, 3 skipped. Native Computer Use verified the cast, tripod, recording, playback, and a hardcore respawn in which all 58 gamerules were unchanged. A physical recording holds about 102 seconds of camera movement (stated in the PR). Not verified: Fish voice playback (HTTP 401 on the configured credential) and authenticated multiplayer. The PR diff was +6,277 / -467 lines over 211 files.
- **Sources:** PR #36; reports/pr36-independent-audit-2026-09-08.md; reports/world-player-names-2026-09-08.md; docs/plans/2026-09-04-director-mode.html; T3 thread "Improve Director Mode for Skits"

## PRs #38 to #47 (Sep 22 to Oct 7, 2026)

Notes: PR #43 was closed, not merged, so it is skipped. PR #48 is catalogued elsewhere. Almost every number below comes from a controlled fixture or a small live sample, and the sources say so. Do not present them as general gameplay speedups.

### Scripts instead of one model call per action
*PR #38 and #40 · Sep 22 and Sep 26, 2026*
- **Problem:** If the model has to be asked before every step (look, walk, mine, look again), most of the time goes to waiting on the model and the body stands still between actions. Agents also kept stopping their own routines to "reconsider" and then rebuilt familiar actions from scratch.
- **Solution:** The model writes a short bounded program (ArenaScript, run with `runProgram`), or a fixed chain of actions (`sequence`), once. The game then runs the steps at tick speed, checks fresh facts between them, and calls the model back only for something new. The model still makes every decision. #38 restored this path so a routine keeps running while the model thinks, and saved routines can be reused later by a short note key.
- **Result:** (measured, simulated bridge, 20 paired runs) one conditional routine instead of separate tool calls cut the gap between two actions from 126.092 ms to 16.610 ms p50, and the routine won 20 of 20 pairs. (measured, simulated bridge, fixed 2 s "thinking" delays) a 5-action program saved 2.0 s when the model's thinking overlapped movement, and independent `startAction` steps saved 4.5 s versus serial calls. (measured, Aug 22 probe from before this range, 16-agent provider with simulated bodies, quoted in the Sep 25 plan) move-then-mine took about 4.8 to 5.2 s through separate calls versus 3.26 to 3.36 s through one sequence. (measured, live Fabric, 8 vs 8 runs) the whole oak-log task median went 24.956 s to 20.794 s (16.7% faster) on #40, but those live runs did not actually use `runProgram`. The gain came from fewer model rounds, and the four close pairs split 2 wins and 2 losses, so it is promising, not proven. (measured, live, 2 trials each) in #38's six-minute gathering test the agent reached 8 oak logs in both after-trials versus 4 and 0 before, a small sample.
- **Sources:** PR #38, PR #40, `reports/opus-speed-benchmark-2026-09-25.md`, `reports/native-successor-handoff-2026-10-02.md`, `reports/realtime-comparison-2026-09-21.md`, `docs/plans/2026-09-25-human-speed-agent-actions.html`, `docs/performance/latency-evidence.md`

### Planning the next job while the current one runs
*PR #38 · Sep 22, 2026 (handoff numbers from reports dated Oct 2, shipped in PR #41)*
- **Problem:** When a routine ended, the body went idle until the model finished thinking about what to do next. That idle gap is wasted game time.
- **Solution:** Shortly before a routine's deadline, the system reminds the same model to prepare its next routine, with the lead time set from that agent's own measured provider-wait p95. The prepared successor is only allowed to start if the predecessor finished normally and a fresh guard check on the world still passes. It never starts on its own authority.
- **Result:** (measured, simulated bridge, 100 ms assumed decision delay, 20 pairs) the finish-to-next-start gap went 127.706 ms to 33.328 ms p50 (p95 128.989 to 33.769 ms), and the queued version won 20 of 20 pairs. (measured, installed Fabric jar, 1 sample) a real successor gap was 77.435 ms. Guard cases passed: a successor whose health guard was true when cached but false at handoff was rejected with no action sent. The earlier "50 to 200 ms saved" figure was an estimate and the report says the fixture does not validate it live. No model-latency or whole-game speedup was recorded.
- **Sources:** PR #38, PR #41, `reports/native-successor-handoff-2026-10-02.md`, `docs/performance/native-successor-live.md`, `docs/performance/latency-evidence.md`

### The agent could not see a tree it had already looked at
*PR #38 · Sep 22, 2026*
- **Problem:** In a six-minute "collect 8 oak logs" test, the agent did a full camera sweep and Minecraft really reported oak leaves about 72 blocks away. But the sweep summary has a 1,400-byte limit, and it was filled with repeated grass blocks and animals before reaching the tree, so the model never heard about it.
- **Solution:** The sweep summary now keeps one of each distinct thing it saw first (entities, blocks, items, landmarks) and only then adds duplicates, still within the same byte limit.
- **Result:** (measured, replay of the 8 recorded inspection samples) oak-tree landmark retained 0 of 1 before, 1 of 1 after, with the sample slightly smaller (1,379 to 1,344 bytes). (measured, live, 2 trials each, not counterbalanced) final oak logs 4 and 0 before, 8 and 8 after, first reaching eight at 182.541 s and 222.087 s. Both after-trials still timed out waiting for operator confirmation, so full lifecycle completion was 0 of 2, and the report warns it proves neither general reliability nor a causal speedup.
- **Sources:** PR #38, `reports/gathering-recovery-2026-09-21.md`, `reports/gathering-sweep-replay-2026-09-21.json`, `reports/gathering-retest-2026-09-21.json`

### An agent that kept thinking while it was only waiting
*PR #38 · Sep 22, 2026*
- **Problem:** After gathering the logs, the agent asked for operator confirmation and then waited. But every ordinary world update woke the model again, and the two new trials burned 54 and 35 model turns that used no tools at all.
- **Solution:** The waiting state now persists across turns for the same goal and session. Ordinary updates and automatic continuation cannot wake it, but urgent operator input still can, and a new goal clears it.
- **Result:** (measured, regression test) 7 model turns before, 1 after. (measured, 60 s live Minecraft check on the final build) 1 model turn, 0 zero-tool turns, no physical actions, quiet for 48.396 s after confirmation became pending. This is evidence of quiet waiting, not completed gameplay.
- **Sources:** PR #38, `reports/gathering-recovery-2026-09-21.md`, `reports/confirmation-wait-2026-09-21.json`

### Faster handoffs: a camera win that made one task slower
*PR #40 · Sep 26, 2026*
- **Problem:** Between actions the runtime asked the server for a fresh look at the world and waited, which could cost an extra server tick (50 ms) even though the server already pushes an observation after every action. Native continuations also built metadata only model turns need.
- **Solution:** Reuse the server's pushed observation (with a fallback to the explicit request), skip model-only work when the next step is an action continuation, and bound how much result data a sequence serializes while keeping the verification facts.
- **Result:** (measured, 4 live runs per arm, earlier experiment) the camera-sweep handoff median fell 103 ms to 50 ms (p95 112 to 71 ms), but the whole-task median got worse, 25.551 s to 29.814 s, because the model happened to choose more actions that time. (measured, tick model, 40 reps per arm) 8-step look-around 1,199.737 to 799.165 ms p50 with identical action hashes. (measured, final 8-vs-8 live comparison) whole-task median 24.956 s to 20.794 s (16.7% faster), camera handoff unchanged at 50 ms (already one tick), four close alternating pairs split 2 wins and 2 losses. The reports keep both the good and bad results on purpose. A single-trial pair in the Sep 25 plan (21.675 s baseline versus 27.211 s optimized) also showed the optimized build slower, and that plan concluded no live speedup follows.
- **Sources:** PR #40, `reports/native-pushed-observation-2026-09-25.md`, `reports/opus-speed-benchmark-2026-09-25.md`, `docs/plans/2026-09-25-human-speed-agent-actions.html`

### Sending the model about 45% fewer fixed tokens
*PR #41 · Oct 3, 2026*
- **Problem:** Every model call re-sent a large instruction block, tool definitions and verbose game-state replies. That costs money and slows turns, and cutting it blindly risks the model missing a fact.
- **Solution:** Shorter always-loaded guidance (with the full control reference still available on demand), repeated rows and values within a reply shared instead of repeated, and "what changed" views made opt-in with baselines reset at the right moments. Every compact reply had to reconstruct to the original exactly.
- **Result:** (estimated, `o200k_base` token proxy, offline replay, not exact billing) instructions plus tool definitions 16,067 to 8,767 tokens (45.4% less); 148 captured tool replies 193,694 to 174,084 (10.1% less, 148 of 148 reconstruct exactly, none grew); 30 generated decision events 126,623 to 114,228 (9.8% less). (measured, 2 factual scenarios, 4 runs with GPT-6.1 Sol) reported uncached input 33,193 to 24,476, with all four runs returning the expected facts. The PR says this does not establish gameplay quality, latency or allowance savings.
- **Sources:** PR #41, `reports/native-input-encoding-2026-10-02.md`, `reports/native-input-comprehension-2026-10-02.md`

### Teaching the agent to ignore progress that does not matter
*PR #41 · Oct 3, 2026*
- **Problem:** During a long cave walk, every finished leg of movement woke the model to "reconsider", even though nothing had changed. The body sat idle waiting for an answer that always said "continue".
- **Solution:** The model can attach its own `reassessWhen` condition to a pause (health, dimension, a hostile in view, changed support blocks), so ordinary progress is waived and only meaningful change interrupts. Urgent damage always still gets through, and the runtime never chooses a route or reaction itself.
- **Result:** (measured, simulated bridge, 12 pairs, 100 ms declared response delay) a 6-leg route took about 387 to 388 ms versus 938 to 941 ms p50, body idle time 553.507 to 6.807 ms, and reconsideration responses went from 6 to 0 per route, faster in all 36 pairs. (measured, installed Fabric jar, same 6 legs, 36 successful actions) route completion median 4,449.9 ms to 3,930.7 ms, and receipt-to-next-dispatch 106.497 to 3.360 ms. Neither measures model latency or whole-agent performance.
- **Sources:** PR #41, `reports/cave-navigation-attention-2026-10-02.md`, `docs/plans/cave-navigation-preparation-2026-10-02.html`

### Long-running agents that lose their place on restart
*PR #42 · Oct 4, 2026*
- **Problem:** Hard goals like a diamond pickaxe run for a long time, and that is where things fell apart. Context could be marked "delivered" before the live model session got it, unread messages were stranded after a restart, and cancellation ownership got lost during recovery. Benchmark receipts could also claim completion without trustworthy evidence.
- **Solution:** Acknowledgement now follows exact-session delivery, replacement sessions recover retained facts, unread input and memory survive lifecycle changes (memory partitioned by owner), and steering keeps the goal's spatial and survival limits. A 19-finding review follow-up fixed the remaining recovery and benchmark-receipt holes.
- **Result:** No speed benchmark recorded. (measured) Windows coordinator run 2,546 passed, 0 failed, 3 skipped; all 114 embedded coordinator files match source; the full CI workflow passed on the final commit. The PR states that token savings, model quality and diamond-pickaxe success remain unproven.
- **Sources:** PR #42, `docs/performance-reliability-followup.md` (linked from the PR), T3 threads "Review PR 42" and "Improve Agent Performance and Reliability"

### Actions stuck behind slow reads and disk writes
*PR #44 · Oct 5, 2026*
- **Problem:** Lucas asked for the agent's decided actions to reach the game as fast as possible. A review by 19 Astra and 2 Opus reviewers reproduced that cancellations queued behind slow reads, stale inspections stalled or failed a running program, disk writes sat directly on the action path, and results were truncated before compression even when the compressed answer fit (32 of 64 blocks sent in one synthetic case).
- **Solution:** Exact controls skip slow reads, each call tracks its own deadline, and valid receipts are released without waiting for durable bookkeeping. Repeated notebook snapshot writes became a checksummed, synced append-only journal, and stale inspections are fenced off.
- **Result:** (measured, simulated bridge, disk-backed, 30 alternating pairs, identical action hashes) receipt-to-next-send handoff 6.92 to 3.52 ms p50 and 11.25 to 5.95 ms p95. No installed-game, real-provider or power-loss latency was measured. The PR flags that older builds cannot replay the new journal, so saved state should be backed up. (measured) 2,683 coordinator tests passed, 3 skipped; 2,526,075 core assertions passed.
- **Sources:** PR #44, T3 thread "Review Game Agent Tool Calls"

### Watching and taking over an agent without teleporting yourself
*PR #45 · Oct 6, 2026*
- **Problem:** Vanilla spectator mode teleports your body to the target, hides the agent's hotbar, hearts and screens, and snaps you back every tick. A vanilla client can also only keep chunks loaded around one point, and remote players never receive food, XP, effects or hotbar contents. There was also no way to grab the controls of an agent.
- **Solution:** A custom `/spectator` view binds the client camera to the agent and draws vanilla's own HUD from a stand-in player fed by a per-tick state stream, while chunk, entity and sound tracking follow the agent and your own body stays loaded and vulnerable. `/takeover` pauses the model, leases the agent's body to the operator's input, and ends automatically if the operator's body loses 2 hearts, then resumes the model with a report of what changed. The same PR added the Claude provider.
- **Result:** No benchmark recorded. (measured) `verifyPovMixins` confirmed all 26 mixin target classes transform under Fabric Knot; about 400 new core checks passed; a real dedicated server booted with 43 mods in the smoke test. Camera, HUD feel and chunk following were not yet tested in a real client at merge time.
- **Sources:** PR #45, `docs/plans/2026-10-06-agent-pov-takeover.html`, T3 thread "Add Claude Models and Instructions"

### An agent that silently never thinks
*PR #46 · Oct 6, 2026*
- **Problem:** Launching a Claude agent on a machine without the Claude Code CLI produced no warning. The agent stood still and never thought, and the same happened with Codex or Antigravity when signed out or broken. The error was only sent as `agent_error`, which the server drops for agents with no active goal.
- **Solution:** A health probe at registration checks installed, working and signed in. A new `agent_notice` message always goes to chat with a fix hint and is replayed to late joiners. The same PR rebuilt first-person `/spectate` to show the agent's hands by hooking the hand renderer itself, which also covers Iris.
- **Result:** (measured, headless Fabric server plus coordinator on the Mini PC, `claude` removed from PATH) the chat notice arrived within the same second the agent joined, while a signed-in Codex agent produced no notice. No latency benchmark; the Iris and Axiom hand rendering was not yet checked in a live client.
- **Sources:** PR #46 (description and its headless check comment)

### Codex and Gemini vanished from the menu
*PR #47 · Oct 7, 2026*
- **Problem:** The Provider selector in the summon menu only offered Claude, so clicking it did nothing. Codex and Gemini had disappeared.
- **Solution:** The cause was that at connect the coordinator sent a model list containing only providers with saved agents, and the Minecraft bridge treated any non-empty list as complete and stopped asking for more. After startup reconciliation the coordinator now refreshes and publishes every provider, off the startup path so a slow or missing CLI cannot delay saved agents.
- **Result:** No benchmark recorded. (measured) a new regression test fails without the fix and passes with it; coordinator `dynamic-main` tests 55 of 55 pass; the full suite had 2,675 pass and 2 fail, the same two Windows ACL tests that also fail on unmodified main.
- **Sources:** PR #47, T3 thread "Restore Codex and Gemini Providers"

## PR #48 (Oct 7 to 8, 2026)

Notes: these numbers come from replaying recorded play sessions offline, headless servers and live play-testing. Cost figures are API-equivalent estimates at Claude Opus 5.5 list prices; the project actually runs on a Claude subscription through Claude Code.

### Long runs and the context bill
*PR #48 · Oct 8, 2026*
- **Problem:** Every agent kept one conversation that never stopped growing, and every model call re-read all of it, averaging about 87k tokens per call and climbing. The usual ways out are both expensive. Filling a 1M window means paying cache reads on up to 900k tokens per call (about $0.18 a call on Opus 5.5). Letting the provider auto-compact means the model writes a summary in output tokens and the cache restarts.
- **Solution:** At about 64k tokens the coordinator ends the conversation and starts a fresh one. It writes a short recap itself, with no model call, and every update already restates the goal, plan, notes and current facts. For our context growth rate, the cheapest point to reset works out at roughly 60 to 65k tokens.
- **Result:** (estimated, from a 58-minute Opus session's call counts) input tokens per hour of play fell from about 70M to about 20M. (measured offline, replaying a recorded Sol session) Codex input fell from 6.9M to 3.2M tokens (−53%). (estimated, 95% cache hits) the API-equivalent cost of that 58-minute Opus run fell from about $37.50 to about $13.20.
- **Sources:** PR #48 Technical catalogue, `coordinator/src/claude-service.mjs`, `coordinator/src/codex-service.mjs`, the T3 thread "Cut model token cost per session"

### The model was woken up for nothing
*PR #48 · Oct 7, 2026*
- **Problem:** While a script was running fine, every routine sighting woke the model, about every 3 seconds. 310 of 358 turns ended with the model doing nothing, and the model was busy about 90% of the time even at low reasoning effort. It also polled for status 93 times.
- **Solution:** While a script runs, routine updates are batched to at most one every 30 seconds. Danger, lava, damage and failures still wake the model immediately, and the tools now tell the model that results arrive on their own.
- **Result:** (measured, session replay) wake-ups fell from 310 to 41, and stale rejected answers from 17 to 0. (estimated) model busy time fell from about 90% to about 62%. (measured) a typical update shrank from 15.6 KB to 6.7 KB.
- **Sources:** PR #48, `coordinator/test/token-budget.test.mjs`, `coordinator/test/program-attention-throttle.test.mjs`

### Too slow to survive a fight
*PR #48 · Oct 7, 2026*
- **Problem:** A model turn takes several seconds, but a zombie hits about once a second and a creeper explodes 1.5 seconds after it starts hissing. The model only heard about a mob after being hit, and its "flee" was a walk that stopped at the first spot.
- **Solution:** Warnings fire the moment a mob starts targeting the agent. Fight and flee actions run until the job is done, with footing checks. The model writes its own reactions in advance ("creeper close, flee"), and they fire within a game tick. Each mob carries a live, uncapped risk score built from its size, health, speed, distance and real weapon damage.
- **Result:** (measured, replayed fight) updates sent to a thinking model fell from 13 to 7. (observed, live play) agents now escape creepers that used to kill them.
- **Sources:** PR #48, the T3 threads "Fix combat follow-through and dithering" and "Threat risk, retargeting, healing"

### Fake players aren't real players
*PR #48 · Oct 7, 2026*
- **Problem:** In Minecraft 26.1, Carpet fake players took no fall damage at all. A totem save was recorded as a death, so the agent was respawned at spawn. `/kill` disconnected the agent instead of killing it.
- **Solution:** Fall damage now runs vanilla's own check for fake players. Death capture checks for a totem the same way vanilla does. `/kill` is a real death followed by an in-place respawn.
- **Result:** (measured, headless server) a 20-block drop does 17 damage, the same as a real player. Before the fix it did 0. (observed, live play) totems and `/kill` behave correctly.
- **Sources:** PR #48, the T3 threads "Find why agents take no fall damage" and "Real deaths and in-place respawn"

### Takeover felt laggy
*PR #48 · Oct 6, 2026*
- **Problem:** Driving an agent's body had about a second of visible lag. The camera followed the body through vanilla's delayed entity sync, which takes 6 to 8 game ticks.
- **Solution:** The client follows the server's per-tick pose stream directly, and the hotbar responds instantly.
- **Result:** (estimated, from tick timing) movement delay fell from about 300 to 400 ms to about 75 to 125 ms. (observed, live play) it "works much better".
- **Sources:** PR #48, the T3 thread "Cut takeover input latency"

### Agents couldn't hear
*PR #48 · Oct 7, 2026*
- **Problem:** Agents only knew what they could see, so they tunnelled one block away from lava pools that a player would have heard.
- **Solution:** Server sounds now reach the agent, and client-only ambient sounds such as lava popping are recreated using the client's own odds. The model gets direction and distance.
- **Result:** (measured, headless server) an agent heard both lava pockets through one-block walls, in the right directions. A rescan costs 0.4 to 0.9 ms on the server. (observed, live play) a Sol agent located a hidden lava pool.
- **Sources:** PR #48, the T3 thread "Add hearing to agent perception"


## PR #48, continued: threats and healing (Oct 8, 2026)

### A creeper that read "risk 4" until it was three blocks away
*claude/threat-heal · Oct 8*
- **Problem:** In a live play-test a creeper hunting a Sonnet agent showed risk 4 at 16 blocks and only jumped to 100-200 at about 3 blocks, because risk measures danger right now and a creeper's blast cannot reach from far away. The model was alerted at once, but nothing in the alert said the creeper was closing in or how soon it would arrive. It took 5.5 s to decide, and by then the creeper was at the fuse.
- **Solution:** Every threat now carries its trend: closing speed, seconds until it reaches contact range (fuse range for a creeper, melee reach for others) and the risk it will have when it gets there. A hunter due within 3 s raises one extra urgent "imminent" alert. That alert, and a creeper closing inside 5 blocks, now reach a model that is mid-decision at once instead of being held for up to 2 s. The first alert also leads with a one-line outlook. The model still decides what to do.
- **Result:** First alert for that creeper: risk 4.3 with no trend → risk 4.3 plus "contact range in 5 s, about 145 there" (estimated with the risk model at 2.6 blocks/s closing; checked in the Java verification). Urgent alerts per approaching creeper: 3 → 4, with the new one about 3 s before fuse range (estimated). A creeper-close or imminent alert during a deciding turn: held up to 2,000 ms → delivered at 0 ms (measured in a replay test). The model's own 5.5 s first decision (2.8 s to first token on a cold 25.9k-token cache) is unchanged (measured, play-session-3 trace).
- **Sources:** `play-session-3-trace.jsonl` lines 548-842; branch claude/threat-heal

### An agent that died next to a cow and a piece of beef
*claude/threat-heal · Oct 8*
- **Problem:** After the creepers, the same agent sat at 6 HP with a food bar of 17. Minecraft only regenerates health at 18 or more, but the wake message said "a full food bar regenerates health". The model used its one heal turn to do nothing. The raw beef Lucas then threw to it never woke it again, because a new heal wake needed 2 more HP lost first. Agents with a task were worse off: food that was only in view raised no alert at all, and carried food raised an ordinary alert that a running routine hears at most once every 30 s.
- **Solution:** Heal facts now say whether the body is regenerating and list the food in reach as exact calls, nearest first: pick up this drop, hunt this cow, eat this item. New food in reach wakes an idle agent once per source. An agent with a task gets one urgent alert at 4 hearts when food is in reach, repeated only after 2 more HP lost or new food, and never more than every 10 s. The routine keeps running and the model chooses.
- **Result:** Beef thrown to an idle agent at 6.1 HP: no wake until health fell to 4.1 HP → woken with the exact pickup call on the next observation (measured, replay test). A tasked agent at 4 hearts with food in view: no alert → one urgent alert within the same observation, with no repeat at the same food and health (measured, replay test). Live effect on survival is not measured yet.
- **Sources:** `play-session-3-trace.jsonl` lines 884-933 and 2515-2523; branch claude/threat-heal

## PR #48, continued: what spectators see (Oct 8, 2026)

Notes: before numbers come from the recorded GPT-6.1 Sol "beat the game" session (play-session-3 trace, 117 move_to and 22 navigate_to actions with per-tick yaw). After numbers come from replaying the same positions through the new steering and from closed-loop simulations in the Java verification suite; no live spectated session has been recorded yet.

### The camera that spun 360 degrees on every stair
*Branch claude/spectate-visuals · Oct 8, 2026*
- **Problem:** Watching an agent dig a staircase, the camera did a full turn on every step. A one-block move carried the body about 0.2 blocks past the stair it was aiming for, and the walking code turned to face that point behind it: a 180 degree spin in four ticks. The next "look at the block" turned it the same way again, completing the circle. It happened in 76 of 117 short moves. Diagonal stairs also swung the view 90 degrees left and right at each step, and control frames, camera sweeps, mining and attacks could snap the view in one tick.
- **Solution:** Within the last block of a move, or when a waypoint has fallen behind, the agent keeps facing the way it was going and steps back onto the spot, like a player tapping S. On stairs it looks down the staircase instead of at each next block. Every other way the agent turns its head (control frames, camera sweeps, mining, attacking, using blocks, aiming a bow, opening chests and furnaces, and placing blocks that face a direction) now turns at player speed, and actions still wait until the view has arrived.
- **Result:** (measured, replaying the trace positions) moves with a spin over 120 degrees fell from 75 of 117 to 4 of 117 (the four are real turns toward targets more than a block away), and average yaw travel in the last block of a move fell from 141 degrees to 0. (measured, simulation) the stair overshoot now turns the view 0 degrees instead of more than 120, and on a diagonal staircase the view holds one heading instead of swinging 90 degrees at every step. (measured) no head turn anywhere exceeds 45 degrees per tick, and a 180 degree control turn takes about 6 ticks (0.3 s) instead of 1. Placing a north-facing piston from a view facing north used to jump the camera about 170 degrees in one tick; it now turns at most 45 degrees a tick and eases back afterwards (measured, verification suite).
- **Sources:** this branch, `ServerNavigationController.heading`, `NavigationMotionVerification`, `ServerActionExecutorVerification`

### Items that appeared in furnaces with no screen
*Branch claude/spectate-visuals · Oct 8, 2026*
- **Problem:** Crafting already showed its menu to spectators, but putting items into a furnace, moving items to or from a chest, equipping armour and pulling a tool from the backpack all opened the menu, moved the items and closed it inside one server tick. Spectators only see the state at the end of each tick, so ore "magically appeared" in furnaces and a pickaxe "just appeared" in the hand.
- **Solution:** These one-move jobs now run like a player: turn to the block, open the screen and show it, move the stack, keep the screen up a moment, then close it. The move itself is unchanged and still checked to the exact item count.
- **Result:** (measured, real vanilla furnace menu in the verification suite) a furnace load now shows the furnace screen for 3 ticks before and 3 ticks after the move, 0.35 seconds in all, instead of 0 ticks. In the play-test all 4 furnace actions and the 5 successful tool selections ran with no screen. A tool that is already on the hotbar is still selected instantly, like pressing a number key.
- **Sources:** this branch, `AdvancedInteractionService.PacedMenuTransaction`, `AdvancedInteractionRollbackVerification`

### A craft that failed because the agent picked something up
*Branch claude/spectate-visuals · Oct 8, 2026*
- **Problem:** Crafting is paced so spectators can watch it, which means it spans about a second. In the play-test the agent had just mined, and while it was crafting a stone tool it walked over a dropped item. The item landed in the slot the ingredient stack had just been lifted from, so putting the leftover back swapped stacks, and the safety check (comparing the inventory with how it was before the craft) counted the pickup as a broken rollback. The craft failed with "ROLLBACK_FAILED", and a craft cancelled with a full inventory failed the same way because vanilla drops what does not fit.
- **Solution:** Leftovers go back to their slot if it still fits them, otherwise to any slot that does, otherwise they drop at the agent's feet, exactly like vanilla closing a menu. The safety check now only judges the craft's own clicks: anything that changes between its ticks (pickups) is folded into the baseline, and items the craft itself dropped are counted.
- **Result:** (measured) the new verification reproduces the exact play-test message on the old code and passes on the new one: the craft completes, the pickup is kept and the leftover planks return to another slot. With a full inventory the craft fails with its real reason and all 5 planks are accounted for at the agent's feet, instead of "ROLLBACK_FAILED". In the play-test this was 1 of 12 table crafts.
- **Sources:** this branch, `AdvancedInteractionService.CraftTransaction`, `TransactionSnapshot.CraftPlacementGuard`, `AdvancedInteractionRollbackVerification`

## PR #48, continued: exploration and resourcefulness (Oct 8, 2026)

### Agents that walked past a shipwreck to strip mine
*claude/explore-resource · Oct 8, 2026*
- **Problem:** In a "beat the game" play-test, GPT-6.1 Sol saw a shipwreck, walked toward it and turned back to strip mine at Y 16; it ignored a cave next to spawn and left most of an iron vein. The agent only received individual block rows, so nothing in its view said "this is a shipwreck", "this is a cave" or "this vein is bigger than what you mined" (the trace shows 215 stone and 1 iron ore broken).
- **Solution:** The server now recognises what a player recognises at a glance, using only blocks in the agent's line of sight: built blocks inside a generated structure piece become one structure row, dark roofed open space in view becomes a cave row, and visible ore is grouped into connected veins with a count of the visible blocks. A newly seen structure wakes the model once; going there stays the model's choice.
- **Result:** (measured, headless Fabric server) a world-generated plains village was named from its edge and woke the model exactly once; an iron vein of 5 reported 3 visible blocks (2 were hidden); a dug 1x2 tunnel was not a cave and the cave beyond it was; a sunlit hillside overhang that first read as a cave was removed by requiring shade. Cost per wake (measured, token benchmark): +190 bytes for a typical cave and vein, +475 encoded bytes with every row filled.
- **Sources:** branch claude/explore-resource, `play-session-3-trace.jsonl`

### Was the strategy guide ever read?
*claude/explore-resource · Oct 8, 2026*
- **Problem:** The same play-test made 24 `capabilities` and 25 `taskPlan` calls, but the trace never logged arguments, so nobody could tell whether the model read the strategy guide that says caves and structures beat strip mining. The taskPlan pointer was a bare topic list, and the guide said nothing about carrying workstations (4 blocks placed, no crafting table or furnace ever broken), finishing worn tools (4 stone pickaxes crafted) or mining whole veins.
- **Solution:** Each reference read now traces its section and topic, and each taskPlan result traces the topics it pointed at, with no content. The pointer says what the read is for ("Read capabilities strategy:resources before mining..."), the guide's resources topic gained a resourcefulness section, inventory rows show `usesLeft`, and placed workstations the agent walks away from are listed as `leftBehind`. The always-on instructions gained one line and stayed under 1,500 characters (1,489 to 1,497).
- **Result:** The question is answerable from the next live trace; no behaviour change has been measured yet. (measured) tool wear made the raw event 246 bytes smaller on a 12-row inventory by dropping always-zero damage fields, at +98 encoded bytes for Codex.
- **Sources:** branch claude/explore-resource, `play-session-3-trace.jsonl`

## PR #48, continued: review fixes (Oct 8, 2026)

### A flee that walked toward the lava first
*PR #48 · Oct 8, 2026*
- **Problem:** After rotations were eased, a control step kept its movement keys pressed while the view was still turning. A "turn around and run" step walked partly toward the danger for its first few ticks, and a jump-and-place pillar step placed its block on the ground ahead instead of underneath.
- **Solution:** The view turns first with movement and clicks released, and the turn doesn't count against the step's duration.
- **Result:** (measured, verification) a 180° turn with forward for 10 ticks used to walk about 16 ticks, the first few toward the danger. It now turns in 6 ticks and then walks exactly 10 ticks in the requested direction. Pillar placement fires looking straight down (90°) instead of about 30 to 45° mid-turn.

### Seeing structures without slowing the server
*PR #48 · Oct 8, 2026*
- **Problem:** Structure, cave and vein sightings were recomputed on almost every observation, because the cache key used the exact view angle, which changes every tick with eased turning. Lookups could also load structure chunks on the server thread, and natural blocks inside a structure's bounds could report structures that weren't actually visible.
- **Solution:** Sightings are recomputed at most twice a second with a rounded cache key, lookups only read chunks that are already loaded, only built blocks identify a structure, and rows use the names a player would recognise.
- **Result:** (computed from the code) a constantly turning view went from up to 20 recomputes per second per agent to at most 2 (10× fewer). Per-observation milliseconds were not measured on a server.

## PR #49: far sight

### Seeing a village 200 blocks away, but not through a hill
*PR #49 · Oct 8, 2026*
- **Problem:** An agent's long-range vision was 91 fixed rays fanned across its view. The gaps between rays grow with distance (about 12 blocks apart at 100 blocks, 24 at 200), so a small hut or a nether portal in plain view was usually missed, and things it did hit came back as bare block rows ("cobblestone at 140 blocks") rather than "a building over there". Passive updates also repeated the same village on every update while it stayed in view.
- **Solution:** The server now starts from what the loaded world knows exists (generated structures, points of interest, biomes, lava, chests, spawners, and blocks that don't belong to the terrain outside any generated structure, flagged as "possibly player-built") and reports each one only if a clear line from the agent's eye, inside its view cone, actually reaches it. Lava blocks that line, and water or lava around the eye shortens it the way the game's fog does. Big things count out to 256 blocks, single small blocks only within 24, judged only by the part the agent can actually see. Structures are named up close and described by their materials and size from far away. A new survey tool lets the model pick what it wants to see, and lookAround can survey every heading it turns to, so seeing all around still costs the time to turn. At most 2 agents run this pass in the same server tick; the rest keep their last view for a tick.
- **Result:** (measured, headless flat-world server, a generated village plus a placed hut, cobblestone tower and nether portal, each at 50, 100 and 200 blocks in view) things reported went from 6 of 12 to 12 of 12. Before, only the 3 village sightings were named; the tower's 3 showed up as bare cobblestone rows, and the hut and portal were never seen. False positives: 0 of 6 (a village and a hut behind the agent, a hut behind a dirt hill, a buried hut, a hut behind a lava curtain, a hut removed just before looking). The first version saw that hut through the lava; this one doesn't. Server cost per agent per sight pass (measured, near the village): mean 0.11 to 0.16 ms (p95 0.15 to 0.19 ms) before, about 0.4 to 0.8 ms (p95 2.4 to 3.9 ms) after, at most twice a second per agent. The 91-ray pass (about 1.6 ms) still runs for landmarks and caves. With 8 agents moving and observed in the same instant, the worst server tick paid 17.7 ms for this pass without the per-tick cap and 6.1 ms with it (p95 14.5 → 3.7 ms, measured). A search through a dense block around the agent went from 1.7 to 0.9 ms per survey (p95 3.9 → 2.4 ms, measured), and searches for terrain such as stone are refused. Tokens (measured over 240 updates near the village): the sight block of a passive update fell from 87.5 to 18.5 bytes on average, because a seen village is now told once (and repeated for up to 30 s) instead of on every update. A default survey costs about 475 bytes, and the new tool adds 1,141 bytes to the tool list sent with every request (usually cached).
- **Sources:** branch claude/far-sight, `FarSight`, `SightedFeatures`, coordinator `survey` tool; measurement harness run against the built mod jar before and after

## Speed run: latency instrumentation (Oct 9, 2026)

### Knowing where the time goes before trying to save it
- **Problem:** When an agent felt slow, the trace could only say that a step took a while. It could not say whether the time went to the model, to the coordinator handing the action to the game, or to the game itself, so every speed idea was a guess.
- **Solution:** Every trace row now carries a wall-clock and a monotonic timestamp, the coordinator marks each stage from event to result (event ready, model turn sent, tool request, journal write, bridge send, result returned), and the Java server reports when it accepted, started and finished each action and which server tick that was. The server only sends these clocks to a coordinator that announced it understands them, so an older coordinator paired with a newer jar still works. A new `scripts/trace-latency.mjs` turns a trace into the per-action latency table with medians, p90 and how long the body sat idle.
- **Result:** (measured by the implementer, unit-level) the stamps cost about 3 microseconds and 32 bytes per trace row. The model never sees these clocks. This layer measures; it does not make anything faster by itself.
- **Sources:** this branch, `TraceWriter`, `ActionTimelines`, `scripts/trace-latency.mjs`

## Speed run: no wasted wakes (Oct 9, 2026)

### The model was woken up while its own action was still running
- **Problem:** While an agent ran an action the model had started itself, routine changes (a new block in view, a heartbeat) still woke the model. It could do nothing useful with them, so each wake cost a full model call and the action's real completion then woke it again.
- **Solution:** Ordinary wakes are now held while the model's own action runs. Dangers, chat and other urgent events still go through at once. The first held wake starts a 15 s timer, so a one-time sighting is released with the freshest facts even if nothing else arrives, and cancelling or replacing the action releases or drops what was held. The completion wake adopts the named reason of the wake it replaced. An earlier idea that also told the model early about remaining work was removed because replaying recorded traces showed it could add calls.
- **Result:** (replay of recorded play traces, implementer's figure, not re-measured at integration) 9 of 98 turns were held-back wakes, about 5.9% of model cost. Which wakes were held is traced as `native_wake_deferred_for_action` and `native_wake_resumed_after_action`.
- **Sources:** this branch, `dynamic-main.mjs` wake hold, `native-tool-runtime.mjs`, `test/wake-while-action-runs.test.mjs`

## Speed run: stable decision handles (Oct 9, 2026)

### Answering a danger wake with a handle that had already gone stale
- **Problem:** When danger interrupted an agent, the model's answer often named the program or action handle it had been shown, but by the time the answer arrived the handle had changed. The server refused it, the model had to be asked again, and each refusal cost a full model round during a fight.
- **Solution:** Urgent decisions are now checked against what changed since the model last saw the state, not against an exact handle. A reply that is still safe (at most 4 HP lost, at most 20 air lost, a threat no more than 2 blocks closer, no new attacker, with absolute floors for health, air, close threats, burning, projectiles and TNT) is accepted, otherwise the model is told at once and gets a fresh decision inline, capped at 8 changed rows. The mod never picks the action for the model.
- **Result:** (simulation of recorded danger wakes, implementer's figure) 13 rejections costing 51.5 s fell to 0. A reviewer replayed 4 cases and 3 were accepted as intended, and the last round added the absolute floors. Not yet checked live on a full match.
- **Sources:** this branch, `native-program-executor.mjs`, `native-tool-runtime.mjs`, `test/program-attention-throttle.test.mjs`

## Speed run: faster mining, crafting and placing (Oct 9, 2026)

### Waiting where a real player would not wait
- **Problem:** Block breaking paused after every block longer than the game's own delay, crafting 16 planks took one round trip per craft, a placement the body had blocked with itself was retried for about two seconds before giving up, and menu clicks were paced slower than an expert player clicks.
- **Solution:** The post-break delay is cleared the way vanilla clears it, so back-to-back blocks follow the game's real timing. A craft count above one craft's output stacks the crafts and takes the result once, with the click count planned from the real ingredient stacks, and `CRAFT_PARTIAL` says how many were made and why it stopped. A final placement refusal ends the attempt early, menu pacing is trimmed to expert-human speed, and a break result names a faster tool in the inventory when there is one. Break time, attack cooldown and turn speed still follow vanilla, and the model still chooses every block, recipe and tool.
- **Result:** (implementer's figures, measured on the headless server; per-item methods not re-run at integration) stone 900 → 650 ms per block, dirt 1044 → 799 ms, 16 planks 2.4 → 0.8 s, a hopeless placement 2.0 → 0.45 s to give up, menu actions 290 → 200 ms. A reviewer confirmed the block-hit-delay behaviour against vanilla's bytecode.
- **Sources:** this branch, `AdvancedInteractionService`, `BreakSpeedAdvisor`, `ServerActionExecutor`, `BlockPlacementAttemptPolicy`, coordinator simulator `virtual-world.mjs`

## Speed run: first-try ArenaScript compilation (Oct 9, 2026)

### A program that never reached its first action
- **Problem:** Sonnet copied native `act(...)` and `mine(...)` calls into ArenaScript. The compiler only accepted `player.*`; after adding aliases, `mine` fields such as `autoAim` still leaked into `break_block` and failed during execution, while `move_to` could still miss its default tolerance. Watcher handlers also checked chat before aliases were rewritten.
- **Solution:** ArenaScript now rewrites aliases before semantic validation, rejects unknown alias fields at compile time, and lowers `mine({autoAim:true})` to the native `look_at` at the block center followed by `break_block`, stopping if aiming fails. The aliases add the native movement and mining defaults, and zero-argument `respawn()` and `dismount()` compile directly. No prompt bytes were added.
- **Result:** (measured, replayed historical first-program sources in the simulated wall harness, first command dispatched through the normalizer and action stub) first-command rate: 0/12 before to 5/12 after. Seven captures still fail compile-time checks for missing required facts or unsupported syntax. (measured, three fresh Sonnet 5.5 low harness sessions) first-command rate was 0/3 because each first source omitted required `expectedBlockId` or mining arguments; all three goals completed after recovery.
- **Sources:** this branch, `coordinator/src/arena-script/parser.mjs`, `coordinator/src/arena-script/interpreter.mjs`; captured and fresh runs from Oct 9, 2026

## Speed run: less coordinator work per action (Oct 9, 2026)

### Asking the server for a second look right after every action
- **Problem:** After every action the server already publishes a fresh observation in the same tick as the result, but the coordinator also requested one of its own, so the server built a second observation per action. The coordinator also copied observation facts several times on the way in, re-serialised the notebook to count its size, and checked the journal directory on every append.
- **Solution:** Once an agent's last two results were each followed by the server's own publication, the coordinator waits up to 40 ms for that publication before asking, and falls back to a request if it does not come. The action is still journaled to disk before the command is sent. A publication only counts when it is strictly newer than the sample the result was fenced at, so a forced local death notice is never mistaken for fresh facts. Observation ingest copies once, size accounting is incremental, and the journal append skips the repeated directory check.
- **Result:** (measured, live headless server, 8 agents, 2,880 actions per side) observation requests per action 0.71 → 0.014. Result-to-next-command latency p50 23.2 → 21.7 ms, p95 58.0 → 42.6 ms, p99 85.1 → 51.2 ms. The first version's 75 ms grace was tightened to 40 ms from these runs, which kept latency level with the base.
- **Sources:** this branch, `native-tool-runtime.mjs`, `observation-adapter.mjs`, `notebook-action-journal.mjs`, `model-notebook.mjs`, `benchmark/coordinator-hot-path-benchmark.mjs`, `benchmark/live-hotpath-latency.mjs`

## Speed run: urgent steers return early (Oct 9, 2026)

### Steering while a player is still fighting
- **Problem:** A blocking fight, flee, navigation or camera call could keep hits and urgent threats from the model until the body call finished, up to 30 seconds. Queued danger updates also cost repeated model boundaries, and Claude's facts could be stale by the time it used them.
- **Solution:** Real damage and imminent danger now return the still-running action handle at the next provider boundary without cancelling the Minecraft action, with a hint naming the replace or cancel step. An interrupted sequence names its active step and leaves later steps unstarted. Claude builds the newest steer with fresh facts at delivery and merges older pending updates, and Codex gets the early result the same way. Wakes held back during the agent's own action never delay these: dangers still go through at once. Player messages and distant threats do not interrupt, because an early return for chat cost an extra model round per message, so they wait for the normal boundary. Tool descriptions are unchanged in size.
- **Result:** (measured, live Claude Code harness, 3 runs per arm, adjacent zombie hit during a 30 s navigation) hit to the model's next call fell from 32.2 s to 10.0 s on average, at $0.0467 → $0.0426 per episode. A chat question during the same walk costs the same as before ($0.0210 → $0.0211, 5 runs per arm). The first version that also interrupted for chat answered in 7.4 s but cost 24% more, so it was dropped.
- **Sources:** this branch, `native-tool-runtime.mjs`, `claude-service.mjs`, `codex-service.mjs`, `dynamic-main.mjs`, `ServerActionExecutor`, `MultiplexedServerBridge`

## Speed run: mid-turn context rotation (Oct 9, 2026)

### A long turn kept re-reading a growing conversation
- **Problem:** A long Claude turn with many tool calls re-reads its whole, growing context on every call. Rotation only happened between turns, so one long turn paid for the full history until it ended.
- **Solution:** Once the context nears the limit, a pre-warmed fresh session takes over at a tool boundary, which is the point where one tool has finished and the model has not yet seen its result. It receives the current event, a one-line digest of the turn's earlier calls and the exact tool result, exactly once, and any pending steer moves with it. If the warm session is not ready or fails, the turn falls back to a plain restart that keeps the finished tool result. Output from a retired session is fenced off by an epoch, so a late tool call from the old process never runs. Codex mid-turn rotation exists but is off by default (`midTurnContextRotation`) because the replacement thread lost a fact the model had noted in 3 of 3 runs; Codex still rotates between turns.
- **Result:** (measured, live Claude Code, Opus 5.5 low, 3 runs per arm, cost priced from every process including the retired and standby ones) 30 tool blocks: $0.984 → $0.927 (-5.7%). 45 tool blocks: $1.585 → $1.394 (-12.1%). Speed did not change, and a fact stated before the rotation was still used afterwards in 3 of 3 runs. An earlier headline of -71% came from not counting the retired process and was dropped.
- **Sources:** this branch, `claude-service.mjs`, `codex-service.mjs`, `context-carry-over.mjs`, `model-fact-encoding.mjs`

## Speed run: load-stable tests (Oct 9, 2026)

### Tests that fail because the machine is busy, not because the code is wrong
- **Problem:** Many tests waited on short wall-clock timers (a 30 ms sleep, a 50 ms deadline, a fixed number of probes) and failed when the machine was busy, even though the code was fine. A red run could not be told apart from a real regression, so every failure had to be re-run and checked by hand.
- **Solution:** Tests now wait for the real event, or run on a shared virtual clock where time only moves when the test moves it, and every remaining limit is a budget that only bounds a failure. Two real bugs surfaced on the way and were fixed: the Windows permission check ran whichever `whoami` came first on the path, which was Git's, and one history test's sleep let a message be delivered twice. The same treatment was applied to the tests added earlier in this speed run, such as the tool-dispatch trace, the held-back post-result request and the rotation and steer tests.
- **Result:** (measured) under heavy load the suite went from 17 failures and 18 cancelled tests to 0 failures in three full runs; every fixed file passed 30 consecutive loaded runs.
- **Sources:** this branch, `coordinator/test/fixtures/virtual-clock.mjs`, `private-artifact-permissions.mjs`, `benchmark/latency-runner.mjs`, about 30 test files

## Speed run: server tick hot spots (Oct 9, 2026)

### Fewer disk syncs and less repeated work on the shared server thread
- **Problem:** Every action forced 2-3 disk syncs on the shared server thread, sight rays always ran the full block clip, and each tick repeated path checks and secret-file hashing.
- **Solution:** One journal sync runs before actions run and one right after, air-only sight rays skip the clip, path checks no longer allocate, death bookkeeping is throttled and secret checks are cached. A first version delayed every result by one tick, which review caught and fixed.
- **Result:** (measured, headless) action round trip equal to base (1 agent p50 ~95 ms); mean tick 2.63 -> 2.48 ms (1 agent) and 5.07 -> 4.58 ms (8 agents moving).
- **Sources:** this branch, `DurableActionJournal`, `ServerObservationCollector`, `ServerNavigationController`, `MultiplexedServerBridge`

## Speed run: observation cadence and size (Oct 9, 2026)

### Sending the model a full view only when something that matters changed
- **Problem:** Every footstep, sound and bit of regeneration made the server collect and send a full view, and block tags repeated on every row.
- **Solution:** Immediate observations are sent only for facts that matter (damage, fire, air, new threats and attackers, inventory, chat); everything else rides the half-second heartbeat, idle scans are cached, observations are no longer deep-copied, and tags are listed once per block type for coordinators that announce support.
- **Result:** (measured, headless, model-free) 8 sprinting agents 7.54 -> 4.15 ms/tick; 8 agents with mobs 5.60 -> 2.12 ms/tick; observations per second with mobs 60 -> 17.5; wire bytes down 70 to 80%. Threat signals still reach the coordinator in the same tick (creeper swelling p95 5 -> 7 ms, max 10 -> 13 ms, n = 60).
- **Sources:** this branch, `ServerObservationCollector`, `ObservationBlockTags`, `ServerObservationWireBudget`, `MultiplexedServerBridge`, `protocol-v2.mjs`
## Navigation speed work (Oct 9, 2026)

### Getting around faster and catching blocked routes sooner
- **Problem:** In the recorded GPT session, 19 drop landings each added about a second with no travel, and most `move_to` legs walked at 4.2 to 4.3 blocks per second because the model passed `sprint:false`. A body pushed against a wall waited 4 seconds before replanning and 12 before failing.
- **Solution:** After a drop the controller asked the body to stand back on the landing block's exact middle: it pressed backwards in the air (cancelling sprint) and, if it landed a little past that block, walked back before moving on. A body that has landed in, or flown past, a later block of its route now simply carries on, and keeps its heading through the fall; a body hanging past a landing is only waved on while the ground under its whole width still leads to the next block, so a body shoved to the rim of a one-block bridge or a ledge corner is steered back instead. `move_to` sprints by default (the food guard still applies; callers can pass `sprint:false`), forward input reaches full strength at once, terrain sampling is reused while the world has not changed, and a body pressed against a wall on dry ground for ten ticks replans after 1 second and fails after 3 (a body in water keeps the slower rule, since a current can pin it). `-Darenaagents.navigation.debugTicks=true` logs every tick, plan and replan reason.
- **Result:** (measured, headless flat-world server, game ticks, one run each unless stated) time lost crossing a 1 to 3 block drop, against the speed held on the flat run-up, walking and sprinting, 18 crossings: 871 ms on average and 1,171 ms at worst before, 93 ms and 174 ms after, and the body no longer backs up after landing (up to 0.26 blocks before, none after). A 21-block course with four steps up, a flat, three steps down and a flat, time to cover it: sprinting 12.5 s before, 5.3 s after; walking 9.6 s before, 5.1 s after. Twenty seeded random-terrain routes of 10 to 22 blocks, none failing before or after: walking 204 s before, 135 s after (-34%); sprinting 199 s before, 129 s after (-35%). Time spent pressed motionless against a wall on those routes: 30.8 s before, 3.5 s after walking, and 24.4 s before, 4.8 s after sprinting; the longest single wait fell from 3.8 s to 1.6 s walking and 3.6 s to 1.4 s sprinting. The rim-of-a-bridge safety rule costs about 4 s of the 125 s sprinting total against the version without it (repeat runs give identical totals). With eight agents sprinting across flat ground together, navigation controller time per server tick (mean / 95th percentile) went from 2.46 / 5.91 ms to 2.04 / 3.61 ms (measured, one run each, machine under load). The cause was read off the per-tick log of a sprinting drop and fits the recorded trace (the frozen body ended 0.06 blocks inside the landing block's far edge, with no collision and the speed of a walk start). Not measured live: gap-jump and step-up landings, the displaced-body cases on a bridge, ledge corner and cave stairs, and swimming or a current (all covered by unit checks only).
- **Sources:** branch claude/opt-navigation, `ServerNavigationController` (landing skip, falling steering, passed-waypoint rule), `BlockedMoveDetector`, `scripts/verify-navigation-drop-live.mjs`, `scripts/measure-navigation-headless.mjs`


## Quality scenario harness fix round (claude/q-scenario-eval)

- **Problem:** A crashed or idle candidate could look cheap enough to pass, and deaths dropped billed calls from the trace.
- **Solution:** Gate healthy paired runs on steady-state log token ratios and gameplay guards, reconcile every token category, and retain interrupted calls and final usage corrections under stable call IDs. Counterbalance the build order, pin both artifacts, and retry invalid pairs without losing earlier evidence.
- **Result:** (measured, synthetic fixtures through the real old and new functions) crash and model-mismatch verdicts changed from PASS to INCONCLUSIVE. Corrected output rows reconcile at 55/55 tokens; retired-process output changes from 5 to 45, matching 40 + 5 billed tokens. Model-facing text changes by 0 bytes; live gameplay and token savings remain unmeasured.
## Quality run (Oct 9-10, 2026)

Notes: "stack" numbers were measured on the integrated branch with all changes below; branch numbers were measured on each branch against main c6327e81.

### Knowing where you are: the situation header
- **Problem:** An agent that spawned in the Nether in diamond armour planned to "get wood and pigs". The dimension sat about 18 KB deep in the observation, biome and open sky were missing, and the world clock was raw ticks.
- **Solution:** A short retained `situation` line states dimension, biome, time of day, worn and carried gear, pickaxe and food, as F3 and the inventory would show a player. The first event in a new task context asks the model to read it before acting, a dimension change always wakes the model (also during a running program, unless the model's own program policy said otherwise), and the raw clock fields are dropped.
- **Result:** (measured, 20-event Nether replay) 3,395 -> 3,298 encoded bytes per wake (-97 B); the first event costs +209 B once and the header is re-sent only when it changes (1/20 wakes instead of 20/20). Worst-case full-kit header 317 B. Food summary 1.21 us per observation (cached). A single live check showed main also recognised the Nether, so no quality gain is claimed from this change alone.
- **Sources:** branch `claude/q-situation`, `situation-facts.mjs`, `dynamic-main.mjs` (new-context instruction, dimension wake), `FoodObservation`, `SkyOpenVerification`.

### Recognising what the player has already achieved
- **Problem:** A prepared player received a route from scratch because the plan could not recognise the Nether, equipped gear or completed milestones.
- **Solution:** Small factual checks reconcile the plan against the player's current and remembered observations. A retained progress line shows satisfied prerequisites and open choices; the translator's route stays in chat. Consumed prerequisites reopen when the item they produced is lost.
- **Result:** (measured, five offline scenarios) all five produce the expected frontier. (measured, 90-second Claude Opus 5.5 low Nether check) the translated plan had checks on 11/11 steps and recognised the Nether immediately. (measured, 20 fixture events on top of the situation change) -25 B on every unchanged wake, +85 to +111 B on the three wakes where progress changes; the one-time translator prompt adds 602 B. Native instructions 1,485 of 1,500 characters. No live cost saving is claimed.
- **Sources:** branch `claude/q-progress`, `plan-checks.mjs`, `live-task-view.mjs`, `PlayerAdvancementsMixin`, `GoalStartFacts`, `planFacts` hello capability.

### Smaller wakes: the event budget
- **Problem:** Compacted wakes lost the world identity needed to reuse observations, so 17 of 19 Nether wakes re-sent the full observation, and a trimmed change view could leave old mobs looking current.
- **Solution:** Preserve world identity, remove trimmed sections from the delivered view and saved baseline, drop exact duplicate fields, reference approaching threats without repeating their facts, and give Claude only the MCP tools it uses.
- **Result:** (measured, reconstructed Nether fixture) steady encoded bytes per wake 18,478 -> 10,377 (-43.8%); stack 10,082. Owner-shaped 19-wake series with context resets 18,410 -> 12,246 mean (stack 11,975). All 22 eligible changes reconstruct exactly; 0 mismatches in 115k fuzz cases. (measured, fresh Claude CLI prefix probes) 21,479 -> 18,531 input tokens per call. One live pair used 21.3% more total tokens (call count noise), so the gameplay saving waits for the paired benchmark.
- **Sources:** branch `claude/q-event-budget`, `event-observation-presentation.mjs`, `model-fact-encoding.mjs`, `node coordinator/src/benchmark/event-budget-replay.mjs` (uses `benchmark/fixtures/nether-fixture.mjs`).

### Deliver useful danger facts without losing earlier edges
- **Problem:** A piglin knocked the agent off a cliff, the warning reached the model 8 to 9 seconds late, passive crossbow poses could interrupt it, and edge facts could be false or reveal hidden depth.
- **Solution:** Require aiming at this agent, omit ranged melee predictions, report visible collision/fluid surfaces with a four-block hidden-depth bound, and flush danger at real provider tool boundaries. Scope repeated-edge suppression to the standing block and dimension, clear empty probes, and retain superseded edges as `earlierFooting`.
- **Result:** (estimated, replay) blocking threat wait 9.4 -> 0 s. (measured fixtures) passive/other-target crossbow poses raise zero aiming signals; four partial-support bridges produce zero false cliffs; hidden floors expose no exact depth; real-provider fixtures recover 0 -> 1 earlier edge facts. The 20-event series grows 18,054 -> 18,194 bytes (+140 B, 0.8%); always-sent instructions and schemas add zero bytes. Hourly tokens and whole-server CPU remain unmeasured.
- **Sources:** branch `claude/q-danger`, `MultiplexedServerBridge`, `EdgeExposure`, `ThreatPerception`, `danger-steer-coalescer.mjs`, `danger-delivery.test.mjs`.

### Starting the model's escape when its old action already ended
- **Problem:** A lava warning made the model replace its running action with an escape. If the old action finished before cancellation, the coordinator discarded that explicit escape and required another model turn.
- **Solution:** The latest body action's terminal receipt releases the requested replacement and reports the old action's state and reason, including when the replacement fails to dispatch. Older receipts and pre-death handles are refused.
- **Result:** (measured, coordinator fixture with injected server receipts) immediate dispatch 1/8 -> 8/8 across four terminal states; recovery tool exchanges 15 -> 8; request plus response bytes 5,442 -> 3,962 (-27.2%). Five stale or pre-death cases are refused and six dispatch-error cases keep the old outcome. The always-sent description shrinks 138 -> 134 bytes. (estimated) one 4 to 5 second model round saved per former refusal. Live survival was not measured.
- **Sources:** branch `claude/q-replace-action`, `native-tool-runtime.mjs`, `native-minecraft-tools.mjs`.

### Exploring to cover ground, not to fall into holes
- **Problem:** Searching for a fortress, the agent picked nearest-first frontier cells, had no memory of where it had already looked, and walked down into a hole. Model-chosen coordinates often failed with no standable alternative.
- **Solution:** Exploration memory records headings walked and surveyed (with each survey's real sight range), standable footing it has seen, and honest travel facts (net climb or descent, teleports reported by the server). Frontier summaries list candidates by distance and coverage; navigation reports standable alternatives and descents. Far structure size counts only blocks actually seen. New body facts are sent only to coordinators that announce `bodyFacts`.
- **Result:** (measured, 50-sample Nether fixture) frontier payload 7,935 -> 1,162 B; candidate distances 0-4 -> 11-60 blocks (8 of 12 cells listed). Observation ingest +0.9 to 1.5 us. Tool definitions 29,150 -> 29,149 B. Four live S1 "find a fortress" runs (two per arm) all died, so live quality and tokens are inconclusive.
- **Sources:** branch `claude/q-exploration`, `explore-frontier.mjs`, `observed-memory-store.mjs`, `PlayerTeleportMarkerMixin`, `node coordinator/src/benchmark/frontier-bytes.mjs`.

### Walking Nether ground and noticing arrows
- **Problem:** Routes ignored slow ground and lava exposure. Correcting step costs then flooded soul sand searches, while repeated missed arrows grew model context and could hide a creeper warning.
- **Solution:** Costs, travel estimates and stall windows use vanilla movement factors, with separate lava exposure penalties. A bounded own-ground weighted A* heuristic prioritizes planning speed; validated closed-node parent chains stay fixed. Visible projectile facts fold until new information arrives, threats retain priority, wall impacts are excluded, and movement failure messages and landing guards reflect the actual route.
- **Result:** Measured planner fixtures: uniform soul sand expansions 2,146 -> 60 and 3,439 -> 80; mixed patches 927 -> 565, with selected cost 832 versus optimal 780. A constructed sand-entrance trap selects cost 1,020 versus optimal 608 in 102 expansions. Required overworld counts stay exactly main's 40, 60, 80, 1,477 and 1,159. The heuristic's horizontal multiplier is capped at 1.8; this is not a path-optimality guarantee. Earlier live checks measured soul sand at 58.09% of ordinary speed. Production replay of 676 observations measured missed-arrow steers 92 -> 2, estimating sustained event traffic 26.29 -> 0.49 MB/hour; paid tokens remain unmeasured. Ten live wall trials reduced incoming-arrow reports 10 -> 0, retaining 10 -> 10 in the open control. Always-sent instructions and schemas add zero bytes.
- **Sources:** branch `claude/q-nether-paths`, `WeightedPathfinderVerification`, `NetherCostsVerification`, `LocalPathfinder`, `MovementCosts`, `MinecraftNavigationWorld`, `ServerNavigationController`, `ProjectilePerceptionVerification`, `projectile-attention.test.mjs`.

### Getting out of lava and fire
- **Problem:** In 6 of 6 Nether test runs the agent died, 5 of them to lava or fire. Actions kept walking for 2 to 5 seconds after the body entered lava, a warning could not reach a model that was still thinking, the model had no exits, burn time or damage cause (two agents burned to death holding steak), and mining opened hidden lava pockets.
- **Solution:** An action that enters lava or catches fire stops with IN_LAVA or ON_FIRE and lists standable exits the eye has actually seen in the last 10 s. A model call that has not yet been told about the contact is cancelled and reissued with it, once per contact; never while a tool runs or when the contact already rides on a tool result. Events carry burn time, food and what hurt the body; `mine` refuses a block beside seen or heard lava unless the model passes `acceptLavaRisk`; lava seen nearby in the last 30 s is remembered. A `hazards` strategy topic states the burn facts.
- **Result:** (measured, live headless checks) main passed 4 of 12; the branch passed 12 of 12, and 13 of 13 after review added a check. (measured, real providers, n=3) one cancel and reissue costs about 16k cached input tokens on Claude Opus 5.5 low (about $0.001) and 3 to 7 ms to interrupt; the Codex cost is not observable. (measured, per observation on the server) 0.5 us when nothing is remembered, 26 to 63 us typical in lava, 240 us worst (turning in a 1x1 pool). (measured, 20-event Nether replay with three lava-contact wakes) the first contact wake costs +414 B once; the series mean is still 122 B per wake below main. The `mine` schema does not grow; the script API reference grows 34 B because it lists the new `breakBlock` field.
- **Sources:** branch `claude/q-hazard`, `HazardFacts`, `HazardExits`, `SeenHazardTerrain`, `ServerActionExecutor`, `dynamic-main.mjs` (`#reissueMidCallTurnForHazard`), `hazard-contact.test.mjs`, `HazardExitsVerification`, `HazardSightVerification`.
- **On the stack:** exits and the `mine` lava check now read terrain through the fight's shared seen-terrain memory (one definition of "seen" for fight, flee and hazard; one memory per body and world, reclaimed on expiry, death, logout and dimension change). (measured, live headless checks, two runs per jar) 16 of 16 pass before and after, every exit, lavaSeen and stop text identical; the added checks show `mine` refuses lava in view as "seen" with no sound yet, never refuses unseen lava as seen, and a fight that walks into lava lists exits. Per-observation cost in lava rises 2 to 14% (about +0.5 to +6 us; 1x1 pool turning 182 -> 188 us); dry shapes are unchanged (7.0 -> 6.6 us with nothing remembered).

### Strategy guidance for any starting point
- **Problem:** The on-demand strategy guide assumed an Overworld fresh start (wood first, water buckets, beds, torches) and never said piglins attack a player without gold armour, so a Nether start in diamond armour read a route that began with wood.
- **Solution:** The route is a dependency checklist with a "Done when" state for each step; dimension facts are stated as facts (water cannot be placed and beds explode in the Nether, Nether spawns ignore light, obsidian needs a diamond pickaxe, piglins attack unless you wear gold); the plan view points to the nether or end topic from the observed dimension. Always-sent lines name the facts other branches added (eating time and regeneration, the dimension-change bypass).
- **Result:** (measured) AGENTS.md 3,395 -> 3,335 B, script API reference -3 B, native instructions -6 characters on their own. On-demand topics (stack, JSON bytes per read, cap 4,096): survival 881 -> 1,499, beat-the-game 1,289 -> 2,288, nether 1,414 -> 2,828; paid only when the model reads them. Facts were checked against the 26.1.2 jar in review. No live quality run.
- **Sources:** branch `claude/q-guidance`, `strategy-guide.md`, `minecraft-strategy-reference.mjs`, `AGENTS.md`, `native-minecraft-tools.mjs`.

### Fighting only what the body can reach
- **Problem:** The agent locked onto a piglin about 20 blocks above it and tried to melee it; in a hole it sprinted (particles, no movement) into a wall and circled. The fight controller walked straight at the target, kept sprint without forward input, read terrain the player had never seen, chose follow-up targets and flee directions by itself, and kept fighting while the body stood in lava.
- **Solution:** Threat rows carry height (`dy`) and a visibly held ranged weapon (`holding`) and drop unused risk factors. Fight and flee plan routes and backsteps only over ground the body has seen (view cone and line of sight, lava opaque) or walked in the last 30 s, from one shared per-body, per-world memory, and say why they stop: `NO_SEEN_ROUTE`, `APPROACH_BLOCKED`, `FLEE_STALLED`. Sprint follows vanilla rules; follow-through to other attackers is the model's opt-in (`continueWithAttackers:true`); entering lava or fire stops the fight with the exits listed. All fights share one 2 ms per tick planning allowance.
- **Result:** (measured, 8 and 16 bodies against unreachable targets, stack vs `claude/q-bench-base`) verdict 5.45-5.75 s `TARGET_UNREACHABLE` -> 2.0-2.65 s `NO_SEEN_ROUTE`; warm controller time per server tick max 0.61 -> 2.48 ms (8) and 0.81 -> 2.89 ms (16). Stable melee: 18-19 hits per 10 s on both; warm mean 0.230 -> 0.233 ms (8), 0.290 -> 0.295 ms (16). Backsteps after walking in: 0% refused on both (branch fixture); a body teleported in, rear never walked or seen, refuses every backstep (main 0 to 16%), which is the honest answer. (measured, branch) fresh-body flee starts moving after 100 ms (main 50 ms); expired memory cells reclaimed 1,000 -> 0. Threat row bytes -16.4% (review measurement); projectile replay with arrows hitting 26.3 -> 25.4 MB/hour of event payload on the stack. Script API reference +17 B for `dy`/`holding`; tool definitions -1 B.
- **Sources:** branch `claude/q-fight`, `ServerFightController`, `ServerFleeController`, `SeenTerrain`, `ObservedTerrain`, `MeleeReach`, `CombatStallDetector`, `HazardEntry`, `CombatMoveText`, `VanillaSprint`, `ThreatPerception`, `FightMovementVerification`, `SeenTerrainVerification`, `SeenHazardAdoptionVerification`.

### Stack totals (all ten changes)
- (measured, 20-event Nether replay, main = `claude/q-bench-base`) 3,394.5 -> 3,228.25 bytes per wake (-166.25 B); with three lava-contact wakes 3,396.30 -> 3,267.70 (-128.60 B). (measured, reconstructed Nether fixture) 18,478 -> 10,082 B steady per wake (-45.4%); first 17,380 B and owner-shaped mean 11,975 B. Tool definitions 29,150 -> 27,632 B. Native instructions 1,456 -> 1,481 of 1,500 characters; script API reference 14,233 -> 14,119 of 14,500 bytes; AGENTS.md 3,395 -> 3,041 B. These stack totals include the final coordinator review fixes.
- (measured, 676-observation four-skeleton capture replayed through the production coordinator, main vs stack) all arrows missing: 10 -> 10 steers (2 threat and 8 movement_loop on both), 2.75 -> 2.55 MB/hour of event payload; arrows hitting: 98 -> 98 steers (1 threat, 89 damage, 8 movement_loop on both), 28.1 -> 25.4 MB/hour. The 8 movement_loop steers are knockback crossing a block edge in this capture; in synthetic circling against a wall the loop is reported once under every arrow pattern, as on main. These are deliveries and bytes, not paid tokens.
- (measured, final coordinator review) coordinator tests 3,136 pass, 0 fail, 3 skipped. Earlier stack Java verification at 58a9d33e: Gradle verifyCore 2,546,752 assertions, build, verifyPovMixins and verifyLiveWindows pass; the coordinator review changed no Java.

### Final coordinator review: the contact and its facts arrive together
- **Problem:** An older folded hit could overwrite the lava sample when a model call was cancelled and reissued. The event also offered eating during contact, told a burning body to fight without an enemy, and asked a new task to read situation/progress that the encoder could omit.
- **Solution:** Flush older hits before the contact and merge pending events in sequence order. Contact events keep food and burn facts without an eating menu, non-threat danger uses a neutral instruction, and new-context events include situation and progress in full. Script guidance states trade-offs, ordinary flight delivery is described honestly, and progress points to the observed dimension's strategy topic.
- **Result:** (measured, coordinator fixtures) stale-contact regression 0/1 -> 1/1; carried-food options during contact 1 -> 0 while dry-ground burning retains them; both new-context fields omitted -> both present on start and replace. (measured, text bytes) always-sent native/API/tools/AGENTS/skill bundle 59,997 -> 59,529 B versus 58a9d33e, and 61,561 -> 59,529 B versus q-bench-base. The unchanged-facts assessment fixture adds 103 B once per start/replace. (measured replay) 676 observations retain exactly 98 hit steers and 10 miss steers; normalized estimates remain 25.44 and 2.55 MB/hour, versus base's 28.07 and 2.75. Paid tokens and live survival were not measured.
- **Sources:** branch `claude/q-stack-coordfix`, `hazard-contact.test.mjs` (committed reviewer b1 regression), `situation-assessment.test.mjs`, `projectile-attention.test.mjs`, `native-tool-reference-regressions.test.mjs`. Replays use the stack-2b 20-event scripts and the original nether-paths-r2 production replay/capture behind stack-2c's recorded figures.
- **Version contract:** The jar and coordinator ship as a matched version. Among this stack's observation additions, only planFacts and bodyFacts are negotiated; skyOpen, footing, fallDamage, hazard/fireTicks/exits/hurtBy/lavaSeen, incomingProjectiles, threat dy/holding, inventory.food and projectile changed facts are not separately capability-gated. Mixed versions are unsupported and strict key validation can reject them.
- **Delivery limit:** An interrupted turn with uncertain assessment delivery leaves that assessment pending, so the new-context line can repeat. This conservative retry is retained because consuming an unconfirmed delivery could lose the instruction entirely.

## Quality run, wave 2: first approved integration batch (Oct 10, 2026)

### Saving plans while another part of the coordinator reads them
- **Problem:** Windows refused to replace an open plan or memory file. Separate instances and alternate Windows spellings could overlap, and a nested save could wait for itself forever.
- **Solution:** Reads and replacements share a process-local queue for each resolved file, including Windows namespace aliases. Same-file nesting rejects immediately with `FILE_TURN_REENTRY`; unrelated files remain independent.
- **Result:** (measured in independent review, 256 replacements of 2 KB each) four writers: 24 -> 0 EPERM errors; one writer with two reader loops: 245 -> 0. Eighty overlapping plan-restart rounds: 58 -> 0 errors and 161 -> 0 abandoned temporary files. Median helper CPU overhead was 7.74 -> 11.19 microseconds per turn versus the first fix, from three alternating 100,000-turn samples on a loaded machine. Model text is unchanged. External processes remain outside the queue; detached descendants can retain reentry ownership after their original turn ends.
- **Sources:** `file-turns.mjs`, `live-task-view.mjs`, `observed-memory-store.mjs`, `file-turns.test.mjs`.

### Repairing several program errors in one response
- **Problem:** Each rejected program exposed one error, and heavily escaped authored text could erase all repair feedback or break the correction input.
- **Solution:** Collect independent static errors with locations and allowed-form hints while still rejecting the entire unsafe program. Both providers and the correction planner retain at most 12 diagnostics, bounded to 8,192 serialized bytes, with explicit truncation; traces retain their codes.
- **Result:** (measured representative reconstruction) four sequential rejections -> one response with four diagnostics, assuming the model repairs every listed defect. (measured second-round adversarial fixture) Unicode hint 311 -> 19 B; serialized diagnostics 26,974 -> 8,103 B; delivered repair diagnostics 0 -> 6. Ordinary four-error response stays 1,671 B, and shared instructions add 0 B. Independent review found 0 unsafe acceptances across 195 probes and 0 base-rejected/branch-accepted programs across 6,000 differential probes. Historical sources were unavailable; live repair time, paid tokens and survival were not measured.
- **Sources:** `arena-script/parser.mjs`, `arena-script/errors.mjs`, `arena-script-diagnostics.test.mjs`, `claude-service.mjs`, `codex-service.mjs`, `program-runtime-manager.mjs`.

### Giving danger facts without choosing the response
- **Problem:** Danger and strategy text ordered game actions and presented a partial menu as a restriction.
- **Solution:** State the reviewed facts and tradeoffs, preserve resource comparisons and capability pointers, and label danger actions as options. Exact danger-line and topic budgets guard the approved wording.
- **Result:** (measured branch fixtures, UTF-8 with guide CRLF normalized) ten event inputs 9,621 -> 9,453 B; guide 15,709 -> 15,528 B; planner 16,555 -> 16,532 B. Tool definitions alone save 6 B per request. Hazard text is 152 B under its existing 156 B cap; its rates are raw damage before mitigation. Execution is unchanged and live decision quality was not measured. Protected native and script-reference guidance remains unchanged.
- **Sources:** `dynamic-main.mjs`, `minecraft-strategy-reference.mjs`, `strategy-guide.md`, `combat-followup.test.mjs`, `minecraft-strategy-reference.test.mjs`.

### Showing whether food can be eaten and how fast health can recover
- **Problem:** An injured agent could hold food while burning without requesting consumption; regeneration eligibility alone did not explain whether damage outpaced healing.
- **Solution:** Report server food-component eatability across the inventory and a current regeneration upper bound. Offered use calls hold for 40 ticks or 2,000 ms; contact events retain recovery facts without a food-action menu. The model chooses whether to eat.
- **Result:** (measured branch reconstruction, 25 inputs plus one tool schema per request) 996,158 -> 995,169 B, mean 39,846.32 -> 39,806.76 B/request. All 1,081 recorded nudge/latch samples match, with 5 -> 5 nudges; this does not measure future wakes. Synthetic 41-slot inventory-scan median was 770.81 -> 701.99 ns across nine alternating 100,000-scan batches, excluding serialization and server ticks. The burn-response hypothesis and survival gain remain unproven. Honey takes the full 40 ticks, leaving no margin; at full hunger the best-food option can name ordinary food even when only an alternative is edible.
- **Sources:** `SurvivalPerception.java`, `observation-adapter.mjs`, `dynamic-main.mjs`, `eating-facts.test.mjs`, `FoodObservationVerification.java`.

### First-batch text budget
- **Result:** (measured assembled exports against the pre-batch stack) provider tool JSON 27,632 -> 27,573 B; MCP tool JSON 27,110 -> 27,051 B. Native instructions remain exactly 1,481 characters and the script API reference remains exactly 14,136 B, both byte-identical. Heal instruction lines are 534 and 497 B. Token-trim and fire-escape are not included; these byte measurements do not establish paid-token or hourly gameplay savings.

## Quality run, wave 2: second approved integration batch (Oct 10, 2026)

### Keeping the connection when one snapshot uses an unfamiliar field
- **Problem:** The server's archer-aiming signal was absent from the coordinator schema. One recorded run reconnected 29 times in 16 seconds; the first containment fix also bypassed corruption checks.
- **Solution:** Check the Java signal vocabulary against the coordinator contract. For known agents on ready sessions, discard recoverable observation or progress drift only after validating every known fact and the normal identity, revision and fragment guards; corruption still closes the connection.
- **Result:** (measured branch bridge fixture with simulated transport) five drifting snapshots followed by one valid snapshot: zero reconnects, three rejection reports and delivery of the valid snapshot. Four review regressions fail before the repair and pass after it. (measured integration coordinator checks) 152/152 pass. Valid sample payloads and always-sent text are unchanged on the branch. Live survival and hourly tokens remain unmeasured; future assembly literals can evade the vocabulary test, and repairing thousands of unknown fields can block the event loop.
- **Sources:** `protocol-v2.mjs`, `protocol-v2.test.mjs`, `observation-adapter.mjs`, `ThreatPerception.java`, `ThreatAttentionVerification.java`.

### Explaining searches, occupied placement cells and refused food
- **Problem:** Agents searched unsearchable bulk terrain, used support coordinates as the placement destination, and mistook completed food-use frames for consumption. Earlier feedback could reveal unseen neighboring space or hide a hunger refusal after another interaction succeeded.
- **Solution:** State the bulk-terrain search limit, describe occupied destinations and free neighboring cells only through current perception, and retain full-hunger explanations alongside accepted interactions. Vanilla food components supply eatability; the existing server-derived eating facts and 40-tick use contract remain.
- **Result:** (measured independent branch headless checks) 28/28 pass, including hidden-cell parity, five vanilla always-edible foods and customized food components. (measured branch comparison) 13/20 -> 20/20 live feedback checks; ordinary use remains 40 ticks and valid placement 3 ticks. A refused steak use adds 97 conditional message bytes. (measured integration) 90/90 coordinator checks pass; tool JSON shrinks another 3 B while retaining the factual survey wording. Live model choices and hourly tokens remain unmeasured.
- **Sources:** `ServerActionExecutor.java`, `ServerActionExecutorVerification.java`, `FarSight.java`, `SightedFeaturesVerification.java`, `native-minecraft-tools.mjs`, `control-reference.md`.

### Reporting the seen edge ahead and the falls already taken
- **Problem:** Bare control-complete receipts omitted the visible rim ahead and the fall that just hurt the body. A first implementation let hidden piston geometry alter remembered cliff facts and attributed accumulated damage to the last landing.
- **Solution:** Describe the first harmful edge along the final control heading using only seen or remembered terrain, treating unsupported collision geometry as unknown. Track each active action's largest fall and label accumulated damage as `fall HP sum`; append edge facts after the existing food feedback and fall facts to the shared result path.
- **Result:** (measured branch replay) the former bare completion names a rim with its bottom out of sight, and a 9-block fall reports 7.0 total fall HP. Two review reproductions fail before repair and pass after it; seven ordinary suffix fixtures remain 197 B across that repair. (measured independent parity probes) 29,873 vanilla states produce zero live world reads and zero hidden-state differences. (measured integration) 65/65 coordinator checks pass. Always-sent text is unchanged by this input; conditional result growth and constant active-action tick work have no measured hourly-cost or whole-server CPU result. Future fall prevention remains unmeasured.
- **Sources:** `DropAhead.java`, `DropAheadVerification.java`, `FallReport.java`, `FallReportVerification.java`, `ServerActionExecutor.java`, `drop-ahead-result.test.mjs`, `control-reference.md`.

### Listing look-around sightings once without losing baseline coverage
- **Problem:** Overlapping camera headings repeated sightings and receipts. A first smaller budget hid previously retained mobs and terrain, while identical coordinates in different dimensions collapsed together.
- **Solution:** Retain every identity admitted by the former per-heading budget before adding sightings under a shared budget. Include dimension in identity and list each sighting's newest historical facts under the last heading that saw it; body actions and reacquisition requirements remain.
- **Result:** (measured independent replay of the same 59 recorded sweeps through production runtime with a mocked bridge) 373,602 -> 251,202 B and 135,116 -> 96,615 `o200k_base` tokenizer tokens. All 1,901 baseline sample identities and 131 mob identities remain. In 250 dense adversarial scenes, zero of 11,206 baseline identities were lost and body commands matched. Always-sent description bytes stay 256, but tokenizer prefix cost grows 5 tokens; recorded-rate savings are estimates with round count and output fixed, not measured billing. Newest facts replace earlier positions, and guaranteed sightings can exceed the additions budget. Live choices, survival and latency remain unmeasured.
- **Sources:** `native-tool-runtime.mjs`, `native-tool-runtime.test.mjs`, `native-minecraft-tools.mjs`, `native-minecraft-tools.test.mjs`.

### Second-batch text budget
- **Result:** (measured assembled exports against batch 1 HEAD) provider tool JSON 27,573 -> 27,570 B; MCP tool JSON 27,051 -> 27,048 B. Native instructions stay byte-identical at 1,481 characters, below 1,500; the script API reference stays byte-identical at 14,136 B, below 14,500. Token-trim remains excluded. Definition bytes alone do not establish billed-token or hourly gameplay savings.

## Quality run, wave 2: third approved integration batch (Oct 10, 2026)

### Letting authored programs handle repeated failures
- **Problem:** A same-pose rejected action could stop a program before its own fallback ran. Stale decision errors required a status round trip, routine observations invalidated replacements, and evicted failure history made incomplete counts look exact.
- **Solution:** Deliver repeat counts and body failure evidence to authored handlers while retaining the existing failure limits. Name pending decisions, reject replacements only for new material danger facts, and label truncated history as lower bounds. Navigation geometry stays suppressed until acquired terrain proves it is fully seen.
- **Result:** (measured approved branch replay, not repeated during integration) 300 repeat facts across 48 recorded runs add 23,332 B; the round-2 repair reduces this from 23,336 B. A real executor fixture with mocked body changes from two clicks plus one forced recovery decision to two clicks plus the authored finish, removing 546 notification bytes. (measured assembled integration) 391/391 focused coordinator tests pass. Live model quality, provider tokens and hourly cost are unmeasured; out-of-order body timestamps and non-ASCII detail truncation remain review follow-ups.
- **Sources:** `repeated-failure.mjs`, `native-tool-runtime.mjs`, `native-program-executor.mjs`, `arena-script/interpreter.mjs`, `arena-script/program-engine.mjs`, `repeat-failure.test.mjs`, `ServerNavigationController.java`, `ServerPathPlannerVerification.java`.
- **Integration boundary (completed in batch 7):** The fully-seen detail is now enabled with `exploredDetail(finishedSearch, !searchWorld.hasUnknown())` after unknown-route returns. Approved underwater surfacing recovery precedes NO_SEEN_ROUTE; geometry detail follows both.

### Third-batch text budget
- **Result:** (measured assembled exports against batch 2 HEAD) provider tool JSON 27,570 -> 27,570 B; MCP tool JSON 27,048 -> 27,048 B, below 29,200. Native instructions stay byte-identical at 1,481 characters, below 1,500; the script API reference stays byte-identical at 14,136 B, below 14,500. Planner and event instruction lines are unchanged. Repeat facts are conditional result text; these static budgets do not establish total gameplay or billing savings.

## Quality run, wave 2: fourth approved integration batch (Oct 10, 2026)

### Keeping acquired resource facts when the camera turns away
- **Problem:** Turning away hid goal-relevant logs and drops from later wakes. Partial samples and guessed ray geometry could erase resources that still existed, while visible stack merges left obsolete drop identities in memory.
- **Solution:** Keep bounded, aged sightings separate from current perception. Retire them only through a fresh contradictory hit, an unambiguous observed merge or an explicit action result; keep transient drops out of restored disk memory.
- **Result:** (measured integrated runtime and coordinator tests) 231/231 focused checks pass, including recorded merge, partial-visibility, airborne-ray and planning-wake regressions. Memory appears in 10/130 reconstructed recorded B wakes, with a measured maximum of 562 B. B/S5-r3 grows by 290 B per wake to retain these facts; aggregate savings below include the situation changes. Live model choices and billing are unmeasured.
- **Sources:** `seen-resource-facts.mjs`, `observed-memory-store.mjs`, `native-tool-runtime.mjs`, `dynamic-main.mjs`, `seen-memory.test.mjs`, `seen-memory-r3.test.mjs`.

### Presenting a corpse honestly and retaining the next situation assessment
- **Problem:** Death wakes repeated stale armour, food, fire and sounds as live facts. A cancelled death input or respawn revision could discard the unread situation assessment, while removing duplicated inventory could also hide facts from a truncated planning wake.
- **Solution:** Present corpse identity and death facts, remove the last-live inventory only when recovery supplies its stack counts, and omit unobserved survival defaults. Retain the situation owner's pending assessment through cancelled delivery and revision changes; preserve recovery whenever the wake cannot retain the inventory it restates.
- **Result:** (measured combined coordinator tests) 157/157 pass, covering stale corpse facts, counted historical inventory, food naming, cancelled death construction and one assessment after same-dimension respawn. No autonomous action is added. Batch 6 integrates respawn while retaining this assessment implementation.
- **Sources:** `event-observation-presentation.mjs`, `dynamic-main.mjs`, `event-observation-presentation.test.mjs`, `situation-assessment.test.mjs`.

### Fourth-batch measured budgets
- **Result:** (measured baseline 27419ba3 versus integrated code, same recorded wire observations and wake timestamps) 24 final-3 B runs, 130 reconstructed wakes: mean provider-encoded event 10,680.36 -> 10,424.56 B, saving 255.80 B/wake (2.40%); totals 1,388,447 -> 1,355,193 B. Task and program context is reconstructed, so these are comparable byte measurements rather than captured provider bodies. Six runs grow individually, including S5-r3 +290.14 B/wake and S1-r4 +229.25 B/wake; no every-wake reduction is claimed. (measured Desktop-forensics-shaped reconstruction) 19 archived Nether-fixture wakes stay 10,457.74 B mean; the original run lacks saved wire snapshots for exact reconstruction.
- **Always-sent text:** (measured, unchanged) provider tools 27,570 B; MCP tools 27,048 B; native instructions 1,481 characters/bytes; script API 14,136 B; planner 16,532 B. Overall hourly tokens, decisions and survival remain unmeasured.

## Quality run, wave 2: fifth approved integration batch (Oct 10, 2026)

### Reporting walked loops without treating a shove as a decision
- **Problem:** Block-centre nudges and knockback could look like walking in circles, while triangle and square routes went unnoticed. Progress-only alerts could report a loop before the correcting observation, rejected delivery could lose it, and the loop field could remove danger facts at the input limit.
- **Solution:** Remember distinct feet cells and motion evidence, withdraw shoved steps, and detect repeated routes of up to eight cells. Validate progress-derived loops through a fresh observation, retain them until successful body-event delivery, and reserve the exact loop-field bytes separately from danger and unread messages. The model still chooses every response.
- **Result:** (measured assembled coordinator with mocked bridge/provider, 24 samples per case) stationary block-centre nudges: 1 -> 0 loop wakes and 3,203 -> 1,599 input bytes. Triangle and square: 0 -> 1 loop wake each, delivered at samples 6 and 8; these newly reported real loops each add a wake. A walked loop under repeated projectile damage: 15 -> 15 total wakes, 27,595 -> 27,055 B, with the loop in an existing damage input. Continuous carried-body samples expose no loop. All 197 focused coordinator checks pass, including delivery rejection, advisory and stale-observation races. Twelve byte-boundary comparisons preserve identical underlying danger, observation, memory and conversation facts; the loop flag adds exactly 20 B. Live gameplay, billed tokens and overall hourly cost remain unmeasured.
- **Sources:** `dynamic-main.mjs`, `movement-loop.test.mjs`, `movement-loop-delivery.test.mjs`, `event-observation-presentation.test.mjs`.
- **Integration boundary (completed in batch 7):** Program-wakes resource discovery follows movement sampling, validation, clearing `knockbackNow` and updating `observedAt`. Loop versions and successful-delivery checks remain intact; resource discovery does not read movement entries.

### Fifth-batch measured budgets
- **Result:** (measured batch 4 HEAD a4dfa21b versus the merged stack, same recorded wire observations and wake timestamps) 24 final-3 B runs, 130 reconstructed provider-encoded events: 1,355,193 -> 1,351,593 B total; mean 10,424.56 -> 10,396.87 B, saving 27.69 B/wake. This comparison holds recorded wake times fixed and reconstructs task/program context; it does not measure changes in gameplay wake frequency. Nineteen Desktop-forensics-shaped fixture wakes: mean 10,457.74 -> 10,419.84 B; the original capture lacks wire snapshots. Twenty direct event/trigger combinations retain identical payload facts and shrink 16,684 -> 16,084 B. The generic event instruction shrinks 129 -> 89 B; instructions for danger and assessment retain their existing selection.
- **Always-sent text:** (measured, unchanged) provider tools 27,570 B; MCP tools 27,048 B, below 29,200; native instructions 1,481 characters/bytes, below 1,500; script API 14,136 B, below 14,500; planner 16,532 B. Protected native instructions and script reference are byte-identical. No server tick work is added.

## Wave 2: death and recovery facts

- **Problem:** Death facts were repeated across recovery and task memory, forcing some respawn wakes into terrain compaction. A wall-clock countdown also falsely aged loot in unloaded chunks, and repeated nearby deaths had no aggregate count.
- **Solution:** Keep the latest death, exact respawn point, portal contact and lost stacks once in recovery, with elapsed age and the 6,000 entity-ticking tick lifetime. Durable task history adds observed nearby death counts by cause over the last 300 seconds. Portal contact respects its observed axis; loss accounting remembers the largest evidenced possession since death so chest round trips cannot count the same stack twice. Presentation remains owned by situation-input.
- **Result:** (measured replay, seven recorded B/S1 sequences, five production-encoded wakes each, same current situation-input presentation on both sides) 239,844 -> 236,037 bytes, 3,807 fewer (1.59%). The five sequences unaffected by the review's added compaction shrink 168,504 -> 165,790 bytes; no new wake enters compaction. Existing baseline overflows remain. With original presentation held equal: 264,744 -> 261,178 bytes. Always-sent instructions and schemas add zero bytes. Six new focused regressions fail before their fixes and pass after. Reconstructed respawns from seven recorded zombie deaths over 123.751 seconds receive nearby counts 1 through 7 and their observed cause. These are payload bytes and factual checks, not paid tokens or a measured survival rate.
- **Sources:** branch `claude/q2-respawn`, recovery and task-memory stores, `respawn-round2.test.mjs`, `respawn-recovery.test.mjs` and `recovery-progress-wrap.test.mjs`.

### Seeing and hitting the exposed part of a combat target
- **Problem:** A short magma cube could expose a hittable top above a slab while fight_target rejected it. Remembered threat signals looked like current sight, and blocked combat often omitted the facts needed to choose another action.
- **Solution:** Entity sight tests the eye against the real hitbox; fight aim validates the reconstructed float-angle ray against colliders within the held weapon's vanilla reach. Threats state current visibility, and terminal combat feedback names only seen or remembered obstacles, unknown cells and headroom, while hiding unseen target height and retaining only the last visible damage progress. SeenTerrain movement restrictions and model-owned action choices remain intact.
- **Result:** (measured live headless fixtures) exposed-top mortal cube: TARGET_NOT_VISIBLE with zero swings -> one-hit kill; full cover: zero -> zero swings. Flat and bouncing invulnerable cubes retain 12 swings over 6.5 seconds; boxed flee identifies known walls and unknown footing without movement. (measured four-round, eight-fighter comparison) warm controller wall mean, stable interior ticks: 0.194 -> 0.206 ms; unreachable common planning window: 0.546 -> 0.538 ms. Both deliver 18-19 swings per fighter per 10 seconds and approximately 20 TPS. These measurements do not establish performance non-regression. (measured bytes) tools: 27,632 -> 27,468; 48 historical observations encoded by production modules plus tools: 2,069,766 -> 2,063,648. Six paired live post-result exchanges increased as outcomes and visible facts changed; total paid tokens per hour remain unmeasured.
- **Sources:** branch `claude/q2-fight-blocked`, `EntityHitboxSight`, `ObservationVisibility`, `ThreatPerception`, `ServerFightController`, `ServerFleeController`, `CombatMoveText`, `EntityHitboxSightVerification`, `FightMovementVerification`, `ThreatAttentionVerification`, `observation-adapter.mjs`, `protocol-v2.mjs`.

## Quality run, wave 2: sixth approved integration batch (Oct 10, 2026)

### Mining a block whose centre is hidden
- **Problem:** Mining required the crosshair to be on the block before the promised turn could happen. A visible edge did not help when the centre was hidden, and failure feedback could name an obstruction outside current sight.
- **Solution:** Admission finds a reachable visible outline point, turns at player speed and tries a distinct angle-valid point after a rounded miss. A blocker is named only from the current eye ray; standing hints use seen terrain. Existing action-use refusals, drop-ahead and fall facts remain composed.
- **Result:** (measured integrated checks) 58/58 coordinator tests and 626 focused Java assertions pass, including mining sight, seen terrain and existing action/drop feedback. These are compiled geometry and executor checks, not a new live gameplay run.

### Combining combat sight, death facts and schema recovery
- **Problem:** Shared protocol and test edits could discard either current threat visibility or recovery from an unknown signal. Death facts also had to survive respawn without duplicating situation assessment.
- **Solution:** Accept the optional visibility fact while retaining schema-drift recovery and both Java verification groups. Recovery keeps observed death dimension/location, a conditional despawn bound, portal contact, fixed respawn distance and nearby death counts; situation-input remains the sole assessment owner.
- **Result:** (measured integrated checks) 243/243 recovery/presentation tests, 185/185 combat/protocol tests and 557 focused Java assertions pass. Full coordinator: 3,273 pass, 3 skipped, zero failed or cancelled. Desktop full build passes 2,546,923 core assertions, 438 voice assertions, 20 camera/presentation checks, 40 transformed POV classes and headless window rendering; 1,728 source hashes match before and after.

### Sixth-batch measured budgets
- **Result:** (measured c6277870 versus the integrated stack) 24 final-3 B runs, 130 reconstructed encoded events: 1,378,151 -> 1,378,323 B; mean 10,601.16 -> 10,602.48 B. Adding one provider tool-definition set per recorded wake gives 4,962,251 -> 4,941,493 B, down 159.68 B/wake. Passive task memory follows the production recovery-aware summary path. Recorded wake times and historical wire facts are fixed; authored plans/programs and exact provider bodies are unavailable, so this does not measure gameplay frequency or regenerated visibility facts.
- **Desktop forensics:** (measured production runtime reconstruction) seven saved zombie deaths and respawn receipts over 123.751 s retain counts 1 through 7, death coordinates, dimension, fixed respawn position, lifetime bound and distance. Encoded inputs 19,439 -> 21,352 B, mean 2,777.00 -> 3,050.29 B; including tools, these seven wakes grow 112.29 B/wake. Original terrain and prompts were not retained. This increase is reported separately from the final-3 saving; it does not establish whole-run token non-regression.
- **Always-sent text:** (measured) provider tools 27,570 -> 27,409 B; MCP tools 27,048 -> 26,887 B, below 29,200. Native instructions remain byte-identical at 1,481 characters/bytes; script API remains byte-identical at 14,136 B; planner remains 16,532 B. Twenty direct event/trigger cases remain 16,084 B total, with identical underlying facts at 12 tested compaction boundaries. Live latency, hourly tokens, billing and combined server perception cost remain unmeasured.


## Quality run, wave 2: seventh approved integration batch (Oct 10, 2026)

### Reporting only routes the player has acquired
- **Problem:** Hidden terrain could decide a route, a newly opened passage could still produce a stale frontier, and raw search geometry could expose a closed pocket.
- **Solution:** Plan through acquired terrain, refresh consulted knowledge before retained searches resume, and recheck the frontier before reporting it. Preserve underwater surfacing recovery, return unknown-route facts before geometry detail, and enable the latter only for a fully seen search.
- **Result:** (measured assembled Desktop smoke) an opened wall reaches the destination in one 1,603 ms call; a closed wall returns REACHED_FRONTIER in 502 ms at the seen boundary without pocket detail. Focused navigation and perception pass 12,871 Java assertions. Accepted branch-review CPU trade-off, not remeasured here: retained-search refresh rose from 0.37 to 157.6 microseconds at 1,877 consulted cells; no further refresh work was added during integration.

### Keeping program recovery and discovery delivery consistent
- **Problem:** Offered recovery operations could fail after cancellation, ordinary discoveries repeatedly woke a model whose own program was still running, and a deferred sighting could outgrow the event budget.
- **Solution:** Share acceptance rules between operation offers and execution, retain exact stale handles and material-danger fencing, and carry bounded acquired discoveries through pauses, responses and completion. Keep loop-detector motion evidence and its independent byte allowance alongside discovery suppression.
- **Result:** (measured real modules with fixture bridges) 1,559 contract tests and 1,377 combined wake/protocol/loop tests pass. On the recorded final-3 B S5-r3 program, the controlled replay gives 24 -> 2 notifications, 7 -> 2 simulated turns and 281,265 -> 25,515 wake bytes; response latency is simulated at 2.4 seconds, not a new provider run. All 96 admissible inputs among 120 stress cases build within budget; 24 oversized-message cases retain their existing rejection. A live fixture mines three oak logs with six successful body actions and explicitly finishes its pending decision.

### Remembering stations that were placed, carried or removed
- **Problem:** A destroyed station could remain listed as placed, and stale inventory or unordered asset facts made task memory misleading.
- **Solution:** Correlate station receipts with durable dispatch facts, reconcile only fresh visible evidence, derive carried assets from inventory, and rank compact facts by proximity and verification. Preserve observed portal transitions and cross-dimension death recovery. The station update remains after notebook persistence so plan-drop can insert its receipt callback immediately before it.
- **Result:** (measured assembled replay of 12 recorded station/inventory facts) mean task summary 1,187.17 -> 815.42 B; event 2,115.83 -> 1,744.08 B; packed summary 1,005.33 -> 763.42 B. Saved Desktop memory changes 10 placed records to 5 placed and 5 destroyed, 5,989 -> 5,551 B. Summary compute mean is 0.0186 -> 0.0266 ms in six counterbalanced rounds; station receipt persistence retains the approved branch's extra disk work. These are reconstructed facts, not gameplay or billing measurements.

### Seventh-batch validation and measured budgets
- **Result:** Full coordinator: 4,449 pass, 3 skipped, zero failed/cancelled. Desktop `verifyCore build verifyPovMixins verifyLiveWindows` passes: 2,547,030 core assertions, 438 voice assertions, 20 camera/presentation checks, 40 transformed POV classes and headless rendering. All 1,737 tracked source hashes match the built Desktop copy. Live navigation and mining smoke: 7/7 checks.
- **Final-3 B:** (measured 3eb4bb74 versus assembled stack, fixed recorded wake times) 24 runs, 130 encoded events: 1,378,323 -> 1,371,726 B, mean 10,602.48 -> 10,551.74 B. Including one provider tool set per wake: 4,941,493 -> 4,934,766 B, saving 51.75 B/wake. Passive memory uses actual correlated dispatch/receipt facts; dispatch time is inferred from first progress minus elapsed time. Historical wire visibility, authored plans/programs and exact provider bodies are not regenerated.
- **Desktop forensics:** (measured reconstructed seven actual zombie-death/respawn wakes) 21,352 -> 20,911 encoded B, mean 3,050.29 -> 2,987.29 B; including tools saves 64 B/wake. Counts 1 through 7 and all prior recovery facts remain. This subset and the station replay do not reconstruct every original Desktop turn.
- **Always-sent text:** provider tools 27,409 -> 27,408 B; MCP form 26,887 -> 26,886 B. Native instructions remain byte-identical at 1,481 characters/bytes, API at 14,136 B and planner at 16,532 B. Twenty event/trigger cases remain 16,084 B; twelve compaction-boundary checks retain their underlying facts. Whole-server CPU, paid tokens, model decisions and hourly billing remain unmeasured.

## Quality run, wave 2: concrete goal progress

- **Problem:** A broad manual preparation step hid the next missing resource, and completed-step lists could consume the progress display before the next requirement appeared.
- **Solution:** Ask the translator for ordered, individually checked milestones authored from player facts. Put the first available requirement, its check status, missing counts and best held tool first within the existing 240-byte display; label unchecked intentions and reported completions as unverified.
- **Result:** (measured offline against 27419ba3, same authored plan) two captured inventory displays change from 252 to 152 bytes and 72 to 46 `o200k_base` proxy tokens, mainly by replacing later step IDs with a count. Those IDs remain in the plan; additional model rounds to read it are unmeasured. A 25-wake death/recovery replay delivers 1,215 -> 1,045 progress bytes and 318 -> 273 proxy tokens. The once-per-goal prompt grows by 563 bytes and 102 proxy tokens. Round-2 regressions correct wooden-before-stone and golden-before-stone hints without choosing an action. A fake provider's 11 checked dragon milestones survive the contract, steering and reloads; live Luna choices, gameplay speed and total hourly cost remain unmeasured.
- **Sources:** `goal-spec-translator.mjs`, `live-task-view.mjs`, `plan-checks.mjs`, `plan-detail.test.mjs`, `plan-progress.test.mjs`.

## Quality run, wave 2: eighth approved integration batch (Oct 10, 2026)

### Remembering an exit and keeping lava bobbing within the danger fold
- **Problem:** Deep lava hid a shore the body had just used. Surface bobbing could repeatedly reintroduce the same hazard, and the old event line omitted continued burning after exit.
- **Solution:** Keep bounded, aged landing evidence from seen and walked terrain, label higher landings and route uncertainty, retain recent severity across folded samples, and present the approved contact or residual-burn facts. The model authors every movement.
- **Result:** (measured final installed Desktop jar) 12/12 live checks pass, including an unseen shore staying unknown, recalled up5 shore, held jump rising 1.087 m in 30 ticks, authored escape, fire interruption in 349 ms, continued burn damage and water extinguishing. A 10.099 s capture has 118 observations and 28 contact flips. At 100/250/500 ms synthetic damage cadences, all 85 phase replays retain baseline wake counts with a minimum 2,000 ms gap. At 500 ms, mean encoded replay bytes fall 11,737.70 -> 11,346.62 B (3.33%); nine actual snapshot projections total 68,696 -> 67,576 encoded B. These compare production builders on the same observed facts, not paid survival or exact historical damage timing. The accepted slower-cadence window-edge follow-up remains.

### Keeping standing stations complete while naming the next unmet step
- **Problem:** An advisory plan could disappear when one step was invalid, lose credit for a standing table or furnace after death, or fill its short progress line with completed and later steps before naming the immediate requirement.
- **Solution:** Salvage valid plan steps, retain correlated own placement and break evidence, and put the next checked requirement first. Share direct block evidence with seen-memory, keep both plan and station receipt paths, retain early-presence guards, and label unchecked facts honestly.
- **Result:** (measured recorded Desktop sequence through actual dispatch/result APIs) 237 events per inventory model, including 9 placements, 219 breaks and 9 deaths. Station-status violations fall 247 -> 0 with empty inventory and 183 -> 0 with modelled station pickup; first-step display violations fall 65 -> 0 in the pickup model. All 474 final displays lead with the next open step and stay at or below 177 B. Two captured inventories with the same granular fixture plan show `iron_pickaxe` unmet and `have:stone_pickaxe`, 126 -> 76 B per line. The station replay gains placement and loss facts: progress totals grow 37,908 -> 70,682 B, and encoded event totals grow 638,013 -> 707,892 B. Full historical inventories and the original granular plan are unavailable; these are controlled sequence replays, not every original provider turn. The goal-translation fixture grows 10,305 -> 10,964 B once per translation. The 1,024 placement eviction policy and extra model rounds to read counted later steps remain accepted follow-ups.

### Passing eating facts through the live wire schema
- **Problem:** The approved server emitted `survival.canEat` and `bestFood.alwaysEdible`, but the coordinator's observation schema still rejected them. A burn probe stalled after its first damage sample.
- **Solution:** Validate both optional booleans and preserve them through the observation adapter; retain the legacy shape and reject invalid types. The new regression covers ordinary food, always-edible food and eatability without a safe best-food entry.
- **Result:** (measured final live bridge) the earlier probe reported rejected survival observations; the final normal streamed-observation probe reports zero protocol rejections and retains bread eatability during a burn. The full entry-point check now passes rather than relying on inspection replies.

### Eighth-batch validation and measured budgets
- **Result:** Focused fire/heal 95/95, plan retention and shared evidence 178/178, concrete progress 158/158, and schema/eating 152/152 pass. Final coordinator suite: 4,517 pass, 3 skipped, zero failed/cancelled. Desktop `verifyCore build verifyPovMixins verifyLiveWindows` passes in 55 s: 2,547,079 core assertions, 438 voice assertions, 20 presentation checks and 40 transformed POV classes, with no visible game window. All 1,449 coordinator, Java and Gradle source hashes match the built copy before and after.
- **Final-3 B:** (measured baseline 7f0408f5 versus assembled batch, fixed recorded wake times) 24 runs, 130 events: 1,371,726 -> 1,371,759 encoded B. Including one tool set per wake saves 9.75 B/wake, 4,934,766 -> 4,933,499 B. This reconstruction omits unavailable authored program/plan state. Twenty ordinary event cases remain 16,084 B; twelve compaction boundaries retain their facts.
- **Text:** Provider tools 27,408 -> 27,398 B; MCP form 26,886 -> 26,876 B. Native instructions remain byte-identical at 1,481 characters/bytes, API at 14,136 B and planner at 16,532 B. Contact and burn lines are exactly 186 and 138 B; hazards reference is bounded at 1,751 B with CRLF. Coordinator coalescer median rises 0.250 -> 0.324 microseconds per offer in six warm 100,000-offer measurements per arm. Whole-server CPU, paid tokens, total hourly cost and model decisions remain unmeasured; no overall gameplay savings claim follows from these samples.


## PR #65 preparation: completed wave 1 and wave 2 integration (Oct 10, 2026)

The ten wave-1 changes remain documented under **Quality run (Oct 9-10, 2026)**: situation awareness, checked goal progress, smaller events, danger delivery, action replacement, exploration memory, Nether movement/projectiles, hazard escape, strategy facts and reachable combat. The following index covers all **24 wave-2 product fixes**. Detailed entries above retain their branch measurements, methods and accepted limits; the final measurements below supersede earlier assembled budgets. The separate scenario-harness work belongs to PR #64 and is not folded into this product stack.

| Wave-2 fix | Problem and integrated behavior | Detailed catalogue entry |
| --- | --- | --- |
| eperm | Concurrent reads and saves share one file queue; nested same-file turns reject. | Saving plans while another part of the coordinator reads them |
| script-errors | One rejected program reports independent bounded repair diagnostics. | Repairing several program errors in one response |
| threat-wording | Danger and strategy state facts and choices while the model chooses actions. | Giving danger facts without choosing the response |
| eat | Server food components determine eatability; healing reports its current bound. | Showing whether food can be eaten and how fast health can recover |
| schema-threat | Valid ranged aiming is accepted; recoverable drift drops one snapshot. | Keeping the connection when one snapshot uses an unfamiliar field |
| action-feedback | Bulk searches, occupied placement and refused food explain their cause. | Explaining searches, occupied placement cells and refused food |
| drop-ahead | Results name acquired edges and measured fall HP sum. | Reporting the seen edge ahead and the falls already taken |
| scan-cost | Historical sightings appear once under their newest heading; baseline coverage stays. | Listing look-around sightings once without losing baseline coverage |
| repeat-failure | Authored handlers receive repeat facts and retain replacement authority. | Letting authored programs handle repeated failures |
| seen-memory | Aged acquired resources survive camera turns until direct evidence contradicts them. | Keeping acquired resource facts when the camera turns away |
| situation-input | Corpse presentation stays honest and the unread respawn assessment survives. | Presenting a corpse honestly and retaining the next situation assessment |
| loop-detector | Walked loops survive delivery races; shoves and nudges do not count as choices. | Reporting walked loops without treating a shove as a decision |
| respawn | Recovery retains exact death, respawn, loss and nearby-death facts once. | Wave 2: death and recovery facts |
| fight-blocked | Sight and aim use exposed hitboxes; blocked combat reports acquired facts. | Seeing and hitting the exposed part of a combat target |
| mine-visibility | Mining accepts a visible part of a block and names only current sight blockers. | Mining a block whose centre is hidden |
| unseen-nav | Navigation plans and refreshes acquired terrain; unknown routes precede geometry detail. | Reporting only routes the player has acquired |
| program-contract | Offered directives and operations agree with actual runtime acceptance. | Keeping program recovery and discovery delivery consistent |
| program-wakes | Routine discoveries fold while authored work runs; bounded unexposed discoveries remain. | Keeping program recovery and discovery delivery consistent |
| my-stuff | Correlated receipts distinguish placed, carried and destroyed stations. | Remembering stations that were placed, carried or removed |
| plan-detail | Concrete checked milestones and the best held tool lead the progress display. | Quality run, wave 2: concrete goal progress |
| fire-escape | Remembered vertical exits and persistent burns survive bounded danger coalescing. | Remembering an exit and keeping lava bobbing within the danger fold |
| plan-drop | Valid plan steps survive invalid siblings; own station proof survives death. | Keeping standing stations complete while naming the next unmet step |
| pickup | Compact candidates and receipts explain stale drops; acquired occupancy composes with unknown routes. | Compact pickup facts and occupied destinations below |
| token-trim | Explicit shared row defaults compress facts; short identifiers stay literal and tool contracts remain. | Measuring tokens while preserving facts and tool contracts below |

### Compact pickup facts and occupied destinations

- **Problem:** Stale drop selectors gave little useful feedback, solid destinations hid acquired occupancy, and repeating per-break drop rows cost more input.
- **Solution:** Keep visible candidate UUID/count/item rows and component-matching collection receipts, omit recurring per-break drop rows, and decorate failed terminal movement from acquired terrain. Preserve NO_SEEN_ROUTE and REACHED_FRONTIER messages, support bounds, route uncertainty and existing hazard suffixes; successful movement remains unchanged.
- **Result:** Approved round-3 live evidence measured 8/18 -> 18/18 checks and 90,096 -> 89,768 terminal-result bytes on 110 comparable results, excluding the hidden-target defect. Hidden UUID requests fell 9,446 -> 45 ms, separately measured. Final integrated backend composition passes 22/22 assertions, including unknown headroom with a retained known oak-log obstruction; current pickup, receipt and terrain checks also run in verifyCore. Standing hints cover full-block support within radius 3 horizontal/1 vertical and promise no route. These measurements do not prove hourly cost or future model choices.
- **Sources:** PickupReceipts, ItemPickupReceiptMixin, ActionResultFacts, AcquiredResultTerrain, ServerItemPickupController and their verification classes.

### Measuring tokens while preserving facts and tool contracts

- **Problem:** Short identifier references saved bytes while increasing model tokens; shortened descriptions could discard constraints. The final stack also needed every intervening description change preserved.
- **Solution:** Keep the 32-character identifier threshold, encode identical row fields as explicit defaults before varying rows, and cache object serialization. Re-derive descriptions from the assembled stack, retaining scan headings, eating duration, search limits, partial-block sight, threat visibility, permitted program directives and the pickup distance contract. taskMemory calls its historical records entries.
- **Result:** Final MCP definitions are 25,964 B and 6,119 o200k_base tokens, compared with wave 1's 27,110 B/6,326 tokens and batch 8's 26,876 B/6,301 tokens. Full provider wrappers are 26,486 B/6,235 tokens. Native instructions remain byte-identical at 1,481 characters and 319 tokens; the API reference remains 14,136 B and 3,225 tokens. Seventy focused contract/encoding checks pass, including 500 seeded exact round-trip pages; all final tool schemas equal batch 8. Product-only squash excludes token-trim's research history.
- **Sources:** model-fact-encoding.mjs, native-minecraft-tools.mjs, token-trim.test.mjs.

### Final integration budgets and limits

All numbers below are measured UTF-8 bytes and direct gpt-tokenizer 4.0.0 o200k_base counts through each revision's production adapter, event builder, memory and encoder. One MCP definition set per input is added as a selected-input accounting comparison, including potentially cached reads. It is not billing or the whole conversation.

| Measured mean | Wave 1 442ee8fa | Batch 8 a4bf48e7 | Final product |
| --- | ---: | ---: | ---: |
| Final-3 B event B/wake, 130 wakes | 10,865.71 | 10,551.99 | 10,160.71 |
| Final-3 B event tokens/wake | 3,509.53 | 3,437.08 | 3,316.41 |
| Final-3 B event + MCP tokens/wake | 9,835.53 | 9,738.08 | 9,435.41 |
| Desktop event B/presentation, 474 controlled presentations | 641.27 | 1,493.44 | 1,492.93 |
| Desktop event tokens/presentation | 186.10 | 467.76 | 471.64 |
| Desktop event + MCP tokens/presentation | 6,512.10 | 6,768.76 | 6,590.64 |
| Desktop recovery event B/wake, 7 actual death/respawn pairs | 2,844.00 | 2,987.29 | 2,769.43 |
| Desktop recovery event tokens/wake | 858.57 | 898.86 | 837.00 |

Final-3 covers all 24 B runs with no missing or rejected replay observations. Recorded wake times and wire facts are fixed; authored programs/plans and movement-loop state are unavailable. The Desktop series replays 237 recorded placement/break/death events under each of two inventory models with the same fixture-authored checked plan, rather than reconstructing all original 232 provider turns. Placement/loss facts grow its event payload versus wave 1: final selected input remains 78.54 tokens/presentation above wave 1, while falling 178.12 versus batch 8. The empty-inventory encoder alone grows 1,865 tokens versus batch 8; the pickup inventory saves 27. This is disclosed rather than treated as universal compression. Both final inventory models retain zero station-status and first-step display violations, maximum progress 177 B. Seven separate reconstructed recovery wakes retain exact death/respawn facts and observed counts 1 through 7.

Full npm: 4,531 passed, 3 skipped, zero failed/cancelled, 109.05 s. Final Desktop verifyCore/build/verifyPovMixins/verifyLiveWindows and the composition probe pass in 59 s: 2,547,117 core assertions, 438 voice assertions, 20 presentation checks, 40 transformed POV classes and 22 composition assertions. All 1,153 checked Java/coordinator/config/Gradle source hashes match the isolated build before and after. Live smoke results are recorded below. Whole-server CPU, total gameplay tokens/hour, billing, repeated survival and the independent ongoing live A/B remain outside this integration's measurements.


### Final Desktop live smoke

- **S5:** Fresh installed-jar Claude Opus 5.5 low run verifies 10 logs in 63.758 s: 6 model calls, 19 body actions, zero deaths, measured capture with complete per-call coverage. The initial attempt never launched a server because the Desktop template directory was absent; the final run uses an isolated authorized template copy.
- **S7 start:** Fresh survival with the archived S7 seed and dragon goal reaches active model play: 15 model calls, 19 body actions, zero deaths. The 60-second play budget ends with TIMEOUT; the harness reports a 94.968-second goal window including its cutoff/grace behavior. Dragon completion is deliberately untested. Both captures use the final product JAR and coordinator sources, with zero observer errors; these single-arm smokes do not establish comparative quality or hourly savings. The scratch harness retains the approved evaluator plus the pre-existing S7 definition and uses its own lab directories and ports, independent of the ongoing live A/B.

## Generality: contract truth

### Keeping descriptions and executable contracts together

- **Problem:** Separate prose and validators could advertise different defaults, limits, result meanings and recovery operations. Fixing individual descriptions left the same cause in other tools.
- **Solution:** Generate all 29 native descriptions from compact claims, keep behavioral evidence under tests, and make CI reject unreviewed interface changes or unreachable Java evidence. An in-repo refresh command lists only changed claims; stable identities preserve reviewed evidence across source line changes. Shared Unicode counting keeps character limits distinct from byte budgets.
- **Result:** (measured against f32ba2c9 after review fixes) serialized tools fall from 26,486 to 24,284 bytes. Native instructions remain identical at 1,481 bytes; false-claim corrections leave the script API at 14,135 versus 14,136 bytes. The complete always-sent bundle, including unchanged Windows agent text, falls from 45,163 to 42,960 bytes. Runtime descriptions occupy 11,247 bytes; the evidence table is absent from the production jar. Gameplay frequency, provider billing and hourly savings are unmeasured.

### Aiming through the visible part without learning hidden terrain

- **Problem:** Interactions, placement and entity actions could reject an exposed target because its center was hidden. Remembered collision shapes could also depend on unseen neighbors or block entities.
- **Solution:** Reuse mining's visible-region solver for selected blocks, requested faces and entity hitboxes, validate actual float-angle player rays and retain exact authored offsets. Compute route and diagnostic shapes through acquired terrain instead of the live hidden world.
- **Result:** (measured Java verification) 39 aiming, 16 terrain-preparation and 116 inspection assertions pass, including short entities in grass, a slit missed by center/corner sampling, inset chests, exact requested faces, unchanged reach and hidden-state invariance. Desktop verification passes 2,547,946 core assertions, 438 voice assertions, 20 presentation checks and 40 transformed POV classes. Five live grass failures become physical successes while six controls, including ranged collision rays, stay successful. No target selection, alternate placement or retry policy was added.

## Generality phase: player HUD facts

- **Problem:** The model could miss ordinary player facts such as XP, absorption, selected slot and damage direction, while a mob-only safety summary called burning players safe. Older summaries exposed hidden counters and repeated the same state.
- **Solution:** One on-demand HUD read covers the visible screen and local F3 facts. One damage-type fact combines perceived harm, observed net HP loss and known exits; the same rate reaches program samples and standing-order wake consumers. Safety includes environmental harm, and public facts use the display's precision.
- **Result:** Measured encoded reconstructed wake bytes fell 3,257.86 -> 3,005.21 for 14 permitted B partial snapshots, 8,409.50 -> 8,074.38 for eight Desktop snapshots, and 20,953 -> 20,615.5 for two complete Desktop event rebuilds. A labeled stress test adds all new conditional wake facts, including two distinct harm causes, and still lowers bytes and tokenizer-proxy counts in every group. These are reconstructed samples, not whole historical runs or billing measurements. Java verified 2,547,215 core assertions; twenty actual Desktop bridge fixture groups passed, including all eleven natural harm classes.

- **Final verification:** Coordinator coverage across the frozen Desktop suite and prerequisite/clock reruns accounts for 4,553 passes and three platform skips in 4,556 registered cases; this is combined coverage. Final installed-jar public smoke passed 3/3, and all 1,307 Java class hashes match the twenty-group-tested Java. Raw classifier receipts retain the shared rate; public scripts/queries use HUD precision and a private elapsed clock.


## Generality phase: HUD parity review fixes

- **Problem:** The generic harm summary blocked eating during starvation, visible night disappeared from wakes, and routine chat/toasts added attention. Missing entity data also crashed contract fixtures.
- **Solution:** Preserve starvation as harm while allowing its food remedy, retain known sky/clock phase through event compaction, and keep chat/toasts as facts without new wakes. Treat absent player entity data as no perceived harm; document the shared rate in game seconds.
- **Result:** Four independent Java failure groups and three Node regressions plus an overflow case fail before the fixes. Focused Desktop Java checks pass 100 overlapping assertions; 157 focused Node cases pass. Measured encoded complete-event rebuilds use 20,620.50 B/wake versus 20,953 at base; B14 partial reconstructions use 3,001.50 versus 3,257.86 and Desktop8 use 8,071.38 versus 8,409.50. Added-facts and open-sky/full-air synthetic groups remain below base in bytes and schema-inclusive tokenizer proxies. These are bounded reconstructions, not whole gameplay or billing measurements.

- **Final verification:** One frozen full coordinator run passes 4,558 tests with three skips and no failures. Desktop verifyCore/build/verifyPovMixins/verifyLiveWindows passes 2,547,232 core and 438 voice assertions, 20 presentation checks and 40 POV classes. Both installed-jar live groups pass: Easy starvation retains the ordinary eating opportunity at 10 HP, and known night survives sky, roof/clock and encoded-wake checks.


## Wave 3 context: repeated handoffs and receipt continuity

- **Problem:** The first repeated-handoff fix discarded prior-turn action handles and earlier failure explanations. Repeating the first 64k reset threshold also projected higher cache-write cost on one recorded trace.
- **Solution:** Preserve every open handle plus the latest terminal handle outside the digest window. Retain distinct failure receipts through the active turn and omit receipts already visible in each replacement input/result. Keep the first 64k handoff and use 128k for repeats, with a growth guard; preserve measured token categories in the replay.
- **Result:** Scripted MCP tests cover prior-turn handles, two successive handoffs, and original/same-action/distinct-failure steering. A q6 runtime/encoder plus actual q9 provider probe passes 3/3. A failure-bearing representative handoff is 9,228 B versus 9,706 B after six calls, and 10,159 B versus 17,488 B after 59. Conditional replay at 37k replacement context and 17,330 reusable prefix projects smoke2 $3.623490 to $3.354810 and base1 $4.677921 unchanged. Short tails can cost more: the added reset initially costs $0.113737, recovered by call seven in smoke2. Live cache reuse, billing, latency and decisions remain owed; these are projections, not a live candidate result.

## Wave 3 context: measured handoff budget and terminal receipt retirement

- **Problem:** Terminal receipts delivered in wakes did not retire asynchronous handles, so completed actions enlarged every later handoff. The repeated 128k threshold had no economic basis and shifted the expensive short tail between traces.
- **Solution:** Reconcile exact action IDs from delivered terminal events and nested receipts, including internal raw receipt identity stripped from compact model presentation. Retain all genuinely open IDs and the newest terminal ID. Replace the tuned repeated threshold with the original 64k eligibility plus a measured write budget funded by paid cache reads. Reserve before reset; settle actual first-call writes and repay surprises before another purchase.
- **Bound:** At every settled usage prefix, elective first-call writes W are at most paid cache reads R plus current unpaid write overrun D. D is at most one actual elective first-call write. This is not a proof of cost neutrality against the baseline; reused-prefix reads also fund the budget, and a large write can defer rotation.
- **Evidence:** The original 20/60 asynchronous-completion reproduction now produces 1,597 B in both cases, with zero obsolete RUNNING handles, versus 3,571/7,411 B before. Untuned typical-assumption replay spans smoke2 -2.44% to +0.06% and base1 +4.08% to +16.74%; 60k replacement with no prefix reuse is worse. Offline cost is diagnostic. One paired 10-minute same-seed actual coordinator check decides $/min and progress after Claude access returns. Detailed accounting proof, all stopping-prefix costs and live protocol are in the external wave3/context REPORT, COST-R2 and LIVE-CHECK-R2 documents.
- **q6 integration follow-up:** Retained failures use q6's shared presentation/classification, including REJECTED. At a handoff, equal explanation fields can refer explicitly to fields already shown in the current input, while action identities and differing targets/effects remain separate. Raw internal receipt identity correlates compact events with named action status. Unit and scripted MCP probes cover normalized raw receipts and explanations surviving a second handoff. The shared failure schema/catalogue is copied from q6 7d5e1e12 for branch compatibility; the merged tree uses that same final contract.

## Wave 3 context: throughput companion integration

- **Problem:** A newer steer could replace a wake whose merged events or program receipts held the only copy of a blocker. Identical bare program reasons could also suppress a different program's receipt.
- **Solution:** Adapt throughput companions 8d6ad0dd, d48dbf48 and 204383bc onto the measured-budget provider. Retain root and merged observation failures, independently named program results, and action receipts, including bare reason codes. Match program visibility by program identity. Preserve shared failure normalization, REJECTED retention, raw action correlation and terminal-handle retirement. Bare receipts do not synthesize explanations or erase earlier ones. Fold q6 d7c944e3's successful ACTION_REPLACED classification into the shared catalogue.
- **Result:** Affected provider/retention/handle/budget suites pass 112/112; q6 integration passes 6/6. Reproductions cover root and three merged placements with no/same/distinct steers across two handoffs, independently identified equal reasons, and bare receipts in successful programs. Throughput branches remain unchanged. No paid models, evals or live runs; cost policy and replay assumptions are unchanged.

## Wave 3 context: nested sequence and program failures

- **Problem:** Sol's r5 actual-runtime sequence probe still fails on 01911869: only outer tool results and selected lastResult fields reached the ledger, so the second handoff lost a nested step's blocker, attempted target and partial movement effect.
- **Solution:** Route tool and event results through one supported-envelope traversal, including results/receipts arrays and program/result/postAction/observation wrappers. Feed each receipt through the existing identity and normalization path. Preserve sourceStepId, independent action identities, bare-reason semantics and full-fact visibility checks. Read data descriptors so bookkeeping does not invoke metadata accessors.
- **Result:** The exact Sol reproduction passes after failing on 01911869. Affected suites pass 143/143. q6's shared integration at a142527e passes 7/7, including actual MCP normalization, NativeToolRuntime.sequence, authoritative failed movement and undispatched second step. Additional provider fixtures preserve sequence/program blockers, targets and effects exactly once through three handoffs. No model, eval or live run; spend $0. Prior full-suite evidence is unchanged; no full rerun for this follow-up.

## Wave 3 context: merged receipt identity and model-facing metadata

- **Problem:** The ledger correlated each historical failure with its private action ID, while handoff visibility correlated only the root. Compact merged failures were therefore carried twice, and historical _actionReceipt fields leaked through root-only stripping. Raw q6 program receipts also repeated message/execution transport fields beside their canonical failure.
- **Solution:** Correlate each merged envelope with the same-position raw envelope before exact-identity visibility matching. Strip _actionReceipt throughout supported event/result envelopes before any model rendering, including event inputs without root observations. Normalize redundant raw q6 receipt fields through its shared failure schema while keeping canonical player-facing facts. Bookkeeping keeps the raw input unchanged.
- **Result:** Sol's captured production-built inputs reproduce the failures on 170e7ec4. New tests cover raw/compact merged failures with no/newer steer through two handoffs, metadata in nested result arrays, and distinct action identities with equal explanations. Affected tests pass 150/150 and q6 shared integration 7/7. Rendered compact no-steer handoffs shrink 2005/2109 to 1638/1742 B; raw no-steer shrink 2102/2206 to 2021/2125 B; newer-steer pairs stay 862/966 B (compact) and 985/1089 B (raw). No instructions/tools/API prefix changes, no paid calls. Full-suite result is recorded in the external context report.
## Decision evals: testing the agent's choices without Minecraft

### Checking decisions on every push

- **Problem:** Knowing whether a change made the agent decide worse took live games: slow, noisy, and one run per scenario.
- **Solution:** 144 recorded moments in 17 cause-class families are frozen as raw game state. Each build renders them with its own production code, the real play model answers each one 3 times through the production provider path, and the tool calls are graded (predicates first, a cross-family judge for open cases) and compared per family against a baseline build.
- **Result:** (measured, Claude Opus 5.5 effort low) both builds on the full set: 864 model calls in 324 s at 40 concurrent, 0 errors, 0 rate limits, $21.10 player plus $1.57 judge, 7.2 min including grading. A build compared with itself passes (+0.2 pts overall). A build that hides hostile mobs from the wake fails `creeper-near` at 0/10 against 10/10 (p = 1.3e-4) in 16 s for $0.63.

### Sharing the prompt cache between repeated samples

- **Problem:** Every session named its observation views with a random id, so the 3 samples of a moment sent different bytes and each paid a full cache write of its ~7k-token wake.
- **Solution:** Eval sessions use one fixed view id (a constructor option that production leaves unset; tests prove the bytes differ only by the id). Builds older than the option get the same bytes by swapping the id at the adapter boundary.
- **Result:** (measured, same build, 20 cases x 3 samples each way) repeat samples fell from $0.072 to $0.017 (-77%) and a 3-sample case from $0.071 to $0.035 per sample (-51%); prompt-cache read share rose from 83% to 94%. The older baseline build paid $0.026 per sample over 428 samples.

### Paying only for the candidate on a pull request

- **Problem:** A comparison needs the baseline build's answers too, which doubles cost even when the baseline did not change.
- **Solution:** Baseline samples are cached by build fingerprint, harness, case and model profile, and confirm runs use fresh sample indexes.
- **Result:** (measured) a 43-case run with the baseline fully cached took 60 s and $3.21; the baseline arm cost $0.

## Decision evals, review round 1

### Never turning missing evidence into PASS

- **Problem:** A confirmation run with almost none of its required samples answered, or a judge outage that left answers ungraded, could still produce PASS.
- **Solution:** Completeness guards per family and overall, a manifest of required confirmation samples that refuses reused or duplicate samples, and an `ungraded` state that never counts as a player answer.
- **Result:** (tested) the reviewer's reproduction, 2 of 60 required samples answered, is INCONCLUSIVE. (measured) a confirmation cut short by the budget stayed INCONCLUSIVE; re-running with the screen from cache confirmed a drowning regression on 36 fresh samples for $0.59.

### Grading the response to the situation, not the tool name

- **Problem:** Some predicates rewarded any movement tool or any read, and punished moving closer before retrying a failed action, so removing failure details from the wake did not lower the score.
- **Solution:** Situation-sensitive predicates (escape progress off the hazard, freeing a slot with a low-value stack, answering the recorded failure reason) on accepted calls only, consistent derived fixtures, and a family where the failure reason changes the right next step.
- **Result:** (measured) with failure details stripped, every failure family now scores lower (-14.3, -9.5 and -8.3 pts; overall -11.1 pts, p 0.005), where before the same mutation scored higher than the baseline.

## Decision evals, review round 2

### Grading what the player did, not which tool it named

- **Problem:** Two rounds of predicate whitelists kept rewarding unrelated actions and punishing real repairs.
- **Solution:** Predicates decide only unambiguous outcomes (clearly wrong by the recorded facts, or the canonical repair of the recorded cause); a cross-family rubric judge decides the rest, with verdicts cached by case, accepted trajectory, rubric and judge model.
- **Result:** (measured) regrading 1,748 recorded answers changed 392 verdicts (22%) for $3.89 of judge calls.

### One recorded moment, one vote

- **Problem:** A derived variant of one recorded moment counted as a second independent situation and doubled one failure's weight in its family.
- **Solution:** Each case carries a source moment id; a source moment gets a total weight of one and one sample budget split across its variants, and the exact test uses those weights. Every unit also needs complete per-arm and per-case evidence before it can decide.
- **Result:** (measured on the same answers) the drowning family moves from p 0.025 (-27.8 pts) to p 0.149 (-13.3 pts); the reviewer's incomplete-evidence reproductions all give INCONCLUSIVE.

## Decision evals, review round 3

### Showing the judge the moment the player saw

- **Problem:** The judge read a clock field the recordings do not use and saw no nearby blocks, ray target, running action, armor, sounds or deaths, and only 20 inventory slots, so a night with a bed in reach and a sunny day gave it the same prompt.
- **Solution:** The judge view now carries the day clock and phase, the 32 nearest blocks with coordinates, the ray target, the running action, survival and armor, sounds, the full slot-indexed inventory and remembered deaths, with the recorded cause in its own section and the build identity hidden. Multi-step answers show the recorded reply they received. A projection version in every judge cache key keeps older verdicts from being reused.
- **Result:** (measured) regrading 1,718 recorded answers changed 105 verdicts (6%) for $4.30 of judge calls. The night bed case went from neutral to good on all 3 samples, and stripping failure details from wakes now fails the screen (-10.2 pts, Holm p 0.0035) where it passed before (-5.6 pts, p 0.076).

### Counting the samples a run promised, not the ones it returned

- **Problem:** A comparison took its sample plan from the rows present, so a run that declared 3 samples per case and returned 1 counted as complete, and a candidate-only comparison passed on a full provider outage.
- **Solution:** The plan comes from each run's declared samples or a screen manifest, and every missing sample counts as missing evidence. Input with no plan cannot pass. Candidate-only comparisons need the same per-case coverage.
- **Result:** (tested) the reviewer's three reproductions, which all passed before, are now INCONCLUSIVE.

### A cheaper preflight on every push

- **Problem:** The quick check costs about $9 and 3 minutes, too much to run on every push.
- **Solution:** `--preflight` asks the same 54 cases 4 times instead of 6. It is labelled weaker; quick remains the PR gate.
- **Result:** (measured) $4.29 and 143 s with a cached baseline; (simulated) 41.8% detection of a 50-point single-family drop against 69.7% for quick, 0.3% false FAIL.

## Arena starts and startup recovery (audit fix run)

### Contestants spawning inside walls

- **Problem:** Arena spawn pads were laid after the ruins, walls and pavilions, but only at floor level, so some roster sizes summoned a contestant with their feet or head inside cobblestone or quartz. A two-player Last Valley, the default roster, was one of them.
- **Solution:** Every spawn pad now carves its two standing layers, and a pad still boxed in by a mound or pavilion gets a short walkway to open ground. A check builds every preset at every roster size and fails if any spawn is obstructed or cannot walk off its pad.
- **Result:** obstructed spawn slots: 21 across 63 preset/roster combinations (audit probe) to 0, and enclosed starts: 4 (review probe) to 0 (measured offline on the real blueprint code).
## Audit deferred: frozen takeover client test and plan-icon readback

### Testing a frozen operator client through the real takeover controller

- **Problem:** The deadman test proved the input lease expires when nobody renews it, but the real takeover controller renews it every tick with its cached frame, so the test could not catch an agent left walking or mining after the operator's client froze.
- **Solution:** A new check drives the real controller and input lease against a managed fake player body built with the repo's Unsafe fixture pattern (manager, server, player list, entity data, game mode, inventory). It sends held frames, stops them, keeps ticking the server, and reads what the input lease actually holds.
- **Result:** (tested) fresh frames keep control past 120 ticks; after one held frame and 40 silent ticks, movement, attack and item use are released and a new frame rearms control. With the POV-001 freshness check disabled the same test fails at the release assertion.

### Letting the plan window copy item icons out of the GPU

- **Problem:** Desktop plan icons are copied out of a private item atlas, but vanilla creates that texture without copy-source permission, so every readback was refused.
- **Solution:** A constructor mixin adds the copy-source flag to the atlas colour texture only while the plan-icon renderer builds its own atlas.
- **Result:** (tested headlessly) the icon atlas asks for usage 15 instead of 13, other atlases keep 13, and the mixin applies under Fabric. Not run on a real GPU.
## Startup and steering blockers (audit WP1)

### One failure, one message

- **Problem:** After an action failed, every quiet observation that still carried that failure steered the model's open turn again, because a moving cow changed the snapshot. One live run sent 843 steers in about 7 minutes with no further actions.
- **Solution:** An observation wake now records whether the provider already accepted that failure (goal revision plus action id). A delivered failure stops making later quiet snapshots urgent; a new failure, a failure whose delivery was rejected, damage and other danger still steer as before.
- **Result:** (measured, deterministic fixture) 20 quiet entity-motion heartbeats after one delivered failure: 20 extra steers before, 0 after. The novel failure and a damage hit each still steer once.

### Goals rejected before the first move

- **Problem:** Natural-language goals failed before play: the provider's strict output schema requires every property, and the plan step's nullable `check` field was missing from `required`, so the provider answered 400 invalid_json_schema and then opened its circuit.
- **Solution:** The goal translator sends a strict copy of the plan schema with `check` required (null means no check). The taskPlan tool and the local validator still accept older steps without `check`.
- **Result:** (tested) a recursive audit of the emitted schema finds no object with a missing or extra required key; before the fix it reported exactly `plan.steps[]: missing required check`. Provider acceptance after the fix is not yet measured live.
## Survival perception facts (audit fix run)

### "You can't heal" while holding a golden apple

- **Problem:** The healing fact looked only at the single best-ranked food. A hurt player at full hunger carrying steak and a golden apple was told it could not heal, because steak cannot be eaten at full hunger even though the golden apple can.
- **Solution:** Perception now tracks the best safe food that can be eaten right now, uses it for the heal opportunity, and names it on the wire when it differs from the best food.
- **Result:** (tested) the steak plus golden apple case went from no heal opportunity to a heal opportunity naming the golden apple; steak alone at full hunger still reports none.

### Angry wolves were invisible until they bit

- **Problem:** Threat sensing only considered hostile mobs and things that had already hit the agent, so a provoked wolf, bee or iron golem chasing the agent produced no threat until its first hit.
- **Solution:** Any mob currently targeting the agent is a threat candidate, and when more than eight threats are latched, the most urgent (a swelling creeper) are reported first.
- **Result:** (tested) a newly swelling creeper behind eight older sightings went from cut to first in the list.

## Threat attention from the full latched set (stacked on PR #73)

### Eight rows on the wire, every threat in the comparison

- **Problem:** With nine or more threats nearby, only the eight most urgent are sent. When a swelling creeper calmed down, a zombie that had been targeting the agent the whole time slid back into the eight rows, and the server called that a new "zombie is targeting you" danger. It woke the model urgently, and did so again every time the creeper swelled and calmed.
- **Solution:** The server keeps the full set of latched threat signals for each observation it collects, and compares that set with the one it last delivered successfully, instead of comparing the eight visible rows. The rows only carry details (distance, bearing, risk). Nothing new goes on the wire.
- **Result:** (tested, publication-level regression) with the row comparison the first calm-down raises a false `threats.<id>.targeting` (the Sol probe saw it repeat 102 ticks later); with the full set, two swell-and-calm cycles raise 0 false facts. Each real new swelling still raises exactly one fact. A threat that gets a new signal while outside the eight rows is promoted into them for that delivery, so its fact always has a visible row (before: no fact, only ordinary attention); with 300 hidden new signals, the shown urgent one is still delivered and the rest stay owed.
## Audit fix WP2: provider and agent state through recovery

### A provider coming back rewound every healthy agent

- **Problem:** When one agent's provider was unavailable at connect time (for example Claude without credits), the coordinator retried it later by replaying the roster it received at the handshake. That replay replaced the live roster, so every healthy agent's newer goal, revision and queue rolled back, agents registered since reappeared as missing, and removed agents came back. Minecraft then reported revisions the coordinator no longer accepted.
- **Solution:** Provider-only recovery is now separate from server roster reconciliation. It reattaches providers to the live roster without replacing it, and "who is still unsupported" is read from the live roster, so a removed agent cannot keep the retry loop alive. A fresh bridge handshake still replaces the roster authoritatively.
- **Result:** (tested) a healthy agent keeps revision 1, its goal and its queued goal through recovery; an agent registered after the handshake survives; a removed agent stays removed. Both checks fail on the previous code.

### A crashed Claude turn that looked idle

- **Problem:** If Claude Code died while a Minecraft tool ran, the coordinator restarted it and handed the tool result to the new process, but the crash had already reset the count of turns awaiting a result. A goal change then saw an idle agent and sent the next goal into the same process while the old turn was still running, so late tool calls from the old goal ran with the new goal's authority and the old turn's result could complete the new one.
- **Solution:** The cold handoff now books its own result like any other turn. An interrupt waits for that result, or retires the process if it never answers.
- **Result:** (tested) the next goal never reaches the process still running the old handoff, and no old-goal tool runs after the goal change. The same test times out on the previous code.

### Cancel that waited behind the thing it cancels

- **Problem:** Claude's tool calls all ran in one queue, so `cancelProgram` or `cancelAction` waited until the observe, watch or body call ahead of it finished, which could be the whole long-running action the model wanted to stop. Codex already let exact cancels skip the queue.
- **Solution:** Claude uses the same scheduling classes as Codex: normalized exact control calls start at once, later calls still wait for them, and a control call that overlaps other tools leaves session handoffs to the ordered call. Unknown and body tools stay ordered.
- **Result:** (tested) a cancel issued behind a pending observe runs before that observe finishes; a later `say` still runs after both. Wait time for an exact cancel changes from "until the earlier tool finishes" to immediate (estimated from the test ordering; no live provider trace).

## Durable legacy agent selectors

### A renamed agent's old name forgotten after a reload

- **Problem:** When two saved agents collided on a public name, the registry renamed one (for example `Rook` to `Rook2`). Its original readable body handle was kept only in an in-memory alias map, so after the world reloaded that handle no longer resolved to the agent.
- **Solution:** The registry snapshot now saves its alias map, and restore loads it back for agents that still exist. A current public name always owns its selector: restore drops any saved alias equal to an agent's public name, and name matches still win over aliases when resolving. Body discovery is unchanged and still refuses another agent's body.
- **Result:** (tested) the original handle resolves after one and two save/reload cycles. An agent whose public name equals that handle keeps the selector. On the previous code the reload check fails with `Unknown agent`.
## Audit WP5: programs, goals, memory and recovery

### A successful aim hid a mining loop that could not progress

- **Problem:** `mine({autoAim:true})` runs `look_at` then `break_block`. Every successful aim reset the program's failure streak, so a loop mining a block that was already air never reached the two-identical-failures rule and spent its whole budget.
- **Solution:** A composite's own preparatory step no longer counts as progress; only the mining result moves or resets the streak. Direct `player.mine` with `autoAim` now uses the same lowering instead of failing with `UNKNOWN_FIELD`.
- **Result:** (tested) a TARGET_AIR loop now returns to the model after 2 failed breaks instead of exhausting (the audit's reproduction ran 20 commands to `PROGRAM_EXHAUSTED`); other failure codes converge at the general 8-failure limit.

### Recovery trails belong to the body, not the dimension

- **Problem:** Each dimension kept its own active trail, so after a Nether death and an Overworld respawn the next death's outbound route began on the previous body's Overworld walk.
- **Solution:** A death ends the agent's active trail in every loaded dimension, and the first respawn sample resets the respawn dimension's trail when it was not loaded at the death (for example after a restart). Historical death routes stay intact.
- **Result:** (tested) the reported sequence now records the second death's route as x 0, 2 instead of 0, 20, 40, 0, 2.

### Ordering memory against the newest death

- **Problem:** Task and recovery memory emptied the inventory at death but kept only the older live clock, so a delayed pre-death sample handed the lost items back to the next body. Recovery station disproofs could also move backwards or be forgotten and let an older table sighting return.
- **Solution:** Both stores keep a monotonic death watermark and ignore living-body facts older than it. Recovery disproof clocks only move forward, later sightings raise them, and evicted disproofs leave a per-world/dimension floor.
- **Result:** (tested) 6 follow-up TODO tests (F2a, F2b, F2c, F3a, F5a, F5b) now pass as ordinary tests; F3b remains a TODO.

## Audit WP5 deferred findings: durable respawn, kill fences, publication identity

### Telling a delayed sample from a world rollback

- **Problem:** Seen memory treated any lower game tick as a world rollback and wiped the scope. One delayed sample erased newer evidence, then re-admitted its own stale blocks.
- **Solution:** A lower tick with an older or equal wall time is a delayed sample and changes nothing. A lower tick with a later wall time is still a rollback and resets the scope.
- **Result:** (tested) the last follow-up TODO (F3b) passes, so the coordinator suite now has 0 todo tests (7 before this audit).

### A respawn must be journaled before the body is replaced

- **Problem:** A model respawn replaced the body at admission, before its journal entry was forced to disk. A crash or journal failure in that gap left a replaced body with no durable record of the action.
- **Solution:** Admission only reserves the action slot. The executor tick starts the respawn, and that tick already holds agents whose acceptance is not durable yet. A persistent journal outage returns the unstarted respawn to the model.
- **Result:** (tested) the body replacement now starts only after a durable acceptance. During a 20-tick journal outage it never starts and is rejected as ACTION_JOURNAL_UNAVAILABLE.

### Plan kill receipts fenced by ledger sequence, not milliseconds

- **Problem:** A kill in the same millisecond as a goal replacement, but before it, counted toward the new goal's advisory plan.
- **Solution:** The kill ledger now stores a sequence fence for every active goal, and kill ledger schema 4 persists it. Goals that were already active in an older save keep their timestamp boundary as their fence.
- **Result:** (tested) the pre-activation kill in the same millisecond is excluded; a version-3 save loads and migrates.
## Audit WP4b part 2: far sight finds everything in dense sections, sees freshly exposed ore, and bounds entity sight work

### Chests that far sight never reached

- **Problem:** Far sight reads each 16x16x16 section of nearby chunks once and keeps its exposed blocks. A read stopped after 96 blocks and then marked the section done, so in a village or a built-up area the planks used up the quota and a chest, spawner or ore later in the same section was never found, however long the agent looked.
- **Solution:** A section read now keeps a cursor. It still stops after 96 exposed blocks (one of the level's 8 section reads per tick), but the next read resumes there, the section counts as done only after all 4,096 blocks, and an unfinished section keeps the agent's candidate cache from freezing the partial answer. Block searches resume the same way.
- **Result:** (measured, scratch harness: 289 chunks, each with 100 exposed planks before a chest) before, 0 of 11 chests within small-sight range were ever found and the gather wrongly reported itself complete after 37 ticks; after, all 11 were found and the gather completed after 74 ticks, as each dense section takes two reads. A warm gather over the same chunks went from 214 to about 250 microseconds for the added neighbour checks (single run each).

### Ore exposed by digging next door

- **Problem:** A section's cached scan stayed valid while that section's own blocks were unchanged, but whether a block's face is exposed depends on the block across it, which can sit in the next section or chunk. Mining the stone above an ore at a section border left the ore "buried" in the cache.
- **Solution:** Each section scan also records the write counts of the six sections touching its faces and which neighbouring chunks were loaded (held weakly, never loaded to check), and is redone when any of them changes.
- **Result:** (tested) uncovering an ore across a section border, across a chunk border, or by a neighbour chunk loading in now exposes it to both the general scan and block searches; an unchanged neighbourhood triggers no rescans.

### A second survey in the same tick answered nothing

- **Problem:** Only one survey per level gets new sight lines each tick; others were meant to answer from their cached sight lines. Every row loop stopped as soon as the line-of-sight budget was spent, so with a budget of 0 they stopped before asking the cache.
- **Solution:** Row loops now stop on their existing test counts (plus a 64-start cap for structures); past the budget a sight line that is not cached answers "unknown" at once, and one that is cached still counts.
- **Result:** (tested) a zero-budget survey now reports a structure and a chest the agent saw a moment earlier, casting no new sight lines; an uncached target still reports nothing.

### A hidden crowd made every entity a ray test

- **Problem:** Entity observation stopped after 64 visible rows, not after a bounded amount of work, so every entity hidden behind a wall within 128 blocks cost a hitbox line-of-sight test each observation, and focused entity inspection tested the whole crowd before paging.
- **Solution:** At most 256 tests per observation, nearest first and counting failures. Hostiles the threat scan has already judged visible are taken without a test, so a budget can never hide a visible threat. An exhausted budget is reported in coverage, and focused inspection gets 256 more tests per page offset so deeper pages reach further.
- **Result:** (measured, selection helper) 10,000 hidden entities plus 2 visible ones: 10,002 visibility tests before, 256 after, with the visible threat kept and the cut reported. Live tick time in a dense-entity world was not measured.

### Review round 1: neighbour edits without restarts, hunting threats inside the budget

- **Problem:** The first fix restarted a section's read whenever a neighbouring section changed at all, so a busy neighbour (a farm, a mining agent) could keep a dense section from ever finishing. Hunting hostiles were still tested for line of sight outside the 256-test budget, focused entity pages could not move past a hidden first page, cached-only surveys could make the server load an unloaded chunk, and the simulator's fixed 3x3 mining samples rejected blocks the real body can mine.
- **Solution:** Each section fingerprints the six neighbour layers that touch it when it is first read; a neighbour edit costs one layer read and, only if that layer changed, a re-read of this section's 256 blocks along that face, keeping its progress. Hunting hostiles draw from the same budget (one left untested is reported as heard), focused pages count candidates rather than visible entries, far sight reads blocks only through loaded chunks, and the simulator searches each face from its nearest point down to 1/64-block parts.
- **Result:** (tested) with an interior edit next door on every pass, the dense section's chest is found on the next pass instead of never (20 passes before); 1,000 hidden hunting mobs plus 1,000 other entities cost exactly 256 tests; a hidden first page of 256 candidates leads to the visible 257th. (measured, same scratch harness as above) warm gather about 263 microseconds against 214 before the first fix.
## Physical actions: placement, jumps, swimming, weapons (audit fix run)

### Blocks refused on slabs and fences

- **Problem:** The high-level place command demanded a "sturdy" face to build against, which vanilla Minecraft does not. Placing cobblestone onto a bottom slab or a fence top was refused before the game was even asked, while clicking the same spot by hand worked, and the agent was told those faces were unusable.
- **Solution:** Placement and the advertised placeable faces now use vanilla's rule: any solid, clickable block face. The game still decides whether the held item can survive there.
- **Result:** (measured in the audit's real-server probe) 2 of 4 legitimate placements refused before; (tested) slab, fence, stone and glass supports are all accepted now, grass and air are not.

### Planned jumps a player cannot make

- **Problem:** The pathfinder treated any one-block step up as a jump, including from a bottom slab onto a full block, a 1.5-block rise that a player cannot jump without Jump Boost. Routes through those steps stalled.
- **Solution:** Jump edges now compare the real standing heights on both sides against the vanilla jump height, so the search finds the walkable way around.
- **Result:** (tested) the slab-to-block jump is refused and the planner takes the bypass; ordinary steps and slab-height steps still jump.

### Drowning next to the shore

- **Problem:** When an agent ran low on air beside a dry shore, the surfacing logic aimed its eyes at the bottom of the breathable block, which pushed its feet into the shore floor; the move was rejected and the agent was told there was no route.
- **Solution:** The breathable block's floor is now only the lowest acceptable eye height; an agent whose eyes are already higher keeps its height and swims out.
- **Result:** (tested on the reported geometry) the surfacing line went from blocked to clear.

## Swept-body jump planning (stacked on PR #77)

### Jumps the planner allowed but the body could not make

- **Problem:** The grid planner decided whether a jump onto the next block up was possible from a few height samples and, on diagonals, a rule about the two side cells. Each fix covered one shape and missed others. A sweep of 916 jump layouts, checked against vanilla's own collision and step-up code, still found 56 jumps the planner allowed that no tested approach could complete: a block, fence post or wall beside a diagonal corner, connected fence arms across it, and obstacles over the path. An agent planning such a jump would press into the corner and stall.
- **Solution:** The planner now moves the 0.6 by 1.8 body through the jump against the collision shapes the agent has seen. It uses vanilla's jump speed, gravity and drag, collides one axis at a time in vanilla's order, and steps up to 0.6 blocks once on the ground, so landing on a stair's low tread and stepping up still counts. It tries a few approaches (steering at the landing at 0.25 blocks per tick, holding the heading at 0.1) and admits the jump if any ends standing on the landing. Jumps between flat full-cell tops with nothing else in the body's way skip the simulation. Results are cached per cell pair. The pathfinder checks the cheap conditions (landing walkable, headroom) before asking for the jump.
- **Result:** (measured, review sweep of 916 cases / 10,992 vanilla-collision trajectories) jumps allowed that vanilla cannot complete: 56 to 0. Jumps refused that the previous planner allowed and vanilla can complete: 0. 4 jumps that vanilla can complete and the previous rules refused are now allowed. (measured, scratch benchmark: 200 paths on seeded 48x48 rough terrain with slabs, stairs, fences and walls, fresh navigation view per path, three runs) planner time 1.12 ms per path before and 1.09 ms after, the same within noise. Without asking the cheap conditions first it was 3.0 to 3.7 ms. Not measured in a live world.

### Review round 1: ceilings and scaffolding in the jump simulation

- **Problem:** The simulated jump kept rising after the head hit a ceiling, so it admitted jumps under overhangs that vanilla cannot make. It also read every block's collision once with no body context, so scaffolding, which is solid only from above, blocked a body rising beside it.
- **Solution:** Any vertical collision now stops vertical motion before gravity and drag apply, as `Entity.move` does. Shapes that depend on where the body is are read each tick for the body's current feet height. Powder snow, which depends on boots and falling, is left to the earlier rules.
- **Result:** (measured, reviewer harnesses with vanilla ceiling handling) jumps allowed that vanilla cannot complete went from 15 to 0 over 653 ceiling layouts and from 1 to 0 over 12,000 random layouts. Reachable jumps newly refused against #77 went from 12 to 0 over 4,556 shape layouts. Planner time is about 1.2 ms per path on the scratch benchmark.
## Breath-aware path search and joint kill windows

### Keeping the arrival that still has air

- **Problem:** The local path search stored one cost and one breath value per cell. In a flooded tunnel, swimming straight on reached a junction cheaply with no air left, and that arrival threw away a costlier one through a dry bypass that still had a full breath. The search reported NO_PATH although the bypass route was valid.
- **Solution:** Each cell keeps every arrival that no other arrival beats on both cost and remaining breath, each with its own parent chain. Dry cells always have full breath, so they keep one arrival as before. Arrivals count against the existing node and retention budgets, and a route never steps back onto a cell already on its own chain.
- **Result:** (measured) the low-air tunnel with a dry bypass now finds an 18-node route (23 expansions, 25 retained states) instead of NO_PATH after 13 expansions. Dry fixtures expand exactly as many nodes as before: 40x40 field 80, random maze 1,185, wall detour 496, U detour 24.

### One kill, one goal leaf, across time windows

- **Problem:** A goal asking for one zombie kill since the goal started and one zombie kill at any time accepted a single new kill, because each time window counted kills on its own.
- **Solution:** Kills are claimed per entity type with two totals: all claiming leaves must fit within all kills, and the leaves that need post-start kills must fit within post-start kills. The kill ledger also keeps enough compacted all-time progress for both kinds of leaf.
- **Result:** (tested) one post-start kill now fails the mixed goal in both leaf orders; two kills, or one earlier plus one new kill, pass; the result survives ledger eviction and a restart.

### Remembering where a route ran short of air

- **Problem:** Routes may not repeat a cell. An arrival in an air pocket that came through a depleted junction can never go back through that junction, yet it still counted as covering a costlier arrival over a flooded loop that could. The search reported NO_PATH although a valid route existed.
- **Solution:** Each arrival remembers the submerged cells it crossed short of air. It covers another arrival only if the other is barred from those cells too. Open flooded areas have a different history for every simple path, so a cell keeps at most one arrival that differs only in history.
- **Result:** (measured) the review's air-pocket case goes from NO_PATH to a 14-cell route in 24 expansions, including with 1- and 2-expansion slices. Dry searches are unchanged. A 30x30 low-air flooded cave takes 2,447 expansions against 938 on main, where the exact rule without the per-cell bound hit the 32,768-label cap.

### Extra arrivals get their own budget

- **Problem:** Keeping several arrivals per cell (breath levels, route histories) used the cap that used to bound reached cells. On a large low-air flooded cave the search ran out before reaching cells that main reached, and lost a route main found.
- **Solution:** The cap counts cells again. Extra arrivals draw on a separate budget of 4,096 and fall back to one arrival per cell once it is spent. An arrival that differs only in history is kept only if it may still enter a cell every retained arrival there is barred from.
- **Result:** (measured) 0 regressions against main in 30,000 seeded worlds. The six-floor cave goes from NODE_LIMIT to FOUND in 16,469 expansions (main 9,167), and worst-case CPU on the reviewer's benchmark drops from 15x to 4.2x main.
## Truthful, discoverable model interface

### A closed action vocabulary in the schema

- **Problem:** `act`, `startAction`, `replaceAction` and sequence items accepted any string as `actionType`, so a model learned the 40 valid names only from prose or a rejected call.
- **Solution:** All four entry points advertise the same string enum generated from the `ACTION_FIELDS` catalogue the validator already uses; invalid names are still rejected exactly as before.
- **Result:** (measured) `act` schema 2,266 -> 2,826 bytes, whole tool list 26,440 -> 28,572 bytes; 40/40 types in every enum, 0 missing or extra.

### Two budgets a program can run out of

- **Problem:** Physical calls and world queries share 256 commands per program version, while `maxActions` separately caps physical actions for the run. Neither usage was visible, so a program could hit `COMMAND_LIMIT` after 255 actions and one inspect with no warning.
- **Solution:** Program status and results report `commandsUsed`, `commandsRemaining`, `queriesUsed`, `actionsUsed` and `actionsRemaining`; capabilities list `programCommands` and `programLoopIterations` from the interpreter's limit table. No limit changed.
- **Result:** (tested) 0 used after pure reads, 1 query after one inspect, 256 actions finish, the 257th and inspect+256 reach `COMMAND_LIMIT`, replacement resets commands while run-wide actions persist, and publishing status issues 0 queries or commands.

### Remembering what the current step needs under a broad goal

- **Problem:** Recent sightings were chosen from the final goal text only, so "Beat Minecraft" surfaced no remembered iron even when the model's own active plan step was "Get iron".
- **Solution:** The model's active plan steps contribute their explicit `has:` ids and #tags, inventory evidence ids and labels to the same filter; pending, replaced, other-revision and other-world steps contribute nothing, and nothing is inferred from recipes.
- **Result:** (tested, synthetic) iron ore 0 -> 1 and logs 0 -> 1 under "Beat Minecraft"; wrong world, stale, contradicted and obsolete-step rows stay 0. Search-time savings in real games are unmeasured.

## Assisted-run audit

### Telling an earned milestone from a granted one

- **Problem:** Late-game capability checks read advancements and inventory, which `/advancement grant` and `/give` set exactly like real play. A headless run could not show that the agent beat the milestone on its own.
- **Solution:** The server now observes every dispatched command (console, RCON, player, command block). Each one that can change a player's advancements, inventory, position, game mode, effects or health is recorded for every agent it may target during that agent's goal: `advancement`, `give`, `effect`, `tp`, `gamemode`, `kill`, `data modify`, `execute ... run`, takeover, and others. World edits such as `summon`, `setblock`, `time set` and `gamerule` count for every agent with a goal. `codex audit <agent>` reports `autonomy=autonomous|assisted|unverifiable`. A goal that started before the server did is unverifiable. Late capability tasks require `autonomy=autonomous`, and `classifyCapabilityRun` labels each report.
- **Result:** (tested) 63 Java checks: 16 evaluator and control commands stay out, 30 interventions are caught, name and selector targeting, and the report states, including a forged-verdict case. The mixin applies under Fabric, and a renamed target fails the same check. Offline runner cases: a post-start advancement grant, a post-start item gift, a forged retained command, a missing audit and a restart all fail; the clean run still passes. Not run against a live server.

### Closing the audit's blind spots (review round 1)

- **Problem:** The first audit missed container and coordinate edits, takeover by agent ID, Carpet's `player` command and function lines. Starting a new goal erased known help. Read-only queries counted as help. A loose substring check accepted malformed or contradictory audit lines.
- **Solution:** Commands are classified by destination: entity changes go to the agents they resolve to (by name, alias, agent ID or selector), block, container and world edits count for every agent, and functions or unrecognised commands make coverage partial. Help counts from the agent's creation across all its goals, and a goal's report is frozen when it ends. Every takeover entry is recorded. Query branches are excluded. One strict parser checks the header grammar, the agent name and field consistency for both the runner and the classifier.
- **Result:** (tested) 103 Java audit checks, including one regression per review finding. The two mixins apply under Fabric (42 classes). 19 malformed or contradictory headers are rejected by the parser, and 4 through the runner's real pass path. Still not run against a live server.

### Allowlist instead of attribution (review round 2)

- **Problem:** The audit tried to work out which agent each command helped. Every round found another gap: selectors resolved from the wrong source or by chance, a modifier named `get`, entity UUIDs, team protection, functions wrapped in other commands, and world help given before the agent existed.
- **Solution:** Commands are no longer attributed to agents. An agent's run is autonomous only if, since a server start that created the world, nothing ran except an exact allowlist identified by parsed Brigadier node path. The allowlist holds read-only queries, the runner's own `codex` agent operations (with a survival game mode), and world rules set before any agent exists. Any other command, function, command block, director command or takeover voids every run. The audit line is bound to the agent id and goal revision the runner observed.
- **Result:** (tested) Against the real vanilla command tree, 25 runner and read-only commands parse and stay clean, and 27 intervention commands, including each round-2 case, void the run. 15 report-state checks pass. The parser rejects 24 stale, foreign or contradictory lines. The cost is accepted by design: any non-allowlisted command during a run turns it into an assisted run. Not run on a live server.

### Closing the allowlist's lifecycle and startup gaps (review round 3)

- **Problem:** Lifecycle exemptions let an operator stop and restart, or steer, the measured goal. `forceload` kept chunks ticking. A writable saved flag could certify an edited world as fresh. Startup data packs, mods or custom generation could help without a command. The scenario GUI stocked chests through Java APIs.
- **Solution:** Each server lifetime allows exactly one agent creation (survival) and one goal start. Any further start, goal change, steering or extra agent is an intervention. `forceload add` is setup-only, and the ticket must be released before play. Freshness comes from the world directory holding nothing but the session lock at server start. Selected data packs, loaded mods and overworld generation must match the project baseline, otherwise the run is unverifiable. Scenario launches and cancels, and any non-agent player online, are interventions.
- **Result:** (tested) The runner's real command sequence, replayed through the parser and the audit lifecycle, ends autonomous. Every round-3 case is assisted or unverifiable in Java checks. The long runner's own setup is documented as assisted. Not run on a live server.

### Deciding world freshness before Minecraft touches the world (review round 4)

- **Problem:** Minecraft saves `level.dat` for a new world before `SERVER_STARTING`, so every genuine fresh run looked like an existing world. The mod baseline trusted any `fabric-` id, and other players were seen only when a command happened to sample them.
- **Solution:** The mod's initializer runs from Fabric's patch ahead of `server.properties` loading in `Main`, before `validateAndCreateAccess`. It resolves the level folder the way Minecraft does (`--universe`, `--world`, `level-name`) and records whether the folder held any regular file. At start, the world is fresh only if that observation names the same folder, found nothing, and the folder has since gained only `session.lock` and `level.dat`. Mods must be an exact root set or jars contained in one, and packs must be vanilla, Fabric's group or an allowed mod's pack. Every player join is checked against the managed fake-body identity (Carpet fake class plus the agent's offline UUID and name) and counted for the server lifetime.
- **Result:** (tested) Replaying the bytecode-ordered new-world startup on disk gives `fresh`. An edited world, chunks present before start, a different folder or no early observation do not. A foreign `fabric-pearl-helper` mod and its pack are rejected. A pre-goal visit still counts after the player disconnects. Not run on a live server.
## PR #78: evaluation honesty audit (WP6, Oct 15, 2026)

### Decision evals that graded an impossible answer as good

- **Problem:** Hard "good" predicates decide a sample without the judge. Several only checked what the player declared, not whether it could work: using a water bucket graded good on burning and lava cases whose recorded inventory had no bucket, shooting the creeper graded good with no bow or arrows, any replacement plan that mentioned "blaze" or "pearl" graded good even when it said to skip them, and closing a chest alone graded good where the rubric demanded closing and escaping.
- **Solution:** Those alternatives were removed so the existing rubric judge decides, the corpus validator's list of known-infeasible families was emptied so it now guards every family, the judge is shown the whole accepted program instead of a 600-character prefix, and a stray second threshold field is now a schema error.
- **Result:** (measured, fixture count) 50 cases across 7 families no longer hand out deterministic good grades for unproven answers; two accepted 748- and 793-character programs that the judge previously saw as identical now project differently.

### Benchmarks that passed without doing the work

- **Problem:** The native realtime comparison passed a trial whenever both programs reported "exhausted", so an executor that dropped every action passed both arms and counted as factual parity. The headless runner accepted a failed chat as delivered and ended a run as passed when the echoed task text contained `STATUS=COMPLETED`. A probe printed PASSED after collecting empty turns.
- **Solution:** Each check now certifies what it claims: the realtime trial needs the declared body commands with successful receipts and compares normalized commands for parity; chat evidence needs a SUCCEEDED result; lifecycle parsing reads only the state segment of the status reply; the probe checks every instructed phase.
- **Result:** (tested) dropped-action, failed-receipt and no-op-source executors now fail certification while the real default workload still passes in both arms.

### Measuring idle time and action counts without double counting

- **Problem:** Body idle time summed every completion-to-next-dispatch gap across all action types, so a chat that overlapped body actions charged the same interval twice; a replayed terminal receipt added an extra action and its elapsed time to the live action-gap report.
- **Solution:** Body idle is the goal window minus the union of body-action intervals (chat excluded, clipped to the window); action-gap timelines key each terminal receipt by agent, goal revision and action id and report duplicates and conflicts instead of counting them.
- **Result:** (measured, fixture) a 1,000 ms goal with two 100 ms body actions and an overlapping chat now reports 800 ms idle (0.8) instead of 1,500 ms (1.5); a replayed receipt leaves 2 actions and 200 ms busy instead of 3 actions, 300 ms busy and -100 ms unattributed time.

## Recipient acknowledgement for simulated direct messages (SIM-007, Oct 15, 2026)

### Proving a direct message was received, not just sent

- **Problem:** A benchmark scenario asks whether an agent's direct message woke and was processed by the recipient, but the simulator only recorded the send. No recipient could ever acknowledge it, so the scenario always failed, and the only way to show "acknowledged" was to supply the flags yourself, which an event-only fallback accepted.
- **Solution:** The simulated server now delivers a direct message to a hosted recipient as a validated `conversation_event`. That recipient's own coordinator reports when it admits and wakes for the message, and when a provider-accepted decision carries it. Only those reports set the world's acknowledgement, keyed to the exact message, sender, recipient and goal revision. Caller-supplied flags are stripped.
- **Result:** (tested) in a 4-agent simulated trial, all 3 messages sent to a hosted agent are acknowledged and processed by its coordinator; a message to a plain player, and forged flags, never pass.
## Faster crafting with honest results (optimization run)

### The crafting grid filled one log at a time

- **Problem:** When an agent crafted, it picked up ingredient stacks in inventory order. With 64 logs ahead of 16 logs, crafting 64 planks counted 16 logs out of the 64-stack with one click each; with the stacks swapped it dropped the 16-stack in with a single click. Same recipe, same output, four times the clicking.
- **Solution:** Before each pickup the craft tries every matching stack first, simulates the remaining clicks, and takes the cheapest; ties keep inventory order, so it is never slower than before.
- **Result:** (measured on the real crafting menu fixture) 41 ticks to 9 ticks for the slow order, the same 9 for the fast order; the audit's real-server pair was 40 vs 8 body ticks. At 20 TPS that is about 1.6 s saved per affected craft.

### "Crafted 4 of 12" was silently dropped

- **Problem:** When a craft could only make part of what was asked, the body explained why, but program results threw successful messages away, so a routine could treat 4 planks as 12.
- **Solution:** The partial-craft explanation stays in the receipt and reaches the script as detail; full successes stay compact.
- **Result:** (tested) explained partial receipts 0 of 1 to 1 of 1, still one terminal sample and no extra read.

### Crafting and eating needed an extra look

- **Problem:** After a standalone craft or eat, the model got no fresh inventory, so any decision depending on the new items cost another round trip.
- **Solution:** Those results now carry the same single fresh sample that movement, mining and pickup already had.
- **Result:** (tested) fresh feedback for craft_inventory, craft_table and use_item went from 0 of 3 to 3 of 3, with exactly one sample each.
## Audit fixes: tests that catch the regressions they name

### Proving a test guards what it claims

- **Problem:** About 40 tests and harnesses passed whether or not the behaviour they were named after worked: assertions searched the wrong string, fixtures were rejected for an unrelated reason first, or the expected value was the production constant itself.
- **Solution:** Each test was rewritten to observe its own boundary, then checked by breaking the production behaviour on purpose (restored from a backup, never committed) and running the old and new test against the broken code.
- **Result:** (measured) for every mutated behaviour the old test passed and the strengthened test failed; the full coordinator suite and verifyCore still pass on unmodified code.

### Two servers sharing one coordinator root

- **Problem:** The orphan reaper only honoured a live owner when the record's supervisor matched its own, so a second server starting on a shared package root killed the first server's coordinator.
- **Solution:** An owner that is a live process in another JVM (exact PID and start time) keeps its coordinator; inside one JVM a different supervisor still marks a retired generation. A second claim on that root now fails as a conflict instead of replacing the record.
- **Result:** (tested) a separate owner JVM keeps its coordinator and record through reaping and a competing claim, and its coordinator is reaped once that owner exits.
## Audit fixes: POV takeover continuity, mirrored bundles, overlays, compact Group screen and scenario scoring

### Scores that only count new evidence, even across a restart

- **Problem:** Every scenario score stayed at zero because nothing in production called the scoring method, so standings and saved results ranked contestants by ID. A naive scorer would also double-award after a restart that restored the same progress.
- **Solution:** A small server-side scorer awards only what the server observes: parkour checkpoints (a telescoping share of the rule weight), finish time (the weight scaled by time left) and PvP eliminations (the weight split across opponents). Checkpoint progress only moves forward and is saved in the same snapshot as the scores, and death events never replay, so a restored run cannot earn the same points twice. Rules the server does not measure now say "Not scored yet".
- **Result:** (tested) a run that reaches 3 of 10 checkpoints holds 6 of 20 points, a quarter-time finish holds 20 + 18.75, a restored finish adds 0, and two opposing kills in a 4-player PvP match hold the full 15. 3 of 31 preset rules are scored; the other 28 are labelled.

### Keeping a dead agent's "continue after respawn" through a server stop

- **Problem:** After an operator took over a dead agent, the intent to resume its goal on respawn lived only in memory, so stopping the server before the respawn lost it and the agent came back paused.
- **Solution:** On orderly shutdown the in-memory entries are written onto the saved agent record, only while the agent is still dead, its goal revision is unchanged and the goal is unfinished.
- **Result:** (tested) through save, reload and respawn the agent now starts its goal instead of pausing; changed or finished goals still stay paused.

## Latency A/B attempts that leave nothing behind

### Containing a runner's detached children

- **Problem:** The latency A/B orchestrator found a runner's children by polling while the runner was alive. A runner that started a detached child and exited before the next process snapshot left that child running after the attempt, while the attempt still reported clean cleanup.
- **Solution:** Each attempt starts through the existing owned-job wrapper. The wrapper puts itself into a fresh kill-on-close Windows job before the runner starts, so every descendant is a job member. Once the runner exits it ends the remaining members, then exits itself; if the wrapper is killed at a timeout, closing the job ends every member. A missing wrapper refuses to run.
- **Result:** (measured on Windows) without the change, a detached child that ignores termination survived its attempt with `Cleanup.Ok=true`; with it, the child is gone when the attempt returns, both after a normal exit and after a 5 s timeout. A real instant-mode A/B with the default runner still passed in 103 s.
## Choosing how to get a resource

### Strip mining for 54 minutes and finding no iron

- **Problem:** Told to "beat the game.", two agents (GPT-6.1 Sol and Opus 5.5) dug down to Y 16 and strip-mined for 30 to 54 minutes, broke 784 and 418 blocks and found no iron, while 13 to 14 structure sightings came and went. Nothing told them speed mattered; the guide presented strip mining as the normal way to get ore and the native instructions asked for "the cheapest safe prerequisite".
- **Solution:** The instructions now set the objective as the least game time at a risk the current gear can take, and ask the agent to compare the known ways to get a resource and compare again at each new sighting or stalled yield. A new strategy topic, sourcing, lists the ways to get iron, diamonds, obsidian, blaze rods, ender pearls and food with typical yields, and judges cave risk by gear and observed light, mobs and exits.
- **Result:** (measured) about 222 extra instruction tokens per wake; the sourcing topic costs about 810 tokens when read. Gameplay effect to be measured in live run 2 against live run 1 (54 min, 0 iron).

## A fight that loses its sword mid-swing

### Driving the real fight tick without a server

- **Problem:** Weapon reselection after a sword breaks was only tested through its helper; nothing ran the fight tick that calls it, so removing the call from the tick would have gone unnoticed.
- **Solution:** A fixture allocates a player, a zombie and a flat stone level without a server, registers the agent so the real combat input lease and arbitration run, and drives `ServerFightController.tick` through a fight where the held sword breaks after its first hit while an axe waits in the hotbar.
- **Result:** (tested) the next tick leases and holds the axe, no swing happens until the attack charge is full again, the next swing hits the same zombie with the axe, and ten later ticks keep the axe. Restricting reselection to the first tick, removing it, or ignoring the attack charge each fail the verification.


## Placeable faces that agree with placement (stacked on PR #92)

### Told a block could not hold what it could

- **Problem:** When an agent places a block, placement decides which face of a neighbouring block it can click from what the held item would actually do at the visible point it clicks. Two snow layers hold cobblestone; one layer or grass is replaced; an oak slab clicked on a bottom oak slab merges into it. The observation's list of placeable faces used an older generic rule, so it hid two-layer snow as a support for cobblestone, offered a bottom slab to an agent holding a matching slab, and listed faces the agent could not see from where it stood.
- **Solution:** Placement and the observation now call one shared rule with the item. The observation judges the held block item, or a cobblestone standing in for a full block when the hand holds no block item, and the observation names which item it used. The old generic rule was removed.
- **Result:** (tested) for 1, 2 and 8 snow layers, grass, bottom and top slabs with cobblestone and slab items, a fence, a crafting table and a face hidden behind blocks, the listed faces and placement's decision agree in every case. Under the old rule two of these disagreed: two-layer snow with cobblestone, and a bottom slab with a held slab. (measured, scratch benchmark) about 4.5 microseconds per in-reach block with open faces, from one sight line per candidate face.

## Long-run harness: concurrent RCON and oversized captures

- **Problem:** A healthy Linux game ended at 42.2 minutes with `ERROR`. The matrix retained `RCON response evidence is incomplete`, but the launcher erased the diagnostic. Minecraft's RCON clients share one response buffer, so the runner's status reads can mix with the observer's large player records. A second game completed 90 minutes, then joining its captured protocol into one string exceeded V8's string limit and left a zero-progress report.
- **Solution:** Serialize runner and observer commands through a per-run lock, retain error codes and command details, and journal observations, samples and usage while the game runs. Write/read JSONL one record at a time, retain only milestone/usage evidence in long-run memory, and rebuild reports from raw captures, including legacy rotated logs and delivered provider observation snapshots.
- **Result:** A live four-client RCON probe returned 138 contaminated responses out of 200 without the lock and 0/200 with it. A regression writes and reads a capture larger than V8's maximum string with a 64 MiB heap. Run 4's rebuilt report changes from 0 milestones/0 calls to 10/24 observed milestones, 1,338 decision segments, one death and a completed 90-minute window. Its missing protocol prefix remains explicit; recovered milestone times can be late. Gameplay and agent instructions are unchanged.

## Live-authored guards that actually match the danger (claude/bg-reflex)

- **Problem:** The model could choose a good defense in a paused decision test but still die in a live game. Guards existed in 97.7% of recorded threat observations, yet their conditions excluded heard creepers and low-health retreat. Model reactions took about four seconds against a 1.5-second creeper fuse.
- **Solution:** Show whether each installed guard's condition actually matches and how often it fired. Teach the model to write its own persistent guard while safe, include threats behind it, and continue into another defense when a fight or flee stops. Remove complete defense programs from model-facing reference text; every new program remains the model's live work.
- **Result:** Measured from real traces: old guard activation-to-command median was already 80 ms, so dispatch did not need acceleration. In three controlled mob attempts per version, survival changed from 2/3 to 3/3, and matching guard conditions from 65.3% to 82.8% of threat observations. The sample is small and does not prove long-game reliability. Full millisecond timelines and validation are in `docs/live-qa/2026-10-17-reflex.md`.

## Pearls: real barter odds and priced pearl sources (claude/d31-pearls)

### One lucky barter replayed three times

- **Problem:** Three games started from the same save point each traded 10 gold to piglins and each got the same 6 ender pearls at the same minute. It looked like bartering works; vanilla odds say 10 gold gives no pearl 81% of the time. Minecraft draws barter and mob-drop loot from per-world random sequences seeded only by the world seed and the loot table, so every game from one save point replays the same rolls.
- **Solution:** A save point now reseeds every loot sequence with a fresh salt per game (vanilla `random reset`), and a live test measures real barters with eight piglins and a new salt per trial.
- **Result:** (measured) 3,350 salted ingots gave 190 pearls, about 17.6 ingots per pearl (vanilla 15.6); 10-ingot trades gave nothing 85% of the time. The unsalted control repeated exactly (4 and 4 pearls), confirming the replay. A piglin takes 6.0 s per ingot; eight in parallel take 0.76 s.

### Telling the model what a pearl really costs

- **Problem:** The model saw only a generic list of pearl sources, so after one barter it treated 6 pearls as nearly done and never sought more (d30-ngold-a, 39 more minutes, then death).
- **Solution:** While pearls are open, the wake prices each source from the situation: expected pearls and the chance of none for the gold held, the gold the rest needs in bastion gold blocks, a seen bastion, warped forests and endermen in view (about 0.5 pearl per kill), and measured fight rules.
- **Result:** (measured, live) drawing an enderman with a look and fighting in place with an iron sword killed it 3/3 in about 5.5 s on open ground and 3/3 in about 8.4 s from a tunnel in thick rock, unhurt; a tunnel with 1-block walls killed 0/5 because the enderman waits beside the wall. (measured, decision eval, DeepSeek V4.1 Flash player, GLM 5.3 Flash judge, 6 recorded moments x 9 samples) good decisions 46% vs 37% before (+9 points, not significant); arriving beside a bastion without gold, heading for its gold went from 1/9 to 5/9; after a 6-pearl barter, seeking more pearls stayed rare (1/9 vs 0/9).

## dig_to: a whole staircase in one action (claude/d31-dig)

### The body waited minutes for the model to dig each block

- **Problem:** Reaching the y-55 lava lakes took Sol 100-116 minutes in random-seed games (Oct 23, 108 games) where a player needs about 15. The model drove digging one block or one tiny program per call (one Nether game made 1,554 break_block calls) at about 5 s a call, so the body stood still 55-67% of play. Yet every block of a player's staircase is known in advance.
- **Solution:** One action, `dig_to`, takes the goal (target y, or x/z for a tunnel) and a pattern (walkable stairs, steep 2-block-drop stairs, stairs up, 1x2 tunnel). The body computes each step's cells, picks the fastest hotbar tool, mines at vanilla speed with the held attack key and walks into the opening, never breaking the block under it. It stops and hands the decision back on what a player would stop for, judged only from what the player can see or hear: lava (an opening it made onto lava is plugged first), water, caves, falling gravel, a mob in sight, damage, low health or food, a worn tool, a full inventory.
- **Result:** (measured, provider-free live runs on 3 seeds, iron pickaxe, `reports/dig-to-live-2026-10-24.json`) 60-69 blocks a minute; steep_down 1.8-2.0 s per level in stone and 2.5-2.7 s in deepslate, stairs_down 2.9-3.0 s per level, against about 50 s per level for the model-driven descents. Two underground starts reached y-56 in 107 and 135 s. Every surface descent met a cave, water or a mob within 30-90 levels and stopped correctly; every call ended within 5 minutes, with 0 deaths and 0 damage on the final build. Four hidden lava sources placed on the path all stopped the dig with the opening plugged and no damage. One full descent wears out about one iron pickaxe (about 250 blocks).

### dig_to stopped at every cave and trickle on the way down (claude/d31-dig2)

- **Problem:** Round 1 dig_to dug fast, but no surface descent reached y-55 in one call: all 7 measured surface spots stopped at a cave or water within 30-90 levels, even turning 90 degrees on each stop for up to 6 calls. A player digs the repeated staircase straight to the target and stops only for something that needs a decision.
- **Solution:** dig_to now handles what a player handles without thinking. It passes caves beside the cut (`throughCaves` on by default), seals water trickling into the cut by placing a carried block into it or into the cell feeding it, and follows the cave wall sideways when the floor under the next step is open (never back up its own stairs). With no wall left, it drops onto seen safe ground within 7 blocks only when health stays 14 or more. Otherwise it crosses the cave top at its level, placing a floor block where open, for up to 12 steps. It still stops for lava, a body of water (water on 3+ sides, or the eyes under water), a cave it cannot pass, a mob in sight, damage, and a worn tool or full inventory. Four body-safety fixes came out of the live runs: step back onto the supported block before mining, never mine a block the body rests on alone, step back from an edge before handing a stop back (an early build slid off a cave edge and fell 13 blocks), and stop before drowning. The model's estimate prices the descent at 4 s per level (~8 min from y63 instead of 11) and says it takes a few dig_to calls. The default timeout is now the 10-minute action maximum.
- **Result:** (measured, provider-free, `reports/dig-to-live-2026-10-24-r2.json`; between calls a stand-in plays the model: it turns on a cave stop, removes the sensed mobs on HOSTILE_NEAR, and gives a stone pickaxe on TOOL_WORN) Final build, 9 surface spots on 4 seeds: 6 reached y-55 (round 1: 0 of 7). Those took 2, 2, 2, 4, 4 and 4 calls and 262-526 s of digging, almost every extra call being a mob in sight; one earlier build reached 5 of 9 in at most 3 calls. The other 3 ended at an aquifer or the sea, where the model decides. No deaths; health lost per spot 0-4 (a planned 7-block drop, a skeleton arrow, mobs met between calls). Stop fixtures fired as documented: FALLING_BLOCKS, LOW_FOOD, NO_TOOL, INVENTORY_FULL, a tunnel goal and the under-water stop on stairs_up (at 298/300 air, no damage). A water source beside the stairs was sealed with 1 block and the dig went on to its target, and a cave pocket under the path was followed sideways.

## Player footwork in fights and an armable dragon-throw escape (claude/d31-combat)

### Fights that stood still between swings

- **Problem:** A model-chosen fight moved only forward and back: it stood in contact with the target through every sword recharge, never side-stepped a shot and backed toward ledges. 108 games on 2026-10-23 lost bodies to wither skeletons, blazes, piglins and endermen this way, and the model, at about 5 s a call, cannot steer a fight tick by tick.
- **Solution:** The body's own footwork inside `fight_target` (pursue:true): it waits just outside the target's melee reach while the sword recharges and steps in sprinting so the charged hit knocks the target back; it circles the target, changing side irregularly; it side-steps projectiles its raised shield does not face; it circles away from a lethal drop behind it and never steps back toward one; it jumps for falling crits only against targets with no melee or high knockback resistance (vanilla gives no crits on dragon parts); and it keeps a block of seen footing round every step and jump. The model still picks whom to fight and whether to move at all.
- **Result:** (measured, provider-free live fixtures, base e1824f5a vs new) two skeletons without armour: 7.3 health lost (3 runs) vs 4.0 (6 runs); three 40-health zombies without armour: 26.1 (11 runs) vs 24.3 (14 runs), within noise. Hand-made incident replays from the 2026-10-23 deaths (the same look and fight_target on the re-created mob, 3 passes): wither skeletons survived 9/9 vs 12/12 with mean lowest health 11.6 vs 13.6; blazes 5/5 vs 6/6, 8.8 vs 11.3; endermen 8/9 vs 9/12, 16.3 vs 12.8 (within noise). Three intermediate builds fell off a fixture ledge while circling a blaze over the edge; unseen footing now counts as no footing and those falls stopped.

### Thrown off the End island with nothing armed against it

- **Problem:** 18 of the End deaths were bodies the dragon threw off towers, the arrival platform and island edges. The model could not arm anything that moves the body away from an edge before the swoop lands, and three water-bucket clutches were cut off mid-fall by a model command sent before the model knew it was falling.
- **Solution:** Two reflex terms the model can arm: `dragon_charging` (the dragon seen flying with a line that passes within about 10 blocks in the next 3 s) and `away_from_edge` (sprint over seen footing to a cell that many blocks from every seen drop). A model command now waits for a `place where:below` clutch to land before taking the body.
- **Result:** (measured, provider-free live check) a body 1.5 blocks from a 17-block drop with the rule armed reached 8+ blocks from every edge in 0.8-4 s in 3 of 3 runs (8.6-17.5 blocks inland); base cannot arm it and stays at the lip. DeepSeek V4.1 Flash armed `dragon_charging -> away_from_edge` in 5 of 9 End-basics decision samples on the new instructions (0 on base). Incident replays with a re-created dragon reproduced only dragon-damage deaths on flat ground (no void throws), so they do not measure the escape: base 6/12, new 7/12, new with the rule armed 5/12.

## travel_to: a whole Nether trip in one call (claude/d31-travel)

### The body stood still while the model chose every few blocks

- **Problem:** In the Nether the body waited for the model 62-66% of the time. Each call to the fastest model took about 5 s and moved the body a few blocks (move_to median 0.4 s, navigate_to median 1.1 s), and navigate_to failed about half the time on Nether terrain, so the model fell back to placing and mining one block at a time. Two 120-minute games covered about 600 blocks and never reached a fortress 615 blocks away: about 5 blocks a minute, where sprinting is 336.
- **Solution:** One action, travel_to, takes a seen place or a heading and runs the whole trip at body speed. It picks a standing spot it has actually seen up to 26 blocks toward the target (where the eye's sight lines land), sprints there through the existing navigation, and picks the next one before arriving so it never stops. Where seen ground ends it builds its way on in a straight line, as a player does: sneak-bridges gaps and lava, fills holes, pillars ledges, climbs over feet-level lava, tunnels walls and punches out fire. It hands back to the model, with where and why, on arrival, damage, hostiles, low health or food, missing blocks, no way on, or a chosen block coming into view.
- **Result:** (measured, provider-free headless courses from six long-run Nether save points, no model calls, 10 minutes each) 1,630 blocks toward the targets in 48.5 minutes: 34 blocks a minute overall, 30-40 on every long course, against about 5 a minute for Sol on Oct 23 and 9 for a scripted navigate_to stand-in on the same first course (which then walked into fire and died). Open ground runs at 100-150 blocks a minute; a tunnel cell takes about 1.6 s and a sneak-bridge block about 0.9 s, and these courses needed 100-300 of them, so running out of hotbar blocks was the most common stop (17 of 59). 0 deaths, 0 fire or lava contact, 0.9 health lost in total; earlier builds of the same action died three times (lava pocket behind a tunnel wall, a plank bridge that burned under the body, lava that kept flowing after a short retreat), each fixed. Only the 41-block fortress course arrived (by seeing its bricks in 2 s); the 100 blocks/min and 80% arrival targets were not met.

### navigate_to's own failures

- **Problem:** Of 345 navigate_to calls in two Oct 23 Nether games, 182 failed: 103 ended at the edge of seen ground, 55 were refused because the target cell could not be stood in (14 named a solid block, 5 of them by integer block coordinates whose top is 1.22 blocks from the request), 7 missed a jump landing. A scripted course found the same step-up jump failing 236 times in a row, and two games walked into fire.
- **Solution:** A request naming a seen solid block (or the air just above seen ground) now means standing on it. Before a step up into a one-wide notch the body lines up on its axis (the jump started up to 0.4 blocks off-centre and hit the notch wall). No gap jumps over fire (vanilla fire burns any body touching its cell, and a jump across a one-block gap is still low when it first overlaps it), and routes keep a cell away from fire and magma wherever there is room.
- **Result:** TBD.

## Blaze shielding and rod pickup routes (claude/d38-blaze)

- **Problem:** A held shield could suppress fighting for 30 ticks after a projectile had already passed. Blaze approaches turned the shield toward path waypoints, rod pickup could route through a lower floor, and repeated knockback still pushed the body off a fortress deck.
- **Solution:** Keep the shield toward the named blaze while walking sideways along a supported route. Let combat resume between actual incoming shots, retain witnessed drop positions, and restrict shielded blaze approaches and rod-pickup routes to their deck without changing acquired terrain facts.
- **Result:** (measured, provider-free, seed 20261009, original fortress kit, 240-second limit, three repeats per arm) The broad-deck acceptance bar was not met: both base and candidate died in all nine trials; the best inventory before death was 3 rods on base and 1 on candidate. All nine final controlled footwork trials survived with no observed falls. Core verification passed 2,557,897 assertions. These correctness fixes do not establish a reliable fortress visit; the remaining failure and complete measurements are in `arena-beat-game/evals/d38-blaze/REPORT.md`.

## Straight down or through a cave to the lava floors (claude/d34-descent)

### The staircase was the only way down

- **Problem:** dig_to only dug staircases: about 3 s a level for stairs_down and 2-2.7 s for steep_down, so the surface to y-55 took 4-9 minutes of digging. An experienced player digs a 1x1 shaft straight down, which is mostly mining time, or walks down a cave where lava shows from far off. The shaft's risk is the unseen floor: the next block down may open onto a cave or a lava lake.
- **Solution:** dig_to has a `shaft` pattern. It needs a water bucket in the hotbar or offhand, breaks the block underfoot only with the body centred over it, and drops into the hole. A fall past 3 blocks into a cave is caught with water, scooped back after landing. Lava the body drops into gets the bucket poured on it first, before the executor's generic lava stop. Lava seen in the walls is plugged. It stops on lava, water or a deep drop seen below and on any fall past 3 blocks, and from `maxShaftY` (default -20, where lava lakes are common) it goes on as steep_down to the target in the same call. Every CAVE_OPENING turns the head once round the cave, crouched, and reports lava seen within 64 blocks and the lowest floor seen as a way down. travel_to now counts height toward a given y as progress, so a cave floor or lava below the body is a valid target. dig_to also accepts `stopWhenSeen` like travel_to, names the first lava seen within 16 blocks in every result, and digs snow by hand when no shovel is held.
- **Result:** (measured, provider-free, `reports/dig-descent-live-2026-10-24.json`, 12 surface spots on 4 seeds, the same kit, a stand-in for the model between calls) The shaft dug 1 s a level against 2.7 for steep_down. On the 6 spots where both reached y-55, the shaft took 3-4.5 min and steep_down 6-11 (1.9-3.8x, median 2.03x). The shaft reached y-55 on 7 spots, steep_down on 9: the shaft drops straight into aquifer water, which left the body under water on 4 spots. No deaths and no falls into lava in 36 runs. Caves caught 5-14-block falls with no damage, and a fixture with lava right under the floor cost 4 health after the pour. Following caves found lava within 16 blocks on 2 of 12 spots (2.3 and 3.3 min in), against 1 for the shaft and 2 for steep_down: most caves a descent meets are small pockets.

## d38: Merge travel safety with shaft and cave descent

- **Problem:** The lava-safe travel and shaft-descent changes were tested separately, but both change travel's controller and verification.
- **Solution:** Merge the travel safety branch first, then descent, retaining the walked-cell lava retreat, support-block footing, guarded movement, and progress toward a target height.
- **Result:** Measured from the merged coordinator: tool schemas 30,389 bytes (+25 from integration), dynamic tools 30,929 (+25), and the generated API reference 14,722 (+27). Their pinned limits match those measured sizes. Live integration evidence is recorded in the d38-merge evaluation.
## End charge advice: shorter escapes, fewer deaths (claude/d38-endfix)

- **Problem:** End advice made Sol rank a 10-second dragon-charge escape above gaze and shield rules. Oct 24 first-life End deaths reached 8.5/h, including 5.7/h from endermen.
- **Solution:** Removed that single advice sentence while keeping fight footwork and reflex controls. Added one End-only recovery fact: without blocks or a pearl, the arrival platform is a dead end across the void.
- **Result:** Five concurrent Desktop Sol-low/default games, 40 minutes each, from the old End checkpoint: 2 void deaths in 2.033 End-hours (0.98/h), 0 enderman deaths, best dragon 100.2/200, no kill. No no-kit re-entry occurred. The charge rule remained in 4/5 installed rule sets, but at 3–4 seconds rather than 10; a separate runtime prompt still suggests it. This small, single-seed historical comparison supports the fix, not complete removal of the risk. Report: `reports/d38-endfix.md`.
## d38: recoverable save points (claude/d38-savepoints)

- **Problem:** Regenerating a checkpoint's seed erased the player's route, supplies and placed blocks. Deaths left the body deep underground without wood. The bed fixture also used a forced coordinate spawn, so breaking the bed did not restore world spawn.
- **Solution:** Versioned fixtures reconstruct visible recovery shafts, lit bed camps and spare kits, use a real vanilla bed interaction, clear the End portal room, and add four independent Nether seeds with matching natural lava-pool starts. Portal pairs stay within vanilla's linking range; End starts include a prepared landing route and island shelter.
- **Result:** Measured without model calls: all 27 current fixtures passed at 20 HP for at least 60 seconds and 1,200 ticks, with inventory, recovery supplies, bed respawn, broken-bed fallback and physical routes verified. Five affected portal variants also passed live round trips. The original forced-spawn control stayed at the broken bed; all new fixtures fell back to world spawn. All 19 originals remain unchanged. No model-game success-rate claim is made.

## d38: remembered routes and recovery after death (claude/d38-recover)

- **Problem:** Death erased useful route history and left the player digging without a pick; recovery steps often had no measurable progress.
- **Solution:** Keep per-player movement and visible-resource memory, expose explicit safe retrace through portals and ladders, add factual drop/equipment preparation, and support distance, tool and pickup plan checks.
- **Result:** Final jar passed 9/9 cave/Nether/End returns in 10.7–21.2 seconds and 3/3 ladder returns. Four 60-minute Desktop Sol-low/default games with v2 camps recorded three replacement picks in 0.37–2.46 minutes and 9.5 seconds of mining without a pick. This is a combined-system historical comparison. Fresh decisions remained weak: 1/12 base, 2/12 candidate. Contradictory legacy naked-End rubrics are reported separately. Details: `reports/d38-recover.md`.

## d38: model-selected projectile shelter (claude/d38-blaze3)

- **Problem:** Blaze knockback pushes the body off a fortress deck or out of melee reach; raised shields alone did not establish reliable rods.
- **Solution:** Added model-callable `build_shelter` / `player.buildShelter`, parameterized by interior cell, cardinal opening, carried full blocks, and optional roof. It uses ordinary movement, observed terrain, vanilla placement/mining, and a fighting window above a sill. Facts explain when players use it; the model decides whether to build and fight. Shared shield/controller behavior remains independent of `claude/d38-controller`.
- **Result:** Desktop, same real spawner/kit/start, 240 seconds, three repeats each at zero and five-second call gaps: baseline died 6/6; shelter died 2/6 and collected zero rods in all six, passing 0/6 required repeats. Four held-out construction/melee/diagnostic-pickup cases passed; both jars survived 10/10 d31 replays. Core passed 2,558,171 assertions and contracts passed 639; full coordinator suite has 26 failures. No conditional Sol games ran. A construction stale-lease exception remains unexplained; a pause hypothesis was falsified and its speculative change reverted. This is not a passing fortress solution. Details: `reports/d38-blaze3.md`.

## Finishing the dragon fight (claude/d38-dragon)

- **Problem:** Seven Sol games produced no dragon kill. Post-crystal progress was 2.2–3.5 HP/minute; short landing windows passed while the model answered or approached, and some chosen head approaches repeatedly hit wing knockback.
- **Solution:** Deliver fountain, perch and breath facts before landing; keep the stronghold respawn bed out of the in-End combat prerequisites; explain enderman anger and gaze priority. A candidate body change routes model-chosen dragon-part approaches around visible wing contact volumes, without changing goals or targeting.
- **Result:** Sol low/default decision screen with Sol medium judge: 16/48 good choices versus 14/48 base (final fact wording, +4.2 points, not established improvement), PASS, zero errors/ungraded. Two Desktop approach sides: time-weighted 8.14 versus 4.99 HP/minute, zero deaths in both arms; east regressed, west improved, and candidate minimum health reached 5.0. This remains a small single-world probe. The v2 fixture also needed empty hands for its real bed tap, because crouch-use with a held item bypassed it; the kit now arrives afterward. Four completed Desktop games cleared all crystals; B killed the dragon at 43.93 minutes with zero deaths. A/C/D best HP was 134/169/105.5, deaths 4/5/2. This is 1/4 kills versus 0/7 historical games, with v2 saves and differing durations confounding the comparison; survival is not established as better. Report: `reports/d38-dragon.md`.


## Controller intent and truthful feedback (claude/d38-controller)

- **Problem:** A raised shield could consume attacks, turn tiny moves into full steps, and make expired protection look armed. Combat feedback could claim another cause's damage, and a swimmer could reject a working detour.
- **Solution:** Reserve hand input, preserve the vanilla-scaled world movement vector while turning the shield, reconcile live rule expiry, record visible arrow collisions, and measure swim progress along the acquired path.
- **Result:** Six real shipping-jar contract groups pass. A 0.15 input moves three times as far as 0.05; changing shield angle from 90° to 45° changes measured distance by less than 0.001%. A flooded detour surfaces in 6.2 seconds. Jar-loaded checks pass 19,803 assertions; coordinator contracts pass 634/634. The d31 decision replay and its suspect-case confirmation pass; the sixteen Desktop suite failures also reproduce on the base. Details: `reports/d38-controller.md`.

## d38-measure: measure retained progress and censored lives

- **Problem:** a first possession could remain a progression milestone after the kit was lost, operator stops lacked a reason, and usage bookkeeping could masquerade as model responsiveness.
- **Solution:** stream one stage score from retained samples, protocol, Watcher and coordinator logs; separate the first life and recovery, record stop intent before signalling, and report supplied/held resources separately from unproved earnings or spending. Bind advancement fallback to the agent and time window, expose zero-good decision comparisons, and freeze provider timing at its tool boundary.
- **Result:** on the same retained Desktop baseline-A trace, the former preferred usage stream has a 3 ms median while completed decision segments have a 4,196.6 ms median. These measure different boundaries, not a speedup. The updated reports label zero-good paired comparisons uninformative and expose missing continuation and causal resource evidence. Full cohort rescoring and gate results are retained in `evals/d38-measure/`.


## Blaze rods from a model-chosen shelter (claude/d38-blaze4)

- **Problem:** Hovering blazes stay beyond melee reach. During construction, centering keys could keep priority while navigation ran, then their unused input lease expired. Kills and first possession also overstated rods retained after a death.
- **Solution:** Added bow/checkpoint support and facts for model-chosen shelter shots, close melee and witnessed pickup. Released centering input before navigation takes over; kept the tactic in model choices and scripted mechanics fixtures.
- **Result:** Small 240-second cohorts, three repeats at zero and five-second call gaps: open melee held zero rods and died 6/6; shelter melee held zero and died 3/6; the fixed-jar bow arm held [3,0,0] and [0,2,1], with one death, meeting the three-rod/no-death bar in only 1/6 repeats. All six initial bow-arm shelters built. The coordinator is back from 26 failures to the 11 known Windows-dependent Linux failures; contracts pass 639/639. The bar remains unmet and no conditional Sol games ran. Details: [d38-blaze4 report](../evals/d38-blaze4/REPORT.md).


## Bow lines and shelter repair (claude/d39-blaze6)

- **Problem:** Bow calls could wait on a draw that had ended; shelter repair jumped at a scaffold hidden by its existing roof. A run acquired three rods and then lost them on death.
- **Solution:** Check the current arrow line and vanilla draw state, return the blocking block and visible clear targets, and repair missing shelter cells while preserving the ceiling and eye-height window. The model chooses every target.
- **Result:** Same 240-second spawner fixture, six repeats per jar: base retained 0 rods with 5 deaths; candidate retained 5 with 4, passing only 1/6. Ranged timeouts fell 4 to 0; cap repair failures 3 to 0. The intact-roof fixture changed from a 4.399-second failure to a 0.899-second success; eight repair/shot checks and six ranged cases passed. Fire during shooting/eating and exposed construction still kill runs. No conditional Sol games ran. Details: [d39-blaze6 report](../evals/d39-blaze6/REPORT.md).


## d39 travel3: faster Nether travel with the base fortress fact

- **Problem:** long trips stopped while usable tools and blocks remained in the backpack, and partially searched walking routes were discarded.
- **Solution:** retain bounded connected searches, use vanilla hotbar swaps for carried supplies, keep crouch across magma handbacks, and chain supported movement and visible construction. Keep the base fortress-search advice and the existing lava/fire and brink protection.
- **Result:** six fresh matched Mini PC pairs improved 31.78 to 62.15 net blocks per active minute (1.96x), with 0 deaths and 0 lava samples in both arms. The candidate had one burn (15 fire samples), so the zero-fire bar fails; neither arm arrived on a course. Two 90-minute Sol trials show mixed outcomes; see the [full/common-window report](../reports/d39-travel3.md).


## Coordinator Codex usage on the T3 Code usage page (claude/d40-t3usage)

- **Problem:** T3 Code counts Codex usage from rollout files in `~/.codex/sessions`. The coordinator starts ephemeral app-server threads in an isolated `CODEX_HOME`, and the decision-eval judges run `codex exec --ephemeral`, so games, decision evals and harness runs wrote no rollouts and the usage page showed only interactive CLI use.
- **Solution:** a usage mirror inside `CodexStdioTransport` (every game, eval player and harness thread) and after each `codex exec` judge call. Each process (a game run, an eval run, a judge batch) appends to one usage-only rollout, so eval threads do not crowd T3's session import scan. The file has one `session_meta`, `thread_settings_applied` whenever the tier changes, `turn_context` whenever the thread, turn or model changes, and one `token_count` per `thread/tokenUsage/updated`. Writes go through one ordered chain so the file's cumulative totals reconcile across threads. A file rotates, with its own session, at 50 MB or a new local day. It writes no prompts, game content, paths or credentials. Non-ephemeral threads are skipped because Codex records them itself. Writes are async, append-only and best-effort. The mirror is on by default and off under `node --test`; `AA_CODEX_USAGE_MIRROR=0` turns it off, and `AA_CODEX_USAGE_HOME` moves it. `scripts/quality/backfill-t3-usage.mjs` can rebuild the last 7 days of games from `quality-usage.jsonl`, one file per game run, (dry-run by default, manifest-tracked, `--delete` removes them).
- **Result:** T3's own parser (copied from its app.asar; a token-level comparison found every function identical) accepts a real two-thread gpt-6-luna low run in one file: 2 records, 0 malformed, 22,738 input and 10 output tokens, equal to the sum of Codex's per-thread totals, tier standard. Codex wrote no native rollout for that call. A scratch backfill of 174 game runs produced 181 files (7 runs crossed midnight; one file per thread had needed 2,407) with 75,233 records and 0 malformed; cached plus uncached input equals the logged 8,751,789,595 input tokens. Decision-eval sample files from earlier runs record null usage, so evals cannot be backfilled. Gates: gradle build verifyCore pass; `npm test` 7,078 tests with the 11 known Windows-only failures; contracts 639/639; no byte budget changed.
## Codex tiers and in-game token use (claude/d40-solcost)

- **Problem:** About 170 Sol games in three days cost about $1,200 at token prices. Recorded calls read 113k input tokens each (96% cached; cached reads 54% of cost). Codex rotation waited three completed turns, and one turn can hold 100+ tool calls, so contexts reached 450k against a 64k threshold. Codex also added a machine-wide skill list and a sleep tool to every call. Item tags were resent on every stack whenever one count changed. `ultrafast_mode` was on by default in Codex 0.164, and some fallbacks still named `priority`/`fast`.
- **Solution:** Rotate at the next completed turn, with a growth guard against thrash. Add an opt-in mid-turn threshold (`--codex-mid-turn-rotation-tokens`). Turn off Codex's skill list, bundled skills, sleep tool and ultrafast mode. List item tags once per itemId in an `itemTags` section that the delta view omits when unchanged. Show measured distances, bearings and velocities to 3 decimals. Make `default` the only fallback tier everywhere. Add cost settings to the decision loop (new builds only, 2 samples, daily cap) and the game queue (daily cap).
- **Result:** No model calls (replays and local renders). Rendered decision wakes: -3.4% tokens. Thread replay over 5 games: -3.3% input per call, -6.45% on replayed items. Codex's own prompt: -1,397 tokens per call. Per game (simulator within 0.6% of recorded cost): 107.7k → 76.1k input tokens per call, 56.5M → 39.9M per game, -14.8% cost (Sol $10.48 → $8.94, Luna $0.80 → $0.64); a 128k mid-turn threshold would reach -19.9%. Gates pass with the 11 known failures. The rotation and `itemTags` changes need a decision-eval check. Report: `arena-beat-game/evals/d40-solcost/REPORT.md`.

## Seen gold as a secondary pearl source (claude/d39-pearls4)

- **Problem:** Sol rarely turned visible Nether gold into pearl supply, while bastion access required combat and routing it did not demonstrate.
- **Solution:** Price only observed gold blocks and ore as partial ingot batches, retain held currency separately, and state unseen-piglin anger rules. No mining or trading routine chooses for the model.
- **Result:** Normal Sol low/default decisions with a Sol medium judge scored 8/66 in both arms. Two completed 90-minute candidate games earned 4.889 and 0.333 ingot-equivalents, made no trades and ended with zero pearls. Sixteen primary physical trials were retained; only one seed completed all three paired repeats. This did not establish improvement; Lucas redirected the primary pearl route to warped forests. Details: `reports/d39-pearls4.md`.


## Warped forest as the primary pearl route (claude/d39-pearls4)

- **Problem:** Gold acquisition and bastion routing produced no retained pearls in the completed games; Lucas chose slower forest hunting as the primary route.
- **Solution:** Prioritize visible warped-forest exploration and model-selected two-high cover, one-enderman provocation, stationary leg fighting and witnessed pickup. Put priority-nine gaze protection ahead of movement from the first Nether call. Prepare four natural v2 forest starts; retain seen ore and held barter currency as secondary supply.
- **Result:** Forest starts are 326–533 m horizontally from the portals (median 464 m), with travel safety unmeasured. Build/core and 639 contracts pass; full coordinator tests have only the 11 known Linux/Windows failures. No formal forest outcome is available yet: calibration is waiting for a shared live slot, and short Sol probes have failed the 30-second admission gate. This does not establish pearl reliability. Details: `reports/d39-warped4.md`; durable status: shared `evals/d39-warped4/driver-status.json`.

## Warped-forest pocket and the first pearls (claude/d39-pearls4, Oct 26)

- **Problem:** Sol had earned 0 ender pearls in every game. The forest measurement was blocked because the model-free stand-in looked for a flat 3x3 floor, and warped-forest ground has none. A roof two blocks above the feet also cannot be built: a block's top face above eye height cannot be clicked.
- **Solution:** A dug pocket built where the player stands: fill lower floor cells, place each roof block at head height on a temporary block that is then removed (corners before edges so the scaffold tops stay visible), dig out the floor and drop in. The result is 2 blocks high, which an enderman cannot enter, with 1-high gaps to hit its legs through. Sol's guidance got the same one-sentence tactic. Five live calibrations found each failure on real terrain (hidden top faces, a lava-sea shore, edges hiding corners).
- **Result:** Four valid 60-minute Sol low/default games from forest starts ended with 5, 4, 5 and 0 pearls (14 total, 36 endermen killed, 17 pickups, one death to a piglin that lost 3 pearls): about 17 minutes per held pearl. These are the first pearls in any game. The stationary model-free stand-in retained 2 pearls in 8 twenty-minute trials (2 deaths), about 5 times fewer than Sol, which moved between shelters. The pocket does not stop piglins (they fit in 2-high cells), and forest starts wear no gold. Luna low games: see the report. Details: `reports/d39-warped4.md`.

## Nether footing and complete fire exits (claude/d39-netherfire)

- **Problem:** Recorded Nether deaths include a walking body stepping onto hanging vines above an unknown drop, lava escape rising in place toward a remembered cliff-top landing, and fire exits reporting success while the body still overlaps a neighbouring flame.
- **Solution:** Check unknown drops while moving and distinguish hanging handholds from landings. Armed lava escape can retrace recently walked dry footing and swims toward shore; armed fire escape walks fully into its exit cell, checks contact again, and reports remaining burning.
- **Result:** Build and core verification passed 2,577,419 assertions; contracts passed 639 checks. The coordinator suite has the 11 known platform-dependent failures. These are software gates, not survival measurements. Paired Minecraft replays, travel pace and four 90-minute Sol games remain unverified while awaiting Mini PC live slots. Desktop work was stopped at the orchestrator's request.
