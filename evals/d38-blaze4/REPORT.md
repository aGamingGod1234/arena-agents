# d38-blaze4: resumed bow-and-shelter measurement

**Acceptance failed: 1/6 fixed-jar bow repeats met the requirement.** The conditional two 45-minute Desktop Sol games were not run. These are provider-free body/tactic fixtures, not Sol decision scores.

## Changes and immutable artifacts

Work resumed in the existing `aa-d38-blaze4` worktree on `claude/d38-blaze4`. Integration `9203dd1e`, including the controller shield-input fix, was already merged in `95ba29a4`; the requested merge was checked and was already up to date. No merge into integration, push, or PR was performed.

The cancelled helper's committed changes restore coordinator fixture portability, real shutdown acknowledgements and usage reconciliation; add the bow/64-arrow kit and `3-fortress-bow-v2.json`; explain ballistic `use_ranged`, melee only in reach and witnessed-rod pickup; and add the live ranged and cover-peek fixtures. Relevant commits include `d82c4c93`, `1e2d4a94`, `237b80fc`, `8f8a9465`, `1e294b18`, `c9bb6914`, and `b618143b`.

The resumed production change is `1103ad7c`, in `ServerShelterController.java`: release the centering input before delegating to navigation. Centering has higher priority than navigation. Keeping its unused lease across an approach both retains old keys and permits its 40-tick deadman to expire. A real-spawner JFR recording caught the exception when centering applied that stale lease; its stack is committed in `resume-stale-lease-stack.txt`. The fix changes ownership at the handoff, without a stale-lease retry. `e2b2760c` records rebuilt-artifact identities, Linux gates and the policy diagnosis.

- Merged baseline source: `112d8be8`; jar SHA-256 `f566af7502ed2cbc73311e649d2ddfefd254eb74538504bb7e7518bd2c3571de`.
- Selected candidate runtime source: `1103ad7c`; jar SHA-256 `f5afb27d30cdb92abdfe2ba7243d193256188cea118ff4b9ccde9c024f940cfb`.
- Frozen spawner harness: `b618143b`; Linux/Git LF SHA-256 `4127295bb8e0177809e5b063c6b34e765c67a2a2b5192755c6723a81a2331085`. The Desktop CRLF hash is `c7b835b698d8f4389090c0fb3285541c968ca811136aca334b2f0be2721e6a50`; the normalized source is the same.
- Of 1,564 class entries, only `ServerShelterController` and the previously documented constructor debug names in `ServerActionExecutor$3` differ from the baseline. The original frozen identities are retained separately from the resumed candidate identity.
- The checkpoint variant adds a bow and 64 arrows. The original `3-fortress-v2.json` remains unchanged, SHA-256 `d037af10efc328f2966737956a25782c37c1f47ba90ed42cba913fb449d39533`; the bow variant SHA-256 is `d4cb9069c8bc9a95f18d937f3435fd17356340dbcc4a052900723ac49d36481d`.

No automatic product combat routine, target choice, cover placement or Watcher-to-model channel was added. The model still chooses its site, construction, shots and collection. The prewritten tactic is confined to the mechanics fixture.

## Comparison with the same harness

All selected arms use seed `20261009`, the vanilla fortress spawner at `84,73,92`, broad-deck start `83.5,73,91.5`, full health, the same authored probe kit plus bow/64 arrows/16 snowballs, and three repeats each at zero and five-second gaps before every body call. Each trial has a fresh body, original terrain/spawner restoration and removal of previous mobs, drops, fire and projectiles. Ambient spawning is disabled; the block spawner remains enabled. Initial position, health and spawner existence are asserted. The measurement window is 240 seconds and a death ends the trial.

Cells below are **rods held at the last observation inside the window / deaths**. Death scores zero retained rods. Maximum prior inventory and kills do not earn acceptance credit. Probe exit codes record fixture completion; gameplay acceptance uses the rod/death rule.

| Gap | Repeat | Open melee | Shelter melee | Bow on base | Bow on fixed jar |
|---|---:|---:|---:|---:|---:|
| gap0 | 1 | 0 / 1 | 0 / 1 | 3 / 0 | 3 / 0 |
| gap0 | 2 | 0 / 1 | 0 / 0 | 0 / 1 | 0 / 1 |
| gap0 | 3 | 0 / 1 | 0 / 1 | 0 / 1 | 0 / 0 |
| gap5 | 1 | 0 / 1 | 0 / 0 | 0 / 1 | 0 / 0 |
| gap5 | 2 | 0 / 1 | 0 / 0 | 0 / 1 | 2 / 0 |
| gap5 | 3 | 0 / 1 | 0 / 1 | 0 / 1 | 1 / 0 |

Open melee and bow-on-base use the completed frozen Desktop cohorts `matrix-base-melee` and `matrix2-base-bow`. The resumed Mini PC cohorts rerun the interrupted candidate bow arm and the round-3 shelter-melee tactic on the merged baseline. The final runtime's d31 replay and the interrupted snowball/construction-guard probes were also rerun. Aborted workers are excluded.

