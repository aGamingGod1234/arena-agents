# Warped-forest pearls, d39-pearls4

Branch `claude/d39-pearls4`, based on `4682f12e`. Gold closeout: [d39-pearls4](d39-pearls4.md).

The primary pearl route is now warped-forest endermen. **Oct 26 result: Sol earned pearls for the first time.** In four valid 60-minute Sol low/default games from the forest starts it ended with 5, 4, 5 and 0 pearls (14 total; the 0 is a game that held 3 and lost them all on one death). See [Oct 26 takeover](#oct-26-takeover-pocket-fix-and-measured-results). The sections after it describe the Oct 25 implementation and are kept as written; their "not measured" statements are superseded.

## Oct 26 takeover: pocket fix and measured results

Taken over from helper d39-pearls4 at `7fe53d3e`. All work on the Mini PC through the shared live-slot locks; nothing on the Desktop.

### The blocker and the fix

The calibration stopped at `NO_OBSERVED_FLAT_3X3_SITE`: the stand-in searched the observed blocks for a flat 3x3 floor, and the forest starts have none. Five calibration runs then showed why each simpler build fails on real terrain:

| Calibration | Seed | What happened | Cause | Fix |
|---|---|---|---|---|
| 4 | 123456789 | Floor fill worked; third pillar block refused (`SUPPORT_FACE_HIDDEN`) | A block's top face above eye height cannot be clicked, so a roof two blocks above the feet cannot go on a pillar | Roof at head height, then dig out the floor and drop in: a dug 2-high pocket |
| 5 | 123456789 | Dig refused (`LAVA_BEHIND`) | The start sits on the shore of the lava sea; lava under and beside the floor | Leave lava sites; scaffold each roof block |
| 6-8 | 123456789 | Every site within 6 moves still showed lava | The shore is a thin crust over the lava sea | Only lava right under the pocket rules a site out up front; the body's own `LAVA_BEHIND` refusal decides the rest; after 6 sites, hunt in the open |
| 9 | 8675309 | 4 edge roof blocks placed, all 4 corners refused, at 6 sites | Edge roof blocks hid the corner scaffolds' top faces | Corners first, then edges (edges use the corners' near faces) |
| 10 | 8675309 | **Pocket built in 13.4 s; one enderman killed from it at full health** | | |

The tactic (`scripts/quality/test-warped-pearl-live.mjs`, test-only): fill lower neighbouring floor cells; for each roof cell, place a temporary block under it, place the roof block at head height on that block's top face, remove the temporary block; dig out the floor under the player and drop in; roof the centre. The result is a 2-high pocket an enderman cannot enter, with 1-high gaps at leg height to fight through. To collect a pearl it breaks the roof and floor of the edge cell facing the pearl, steps out, returns and re-roofs. The stand-in also fights anything attacking it (forest starts wear no gold, so piglins attack) and uses a shield stance only with a shield in the offhand; both bugs killed an earlier trial.

Sol's guidance (`coordinator/config/minecraft-agent/AGENTS.md`, pearl paragraph) now says the same in one sentence: forest ground is rarely flat, so build where you stand (fill lower cells, 2-block corner pillar, roof at head height because a top face above the eyes cannot take a block, dig out the floor and drop in; leave by opening one edge cell). +229 bytes over the Oct 25 sentence (no pinned byte budget covers this file; no budget was changed); the contract claim was refreshed and re-approved with its original predicate. All four Sol games ran this guidance (frozen player `aa-d39-warped4-live` at `99d8a493`).

### Bar 3 (main): real Sol games

Sol `gpt-6.1-sol`, low, default tier on every player turn (provider-reported), 60-minute wall-clock window, goal "Beat the game. First gather and retain 12 ender pearls here; prefer warped-forest endermen, with seen gold and held ingots as secondary supply." Launched through `evals/d39-warped4/supervise-live.mjs` (the same `run-long.mjs` arguments as `api/long-sub.sh`, plus the 10-minute provider-stall void guard). Every launch passed a one-line `codex exec` probe (5-8 s answers).

