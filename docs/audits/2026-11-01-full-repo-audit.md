# Full repository audit, 2026-11-01

A read-only audit of the whole repository, looking for enhancements: bugs, security and privacy gaps, performance hotspots, reliability, cost, test coverage and maintainability. No source code was changed. This document is the only output.

## How this was done

The repo was split into six areas and each one was reviewed by reading the code, not by pattern-matching:

1. Coordinator provider, process, transport, scheduling and voice layer
2. Coordinator game logic, ArenaScript, protocol and model context
3. Java server: bridge, journal, supervisor, executor, perception
4. Java controllers, reflexes, mixins, client, resources, voice addon
5. Build, CI, scripts, docs and repo hygiene
6. Benchmarks, decision-eval, pricing and spend gates

The most important findings were re-checked by hand against the code before going into this report. Items checked that way are marked **(re-verified)**. Line numbers are from commit `5d21746`.

### Baseline measurements (Linux, Node 22.23.4, this container)

| Suite | Result | Time |
|---|---|---|
| `npm run test:contracts` | 658 / 658 pass | 4 s |
| `npm run test:portable` (what Linux CI runs) | 476 / 476 pass | 12 s |
| Full coordinator suite (`node --test`) | 7165 tests: 6906 pass, **12 fail, 170 cancelled**, 77 skipped | 2 min 57 s |
| `python -m unittest scripts.maps.tests.test_map_tools` | 60 tests, 23 errors (needs `powershell`), 3 skipped | |

The Java build was not run here. It needs the third-party JARs and a Minecraft download.

---

## Top 15, in priority order

These matter most across the whole repo. The details are in the area sections below.

| # | Severity | Area | Finding |
|---|---|---|---|
| 1 | High | Privacy | The "clean public snapshot" still leaks the maintainer's machine layout: **136 tracked files** contain the maintainer's Linux home path. There are also host aliases (machine names in eval JSON and `scp` commands), private harness scripts (`slot.sh`, `fix-slot.sh`) and Windows user-profile paths. Most are in `evals/`, `scripts/quality/`, `docs/live-qa/`, `reports/` and `coordinator/test/contracts/claims.json`. **(re-verified)** |
| 2 | High | Release | The install guide shipped in the ZIP (`docs/distribution/README.md:9-11`) tells users to install Minecraft **26.1.2** and Fabric Loader **0.19.3**. The mod declares `~26.3` and `>=0.20.1` (`fabric.mod.json:26-27`). Anyone following the guide gets a mod that refuses to load. README.md:3 and :272 are also stale. **(re-verified)** |
| 3 | High | Security | On Windows, `spawnOwnedProcess` base64-encodes the **entire provider environment** (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, ...) into the PowerShell `-CommandJson` argument (`coordinator/src/child-process-lifecycle.mjs:17-20`). Command lines end up in event 4688, Sysmon and EDR logs. The wrapper already gets the same variables through `env`. **(re-verified)** |
| 4 | High | Reliability | The action journal checks every saved entry against the *current* argument schema on load (`DurableActionJournal.java:886-889`), and any failure marks the whole journal `ACTION_JOURNAL_CORRUPT`. The first mod update that renames an action or tightens a range leaves that world's automation offline for good. The bridge retries every 30 s forever, and restarting does not help. **(re-verified)** |
| 5 | High | Reliability | The model notebook's recovery list only grows. `CANCELLED_BEFORE_DISPATCH`, `DISPATCH_NOT_SENT` and disconnect-unknowns are never resolved, and past 1024 entries `#bound` throws on *every* mutation (`model-notebook.mjs:207-238`). Because `recordDispatch` is the write-ahead step before every action, a long-lived agent eventually can't act until its file is deleted. **(re-verified)** |
| 6 | High | Gameplay | ArenaScript throws `UNKNOWN_MEMBER` on any missing key (`interpreter.mjs:532`). The observation adapter only includes `hazard`, `fireTicks`, `lavaFlow`, `lastAttacker` and similar fields while they apply, so a watcher like `player.state().hazard === "lava"` **kills the program at install or on the first quiet tick**. There is no guard syntax (`??` is evaluated after the throw, and `in` and `?.` are banned). **(re-verified)** |
| 7 | High | Performance | `discoverAntigravityCatalog` is `async` but calls `spawnSync(agy models, 15 s timeout)` (`provider-catalog-discovery.mjs:36`). That freezes the whole coordinator (bridge, MCP, voice, all 16 agents) at startup and on every "Rescan". On Windows, a similar `spawnSync(powershell Get-AppxPackage)` can happen on every Codex transport start. **(re-verified)** |
| 8 | High | Performance | While a bow draw is held and the target is blocked, `ServerRangedUseController.java:325,337` eagerly builds `RangedShotCheck.clearTargets(...)` **every tick**. That is a 128-block entity scan plus a raycast and a 200-step ballistic solve per visible entity, and the text is only used if the hold times out. **(re-verified)** |
| 9 | High | CI | Linux CI runs only `test:portable` (12 of about 431 test files). On Linux, the full suite has 12 failures and 170 cancellations. Most of the cancellations come from one file, `native-tool-runtime.test.mjs`: its guard timers are `.unref()`'d, so when the code under test waits on nothing that holds the event loop open, Node exits mid-test and cancels the rest of the file. The same code resolves normally once the loop is held open (reproduced outside the runner). **(re-verified)** |
| 10 | Med | Cost | The token price tables are copied **six times** and disagree with each other and with list prices. `call-cost.mjs` and `decision-eval/pricing.mjs` charge Opus 5.5, Sonnet 5.5 and Fable 5.1 the same $2 in / $20 out. List prices are Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10, Fable 5.1 $10 / $50. So budgets in "USD" are not list dollars, and Fable is under-priced 5x on input. **(re-verified against the current Claude pricing reference)** |
| 11 | Med | Security | The Claude MCP bearer token is passed in argv (`--mcp-config '{"headers":{"Authorization":"Bearer ..."}}'`, `claude-service.mjs:786`). On Linux, `/proc/<pid>/cmdline` is world-readable, and that token is the only auth on the loopback tool server, so any local process can drive that agent's body. OpenCode already does this correctly with a 0600 temp file. **(re-verified)** |
| 12 | Med | Protocol | `claude-tool-server.mjs:94` answers any dispatch exception with `rpcError(null, -32700)`. A null id means Claude Code can't match the error to its request, so the call hangs until `MCP_TOOL_TIMEOUT_MS` (10 min) or the turn lease expires. **(re-verified)** |
| 13 | Med | Statistics | Several quality gates report PASS or "certified" when the test has no power. The deaths, completion and progress guards use a sign test at a fixed alpha of .05, which **can't fire with 4 or fewer discordant pairs**, but a run counts as conclusive at n >= 3 (`quality-metrics.mjs:408-463`). "P95" latency at n = 5 is just the maximum (`latency-acceptance.mjs:6`). **(re-verified)** |
| 14 | Med | Ops | The coordinator restart budget never runs out. `RestartBudget.recordUnexpectedExit()` always returns `true` (`CoordinatorLaunchPolicy.java:19-22`), so a deterministic crash restarts every 30 s forever, and the `COORDINATOR_RESTART_EXHAUSTED` message in `CodexAgentServerRuntime.java:526` can never appear. **(re-verified)** |
| 15 | Med | Performance | The Watcher diagnostics are **on by default** in production (`Watcher.java:137`). Per agent, they run entity and block scans every 2 to 5 ticks and write JSONL synchronously on the server thread with no rotation. Journal fsync (up to 2 per tick) and compaction also run on the server thread. **(Watcher default re-verified)** |

