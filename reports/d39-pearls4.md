# d39-pearls4: price the gold Sol has actually seen

Branch `claude/d39-pearls4`, based on `4682f12ef47a997d0f6fb9b3e9ca194dd765bfe8`.

The tested change prices a seen patch as partial pearl supply. It does not establish reliable pearls. The normal paired decision eval scored 8/66 good choices in each arm and passed its regression gate. The diagnostic probe scored 17/66 on base and 15/66 on final candidate. Neither establishes improvement. Full-game and physical results follow below.

## What changed

`coordinator/src/gold-source-facts.mjs` counts only gold blocks and Nether gold ore in current sight or scoped player memory. It deduplicates coordinates, withdraws remembered sources when current sight shows air, separates the nearest connected seen patch from all seen sources, and prices blocks at nine ingots and unenchanted ore at four ninths of an ingot. It states that access and clearance are unverified. Closed chests and buried neighbours contribute nothing. Held currency remains a separate existing pearl-options input.

`need-sources.mjs` puts this compact fact before the pearl-source choices. Its reserved budget rises by exactly 322 bytes, from 720 to 1,042: a 320-byte gold fact plus its separator. The instruction file stops dismissing ore because one vein cannot fund all twelve pearls. It explains partial batches, collecting nuggets and crafting currency. `combat-facts.mjs` states that guarded mining and opening guarded containers can anger unseen piglins even with gold worn. Final wording names chests, barrels and shulker boxes rather than suggesting every container, including a furnace, is guarded.

No production Java, action, goal ordering, mining routine or barter routine changed. Sol still chooses every target and action. Survey coordinates, world data and `/locate` results were operator-only and never entered its observations, memory or instructions. Five focused tests cover source parity and accounting; the existing combat fact test covers the anger warning. Gold gathering is marked advisory in the contract claim, not a body guarantee.

Runtime commits: `af6f3f09` (accounting and facts), `892d605e` (advisory claim), `53920309` (accurate container wording). `713e8792` adds operator measurement tools. Live games were frozen at `af6f3f09`; the final wording at `53920309` has decision and test coverage, but was not substituted midway through those games.

## Earlier evidence and chosen lever

The d37 report found working bartering but almost no block harvest: Sol saw only a few blocks while the original bastion held about 225 ingots. The two d38 pearl reports added source/plan guidance without establishing supply; the second regressed its decision sample and earned no new pearl source. The third report's natural-enderman trials yielded zero pearls and had access/patrol limitations. These findings support testing gold decisions, but do not prove that still more advice will solve them.

The d39 queue records ore in avatar perception during fortress travel, with little deliberate harvesting. Recorded visibility alone does not prove delivery to the model. The least autonomous change is therefore to price those sightings as a small usable batch rather than require a source to fund the entire goal. This is a hypothesis under test, not a claim that bastion access or safe mining has been solved.

## Operator survey of the four v2 starts

The server uses vanilla 26.1.2 structure templates, loot tables, gold drops and piglin tags. For each checkpoint the survey loads chunks before applying its seven Nether fixture commands, checks placement responses, then captures generated region data. All 225 expected portal chunks are fully generated on every seed. It also loads the operator-located bastion. The earlier unprepared survey, which sent placement commands before chunks loaded, is excluded.

Distances below refer to structure-start positions, horizontally from the portal. The census also reports actual gold coordinates and structure-piece bounds in `survey/*/analysis.json`. Housing units are the vanilla `units` type.

| Seed | Portal x,y,z | Operator-located bastion | Actual gold blocks / ingots | Chests | Exposed ore on approximate walk routes |
|---|---|---|---:|---:|---:|
| 123456789 | 0.5,65,5.5 | housing units, 320 m east | 19 / 171 | 8 | 133 |
| 8675309 | 16.5,77,-2.5 | housing units, 434 m northeast | 21 / 189 | 11 | 73 |
| 987654321 | 0.5,61,-2.5 | hoglin stable, 495 m northeast | 26 / 234 | 9 | 37 |
| 20261024 | 0.5,82,-2.5 | housing units, 705 m northwest | 19 / 171 | 12 | 25 |