| Seed | Pearls held at end | Peak | First pearl | Endermen killed | Pearls picked up | Deaths (cause) | Minutes per held pearl | Longest provider wait | Cost |
|---|---:|---:|---:|---:|---:|---|---:|---:|---:|
| 8675309 | **5** | 5 (51 min) | 19.2 min | 9 | 5 | 0 | 12 | 58 s | $13.96 |
| 987654321 | **4** | 4 (58 min) | 4.5 min | 14 | 4 | 0 | 15 | 21 s | $11.76 |
| 20261024 (r2) | **5** | 5 (47 min) | 12.4 min | 7 | 5 | 0 | 12 | 97 s | $9.80 |
| 123456789 | **0** | 3 (17 min) | 3.6 min | 6 | 3 | 1 at 31.9 min: killed by a piglin, "tried to swim in lava to escape Piglin" | none | 16 s | $7.02 |
| **Total** | **14** | | | **36** | **17** | **1** | **17.1** (240 min / 14) | | $42.53 |

Pearls held at the end: 3 of 4 games. 17 pickups from 36 kills is 0.47 per kill, in line with vanilla's 0.5. At the pooled rate, 12 pearls take about 3.4 hours of forest hunting.

What Sol did after the first pearl: in the three surviving games it kept hunting to the end of the window (fight_target in every 10-minute bucket; build_shelter 12-21 times per game, mostly enclosed shelters with one opening). The tool crafting after about 30 minutes in those games is **not a death**: the iron pickaxe broke (vanilla `broken` stat, one iron pickaxe in each), and Sol crafted sticks and a stone pickaxe (wooden pickaxes first in 8675309). Heavy shelter building and digging used up the pickaxe. In the seed 123456789 game, Sol wandered about 190 blocks from the start, fled a piglin into lava and died with 3 pearls; after respawning at the Overworld camp it spent the remaining 28 minutes re-kitting (crafted 6 wooden pickaxes and broke all 6, 32 oak planks, 2 crafting tables) and never returned to the forest.

Void runs, not scored: seed 20261024 r1 (I stopped its worker by mistake at about 50 of 60 minutes); seeds 8675309 and 123456789 round b (Sol replications stopped about 10-20 minutes in when the orchestrator moved further games to Luna to save the weekly Codex quota).

No same-start base arm exists: earlier Sol games all started at portals or bastions and ended with 0 pearls, so these results show that Sol earns pearls from a forest start with this guidance, not how much of that is due to the guidance versus the start.

### Bar 1: model-free stand-in, pearls per 20 game minutes

Zero provider calls; production jar, observations and action validation; natural spawns and vanilla loot. Two salts per seed, 24,000 ticks each, all on the controller at `99b6a507` (sha256 `36c8755d…`, identical in all 8 results; the cohort was restarted after the attacker/shield fix). One run per salt; no reruns replaced a result.

| Seed / salt | Cover | Built after | Endermen seen | Killed | Pearls picked up | Pearls held at end | Deaths |
|---|---|---:|---:|---:|---:|---:|---|
| 123456789 / 1 | pocket | 45 s | 21 | 1 | 1 | 1 | 0 |
| 123456789 / 2 | open (no lava-free site in 6 moves) | - | 29 | 2 | 0 | 0 | 1, lava during a fight |
| 8675309 / 1 | pocket | 13 s | 6 | 2 | 0 | 0 | 0 |
| 8675309 / 2 | pocket | 13 s | 5 | 1 | 1 | 1 | 0 |
| 987654321 / 1 | pocket | 14 s | 4 | 2 | 1 | 0 | 1, piglin (at 7,520 ticks) |
| 987654321 / 2 | pocket | 14 s | 4 | 1 | 0 | 0 | 0 (killed 4 piglins) |
| 20261024 / 1 | pocket | 48 s | 12 | 1 | 0 | 0 | 0 |
| 20261024 / 2 | pocket | 33 s | 14 | 1 | 0 | 0 | 0 |
| **8 trials** | 7 pocket, 1 open | | | **11** | **3** | **2 (0.25 per 20 game minutes)** | **2** |

What this shows:

- The pocket builds on real forest terrain in 13-48 s on every seed except the lava-shore start, where 1 of 2 trials found no site.
- A stationary pocket gets few fights: 1-2 kills per 20 minutes, because only endermen that wander within reach can be fought. Sol, which moved between shelters, killed 6-14 per hour and picked up 1.2 pearls per 20 minutes (14 held in 240 minutes), about 5 times the stand-in's 0.25.
- The pocket protects against endermen only. A piglin (1.95 blocks tall) fits through its 2-high side cells, and forest starts wear no gold armour: piglins caused one of the two stand-in deaths and the only Sol death (which lost 3 pearls). A gold helmet from the start kit, or a pocket with closed sides plus a 1-high fighting slit, is the obvious next fix; neither was tested.
- Kills with no pickup (8 of 11) are vanilla: 0-1 pearls per kill, average 0.5; one dropped pearl in trial 987654321/1 was picked up before the piglin death.

