# Six full-game deaths: evidence and intervention

Baseline: `origin/main` at `821d53342e94`. Game 1 ran `3ff1739b`; game 2 ran `4f9a58c0`, seed `8365083243764356534`. Times below are seconds before the death, rounded; protocol references are line numbers in the **complete** `quality-protocol.jsonl`, not its rotated counterpart. These are causal reconstructions from observations, commands/results, coordinator wake events and captured provider input, not a physics replay.

## Sources and method

Both original directories are under `/home/agaminggod/.t3/worktrees/agents arena/t3-ba7399a1/runtime/headless-runs/`:

- Game 1: `run-1792221047917-2898d71e/q-c24yn0-45e0-LONG-r1-92ff4596`.
- Game 2: `run-1792226760127-5fbc580a/q-c5jehx-9aa8-LONG-r1-a3b10191`.

For each death, inspect the preceding 65 seconds of `quality-protocol.jsonl`, `coordinator.jsonl`, and `provider-turns.private.jsonl`. The provider timestamp is turn completion, not when every contained steer arrived; use coordinator timestamps for delivery. Some historical provider inputs contain invalid nested JSON introduced by location redaction. Their readable headers and independent protocol facts remain usable, but a byte-exact reconstruction of every historical model input is unavailable. No hidden model reasoning is inferred.

`capture.mjs --cooldown-ms 1` captured 732 moments from these runs. Seven selected checkpoints came directly from those captures; the pre-fall shoreline checkpoint uses the capture module's raw-observation extraction on the precise preceding observation. The eight committed cases retain unmodified raw observations, SHA-256 provenance and original trace/line references. Full goal specifications are restored from the run's recorded goal; saved end-of-run task plans are omitted because they postdate the death. Historical action/program ownership is not recreated. Thus decision evals measure the first decision on these facts, not the original stale-handle workflow or live survival. Cases live outside `train/` and are selected with `--cases test/fixtures/decision-eval/fullgame-deaths.json --ids ...`, preserving the default quick corpus.

## Ranked cause classes

1. **Combat response and interruption, 3/6 deaths:** two zombie encounters and pursuit of a skeleton through a new creeper threat. One concrete implementation defect: the model-installed survival template engaged at exactly the same health where its fight action immediately bailed. Stale program responses and late/coalesced damage updates also consumed response time.
2. **Terrain/fluid planning, 3/6:** gravel falling into a pillar shaft, sustained raw forward+jump across an unseen shore edge, and lava casting without confirmed current cooling water. The fall's reactive warning arrived too late for a normal model turn. Prevention needs the model to select supported movement before leaving the edge.

These counts describe primary causes, not independent experimental attribution or estimated minutes saved. No demonstrated body/pathfinding defect caused the fatal fall or suffocation. Game 1's earlier flee did take a damaging drop and cost 2 HP; that is recorded below without claiming all movement is safe.

## Game 1, zombie, 19.0 min

Death clock `1792222218076`; protocol death line 12319.

| Before death | Model-visible facts and choice | Body outcome |
|---|---|---|
| 60–40 s | Pillaring out of a cave, dirt ceiling, look sweeps with unknown edges. | Rises from about Y66 to Y73. |
| 33–25 s | Chooses northward navigation, then fights a nearby zombie after first damage. | Frontier result at 745.5,73,435.8; HP20→17; zombie killed. |
| 21–14.5 s | Requests `flee_from` distance24. | Descends Y73→61; a 5-block fall costs2HP. `TARGET_LOST` at line 12224 reports separation17.8m, another threat15.4m, body idle and no further retreat. |
| 10.6–6.5 s | Chooses local `move_to`; installed guard subsequently fights. | Move succeeds at line 12255; kills another zombie at line 12282 with HP15. |
| 3.4–0 s | Guard fights at HP12; damage brings HP9 and bailout threshold 10. At HP3 the model explicitly requests another fight, threshold 8, continuing attackers. | `LOW_HEALTH_BAILOUT` at12304, then immediate second bailout at12314. No retreat; more melee hits kill it. |

Threat wakes existed at −36.7/−30.9 s; later fall/damage wakes at −16.78/−16.69 s and threat updates throughout the last 12s. Captured headers included “Choose a direct fight_target or flee_from now” and low-health/creeper cautions; the final damage updates were late/coalesced. This was not silent danger perception. The model still chose an impossible fight below its own threshold. Main already explains that bailout leaves the body idle. This patch lets concrete survival/bailout facts outrank generic pending-program instructions. Replay `deaths-zombie-bailout`: **6/6→6/6**, no measured gain over current main.

## Game 1, burning while casting, 68.6 min

Death clock `1792225192774`; line 40305.