Seed 987654321 also has a housing bastion only 82 m west, with 17 blocks (153 ingots) and seven chests, in the generated portal area. `/locate` returned the more distant stable. The vanilla random-spread search can return its first search-ring hit rather than the globally closest structure across adjacent regions. Neither structure location was told to Sol.

The vanilla gold-bearing templates also explain the usual places to inspect. Housing units have 12 blocks in `walls/wall_base` and five in `walls/connected_wall`. Stables have 12 in `walls/side_wall_1` and four per selected `ramparts/ramparts_1`. Bridge templates carry 16 in the bridge piece, seven in the entrance, two in its base and three in one base-wall variant. Treasure center alternatives contain 19, 12, 16 or 13 blocks; some entrance and wall templates add smaller groups. Shared `blocks/gold` pieces add one each. These are template pieces, not additive guarantees for every generated bastion: variant selection, repeated pieces, jigsaw placement and processors determine the actual stock. The sampled housing bastions have the 17 main-wall blocks plus zero, two or four shared gold pieces.

Housing gold in these generated pieces sits mainly in the lower wall/base sections, y35–54. The stable has gold at y33–64. Counting structure NBT must include a jigsaw block's `final_state`; omitting it undercounts gold. Processors can then remove template blocks: the stable has 29 template blocks but 26 actual blocks. Chests use their saved vanilla loot-table IDs. Expected currency from those chests, including block and nugget conversions, is respectively 21.20, 29.15, 29.27 and 31.79 ingots; the nearby second housing bastion adds 18.55. These are loot expectations, not opened or earned inventory. No bridge or treasure-room bastion was present in this sampled set.

The actual gold block coordinate ranges relative to each portal are below (`+x` east, `+z` south; negative y is below portal height). These are operator census results, not discovered player routes.

| Seed / type | x offset range | y offset range | z offset range |
|---|---:|---:|---:|
| 123456789 housing | +278.5 to +309.5 | −30 to −11 | −3.5 to +40.5 |
| 8675309 housing | +185.5 to +216.5 | −42 to −23 | −434.5 to −383.5 |
| 987654321 stable | +306.5 to +350.5 | −28 to +3 | −366.5 to −322.5 |
| 987654321 nearby housing | −57.5 to −39.5 | −26 to −11 | +22.5 to +32.5 |
| 20261024 housing | −297.5 to −263.5 | −47 to −32 | −673.5 to −623.5 |


The walk graph uses cardinal movement, full-block floors, up one/down up to three blocks, and doors treated as open. A source must lie within 4.5 m of an eye position with an approximate centre ray. It excludes digging, bridges, stairs/slabs and mob risk. None of the gold blocks lies on that unmodified graph. This does not mean a player cannot reach the bastion gold by mining or building. The graph is a terrain census, not an executable route or a safe-access proof.

| Seed | Ore within 25 route steps | Within 50 | Within 100 | Within 200 | All mapped | Expected ingots in all mapped ore |
|---|---:|---:|---:|---:|---:|---:|
| 123456789 | 7 | 21 | 57 | 125 | 133 | 59.11 |
| 8675309 | 2 | 4 | 9 | 43 | 73 | 32.44 |
| 987654321 | 8 | 23 | 27 | 37 | 37 | 16.44 |
| 20261024 | 2 | 4 | 4 | 7 | 25 | 11.11 |

These cumulative counts are sources visible from some position reachable within the distance, not ore per block of one chosen walk. Source counts omit hidden ore. The sample is dense enough for small batches, but the 112 m portal census alone does not fund twelve pearls reliably.

### What a player can expect per minute

An unenchanted iron pick mines hardness-three gold ore or a gold block in 15 ticks; allowing the normal five-tick delay gives one second per block. Ore averages four nuggets, so a stationary exposed face has an ideal ceiling of 26.67 ingots/minute. A block yields nine ingots, 20.25 times an average ore block. At walking speed 4.317 m/s and two seconds of collection per patch, the nearest mapped patch rates, including outward access, are 13.02, 4.27, 14.69 and 3.39 ingots/minute in seed order. Searching, turning, fragmented surfaces, the return and enemies reduce these estimates.

