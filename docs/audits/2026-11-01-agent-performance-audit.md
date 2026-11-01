# In-game agent performance audit, 2026-11-01

This is a follow-up to [the full repository audit](2026-11-01-full-repo-audit.md). That one covered code quality. This one asks a narrower question: **how well does the agent actually play Minecraft, and what would make it play better?**

It is read-only. No code was changed and no model provider was called. It draws on four sources:

1. **Evidence.** Every measurement already in the repo: `evals/`, `reports/`, `docs/live-qa/`, `docs/technical-catalogue.md` and `PROJECT_LOG.md`.
2. **Decision loop.** The path from a world event to a model turn to a body action. Offline benchmarks were run, plus new experiments against the real coordinator code.
3. **What the model sees.** Real wake inputs, rebuilt from decision-eval fixtures and read the way the model reads them, with the strategy text checked against vanilla mechanics.
4. **Body competence.** The Java controllers and reflexes, judged the way a skilled player would judge them.

Items marked **(re-verified)** were re-checked by hand against the code, or the experiment was re-run, before going into this report. Numbers are labelled **measured** or **estimated**. Most measured games used Codex `gpt-6.1-sol` at low effort.

---

## Where the agent stands today

| What | Result | Source |
|---|---|---|
| Fresh-world game beaten | **Never.** Best on record: casting a Nether portal at about 68 min, then death. Every later stage was only measured from prepared checkpoints. | `docs/live-qa/2026-10-17-fullgame-deaths.md` (2 games) |
| Dragon kill from an End checkpoint | 1 of 4 games after the End fixes (0 of 7 before). Crystals cleared 4/4. | `reports/d38-dragon.md`, `reports/d38-endfix.md` |
| Ender pearls, barter route | 0 pearls in 6 games | `reports/d39-pearls4.md` |
| Ender pearls, warped forest | 14 pearls in 4 x 60 min (about 17 min per pearl). 0 games reached 12. $42.53 total. | `reports/d39-warped4.md` |
| Blaze rods | Never measured with a real model. The scripted stand-in passed 1/6. | `evals/d39-blaze6/REPORT.md` |
| Nether travel | About 5 blocks/min with the model alone. 182 of 345 `navigate_to` calls failed. | `docs/technical-catalogue.md:1375-1386` |
| Digging down to the y-55 lava floors | 100-116 min with the model driving, where a player needs about 15 | `docs/technical-catalogue.md:1351` |
| Deaths | **1.76/h** across 23 games (22.2 h). 2.0/h on first lives in the End, more than half of them void falls. | `evals/d38-measure/*.json`, `reports/d38-endfix.md` |
| Model calls | 6.9 decisions/min. Median decision 3.0-5.3 s. | `evals/d38-measure/` timing |
| Cost | About 113k input tokens per call (96% cached). About $10.5 per game (simulator estimate). About $10.6 per game-hour (measured, warped forest). | catalogue, `reports/d39-warped4.md` |
| Reaction to a threat | Wake reaches the provider in 24-66 ms. **The model's first flee comes 4.0-4.2 s after the threat** (2 samples). A creeper fuse is 1.5 s. | `docs/live-qa/2026-10-17-reflex.md` |
| Decision quality (decision-eval) | 59-60% "good" on the quick set. Pearls 12%, dragon after crystals 33%, recovery 2/12. | reflex, pearls4, dragon and recover reports |

### Where the time goes

The single biggest finding: **the body spends most of its time standing still, waiting for the model.**

- **Measured, live, one oak log, p50 20.8 s:** the model took 10.6 s, the gaps between actions 5.7 s, and physical actions 5.3 s. The body was moving about **26%** of the time. (`reports/opus-speed-benchmark-2026-09-25.md`, Codex `gpt-6-sol`/low/priority) **(re-verified)**
- **Measured, random-seed games:** the body was idle **55-67%** of play (62-66% in the Nether). One game made 1,554 `break_block` calls. (`docs/technical-catalogue.md:1351`) **(re-verified)**
- **Measured, offline overlap benchmark:** serial actions took 16.25 s against 11.75 s when the next decision overlaps the current action (-27.7%).

Most of the improvements below are versions of one idea:

> **Stop handing control back to a 5-17 second model for things the body could handle in one tick, and stop paying for model turns that change nothing.**