Licensing (`LICENSE` is "All rights reserved" on a public repo, and the ZIP has no third-party notices) is covered in area 5.

---

## 1. Coordinator: provider, process, transport, scheduling, voice

Most of this layer is well hardened. It has bounded JSONL decoding, epoch and generation fencing, HMAC-signed voice requests with nonce replay protection, bounded HTTP bodies and owner-only DACLs. The problems cluster in a few places.

| Sev | Where | Finding | Fix | Effort |
|---|---|---|---|---|
| High | `provider-catalog-discovery.mjs:36-37`; `codex-app-server.mjs:146,218` | `spawnSync` in async paths blocks the event loop for up to 15 s (see Top 7). | Async `spawn` with `stdio: ['ignore','pipe','pipe']`. For Codex, use the existing async `discoverCodexWindowsPackageLocations`. | S |
| High | `child-process-lifecycle.mjs:17-20`, `owned-windows-job.ps1:199-205` | Provider secrets go into the Windows command line (see Top 3). | Build the child env inside the script from its own env, or pass the JSON over stdin or a 0600 temp file. | M |
| Med | `claude-service.mjs:786,1870` | Bearer token in argv (see Top 11). | Write `--mcp-config` (and `--settings`) to a 0600 file, as OpenCode does. | S |
| Med | `antigravity-service.mjs:20,486-499` | The whole planner prompt is one argv element. On Linux there is no guard against `MAX_ARG_STRLEN` (128 KiB, gives E2BIG). On Windows the 24k-char guard is too loose after base64 and JSON growth, so prompts of roughly 18 to 24k chars fail with a confusing spawn error. Prompts are also visible in process listings. | Send the prompt on stdin or via a file, or check the final command-line length. | S-M |
| Med | `voice/local-speech-provider.mjs:144-157,214-226` | One aborted or timed-out speech request kills the whole Python worker and throws away the loaded Chatterbox and Whisper models. Cancelling a request that is merely queued also kills the one in flight. | Add a `cancel` op to the worker. Kill only on a hard timeout. | M |
| Med | `posix-process-wrapper.mjs:7,60-66`; `dynamic-main.mjs:633-716,4867-4876` | `coordinator.stop()` has no overall deadline, while the POSIX wrapper SIGKILLs the group after 2 s, so trace, provider-turn and audit tails are lost. If `stop()` rejects, voice and audit close are skipped and the rejection is unhandled. | One deadline for the whole stop (about 1.5 s), staged with `allSettled`, closing the sinks in a `finally`. Have the wrapper signal the coordinator first. | S-M |
| Med | `child-process-lifecycle.mjs:16,105-118` | On POSIX, providers aren't spawned `detached` and only the direct child is signalled. npm shims (`codex`, `opencode`) can leave the native server orphaned. Windows uses job objects, so the two platforms behave differently. | `detached: true` and signal `-pid`, reusing `posix-process-group.mjs`. | S-M |
| Med | `claude-tool-server.mjs:93-95` | Null-id MCP error (see Top 12). | Keep `message.id` and use -32603, or return an `isError` tool result. | S |
| Low-Med | `voice/voice-http-server.mjs:141-150,843-866` | The body-read deadline is 120 s and pre-auth slots are capped at 5, so any local process can hold 5 trickling connections and starve real voice requests (429). | Short separate body deadline (about 2 s for TTS). Optionally check the MAC on headers first. | S |
| Low-Med | `codex-app-server.mjs:139-142,188-207` | The cached desktop `codex.exe` is preferred before the installed package is checked, so the coordinator keeps running a stale binary after a Codex update. | Compare against the registered package version and prune old copies. | S |
| Low | `claude-service.mjs:801-805,2184`; `opencode-service.mjs:809`; `diagnostic-sanitizer.mjs:6-17` | Claude and OpenCode keep the *first* N bytes of stderr, so after hours of running the exit message shows startup chatter. Claude's `excerpt()` doesn't redact. The sanitizer misses bare `sk-...`, `sk-ant-...` and `AIza...` tokens. | Ring-buffer tail, `sanitizeDiagnosticText`, token-shape patterns. | S |
| Low | `dynamic-main.mjs:183-253,781-835` | Per-agent state is spread across about 55 Maps and Sets, and about 35 are cleaned up by hand on removal. `#healWakes` and `#perceptionSequences` are never deleted. | One `AgentRuntimeState` per agent with a single `dispose()`. | M |
| Low | `rotating-jsonl-sink.mjs:52-77` | `stat` plus open, append and close on every row. On Windows, a rename failure during rotation (EBUSY) makes every later append throw, so that trace is dead for good. | Track size in memory, keep a stream open, degrade on rotation failure. | S |
| Low | `acp-transport.mjs:21-189`, `active-goal-supervisor.mjs`, `child-process-lifecycle.mjs:91-103` | Dead or test-only code in production modules. | Delete, or move to test-support. | S |
| Low | `capture-shutdown.mjs:14-19`; `private-artifact-permissions.mjs:34-36,113-118` | A transient read error aborts a graceful capture stop. `whoami.exe` and the PowerShell ACL repair have no timeout. There is an lstat-then-open TOCTOU. | Retry, add timeouts, `fstat` the open handle. | S |
| Low | `voice/windows-tts-provider.mjs:85-140` | A fresh `powershell.exe` and System.Speech load per utterance (estimated 0.5 to 1 s each). | Persistent worker reading from stdin. | M |