Bastion blocks are much richer, but raw block stock divided by straight-line travel to its closest gold block plus mining is only a ceiling: 122.65, 93.19, 103.48 and 58.10 ingots/minute for the located structures, 328.42 for the nearby housing bastion on 987654321. Those numbers omit vertical access, walls, collection, brutes, anger and lava. They are not measured safe entry rates. Actual player bastion-entry yield/minute remains unverified; presenting these ceilings as expected achieved rates would be misleading. The production-body repeat measurements below include its real movement, scans and combat.

### How much gold buys twelve pearls

The shipped barter table has pearl weight 10 out of total 469. A successful pearl trade returns two, three or four pearls uniformly. Expected pearls per ingot are 30/469 = 0.063966. Dividing twelve by that yield gives 187.6 ingots, but it is not a reliable budget. The exact distribution gives a mean stopping cost of 204.97 ingots to reach at least twelve, median 189, 80% budget 282, 90% budget 340 and 95% budget 394. A stock of 225 ingots has 14.39 expected pearls but only a 63.94% chance of at least twelve. Sixty-four ingots have only a 3.79% chance; 128 have 23.97%.

The committed `vanilla-prices.py` reproduces the table prices and exact distribution retained in `barter-odds.json`. Vanilla chest expectations are `bastion_other` 2.64957, hoglin stable 4.45889, bridge 2.05513 and treasure 14.58333 ingot-equivalents per chest. Armor and tools are not counted as currency.

## Decision measurement

Frozen cases: three newly captured, healthy, equipped d39 ore turns, six reused d31 pearl cases and two reused d38 cases. The selector required an iron pick, gold worn and seen ore; no eligible fourth-seed case was found. Cases and hashes were frozen before sampling. The harness split is called heldout, but reused cases were known from earlier investigations and the fresh queue views were examined here; this is not an independent blind test. Current travel actions and replayed goal setup were preserved on the fresh turns. Reused state has the replay limitations recorded in the eval output.

Both arms use Sol `gpt-6.1-sol`, low reasoning, default tier; the judge uses the same model at medium, with `AA_JUDGE_ALLOW_SAME_FAMILY=1`. Six samples per case give 66 answers per arm. Final diagnostic comparison targets `53920309` versus `4682f12e`: base 17/66, candidate 15/66, comparison PASS (diagnostic, not a gate), no errors or ungraded cases. The baseline 66 answers were reused from the initial screen; the candidate was resampled after the container wording correction. The initial `af6f3f09` screen was 17/66 versus 18/66. Neither establishes improvement.

All eighteen fresh ore answers in each final arm score zero good. Eight cases score zero in both arms. The README explicitly says `--probe` is diagnostic and never a gate. A separate normal paired evaluation also used six samples per case, the same frozen cases and model settings, and fresh answers in both arms: 8/66 good versus 8/66, PASS, zero errors/ungraded, nine cases zero-good in both arms. It stops at the first accepted call, often a read or setup call, and likewise has no physical continuation. Its per-case good counts differ only on d31-02 (4 to 5) and d38 seen-unmined (4 to 3); all other cases are zero in both arms. This is a strict first-action probe with scripted replies and no Minecraft continuation: cancelling an active travel action or preparing can end the probe before a mine, so zero is not proof that Sol would never mine in continued play. Conversely, it supplies no evidence that the patch makes it mine. The production renderer check confirms the seen-gold fact is present on all three fresh views. The eval's native `modelCalls` aggregate is zero because that provider metric is missing, despite real player answers and billing; do not interpret it as zero inference.

| Case | Base good / 6 | Final candidate good / 6 |
|---|---:|---:|
| fresh 123456789 / 20261024 / 8675309 | 0 / 0 / 0 | 0 / 0 / 0 |
| d31 pearls 01 | 6 | 3 |
| d31 pearls 02 | 6 | 6 |
| d31 pearls 03 / 05 / 06 / 07 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| d38 seen-unmined | 5 | 6 |
| d38 unseen-piglins | 0 | 0 |

## Physical repeat measurement

Lucas closed the gold phase on Oct 25 at 23:07 to prioritize warped forests. Sixteen primary trials are captured, plus two supplementary valid Desktop trials. The three-repeat-per-arm bar is complete only on seed 123456789. Two completed Mini candidate trials are retained; the just-started base 8675309 repeat 3 and all queued trials were cancelled and remain unscored.