---

## The top 12 improvements

Ranked by expected impact on survival, progress and cost, against effort.

| # | Area | Change | Why | Effort |
|---|---|---|---|---|
| 1 | Wake policy | **Stop interrupting the agent's own fight for every hit.** | **Measured (re-verified):** in a 20 s zombie melee the coalescer delivers 12-14 steers, and each one cuts the running `fight_target` short and forces a model call. Three zombies over 30 s give 17. Each call re-reads 60-100k cached tokens plus about 8 KB of fresh observation. The cause is that `nativeSteerInterruption` treats any `damage` trigger as an interruption, even from the mob already being fought (`dynamic-main.mjs:6427,2394`; `danger-steer-coalescer.mjs:13`). | S |
| 2 | Wake policy | **Stop re-waking an idle model for noise.** | **Measured (re-verified, against the real coordinator with a fake planner):** while no action is running, each of 20 heartbeats changing one tiny thing triggered **20 extra provider turns**. The changes tested were a cow 20 m away drifting 0.1 block, view yaw, saturation ticking down, 0.01 block of position drift, and a non-targeting zombie 40 m away. A static world gave 0. The cause is that the observation signature includes unrounded positions, yaw, velocity and saturation (`dynamic-main.mjs:1141-1214,7831`). Fix: round to blocks, drop yaw, velocity, saturation and distant passive mobs, then send one explicit continuation wake and back off. | S-M |
| 3 | Reflexes | **Add default reflexes for the dangers that kill faster than the model can answer.** | **Re-verified:** only four defaults exist (lava, fire, air, edge; `reflexes.mjs:20-25`), against a 5-17 s decision. A creeper fuse (1.5 s) and an incoming arrow (about 1 s) wake the model, but the paid turn can only react after the fact. Add these as defaults the model can switch off: `creeper_fusing -> sprint_away`, `incoming_projectile -> shield` (when held), `falling -> water clutch`, `suffocating -> dig out`, and `hurt and safe and hungry -> eat`. When a rule has handled the danger, downgrade the wake to a summary. | S |
| 4 | Body | **A fight bail-out should flee, not stand still.** | **Re-verified:** `fleeAtHealth` has no default (`ServerActionExecutor.java:894`), so `fight_target` fights to the death. When it is set, the bail-out returns "body idle, no retreat performed" (`ServerFightUntilController.java:393`; `ServerFightController.java:356`). The code's own comment records a death 3.5 s after a bail-out, and several measured deaths follow `LOW_HEALTH_BAILOUT`. Fix: default floor of about 6 HP, then backpedal behind the shield or flee until the next command. Add `onBailout: flee/dig_in/shield`. | S |
| 5 | Body | **Melee should respect the creeper fuse.** | **Re-verified:** fight code reads `getSwellDir()` only to add "(swelling)" to a status message (`ServerFightController.java:1186`). A creeper is treated as a 3-block-reach mob, and the body keeps stepping in for hits. Travel `fightThrough` also attacks creepers within 6 blocks (`ServerTravelController.java:279-283`). Fix: when it is swelling, back off past 7 blocks (vanilla cancels the fuse there) and re-engage. Leave creepers out of `fightThrough` unless the model named them. | S-M |
| 6 | Loop | **Let the body keep working while the model thinks.** | `act` blocks by default, and `startAction` and `queueProgram` are opt-in. **Measured:** overlapping saves 19.5-27.7% wall-clock. Fix: long actions (navigate, travel, mine, dig_to, counted fights) return a handle once accepted. Add a "keep doing the current intent until the model replies" mode. | M |
| 7 | Body | **Fix burning after lava.** | The `LeaveFire` reflex holds the body still while it burns (`ReflexActions.java:2014,2103`). Leaving lava means about 15 s of burn at about 1 HP/s, with the action paused. Fix: place a carried water bucket at the feet and scoop it back (Overworld), or step into seen water. Several measured deaths were "burned" or "tried to swim in lava". | S |
| 8 | Body | **Smarter food choice in the eat reflex.** | **Re-verified:** the reflex takes offhand food, otherwise the hotbar food with the highest nutrition (`ReflexActions.java:556-571`). It ignores saturation and bad effects, so rotten flesh (4) beats a carrot (3), and spider eye, pufferfish and chorus fruit are all eligible. Golden apples are eaten as ordinary food. Fix: score by how much of the hunger gap it fills plus saturation, penalize bad effects, and keep golden apples for `health_below`. Also back off one or two safe cells before eating when a hostile is in reach, since eating stands still for about 1.6 s. | S |
| 9 | Wake input | **Cut the noise out of danger wakes, and put the summary first.** | **Measured (re-verified):** an urgent wake is 6-18 KB (about 4.5k tokens) on top of a 70 KB static prefix. In a 9 HP zombie bail-out, the useful lines sit beside 4.2 KB of block and item tags (grass alone has 27, such as `sniffer_diggable_block`), coordinates to 16 decimals, snow-block landmarks and sound rows. Order today is danger, then a 12-14 KB observation, then `now` and situation, although the instructions say to read `now` first. Fix: on urgent triggers, drop the tag maps (keep `mineable/*`, logs, planks), round to 0.1, drop landmarks and sounds, and order danger -> now -> situation -> observation. Rounding plus dropping entity bounds alone **measured -17%** on a steady wake. | M |
| 10 | Body | **`mine` and `break_block` should pick the tool.** | `mine` never selects a tool, although `dig_to` already has a chooser (`ServerDigController.java:1461`). Every block costs `select_tool` plus `mine`, and ore can be mined with too weak a pick and lost. Also add a whole-tree / ore-vein action. Gathering 8 logs took 182-222 s (measured). | S-M |
| 11 | Config | **A lighter default Codex profile for real-time control.** | **Re-verified:** `config/dynamic-agents.json:26-30` launches `gpt-6-luna` at **`xhigh`** reasoning on the `default` tier. The speed benchmark that produced good numbers used `sol/low/priority`. Use low or medium effort plus priority for control turns, and keep high effort for planning. | S |
| 12 | Strategy | **One Nether pearl route, everywhere.** | AGENTS.md:33 says warped-forest endermen are the main route and bastions are "not the default". The plan prompt (`goal-spec-translator.mjs:166-167`) still builds gold and bastion steps, leads with barter maths, and mentions warped forests only in passing. AGENTS.md:35 tells the model to follow `now.plan`, so it gets mixed signals. The measured results already decided this: barter gave 0 pearls in 6 games, the warped forest 14 in 4. **(re-verified, softer than first reported: the two texts disagree on emphasis rather than contradicting outright)** | S |

