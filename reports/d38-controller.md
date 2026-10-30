# d38-controller: six confirmed controller contracts

Branch: `claude/d38-controller`, based on integration `a68669f5104b126b20aced30c324aecf021a702d`.

All six defects remain on that base; none was skipped as already fixed. Confirmation excerpts with immutable source line numbers are in `evals/d38-controller/BASE-EVIDENCE.md` in the arena-beat-game workspace. The audit appendix supplied here contains reviews 67–99; review 76 reproduces and checks the relevant findings from reviews 03, 08, 13, 15 and 19. Reviews 79, 81, 94, 95, 97 and 99 were also consulted.

## Shipping artifact and execution

- Jar: `jars/d38-controller-7f15ecde.jar` in arena-beat-game; also `C:\Users\player\arena-runner\jars\d38-controller-7f15ecde.jar` on Desktop.
- Build source: `7f15ecdec8b50f63090a83c7fdb20fe44df152de`. Later commits change only the test harness and documentation; production sources match this build.
- SHA-256: `5438851a310c2296240c5bbe2cbd8b128a6ab7d8816f5c5f1b7723221488fac3`; 5,974,355 bytes. The copied local jar, Desktop artifact and the mod loaded by the final Fabric server all match.
- Attestation streams and checks eleven affected compiled classes against jar entries, and all three changed coordinator modules against their packaged copies. `verifyShippingCore` checks the code origin of nine production classes before running controller/reflex/motor contracts.
- All Gradle, npm suites, decision evaluations and Minecraft servers ran on Desktop through the winrunner setup, with its 10% RAM reserve and BelowNormal/14-of-16-CPU process tree. The Mini PC ran edits, Git, syntax checks and transfers only. No other project queue was changed.
- Live fixture: `scripts/quality/test-controller-contracts-live.mjs`; Fabric/Minecraft 26.1.2, provider-free. Its coordinator imports come from the same jar, extracted into the task's own directory. The final six groups all pass. `evals/d38-controller/live-results.json`, `live-manifest.json` and `artifact.json` retain results and identity. No auth homes or RCON secret files were transferred.

## 1. Held shield suppresses attack/use: confirmed and fixed

Base: `CommandFollower.MOVES_UNDER_HOLD` includes both raw-control types without reading their flags. `Shield.tick` then overwrites hand input while the executor continues ticking the command.

Fix: classify the entire request. Movement-only controls still compose; any attack/use frame, including a later or branched frame, reserves the hands for the whole sequence. The normal explicit handoff yields the shield. A firing that genuinely owns the body pauses exclusive commands rather than advancing their input frames. A null-safe follower check covers the reserved-hand classification.

Test: request classification, delayed-frame reservation and handoff regression in `ReflexVerification`, executed from the jar. On the installed jar, direct attack reduced the test husk from 20 to 18.68061; a movement-then-attack sequence reduced a fresh husk to 17.95039. Main-hand use consumed snowballs from 8 to 6. The fixture confirms its current target under the crosshair. Old targets are moved out before death, because a vanilla dying body otherwise intercepts the next fixture's one authored press for twenty ticks.

Files: `reflex/CommandFollower.java`, `reflex/ReflexEngine.java`; shipping/live tests.

## 2. Shield movement loses magnitude/direction: confirmed and fixed

Base: `keysFor` returns zero below squared magnitude 0.01, then rounds the surviving direction to eight full-key headings. Thus 0.05 becomes zero and 0.15 becomes a full key.

Fix: rotate continuous, vanilla-normalized axes. Carry the authored movement basis through `AgentInputState` to the motor, apply vanilla's item-use/crouch/diagonal scaling in that original frame, then rotate the resulting impulse. A safety guard changing the keys discards the basis, so it cannot restore movement the guard stopped. Ordinary inputs retain their previous motor path.

Test: raw rotation sweeps, motor sweeps over fractional/full/diagonal axes, multiple use/crouch factors and 73 angles, plus a safety-guard negative control. All run against production classes from the jar. Live: 0.05 at 90 degrees moved 0.03919997 blocks; 0.15 moved 0.11759970, ratio 2.999995. The same 0.15 at 45 degrees moved 0.11759978, angular magnitude ratio 1.000000746; direction also passes. An intermediate simple-rotation negative control measured a 1.374431 angle ratio, which exposed the need to rotate after vanilla scaling.