| Seed | Base secured ingots / n | Candidate secured ingots / n | Base / candidate deaths |
|---|---:|---:|---:|
| 123456789 | 2.111 / 3 | 3.037 / 3 | 1 / 1 |
| 8675309 | 0.000 / 2 | 0.000 / 2 | 0 / 1 |
| 987654321 | 2.667 / 1 | 2.444 / 2 | 0 / 0 |
| 20261024 | 0.000 / 1 | 0.000 / 2 | 0 / 0 |

Each value is the mean secured ingot-equivalent in a ten-minute opportunity, with actual n shown; these unequal partial groups are not a complete paired comparison. Same frozen, test-only sight-driven controller, same jar and checkpoints. No model or operator gold coordinates feed this controller. The production change adds facts only, so this is a control and a measure of body headroom, not evidence that the fact patch changes physical mechanics. Death truncates an attempt; report that duration and secured gold as zero rather than extrapolating a survivor rate.

## Queue trace and four live games

The queue trace includes all eight multi-seed Nether-entry games and the later queue tags beginning `d39-nether-`, through the stated final cutoff. Other checkpoint types remain separate from the four-seed control comparison. The first four use `9203dd1e`, so they are historical context, not the requested exact-base controls. Avatar sightings below count recorded visible cells, not guaranteed delivery of every cell to an LLM wake. The exporter separately counts minimum explicit gold cells in decoded wake inputs and turns carrying the new gold fact.

| Queue game suffix | Build | Observed window / ending | Ore / gold blocks seen | New gold ingot-equivalents | End gold | Deaths |
|---|---|---|---:|---:|---:|---:|
| 123456789-3 | 9203dd1e | 90 min | 30 / 0 | 0 | 0 | 1 |
| 987654321-5 | 9203dd1e | 75.81 min official, spend cap | 9 / 0 | 0 | 0 | 9 |
| 20261024-8 | 9203dd1e | 90 min | 8 / 0 | 1.444 | 0 | 2 |
| 8675309-11 | 9203dd1e | 90 min | 24 / 0 | 0.889 | 0 | 2 |
| 123456789-18 | 4682f12e | 90 min | 50 / 0 | 0.222 | 2.222 | 0 |
| 987654321-20 | 4682f12e | 44.76 min, RCON closed | 8 / 0 | 0; recovered own initial 2 | 0 | 2 |
| 20261024-22 | 4682f12e | coordinator bridge failed, zero Sol turns | unavailable | unavailable | unavailable | unavailable |
| 8675309-24 | 4682f12e | coordinator bridge failed, zero Sol turns | unavailable | unavailable | unavailable | unavailable |

The private audit sanitizer flattens newlines, so the first audit parser decoded no wake packets. The corrected exporter scans complete JSON packets and uses the source build's fact decoder, including explicit view replacements. On the locally available exact-base 123456789 game it decodes 139 packets across 182 Sol turns and finds three explicit ore cells, versus fifty in avatar perception. Three is a minimum: tool replies and retained sections are not reconstructed. Desktop wake inputs were never copied and cannot be re-read under the stop instruction; their explicit-cell coverage remains unavailable. This evidence does not establish that Sol deliberately ignored all fifty ore cells.

All six games with gameplay recorded zero gold handovers, dropped ingots and heard barter starts, zero vanilla pearl pickups, and zero pearls/eyes held at their ending sample. No gold block was mined. The old 20261024 game mined three ore blocks for thirteen nuggets; old 8675309 mined two for eight nuggets. Their pickups occurred during `travel_to`, not deliberate gold-break commands. The exact-base 123456789 game mined one ore for two nuggets and retained those plus its initial two ingots. Exact-base 987654321 mined no gold: its two picked-up ingots are its own starting currency recovered after the first death, not new supply. Its inventory goes from two to zero at 16.74 min, back to two at 19.07 while retracing to the death location, then to zero at 42.98 after the next death. It has no gold crafting, container transfer or trade command.

Recorded ordinary piglin counts in those six games are 59, 27, 2, 99, 112 and 6 respectively. The old 8675309 game also saw three brutes and died once to a brute. That is not gold anger: brutes ignore gold armor. No queue death names an ordinary piglin. The gameplay-only `queue-choices.json` records the first ore view, following commands and action counts per game. They issue 40–106 `travel_to` calls and 38–57 `dig_to` calls, but no successful explicit break of a gold block or Nether gold ore. None of these games demonstrates barter failure once gold was supplied; the trace mainly shows no supply decision, incidental ore mined in travel, and resource loss. The sole complete exact-base multi-seed entry control is 123456789; the other three do not supply matched 90-minute outcomes. The queue's 90-minute raw log for old 987654321 exceeds its official spend-cap window; use the official window rather than relabel it a full control.

