# d39-blaze6: blocked bow shots and shelter repair

**Acceptance failed: 1/6 candidate repeats passed, versus 0/6 on base.** The candidate retained 5 rods and recorded 4 deaths; base retained 0 and recorded 5. The conditional two Sol-low/default 45-minute games were not run. These are provider-free body and stand-in-policy measurements, not Sol decision scores.

## Changes and immutable artifacts

Branch `claude/d39-blaze6` starts at `590fa635` on `claude/d22-int`, including d38-blaze4. Runtime commit `b8c17dcd` changes `ServerRangedUseController.java`, `RangedShotCheck.java`, `ServerShelterController.java`, the existing ranged contract verification and `coordinator/src/failure-codes.mjs`. Fixture commits are `ae29d9a1`, `d1aa2fa3`, `c7a67175` and `7352e15f`. No push, PR or merge into integration was performed.

- The bow can aim through the visible upper body of the requested target when its centre sends the lower arrow launch into a sill. The target UUID remains the model's choice. Explicit aim fields retain their authored aim.
- The controller checks the arrow path while drawing and ends a blocked call on its next tick. Refusals name the first blocking block and coordinates, then list current visual targets with clear full-draw lines, nearest first. The result does not select one of those targets.
- The controller checks whether the vanilla bow draw still exists. A stopped draw returns `RANGED_DRAW_INTERRUPTED`, or watches an early owned arrow if it remains observable, rather than waiting on the old draw timer.
- Shelter repair inspects the ceiling underside. An existing full ceiling makes its hidden construction scaffold unnecessary. Existing full cells are retained, missing cells are repaired, and the model-chosen eye-height window remains open. Failure results name the cell, known block and placement/mining reason.

Base jar SHA-256: `472c5fa734bf737e5140f36a2348c09f69e967923c85f9a07b8e41d3a40f753a`. Candidate jar: `3d76f0c7295c6ca247c09d79d39ee4971d735f0ef6e5220d9e18eac19e75173b`. Each jar's runtime source was frozen before its measurements. All other Java classes are byte-identical except unchanged instruction bodies with debug-name/line changes in `ServerActionExecutor$3`, `ArrowWatch` and `TargetFacts`. `artifact-identity.json` records the source hashes and comparisons. Java sources use CRLF. No pinned byte budget was raised.

## Same-harness comparison

Both jars ran on the Mini PC, at approximately 20 TPS, with seed `20261009`, the vanilla spawner at `84,73,92`, broad-deck start `83.5,73,91.5`, the frozen bow kit, east-facing roofed shelter, and both armed shield rules. Each trial restores the original terrain/spawner and starts a fresh body at full health. Ambient spawning stays disabled and the vanilla block spawner stays active. The window is 240 wall seconds; a death ends the trial. Each jar has three repeats each at no gap and a five-second gap before every body call.

The round-5 harness hash is `4127295bb8e0177809e5b063c6b34e765c67a2a2b5192755c6723a81a2331085`. The measured harness hash is `467393577a9301c8071967029efc21c0f219f1f2e1baa650e3634a06ce4e8e3e`. Its only change is a passive vanilla used-bow scoreboard counter and result fields. Target choice, actions, gaps, terrain restoration, kit and scoring are unchanged.

Each paired cell below is **base / yours**. Fired counts actual vanilla bow releases, including early releases that lack a successful ranged receipt. Refused counts `TARGET_OBSTRUCTED` calls. Picked counts the maximum inventory observed inside the window; the fixture never spends rods, so this is the number acquired before any death. Held is the last in-window inventory, scored zero on death. Kills and earlier possession do not earn acceptance credit.

| Gap | Repeat | Kills | Fired | Refused | Picked | Held | Deaths |
|---|---:|---:|---:|---:|---:|---:|---:|
| 0 s | 1 | 1 / 0 | 5 / 0 | 13 / 0 | 1 / 0 | 0 / 0 | 1 / 1 |
| 0 s | 2 | 7 / 4 | 25 / 17 | 32 / 3 | 2 / 3 | 0 / 0 | 1 / 1 |
| 0 s | 3 | 0 / 12 | 0 / 32 | 0 / 128 | 0 / 4 | 0 / 4 | 1 / 0 |
| 5 s | 1 | 3 / 0 | 9 / 0 | 2 / 0 | 0 / 0 | 0 / 0 | 0 / 1 |
| 5 s | 2 | 2 / 2 | 5 / 6 | 0 / 0 | 2 / 1 | 0 / 1 | 1 / 0 |
| 5 s | 3 | 0 / 1 | 0 / 9 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 1 |
| **Total** | | **13 / 19** | **44 / 64** | **47 / 131** | **5 / 8** | **0 / 5** | **5 / 4** |

Base returned four `RANGED_USE_TIMED_OUT` calls and three failed roof-cap re-entry repairs. The candidate returned zero ranged timeouts, nine observed draw interruptions, twelve successful re-entry repairs and one repair request stopped by the measurement deadline. It recorded no roof-cap repair failure. These fixes did not make the full tactic reliable.

## Retention and remaining causes, with traces