| Before death | Model-visible facts and choice | Body outcome |
|---|---|---|
| 60–34 s | Repeated scaffold travel attempts in water, raw jump and attempted lava placement. | Navigation times out, lava placement reports obstruction, water pushes it off a reached stand. |
| 28–14 s | Places cobble, navigates to609.5,65,182.5, extends scaffold and tries to rise again. | First stand succeeds; next rise reaches a frontier (40183). |
| 9.6–7.2 s | Torch, forward+jump for 8ticks, then lava bucket at610,66,181/up. | Placement succeeds (40226); lava/fire contact, HP16→12→8. |
| 5.7–0 s | Guard moves toward scaffold. Model tries stale `cancelProgram`, then direct forward+jump escape. | Briefly leaves lava but burns; cancellation rejected; installed guard interrupts escape, lava contact resumes atHP3. Subsequent dry-ground movement does not extinguish; dies. |

The readable historical header says “lava/fire contact. Move horizontally out now ... Lava costs ~8 HP/s; burn after exit. Escape before food or guards.” Contact became visible with about 7.2s remaining; additional fire wakes continue through −0.25s. Danger was explicit, but action ownership and repeated guard movement defeated the escape. Main's existing casting guidance already requires current cooling water and distinguishes dry ground from extinguishing. Keep that guidance; strengthen concrete emergency precedence, without adding automatic fluid or movement behavior. Replay `deaths-portal-contact`: **1/6→4/6**. This first-action improvement does not validate the guard/cancel race end to end.

## Game 2, suffocation, 23.9 min

Death clock `1792228217059`; line 14403.

| Before death | Model-visible facts and choice | Body outcome |
|---|---|---|
| 60–21 s | Repeated vertical mining and cobble pillaring. | Climbs roughly Y62→72. |
| 21–13.8 s | Script mines successive stone ceiling blocks through(-8,77,-122), then jumps and places support. | Mining completion14320 exposes gravel(-8,78,-122). |
| 13.0–7.5 s | Feet nowY76; observed head block is gravel atY77; `suffocating=true`, harm `in_wall`. Historical header: “suffocation. Reply to the program.” | Program suspends; HP20→19 then falls repeatedly. No escape body action. |
| 7.5–0 s | Model's `respondProgram` rejected `STALE_PROGRAM_DECISION` after ongoing damage changes facts. | Body remains in the block until death. |

Coordinator suffocation event at−13.084s, steer at about−13.035s; first damage steer follows within~50ms. The warning had substantial time, but gave a program-administration instruction instead of a physical remedy. The gravel was revealed before the jump; this was falling-block physics, not navigation putting the player through a wall. New header names head-block removal/side exit, stops pillaring, and directs use of current-handle `cancelProgram` when a program owns the body. Guidance covers sand/gravel support generally. Freshness validation remains intact. Replays `deaths-gravel-head` and `deaths-gravel-critical`: **12/12→12/12**; simplified replay cannot demonstrate that the historical stale-response loop is resolved in live execution.

## Game 2, fatal fall, 30.4 min

Death clock `1792228610797`; line 17443.

| Before death | Model-visible facts and choice | Body outcome |
|---|---|---|
| 60–30 s | HP6.5, food17; builds dirt dams, mines stone and chooses a breathable cell. | Reaches(-5.5,58.75,-116.5), holds jump to surface. |
| 18–3 s | Requests navigation toward(1,67,-111), then explicitly cancels it and holds jump100ticks. | Surfaces, then sinks toY61. This navigation is not the fatal command. |
| 2.8 s | At(-4.21,61,-114.29), underwater with 11.4s air and breathable cell overhead, model requests raw forward+jump yaw38 for 70ticks. | Crosses shoreY63 then launches over its unseen edge. |
| 1.7–0 s | `dropAhead={drop:1,atLeast:true,at:3}` and unknown ground-ahead depth; later fallDistance4.036 and fallDamage1. | Raw control still holds forward+jump. Lands atY54, consuming remaining 6.5HP. |

The optional installed fall guard's depth threshold 4 did not match the lower-bound1 edge; unknown depth did not assert a safe one-block drop. Actual airborne fall warning fires at−0.481s, too late for normal inference. No evidence of navigation planning this drop. New movement guidance requires supported landings before shore/edge traversal; fall header distinguishes stopping before an edge from already falling, where releasing input/sneak cannot undo it. `deaths-water-exit`: **6/6→6/6**; `deaths-fall-airborne`: **0/6→2/6**, still below its 0.5 threshold. An airborne replay “good” decision is not a physically timely rescue.

## Game 2, creeper during skeleton pursuit, 58.3 min

Death clock `1792230284318`; line 34449.