---

## Everything else, by area

### A. Model turns and latency

| Sev | Where | Finding | Fix | Effort |
|---|---|---|---|---|
| Med | `native-tool-runtime.mjs:811`; `ReflexEngine.java:121` | A stale model command can switch off a firing survival reflex. Any body call yields the firing reflex, even one built before the danger. Scenario: Claude is streaming a `navigate_to`, the body steps into lava, `default-lava` fires, then the late `navigate_to` arrives and yields `leave_lava`. | Yield only to calls built from facts that include the firing, or never yield priority 8+ defaults to non-defensive calls. | S-M |
| Med | `arena-script/facts.mjs:50-111`; `program-engine.mjs:55` | **Measured** CPU profile (8 agents, programs): `createInterpreterFacts` takes about 32% of coordinator CPU. ArenaScript copies, validates and freezes the facts 2-3 times per sample. Program step handoff goes from 23 ms at 1 agent to 119 ms at 8 (p95 156 ms), and tool return from 13 ms to 78 ms. | Structural sharing, skip re-validation of the adapter's own output, re-project only what changed. | M |
| Med | `codex-service.mjs:28`; `dynamic-main.mjs:4737` | Codex mid-turn context rotation is off and not even an allowed config key. The project's own comments record contexts up to 450k tokens (mean 113k against a 64k threshold). Turning it on cut cost about 29% but lost a noted fact in 3/3 runs. | Allow the key, and carry seen facts forward through the notebook so rotation doesn't lose them. | S |
| Med | `claude-service.mjs:58-59` | Claude keeps at most 2 warm standby sessions **in total**, and an idle standby is killed after 3 s. With 8-16 agents, most rotations are cold starts (**estimated** 2-5 s stall, not measured). | Scale the cap with agent count. | S |
| Low-Med | `dynamic-main.mjs:2323` | The Claude danger reissue fires once per episode. After that, steers wait for a tool boundary at full effort. | Run danger-started turns at lower effort. | M |
| Low-Med | `wake-filter.mjs:14,150-166` | Under-waking, the counterpart of #1: hits from a "known" mob kind are held until HP is 8 or less, and known kinds never expire. | Wake at 14 and 10, on any hit of 4+, or on fast loss. Expire known kinds. | S |
| Low | `planning-scheduler.mjs:4` | A scheduler slot is held for the whole native turn, including tool waits (up to 900 s). The code default concurrency is 4; the shipped 16/16 config hides this. | Release the slot during body waits. | S |
| Low | `native-program-executor.mjs:16` | A discovery during a background program can reach the model up to 30 s late. | Shorter window for resource sightings. | S |