The round-5 three-rod death was during repeated re-entry repair, then eating. At 159.2 seconds it still held three rods at 10.17 HP; another hidden-cap attempt ended at 166.2 seconds with 2.55 HP and burning. It died during eating at 168.2 seconds. The server death message is `Blazer1 was slain by Blaze`. `round5-retention-evidence.json` preserves the selected samples and original log reference.

The candidate's no-gap repeat 2 also held three rods and later died, but all five of its re-entry repairs succeeded. At 109.2 seconds it held three rods at 16.45 HP. Damage followed during shooting: a blaze melee hit at 111.2 seconds, a fireball at 115.1 seconds and burning. At 130.2 seconds it remained inside the shelter at 5.07 HP with `minecraft:in_fire`; at 139 seconds it had 1.13 HP. The frozen stand-in repeatedly tried food, including full-hunger refusals, and its eating call was cancelled on death at 140.4 seconds. This remaining retention failure is shooting followed by eating in contact fire, rather than a hidden-cap rebuild. See `candidate2-retention-evidence.json` and the raw `candidate2-bow/trace.jsonl`.

Initial construction also remains vulnerable. No-gap repeat 1 was fireballed before firing an arrow. Five-second-gap repeat 1 completed four of nine shell steps and returned `SHELTER_BLOCKED`: air at `83,73,92`, requested support `83,72,92`, with `BODY_IN_DESTINATION` and an entity overlapping the placement collision shape. It later died with zero rods. The result supplies a concrete obstruction rather than silently rebuilding the cap.

Target choice remains another limit of the frozen policy. No-gap repeat 3 retained four rods, but made 125 separate refused calls against the west sill at `82,73,91`. Across its 128 refusals, 126 results listed at least one visible clear alternative. The stand-in kept choosing its target. The body returns the choices and leaves selection to the caller. These are separate action IDs, not an internal ranged retry loop.

The single-seed comparison does not establish a general survival guarantee. The remaining cause classes are exposed construction, fire inside completed cover during shooting/eating, and caller choices after a genuine obstruction.

## Held-out mechanics and d31 replays

Eight held-out checks pass in `candidate2-repair-r2/repair.json`: initial construction; intact repair after terrain memory expires; intact roof with its hidden scaffold removed; witnessed three-rod collection and return at 20 HP; immediate blocked-shot alternatives; an obstruction added during a draw; a named chest obstruction; and a physical hit on a lower target through the eye-height opening above an intact sill.

The immediate blocked call returned in **59 ms** through the live bridge and named glass at `3,102,1` plus a visible blaze UUID. A new glass blocker at `1,102,0` returned in **52 ms** after placement. The same intact-roof fixture fails on base after **4,399 ms** at its hidden scaffold; the candidate completes it in **899 ms**, placing nothing. Collection/re-entry restores only the missing sill and retains all three rods at full health. The first exploratory barrier left a real edge line and the arrow correctly hit its target; that fixture was widened, and its failed expectation is excluded. Runtime source did not change.

All six inherited isolated ranged cases pass: four cardinal bow directions, raised targets, roof/no-roof, a side window and seven snowballs. Every target died through confirmed physical shots under the armed shield stance. These stationary NoAI checks are separate from natural-spawner yield.

Fresh d31 replays use the same ten IDs and 12-second danger window. Base: **9/10 survived, 1 death, 0 errors**. Candidate: **10/10 survived, 0 deaths, 0 errors**. No previously surviving incident regressed in this pass. The base death was the `q-kiuc06` wither-skeleton fixture with no restored reflex rules. All ten incident/save-point hashes match the previous selection. The previous historical 10/10 is not substituted for these fresh results. Melee, navigation and shield instruction bodies were unchanged.

## Gates, resources and unverified work

- `./gradlew --no-daemon --max-workers=2 build verifyCore`: passed on both jars. Candidate: 2,577,418 protocol/core assertions, including six new stopped/blocked-draw assertions; voice: 442. Initial `JAVA_TOOL_OPTIONS` polluted the deliberately silent readiness fixture; clean-environment builds passed.
- Final coordinator `npm test`: 6,984 passed, 75 skipped, 11 failed of 7,070. All eleven failure names exactly match the prior Windows-dependent Linux failures. An initial run overlapped Gradle's `npm ci`; the final run was separate and complete.
- `npm run test:contracts`: 639 passed, zero failed. Focused failure-schema/lifecycle checks: 26 passed. No byte budgets changed.
- Heavy jobs used the shared slots. Live work used one slot at a time, with a two-CPU quota and 3 GB memory limit; builds used the Gradle slot with a two-CPU quota and 4 GB limit. Detached task workers and disk logs survived the session. The Desktop was checked with the required CPU counter but lacked the free-RAM budget, so no Desktop job started. Other queues and device power/configuration were left alone.

The requested all-six three-rod/no-death bar is unmet. The two conditional Sol games were therefore not run. No real Sol choice or use of this revised shelter/bow behavior is established. Evidence is under `/home/agaminggod/Desktop/Projects/arena-beat-game/evals/d39-blaze6`; selected manifests, per-run receipts and raw traces are in `base-bow/` and `candidate2-bow/`. Compact source, mechanics, gate, retention and replay records are committed beside this report; jars and test worlds remain local evidence.