Files: `reflex/ReflexActions.java`, `input/AgentInputState.java`, `input/ModelPlayerInputBridge.java`, `input/VanillaMoveInput.java`, `VanillaMoveInputVerification`.

## 3. Server-expired reflexes remain armed: confirmed and fixed

Base: `ReflexBook.observe` advances event sequence/report history without retiring definitions. An absent live row becomes pending; later payloads still include it.

Fix: reconcile the authoritative live rule set only when it acknowledges the current definition revision and is not rejected. Remove missing definitions and context-lifetime state; retain expiry reports, synthesizing a report if the event ring no longer contains it. A delayed old revision cannot retire a deliberate replacement. Coverage excludes pending, expired, disabled, yielded and physically unavailable rules.

Test: ten packaged-module contract tests include TTL, max-firings and until expiry, absent-event reconciliation, old-revision replacement, coverage and crystal credit. The live jar separately expires all three kinds, reports each expired, removes their coverage, then accepts an unrelated update containing only the new rule. No expired id is resent or reinstalled.

Files: `coordinator/src/reflexes.mjs`, `danger-contexts.mjs`, `coordinator/test/d38-controller-contracts.test.mjs`. An existing report-budget fixture now supplies live rule rows instead of incorrectly representing installed definitions with an empty authoritative list.

## 4. External crystal destruction credited as own shot: confirmed and fixed

Base: the broad `broke or died` match also accepts the Java producer's explicit `something else did it` message.

Fix: require successful, positive own-hit evidence; exclude external/unknown feedback. Track explicitly external destruction separately so a crystal disappears from remembered standing crystals without increasing “broken by your own hits.”

Test: packaged-module positive/negative/state controls; live external kill after the arrow launches earns zero own credit. A separate crystal physically destroyed by the player's arrow receives credit. Both are actual server receipts from the shipping jar.

File: `coordinator/src/dragon-fight-facts.mjs`.

## 5. False arrow hits and hidden trajectory feedback: confirmed and fixed

Base: increased `hurtTime` is treated as this arrow's hit, and sticky `seen` permits subsequent hidden position sampling.

Fix: record visible, actual vanilla arrow collisions in `ArrowImpactReceiptMixin`, including whether that collision destroyed its target. The watch uses that receipt rather than nearby damage or proximity guesses. It stops before reading another hidden position/outcome and samples target geometry only while visible. An unknown impact remains unknown.

Test: live controlled unrelated damage while an intentionally missing arrow flies does not produce hit/hurt credit. A wall raised behind an already launched arrow ends the watch with `you lost sight of it; impact not confirmed`, with no hidden flight correction. The crystal positive control also proves the shipping mixin's actual collision callback is active.

Files: `mixin/ArrowImpactReceiptMixin.java`, `controller/ArrowImpactReceipt.java`, `controller/ServerRangedUseController.java`, `arenaagents.mixins.json`.

## 6. Swim detour rejected for no endpoint progress: confirmed and fixed

Base: `SwimUp` retains the best Euclidean distance to the final air cell and fails after forty ticks without a quarter-block endpoint improvement.

Fix: measure remaining distance along the acquired path, including the fractional first leg. Rebase the guard when its air destination changes. Keep the same forty-tick/quarter-block stall contract for genuinely stationary swimmers.

Test: jar-loaded synthetic detour, stationary and changed-destination controls; real acquired U-shaped flooded tunnel. The live route initially has 17 path blocks remaining; distance from the body's start to the reported air point is 4.07 blocks and grows to 6.55 during the detour. It follows the route and reports `surfaced` after 6.2 seconds, with air replenishing and no false no-progress result.

Files: `reflex/ReflexActions.java`, `reflex/SwimAirProgress.java`, jar-loaded/live tests.

## Gates

Actual Desktop command, following the d38-dragon build procedure:

