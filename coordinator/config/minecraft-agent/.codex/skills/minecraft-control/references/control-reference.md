---

name: minecraft-control
description: Control the embodied Minecraft player through factual observations, native tools, and bounded input programs.
---

### Live advisory plan

At the start of a substantial task, read `taskPlan`. Publish or revise the dependency tree at meaningful progress boundaries using `replace`. Preserve step IDs when the same step remains. The main agent owns the plan and every game decision. Inventory/world evidence reflects present possessions or observed structures; milestones retain historical progress after death. Choose recovery or replacement from live facts. Recovery checks can use `tool:pickaxe:wooden+`, `tool:pickaxe:stone+`, `has:minecraft:iron_pickaxe*1` and `near:minecraft:the_end@20,64,-10*4` (within 4 blocks, same dimension); the distance check reports progress as you approach. A plan is advisory; `finish` still requests the separate server goal verification.

```json executor-call
{"tool":"taskPlan","arguments":{"operation":"read"}}
```

```json executor-bad-call
{"tool":"taskPlan","arguments":{"operation":"replace"}}
```

# Minecraft player control

Native tools apply your chosen actions and report what happened. Plain assistant text has no Minecraft effect.

## Read facts, choose, act, verify

1. Read the current goal, newest event, and last result. Use capabilities when you need unfamiliar fields or runtime settings. Observe repeats the effective settings; a provider mapping does not change your selected identity.
2. Act from fresh supplied facts. postAction.observation and program observation already contain inventory, visible drops/entities, pose and menu where covered. Reuse those facts; inspect only missing details. Batch independent reads while the body works. Check freshness, coverage, world identity, dimension, and revisions.
3. For repeated work, read programReference and author a bounded runProgram routine with a completion condition and attention policy. Use background:true while you reason. Reuse matching notebook source with current parameters. Choose targets from fresh program facts on each iteration, including new drop UUIDs and menu states. Queue one chosen successor while current work runs, with a precondition checked from fresh facts at handoff. Return to model planning when the routine lacks a valid next step. Use sequence for a small fixed batch of known safe steps and individual tools for isolated actions.
4. Distinguish accepted input, attempted use, projectile spawn, verified effect, and verified goal. Finish asks the server to check the immutable goal contract. A failed check leaves it active.

## Observations and memory

Use inspect section hud for the current HUD, XP, all hotbar slots, offhand, effects, local sky and bed rule, and F3 light. Saturation is hidden: hungerShaking reports its visible cue. Chat, sound direction and advancement toasts are in inspect events; damage cause/direction are in the observation and inspect hud; follow afterSequence and coverage gaps. Coordinates and biome obey reduced debug info. player.harm names the perceived primary damage-type id, optional hpLossPerSecond and possible exits. The rate is net visible HP plus absorption lost over at most two game seconds (ticks/20), rounded to 0.1; healing offsets it, so zero does not mean no damage. It appears only after one game second of samples and resets on body, dimension, death and respawn. ArenaScript player.state().harm is null when no harm is perceived. direction is the latest hurt tilt; a distinct recentDamage cause remains separate. ongoing appears only when true; its absence marks a recent hit. Terrain exits are known landings, with route gaps and historical age, not a promise that they cure every damage source. Options name vanilla possibilities: air or water breathing for drowning; leave the obstructing solid block for suffocation; food for starvation; milk clears poison/wither; leave powder snow or use leather against freezing; water/rain or fire resistance against burning; cover/distance against blasts. Options do not promise that the item, route or effect is available. Remaining burn time is unknown. Status-effect seconds match the inventory display; exact durability is available through advanced item inspection.

Observe reports freshness.fresh for the sample barrier. False identifies cached facts. rememberedSections identifies older sections retained during death. A missing entity, block, or slot may be omitted by coverage limits rather than absent. Images and hidden server state are outside this interface.

Wake threatOutlook.soonestContact names the approaching observed threat UUID with the shortest finite contact ETA; it is a fact, not a target choice.

Compact observations keep resultCoverage row counts separate from omittedFields. Field paths such as inventory.extra or entities[].equipment identify omitted or shortened fields; [] means at least one retained row. All rows retained does not mean all fields retained. Existing server coverage still applies; omitted facts remain unknown.