### Luna low games

LUNA_PLACEHOLDER

### Gates

Run twice through the slots, at `db353d84` and again at the report commit (after the final guidance edit):

- `./gradlew build verifyCore`: PASS (2,577,418 protocol/core and 442 voice assertions).
- `npm test`: 7,086 tests, 7,000 pass, 11 fail (the known Windows-path tests), 75 skipped.
- `npm run test:contracts`: 639/639.

### Unverified

- Travel from the portal to a forest: every game starts in the forest.
- Pearls in a full game: no game reached 12 pearls or went on to the stronghold.
- The four forest seeds are the only ones tested; there is no held-out forest.


## Player behavior

`coordinator/config/minecraft-agent/AGENTS.md` explains the player tactic: arm `enderman_gaze → look_away` at priority 9 in the first Nether call, for the hour-long window; keep movement at priority 8 or below. The model chooses a three-by-three ceiling with two blocks of clearance or a two-high dug pocket, the individual target and when to provoke it. It deliberately suspends the gaze rule only to stare at its chosen enderman, looks down and restores the rule before fighting. It uses existing `look_at`, `place_block`, `navigate_to` and `fight_target` actions, with `pursue:false` and shield support. An already angry enderman needs no additional stare. The model collects witnessed drops and changes an unreachable position rather than repeatedly pursuing outside cover.

`need-sources.mjs` places the forest route ahead of gold, including when a bastion is known but no forest is yet known. Discovery remains visible exploration. Seen ore along travel and held currency remain secondary supply; guarded mining can anger unseen piglins. There is no new production body action or model-callable saved hunting routine. No additional byte budget was added for this phase; the earlier gold change's exact 322-byte increase remains.

## Operator-only forest survey

`evals/d39-warped4/survey.mjs` located each biome with `/locate biome minecraft:warped_forest` and selected a natural standing point with two air cells above nylium. It placed no forest shelter, mobs, pearls or terrain. Locate output is separate operator evidence; it is absent from player instructions, observations and memory.

| Seed | Locate distance | Prepared start x,y,z | Horizontal portal distance | Height change |
|---|---:|---|---:|---:|
| 123456789 | 480 m | -287.5,32,-378.5 | 480.0 m | -33 |
| 8675309 | 532 m | 464.5,79,285.5 | 532.6 m | +2 |
| 987654321 | 320 m | -191.5,63,261.5 | 326.4 m | +2 |
| 20261024 | 445 m | -167.5,49,-418.5 | 448.6 m | -33 |

On these four seeds the prepared starts are 326–533 m from the portal horizontally, median 464.3 m. Raw locate distances have median 462.5 m. These are nearby enough to test as separate pearl-stage starts, but no safe walking route, travel time or return journey has been demonstrated. The sample does not establish a distance distribution across arbitrary seeds.

The checkpoints are `evals/d39-warped4/checkpoints/10-warped-forest-<seed>-v2.json`, also installed under the shared `long/checkpoints/` directory. Each has full unenchanted iron armour, sword, pick, shield, 32 cooked beef, 128 cobblestone, wood and ordinary stage supplies, with two existing gold ingots. No gold armour is worn at the forest start. Original portal and used Overworld bed camp remain, including its original spare gold helmet for recovery through piglins. The test does not traverse a piglin route to the start. Chunk tickets stay within the existing eight-ticket bound: five per fixture. All four passed fixture schema normalization; the operator verified the natural biome/floor positions. Full player setup has only been instantiated on the first seed so far.

## Measurement entry points and missing outcomes

The test-only `scripts/quality/test-warped-pearl-live.mjs` uses the production jar, ordinary action validation and production player observations, with zero provider calls. It builds its cover using seen floor/support cells and ordinary carried blocks, then selects one visible, nearby enderman. Natural spawning and vanilla loot remain enabled. Construction time counts in the game-time window. A death ends the opportunity and scores zero retained pearls; a harness error is unavailable. It records inventory, kills, pickups, deaths, action outcomes, game ticks and artifact hashes. It is never exposed to Sol.

The formal cohort is three 24,000-tick (20-game-minute) trials per seed, salts 1–3, on the identical jar and frozen controller/checkpoints. The two-minute calibration is excluded. No base forest arm is claimed: this phase measures the requested forest tactic directly; earlier gold/open-enderman experiments are different starts/controllers.

