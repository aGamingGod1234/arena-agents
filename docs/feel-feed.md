# Teammate activity feed

The Java server's `AgentChatReporter.acting/result` produced the spam. Unknown non-success results became “needs attention”; distinct error texts bypassed the old 10-second throttle. The installed [Chat Patches](https://github.com/mrbuilder1961/ChatPatches) client adds `xN` duplicate counters without preventing delivery/logging.

Concise chat now publishes changed model-authored summaries and accepted intent labels/reasons. Private conversation-only replies still require `say` and its audience. Existing privacy filters, revision fences and progress/verbose toggles remain.

A shared vanilla action bar shows targets and successful-action counts to players with the existing operator control permission or the singleplayer owner, excluding agent bodies. It sends changed text and refreshes active text every 2.5 seconds. The addressed-packet hook gives other action-bar messages three seconds of priority; feed packets do not suppress themselves. Two agents keep a stable order; larger rosters rotate adjacent pairs fairly every 2.5 seconds. Completed statuses expire after five seconds; a missing result expires 30 seconds after the action began.

Path, timeout, target, placement, inventory, shield and ranged failures have short factual messages. Other announceable failures get “Couldn't finish <activity>: <plain reason>”; raw executor evidence stays in the console. The old retry-code filter still governs fallback eligibility. Successes and cancellations stay quiet by terminal state, while partial collection cannot hide a real failure. Ordinary problems share one 30-second window per agent. Disconnects, deaths, provider failures and critical events bypass that window; stopped-task messages keep a bounded, privacy-filtered reason. Health at six points or less and hunger at six points or less each warn once per danger episode, independently of routine errors. Vanilla deaths and advancements remain. Important-item acquisitions and dimension transitions are sampled each second; existing inventory establishes a quiet baseline.

All reporter mutations and broadcasts move to the owning Minecraft server thread, including bridge-thread decisions, action starts/results, notices and cleanup. The weak server map also synchronizes access across server instances. Queued decisions recheck the goal revision before appearing.

## Measured replay

`scripts/replay-activity-feed.sh <run-2/game-latest.log> [HH:mm:ss]` uses the production Java policy.

**Round 2: 1,101 → 70 messages over 40.33 minutes: 27.30 → 1.74 lines/minute, 93.6% fewer.** Includes `xN` updates, 43 retained problems from 63 failure candidates, one recovered important-item event, and vanilla deaths. Joins/leaves are outside the activity feed count. The three deaths were omitted by the round-1 replay, so its 1,098-message denominator and 0.97 lines/minute claim are superseded.

The historical chat has no reason codes or terminal states. Every non-collection “needs attention” line therefore counts conservatively as an announceable failure, including unfamiliar text, before applying the production throttle. Collection lines recover first important items. Stopped-task and disconnect lines remain visible. Missing model summaries, health/hunger transitions and inventory events cannot be reconstructed; these measurements establish routing behavior, not future live traffic.

Actual 13:40–13:42 sample: **131 → 3 chat messages**. Before excerpt, abbreviated:

```text
13:40:00 Opus: Mining a block (x33)
13:40:01 Opus: Mining a block (x34)
... repeated mining/crafting/placing ...
13:40:51 Sol: Moving to the next position needs attention: Seen path ends ... Seen obstruction: minecraft:stone ...
13:41:36 Opus: Placing a block needs attention: ... inventory slot 35, not hotbar 0-8; select_tool ...
```

After, all chat:

```text
13:40:51 Sol: Can't reach the target: blocked by stone.
13:41:29 Opus: No iron in this tunnel so far. My stone pickaxe is almost broken, so I'm crafting new ones before I keep digging.
13:41:36 Opus: Couldn't finish placing a block: the action failed.
```

Tested status: `[Sol] Mining oak log ×16`. Authored-intent test: `Gather exposed iron: The cave south has visible ore`.

Round-2 checks cover unmapped failures, timeout states, partial collection, danger episodes, severe-error bypass, stale status, fair rotation, operator-only action-bar rules, refresh timing and vanilla overlay priority. Reporter tests use Minecraft's real task queue with eight concurrent decision callers and an executor caller, then verify delivery and stale-revision rejection. Packet fixtures exercise vanilla overlay suppression and feed self-exclusion. A synthetic CLI replay checks failure counting and retained deaths. These are backend/packet fixtures, not a live visual check.

Java `export JAVA_HOME=/usr/lib/jvm/temurin-25-jdk-amd64; flock /tmp/aa/gradle.lock ./gradlew verifyCore --offline`: **2,554,251 assertions passed**, including client compilation.

Coordinator `npm test`: 6,250 passed, 12 baseline failures, 74 skipped. The failures comprise platform-dependent CLI/PowerShell checks and the existing orphaned-predicate contract check.

## Changed files

```text
coordinator/src/dynamic-main.mjs
coordinator/test/concise-feed.test.mjs
coordinator/test/failure-schema.test.mjs
coordinator/test/helpers/failure-code-sources.mjs
src/main/java/dev/agaminggod/arenaagents/server/AgentActivityPresentation.java
src/main/java/dev/agaminggod/arenaagents/server/AgentChatReporter.java
src/main/java/dev/agaminggod/arenaagents/server/AgentFeedPolicy.java
src/main/java/dev/agaminggod/arenaagents/server/CodexAgentServerRuntime.java
src/main/java/dev/agaminggod/arenaagents/server/FailureChatThrottle.java
src/main/java/dev/agaminggod/arenaagents/server/bridge/MultiplexedServerBridge.java
src/test/java/dev/agaminggod/arenaagents/server/AgentActivityPresentationVerification.java
src/test/java/dev/agaminggod/arenaagents/server/AgentFeedReplay.java
src/test/java/dev/agaminggod/arenaagents/server/AgentFeedVerification.java
src/test/java/dev/agaminggod/arenaagents/server/bridge/MultiplexedServerBridgeVerification.java
src/main/java/dev/agaminggod/arenaagents/mixin/PlayerObservationEventsMixin.java
src/test/java/dev/agaminggod/arenaagents/server/FailureChatThrottleVerification.java
src/test/java/dev/agaminggod/arenaagents/verification/VerificationMain.java
scripts/replay-activity-feed.sh
docs/feel-feed.md
```