The later `d39-nether-gold-27` is a separate `4682f12e` control on seed 20261009, checkpoint `2-nether-gold-v2.json`. It completes its 90-minute budget with 57 Sol low/default turns, two recorded ore cells, nine ordinary piglins, no gold mining, no handovers/drops/barter starts, no pearl pickups and zero gold/pearls held. Its two picked-up ingots and helmet are recovery of starting gear, not new supply; there is no gold-source action. Four deaths name a Blaze, two Wither Skeletons and an overworld Skeleton, with no piglin death. No explicit ore cell is found in its 28 decoded wake packets, again a minimum that omits tool replies and retained views.

`d39-nether-gold10-28` and `d39-nether-29` are Desktop attempts on the same seed, interrupted during the Desktop-wide stop. Both are void. Their unavailable or partial artifacts provide no gameplay outcome. The local acknowledgement time is later than the actual stop, so the explicit interrupted tags govern rather than that timestamp. `d39-nether-sol-y55-30`, seed −8891462362762682724, was newly launched on the Mini PC at the latest refresh; its operator lifecycle records show PLANNING_TIMEOUT from 22:20 through 23:00. It is excluded from scored gold outcomes under the user's provider-stall instruction. A fresh low/default readiness sample at 23:01 also failed with PLANNING_TIMEOUT after 121.181 seconds; neither pending Mini replacement live game was launched.

Only two of the required four candidate games completed before the direction change. The two missing seeds, 987654321 and 20261024, remain unverified. The two completed games use `af6f3f09`, Sol low/default, and the exact same Desktop base jar. 123456789 earned 44 nuggets (4.889 ingots), explicitly mining eleven ores around minutes 57–59, then crafted four ingots and spent them on gold boots after recovery. It ended with zero gold and pearls, no trades and five deaths. The final ordinary-piglin death followed a skeleton death and re-entry without gold worn; no guarded action occurred in the preceding minute. This is consistent with naked aggression, not an identified mining-anger death. 8675309 earned three nuggets (0.333 ingots) incidentally during fortress travel at 19.59 min, made no trades and ended with zero gold/pearls after one wither death.

Gross pickups, new source earnings and final holdings are separate. Starting `/give` currency and currency crafting are excluded from earnings; recovered own drops can still inflate the vanilla gross pickup counter and are identified explicitly above. A missing ending sample or preflight is unavailable, not zero. A handover or heard admiration start would not alone prove a completed barter; here all relevant command, sound and pearl-pickup counts are zero.

## Censored attempt and runner repair

The first 987654321 candidate attempt ended early with `RCON_INCOMPLETE` after the runner received a complete, untruncated 18,393-byte `codex status` reply. The runner conflated its 16,384-byte retained-evidence limit with the size of a complete lifecycle poll. This is an internal test-runner failure, not a pearl failure or a full 90-minute result. Its evidence is retained separately from the later attempts. A brief SSH outage occurred around this period too; it does not explain this deterministic size check.

Commit `778aa743` fixes the runner only: complete status polls for the owned agent(s) pass to lifecycle parsing without being retained as assertion evidence. The RCON transport keeps its 64 KiB reply limit, and the report/assertion evidence bound stays 16,384 bytes. Incomplete/truncated replies and oversized inventory evidence still fail. A failing-before/passing-after 18,393-byte mock reproduces the issue; all 26 headless-matrix tests pass afterward. Both post-reboot `-r3` replacements use the separate validated `d3dbc5c1` harness with this repair and explicitly point their player coordinator at the original frozen `af6f3f09` runtime. This does not change model instructions or body code. No Java/player behavior or prompt changes with this repair. The failed initial 20261024 live attempt never made its coordinator bridge ready and produced no Sol turns. A physical 20261024 startup produced no scored result, and the old launcher continued into a port-in-use error. Those starts are excluded, not scored as zero gold. Replacement physical launches preserve the frozen controller, stop on a failed child, and use a fresh port group for every server, as the existing replay harness does.