Inspect supports inventory, menu, entities, blocks, landmarks, nearby_containers, item, block, events, recipes, mechanics, and survey (the survey tool's fields: include, exclude, limit). Pages use offset 0..4096 and limit 1..32. Item detail requires slot; block detail requires visible x/y/z. Events accept afterSequence for newly delivered player-accessible events. Recipes lists installed rules; an exact recipeId retrieves its ingredient, result, and workstation display details with explicit coverage. Mechanics reports installed version and current native player attributes and abilities. Recipe rules do not reveal hidden resources or positions. Copy returned stack fingerprints, containerId, stateId, raw slot indexes, target identities, and hit geometry. Continue a shortened page using nextOffset; unreturned details remain unknown.

ExploreFrontier lists observed footing within a horizontal radius (default 128): stood means you stood there; seen_surface means a block you saw below your eye, one per 16-block sector. Its top face may not have been the face you saw, and whether it can be stood on, has headroom or sits beside lava is unknown until you get close. A surface later seen changed or covered is dropped. Each row gives dy (height change from your feet), horizontal distance and compass heading (north is -Z, east is +X); visited, blocked (a recent failure there) and ageS (seconds since that spot was last observed, only when old) mark uncertainty. Rows are ordered one per heading per round, farthest first; continue with offset (each call reads fresh facts, so pages can shift). coverage summarizes this world and dimension: blocks travelled, descended and climbed (sums between sampled footholds, so at least that much; deaths and teleports are not travel), your first remembered position, and for each heading [walked, seen] as the farthest blocks from you, followed by [sight range, age in seconds] when a complete survey taken within 32 blocks of you had that heading in its view cone (pitch counts: looking straight down covers no heading). The sight range is how far that view could reach (water and lava fog shorten it), not how far was searched: terrain and unloaded chunks hide what lies behind them, and a survey that found nothing proves nothing is there. Remembered structure and portal sightings follow. blockId instead pages remembered blocks of that exact id. It never chooses or travels; choose coordinates with moveTo. Survey results carry the same coverage as search, and coverage.rangeBlocks when fog shortened the view. moveTo results add travel when your height changed: feetDy (exact change of your feet), descendedAtLeast and climbedAtLeast (ground changes between sampled footholds), lowestGroundY (lowest sampled foothold), and startOnGround/endOnGround (false, or unknown) when you were not seen standing. NO_STANDABLE_PATH adds knownFooting, the nearest observed footing to the target with blocked and ageS. Stored places are scoped to world and dimension and can become stale.

Notebook stores model-authored notes up to 2048 characters. QueryMemory returns historical notes and action receipts with separate provenance; pass offset or the returned nextOffset to continue a page. DISPATCHED and UNKNOWN are unresolved operations, not successful effects. Query kind unresolved retrieves their arguments; observe and capabilities report a bounded summary and count. Receipts distinguish server results from coordinator uncertainty and report evictions. Notes are hypotheses or remembered plans, not proof of current state. After reconnect or context replacement, compare uncertain operations with fresh facts before deciding whether to retry. Death retains the goal where lifecycle policy permits it; current inventory, lastDeath, and lastLostInventory are distinct facts.

## Trip preparation

Before mining or long travel, compare remaining goal needs with current food, tool durability, useful spares, fuel and verified workstations. Choose supplies for the whole trip and record a compact preparation target in progress memory. Accessible remaining ore or nearby food can be worthwhile when likely savings in later travel, slow mining or rebuilding exceed marginal time and risk. Honor explicit operator quantity limits. Count owned supplies first, gather the remaining amount of your chosen target, and reassess it when circumstances change. Reuse, carry or intentionally leave workstations according to their likely next use.

Choose travel equipment from current inventory: a capable durable tool and useful spare, armor, reachable weapon and food, and a shield or blocks when appropriate. Use equip_item for armor/offhand, select_item for an item already on the hotbar or select_tool to bring a whole stack from slots 0-35, and authored control frames for its use. Verify slots and held items after changes. A carried building block can be useful cover when you choose its supported placement; holding it alone provides no defense. Equipment and reserve quantities remain your decisions.

## Cave travel

Give moveTo the far target when the route is observed safe (about 30 blocks per leg), not each corner. Continue a live-authored background program or chosen queued successor when fresh prerequisites match. On known ground, reuse current results and inspect missing details; broad block pages after every one-block waypoint add work without establishing more route safety. Reassess when new geometry, unknown coverage, threats, relevant resource opportunities or leg exhaustion change the decision. Historical routes still need checking in the direction you will travel.

Declare `program.onUnhandledAttention(mode, {reassessWhen: () => condition})` before top-level execution to filter routine unhandled attention using a pure condition you author from current facts. Cover the reasons this leg needs your next decision. Only exact false suppresses an ordinary notification; missing, unknown or failing conditions retain notification. Fresh samples, physical collision checks and authored watchers remain active. Urgent attention, a dimension change and existing failure, checkpoint or exhaustion requests bypass this filter; the mode you declared still decides whether a dimension change pauses the routine. Omitting it keeps normal attention behavior.

Water is traversable terrain, not a hazard: navigateTo swims at the surface and through flooded passages and onto flooded floors while one breath covers the underwater stretch, and may end early to breathe when the remaining breath cannot cover it. Manage air from underWater and airSecondsLeft. Capabilities section strategy, topic water, has swimming and underwater mining details.

Check every movement receipt and stop for a new decision on the first blocked leg. The filter does not turn a single failed action into a model request by itself. After your attention and watcher declarations, use this ArenaScript fragment with the observed leg you chose:

```javascript
const leg = program.parameters().leg;
const moved = await player.navigateTo({x:leg.x,y:leg.y,z:leg.z,tolerance:leg.tolerance,sprint:leg.sprint,timeoutMs:leg.timeoutMs});
if (!moved.succeeded) program.checkpoint(moved.reason);
```

## Portals and dimension changes

Entering a portal ends any running action that started in the old dimension with state `CANCELLED` and reason `DIMENSION_TRANSITION` (navigation included). The receipt is truthful: its target coordinates belong to the dimension you left and are never valid in the new one. The runtime does not retry the old leg or choose a next one. Treat the crossing as a reassessment boundary: read the destination from fresh facts (the result or observation dimension, or `world.state().dimension` in ArenaScript), then author a continuation for that dimension. Places, routes and notes are scoped per dimension, so query the destination's own records. A routine can stop for your decision at the crossing; its result carries the failed receipt and the fresh observation with the new dimension:

```javascript
const leg = program.parameters().leg;
const moved = await player.navigateTo({x:leg.x,y:leg.y,z:leg.z,tolerance:leg.tolerance,sprint:leg.sprint,timeoutMs:leg.timeoutMs});
if (moved.reason === "DIMENSION_TRANSITION") program.checkpoint("dimension_changed");
if (!moved.succeeded) program.checkpoint(moved.reason);
```

## Survival and recovery

`canHealNow` includes the nearby-threat safety check; it does not say eating is impossible. `healing.canEat` reports carried-food eatability, independent of threats. Ordinary food needs hunger below 20; golden apples, enchanted golden apples, chorus fruit and suspicious stew also work at full hunger. Most foods take 1.6 s (32 ticks) of held use and slow movement. Allow 40 ticks or 2000 ms for the use-start tick. Moving or taking ordinary damage does not cancel eating; releasing use, changing the held item, or death does. Selecting food with `use:false` only equips it. A complete control frame with the food slot and `use:true` can combine your chosen movement with eating.

`healing.naturalRegen` means regeneration is eligible, not that health will recover under damage. `regenHPPerSecondMax` is an upper bound at the current food and saturation: 18+ food with no saturation heals at most 0.25 HP/s; 20 food with saturation can heal up to 2 HP/s while spending saturation. It is unknown in Peaceful or with missing facts. Burning costs about 1 HP/s before protections, so slow regeneration loses health overall. Eating fills hunger and saturation, not HP directly; the model chooses whether there is time to eat or another response is needed.

Choose survival actions before beginning exposed mining or long travel. Use current health, food, equipment, visible enemies, onFire, inLava, suffocating, air and terrain facts. Anticipate an observed enemy's approach, projectile or hazardous crossing before damage; choose threat conditions and a checked retreat, shield, exact enemy target or supported cover placement. Author bounded interrupt handlers that execute those choices. Damage takes priority over gathering. Waiting alone leaves the player exposed. A successful input does not prove safety: inspect the new position, threats and health before continuing.

Use program.watch(condition, {mode:"interrupt", after:"reconsider"}, handler) for defensive reactions. The handler finishes its authored actions and pauses for your explicit program decision instead of resuming unrelated work. This opt-in interrupt guard also fires at installation when its condition is already true. Legacy after:"resume" (the default) retains rising-edge behavior. An in-flight interrupt abandons the interrupted routine; replace it after reassessment. An initial guard preserves its undispatched continuation. A boundary watcher preserves its continuation, which may resume only after you explicitly continue. Choose conditions that detect the first relevant damage, not only critically low health. For example, capture initial health, watch for a decrease, and use parameters for a retreat point you checked; also handle already unsafe facts before beginning work. A wait-only handler is not a defensive reaction.

The default survival policy pauses unrelated work for unhandled damage, fire, lava, suffocation and hazardous fall notifications even with ordinary continue_and_notify. It releases input and requests your decision; it chooses no movement, target or defensive action. Repeated damage does not cancel an executing authored defensive handler. If you explicitly want unhandled survival notifications to leave your routine running, declare program.onUnhandledAttention("continue_and_notify", {survival:"continue_and_notify"}). Use that only when your own routine handles the danger. Conversation and harmless observations keep their ordinary policy.

After death, keep the project goal and compare recovery with rebuilding. taskMemory retains multiple earlier death sites, lost inventory, outbound position trails and observed workstations. Trails are historical positions, not verified routes; omittedWaypoints and reverseVerified:false expose their limits. Drops may despawn, burn or belong to another player. Observe them before attempting pickup. Do not erase an earlier valuable loss because the latest death was empty-handed.

Record important places with stable keys and coordinates. Connect them with route entries using from/to place keys and waypoints; include which direction you actually tested and what failed. Save progress, remaining requirements and lessons after meaningful changes, not each tick. Route connections let you work out how to reuse an existing staircase; you still choose and verify each leg. Only shared:true shares a note with teammates in this observed world and dimension. Automatic observations and deaths stay private. Retire obsolete notes, update changed routes and distinguish old goalRevision progress from the current goal. Query pages for full details; the automatic taskMemory summary includes counts and may omit older entries or shorten notes.

Inside ArenaScript use await world.taskMemory({operation:"remember", entry:{...}}) or await world.taskMemory({operation:"query", query:{...}}). These have the same bounded contract as the native taskMemory tool and perform no gameplay.

After a cross-dimension death, query the recorded death dimension explicitly, for example query:{kind:"deaths",dimension:"minecraft:the_nether"}. This recalls your historical records and explicitly shared notes in the same world. New observations and note writes remain scoped to the current dimension; coordinates from different dimensions are never interchangeable.

## Input ownership and precision

Control holds a complete frame for 1 to 200 server ticks. Supply every input, including false buttons, view, hand, and selectedSlot. Completion, cancellation, and expired leases release input. Vanilla game-mode and interaction restrictions remain authoritative.

Act with control_sequence runs 1 to 64 complete frames with maxTicks from 1 to 2000. Each frame has 1 to 200 ticks and up to 16 optional branches. The server checks branches before applying each tick. The first matching branch jumps to its zero-based nextFrame; an index equal to the frame count stops. A jump resets that frame duration. Backward jumps remain bounded by maxTicks. The complete action arguments must fit 32768 UTF-8 JSON bytes, including all frames, branches, or book pages. Per-field limits do not waive this total budget.

Branches read only your player facts. Numeric conditions are health_below (0..2048), food_below (0..20), and air_below (0..100000). Boolean conditions are on_fire, in_water, on_ground, horizontal_collision, hurt, and using_item. You author both condition and response. A completed frame program proves input execution; it does not prove your larger intended effect.

StartAction returns a handle immediately. ActionStatus reads its state or terminal receipt. CancelAction requires the exact actionId and goalRevision and waits for acknowledgement. ReplaceAction starts after a confirmed terminal result. An ended latest handle starts a new action and returns replacedAction; unconfirmed cancellation blocks replacement.

RunProgram executes your ArenaScript using the same interpreter as script mode. Source is at most 65536 UTF-8 bytes; maxActions defaults to 64 and caps at 1024; timeoutMs defaults to 30000 and caps at 600000. Author an explicit program.onUnhandledAttention mode. For foreground calls, continue_and_notify completes the current action before yielding; pause_and_notify cancels it before yielding. Watchers, branches, selected targets, and reactions come from your source. No other model plans its steps. Player calls await correlated physical results and new observation barriers; world.inspect and world.queryMemory are bounded reads, world.remember writes your notes. A deadline or lifecycle change stops further steps and requests release of its physical action; unknown acknowledgement remains uncertain. Program completion or program.finish yields to you; use the separate finish tool for factual goal verification. Put bulk work in one program that loops with program.repeatUntil to a count, sized with maxActions and timeoutMs: an unqueued PROGRAM_EXHAUSTED needs another model decision.

Optional parameters is a pure JSON object, at most 4096 serialized UTF-8 bytes, depth 16 and 256 total object properties/array entries. Its detached, immutable data is available through program.parameters(). Supply observed coordinates, exact identities and quantities without rewriting tested source. Match current prerequisites before reuse; parameters supply data, never extra commands. Optional expectedDurationMs is your estimated duration from 1 to timeoutMs. Preparation uses per-action measured times and known remaining work, bounded by your expected duration and deadline. Simple inventory count loops use observed gain; other conditional work stays unknown without your estimate. A wake needs a full measured model response of remaining work, or at least two seconds on a measured final action when model timing is unavailable. One substantial estimate increase may re-arm it once; timeout is only a limit. Estimates extend no deadline and guarantee no ready successor.

Author loops for repeated work. Results/status/wakes carry timing.elapsedMs, completedActions, averageActionMs and up to 16 byAction averages; receipts carry durationMs. Known continuations add remainingActions; estimatedRemainingMs needs measurements for each remaining action type and includes the active action. Simple count conditions use observed gain; unsupported control flow stays unknown. Counted loops, entered for-of lists and if branches still give remainingActionsAtMost and estimatedRemainingMsAtMost (costlier branch, no early exit; your earlier programs time action types this one has not run), which time program_planning_due no earlier than needed. Size bounded work from these measurements and queue the next program before this one ends. program_planning_due is advisory: prepare while the current body keeps working. A runProgram or body call sent after it waits and starts the moment the program ends naturally; any other ending returns NOT_STARTED with the program status, and the call never ran. Fresh terminal program observations carry freshness; read their inventory, drops and pose before another observe/inspect.

## Interaction details

Move to a standing position beside a solid target, with room for both feet and head. Removing a tree's bottom log still leaves the next log at head height. Use the goal's allowed tolerance; a tighter tolerance needlessly excludes safe positions. After NO_STANDABLE_PATH, choose another observed approach with clearance.

Mining requires a reachable block with a clear line of sight to part of its outline. expectedBlockId is optional: omit it or pass a #tag (#minecraft:base_stone_overworld) to break whatever mineable block is there (the result names it, so stone/granite/diorite need no guess); an exact id fails TARGET_CHANGED on any other block; air, fluids, bedrock and blocks with contents (chests, spawners, signs) are refused unless named exactly. mine turns to a visible part of the block at player speed, so call it directly; use look_at first only for a specific aim point (autoAim:true just prepends that look_at). It selects no alternate target. A broken block does not prove collection; drops within about a block are collected while you keep mining; the rest stay as drops. Blocking mining, movement, and pickup return postAction with updated inventory and entities. Use these facts when freshness.fresh is true; otherwise observe before a dependent action.

For a resource goal with multiple accepted item types, compare fresh visible sources and choose the nearest reachable one. Reassess when its route or collection fails. For a quantity goal, count held matching items and collect reachable matching drops toward the remaining amount before mining more. Drops can enter inventory automatically as you approach. Once inventory meets goalSpec, request finish. Only request pick_up_item while more is needed and the UUID appears in fresh facts, including after ITEM_PICKED_UP. ITEM_NOT_FOUND means the selected entity is unavailable. Reconcile inventory and reacquire remaining drops. Melee attempts and bow release also need effect evidence before claiming a hit.

Menu clicks use the current menuId, containerId, stateId, raw slot, button, clickType, expectedItemId, and expectedCount. Include expectedFingerprint for exact variants. Inspect after a click because cursor, slots, costs, and options can change. Generic clicks preserve a held cursor; close explicitly when appropriate. Provide containerId and stateId together for legacy menu operations. A rejected or partial operation is not automatically safe to repeat.

The default minecraft:inventory menu with containerId 0 exists even while walking or mining. Its presence does not mean a screen blocks gameplay. Do not close it before ordinary actions. Close an actual external container when finished, using its latest observed identity and state. Inventory and menu state can change when a nearby item is collected, even without a menu click.

For interact_block, choose a reachable face and omit hitX/hitY/hitZ by default. The executor derives the face point from the actual block shape, including inset chests. Supply offsets only when you have observed geometry that requires a specific point. Block hit offsets are within the block from 0 to 1. Entity hit offsets are relative to the observed entity position. Choose the hand explicitly. Sign writes compare expectedLines; book edits compare expectedFingerprint. A book title signs it. Beacon effects use observed legal effect IDs or none. Mechanics still depend on current world, menu, and game-mode state.

After a deposit, inspect the menu to verify the destination stacks and your remaining inventory. AWAITING_OPERATOR_CONFIRMATION means report the result once with say and end the turn until new input arrives; leave the completed deposit alone. COMPLETED or lifecycle cancellation, including CANCELLED with STALE_PLAN, ends this goal turn. A cancelled call with executed:false made no world change. For other failed completion checks, use the returned unmet facts to decide the next action.

## Tool examples

These examples demonstrate accepted syntax, not a world script. Replace illustrative coordinates, UUIDs, handles, slots, revisions, and fingerprints with actual observed references. Numeric arguments are literal values.

### observe

Request a fresh player observation. Read freshness and coverage; an unavailable freshness barrier returns explicitly stale cached facts.

```json executor-call
{"tool":"observe","arguments":{}}
```

### taskMemory

Record a place or connect named places using your observed route. Replace these illustrative coordinates with current evidence.

```json executor-call
{"tool":"taskMemory","arguments":{"operation":"remember","entry":{"kind":"place","key":"mine-entrance","label":"Mine entrance","summary":"Existing staircase begins here; verify clearance again after respawn.","position":{"x":12,"y":64,"z":10},"shared":true}}}
```

```json executor-call
{"tool":"taskMemory","arguments":{"operation":"remember","entry":{"kind":"route","key":"entrance-to-junction","label":"Existing staircase","summary":"Descended this leg; uphill traversal has not been verified.","from":"mine-entrance","to":"lower-junction","waypoints":[{"x":12,"y":64,"z":10},{"x":16,"y":60,"z":10}]}}}
```

```json executor-call
{"tool":"taskMemory","arguments":{"operation":"query","query":{"kind":"deaths","offset":0,"limit":8}}}
```

### capabilities

List the versioned action fields, query sections, limits, and runtime support for this player.

```json executor-call
{"tool":"capabilities","arguments":{}}
```

Read the shared ArenaScript language and API reference before writing runProgram source.

```json executor-call
{"tool":"capabilities","arguments":{"section":"program"}}
```

### inspect

Request a focused page of player-accessible facts. Item queries need a slot; block queries need visible x/y/z coordinates. Read coverage and freshness.

```json executor-call
{"tool":"inspect","arguments":{"section":"inventory","offset":0,"limit":16}}
```

```json executor-call
{"tool":"inspect","arguments":{"section":"recipes","recipeId":"minecraft:crafting_table","offset":0,"limit":16}}
```

### actionStatus

Inspect the active action or a retained terminal receipt without changing the player.

```json executor-call
{"tool":"actionStatus","arguments":{"actionId":"native:agent-a:3:7"}}
```

### cancelAction

Cancel the exact active handle and wait for its authoritative terminal result. A stale handle cannot cancel another action.

```json executor-call
{"tool":"cancelAction","arguments":{"actionId":"native:agent-a:3:7","goalRevision":3}}
```

### replaceAction

For an active handle, cancel it, await acknowledgement, then await the replacement result. For the latest ended handle, start a new action and return its handle with startedAs:"start_action" and replacedAction. No replacement runs after uncertain cancellation.

```json executor-call
{"tool":"replaceAction","arguments":{"actionId":"native:agent-a:3:7","goalRevision":3,"actionType":"look_at","arguments":{"x":12,"y":65,"z":12}}}
```

### startAction

Start one model-chosen action and return its handle immediately. Its result arrives as an event after you end your turn; never poll actionStatus. Cancel the exact handle to stop it.

```json executor-call
{"tool":"startAction","arguments":{"actionType":"wait","arguments":{"durationMs":500}}}
```

### notebook

Save or replace one model-written note of up to 2048 characters in this agent and world. Notes are hypotheses or plans, never authoritative game evidence.

```json executor-call
{"tool":"notebook","arguments":{"key":"return-route","text":"Observed bridge at 12, 64, 12 in the Overworld. Recheck before crossing."}}
```

### queryMemory

Read this agent and world's saved notes and action receipts. Continue pages with nextOffset. Memory records are historical, not fresh world observations.

```json executor-call
{"tool":"queryMemory","arguments":{"kind":"notes","text":"bridge","offset":0,"limit":10}}
```

```json executor-call
{"tool":"queryMemory","arguments":{"kind":"unresolved","offset":0,"limit":10}}
```

### runProgram

Run your bounded ArenaScript through the shared interpreter. This example reads the current player state, executes one model-chosen wait, and yields at source exhaustion.

```json executor-call
{"tool":"runProgram","arguments":{"source":"program.onUnhandledAttention(\"pause_and_notify\"); const self = player.state(); if (self.health > 0) { await player.wait(50); }","maxActions":4,"timeoutMs":5000}}
```

Author source live; program.parameters() supplies bounded data for that source. Notes retain observations and prerequisites, not executable routines.

Set `background:true` when your authored routine should continue acting or reacting while you reason. It returns a `programId` and `goalRevision`; the routine retains exclusive body control. Observations, inspection, memory, and program status remain available. Choose your own watcher conditions and responses from current facts. Use `capabilities` with `section:"program"` for the language reference.

A program ends on exhaustion, unhandled failure, cancellation, its action budget, or its deadline (at most 600 seconds). Larger integer deadlines clamp to 600000 ms with an adjusted note; expectedDurationMs clamps to the effective deadline. Watchers and sampling end with it. Background programs never restart themselves and do not survive stop, death, goal replacement, or disconnect. Cancel the program and wait for its result before issuing another body action. An `UNKNOWN` cancellation result requires checking the active action; input release is unconfirmed.

With `continue_and_notify`, unhandled attention requests your decision while the authorised routine continues. With `pause_and_notify`, it cancels the current input and waits for your decision. A foreground call returns a live handle on attention so you can respond too. Program attention and completion arrive as events; use `programStatus` to recover the latest handle when needed. Ordinary progress does not require replanning.

A standing order is a reflex you author once, for danger faster than a model turn. `standing:{id,when,ttlS}` stores the source instead of running it; `when` is one side-effect-free expression over the same facts as a queueProgram precondition. The moment it turns true (or if it is true when stored) the source starts as a background program. It cancels your own running action or a program paused for your decision; a running program keeps the body, since its own watchers answer first. Its source must declare `{ survival: "continue_and_notify" }`, because urgent danger otherwise pauses a program, and an order runs during exactly that danger. It fires again only after the condition was false. At most four orders; each expires after `ttlS` seconds (default 600, at most 1800) and survives death and respawn. Every firing returns as a program result whose `standingOrder` names the order, the facts that fired it (`cause`) and what it `preempted`. A condition naming a fact absent from a sample reads false and shows `conditionError` in the order list. `standing:{id}` alone deletes the order.

For a persistent defensive policy use `standing:{id,when,guard:true}` (omit ttlS). Its condition is checked on every live sample, including unchanged heartbeats while you think with no program running. While true it can start another bounded response after the previous one ends. Retries while the condition stays true back off from 250 ms to 5 s, resetting when it clears. It survives program replacements and respawn until you replace the same id or delete it; a new goal text or revision clears standing guards; respawn uses the new body's health, equipment and threats. Four orders total; conditions <=1024 UTF-8 bytes, source <=4096, each response uses maxActions/timeoutMs (defaults 16/10000, maxima 1024/600000). No default policy is installed.

Author guard source and its condition live from observed danger. Named templates and saved noteKey programs are outside this player's allowed actions. The continuity guard fact reports its last evaluated condition, condition error and firing count. Installed with condition false does not protect against the current threat; compare your expression with the observed facts. background:true with standing is ignored.

Precedence: a model body command being dispatched finishes preparation and bridge publication before a guard can take the body. Your explicit new body command cancels the current guard response and waits for input release. Model-authored fight_target, flee_from, block_with_shield, use_item and respawn (including program-owned defenses) finish before a guard; reads and conversation leave it running. An eligible guard cancels routine work (including active programs), discards its queued successor, then takes the body after cancellation acknowledgement. Orders never preempt another order. Guard conditions take priority over legacy orders; within each group installation order wins. Clearing/replacing a guard also cancels its current response. One episode spans a continuously true condition: program_guard_activated wakes urgently once; program_ended reports the episode when it clears or the guard is edited. Repeated outcomes coalesce; an outcome category change can wake urgently. programStatus and episode results retain standingOrder.activations and lastOutcome, cause, preempted work and action receipts. A failed response never proves safety. Use tryResult and author the next fallback in the same response to avoid waiting for a model turn.

Author the defense from current facts. A creeper fuse lasts about 1.5 s; arrange the response before contact rather than waiting for another model reply. Use all player.state().threats when choosing between creepers and melee enemies. targetable threats can remain behind you with visible:false; fleeFrom accepts their observed UUID. safeExit:null means no acquired exit cell, not that fleeFrom is unavailable. Choose a bounded escape or other physical response and handle failure in the same source. LOW_HEALTH_BAILOUT is a stop, not a retreat. Re-read threats after each action; TARGET_GONE is disappearance, not proof of safety.

Underwater facts: `airSecondsLeft` is remaining air ticks / 20 (300 ticks full; one bubble is 30 ticks), `waterMotion` says sinking/rising/swimming/level, and `waterAbove` is open_water/blocked/unknown. Magma bubble columns count as sinking and block breathable routes; soul sand columns are rising aids. `breathable` is the nearest acquired air cell reachable up/sideways through water, or null while none has been found by the bounded search. Its kind is surface or breath_only: a one-high pocket can put your eyes in air without room to stand. Its x/y/z are a feet destination for moveTo; distance and seconds are swim-path estimates at 2 blocks/s, before currents or obstructions. Underwater navigation may end early to breathe: at the three-second reserve, when the route exceeds remaining breath, or when no underwater route is found, it swims along an acquired breathable route and returns AIR_RESERVE_REACHED or BREATH_NOT_COVERED with air and path facts. It ends there; choose the next destination after reading the result. With no acquired breathable cell it stops and reports the reason while breath remains. Drowning attention arrives below swim ETA plus 15 seconds and re-alerts at three seconds. A raw control frame with jump:true rises in water without moveTo. Failed movement proves no safety.

For low air, choose a remaining-air threshold and a response using the current breathable target or a complete jump:true control frame when the column allows rising. Keep the handler bounded and handle blocked movement. Other possible condition facts include fire, inLava, health, hunger, threats, fallDistance and dropAhead; you choose thresholds and responses. Write every guard live.

### reflexes

Reflexes are rules you author that the mod checks every server tick (50 ms) for your player, for reactions faster than a model turn or a guard. Each rule is `{id, kind, priority, when, do, until, maxS, cooldownS, ttlS, lasts, maxFirings, wake}`. Send them with `runProgram({reflexes:[...]})` (rules only, the body is untouched; the result lists them), or add `reflexes` to the call that acts: `act`, `sequence`, a runProgram that starts a program, or a standing order. The rules install before that call acts, and its result (or failure) lists them. An entry with an existing id replaces it; `{id, remove:true}` removes one and `{id:"*", remove:true}` removes all of your own rules (default rules stay; remove each by its id); `reflexes:[]` just lists them.

Before exposure, author only missing rules for the current threats, gear and footing. For close danger, the short escape or defense call itself carries them. Consider continuing fire after projectile hits, deflectable fireballs, approaching creepers, air and tool durability as relevant to the job. Give survival responses priority over shield/combat stances; choose expiry and important wakes. Keep working rules across programs; revise failed rules by the same id from the firing report. Author every rule live; no saved or named sets. Setup timing and maintenance are taught in the player instructions.

- Default rules: four rules are armed from spawn, again after each respawn and at each dimension change: `default-lava` (`in_lava` -> `leave_lava`, priority 9), `default-fire` (`in_fire` -> `leave_fire`, priority 8), `default-air` (`air_below {bubbles:3}` -> `swim_up`, priority 8) and `default-edge` (stance `edge_near {within:2, direction:any, drop:4}` -> `brace`). They fire, pause and resume the running action and report like your own rules, and wake lines list them by id. `{id:"default-...", remove:true}` switches one off until the next respawn or dimension change; a rule you send with the same id replaces it and stays yours. They do not count toward your 12 rules.
- `kind`: `trigger` (default) fires once when its condition becomes true; `stance` fires while it is true and releases when it stops being true.
- `when`: one condition or an array of up to 4 that must all hold; add `not:true` to negate one (at least one must be un-negated). Conditions read only what a player perceives: `incoming_projectile {withinS 0.05-2, projectiles?}` (a visible projectile whose flight reaches you within withinS, default 1), `hostile_near {within 1-32, mobs?, targetId?}` (nearest hostile or listed mob in line of sight; targetId tracks one UUID until no longer sensed), `target_in_reach {mobs?}` (in the held item's attack reach), `health_below {value}`, `air_below {bubbles}`, `hunger_below {value}`, `tool_broke {tool?}` (the held tool just broke; tool pickaxe/axe/shovel/hoe/sword/shield/any), `on_fire`, `in_lava`. Mob and projectile ids may omit `minecraft:`.
- `do`: `shield {counter?}` (raise the shield in either hand, held while the condition holds: toward a shot about to land, else toward the hostiles within 3.5 blocks, all of them when one facing covers them, else the one whose attack is due; with `counter:true` and an offhand shield it also strikes between their attacks: once the weapon has recharged and every hostile near has just swung, it lowers the shield, hits the one in reach and raises it again), `attack` (aim and swing at the mob in reach when the attack has recharged; a trigger swings once), `step_back {blocks 1-4}` (back away from the mob onto known safe footing), `eat` (best food from offhand or hotbar), `select {tool | item}` (tool `any` means the kind that just broke; from the main inventory it opens the inventory screen and swaps the stack into the hotbar, standing still for about 0.2 s), `swim_up` (swim to the nearest breathable cell you have seen, straight up under open water or around a flooded tunnel's ceiling, until surfaced; with no seen air, hold jump looking up).
- Work conditions: `inventory_full` (no empty main slot), `item_nearby {within 1-8, items?}` (a dropped item in view that fits your inventory, default within 4), `tool_low {uses 1-256, tool?}` (the held tool has at most `uses` uses left), `falling {blocks 1-64}` (in the air, fallen that far), `saturation_empty` (the hunger bar jitters), `night` (sunset to dawn, seen through open sky or on a carried clock), `stack_used_up {item?}` (the held stack just ran out: last block, torch or food). Work actions: `pickup {within 1-8}` (walk a short safe straight path to the dropped item of the condition, or the nearest in view, until it is collected), `place {item, where: below|ahead|feet}` (right-click a face in reach with the item from hotbar or offhand: below fills the gap under you or sets a torch at your feet, ahead fills the feet cell in front of you; a `water_bucket` below aims down and empties once the ground is in reach, for a fall, then scoops the water back after landing; `feet` empties a `water_bucket` on the ground under you and leaves the source there, standing water endermen cannot path into), `stop` (hold still, cancel the running program or action, and wake you; `wake` defaults to true).
- Combat and hazard conditions: `fireball_incoming {withinS 0.05-3, deflectable?}` (a visible fireball, wither skull or wind charge reaching you within withinS, default 1.5; `deflectable:true` keeps only ghast fireballs and wind charges, which a punch sends back), `creeper_fusing {within 1-16}` (a creeper swelling to explode, heard without sight; default 6), `enderman_gaze {within}` (your crosshair is on or nearly on a calm enderman's eyes, the stare that provokes it; one already angry at you stays angry and never counts), `enderman_provoked {within}` (an angry enderman), `edge_near {within 1-4, direction ahead/behind/left/right/moving/any, drop 2-64}` (a fall of at least `drop` blocks, default 4, or the void, within `within` blocks in that direction, default 1 and moving, from seen terrain), `lava_near {within 1-4}` (lava at feet level or just below/above, default 2), `lava_flowing {withinS 0.5-6}` (seen lava whose spread, by vanilla's flow rules over the blocks you know, reaches your feet or head within withinS, default 3; the point is the cell it flows in from; player.lavaFlow shows the same flow), `attacked_from_behind {within 1-8}` (a mob outside your view just hit you or is closing on you), `exposed {within, mobs?}` (a hostile or listed mob within range has a clear line to you; `not:true` means you are in cover), `cloud_near {within 0-4}` (you stand in a harmful cloud, such as dragon breath, or its seen edge is within `within` blocks, default 1; actions run from its centre), `dragon_charging {within 8-96}` (the dragon, seen flying, not perched, within `within` blocks, default 48, whose flight line passes within about 10 blocks of you in the next 3 s: the swoop whose body throws you 5-15 blocks).
- Combat and hazard actions: `deflect` (aim at the condition's fireball and punch it when it is in reach; only deflectable ones), `sprint_away {blocks 2-24}` (run from the condition's mob or point, else from the nearest hostile that sees you, along safe footing; default 8; with a mob within 3 blocks it keeps a block off drops, and on an edge with the mob inland it runs along the edge; it turns to look at footing it has not seen, and with no level heading takes the shallowest drop that leaves 4 health, or from a cloud runs back across it; else it fails naming what blocks each direction), `move_to_cell {x,y,z, sprint?}` (walk a short safe path, at most 16 steps over seen footing, to a cell you name, such as cover you saw), `sneak` (hold sneak and stand still while the condition holds, so you cannot walk off an edge; the paused action does not move meanwhile), `look_away` (turn the view down and away from the condition's mob), `place_block {item?, count 1-2}` (place hotbar blocks in the cell beside you toward the threat, feet level then head level; default any plain solid block), `take_cover {within 2-10}` (move to the nearest cell, at most `within` steps away, that the condition's mob cannot see, or the shooters that see you (else every hostile that does) when the condition names no mob; with no such cell it places two hotbar blocks toward the nearest one), `brace` (never takes the body: while its condition holds and for 2 s after, a hit that shoves the body toward a lethal or unseen-bottom drop is walked back toward the take-off point with a player's air keys, whatever drives the body: an action, control keys, a program, a firing or nothing), `away_from_edge {blocks 2-12}` (sprint along seen footing, at most 24 steps a walk, to the nearest cell at least `blocks` from every drop of 5+ blocks, the void, lava or footing you have not seen, default 6, avoiding breath clouds; done at once when already that far; short of it, it turns to look inland and walks again, up to 4 walks, and fails when none gains a block; give it maxS for the walk, about 10).
- Digging hazards: `suffocating` (your head is inside a solid block, as when sand or gravel drops onto it: the block fills the view and costs 1 health every half second); `dig_out` (mine the block your head is stuck in with your fastest hotbar tool for it, then any sand or gravel that drops in after it; it fails on a block you cannot mine). A model turn is slower than suffocation: arm it before digging up a shaft or tunnelling where sand or gravel is in view.
- Fire hazards: `in_fire` (your body overlaps a fire block, such as one a blaze fireball left where it landed; it re-ignites you every tick, so the burn grows while you stand in it, while `on_fire` alone also holds after you leave); `leave_fire` (sprint to the nearest seen cell, at most 6 steps, with no fire or lava at feet or head); `leave_lava` is the same move from lava (`in_lava`): it holds forward and jump, which swims and climbs a ledge, toward that cell or the nearest seen exit. It prefers a cell the seen flow does not reach (never a pit under a flow), also runs before contact when a seen flow reaches you within 4 s (arm it on `lava_flowing`), and ends standing, not in the air. Lava kills in about 2-3 s, faster than a reply; Nether lava spreads a cell every 0.5 s, faster than you wade out of it, so arm `lava_flowing` to leave or `place_block` to dam a flow before it reaches you.
- Shields need 5 ticks to rise, and an arrow is visible only about 6 ticks before it lands: pre-raise with a `stance` (for example while `exposed` to a skeleton), not only a projectile trigger. A higher-priority firing that takes over from a raised shield keeps the body's input without lowering it. A stance is not progress when the body keeps losing health: a stance that hits `maxS` after losing 2+ health counts as a failed firing and wakes you, and one held for three `maxS` spans in a row without its condition clearing wakes you once; give fleeing (`sprint_away`, `take_cover` on `health_below`) a higher priority than holding.
- Arbitration: one rule fires at a time; higher `priority` (1-9, default 5) preempts a lower firing. Rank survival above combat above work. A firing takes the body from the running action, which pauses (it is not cancelled) and resumes when the firing ends; your program keeps waiting on that action. Health lost under the firing is the firing's: a resumed travel_to or navigate_to does not stop for it and travel_to plans its next leg from where the body now stands. The action's result names the rules that paused it (`paused 1 time(s) by reflex <id> for 0.4 s, resumed 1 time(s)`). A held `shield` lets a walking action (move_to, navigate_to, follow_entity, control, wait) keep moving behind it at vanilla's shield-raised speed (a fifth of walking), and inside `fight_target` the fight raises the offhand shield between its own swings except while a shot is about to land; `flee_from` takes the body from the shield and runs with it lowered. Your own direct body command (any action tool, sequence or lookAround) ends the current firing, except that a held shield stays up under a walking or fight command and a `place` `where:below` firing finishes a fall in progress first (your command starts once you land); a yielded stance stays down until that command ends or its condition clears. When an action stops on `LOW_HEALTH_BAILOUT`, `ON_FIRE`, `IN_LAVA` or `NAVIGATION_DAMAGED`, your rules whose conditions hold fire at once (triggers too), so arm the fire, lava and low-health rules you want before a fight.
- Example, written live for a perched dragon you will fight (ids, numbers and priorities are yours): `reflexes:[{id:"breath",priority:9,when:{type:"cloud_near",within:0},do:{type:"sprint_away",blocks:6}},{id:"head",kind:"stance",priority:6,when:{type:"target_in_reach",mobs:["ender_dragon"]},do:{type:"attack"},ttlS:900}]` carried by the call that runs to the head (a sprinting move or fight_target). The stance swings at the head whenever it is in reach (another part only when the head is not), and each hit it lands pauses the wing throw for half a second; the breath rule leaves only once you stand in the cloud, so the stance keeps swinging up to its edge.
- Limits: at most 12 rules of your own, plus the default rules. Each firing lasts at most `maxS` (default 4 s trigger, 10 s stance, at most 20; shield stances default to 600 s and accept maxS up to 600), then waits `cooldownS` (default 0.5). A rule expires after `ttlS` (default 600, at most 3600), when all its `until` conditions hold, or after `maxFirings`. `lasts` ties it to a context instead: `"night"` ends it at the first dawn (armed by day, it lasts the coming night), `"dimension"` when you leave the dimension it was armed in (a death elsewhere counts), `"lava"` once no lava has been within 12 blocks for a minute; with `lasts` and no `ttlS` the ttl is 3600. Wake lines name a rule's remaining seconds in its last 120 s and list expired rules with the reason. Four firings in a row without progress (failed, or a trigger hitting maxS), or more than 40 in a minute, disable the rule and wake you.
- Reports: every firing ends as done, hit maxS, failed, preempted, yielded, expired or DISABLED with a detail ("blocked 3 hit(s)", "no pickaxe in hotbar (2 in inventory)", "lost 4.0 health"). They arrive in your next wake as `now.reflexes` with the armed rule ids and, when report space allows, their authored condition, action and priority; `wake:true` also wakes you when that rule's firing ends. While your own action runs, a hit at more than 8 health from a mob kind a wake in this dimension showed, another threat signal from such a kind, an incoming projectile of a kind already shown, a burn while an armed `leave_fire`/`leave_lava` rule has not failed, and routine updates do not wake you; the next wake sums them in `now.whileActing` (hits and health, threat signals, items gained, update count). You are woken at once when the action ends or fails, at 8 health or below, for lava at the body, a hit with no seen attacker, a mob or projectile kind no wake in this dimension showed, a creeper swelling or close, a burn with no fire rule or after one failed, a fortress, portal, stronghold or bastion sighted, and an enderman within 24 blocks while your goal names pearls or eyes and you hold fewer than 12. Programs read `world.state().reflexes` (each rule's state armed/firing/cooldown/yielded/disabled, fired count, expiresInS, the current firing and recent reports).
- Rules persist across goal revisions, programs, thinking gaps and death; they end only by expiry or removal. Standing guards remain for larger responses that need a whole program. Precedence: your direct command, then a firing reflex, then a guard: a guard whose condition becomes true while a reflex fires waits for the firing to end and fires only if its condition still holds. Time a firing holds the body does not count toward the paused action's timeout or the program's timeoutMs.

### queueProgram

While a background routine runs, choose its next bounded work and queue exactly one successor. Copy `afterProgramId`, `goalRevision`, and `programVersion` from the current handle/status. Supply live-authored source, optional parameters and bounds, and a required `precondition`: one side-effect-free ArenaScript expression, at most 4096 UTF-8 bytes. The expression reads fresh facts and successor parameters. It must evaluate to exactly true; an unknown or changed prerequisite drops the queue.

```json executor-call
{"tool":"queueProgram","arguments":{"afterProgramId":"native-program-session-1","goalRevision":3,"programVersion":1,"source":"program.onUnhandledAttention(\"pause_and_notify\"); await player.wait(program.parameters().durationMs);","parameters":{"durationMs":50},"precondition":"player.state().health > 0 && !player.state().dead","maxActions":1,"timeoutMs":5000,"expectedDurationMs":50}}
```

Invoking queueProgram again explicitly replaces the pending successor for that predecessor and returns a new queueId. The runtime performs no strategy selection. Handoff requires natural `PROGRAM_EXHAUSTED` whose last action succeeded (earlier failed actions your source passed over still hand off; the precondition judges the fresh facts), no pending program decision, a valid lifecycle, the same world/dimension, and an authoritative fresh observation after the predecessor ends. Failure, death, cancellation, manual finish, checkpoint, action budget, or deadline cannot start it. Each successor gets its own timeout from handoff; the predecessor's deadline stays fixed. A successor can also have one explicitly authored next queue while it runs.

### cancelQueuedProgram

Withdraw only the exact pending queue. Copy its queueId and predecessor identity from programStatus. The current routine keeps running, and a stale handle cannot cancel a newer replacement queue.

```json executor-call
{"tool":"cancelQueuedProgram","arguments":{"afterProgramId":"native-program-session-1","goalRevision":3,"queueId":"native-queue-session-1"}}
```

### programStatus

Read a running program, pending decision, pendingSuccessor summary, or the latest retained terminal result. The summary carries the exact queue identity and execution bounds. Supply the exact handle when checking a particular program. A terminal program result does not prove goal completion; use `finish` for that.

```json executor-call
{"tool":"programStatus","arguments":{"programId":"native-program-session-1"}}
```

### respondProgram

Copy the pending `decisionId`, `programId`, and `goalRevision` from the event or status. Choose `continue`, `pause`, `replace`, or `finish`. Only `replace` takes new `source`; it releases the previous input before starting the new version and retains the original deadline and action budget. A newer attention event invalidates an older decision, except that `replace` still lands when only the same danger worsened (air or health kept falling). On `STALE_PROGRAM_DECISION`, inspect the current decision and reconsider. Ordinary authorised progress does not invalidate a decision.

`pause` and `finish` end this routine after input release. Resume later with a newly authored program. Program `finish` does not complete the goal; the separate `finish` tool requests Minecraft verification.

Repeated deterministic failures can halt the routine and deliver an `action_failure` decision. `PROGRAM_REPLACEMENT_REQUIRED` means its old continuation cannot resume: use the failure evidence to author a different replacement, or explicitly stop it.

```json executor-call
{"tool":"respondProgram","arguments":{"programId":"native-program-session-1","goalRevision":3,"decisionId":"native-program-session-1:decision-1","directive":"continue"}}
```

### cancelProgram

Cancel the exact program, including a pending notebook load, and wait for its result. Copy both fields from the returned handle. Cancellation prevents subsequent program actions; an in-flight body action must acknowledge cancellation before control is released.

```json executor-call
{"tool":"cancelProgram","arguments":{"programId":"native-program-session-1","goalRevision":3}}
```

### lookAround

Turn through 2 to 8 camera steps. Returned samples retain sightings from each heading; reacquire a target before acting on a historical sighting. Add `survey` (same fields as the survey tool) to survey each heading once the body faces it; the merged rows keep the nearest sighting of each thing, with bearings relative to the final heading.

```json executor-call
{"tool":"lookAround","arguments":{"centerYaw":90,"pitch":0,"steps":4,"ticksPerStep":3}}
```

```json executor-call
{"tool":"lookAround","arguments":{"centerYaw":0,"pitch":0,"steps":4,"ticksPerStep":3,"survey":{"include":["structures","built","biomes"],"limit":3}}}
```

### survey

Read what the player sees now, from its eye and view cone (about 150 degrees), using what the loaded world holds: structures (named within 64 blocks; farther, the built blocks seen and the horizontal span of those seen blocks, a lower bound), poi (nether portals, bells, beds, workstations), biomes (nearest visible ground of each other biome), built (blocks that do not belong to the terrain, outside every generated structure: possibly player-built, a hint only), blocks (lava pools, spawners, chests; `blocks:<id>` searches exposed blocks of one id within 24 blocks), caves and veins. Big things count to 256 blocks; single small blocks only within 24. Nothing behind terrain, in unloaded chunks or behind the player is reported; turn or use lookAround with survey to see around. `include` and `exclude` pick sections, `limit` sets rows per section (1 to 8, default 4). Threat facts are always included. Passive observation updates retain recent sightings for up to 30 seconds.

```json executor-call
{"tool":"survey","arguments":{}}
```

```json executor-call
{"tool":"survey","arguments":{"include":["structures","blocks:minecraft:diamond_ore"],"limit":2}}
```

### control

Hold one complete player input frame for 1 to 200 server ticks. Use for precise movement, jumps, attacks, item use, view, and hotbar control.

Before moving on ground, player.groundAhead samples the centerline up to 8 horizontal blocks along your current view heading, even while stationary. status is clear, blocked, unknown, drop, water or lava; at is horizontal distance to the first reported cell. drop is vertical depth where known, or a lower bound with atLeast:true (search stops after 32 blocks). Unknown includes unseen body clearance or support, even with zero measured drop. Clear describes sampled support and clearance only, not a swept-body route or a guarantee for jumps, strafing or a different yaw. It does not stop input, with one exception: a grounded walking frame (and each control_sequence frame) stops with VOID_EDGE before your body would leave its last support over the void, an edge with nothing below to the world's bottom; sneak:true walks to that edge without falling and jump:true leaps. Raw movement can walk or jump over an unseen edge; choose sneak or moveTo for observed-route traversal. The separate dropAhead fact remains the approaching-motion fall trigger.

player.brink appears while a shove of at most 1.4 blocks any way would put the body over a lethal brink you have seen: dir (compass) and at (blocks) say which way and how close, below is lava, fire, void or drop (a fall whose damage reaches your health), drop its depth. It is any direction, not only your view heading: a hit from the front pushes you toward a brink behind you. Your body keeps its footing there as a player does: a step that would carry the whole body over a lethal brink is taken crouched, so vanilla stops it at the lip (not during your own jump), and while you hold no movement keys (standing, blocking, mining, eating, waiting) within a shove of a lethal brink or of a drop whose bottom you have not seen, the body crouches at the spot where it stopped and walks back to it after each shove. During an action you sent other than control (a move, travel_to, use, place, build_shelter, a fight) or with an item in use, a hit whose hop would land over a lethal drop or one whose bottom you have not seen is walked back toward the take-off point, upright, with a raised shield lowered in the air; a navigate_to, move_to or travel_to leg does not jump onto such a landing (it crouches at the lip instead) unless its destination is below the lip. Your control keys, programs, fights and rules jump as sent. When the body did either, player.brink.saved names it for 5 s ({did, at, below, agoS}) and the action's result says so. One big blast (a ghast fireball, a creeper) still throws a body off a lip: to fight, block or wait, stand where brink is absent.

The result names the edge you can see along your final heading as `ahead {"drop":9,"at":2}`: a measured drop of 4 or more blocks (fall damage starts at 4), or an edge of unmeasured depth, after `at` whole blocks of ground, `atLeast` when its bottom is out of sight (look down to measure it), `into` for water or lava. Absent means no such edge is seen, not that the way is safe. Any action result can add `fell N blocks; fall HP sum D` after a measured fall of 4+ blocks: N is its worst drop, D the health all its falls cost.

```json executor-call
{"tool":"control","arguments":{"forward":1,"strafe":0,"jump":true,"sneak":false,"sprint":true,"attack":false,"use":false,"yaw":0,"pitch":0,"selectedSlot":0,"hand":"main","ticks":8}}
```

### moveTo

Navigate to the target you choose through acquired safe terrain in bounded ~30-block legs; when the route is observed safe, give the far target. Prefer moveTo for traversal and exploration through acquired terrain; use control for deliberate input maneuvers. At a sight boundary the body looks toward your target, replans as terrain becomes observed, and can take observed detours within your timeout. Three consecutive searches without a continuation stop with NO_SEEN_ROUTE or REACHED_FRONTIER; lack of body progress still stops the move. Unknown terrain never authorizes a step. Explicit move_to and navigate_to share this behavior.

DESTINATION_REACHED confirms ordinary verified arrival. DESTINATION_NEAR_UNVERIFIED is FAILED, never ok: after three empty observation searches, movement stopped at stable verified dry footing near the target, whose cell, headroom and support must be seen and standable. The remaining approach contains unseen cells and no known obstruction, fluid or drop; distance is within tolerance or at most min(2.5, tolerance + 1.5) blocks, with height difference at most 0.5. This does not prove a route or arrival and success-dependent program steps and sequences stop. Terminal messages state "stopped X blocks from target (requested tolerance T)", replans, distance walked and stop coordinates. Target facts describe observed geometry, not verified arrival.

Native moveTo maps to navigate_to, with tolerance:1, sprint:true and timeoutMs:30000 defaults. Its timeout accepts 1..600000ms, matching act and sequence. In ArenaScript, player.moveTo accepts x/y/z, tolerance and sprint only; player.navigateTo additionally requires timeoutMs. Program deadlines still apply.

```json executor-call
{"tool":"moveTo","arguments":{"x":12,"y":64,"z":12,"tolerance":1,"sprint":true,"timeoutMs":30000}}
```

### travelTo

`retrace:true` with `x,y,z` and optional `dimension` follows the route your body actually walked, including remembered portal transitions, across deaths. Turns stay in order, even when they lead away from the destination. Each leg uses current sight and ordinary travel safety (lava brake, brink guard, building and vertical steps); remembered terrain may have changed. No connected route returns `NO_ROUTE`. At a portal the body enters it; after `DIMENSION_TRANSITION`, reissue retrace in the new dimension. A save point supplies no route you never walked. `routeMemory` reports the death route length, remembered hazards and nearest seen wood, planks, crafting table and chest.

One call for a long trip, the fast choice whenever the target is more than about one moveTo leg (30 blocks) away: a seen place (a structure, a far landmark, a remembered spot) as x and z (y optional), or a heading as yaw and distance. With y, height toward it counts as progress, so a cave floor or lava seen below is a target too: it walks down seen ground and drops of up to 3 blocks. The body works at its own speed until something needs your decision: it picks a standing spot it has seen up to 48 blocks ahead toward the target, sprints there through ordinary navigation (every moveTo safety rule applies), and picks the next as new terrain comes into view, looking ahead and to either side when nothing seen gets closer. Where seen ground ends it builds its way on in a straight line toward the target with carried blocks and tools: a gap or lava below the next cell is bridged (sneaking backwards to the edge and placing on the side of the block underfoot), a ledge two or three blocks up is pillared, a wall is tunnelled (never a cell beside seen lava, nothing unbreakable or holding items, nothing taking over 1 s a block with the best carried tool, or 1.5 s for brief tool-free clearing). build:false never places or mines. Plain full blocks are used (netherrack, cobblestone, dirt, stone...), never valuables, falling blocks, block entities or blocks lava sets alight (planks, logs, wool); main-inventory supplies are swapped into the selected hotbar slot as needed. A tunnel cell is looked into before it is entered, and lava coming at the body makes it back out along its walked trail to dry ground, normally up to eight cells first.

It stops and returns where it is, how far is left, blocks per minute and what it built, with one reason: ARRIVED (within tolerance blocks horizontally, default 3; and within max(3, tolerance) of y when given), TARGET_SEEN (the stopWhenSeen block id came into view, for example minecraft:nether_bricks), TRAVEL_DAMAGED (any health loss, with the cause), HOSTILE_NEAR (a visible hostile not in range at the start came within 16 blocks, any hostile within 6, or a mob targeting you within 48), LOW_HEALTH (health fell to minHealth, default 8), LOW_FOOD (food fell to 6, where sprinting stops), OUT_OF_BLOCKS (a bridge or pillar is needed and no plain block is carried), NO_ROUTE (nothing seen gets closer and building cannot continue, with why; or no closer for 60 s), BUILD_FAILED, TUNNEL_FLOODED (lava or water flowed into a tunnel cell, not entered), LAVA_INCOMING (seen lava was about to flow into the body's cell; it stepped out of the way first), ON_FIRE or IN_LAVA, or TRAVEL_TIMEOUT (timeoutMs, default and maximum 600000). Re-issue it to continue after a stop you have dealt with.

`fightThrough:true` is your choice to fight through hostiles instead of stopping for them: a hostile further than 6 blocks only stays in view, one within 6 or one that hits you is fought as `fight_target` would (best hotbar weapon, pursue, `fleeAtHealth` = `minHealth`), and the trip goes on from where the fight ended. The result lists each fight (`fought through zombie (...): TARGET_KILLED`). It hands back with the fight's reason on `LOW_HEALTH_BAILOUT`, `IN_LAVA`, `ON_FIRE` or death, and on a second failed fight (escaped, unreachable, timed out); hits not from a mob (a fall, fire) or from one beyond 16 blocks (a ghast) still stop it with `TRAVEL_DAMAGED`. Not with `retrace`.

```json executor-call
{"tool":"travelTo","arguments":{"x":120,"z":-40,"fightThrough":true,"minHealth":10}}
```

```json executor-call
{"tool":"travelTo","arguments":{"x":-180,"z":-610,"tolerance":16,"stopWhenSeen":"minecraft:nether_bricks"}}
```

```json executor-call
{"tool":"travelTo","arguments":{"yaw":-90,"distance":300,"build":false,"timeoutMs":120000}}
```

```json executor-bad-call
{"tool":"travelTo","arguments":{"x":10,"z":10,"yaw":90,"distance":50}}
```

### exploreFrontier

Stood spots and unverified seen_surface blocks with dy and heading, plus per-heading search coverage and sightings. blockId pages remembered blocks of that id. It chooses nothing.

```json executor-call
{"tool":"exploreFrontier","arguments":{"radius":128,"limit":8,"offset":8}}
```

### mine

Mine one observed, in-range block coordinate with its exact current blockId. It turns to a visible part, aiming around plants where possible. Instant-break replaceable vegetation or flowers obstructing a remembered target is cleared with vanilla attacks and its removal reported; solid obstructions still fail. It never substitutes another solid target or selects a tool.

timeoutMs defaults to 15000 and accepts 1..600000ms, matching act and sequence break_block. Program deadlines still apply.

```json executor-call
{"tool":"mine","arguments":{"x":11,"y":64,"z":10,"expectedBlockId":"minecraft:oak_log","timeoutMs":15000}}
```

### say

Send public chat, a private message, or nearby proximity speech. say accepts up to 256 Unicode code points. Direct speech requires an observed player UUID in recipientId; supplying only recipientId defaults audience to direct. Other audiences cannot use recipientId.

```json executor-call
{"tool":"say","arguments":{"message":"I found the marked chest.","audience":"proximity"}}
```

### wait

Pause briefly and wait for the body result.

```json executor-call
{"tool":"wait","arguments":{"durationMs":500}}
```

### act

Execute one supported advanced player action. Supply exactly the fields required by that actionType. Optional `reflexes:[...]` installs reflex rules before the action starts (control topic tool:reflexes).

```json executor-call
{"tool":"act","arguments":{"actionType":"wait","arguments":{"durationMs":500}}}
```

### sequence

Execute 2 to 8 known actions in order, stopping on the first factual failure. results contains step receipts. Optional `reflexes:[...]` installs reflex rules before the first step (control topic tool:reflexes). When a step attempted movement, mining, or pickup, postAction samples facts after the last attempted step. This pair walks to and mines one observed, reachable block in one call; choose subsequent targets from that fresh result.

```json executor-call
{"tool":"sequence","arguments":{"actions":[{"actionType":"navigate_to","arguments":{"x":11.5,"y":64,"z":9.5,"tolerance":1,"sprint":true,"timeoutMs":30000}},{"actionType":"break_block","arguments":{"x":11,"y":64,"z":10,"expectedBlockId":"minecraft:oak_log","timeoutMs":15000}}]}}
```

Optional finish:{summary} requests verification of the immutable active goal after every step succeeds and fresh final facts are available. A failed step skips finish; action success alone does not prove the goal. Read the returned finish verification facts. If AWAITING_OPERATOR_CONFIRMATION, report once with say and end the turn until new input.

```json executor-call
{"tool":"sequence","arguments":{"actions":[{"actionType":"craft_inventory","arguments":{"recipeId":"minecraft:oak_planks","count":4,"timeoutMs":15000}},{"actionType":"craft_inventory","arguments":{"recipeId":"minecraft:stick","count":4,"timeoutMs":15000}}],"finish":{"summary":"Crafted the requested sticks; verify current inventory."}}}
```

### takeTask

With no active task, a player message in this conversation that asks you to do something is yours to accept. Call takeTask to adopt it: request defaults to that player's latest words, so rewrite it as the concrete task when that is clearer. If you have a paused task and they say "continue", call takeTask with resume:true; only an operator can give a paused agent a different task. On a completed agent, name what to continue in request. Pass requesterId only when several players messaged you. Minecraft starts the task, validates it first (PENDING: it starts by itself), or refuses (taken over, busy, paused, unclear request, requester offline) with a reason to relay using say. takeTask never replaces an active task. After success end the turn; the task turn starts at once with every tool. Plain chat needs only say.

```json executor-call
{"tool":"takeTask","arguments":{"request":"Craft a stone pickaxe and bring it to me."}}
```

```json executor-bad-call
{"tool":"takeTask","arguments":{"requesterId":"Lucas"}}
```

### finish

Ask Minecraft to verify the immutable active goal. A failed check keeps the goal active.

```json executor-call
{"tool":"finish","arguments":{"summary":"Crafted and collected the iron pickaxe."}}
```

## Advanced action reference

Call through act, startAction, or a sequence step. Optional fields may be omitted. Capabilities lists the current action contract.

### move_to

Fields: `x`, `y`, `z`, `tolerance`, `sprint` optional (default true).

move_to and navigate_to fail with LAVA_FLOW, before moving, when the route enters a cell seen lava flows into next (lava beside its feet or head, or over its head) from outside such cells; the failure names the cell and the lava. A body already in a flow's way may cross such cells to get out. A stop with a seen flow on its way adds `lava flowing at the stop` with when it arrives.

```json executor-call
{"tool":"act","arguments":{"actionType":"move_to","arguments":{"x":12,"y":64,"z":12,"tolerance":1,"sprint":true}}}
```

### control

Fields: `forward`, `strafe`, `jump`, `sneak`, `sprint`, `attack`, `use`, `yaw`, `pitch`, `selectedSlot`, `hand`, `ticks`, `instantLook` optional.

The view turns before movement/clicks; `instantLook:true` snaps it. Normal completion retains authored sneak for up to 10 settling ticks, with movement/clicks released. Branch stops, damage, fire, water and ladders skip settling.

```json executor-call
{"tool":"act","arguments":{"actionType":"control","arguments":{"forward":0,"strafe":1,"jump":false,"sneak":true,"sprint":false,"attack":false,"use":true,"yaw":90,"pitch":15,"selectedSlot":3,"hand":"off","ticks":10}}}
```

### control_sequence

Fields: `frames`, `maxTicks`.

```json executor-call
{"tool":"act","arguments":{"actionType":"control_sequence","arguments":{"frames":[{"forward":0.5,"strafe":0,"jump":false,"sneak":false,"sprint":false,"attack":false,"use":false,"yaw":90,"pitch":0,"selectedSlot":0,"hand":"main","ticks":20,"branches":[{"condition":"horizontal_collision","value":true,"nextFrame":1}]},{"forward":0,"strafe":0,"jump":false,"sneak":false,"sprint":false,"attack":false,"use":false,"yaw":90,"pitch":0,"selectedSlot":0,"hand":"main","ticks":1}],"maxTicks":40}}}
```

### look_at

Fields: `x`, `y`, `z`.

The turn keeps off calm endermen's eyes. When the exact line to the point meets one, the view settles a few degrees off it and the result names that enderman.

```json executor-call
{"tool":"act","arguments":{"actionType":"look_at","arguments":{"x":12,"y":65,"z":12}}}
```

### attack

Fields: `targetId`, `timeoutMs`.

```json executor-call
{"tool":"act","arguments":{"actionType":"attack","arguments":{"targetId":"550e8400-e29b-41d4-a716-446655440000","timeoutMs":15000}}}
```

The Ender Dragon is hit through its parts. Each part is its own entity row with its own uuid, plus `parentId` (the dragon) and `partName` (for example head or body); use that part uuid as `targetId`. attack swings once at a part within reach and under your aim ray (`TARGET_TOO_FAR`, `TARGET_OBSTRUCTED` otherwise); repeat it for more hits. End crystals are ordinary entity rows: attack them in reach, or shoot them with use_ranged without aim fields. A crystal with `appearance.caged` stands inside iron bars on every side and above: arrows stick in the bars, so climb beside its pillar to the cage and break bars (or reach the crystal) before hitting it; the explosion hurts at close range. fight_target also takes a part uuid: it walks to that part and swings at it each cooldown while it is in reach, and the dragon is the target that dies; other non-living targets fail `TARGET_NOT_LIVING`. The head takes full damage, other parts a quarter plus 1. A perched dragon (motion `perched`, sitting on the central fountain) takes no arrow damage (arrows bounce off burning) and takes off after about 50 damage. Passing wings fling a player dozens of blocks with 5 damage: from a pillar or an island edge that is a long fall or the void. use_ranged also accepts a part or crystal uuid; without aim fields it allows for drop and leads the dragon's flight. A succeeded attack proves the swing, not damage; a bow message reports what you saw of the arrow. Entity rows do not report the dragon's health, and a crystal missing from fresh facts may only be out of view, so treat a missing row as unknown; look again with the crystal in view, or use sounds and the boss bar, before deciding it is gone.

Entity `appearance` reports visible golem `cracks`, sheep `woolColor`/`sheared`, cloud type/radius/shrinking/growing. Nearby `player.clouds` reports bounds, contact, arming or harmful/unknown, `growing` with `reachesYouInS` (when its spreading edge reaches where you stand), and known exits with unverified routes. Fireball breath spreads from 3 to 7 blocks over 30 s, so stand well clear of its edge. Breath harm requires received cloud magic; contact alone is danger. Clouds alert once on sight and once on contact. Dragon fireballs raise incoming-projectile warnings and match the `fireball_incoming` reflex; shields cannot stop their clouds, and the `cloud_near` reflex senses them.

### fight_target

fight_target can continue until a count, with pickup: add `untilItem` and `untilCount` and it keeps fighting the target's mob type in the area, retargeting the next one and picking up the drops, until the inventory holds `untilCount` of `untilItem` (blaze rods from blazes, ender pearls from endermen). The named target is fought first; the run is the fight_until engine with `weapon:"auto"` (fields `collect`, default true, and `fleeAtHealth` apply; your `pursue`, `shield`, `sneak` and `desiredRange` hold for every engagement: `pursue:false` fights in place with no walking to cover, backing off or ledge trips, `shield:true` raises the shield against every mob type and `shield:false` keeps it down; `timeoutMs` is the whole run, at least 180000, at most 600000; `roof:true` against an enderman as in fight_until). The result names the kills, the items gained and why it stopped. Count mode also starts from your plan: when an open plan step checks `has:<item>*N` and `<item>` is the target's drop (blaze -> blaze_rod, enderman -> ender_pearl), a call without `untilItem`/`untilCount` runs to N with collect on, and the result's `countMode` says so. `single:true` fights the one target only; your own `untilItem`/`untilCount` set the count; cancelAction stops the run.

```json executor-call
{"tool":"act","arguments":{"actionType":"fight_target","arguments":{"targetId":"550e8400-e29b-41d4-a716-446655440000","timeoutMs":180000,"untilItem":"minecraft:blaze_rod","untilCount":6}}}
```

Against blazes, shield:true holds toward the target at any range between swings. Pursuit keeps the current deck and steps out of a fire cell while continuing the fight. Shielded or fire-resistant fights wait for the blaze to enter reach; unshielded blocked approaches return control. A shield stance covers idle model time; place_block can provide two-block-high cover to break line of sight. Kill receipts report witnessed drop UUIDs and last-seen positions; pick_up_item accepts these remembered UUIDs and uses their last-seen position until visible again.

Fields: `targetId`, `timeoutMs`, optional `sneak` (default false; holds crouch throughout the fight), `collect` (default false; after the named target dies, walks to the drops you saw fall by pick_up_item's route for up to 15 s and reports each drop picked up or left with the reason), `shield` (default false; requires an equipped offhand shield, raises it between swings once the target is in reach and releases it for each attack, so a pursuing fight closes in at walking or sprint speed (a raised shield walks at a fifth of that); vanilla activation delay, cooldown and direction still apply), `pursue` (default true; false aims and swings in place without movement, jumping or backoff; knockback can still move you), `desiredRange` (1..6, default 2.5), `fleeAtHealth` and `continueWithAttackers` (default false; true with a `targetPolicy`), `untilItem` and `untilCount` (count mode, above), `single` (default false; true keeps a plan-counted mob to one target), `roof` (count mode, endermen), `includePlayers` optional (default false: players are never follow-through or policy candidates unless true). You chose to fight: the body selects the best hotbar weapon (sword > axe/spear > other tool), turns, closes to reach and swings at 90%+ attack charge. Within reach a pursuing fight moves like a player between your calls: while the sword recharges it stays just outside the target's own melee reach and steps in, sprinting, as the charge completes (a sprint hit knocks the target back); against a living target with headroom it jumps so the charged swing lands while falling (a critical, x1.5; never on a dragon part, which takes no criticals); it circles the target, changing side irregularly so shots aimed where you stood miss, never onto unsafe footing; a projectile about to hit that your raised shield does not face is side-stepped; with a seen drop of 5+ blocks, the void or lava behind you within a hit's push it circles away from that side and never steps back; at low health (6, or fleeAtHealth+4) it keeps out of reach and stops jumping. Against the dragon it does not circle (its wings throw anyone beside or behind it). Results add `footwork` counts (crits, sprint hits, dodged shots, time circling off a drop). pursue:false keeps all of it off. The fight ends when the named target dies or is gone; pass `continueWithAttackers:true` (or a `targetPolicy`) to go on to the next mob already attacking you (never a creeper, never one that is not attacking) until none remain. The approach plans only over terrain you have seen: `TARGET_UNREACHABLE` means the whole area you can walk was seen and none of it reaches; with no route through seen terrain (one may exist out of sight), it holds position and swings if the target enters clear melee reach, until your timeout or bail-out; FIGHT_TIMED_OUT reports NO_SEEN_ROUTE and geometry if it remained waiting. Results: `TARGET_KILLED`, `TARGET_GONE`, `LOW_HEALTH_BAILOUT` (your fleeAtHealth reached; body idle, no retreat performed), `TARGET_UNREACHABLE`, `APPROACH_BLOCKED` (stalled or 5 s without progress; names what blocked), `TARGET_ESCAPED`, or `FIGHT_TIMED_OUT`; each message lists all kills and any remaining threats (uuid, distance, swelling creepers). The target may be a `player.threat` uuid behind you, or an Ender Dragon part uuid (it swings at that part). Crouching limits walking off an edge; it does not anchor you against airborne knockback. For crouching while only shielding, use a control frame with sneak:true, use:true, hand:"off" and your chosen facing.

```json executor-call
{"tool":"act","arguments":{"actionType":"fight_target","arguments":{"targetId":"550e8400-e29b-41d4-a716-446655440000","timeoutMs":15000,"fleeAtHealth":6}}}
```

### fight_until

Gets a mob drop in one call (blaze rods from blazes, ender pearls from endermen): fights one mob type until the inventory holds `untilCount` of `untilItem`. Each engagement targets the nearest seen living mob of that type inside the area (one already targeting you first): a bow volley (use_ranged untilDead, same aim, draw and arrow watch) or a melee fight_target (same reach, swing timing and route checks). `weapon:"auto"` uses the bow when the target is past melee reach, in clear sight, and a bow and arrows are carried, otherwise the best hotbar melee weapon; an enderman is always fought in melee (vanilla endermen teleport away from arrows) and the first hit provokes it. With `collect` the drops seen to fall are walked to after each kill by pick_up_item's route. With a spot (`x`,`y`,`z`) the body walks back to it between engagements. An auto volley lasts at most 15 s and a melee engagement 30 s before the target and weapon are chosen again; a target an engagement failed on is passed over for 15 s.

Stops: SUCCEEDED `UNTIL_COUNT_REACHED` once the count is held; `FIGHT_UNTIL_TIMED_OUT` at `timeoutMs`; `LOW_HEALTH_BAILOUT` at or below `fleeAtHealth` (body idle, no retreat); `IN_LAVA` on new lava contact; `AGENT_DEAD`; `OUT_OF_ARROWS`/`BOW_NOT_EQUIPPED` with `weapon:"bow"` (auto switches to melee); `NO_TARGET_SEEN` after 30 s without a seen target in the area; `SPOT_UNREACHABLE` after two failed walks back; the failing code after two engagements in a row fail with the same code without a kill; cancelAction. Fire does not stop it: in a fire block the body walks to the nearest seen exit and fights on while it burns. With a shield in the offhand it lowers the weapon and raises the shield toward a seen shot about to hit (vanilla blocking: a quarter-second raise, front arc only), then fights on. After a kill whose drop it did not see fall, it looks toward where the target died and, with `collect`, picks up a drop it then sees. Armed reflexes pause and resume it like fight_target. The result lists fire time, steps off fire, shield raises and blocks, cover moves, drops looked for and found, kills, the item count before and after, arrows used, bow and sword engagements, each ending code and the last engagement messages.

Fields: `mob` (entity id), `untilItem` (item id), `untilCount` (1-2304, total held), optional `weapon` (`auto` default, `bow`, `sword`), `collect` (default true), `fleeAtHealth` (default 6), `x`,`y`,`z` (spot; the area centre, else where the call started), `radius` (default 24, 2-48), `timeoutMs` (default 180000, max 600000), `roof` (default false; endermen only).

`roof:true` against endermen: before provoking, the body builds a one-cell shelter on firm ground where it stands or within 2 blocks (two-high walls on three sides, a roof, and a two-high doorway toward the nearest enderman with a block over it; 9 carried full blocks of one kind, the kind held most, never obsidian). A 2.9-block-tall enderman fits neither the cell nor the doorway, so from the middle of the cell you hit it in the doorway while it cannot reach you (vanilla). A roof hides you from an enderman's stare check, so the body steps two cells out to stare a calm one hostile, walks back in and swings in place; after a kill it walks out to the drop and back. Missing blocks stop it at once with `ROOF_BLOCKS_MISSING` (how many are needed and carried); a failed build stops with `ROOF_NOT_BUILT`.

```json executor-call
{"tool":"act","arguments":{"actionType":"fight_until","arguments":{"mob":"minecraft:blaze","untilItem":"minecraft:blaze_rod","untilCount":6,"weapon":"auto","fleeAtHealth":8}}}
```

### flee_from

Every fight/flee stop leaves the body idle; no further retreat runs. A stop or bailout alone proves no safety.

Fields: `targetId`, `distance` (1..64), `timeoutMs`. Sprints away from the target and every other hostile threat within 16 blocks (nearer ones and creepers, especially swelling ones, push hardest), jumping steps and steering around walls, hazards and deep drops, until at least `distance` away and the target is not closing (`ESCAPED`), it lost you (`TARGET_LOST`), it is gone (`TARGET_GONE`, a failed result with last/best separation, never proof of escape), `FLEE_BLOCKED` (all tested headings failed) or `FLEE_TIMED_OUT`. It probes all 12 headings in 30-degree steps, including backtracking out of a dead end, with one-block jumps/step-ups. A physically stalled heading is excluded and alternatives tried before FLEE_BLOCKED; moving 1.5 blocks resets those exclusions. Results include moved distance, best separation and tried headings. It never reports escape while another threat inside `distance` is still closing in or any creeper is within 7 blocks. Ending while still swimming, the result gives your air and the land you can see (nearest first); choose where to swim. Navigation stops at its destination; flee_from checks separation while threats keep moving. You choose the trade-off.

```json executor-call
{"tool":"act","arguments":{"actionType":"flee_from","arguments":{"targetId":"550e8400-e29b-41d4-a716-446655440000","distance":12,"timeoutMs":8000}}}
```

### select_item

Fields: `itemId`.

Selects the hotbar slot (0-8) holding `itemId`; it moves nothing. A stack elsewhere fails with ITEM_NOT_IN_HOTBAR naming its inventory slot; use select_tool to move it. Equivalent matching stacks select the first hotbar stack; different components or durability fail with AMBIGUOUS_ITEM. In creative mode an absent item is created in the selected hotbar slot when it is empty, else HOTBAR_SLOT_OCCUPIED.

```json executor-call
{"tool":"act","arguments":{"actionType":"select_item","arguments":{"itemId":"minecraft:oak_log"}}}
```

### use_item

Fields: `durationMs`, `hand` optional, `expectedItemId` optional, `mode` optional, `aimX` optional, `aimY` optional, `aimZ` optional (all three together), `acceptLavaRisk` optional.

Use acts along your current view, as a right click does: a block the crosshair meets takes the click first, else the held item acts. `mode:"once"` releases after one accepted use, for instant items such as a thrown snowball, pearl or eye, a placed or filled bucket, or flint and steel. The default `"hold"` keeps use held for durationMs, for eating, drinking, drawing a bow or blocking. A bucket's own ray takes the first fluid source on that view line, so look_at the fluid surface first, or use interact_block on the fluid cell. A filled bucket empties into the cell on the clicked face's side of the first block its ray meets. Lava with no water above or beside that cell stays a source and spreads 3 cells, 1.5 s each (7 cells, 0.5 s each in the Nether). A pour whose spread over the cells you know reaches your body is refused with LAVA_POUR_AT_BODY before it empties; the failure names the landing cell and a cell where water would cast it to obsidian. `acceptLavaRisk:true` pours it anyway.

Inspect first with `mode:"inspect"` before throwing pearls, snowballs or eggs; it returns a nominal `throwPreview` without use input. Optional aimX/aimY/aimZ chooses the world point; otherwise it uses your view. `mode:"once"` reports the preview with accepted input. The preview traces vanilla flight through observed terrain, reporting impactCell, distance and the `arrival` point: a pearl puts you where it was one tick before it struck, so off a wall face you arrive in the air beside it. footing, headroom, below (solid/void/unknown) and `dropAfterArrival` describe that arrival; with aim fields, `aimOffset` gives blocks the impact lies `below` your aim point and `short` of it (negative: past it); an impact well below the aim, short or past, means the arc dips under the target: raise the aim. `mobsNearLanding` lists visible hostile or neutral mobs within 8 blocks of the impact, nearest first; `angry` marks one already after you. `viewMeetsEndermanEyes` names a calm enderman whose eyes this throw's view meets: holding it provokes the enderman. `footing:false` or `unknown_terrain` means the projectile may land without support (void/fall). The result's landing fields are authoritative predicted facts, not proof of a safe teleport. Unknown terrain ends the prediction; spread and entity hits remain uncertain. You choose whether to throw.

Ender eyes only locate a stronghold (20% break per throw). Inside, explore for the portal room (silverfish spawner, lava, stairs), rather than throwing eyes. Keep 12 eyes minus pre-filled frames for the portal.

Most foods need 1.6 s of held use; allow 2000 ms (40 ticks) for the use-start tick. A shorter request can release use before consumption. The result confirms accepted input only; downstream effects are unconfirmed. Check food count, hunger and saturation in fresh facts to verify consumption. Full hunger blocks ordinary food even at low health.

```json executor-call
{"tool":"act","arguments":{"actionType":"use_item","arguments":{"durationMs":2000,"hand":"main","expectedItemId":"minecraft:apple"}}}
```

### break_block

Fields: `x`, `y`, `z`, `expectedBlockId` optional, `timeoutMs`, `acceptLavaRisk` optional.

A block with lava beside it is refused with LAVA_BEHIND before any swing, since breaking it may let lava flow in; the failure says whether the lava is above, beside or below. `acceptLavaRisk:true` breaks it anyway. Where water evaporates (the Nether), breaking the only block you stand on is refused with UNSEEN_BELOW when the bottom of the drop under it is unseen, or the drop ends in lava, fire, the void or a fall that kills at your health; a seen floor within a survivable fall is broken. `acceptLavaRisk:true` breaks it anyway. A break that opens onto lava in view says `lava now open` with its side and spread delay (about 1.5 s in the Overworld, 0.5 s in the Nether).

```json executor-call
{"tool":"act","arguments":{"actionType":"break_block","arguments":{"x":11,"y":64,"z":10,"expectedBlockId":"minecraft:oak_log","timeoutMs":15000}}}
```

### pick_up_item

Fields: `targetSelector`.

```json executor-call
{"tool":"act","arguments":{"actionType":"pick_up_item","arguments":{"targetSelector":"550e8400-e29b-41d4-a716-446655440000"}}}
```

### place_block

Fields: `x`, `y`, `z`, `face`, `itemId`, `desiredState` optional, `faceMode` optional (`preferred` default, `strict`).

`x`,`y`,`z` is the destination to fill, including replaceable grass, leaf litter or thin snow; nonreplaceable flowers remain occupied. `face` prefers the clicked neighbour side: `up` means support at y-1. For ground at y=64, send y=65. Preferred mode tries another visible adjacent support within reach only when vanilla predicts the same stable block state; strict mode requires the named face. Orientation-sensitive substitutions that change state fail. The runtime selects `itemId` from slots 0-35 and reports the used face/support. Existing failure codes carry `cause`: NO_SUPPORT (observed neighbours listed), SUPPORT_FACE_HIDDEN (eye and visible faces), SUPPORT_NOT_OBSERVED (neighbours unknown), DESTINATION_OCCUPIED (id, replaceability), BODY_IN_DESTINATION, OUT_OF_REACH, PLACEMENT_CONTEXT_MISMATCH (visible click cannot fill this cell) or PLACEMENT_STATE_MISMATCH. Failures include the requested support coordinate; an actual click also names its support. Unknown terrain stays unknown.

An observed block's `placeableFaces` are the faces of it you can click now to place into the empty cell beside that face, judged by this same rule for the item named in `coverage.sections.blocks.placeableFacesFor`: your held block item, or cobblestone standing in for a full block (`placeableFacesStandIn`) when you hold none. Another item can differ: snow adds a layer to thin snow, and a slab merges into a matching bottom slab.

```json executor-call
{"tool":"act","arguments":{"actionType":"place_block","arguments":{"x":11,"y":64,"z":10,"face":"up","itemId":"minecraft:cobblestone","desiredState":"minecraft:cobblestone"}}}
```

### chat

Fields: `message`, `audience` optional, `recipientId` optional.

```json executor-call
{"tool":"act","arguments":{"actionType":"chat","arguments":{"message":"I found the cave.","audience":"direct","recipientId":"550e8400-e29b-41d4-a716-446655440000"}}}
```

### wait

Fields: `durationMs`.

```json executor-call
{"tool":"act","arguments":{"actionType":"wait","arguments":{"durationMs":500}}}
```

### set_door

Fields: `x`, `y`, `z`, `open`.

```json executor-call
{"tool":"act","arguments":{"actionType":"set_door","arguments":{"x":11,"y":64,"z":10,"open":true}}}
```

### drop_item

Fields: `slot`, `count`.

```json executor-call
{"tool":"act","arguments":{"actionType":"drop_item","arguments":{"slot":9,"count":1}}}
```

### navigate_to

Fields: `x`, `y`, `z`, `tolerance`, `sprint`, `timeoutMs`.

```json executor-call
{"tool":"act","arguments":{"actionType":"navigate_to","arguments":{"x":12,"y":64,"z":12,"tolerance":1,"sprint":true,"timeoutMs":30000}}}
```

### build_shelter

Fields: `x`, `y`, `z` (interior feet cell), `opening` (`north`, `south`, `east`, `west`), `itemId` (carried full solid block), `roof` optional (default true), `timeoutMs`.

One goal-directed body action builds a one-cell interior with two-high surrounding walls and a one-high opening at eye height above a solid sill on the chosen side. An optional roof covers the body. It approaches the chosen interior, mines partial obstructions and the window with usable hotbar tools, punches out touching fire, and uses visible vanilla placement clicks and carried blocks (block entities are left intact), and reports partial construction on obstruction or displacement. Players use enclosures before projectile fights to contain knockback and intercept shots. Choose the site and opening, then use fight_target with pursue:false to stay inside and swing at enemies approaching the window. Drops inside or at the opening remain available to pick_up_item. Building never starts fighting.

```json executor-call
{"tool":"act","arguments":{"actionType":"build_shelter","arguments":{"x":83,"y":73,"z":91,"opening":"east","itemId":"minecraft:cobblestone","roof":true,"timeoutMs":120000}}}
```

### dig_to

Fields: `pattern` optional (`stairs_down` default, `steep_down`, `stairs_up`, `tunnel`, `shaft`), `y` optional (needed for stairs and shaft), `x` optional, `z` optional, `heading` optional (`north`/`south`/`east`/`west`), `maxBlocks` optional (default 1024), `throughCaves` optional (default true), `maxShaftY` optional (default -20), `stopWhenSeen` optional (a block id), `timeoutMs` (default 600000, the most an action may take).

The fast choice for going deep or through rock: one call digs the whole job at body speed instead of one break_block per call. stairs_down mines the three cells ahead and below each step (a walkable 1-wide staircase, never straight down); steep_down mines four and drops two blocks per step (no fall damage, a third fewer blocks per level, but not walkable back up); stairs_up the two ahead and the jump headroom, tunnel a 1x2 passage. Heading: toward x/z when given (the larger axis first), else `heading`, else the way you face. The body selects the fastest hotbar tool, mines at vanilla speed, mines gravel that falls in, fills a one-block hole under the next step with a carried filler (cobblestone, dirt...), and plugs an opening it made onto lava. Like a player digging the repeated pattern, it handles on its own what needs no decision: a cave beside the stairs is passed and listed; water trickling into the cut is sealed with a carried block (up to 6 blocks a step); an open floor under the next step is followed sideways along the cave wall (it turns, never back up its own stairs), with no wall left it drops onto seen ground within 7 blocks (at most 4 fall damage, only when health stays 14 or more), else it crosses the cave top at its level (a carried block placed as the floor where open, up to 12 steps) until rock is under the next step again; `throughCaves:false` stops at the first cave instead. It stops and returns the facts (position, blocks mined, ores seen, tool uses left, caves passed, drops, water sealed) with: DIG_GOAL_REACHED, DIG_LIMIT_REACHED (maxBlocks), LAVA_AHEAD (seen or heard at the next cells; it never breaks into lava), WATER_AHEAD (more water than a few blocks seal: a lake, aquifer or the sea, or the eyes under water), CAVE_OPENING (a cave under the step it could not follow, drop into or cross), FALLING_BLOCKS, HOSTILE_NEAR (a hostile in sight within 12 blocks), DAMAGE_TAKEN, LOW_HEALTH (8 or less), LOW_FOOD (6 or less), NO_TOOL or TOOL_WORN (2 uses or fewer left; a second pickaxe in the hotbar is used next), INVENTORY_FULL, UNBREAKABLE, NO_FLOOR, DIG_STUCK. After a stop, deal with its cause and call dig_to again with the same target (another heading after a lava or cave stop). Cancel it like any action. Measured with an iron pickaxe: about 60 blocks a minute; steep_down about 2 s per level in stone and 2.5 s in deepslate, stairs_down about 3 s per level; surface to y-55 took 4-9 minutes of digging in 2-4 calls on most measured spots (about 3.5 s per level with its own turns and crossings), the usual stop a mob in sight. A full descent wears out about one iron pickaxe (about 250 blocks), so carry a spare.

shaft digs 1x1 straight down: it breaks the block underfoot with the body centred on it and drops into the hole, a mined block per level. It needs a water bucket in the hotbar or offhand (NO_WATER_BUCKET otherwise): the next floor is unseen until the one above breaks, so a fall past 3 blocks into a cave is caught with water (scooped back after) and lava dropped into gets the bucket poured on it (IN_LAVA, health lost). Where water evaporates (the Nether) no fall is caught, so a floor whose underside is unseen is not broken (UNSEEN_BELOW; stairs_down and steep_down see each step first); only an explicit `throughCaves:true` in the call breaks it anyway (the default does not). It plugs lava seen in its walls (LAVA_AHEAD), stops on lava, water or a deep drop seen below, and after any drop into a cave (CAVE_OPENING). At maxShaftY it goes on as steep_down to `y` in the same call (lava lakes and aquifer lava are common below y-20). Every CAVE_OPENING turns the head once round the cave and adds lava seen (with distance; lava glows across a dark cave) and the lowest floor seen: a way down with no digging, walked with travel_to to that x, y, z. Every result names the first lava seen within 16 blocks; `stopWhenSeen` (e.g. minecraft:lava) ends the dig with TARGET_SEEN once that block is in view.

Ways down, measured with an iron pickaxe (provider-free, 12 surface spots, 4 seeds): shaft 1 s per level (one block mined), steep_down 2.7 s (two), stairs_down about 3 s. Surface to y-55 took 3-4.5 min of digging by shaft (its steep_down part below y-20 included) against 6-11 min by steep_down on the 6 spots both reached (1.9-3.8x, median 2x). shaft is the fast choice above y-20 with a water bucket; steep_down sees each floor before standing on it. The caves met were mostly small pockets: runs that walked each cave's seen floor or lava with travel_to (up to 150 blocks a minute while walking, a third of the walks NO_ROUTE) saw lava within 16 blocks on 2 of 12 spots (2-3.5 min in, one from a walk), digging alone on 1-2. Risks: a shaft breaks into unseen caves (falls of 5-14 blocks were caught with water, no damage) and can drop into lava (lava right under the floor: water poured, 4 health lost); water stopped about a third of all descents with the body under water; caves bring mobs (the usual stop).

```json executor-call
{"tool":"act","arguments":{"actionType":"dig_to","arguments":{"pattern":"steep_down","y":-55,"timeoutMs":600000}}}
```

```json executor-call
{"tool":"act","arguments":{"actionType":"dig_to","arguments":{"pattern":"shaft","y":-55,"timeoutMs":600000}}}
```

### cast_obsidian

Makes Nether portal obsidian from lava with buckets, no diamond pickaxe needed: `count` blocks in a pool, or a whole frame with `frame:true`.

Fields: `x`, `y`, `z` (the site), `axis` optional (`x` or `z`), `frame` optional (default false), `count` optional (1-64, default 4), `timeoutMs` (default 300000).

Makes obsidian in place with buckets, as vanilla does: a lava source with water above or beside it turns to obsidian (water below does nothing; flowing lava touched by water becomes cobblestone). It needs a water bucket; frame mode also needs an empty bucket and carried blocks (cobblestone, cobbled deepslate, netherrack, stone, dirt, blackstone and the like). Every click is a vanilla item use along the body's turned look, within vanilla reach (4.5 blocks), on a face the eye sees; the body walks to a standing spot in reach when none is in reach from where it stands.

Count mode (frame false): the site is a cell of a lava pool you have seen. The body pours the water bucket on a cell beside the pool's edge so the flow runs over the lava sources, waits for the flow (about 2 s), and scoops the water back. It repeats along the pool until `count` new obsidian blocks lie within 8 blocks of the site. An iron pickaxe cannot mine obsidian, so the obsidian stays where it formed.

Frame mode (frame:true): the site is the lowest corner of a 4 wide, 5 high Nether portal frame (the inner opening is 2x3); `axis` is the direction its width runs (taken from obsidian already at the site, else across the line from you to the site). It fills the 10 frame cells (corners are not needed), bottom row first: it takes lava from the nearest seen lava source within 16 blocks with the empty bucket, pours the water into a cell above or beside the frame cell, pours the lava into the frame cell (it turns to obsidian at once), and scoops the water back. Where no face to click is in sight it first places up to 3 carried blocks (out of the frame's plane or at its corners, never in the opening). Obsidian already in a frame cell is kept. Water it pours flows for a few seconds before it is scooped and can turn nearby pool lava to obsidian too.

Lava is never poured where use_item would refuse it with LAVA_POUR_AT_BODY (a pour whose flow reaches the body before water touches it); three refusals of one cell leave that cell out and the result says so.

Stops with the counts (new obsidian seen, frame cells seen cast, missing and unseen, pours and scoops, a water source left behind, seen lava sources left, buckets carried): CAST_COUNT_REACHED, FRAME_COMPLETE, NO_LAVA_IN_REACH (no seen lava source within 16 blocks), NO_WATER_BUCKET, NO_EMPTY_BUCKET, NO_STAND_SPOT (no spot in reach could be walked to; 12 walks without a click), FRAME_CELL_BLOCKED (a frame cell holds another block: break it and call again), FRAME_CELL_UNSEEN (a frame cell you have not seen: the body looked at it and found no seen spot to see it from; move where you can see it and call again), LAVA_POUR_AT_BODY (every remaining cell was refused), DAMAGE_TAKEN, LOW_HEALTH (8 or less), IN_LAVA, ON_FIRE, WATER_AHEAD (eyes under water, breath running down), HOSTILE_NEAR (a hostile in sight within 12 blocks), CAST_TIMED_OUT. Cancel it like any action.

```json executor-call
{"tool":"act","arguments":{"actionType":"cast_obsidian","arguments":{"x":-21,"y":-54,"z":66,"axis":"x","frame":true,"timeoutMs":300000}}}
```

### barter_until

Gets ender pearls (or another barter item) from piglins for gold ingots in one call.

Fields: `itemId` (the item to collect, e.g. `minecraft:ender_pearl`), `count` (1-64), `timeoutMs` (default 300000).

Barters with piglins until `count` of the item have been gained. It needs a gold armour piece worn (NO_GOLD_ARMOUR otherwise; vanilla piglins attack a player without one) and gold ingots carried. The body walks to the nearest calm adult piglin it sees within 16 blocks that is not already examining an item, turns to it and throws one gold ingot toward its feet (a vanilla Q drop from the selected stack), then turns to the next free piglin; with none free in view it turns on the spot in 60 degree steps to find one. A piglin examines an ingot for about 6 s and throws a random return toward you; the body walks to returned items it sees within 8 blocks and picks them up by touch, as vanilla does. Every returned item is kept; the count is the change in the carried amount of `itemId` since the call started.

Stops with the counts (item gained and held, ingots thrown and left, every item gained): BARTER_COUNT_REACHED, OUT_OF_GOLD (no ingot left and no piglin still examining one), NO_PIGLIN (no calm adult piglin in sight after a full look around in 60 degree steps), PIGLIN_ANGRY (a piglin you see goes for you), NO_GOLD_ARMOUR, DAMAGE_TAKEN, LOW_HEALTH (8 or less), IN_LAVA, ON_FIRE, HOSTILE_NEAR (a non-piglin hostile in sight within 12 blocks), BARTER_TIMED_OUT. Cancel it like any action.

```json executor-call
{"tool":"act","arguments":{"actionType":"barter_until","arguments":{"itemId":"minecraft:ender_pearl","count":12,"timeoutMs":300000}}}
```

### travel_to

Fields: `x` optional, `z` optional (give x and z, or yaw and distance), `y` optional, `yaw` optional, `distance` optional, `tolerance` optional, `build` optional, `retrace` optional, `dimension` optional (requires retrace), `stopWhenSeen` optional, `minHealth` optional, `fightThrough` optional, `timeoutMs` optional. See travelTo.

```json executor-call
{"tool":"act","arguments":{"actionType":"travel_to","arguments":{"x":-180,"y":70,"z":-610,"tolerance":8}}}
```

### transfer_container

Fields: `x`, `y`, `z`, `sourceKind`, `sourceSlot`, `destinationKind`, `destinationSlot`, `count`, `expectedItemId`, `timeoutMs`.

```json executor-call
{"tool":"act","arguments":{"actionType":"transfer_container","arguments":{"x":11,"y":64,"z":10,"sourceKind":"player","sourceSlot":9,"destinationKind":"container","destinationSlot":0,"count":1,"expectedItemId":"minecraft:iron_ingot","timeoutMs":15000}}}
```

### craft_inventory

Fields: `recipeId`, `count`, `timeoutMs`.

```json executor-call
{"tool":"act","arguments":{"actionType":"craft_inventory","arguments":{"recipeId":"minecraft:oak_planks","count":4,"timeoutMs":15000}}}
```

### craft_table

Fields: `recipeId`, `x`, `y`, `z`, `count`, `timeoutMs`.

```json executor-call
{"tool":"act","arguments":{"actionType":"craft_table","arguments":{"recipeId":"minecraft:iron_pickaxe","x":11,"y":64,"z":10,"count":1,"timeoutMs":30000}}}
```

### furnace_transaction

Fields: `x`, `y`, `z`, `operation`, `timeoutMs`, `inventorySlot` optional, `count` optional, `expectedItemId` optional, `fuelSlot` optional, `fuelCount` optional, `expectedFuelItemId` optional.

Opens the reachable visible furnace and closes after moving items. `load`: `inventorySlot`, `count`, `expectedItemId` for input, plus `fuelSlot`, `fuelCount`, `expectedFuelItemId`; exact counts, different slots 0-35. Returns after loading, so work elsewhere. `take_output` without stack fields takes all output into available inventory. Legacy `insert_input`, `insert_fuel`, or exact `take_output` use `inventorySlot`, `count`, `expectedItemId`.

`furnaces` observations remember used furnaces: input/fuel/output item counts, state loaded/estimate/missing, estimatedReadyAtEpochMs when enough fuel. Vanilla furnace: 10 s/item; coal 8 items, planks/log 1.5, stick 0.5. Loaded chunks supply current facts and one completion attention with the output count/location for your load. Unloaded or other-dimension memories keep dated estimates, never confirm completion. Choose what/when to load and collect; no polling.

```json executor-call
{"tool":"act","arguments":{"actionType":"furnace_transaction","arguments":{"x":11,"y":64,"z":10,"operation":"load","inventorySlot":9,"count":8,"expectedItemId":"minecraft:raw_iron","fuelSlot":10,"fuelCount":1,"expectedFuelItemId":"minecraft:coal","timeoutMs":15000}}}
```

```json executor-call
{"tool":"act","arguments":{"actionType":"furnace_transaction","arguments":{"x":11,"y":64,"z":10,"operation":"take_output","timeoutMs":15000}}}
```

### equip_item

Fields: `sourceSlot`, `targetSlot`, `expectedItemId`.

```json executor-call
{"tool":"act","arguments":{"actionType":"equip_item","arguments":{"sourceSlot":9,"targetSlot":"head","expectedItemId":"minecraft:iron_helmet"}}}
```

### select_tool

Fields: `sourceSlot`, `hotbarSlot`, `expectedItemId`, `minRemainingDurability`.

Like the vanilla number key, swaps the whole stack in inventory slot `sourceSlot` (0-35), any item, with hotbar slot `hotbarSlot` (0-8), empty or occupied, and selects it; the hotbar stack takes `sourceSlot`. Items without durability pass `minRemainingDurability` 0. Armor and offhand slots need menu_click.

```json executor-call
{"tool":"act","arguments":{"actionType":"select_tool","arguments":{"sourceSlot":9,"hotbarSlot":0,"expectedItemId":"minecraft:iron_pickaxe","minRemainingDurability":1}}}
```

### block_with_shield

Fields: `durationMs`.

```json executor-call
{"tool":"act","arguments":{"actionType":"block_with_shield","arguments":{"durationMs":2000}}}
```

### use_ranged

use_ranged can continue until a count, with pickup: add `untilItem` and `untilCount` and the bow keeps shooting the target's mob type in the area, retargeting the next one and picking up the drops, until the inventory holds `untilCount` of `untilItem`. The named target is shot first; the run is the fight_until engine with `weapon:"bow"` (`collect` default true, `fleeAtHealth`, your `drawDurationMs` and `trackTarget` for every volley; `timeoutMs` optional, the whole run, default 180000, at most 600000). The result names the kills, the items gained and why it stopped. As with fight_target, an open plan step `has:<item>*N` for the target's drop starts count mode to N unless you pass `untilItem`/`untilCount` or `single:true`.

Fields: `targetId`, `drawDurationMs`, `timeoutMs` optional (required without `untilDead:true`), `aimX` optional, `aimY` optional, `aimZ` optional, `trackTarget` optional, `untilDead` optional, `fleeAtHealth` optional, `collect` optional (the last two only with `untilDead:true` or count mode), `untilItem` optional and `untilCount` optional (count mode, above), `single` optional (one target, no plan count).

Without aim fields the bow aims as a practised archer does: it turns to the middle of the target's visible body (the target may be outside your view if nothing blocks the line; you turn to it), leads a moving target (the flying dragon too) by its seen motion over the arrow's flight, holds above that point by the arrow's drop for this draw, re-aims while drawing at a moving target, then releases. Omit aim fields for crystals and the dragon alike; the result gives the aim point used. `trackTarget:true` also re-aims at a still target while drawing. `aimX`/`aimY`/`aimZ` instead fix one world point you choose (all three together, not with trackTarget; the bow adds nothing to it), and the result says where that point's arc reaches the target's range. A target past the bow's reach fails `RANGED_TARGET_OUT_OF_REACH`; one behind blocks that stop arrows fails `TARGET_OBSTRUCTED` naming the block (iron bars and glass panes are see-through but stop arrows). After release the bow watches your arrow for up to 3 s, as you would, and its message says how it ended: struck the target (it flashed hurt, or it broke), bounced off a perched dragon, or missed with the closest pass in blocks above/below and left/right of the target's centre plus the vanilla scatter at that range (every arrow leaves up to 1 block per 58 blocks off the aim each way, so a pass within scatter says nothing about the aim), stuck in a named block, or lost from sight. With a held pearl, snowball or egg, inspect first via use_item `mode:"inspect"` with the same aim, then choose whether to throw. This aims and uses once, reporting throwPreview; drawDurationMs applies only to bows. `footing:false` or `unknown_terrain` means the projectile may land without support (void/fall); the result's landing fields are authoritative predicted facts.

```json executor-call
{"tool":"act","arguments":{"actionType":"use_ranged","arguments":{"targetId":"550e8400-e29b-41d4-a716-446655440000","drawDurationMs":1000,"timeoutMs":15000}}}
```

```json executor-call
{"tool":"act","arguments":{"actionType":"use_ranged","arguments":{"targetId":"550e8400-e29b-41d4-a716-446655440000","drawDurationMs":1000,"timeoutMs":15000,"aimX":8.5,"aimY":66,"aimZ":0.5}}}
```

`untilDead:true` (bow only) keeps shooting the same target: after each arrow's flight ends the bow draws, aims and looses again as a player holding right-click does, each arrow aimed as above, until the target dies (`TARGET_KILLED`), `timeoutMs` ends (`RANGED_VOLLEY_TIMED_OUT`; default 20000, at most 60000), the target is out of your line of sight for 3 s or every shot is refused for 3 s (`TARGET_NOT_VISIBLE` or the refusal's code), your health reaches `fleeAtHealth` (`LOW_HEALTH_BAILOUT`), you newly enter lava or fire (`IN_LAVA`, `ON_FIRE`), arrows run out (`OUT_OF_ARROWS`), 3 draws in a row loose nothing, or you send another command. The result lists every arrow's outcome in order, the hits, the arrows left and the kill. `collect:true` then walks to the drops you saw fall from the kill, one at a time by pick_up_item's route (seen footing, no lava or fire cells; a blaze rod is followed on your own deck) for up to 15 s, and reports each drop picked up or left with the reason (it burns in lava or fire below, no inventory room, the route failed, time ran out).

```json executor-call
{"tool":"act","arguments":{"actionType":"use_ranged","arguments":{"targetId":"550e8400-e29b-41d4-a716-446655440000","drawDurationMs":1000,"untilDead":true,"timeoutMs":20000,"collect":true}}}
```

### interact_block

Fields: `x`, `y`, `z`, `face`, `hand`, `expectedItemId`, `hitX` optional, `hitY` optional, `hitZ` optional, `acceptLavaRisk` optional (use_item's LAVA_POUR_AT_BODY rule).

One right click at a visible face. The block's own use goes first (open a chest, press a button, sleep in a bed, fill a cauldron); if it does not take the click, the held item acts along the same look, as in vanilla: a bucket fills or empties, flint and steel lights. A water or lava cell is a valid target: it has no outline, so the aim is its visible surface on that face, and the bucket takes the first source on that line. To place fluid, target the solid face it should go against. A held-use item (food, bow, shield) returns HELD_USE_REQUIRED; use use_item. The result confirms an accepted click; check the held item and blocks for the effect.

```json executor-call
{"tool":"act","arguments":{"actionType":"interact_block","arguments":{"x":11,"y":64,"z":10,"face":"west","hand":"main","expectedItemId":"minecraft:air"}}}
```

```json executor-call
{"tool":"act","arguments":{"actionType":"interact_block","arguments":{"x":12,"y":63,"z":10,"face":"up","hand":"main","expectedItemId":"minecraft:bucket"}}}
```

### interact_entity

Fields: `targetId`, `hand`, `expectedItemId`, `hitX` optional, `hitY` optional, `hitZ` optional.

One right click on the entity with the selected hand's item, as in vanilla: feed or breed, mount, milk with a bucket, shear, trade. Giving a calm adult piglin a gold ingot hands one over; it examines it for about 6 s, then throws a random return toward you. Collect the dropped items afterwards.

```json executor-call
{"tool":"act","arguments":{"actionType":"interact_entity","arguments":{"targetId":"550e8400-e29b-41d4-a716-446655440000","hand":"main","expectedItemId":"minecraft:wheat","hitX":0,"hitY":0.8,"hitZ":0}}}
```

### dismount

No arguments.

```json executor-call
{"tool":"act","arguments":{"actionType":"dismount","arguments":{}}}
```

### start_fall_flying

No arguments.

```json executor-call
{"tool":"act","arguments":{"actionType":"start_fall_flying","arguments":{}}}
```

### wake_up

No arguments.

```json executor-call
{"tool":"act","arguments":{"actionType":"wake_up","arguments":{}}}
```

### set_flight

Fields: `enabled`.

```json executor-call
{"tool":"act","arguments":{"actionType":"set_flight","arguments":{"enabled":true}}}
```

### write_sign

Fields: `x`, `y`, `z`, `front`, `lines`, `expectedLines`.

```json executor-call
{"tool":"act","arguments":{"actionType":"write_sign","arguments":{"x":11,"y":64,"z":10,"front":true,"lines":["Storage","","",""],"expectedLines":["","","",""]}}}
```

### edit_book

Fields: `slot`, `pages`, `title` optional, `expectedFingerprint`.

```json executor-call
{"tool":"act","arguments":{"actionType":"edit_book","arguments":{"slot":0,"pages":["The bridge is at 12, 64, 12."],"title":"Travel notes","expectedFingerprint":"7ae1bde6c0fc2a4f34d8ad4d405bf364674c4129b8f76164a01eac465c740fd2"}}}
```

### menu_click

Fields: `menuId`, `containerId`, `stateId`, `slot`, `button`, `clickType`, `expectedItemId`, `expectedCount`, `expectedFingerprint` optional.

```json executor-call
{"tool":"act","arguments":{"actionType":"menu_click","arguments":{"menuId":"minecraft:generic_9x3","containerId":2,"stateId":7,"slot":0,"button":0,"clickType":"PICKUP","expectedItemId":"minecraft:iron_ingot","expectedCount":1,"expectedFingerprint":"7ae1bde6c0fc2a4f34d8ad4d405bf364674c4129b8f76164a01eac465c740fd2"}}}
```

### menu_close

Fields: `menuId`, `containerId`, `stateId`.

```json executor-call
{"tool":"act","arguments":{"actionType":"menu_close","arguments":{"menuId":"minecraft:generic_9x3","containerId":2,"stateId":8}}}
```

### beacon_effects

Fields: `menuId`, `containerId`, `stateId`, `primaryEffectId`, `secondaryEffectId`.

```json executor-call
{"tool":"act","arguments":{"actionType":"beacon_effects","arguments":{"menuId":"minecraft:beacon","containerId":2,"stateId":8,"primaryEffectId":"minecraft:speed","secondaryEffectId":"none"}}}
```

### menu_transfer

Fields: `menuId`, `sourceSlot`, `destinationSlot`, `count`, `expectedItemId`, `timeoutMs`, `containerId` optional, `stateId` optional.

```json executor-call
{"tool":"act","arguments":{"actionType":"menu_transfer","arguments":{"menuId":"minecraft:anvil","sourceSlot":0,"destinationSlot":1,"count":1,"expectedItemId":"minecraft:iron_ingot","timeoutMs":15000,"containerId":2,"stateId":7}}}
```

### menu_button

Fields: `menuId`, `buttonId`, `timeoutMs`, `containerId` optional, `stateId` optional.

```json executor-call
{"tool":"act","arguments":{"actionType":"menu_button","arguments":{"menuId":"minecraft:merchant","buttonId":0,"timeoutMs":15000,"containerId":2,"stateId":7}}}
```

### anvil_rename

Fields: `menuId`, `name`, `timeoutMs`, `containerId` optional, `stateId` optional.

```json executor-call
{"tool":"act","arguments":{"actionType":"anvil_rename","arguments":{"menuId":"minecraft:anvil","name":"Miner","timeoutMs":15000,"containerId":2,"stateId":7}}}
```

### respawn

No arguments.

```json executor-call
{"tool":"act","arguments":{"actionType":"respawn","arguments":{}}}
```

## Dependent calls and rejected inputs

Read independent missing details together when their arguments are already known. Keep batches small enough to review their coverage and freshness.

```json executor-calls
{"calls":[{"tool":"inspect","arguments":{"section":"inventory","offset":0,"limit":16}},{"tool":"inspect","arguments":{"section":"mechanics","offset":0,"limit":16}}]}
```

A combined turn can use a known look coordinate and then read its observation. Wait for the observation before choosing an unseen target.

```json executor-calls
{"calls":[{"tool":"act","arguments":{"actionType":"look_at","arguments":{"x":12,"y":65,"z":12}}},{"tool":"observe","arguments":{}}]}
```

These inputs fail the tool boundary. A valid call can still fail current world checks.

```json executor-bad-call
{"tool":"taskMemory","arguments":{"operation":"remember","entry":{"kind":"route","key":"r","label":"r","summary":"Unknown route","from":"a","to":"b","waypoints":[]}}}
```

```json executor-bad-call
{"tool":"observe","arguments":{"radius":10}}
```

```json executor-bad-call
{"tool":"inspect","arguments":{"section":"item"}}
```

```json executor-bad-call
{"tool":"inspect","arguments":{"section":"inventory","offset":5000}}
```

```json executor-bad-call
{"tool":"control","arguments":{"forward":1,"ticks":8}}
```

```json executor-bad-call
{"tool":"cancelAction","arguments":{"actionId":"native:agent-a:3:7"}}
```

```json executor-bad-call
{"tool":"exploreFrontier","arguments":{"radius":"far"}}
```

```json executor-bad-call
{"tool":"notebook","arguments":{"key":"route","text":""}}
```

```json executor-bad-call
{"tool":"act","arguments":{"actionType":"menu_click","arguments":{"menuId":"minecraft:generic_9x3","containerId":2,"stateId":7,"slot":-1,"button":0,"clickType":"PICKUP","expectedItemId":"minecraft:iron_ingot","expectedCount":1}}}
```

```json executor-bad-call
{"tool":"act","arguments":{"actionType":"control_sequence","arguments":{"frames":[{"forward":0,"strafe":0,"jump":false,"sneak":false,"sprint":false,"attack":false,"use":false,"yaw":90,"pitch":0,"selectedSlot":0,"hand":"main","ticks":1}],"maxTicks":0}}}
```

```json executor-bad-call
{"tool":"say","arguments":{"message":"Hello","audience":"direct"}}
```

```json executor-bad-call
{"tool":"queueProgram","arguments":{"afterProgramId":"native-program-session-1","goalRevision":3,"programVersion":1,"source":"program.onUnhandledAttention(\"pause_and_notify\"); await player.wait(50);"}}
```

```json executor-bad-call
{"tool":"cancelQueuedProgram","arguments":{"afterProgramId":"native-program-session-1","goalRevision":3}}
```

```json executor-bad-call
{"tool":"runProgram","arguments":{"noteKey":"bounded-wait","parameters":[],"timeoutMs":5000}}
```