| Before death | Model-visible facts and choice | Body outcome |
|---|---|---|
| 60–19 s | Repeated birch obstruction repair and local route selection. | Clears logs, reaches successive local stands. |
| 19–7.9 s | Moves toward117,75,106; sees skeleton10.8m with bow. | Travel pauses for threat decision. |
| 5.2–4.0 s | Chooses `fight_target` skeleton, threshold 10,20s timeout. New visible creeper7.7m has `imminent`, ETA1.6s. | Continues pursuing skeleton uphill. |
| 2.9–0 s | Arrow lowersHP20→15; creeper closes to3.6m, then~1m and swelling, expected damage33. | Skeleton fight remains active; creeper explosion kills it. |

Threat wake at−7.925s; new creeper event−3.975s and steer−3.959s. Historical header remains “Threat: fight_target/flee_from work while program awaits reply” for both. Subsequent threat/damage steers queue/coalesce. The body pursued the selected skeleton; the model needed to replace that action when the threat changed. New header scans all reported threats and names imminent/swelling creepers even when a skeleton ranks first, directing immediate flee/action replacement. Replay `deaths-creeper-pursuit`: **6/6→6/6**; no demonstrated live reaction-time improvement.

## Game 2, zombie after shore exit, 72.7 min

Death clock `1792231145897`; line 41138.

| Before death | Model-visible facts and choice | Body outcome |
|---|---|---|
| 60–20 s | HP13, food15; salmon hunt, surfacing and shore attempts. | Fight times out without hits; swim/surface guard and failed shore routes consume time. |
| 19–7.4 s | Two forward+jump100tick commands reach shore; zombie threat arrives. Model attempts program response. | Threat wake−10.995s, steer−10.977s; response rejected stale at−7.396s. |
| 5.8–4.1 s | Installed survival guard chooses zombie fight threshold 10 atHP13. | One hit bringsHP10; bailout41110. Guard triggers AGAIN at exactlyHP10 and immediately bails at41118. |
| 3.5–0 s | Fresh damage updates, no effective retreat. | HP7→4→1→0. |

Confirmed coordinator template defect: engagement used `health >= fightAtHealth`; `fight_target` bails at `health <= fleeAtHealth`, and the template sets the same threshold. Changed trigger, script branch and feedback to strictly `>`. At equality an existing model-authored escape is used immediately; without a reported/model escape the impossible fight is skipped and feedback reports no supported escape. This is a correction to an already model-installed template, not a new autonomous guard. Interpreter tests cover thresholds 6, 10, 14 at below/equal/above, with and without escape. Replay `deaths-zombie-repeat`: **6/6→6/6**; the template boundary is proven by execution tests, not that replay's first model call.

## Verification and limits

Final targeted decision results: **37/48→42/48** good, PASS, eight source moments × six samples, GPT-6.1 Sol low, baseline `821d53342e94`. Output: `/home/agaminggod/Desktop/Projects/arena-beat-game/evals/deaths-3`. Candidate was the dirty branch's actual files; eval output labels its starting HEAD, so use its candidate fingerprint as well as the final commit. Earlier valid run `deaths-2` was 37/48→43/48 before the threshold fix. `deaths-1` was aborted because an incomplete captured goal specification left four cases without a wake; it provides no result.

No Java/body/pathfinding changes, no autonomous actions added. No targeted Minecraft live run or complete game rerun was performed; live mortality, ownership-race recovery, and escape physics remain unverified. The next useful live experiment is the gravel shaft with an active program and repeated damage, measuring whether cancellation plus head-block mining executes before death.

Checks: all 58 focused tests pass; all 600 contract checks pass after `contracts:refresh`; `./gradlew verifyCore` succeeds. The full Node suite has 6,619 passes, 75 skips and 17 failures. Those 17 failures reproduce on an unchanged `821d53342e94` archive: 11 Linux/platform fixture failures plus 6 existing night/continuity/corpus failures. The changed emergency-header expectation is updated and its tests pass. All eight fixture observation hashes were independently compared with the exact original protocol lines.

Targeted candidate code fingerprint: `5dd361be5b4b35fa6133ab76282c0fb993f8238e8c7df36398565dfc43fafe9a`; instruction prefix SHA-256: `715119943f9755b7f5ae5e02c69917a08ce861c99c4eb54c5137a85ef7d72823`.

Check logs: `/home/agaminggod/Desktop/Projects/arena-beat-game/reports/deaths-checks/`.

Final quick regression against `origin/main`: **46/76→48/76**, PASS, zero sample errors or ungraded answers. Output: `/home/agaminggod/Desktop/Projects/arena-beat-game/evals/deaths-quick-final`. One sample per case, with `--confirm-reserve 0.1`, keeps the76-case screen inside the fixed $15 estimate; low statistical power. Default six-sample and two-sample invocations were refused by the preflight budget check before any samples ran (`deaths-quick`, `deaths-quick-2`); exactly one quick screen executed. Its reported total cost was$0.73. Three individual cases changed from good to not-good; the comparison's regression rule did not flag a statistically supported drop. This is a broad smoke check, not proof of unchanged behavior on every family.