## Gates and evidence

Final `./gradlew build verifyCore --offline`: PASS. The first cache-warming build ran without offline as required. Core verified 2,577,418 assertions and voice 442. Contracts: 639 passed. Focused source/fact gates: 69 passed. Full `npm test`: 7,077 total, 6,991 passed, 75 skipped, the eleven known Windows/platform-dependent failures on Linux. This is not a clean full-suite pass. No new platform failure was introduced.

All 1,565 candidate classes match the Desktop baseline jar byte-for-byte. The Mini baseline jar differs in one anonymous-class local-variable debug table only; disassembled executable instructions match. Physical arms use the same exact Desktop jar, and live games explicitly load our frozen coordinator root. Hash evidence is `jar-class-parity.json`.

Reproduction sources are committed under `evals/d39-pearls4/` and `scripts/quality/test-gold-route-live.mjs`. Large gameplay artifacts stay outside git under the arena workspace's `evals/d39-pearls4/`: prepared survey, source and barter prices, frozen decision cases and reports, safe gameplay exports, repeat results, metrics and gate logs. Exporters allow only gameplay envelopes and selected player evidence; authentication envelopes, credential files, provider homes and server credentials stay on their host. No push, PR or merge was performed.

Host resource pressure also affected this batch. A separate PowerShell inspection reached about 19 GB resident / 25.7 GB private memory, leaving only 0.46 GB free. The orchestrator stopped it after the issue was identified and confirmed about 20 GB free. The incomplete observation/startup runs remain excluded and are replaced on the same controller. This pressure coincided with capture failures, but the complete-status size rejection above is independently reproduced and should not be attributed to RAM.

Lucas restarted the Desktop while two candidate `-r2` games and two physical trials were active. Those attempts are void by instruction, with no scored gameplay, deaths or yield. Completed pre-reboot results are retained. Restart recovery verified the Desktop hostname and boot time, then recorded eleven successful SSH checks over 304 seconds and a successful `win-long.sh desktop-lan status` before admitting any replacement. A Mini PC live job waited through `slot.sh` while all three slots were occupied, then was cancelled before admission; it never launched a game. The later Desktop-wide stop also voided both active `-r3` games and an unfinished evidence copy. No Desktop status, copy, build or game command was issued after that instruction. Only the already collected snapshot is usable. Uncollected completed physical attempts are not reconstructed from progress messages; eight missing arm/seed/repeat cells were queued on the Mini PC through `slot.sh`, preserving the controller and exact jar. Two additional candidate salt-2 repeats on the Mini PC match the host of their replacement base arms. `primary-cohort.json` freezes the primary host assignments before Mini outcomes: both arms use the Mini PC for 8675309 repeat 3, and 987654321/20261024 repeats 2 and 3; the other seven pairs use the Desktop. The two retained candidate Desktop salt-2 results remain supplementary. The intended complete matrix would use 14 Desktop and 10 Mini trials, with each pair on the same host. At closeout only 14 Desktop and two Mini primary trials were captured; the remaining scheduled trials were cancelled by the new direction. Host differences across seeds and stochastic mob behavior still limit the rates; the controller never consumes the changed fact. The two missing live games were queued for Mini PC slots, but neither launched before the gold phase closed. Interrupted attempts never replace their outcomes.

## Remaining limits

Gold phase closed by explicit user redirection; unfinished gold bars are reported above rather than filled with interrupted trials. This sample cannot prove safe bastion entry, unseen source discovery, repeated barter completion or twelve-pearl reliability. The final container wording has no separate live-game rerun. Geometry ceilings cannot replace actual player rates. Same-family judging and short first-action probes limit the decision result.


## Gold phase closeout

The gold source and guard facts are retained as secondary-source support. No measured decision or full-game pearl improvement is established. Both completed candidate games ended with zero gold, zero pearls, zero handovers/dropped ingots/heard barter starts; deaths were 5 and 1, including one ordinary-piglin death in the first game. The original four-game and complete physical-repeat bars remain unmet. Required build, full-suite and contract gate results above are retained from the exact unchanged production files; the resumed focused tests pass 95/95. Operator evidence is frozen in `gold-final/measurements.json`. No Desktop action was taken during the resumed work.