```text
.\gradlew.bat build verifyCore verifyShippingCore --offline -x assembleWindowsNodeRuntime --no-daemon --max-workers=1 --init-script <task-memory-init>
```

The init script caps each Java verification process at 512 MB. The existing Windows Node runtime is reused; its installer task is excluded, as in d38-dragon. No Windows runtime installation is claimed.

- Build, `verifyCore`: PASS, 2,577,196 core assertions; voice-addon 442 assertions.
- `verifyShippingCore`: PASS, 19,803 controller/reflex/motor assertions, nine class-origin checks.
- Packaged coordinator contracts: 10/10 PASS.
- Full `coordinator npm test`: 7,017 pass, 16 fail, 13 skip (7,046 total). The exact same sixteen failure locations reproduce on fresh base `a68669f5`: 44 pass/16 fail across the affected sixty tests. There are zero new failure locations. Causes are existing Desktop environment/fixture issues: ambient home AGENTS.md, Python not on PATH, Windows file modes and POSIX process/smoke/cleanup fixtures. They are not repaired by this patch.
- `npm run test:contracts`: 634/634 PASS.
- No pinned byte budget was raised.

Logs: `build-final.utf8.log`, `packaged-final.utf8.log`, `npm-test-final.utf8.log`, `contracts-final.utf8.log`, `baseline-failures.utf8.log`, and `baseline-failure-comparison.json` under `evals/d38-controller`.

## d31 combat rerun: PASS, no established regression

The original d31 directory holds the blaze-fight, end-fight-basics and end-perch decision suite. Its original candidate run was stopped without a candidate sample; it is not a completed live-combat benchmark. The three fixture files are unchanged between d31 and the current base.

Rerun those 19 cases on Desktop against `a68669f5` and candidate `eaa930da`, 3 samples/case, probe mode, fresh samples. Player: gpt-6.1-sol low/default; judge: gpt-6.1-sol medium with the explicit same-family option. The candidate's coordinator production sources match the final branch. All 19 rendered/encoded inputs and the complete system prefix are byte-identical between arms.

- Full screen: PASS; candidate 21/54, base 25/54, no errored or ungraded samples. Overall p(worse)=0.149; no family crossed the regression threshold. Report: `d31-eval.md`.
- The small screen flagged end-perch-02 (0/3 versus 3/3). Fresh offset-3 confirmation: PASS; candidate 8/12, base 3/12, no errors/ungraded answers. That case totals 8/15 versus 6/15 across both runs. Report: `perch-confirm.md`.
- `d31-render-identity.json` retains the exact input/prefix comparison. These are decision replays, separate from the actual Minecraft controller probes; they do not measure earned rods or a dragon kill.

## Remaining limits

No full-game death-rate or progression improvement is claimed. The air search remains bounded to eight blocks around the current eye cell; a sufficiently large previously acquired route can drop out of that local search as the body moves. The acceptance detour fits that bound. That independent search-lifetime limitation was found while constructing the fixture and is left as a follow-up, outside the requested distance-guard fix. The sixteen established Desktop npm failures remain.

## Implementation commits

- `95b91fe2` Fix shield command ownership, reflex expiry, and observed combat feedback
- `63fbfbce` Preserve existing controller source line endings
- `649e2ebc` Test controller contracts and track swim progress along the acquired route
- `4c3e28ac` Exercise controller contracts through a guarded shipping-jar live fixture
- `eaa930da` Keep live controller fixture fills inside the vanilla command limit
- `0cbbe54a` Handle shield handoffs safely and tighten controller live fixtures
- `ade95c5f` Verify controller classes from the shipping jar and record full swim diagnostics
- `e64d6c87` Keep Gradle edits scoped to the shipping verification task
- `6faa1755` Keep the swim detour inside the bounded air-search radius
- `4a0340a3` Scope the shipping-jar entry point to controller and reflex contracts
- `7f15ecde` Preserve vanilla-scaled movement through shield rotations at every angle
- `087f5499` Use the packaged coordinator modules for the live shipping contract gate
- `ce870419` Isolate live targets from vanilla death-animation collision bodies


The final documentation commit follows this list. There was no push, pull request or integration merge.