Prompt caching looked healthy: no volatile fields in the stable prefix, and one system prompt per process or thread. The waste is in how *often* the context gets re-read (findings 1, 2 and the Codex rotation item), not in caching itself.

#### Latency budget, hop by hop

| Hop | Budget |
|---|---|
| Server idle heartbeat | 500 ms (urgent observations are sent at once) |
| Observation ingest | **measured** p50 12 ms |
| Danger steer coalescing | first one immediate, then 1 per 2 s |
| Claude steer delivery | next tool boundary (3-7 s); interrupt ack up to 5 s |
| Model decision | 5-17 s (p95 about 8 s per code comments) |
| Tool call -> command sent | **measured** p50 1.4 ms (1 agent) / 7.6 ms (8 agents) |
| Server admits command | up to 50 ms |
| Result -> tool returned | **measured** p50 13 ms / 78 ms |
| Guard firing -> command | **measured** median 80 ms, max 119 ms |

The coordinator plumbing is fast; the model decision dominates by about 100x. Faster plumbing won't move the needle much; fewer, better-targeted model turns and more body autonomy will.

### B. Body competence

What's already strong:
- **Melee:** swings at 0.9+ charge, spaces itself just outside the mob's real reach, sprint hits, falling crits timed to the charge, irregular strafing, and no circling over drops.
- **Bow:** exact vanilla ballistics.
- **Navigation:** A* with node and time budgets, lava-spread prediction.
- **`dig_to`:** chooses the tool, refuses worn tools, plugs lava, seals water, handles gravel, clutches with a water bucket in shafts.
- **Reflexes:** react in 0-1 tick.

These gaps are on top of the items in the top 12.

| Sev | Where | Gap | Fix | Effort |
|---|---|---|---|---|
| Med-High | `ReflexActions.java:445-480` | The attack reflex swings with whatever is held, often a pickaxe. | Switch to `CombatPlanning.bestWeaponSlot`. | S |
| Med | `MinecraftNavigationWorld.java:1118,1153` | Navigation never opens doors, fence gates or trapdoors, and travel's tunnel fallback can mine a wooden door. Entering or leaving any building costs extra model calls. | Treat wooden doors and gates as passable, with an open-and-close step. | M |
| Med | `ServerTravelController.java:257-287` | `travel_to` hands back on every new hostile within 16 and on any damage (even 0.5 from a berry bush), so a night trip becomes a long series of model turns. | Ignore mobs that aren't targeting or closing. Small tolerance for environmental damage. | M |
| Med | `TravelBuilder.java:33`; `LocalPathfinder.java:19,550` | Travel can't go down: there's no dig-down leg, and drops are capped at 3 blocks even into deep water. | Hand off to a `dig_to` stairs_down leg. Allow drops into water 2+ deep. | M |
| Med | `ServerDigController.java:1454` | A full inventory stops strip mining, with no junk handling. One forest game picked up +91 cobble, +49 deepslate, +38 diorite, +23 andesite. | Optional drop of cobble, dirt, gravel, netherrack and similar beyond about 64. | S |
| Med | Forest games | Iron pickaxes broke at about 30 min, and one game spent 28 min re-kitting (6 wooden picks). | Show tool uses left against planned work, and suggest the replacement craft in `now.craft`. | S-M |
| Med-Low | `ServerFightController.java:512` | The shield drops and re-raises on every swing, ignoring the 5-tick raise delay and the mob's 20-tick attack cycle. | Swing just after the mob's swing (the reflex shield already detects mob swings). | S-M |
| Med-Low | `use_ranged` | Stands still while drawing, and doesn't back off from a closing melee mob. | Back off while charging, and switch to melee inside about 4 blocks. | M |
| Med | Piglins | Brutes killed agents 3 times in one travel game, and a piglin death lost 3 pearls. Forest starts wear iron, not gold. | Gold-piece awareness in the kit and the plan. Brute avoidance. | M |
| Low-Med | Armor | No automatic equip or upgrade, and no totem moved to the offhand. | Auto-equip better armor. | S |
| Low | `ReflexActions.java:881` | The water clutch fails in the Nether (water evaporates), with no fallback. | Fall back to hay, slime, ladders or twisting vines. | S |
| Low | `LocalPathfinder.java:42,535` | 4-direction moves only, and gap jumps clear just 1 block, so the agent bridges gaps a sprint jump would clear. Powder snow counts as a hazard even with leather boots. | Diagonal moves and sprint jumps. Model the boots. | M |
| Med (End) | End fight | Dragon landing windows are 4-5.75 s; a first model call takes about 7.2-7.5 s. Void falls were 19 of 35 End deaths before the fix and still happen. No bed tactic was used. | A local "perch window" behaviour (rush and melee the head on landing), plus edge-aware positioning. | M-L |