| Bar | Available result |
|---|---|
| Model-free pearls per 20 game minutes, three repeats per forest; deaths | **0/12 formal trials available. Yield and deaths unavailable.** |
| At least three real Sol low/default 60-minute games | **0 valid games. Holdings, enderman kills, deaths and time per pearl unavailable.** |
| Fresh short reply within 30 seconds before every launch | Six retained short probes failed, including the 01:31 Singapore-time refresh. No forest game launched. |
| Void games with a provider stall of at least ten minutes | Six timing-state tests pass; a recorded long-stall queue trace is detected as void. Real-game signal shutdown remains unverified. |

Calibration 1 failed before gameplay because the initial fixture requested ten chunk tickets (maximum eight). The corrected fixture uses five. Calibration 2 instantiated the setup but failed before the hunting window because reflex priority 10 was invalid (maximum nine). The guide and controller now use nine. Neither attempt is a zero-pearl trial. Calibration 3 uses the corrections and has not acquired a live slot as of the report snapshot. Its queued unit was restarted at 00:31 Singapore time; no result directory or gameplay output exists yet.

Readiness checks use the unchanged production `CodexStdioTransport`, explicitly request `gpt-6.1-sol`, low, default at both thread and turn start, and never select fast/priority or a fallback model. The latest completed exact-launcher probe observed the requested model/default tier and acknowledged its turn in 275 ms, but delivered no answer within 30 seconds. Acknowledgment is not readiness. Earlier queue games sometimes received responses; these failures do not establish a global continuous outage.

`provider-stall.mjs` tracks actual model-response boundaries, excludes body execution while tools are pending, preserves a continuous provider wait across planning-timeout retries, and makes a ten-minute violation sticky even if a late answer arrives. Replaying the retained queue trace detects an 18.7-minute completed provider wait. This validates trace classification, not process shutdown in a newly stalled game.

`run-games.sh` probes before queueing and again after live admission. It runs Sol low/default for 60 minutes with the goal: “Beat the game. First gather and retain 12 ender pearls here; prefer warped-forest endermen, with seen gold and held ingots as secondary supply.” This is a pearl-stage cue from a prepared start, not a test of discovering/travelling to a forest from the portal. The collector requires a completed wall-clock window, model/tier provenance, no stall/monitor error and an inventory sample within 15 seconds of the ending. Time per retained pearl is the entire 60 minutes divided by ending holdings; zero holdings have no finite rate. It scores only after the supervisor finishes, avoiding a cached intermediate inventory.

## Durable status and contention

All work runs on the Mini PC. No Desktop command was issued. Heavy jobs use `arena-beat-game/slot.sh`; its shared live count is three and the queue currently holds one. No other helper was stopped or any slot limit changed.

Own active units are `d39-pearls4-warped-calibration3` and `d39-pearls4-warped-driver`. The driver waits for a successful calibration, freezes hashes and the player checkout, runs two slot-managed physical workers, validates the full twelve-trial matrix, then admits the four seeded Sol games through two workers with readiness/stall guards. It stops on a broken physical harness rather than silently replacing a failed result. Final outcome checks are still needed; background launchers are not measured outcomes.

Status lives at `/home/agaminggod/Desktop/Projects/arena-beat-game/evals/d39-warped4/driver-status.json`; calibration log is the adjacent `d39-warped4-calibration3.log`. Measurements, probes, per-trial actions and final summaries remain under `evals/d39-warped4/` in the shared evidence checkout. Frozen player files live in `aa-d39-warped4-live` at `a69198da`. Operator/report commits made afterward do not change that player's production files.

## Gates

Final source checks on the Mini PC, through the appropriate slots:

- `./gradlew build verifyCore --offline`: PASS, 2,577,418 protocol/core assertions; build successful.
- `npm test`: 7,086 total, 7,000 pass, 11 known Windows-dependent failures on Linux, 75 skipped.
- `npm run test:contracts`: PASS, 639/639.
- Focused forest source ordering, appearance budgets and provider-stall state checks: PASS, 14/14.
- `git diff --check`, launcher shell syntax and operator Python syntax: PASS.

No body fix or pearl-production improvement is established. Natural spawning availability, canopy construction, enderman provocation/leg fighting/pickup and Sol's continued decisions all still require the queued live measurement. The original gold phase's unmet bars are explicitly closed by Lucas's route change, not filled using interrupted or stalled games.