Bow-on-base retained 3 rods across six trials and died 5 times; the fixed jar retained 6 and recorded 1 death. The fixed jar completed all six initial shelters. The retained base cohorts ran on the Desktop; the resumed cohorts ran on the Mini PC. This small single-seed comparison does not isolate the causal effect of the bow or establish a general survival guarantee. It did not establish the required reliable three-rod outcome.

## What the traces establish

One fixed-jar trial killed 18 blazes, retained three rods and survived. Another held three rods before dying, correctly scoring zero at the end. A third killed 12 blazes and retained none. A kill or first possession therefore overstates usable progression.

The remaining authored policy failures include rebuilding a hidden roof cap after collection and repeatedly selecting a target whose arrow path meets a feet-level wall. One no-gap run recorded six `SHELTER_BLOCKED` returns while rebuilding; another recorded 112 refused shots against the same sill block. Those calls do not establish that an arrow was fired. Some natural shots also return `RANGED_USE_TIMED_OUT`; their exact cause was not established and no timeout/retry workaround was added.

A separate exploratory pilot repairs the walls/sill with `roof:false`, leaving the existing ceiling, and temporarily chooses another visible target when a named non-head wall blocks the shot until the target/body moves. It used one five-second-gap repeat: 0 rods, 0 deaths, 3 kills. It also missed the bar and was not promoted into production guidance or the selected six-repeat harness. Its patch is retained as `repair-pilot.patch`.

## Isolated ranged mechanics and replays

The selected jar passed all six isolated ranged cases: north/east/south/west bow shots at 6–14 blocks, raised targets, a roof-off case, a deliberately opened side window, and snowballs at six blocks. The shield stance was observed firing before each draw/throw. Targets were stationary NoAI fixtures. Every case completed construction and killed its target through confirmed physical shots. Seven snowballs reduced blaze health from 20 to zero in three-damage steps, leaving nine of the legal 16 stack. These checks establish drawing/throwing under the armed shield stance; they do not establish reliable natural-spawner yield or immunity to every incoming-shot interruption.

Base d31 replays: 10/10 survived, 0 deaths, 0 errors. Fresh selected-jar d31 replays: 10/10 survived, 0 deaths, 0 errors, using the same ten incidents and 12-second danger window. These are actual server replays, separate from the NoAI fixtures.

The natural shelter/snowball arm, with melee only in reach, completed one no-gap trial: 0 rods held, 0 deaths, 0 kills. The construction-only shield-suspension pilot completed one five-second-gap trial: 0 rods, 1 death, 0 kills. Both remain secondary diagnostics, outside the six-repeat acceptance matrix. A preceding snowball attempt was rejected before scoring because the first observation had moved outside the authored start-position tolerance; its empty result is excluded.

## Gates, resources and limits

- `./gradlew --no-daemon --max-workers=2 build verifyCore verifyShippingCore`: passed, 2,577,412 protocol/core assertions, 19,811 shipping assertions, plus entrypoint/mixin and voice checks. The first resumed Mini PC build ran online after the cache wipe. Builds used the Gradle slot.
- Final `npm test`: 6,984 passed, 75 skipped, 11 failed out of 7,070, exactly the documented Windows-dependent Linux failures. The extra 15 regressions from round 3 are gone. This final rerun includes the resumed production source.
- Final `npm run test:contracts`: 639/639 passed. No pinned byte budget was increased. Java source line endings remain CRLF.
- Selected resumed live jobs used one Mini PC live slot at a time, a two-CPU quota and 3 GB service memory limit, alongside the other queues. Selected spawner measurements remained approximately 20 TPS. Detached user units and logs survived the terminal session.
- New Desktop attempts were stopped by the host resource guard and are not scored. Observed host peaks included 98%; the report does not claim the whole Desktop stayed below 90%. Its other games and applications were left alone. The selected resumed matrix moved to the slot-controlled Mini PC. No auth homes or credentials were copied, and no device power, global configuration, FORK-Tools job or integration branch was changed.

The three-repeat no-gap and five-second-gap bow bar failed. The checkpoint variant has not been demonstrated in a real Sol game, and no Sol choice/use of this tactic is established by these provider-free fixtures. The conditional Desktop games were therefore not run.

Evidence: `/home/agaminggod/Desktop/Projects/arena-beat-game/evals/d38-blaze4`. The selected raw manifests, trial receipts and traces are under `resume-candidate-bow/`, `resume-shelter-melee/`, `resume-final-mechanics/`, `resume-snowball2/`, `resume-build-guard/` and `resume-repair-pilot/`; gates use `resume-build-fix.log`, `resume-final-npm.log`, `resume-final-contracts.log`; replays use `resume-final-d31-selected.json`. Committed `selected-summary.json`, `resume-verification.json` and identity records provide the compact handoff. The first resumed replay pass accidentally selected the unfiltered 138-case local library. Its partial results are excluded as `resume-d31-oversized-partial.json`. The final replay explicitly selects the ten baseline IDs with `--only` and compares them with `--compare`; the selection and input hashes are recorded in `resume-d31-selection.json`. No interrupted or resource-stopped cohort is treated as complete.