**Untested at world level:** creeper melee, food choice, reflex weapon switch, putting out an afterburn, door routing, travel descent, tree felling, and the Nether clutch. Each fix above should come with a world-level verification.

### C. What the model sees

These come from rebuilding real wakes from decision-eval fixtures (sizes **measured**).

| Wake | Encoded | Of which tags |
|---|---|---|
| Fight bail-out, 9/20 HP, 2 zombies in reach | 17.2 KB | 4.2 KB (25%) |
| Blaze plus 3 wither skeletons | 17.9 KB | 2.3 KB |
| Nether fortress search (idle) | 17.5 KB | 2.1 KB |
| Night, bed craftable | 16.6 KB | 4.2 KB |
| Action finished, iron pick craftable | 11.7 KB | 1.5 KB |
| Creeper at 4.7 m | 8.9 KB | 2.0 KB |
| Respawn / new context | 6.1 KB | 1.2 KB |

| Sev | Finding | Fix | Effort |
|---|---|---|---|
| Med | **Facts a human always has are missing:** respawn point (the strategy guide asks "where would I respawn?"), light level at the feet, free inventory slots, saturation (only implied by `hungerShaking`), hunger trend and armor durability. | Add `spawn:`, `light:`, `bag: 22/36`, `saturation:` lines. | S |
| Med | Duplicated payload: `observation.recovery` lists the inventory twice (about 1.1 KB), and `tagCounts` carries 40+ tags such as `#minecraft:completes_find_tree_tutorial`. | Drop both. | S |
| Med | Phase-specific options leak into other phases: a 1.2 KB pearl and bastion essay in a blaze fight in basalt deltas, and piglin barter rules where no piglins are. | Gate by dimension and step. | S |
| Low-Med | Wake signals contradict each other. A creeper wake says "Choose flee_from now" while the creeper is not swelling and is moving away (`approaching:false`). It reports `visible:null` despite `lineOfSight:true`, and "weapon none" while `bestWeapon` is the wooden pickaxe. | Make the wording follow the actual signals. | S |
| Low | A zombie bail-out wake rendered `trigger:"resource_discovery"` (`classifyObservationTrigger`, `dynamic-main.mjs:5964`). May be a replay artifact; worth checking. | Check. | S |
| Low | Numbers without units (`risk 136.8`, `contactRisk`). "ACTION_TIMEOUT: newer navigate_to running" doesn't say what to do next. | Units, plus a next step in error text. | S |

Also see the full repo audit, area 2. ArenaScript crashes on optional facts like `hazard` and rejects string + number, and the real error message never reaches the model. Those three fixes matter a lot for agent-written guards.

### D. Instructions and strategy

Checked and correct against vanilla Java: food and saturation values, regen thresholds, starvation limits, lava spread, air, suffocation, fuel values, iron golem drops, pearl barter odds (about 2.1%), eye break chance, the stronghold ring, crystal blast damage, and enderman stats.