**Splitting `dynamic-main.mjs` (7,908 lines).** These seams are listed easiest first, and together they would bring the class down to roughly 2.5k lines:

- voice bootstrap (lines 4897-5716) to `voice/bootstrap.mjs`
- `createJsonlAudit` to `protocol-audit.mjs`
- CLI and config parsing (4693-4838) to `dynamic-config.mjs`
- the pure event-input and observation-compaction functions (5853-7890, about 2k lines) to `native-event-input.mjs`
- the 700-line `#bindBridge` to a dispatch table
- native wake, steer and survival control to `native-wake-controller.mjs`
- the provider plan loop to its own module

---

## 2. Coordinator: game logic, ArenaScript, protocol, model context

The ArenaScript sandbox held up against every escape tried: recursion via function values, closure mutation of loop counters, computed and optional member access, `typeof`, `delete`, `in`, template literals, labelled statements, unbounded loops and exponential arrays. The JS and Java action field lists match. The real issues are in fact semantics, diagnostics and context size.

| Sev | Where | Finding | Fix | Effort |
|---|---|---|---|---|
| High | `model-notebook.mjs:207-238` | Recovery list grows until it reaches the 1024 hard cap, then bricks the agent (see Top 5). | Record `CANCELLED_BEFORE_DISPATCH` as terminal. Age out or summarize UNKNOWN entries. Evict instead of throwing. | S-M |
| High | `arena-script/interpreter.mjs:532`, `observation-adapter.mjs:48-56` | Optional facts crash watchers (see Top 6). | Missing keys on fact records return `undefined` (keep the throw for capability objects), **or** normalize optional facts to `null`, **or** treat a condition error as false plus a model notification. | S |
| Med | `interpreter.mjs` `#run` catch; `native-program-executor.mjs:1058` | Runtime errors reach the model as just "ArenaScript EXECUTION_ERROR: execution failed". The real message ("origin requires finite coordinates", ...) is only in `cause`. The model retries blind, at a full turn's cost each time. | Convert `facts.mjs` TypeErrors to `ArenaScriptError` with step location, or append a bounded `cause.message`. | S |
| Med | `interpreter.mjs:1208` (`addOperands`) | `"health " + player.state().health` fails with "arithmetic requires finite numbers". String + number isn't allowed, the API reference doesn't say so, and there's no `String()`. Routines die at their first status message, after real actions have already run. | Allow string + finite number within the 4096-byte cap. | S |
| Med | `native-minecraft-tools.mjs:92,124-125,383-401`; `native-tool-runtime.mjs:1166,1373,1637` | `noteKey` and `standing.template` are "never use" in the instructions, SKILL.md and control reference, yet still live in the schemas and runtime. The runtime even executes a saved note's text as program source. | Remove from the schemas and reject at normalization, or drop the prohibition. | S-M |
| Med | `wake-filter.mjs:14,150-166,209` | While an action runs, hits from a "known" mob kind are held until HP is 8 or less. "Known" never expires within a dimension, and hit size and rate of loss are ignored. This contradicts `danger-steer-coalescer.mjs:15-17` (notify at 14 / 10 / 6). | Wake at 14 and 10, on a single hit of 4 or more, or on a fast loss rate. Expire known kinds. | S |
| Med | Model context (measured) | Static prefix of about **70 KB (about 19-20k tokens)** per session: 30 tool schemas 32.8 KB (`act` alone 5.7 KB), AGENTS.md 19.3 KB, SKILL.md 17.1 KB. About 9 KB is phase-specific (End, Nether, pearls, excavation) and loads even in early Overworld play. `capabilities.all` (9.9 KB) repeats the `act` enum. | Gate phase text by dimension or goal, drop the duplicate enum and signature, merge the overlapping survival guidance. Estimated **4-6k tokens saved per session start**. | M |
| Low-Med | `native-wake-events.mjs:52-69`; `dynamic-main.mjs:6621-6687` | Merged wake history is unbounded and never trimmed. Measured: 1 event 5.2 KB, 20 events 14.7 KB, 50 events 27.9 KB. | Keep the first, the latest 8 and each distinct failure. Count the rest. | S |
| Low-Med | `program-precondition.mjs:11-18` | The parser diagnostic for preconditions and standing `when` is wrapped in a generic TypeError, so the location and "Fix:" hint are lost. | Surface `cause.message`. | S |
| Low | `parser.mjs:891-897` | `repeatUntil` `maxIterations` has no upper bound (literal loops cap at 1024), which inflates `progressBound()` estimates shown to the model. | Cap it. | S |
| Low | `native-tool-runtime.mjs` (7 `Date.now()` sites) | No injected clock, so simulator and decision-eval replays aren't byte-reproducible. | Inject `now`. | S |
| Low | `model-notebook.mjs:104` | Text search runs on `JSON.stringify(entry)`, so "note", "receipt" and "source" match every entry. | Search value fields only. | S |
| Low | `context-carry-over.mjs:30-41`; `codex-service.mjs` | UNKNOWN actions stay as "running" handles forever in Codex carry-over (Claude calls `invalidateHandles()`, Codex doesn't). | Treat UNKNOWN as terminal and invalidate on reconnect. | S |
| Low | SKILL.md vs AGENTS.md | One says "no default guard is installed", the other lists the default-lava, fire, air and edge reflexes (which `reflexes.mjs:20` arms). | Reword. | S |
| Low | `task-memory-store.mjs:361-363` | Task memory hard-fails at 256 entries with no eviction. | Evict the oldest entry of the same kind and report it. | S |

---

## 3. Java server: bridge, journal, supervisor, executor, perception

Bridge authentication is sound. It uses nonce-bound mutual HMAC-SHA256 with constant-time compare, loopback-only bind plus a peer check, a 64 KiB line cap, strict duplicate-key JSON, per-session dedupe, a handshake deadline and SHA-256 installer manifests. The risks are durability, IO on the server thread, threading at the edges, and how failures are reported.

| Sev | Where | Finding | Fix | Effort |
|---|---|---|---|---|
| High | `DurableActionJournal.java:886-889,509-512` | Schema-coupled journal recovery bricks the world after an upgrade (see Top 4). A single torn frame does the same. | Recover identity fields only (entries are never replayed). Version-stamp the file. Quarantine to `.corrupt-<ts>` and start fresh. | M |
| Med | `MultiplexedServerBridge.java:541-548`; `DurableActionJournal.java:640-642,414-463` | fsync (up to 2 per tick with 16 agents) and periodic compaction run on the server thread. NTFS FlushFileBuffers often takes 2-20 ms (estimate). | Group-commit on a journal thread. The executor already holds non-durable acceptances, so release them from the callback. | M-L |
| Med | `MultiplexedServerBridge.java:1250-1253,2851-2853` | The handshake reads `PlayerList` and live inventory from the bridge reader thread. That risks torn state or a CME that aborts the handshake. | Compute it in `captureHandshakeSnapshot`, which already runs on the server thread. | S |
| Med | `watch/Watcher.java:137-145,347-379,719-722` | On by default, with world scans per agent and synchronous, unrotated JSONL writes (see Top 15). | Default off in release builds. Use a background appender with rotation. | S-M |
| Med | `CoordinatorProcessSupervisor.java:1038-1041,1153` | The real launch failure is thrown away and replaced with "Could not start the Arena Agents coordinator". | Pass the cause through and log the throwable once per distinct cause. | S |
| Low-Med | `CoordinatorProcessSupervisor.java:1794`; `CoordinatorLogRotation.java:24-33` | A rotation `Files.move` failure (Windows lock) blocks launch. Logs only rotate at launch, so they grow without limit during long runs. | Warn and continue. Rotate by size. | S |
| Low-Med | `CoordinatorLaunchPolicy.java:18-31` | The restart budget is infinite and `COORDINATOR_RESTART_EXHAUSTED` is unreachable (see Top 14). | Terminal state after N failures, plus an operator retry command. | S |
| Low-Med | `MultiplexedServerBridge.java:4755,1231-1233` | No idle timeout after auth, and a new hello is rejected with `SESSION_ACTIVE`, so a hung external coordinator holds the session forever. | Idle timeout, or let a freshly authenticated hello take over. | S |
| Low | `MultiplexedServerBridge.java:217-218,466,2806` | `protocolKnownAgentIds` and `coordinatorReadyAgentIds` are plain HashSets read without the lock on the server thread. | `ConcurrentHashMap.newKeySet()`. | S |
| Low | `MultiplexedServerBridge.java:1038-1039` | 8 pre-auth slots with a 5 s deadline can be squatted by any local process at about 1.6 conn/s. | Two-stage deadline: require `auth_challenge` within about 500 ms. | S |
| Low | `MultiplexedServerBridge.java:563-569` | Protocol exceptions in server tasks are only logged, never reported to the coordinator. The real cause is then hidden behind `COORDINATOR_STATUS_TIMEOUT`. | Reply `protocol_error` or close with a code. Rate-limit the logs. | S-M |
| Low | `CodexAgentServerRuntime.java:248,267-335,1523-1612` | Small file IO on the server thread (secret stat every tick, re-hash every second, config JSON parsed twice every 5 s). | Move to the maintenance thread. | S |
| Low | `CodexAgentManager.java:1985-2021` | UUID lookups iterate every entity in every level. | `ServerLevel.getEntity(uuid)` plus an index. | S |
| Low | `protocol/ProtocolCodec.java` | The legacy v1 line codec is unused in production (only `validateActionArguments` is used), and its parser accepts duplicate keys. | Extract `ActionArgumentValidator` and delete the rest. | S |
| Low | `CoordinatorProcessSupervisor.java:2245-2252`; `NodeRuntimeLocator.java:101-131` | About 260 coordinator files are re-hashed every 5 s, but the launched `node.exe` is never hashed. | Stat fast path. Add Node to the manifest. | S-M |
| Med (maint.) | `MultiplexedServerBridge.java` (4,866 lines), `ServerActionExecutor.java` (4,389 lines) | God classes. | Bridge: `BridgeTransport`, `HandshakeCoordinator`, `ObservationPublication` (already nested), `CatalogSync`, `CoordinatorStatusDecoder`, `ActionAdmission`, `ConversationPublisher`. Executor: `ActiveAction` (about 1.4k lines) with per-type strategies, `PlacementSelection`, the respawn pipeline. | L |

---

## 4. Java controllers, reflexes, mixins, client, resources, voice addon

Checked and found sound: takeover and spectate payloads (session id plus an op check on every payload), op-gated Director and scenario receivers, `set_flight`, action timeouts, client/server separation (no `net.minecraft.client` in `src/main`), and lang key completeness.

| Sev | Where | Finding | Fix | Effort |
|---|---|---|---|---|
| High | `ServerRangedUseController.java:325,337`; `RangedShotCheck.java:211-222` | The per-tick bow-aim diagnostic scan (see Top 8). Estimated about 6,000 clips per tick near 30 entities, for up to 600 s. | Keep a code plus a supplier and build the text once at `finish`. Cap to the 5 nearest. | S |
| Med-High | `ServerRetraceController.java:35-48`; `ServerActionExecutor.java:3248-3256` | Cross-dimension retrace can never succeed. The executor cancels on any dimension change (it only exempts portal navigation). Inside the controller, `portalLeg` is never reset, `index` never advances, and `get(index-1)` can throw at index 0. | `crossesDimensions()` hook on the controller, reset the leg, guard the index. | M |
| Med | `AgentControlSync.java:129-132,390-420`; `AgentControlSnapshot.java:214-236` | Any modded client, even non-op, can spam `AgentControlRequestPayload` and receive every agent's prompt, summary, last error and voice profile. `canControl` is computed but nothing is redacted. **(re-verified: no rate limit or permission check on the receiver)** | Per-player rate limit, cache per revision, redact when `!canControl`. | S |
| Med | `src/client/resources/arenaagents.client.mixins.json` | `required: true` and `defaultRequire: 1` for cosmetic render mixins (an `ordinal=0` ModifyArg, `method = "*"`, 30+ wraps). One moved call site in a Minecraft update and the whole client won't start. | Second config with `require = 0` for cosmetic hooks, disabling the feature when one fails to apply. | S-M |
| Med | `EntityPlayerActionPackMixin.java:68`, `EntityPlayerMPFakeMixin.java:46,71`, `MsgCommandMixin.java:22` | `@Redirect` on Carpet internals and vanilla chat is exclusive, so it conflicts with any other mod redirecting the same call. | MixinExtras `@WrapOperation` (already used elsewhere). | S |
| Med | `LevelChunkMutationRevisionMixin.java:36-56`; `WorldMutationRevisions.java:47-54` | Every `setBlockState` goes through a `synchronized` boxed `LinkedHashMap<Long,Long>`, and each chunk keeps a `LongOpenHashSet` of up to 4,096 positions (about 64 KB). | fastutil `Long2LongLinkedOpenHashMap`, a server-thread assertion instead of the lock, a per-section bitset. | M |
| Med | `voice-addon/.../fabric.mod.json` | Depends on `arenaagents >=0.1.0` but imports internals and carries reflection shims for old versions. A mismatched pair gives `NoSuchMethodError`. | Pin `=${version}`. Delete the shims. | S |
| Low-Med | `ServerDigController.java:328-347` | A `stopWhenSeen` sighting made while falling is dropped (it's only sampled every 20 ticks and ignored while airborne). | Remember it and report it on the first grounded tick. | S |
| Low-Med | `ServerTravelController.java:330-345` | `ClipContext.Fluid.ANY` stops sight lines at water. That means 91 rays of 96 blocks every second, with `toString()` compares. | Lava-only fluid filter, `Block` identity compare, smaller fan. | S |
| Low-Med | `camera/CameraDolly.java:73-84` | Any player who can build can shift-use to delete op-placed cameras. | Require `mayControl`, or store an owner UUID. | S |
| Low-Med | `reflex/ReflexEngine.java:243-262` | Reflex sensors (some raycasting up to 96 blocks) are recomputed per rule per tick, up to 16 rules x 8 conditions. | Cache each condition's reading per tick. | S |
| Low | `PovSessionRuntime.java:445-453` | Walks about 1,500 registry items every 20 ticks per takeover. | Count from `ItemPickupReceiptMixin`. | S |
| Low | `MinecraftNavigationWorld.java:57,98` | `states` and `cells` grow for the controller's lifetime (up to 600 s). | LRU cap. | S |
| Low | `en_us.json`; `CameraDirectorClient.java:63` | About 35 unused legacy lang keys. One keybind is in `Category.MISC`. | Clean up. | S |
| Low | `client.navigation` package | Common code under a `client` package name. | Rename to `navigation`. | M |
| Low (maint.) | Controllers | Input lease, release and health-drop logic is duplicated across Travel, Dig, Navigation and LedgeFetch. `ServerRetraceController` uses a dense one-line style. | Abstract controller base with lease, deadline, finish and `crossesDimensions()`. | M |

---

## 5. Build, CI, scripts, docs, repo hygiene

Already good: `gradle/verification-metadata.xml` (650 sha256 entries), STRICT dependency locking, a wrapper `distributionSha256Sum`, `fetch-libs.sh` with `set -euo pipefail` and sha256 checks, `$ErrorActionPreference='Stop'` in the CI scripts, no real secrets found, and `docs/technical-catalogue.md` exists as AGENTS.md requires.

| Sev | Where | Finding | Fix | Effort |
|---|---|---|---|---|
| High | `evals/`, `scripts/quality/**`, `docs/live-qa/`, `reports/`, `coordinator/test/contracts/claims.json` | Leaked local paths, host aliases and private harness references (see Top 1). `evals/` alone is 270 files and 7.6 MB that no code imports. | Scrub to placeholders (`$ARENA_LAB_ROOT`) or move out of the repo. Run `npm run contracts:refresh`. Add a CI denylist grep for `/home/[a-z]`. The repo is one commit, so a real scrub means rewriting and force-pushing it; otherwise the old content stays reachable. That is your call. | M |
| High | `docs/distribution/README.md:9,11`; README.md:3,272 | Wrong Minecraft and Fabric Loader versions (see Top 2). | Fix now. Generate the lines from `gradle.properties` at package time, or assert in `verify-windows-distribution.ps1`. | S |
| High | `.github/workflows/reliability.yml` | Linux runs about 10% of the coordinator suite (see Top 9). | Run the full `npm test` on ubuntu with explicit `skip: process.platform !== 'win32'` on Windows-only tests. Fix the `.unref()` guard timers in `native-tool-runtime.test.mjs` first. | M |
| Med | `LICENSE`; release ZIP | "All rights reserved" on a public repo, so nobody can legally fork or contribute. The ZIP ships Fabric API (Apache-2.0), Carpet (MIT), Simple Voice Chat, `node.exe` and acorn with no notices. | Choose a license. Add `THIRD-PARTY-NOTICES.md` (including Node's LICENSE) to the JAR and ZIP. Confirm SVC's redistribution terms. | S-M |
| Med | `NOTICE-FONTS.md:14-16`, `ScenarioParkourCourse.java:17-18`, `MAP-SOURCES.md:43-56`, `maps/source-ledger.json` | The Thinking Tower attribution contradicts itself: "adapted from New Year Parkour" (CC variant not stated) vs "original geometry", and the map is missing from the machine-readable ledger. | Settle on one account. Add a ledger entry with the exact CC variant. | S |
| Med | `reliability.yml` | No `timeout-minutes` and no `concurrency` cancellation, while the Windows `npm test` allows 15 min **per test**. | `concurrency: {group: ${{github.workflow}}-${{github.ref}}, cancel-in-progress: true}`, job timeouts of 30-60 min, a lower per-test timeout. | S |
| Med | `reliability.yml` | Actions pinned by major tag (`@v4`, `@v5`), no Dependabot, no Gradle wrapper validation, CI Node `'22'` vs bundled 22.23.2. | SHA pins plus `.github/dependabot.yml` (actions, npm, gradle), `gradle/actions/wrapper-validation`, exact Node version. | S |
| Med | Repo-wide | No lint or static analysis: no ESLint for about 460 `.mjs` files, no PSScriptAnalyzer for about 70 `.ps1`, no shellcheck, no CodeQL. | Cheap Linux lint job. A rule banning `*Sync` process calls in `coordinator/src` would have caught Top 7. | M |
| Med | `build.gradle:386,420,470,553,615-619` | `verifyHowtoIndex`, `verifyDirector`, `verifyShippingCore` and `verifyLiveWindows` exist but nothing runs them, so `howto-index.json` can drift. | Wire them into `check` or the Windows job. | S |
| Med | `scripts/quality/**`, `scripts/feel/collect.sh`, `evals/*/*.sh`, `scripts/replay-activity-feed.sh:6` | About 60 scripts depend on the omitted harness (`slot.sh`, SSH aliases, the maintainer's home path, a fixed JDK path). Several lack `set -e`. | Delete, or move to `tools/lab/` with a README of requirements and env-driven paths. | M |
| Med | `scripts/prepare-runtime.ps1:4,24,95` | Takes `-SourceWorld` but then asserts it equals `New World (76)`, so the documented source-checkout setup only works on the maintainer's machine. | Honor the parameter, or generate a fresh world. | S |
| Med | README, repo root | `install-toolchain.ps1` is never mentioned, there's no Linux or macOS quick start (CI proves `fetch-libs.sh && ./gradlew verifyCore && npm ci && npm test` works), and there's no CONTRIBUTING, SECURITY, PR template or CODEOWNERS. A PR template is the natural home for the AGENTS.md catalogue rule. | Add them. | S-M |
| Med | `scripts/maps/tests/test_map_tools.py` | 23 of 60 tests error on Linux (no `powershell`). | Skip when it's missing, or use `pwsh`. Run in the Linux job. | S |
| Low-Med | `coordinator/test/fixtures/decision-eval/` (about 70 MB), `claims.json` (2.8 MB), `reports/` (6.5 MB), `maps/registries/*block-states.json` (3 MB, regenerable) | Heavy checkout. `warped-provider-stall.test.mjs:3` imports from `evals/`. | Gzip the fixtures (about 7.5x smaller) or use LFS. Move `provider-stall.mjs` to `test-support/`. | M |
| Low-Med | `src/test`, `build.gradle:416-418` | No JUnit. 265 custom `*Verification` mains with `failOnNoDiscoveredTests = false`, so there's no per-test report and the run stops at the first failure. | Emit JUnit XML, or wrap them as dynamic tests. | M |
| Low | `headless-cli.test.mjs` and related | Creates a literal `coordinator/C:/runs/...` directory on Linux (hidden by `.gitignore:61-62`). `owned-process-job.test.mjs:165-171` is Windows-only without a skip and has a `'C:\fake-bin'` `\f` escape bug. | `mkdtemp` or `path.win32`. Add the skip and fix the escape. | S |
| Low | `coordinator/package.json` `test` | No glob, so about 30 helper and fixture modules run as tests. | `node --test "test/**/*.test.mjs"`. | S |
| Low | `server-template/README.md:11,18`; `libs/README.md:9,15`; `scripts/decision-eval/README.md:310-370`; `decision-eval/stats.mjs:3`; `PROJECT_LOG.md` | Docs describe the private repo (tracked libs, a removed workflow, `arena-quality-research/`). The log stops at 2026-10-06. | Update. | S |
| Low | `scripts/fetch-libs.sh` | No `shasum -a 256` fallback for macOS. Downloads straight to the final name and skips existing files, so an interrupted download stays corrupt. No `--proto '=https'`. No CI cache. | Temp file plus rename, fallback, cache keyed on `checksums.sha256`. | S |
| Low | `.gitattributes` | Only 3 LF rules. Nothing pins `*.sh`, `gradlew` or `*.sha256` to LF, though Windows CI runs `fetch-libs.sh` via Git Bash. | Add `* text=auto`, `*.sh`, `gradlew` and `*.sha256` as `eol=lf`, `*.ps1` as `eol=crlf`. | S |

---

## 6. Benchmarks, decision-eval, pricing, spend gates

Checked and found sound: `decision-eval/stats.mjs` (exact conditional CMH, Holm adjustment, Wilson interval), the `SpendLedger` file lock with atomic rename, the strict Anthropic gateway (synchronous admit and settle), the counterbalanced AB/BA pilot, and the t table.

| Sev | Where | Finding | Fix | Effort |
|---|---|---|---|---|
| High | `benchmark/quality-metrics.mjs:408-463,479-485` | Sign-test guards can't fire at n of 4 or less, yet the verdict can PASS. The "zero tolerance for deaths" in the method text isn't what the code does (see Top 13). | Literal zero tolerance on aggregate deaths and completions, or `INCONCLUSIVE` while 0.5^n >= alpha. | S |
| High | `benchmark/latency-acceptance.mjs:6,57,148,165` | "P95 speedup" at n = 5 is max vs max with no uncertainty, yet it sets `claimCertified`. | n >= 20 before calling it p95, and gate on a bootstrap CI of the ratio (as `paired-analysis.mjs` does for means). | M |
| Med-High | `quality-metrics.mjs:165,347` | v1 deaths aren't windowed to the goal, and the counter fallback is absolute, not a delta. The guards use v1 even though v2 has the corrected count. | Base the guards on `qualityV2.deathEvents`. | S |
| Med | `call-cost.mjs:3-16`, `decision-eval/pricing.mjs:9-22`, `spend-gate.mjs:81-84`, `handoff-budget.mjs:1`, `scripts/context-cost-replay.mjs:7`, `scripts/quality/context-rotation-sim.mjs:17` | Six price tables (see Top 10). The two main files also disagree on `opencode-go/deepseek-v4.1-flash` cache write, and `glm-5.3-flash` is missing from `call-cost.mjs` (null cost). STRICT_PRICES has Sonnet 5.5 cache read at 0.1, but the list price is 0.20. | One pricing module with separate `list` and `proxy` columns. Gates use list prices. Add a test that the tables agree. | M |
| Med | `scripts/decision-eval/run.mjs:77-81,287-300`; `decision-eval/runner.mjs:104,114`; `eval.mjs:216,274`; `compare.mjs:73-74` | `--budget-usd` is check-then-spend. Unknown model cost counts as $0. Any ledger read error reads as $0 spent. The judge's $5 cap is per family per stage and sits outside the budget. | Reserve the worst case per sample. Refuse unpriced models. Only ENOENT reads as 0. Put the judge in the same ledger. | M |
| Med | `decision-eval/judge.mjs:284-287` | The judge cap reserves in-flight calls at the running mean (or $0.05 before the first call finishes), so it can overshoot by about 6 x (real - mean). | Reserve the worst case from prompt bytes plus max output. | S |
| Med | `decision-eval/judge.mjs:89-94,229-244,395-399,536-541` | Player-authored text (program comments, chat) reaches the judge verbatim, so a model under test can address the grader. Parsing only strips a fence that wraps the whole output, so prose before the JSON means "ungraded". | Strip or fence free-text fields. Extract the first balanced `{...}`. Log the raw text on failure. | M |
| Med | `benchmark/paired-analysis.mjs:100-119,160-166` | Timed-out (censored) trials stay in the latency deltas. The mean of percent deltas is biased (+100% and -50% average to +25%). Success-rate difference has no CI or McNemar test. | Report passed-only deltas, use log ratios, add McNemar or Wilson. | M |
| Low-Med | About 20 private percentile helpers | Three different definitions, and some return NaN or undefined on empty input. Decision-eval p50 and p95 aren't comparable with benchmark reports. | One shared stats module. | M |
| Low-Med | `quality-metrics.mjs` vs `quality-metrics-v2.mjs` | Diverged copies of the food regex, unreachable codes and low-health logic. Both appear in comparisons under the same names. | Shared predicates. Mark v1 as legacy. | M |
| Low | `coordinator/scripts/dispatch-latency-benchmark.mjs`, `render-routine-bytes.mjs`, 9 benchmark modules | Dead (zero references) or unreferenced by any script or test. | Delete, or add `benchmark:*` scripts plus a smoke test. | S |
| Low | `decision-eval/stats.mjs:122-134,225-227` | The stratified exact test can blow up: an lcm of variant counts 1-10 is 2520, so the arrays reach millions of entries. | Sparse convolution or a small common denominator. | S |
| Low | `codex-usage-mirror.mjs:117-125` | One `appendFile` error silently disables the usage mirror for the rest of the process. | Log once and retry. | S |

---

## Suggested roadmap

**This week (all S, high value):**
1. Fix the version strings in `docs/distribution/README.md` and README.md, and assert them in packaging.
2. Stop putting secrets in argv or command lines: the Windows `-CommandJson` env and the Claude `--mcp-config` token.
3. `claude-tool-server.mjs`: keep the request id on errors.
4. Async `agy models` and Codex package discovery.
5. Make the bow-aim `clearTargets` text lazy.
6. ArenaScript: missing fact keys become `undefined`/`null`, string + number works, the real error messages reach the model.
7. Model notebook: don't journal `CANCELLED_BEFORE_DISPATCH` as unknown, and evict instead of throwing.
8. Watcher off by default. Finite restart budget.
9. CI: `concurrency`, `timeout-minutes`, fix the `.unref()` timers in `native-tool-runtime.test.mjs`.
10. Rate-limit and redact the agent control snapshot.

**Next (M):**
- Version and quarantine the action journal, and move fsync off the server thread.
- Run the full coordinator suite on Linux.
- Add a lint job with a no-`*Sync` rule and a path/identity denylist.
- One pricing module at list prices, and worst-case reservation on every paid path.
- Statistical floors (n) on every gate.
- Phase-gated agent instructions (about 4-6k tokens saved per session).
- Licensing and third-party notices.

**Then (L, maintainability):**
- Split `dynamic-main.mjs`, `MultiplexedServerBridge.java` and `ServerActionExecutor.java` along the seams above.
- Shared controller base class.
- A single per-agent state object in the coordinator.
- Move the lab material (`evals/`, `reports/`, lab scripts, big fixtures) out of the product tree.