| Sev | Finding | Fix | Effort |
|---|---|---|---|
| High | **The enderman hunt has no gear check.** AGENTS.md:33 says "while pearls and eyes are below 12, take a near enderman", and the Overworld iron-stage wake still suggests it with a wooden sword, no armor, at night. An enderman kills an unarmored player in 3 hits, and a wooden sword needs about 10. | Require an iron sword (or stone plus armor) and full health. Default to the roof shelter when unarmored. Hide pearl lines before the Nether step. | S |
| High | **Guard templates require `threat.visible` and skip creepers when there's no exit** (`standing-templates.mjs:18,41`, re-verified). The evidence report found guards installed in 97.7% of threat observations, but a condition true in only 6.7%, and all 3 deaths in the reflex game had no guard defence. The guidance was fixed, but the template still has the old conditions. | Align the templates with the fixed guidance. | S |
| Med | Five overlapping safety mechanisms with no rule for which to use: reflexes, standing guards, `program.watch`, `onUnhandledAttention`, and "guard mining with watches". | One decision table: reflexes for reactions under a second, standing guards for multi-step escapes, watchers only inside programs. | S |
| Med | Missing skilled-player strategy. Armor priority (chestplate then leggings give the most per ingot; a shield is the best single ingot after pick and bucket). Shield up at a cornered creeper. First-night pillar or 1x1 hole. Eat to 20 before a fight for fast regen. 12 eyes is tight (about 10.8 empty frames plus breaks), so 13-14 is safer. Golden boots (4 gold) are cheaper than the helmet (5) the code offers (`need-sources.mjs:570,712`). | Add to the strategy guide. | M |
| Med | Saved-program reuse is still taught (`control-reference.md:27`) against "no named saved routines" (AGENTS.md:53, SKILL:26). | Remove. | S |
| Med | Version drift: `strategy-guide.md:3` says 26.1.2 game data while the index and foods are 26.3. Some 26.1-specific claims need checking. | Regenerate against 26.3 data. | S |
| Low | Missing tools: no `eat` act action (it goes through `use_item` with a duration), no `sleep`, and no "gather N of block X" counterpart to `fight_until`. | Add them. | M |

### E. Measurement gaps

These are what's missing before you can tell whether any of the above worked.

- **No random-seed full-game benchmark.** There's no stage-reach rate (iron, Nether, rods, pearls, End) and no time-to-milestone distribution. Everything after the Overworld is from checkpoints. This is the most important missing metric.
- **Body idle share isn't tracked per run.** It's the best single indicator of the main problem here and should be a headline metric on every run.
- **Wasted turns aren't tracked.** Model turns per useful action, and turns that end with no action, should be per-run metrics. Findings 1 and 2 would show up immediately.
- **Death attribution:** in all 15 death traces, there's no record of whether the model, a reflex or a controller was in control at death.
- **Blaze and dig have no real-model runs;** only scripted stand-ins have been measured.
- **Reaction time to a threat has 2 samples.** It needs a live distribution.
- **Token accounting is incomplete:** long-run reports are marked INCOMPLETE, and the eval's `modelCalls` shows 0. There's no cost-per-milestone figure.
- **Decision evals mostly grade the first call** (261 of 275 cases have no continuation), and the judge is the same model family.

---

## Suggested plan

**Phase 1: quick wins, all S effort.**
- Top 12 items #1-5, #7, #8, #11 and #12, the attack-reflex weapon switch, the guard-template alignment, and the enderman gear check.
- These mostly flip defaults or add a few lines each.
- Expected effect (**estimated**): far fewer model turns in fights and while idle; fewer creeper, burn and bail-out deaths.

**Phase 2: medium.**
- #6 (keep the body moving), #9 (lean danger wakes), #10 (tool auto-select and tree/vein actions).
- Doors, travel descent, travel stop tolerance, and the ArenaScript fact-copy CPU cost.

**Phase 3: measure.**
- Build the random-seed full-game benchmark, reporting stage-reach rates, body idle share, turns per useful action, deaths per hour by cause and controller, and cost per milestone.
- Run it before and after phases 1 and 2. Per AGENTS.md, each result goes into `docs/technical-catalogue.md`.

**Bigger bets for later:**
- A local dragon "perch window" behaviour.
- A blaze-farming routine with cover.
- Piglin and brute awareness.
- An overall shift toward the body owning multi-step intents ("get 12 pearls in this forest") with the model supervising, rather than the model driving each step.
