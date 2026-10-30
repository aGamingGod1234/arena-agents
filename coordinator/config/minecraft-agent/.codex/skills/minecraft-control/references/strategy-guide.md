# Minecraft strategy guide

Optional mechanics and options for Java 26.1, pinned to this project's 26.1.2 game data. Vanilla defaults unless stated; difficulty, gamerules and datapacks can change them. Nothing here reveals current world locations. Each heading is a separate on-demand topic.

## Getting ores and resources

Exposed ore in caves, ravines and mountains costs fewer excavated blocks than buried ore. Structure loot can contain processed resources (structures). Comparing ways to get a resource: topic sourcing. Flooded caves expose ore but require air (water). Branch or strip mining reveals only the blocks beside each tunnel: predictable, but many blocks broken per vein found; it suits a small remaining amount, or when no exposed source is known nearby. Some diamond features discard ore exposed to air, so buried diamonds outnumber exposed ones. Whole veins: visible connected ore does not show the full cluster. Large iron veins occur with tuff at Y -60 to -8, copper with granite at Y 0 to 50.

Heights describe distributions, not guaranteed deposits. Y -59 is a practical deep mining height above most bedrock; Overworld lava aquifers occur below about Y -54.

| Overworld ore | Generation heights | Distribution |
|---|---|---|
| Coal | Y 0 to world top | Lower batch peaks at 96; upper starts at 136 |
| Copper | -16 to 112 | Peak 48; larger veins in dripstone caves |
| Iron | -64 to 72, 80 to world top | Common around 16 underground and 232 in mountains; caves and ravines expose veins |
| Gold | -64 to 32 | Peak -16; extra badlands batch 32 to 256 |
| Lapis | -64 to 64 | Exposed batch peaks at 0; buried batch uniform |
| Redstone | -64 to 15 | Extra deep batch increases toward bottom |
| Diamond | -64 to 16 | Several batches; generally more toward bottom |
| Emerald | -16 to world top, mountain biomes | Distribution peaks at 232 |

| Nether ore | Heights | Notes |
|---|---|---|
| Quartz, Nether gold | 10 to 117 | Gold drops nuggets without Silk Touch |
| Ancient debris | 8 to 119 | Concentrated batch 8 to 24, peak 16; not naturally exposed to air |

The End has no natural ore features; city loot can supply gear/diamonds. Deepslate ores need the same tier (tools). Ancient debris smelts to scrap; 4 scrap + 4 gold make 1 netherite ingot. Smithing upgrades also require a netherite template; duplication costs 7 diamonds and matching base block.

Furnace smelting takes 10 s/item, smoker food and blast-furnace supported ores/metals 5 s. Coal/charcoal fuels 8 items, log/plank 1.5. Cooking needs fuel, not an underground location; cooked food needs no recooking. Tables drop with any tool; a furnace needs a pickaxe. usesLeft reports wear; consuming a most worn tool before a fresh one avoids leaving unusable partial tools. sighted.caves, sighted.structures and sighted.veins are visible facts, not unseen deposits. leftBehind lists previously placed workstations; remembered entries do not certify current access.

## Choosing how to get a resource

Players treat a needed resource as a choice between ways, not one method. The question is which known way gives the needed amount soonest at a risk current gear and health can take; a death or lost inventory usually costs more time than a detour.

- **Ways known.** Remembered sightings and places, survey, lookAround and exploreFrontier results, and the taskPlan options line name what is already known; unvisited headings may add more.
- **Time.** Travel there and onward (sprinting about 5.6 blocks/s, walking 4.3) plus extraction: a visible vein takes seconds, strip mining usually many blocks broken per vein found.
- **Yield.** Typical amounts below; loot and drops are random.
- **Risk against gear.** With no armour and stone tools, surface sources, villages, daylight and cave stretches that are observed lit, clear of mobs and close to an exit keep exposure low; dark caves at any depth and night travel can bring several hostile mobs at once. With iron armour, a sword and a shield, caves and ravines with exposed ore are often the fast way to iron, coal, gold, redstone and diamonds.
- **New facts.** A new structure, cave, lava or exposed ore, nightfall, damage, a gear upgrade, or a way that stops yielding (taskPlan unchanged Nm, N blocks broken) change the comparison.

A village and a cave both near, holding a stone sword and no armour: village chests or a golem can supply iron armour that makes the cave cheaper, and lava seen in the cave is portal material.

| Need | Ways (typical yield) | Time and risk |
|---|---|---|
| Iron | Exposed ore in caves, ravines, mountain faces (4-10 per vein); iron golem (3-5 ingots, no smelting); weaponsmith, toolsmith, armorer, shipwreck treasure, mineshaft minecart and buried treasure chests (a few ingots, sometimes gear); ruined portal chests (nuggets); staircase down to Y 16-0, taking ore exposed | Exposed ore takes few blocks; a golem has 100 HP and hits hard; caves add mobs and falls; strip mining is steady but costs many blocks per vein |
| Diamonds | Exposed in deep caves near Y -59; buried treasure (often 1-2); shipwreck, village, temple and mineshaft chests (rare); strip mining at Y -59 | Iron pickaxe or better; deep caves are dark, lava below about Y -54; mining is steady, many blocks per vein |
| Obsidian, portal | Ruined portal (partial frame; chest may hold obsidian, flint and steel); water bucket onto lava sources (bucket is 3 iron): lava lies in caves (cave air below y-54 is lava; pools sit in caves higher up), shown by open caves and ravines (its light; pops within ~16 blocks through rock); recorded games saw 1 usable pool in 1767 min above y-20 and 2 in 37 min at y-45 and below, where pools sit behind rock until a cave opening or heard lava shows their side; rarely on the surface (surface lava lakes ~1 per 200 chunks, underground ones ~1 per 9); weaponsmith chests; a frame needs 10 | Mining obsidian needs a diamond pickaxe, casting does not; lava burns |
| Blaze rods | Blazes at Nether fortresses (0-1 rod per player or tamed-wolf kill without Looting) | Fireballs and fire; fire resistance, shields and cover help |
| Ender pearls | Endermen (0-1 per kill without Looting; Overworld nights, common in warped forests, occasional in soul sand valleys); piglin bartering (2-4 per pearl barter, about 2% of ingots); expert cleric trades | Endermen hit hard and turn hostile when looked at; gold armour keeps ordinary piglins neutral; bartering costs many gold ingots |
| Food | Animals (1-3 meat each); village crops and hay bales (a bale is 3 bread); fishing; apples from oak leaves | Fishing is slow but safe; cooked meat restores far more than raw |

## Structures and loot

| Structure | Where | Useful for |
|---|---|---|
| Village | Plains, desert, savanna, taiga, snowy plains | Blacksmith, armorer, weaponsmith and toolsmith chests (iron, tools, armor, sometimes diamonds and obsidian); hay bales for bread; beds; iron golems drop iron; trades |
| Shipwreck | Oceans and beaches | Treasure chest (iron, gold, emeralds, sometimes diamonds); supply chest (food); map chest with buried treasure maps |
| Buried treasure | Beaches, via a treasure map | Iron, gold, often diamonds, TNT, heart of the sea |
| Ruined portal | Overworld and Nether only | Obsidian toward a nether portal, flint and steel or fire charge, gold gear, sometimes golden apples; often next to lava |
| Mineshaft | Underground, often joined to caves; badlands near the surface | Chest minecarts (iron, gold, bread, sometimes diamonds), rails, ore exposed along tunnels; cobwebs and cave spider spawners |
| Desert temple | Desert | Four chests under the floor (gold, iron, emeralds, sometimes diamonds); a pressure plate on TNT in the center |
| Trial chamber | Underground, copper and tuff rooms | Vault loot with trial keys; many mob spawners |
| Ancient city | Deep dark, around Y -51 | Loot; sensors relay vibrations, natural shriekers can summon wardens; sneaking reduces vibrations, not sniffing |
| Dungeon | Underground | Monster spawner; iron, bread, seeds, buckets and rare enchanted golden apples |
| Jungle temple | Jungle | Iron/gold/diamonds; tripwire arrow traps and lever puzzle |
| Igloo | Snowy terrain | Some have a basement with villager/zombie villager, Weakness potion and golden apple |
| Ocean monument | Deep oceans | Guardians/elders, gold blocks, sponges; no ordinary treasure chests |
| Woodland mansion | Dark forest | Illagers, sometimes caged allays; chests may hold gear and rare enchanted golden apples; evokers drop totems |
| Pillager outpost | Several Overworld biomes | Pillagers, tower chest with possible crossbow/iron/crops; some cages hold allays/golem |
| Trail ruins | Partly buried in several wooded/cold biomes | Brushable suspicious gravel with pottery sherds, trims and other loot; breaking loses archaeology loot |

Loot is probabilistic, not guaranteed. Vaults reward each player once; trial spawners have cooldowns and distinct ominous variants. Ordinary spawners differ. Visible structure loot can substitute for mining.

## Water and swimming

Water is not a hazard like lava. Swimming costs air, not health; drowning damage starts only when air reaches zero.

- Air is 300 ticks, 15 seconds under water. Observe reports underWater and airSecondsLeft, and an air warning reaches you at half air. Air refills to full in about 4 seconds with your eyes above water.
- navigateTo swims at the surface and through flooded tunnels, shafts and caves while one breath covers the underwater stretch, roughly 24 blocks with a 3 second reserve. It waits at the surface to catch breath before a long dive, rises for air when breath runs short, and can end standing on the floor of flooded space. Air pockets split a longer flooded passage into legs.
- Control input in water: jump held rises or stays afloat; releasing it sinks; sprint while underWater swims along the view pitch.
- Eyes above water with onGround:false is floating, not a dry work site. Keep jump held while refilling air, then choose reachable shore or an air pocket. Cancelling a guard also releases its swim/float input; supply the next water action before stationary crafting, building or reads.
- Mining with your head under water is about 5 times slower, and again about 5 times slower while floating instead of standing. A helmet with Aqua Affinity removes the water penalty; Respiration extends breath.
- Breaking into water while tunnelling: flowing water pushes you but does no damage. Swimming through, blocking the flow, or bucketing the source are options. A flooded cave is often an unlooted ore wall.
- Placing a door under water clears an air pocket you can breathe in. Soul sand columns push up, magma columns pull down; both replenish air and need source water.
- Where water can be placed, it turns lava sources to obsidian and flowing lava to cobblestone; pouring it over lava makes a crossing. A bucket placed just before landing cancels fall damage. Water cannot be placed in the Nether.
- Boats cross open water fast with no air use. Drowned (sometimes with tridents) and guardians are the main water threats.

## Survival basics

- Health normally 20 HP (10 hearts), food 0-20; saturation is a reserve capped by food. Each 4 exhaustion spent consumes 1 saturation first, then 1 food. Sprint/swim/jump/mine/attack/healing spend exhaustion, ordinary walking does not. Sprint requires food above 6.
- With natural regeneration, food 18+ heals 1 HP per 80 ticks (4 s). At 20 with saturation, every 10 ticks heals min(saturation,6)/6 HP, up to 2 HP/s. Both spend exhaustion. Ordinary eating restores food/saturation, not instant health. Zero-food starvation deals 1 HP per 4 s down to 10 HP on Easy, 1 on Normal, death on Hard. Peaceful restores health/food separately.
- Food/saturation: cooked beef/pork 8/12.8, chicken 6/7.2, bread/baked potato 5/6, golden carrot 6/14.4. Bread costs 3 wheat; hay gives 9 wheat. Raw chicken/rotten flesh can cause Hunger; pufferfish harms. Most foods take 1.6 s and cannot be eaten at full food. Golden apples grant regeneration/absorption and allow full-food eating.
- Cooking takes time/fuel anywhere; a furnace does not require underground shelter. Hunting/fishing/farms/loot/trades/stew are options. Nether hoglins drop pork, stems make planks but not charcoal. Existing cooked food/gear retain value across dimensions.
- Blocks provide footing/cover. Visible mobs can be outside melee reach (combat). Armour is not Fire Resistance. Beds set Overworld respawn but explode in Nether/End; anchors work in Nether (navigation). Lighting has mob-specific rules (spawning).
- Falls beyond 3 blocks hurt; water can cancel landings where present. Sand/gravel fall without support. Leather boots prevent sinking into powder snow, leather gear protects from freezing. Lava/fire differs (hazards).

## Sizing up a situation

Questions players use after arrival, respawn, failure or change. The order and the conclusions are yours. Observations, player facts and inventory carry the evidence.

What can kill me before this finishes? What already satisfies the goal? What does each possible prerequisite cost and risk? After a failure, which assumption failed?

What players check:

- **Health and armour.** How many more hits or falls can I take? Armour reduces many attacks; shields, enchantments and effects offer other protection.
- **Hunger and food.** Is the bar high enough to heal (18+) and to sprint (above 6)? How many meals do I carry, and how far is the next source?
- **Light and time.** Overworld darkness and night spawn hostile mobs on open ground; how long until dark or dawn? Is this spot lit, roofed or open? The Nether and End have no normal day/night cycle; light requirements vary by mob (topic spawning).
- **Threats.** What can see, hear or reach me: how far, above or below, ranged or melee, one or several? What hurt me last, and is it still there?
- **Weather.** Rain puts out burning; sunlight-burning mobs do not burn in rain; a thunderstorm darkens the day enough for hostile spawns.
- **Shelter.** Where could I wait out a night or heal: a roof and walls, a hole sealed behind me, a lit room, a bed?
- **Gear.** Which tools, weapons, armour and blocks do I have, and how worn (usesLeft)? What can they mine or fight; what would a lost or broken one stop?
- **Place.** Dimension, biome, depth (Y), open sky or underground, water, lava or a drop nearby. What resources and hazards does this place hold? The Nether lacks iron, coal and diamond ore; it has Nether gold, quartz and ancient debris. Water placement is unavailable there; crimson/warped stems provide planks.
- **Way home.** Where are my spawn or bed, base, portal, chests and dropped items, and do I know the way? Where would I respawn if I died now?

Trade-offs players weigh:

- **Progress against safety.** Continuing can save time but risks carried items if you die. Death normally drops them; surviving drops can be recovered before 6,000 ticking entity ticks (5 min at 20 TPS). keepInventory changes this.
- **Fight or avoid.** A fight costs health, durability and time and may give drops; avoiding costs a detour or a wait.
- **Prepare or go.** Food, healing, armour and torches cost time; missing protection raises the cost of danger.
- **Carry or return.** Food, blocks, a table and spare tools carried save trips; slots are limited and everything carried is at risk.
- **Known or new.** Explored routes reduce uncertainty; mobs and terrain can change. New ground may hold resources, structures or falls.
- **Speed or care.** Sprinting and jumping drain hunger; walking blind into darkness, water or lava trades caution for speed.

Questions for a start with little or nothing; each applies only where the answer is no:

- **Any tools at all?** Logs provide planks, sticks and a crafting table. Wooden pickaxes yield cobblestone; stone tools are faster and more durable.
- **Food for the next while?** Animals, crops, apples and village bread are early sources; cooked meat restores much more than raw.
- **Anything for the first night?** A dug-in room, a quick hut, torches from coal and sticks, or a bed (3 wool, 3 planks), which can skip Overworld night and set spawn; Nether/End beds explode.
- **Iron yet?** Iron provides tools, armour, buckets and shields (topic resources).
- **Places remembered?** Spawn, bed, base, caves and structures found make a death or a long trip cheaper.

Gear already held may satisfy prerequisites, but only the ones it covers: diamond armour covers armour, not an iron bucket or shield. What could end this step before it finishes, and what would continuing cost then?

## Lava and fire

- Leaving lava you keep burning about 15 s: about 1 HP per second that armour does not reduce, on top of the lava's own damage. Fire blocks burn shorter.
- Water or rain ends burning at once. Placed water evaporates in the Nether, but a water cauldron can extinguish. Fire resistance prevents fire and lava damage while the effect lasts; player.effects.duration is in ticks (20 per second, -1 infinite).
- At 20 food with saturation, natural regeneration can outpace ordinary burning. Lava's raw damage is much faster; actual damage depends on gear and effects. healing.burn.rawDamage estimates remaining unmitigated burn damage after fire resistance expires.
- In lava, held jump applies upward input every tick; releasing it sinks. Looking up and sprinting do not give water's sprint-swim speed in lava. player.exits lists known landings within 3 horizontal blocks, up to 3 above: direction, horizontal distance, upN/downN, Nlava, Ngap, unseen, coordinates. up1 is a jump; higher landings require rising first and do not certify a route. If none is nearby, it recalls one nearest remembered landing, including the way you walked (30 s memory); other seen terrain lasts 10 s. remembered Ns is its age, not a current guarantee. Empty exits means none known, not no possible shore. Lava hides what is behind it.
- An action that walks into lava or catches fire stops with IN_LAVA or ON_FIRE and the same exits. hurtBy names what last hurt you; lavaSeen lists lava you saw within 4 blocks in the last 30 s that is out of view. lavaFlow {from, at, inS} is seen lava flowing toward you: the lava it spreads from, the cell of yours it reaches and in about how many seconds.
- mine refuses a block with lava heard or seen beside it (LAVA_BEHIND) unless acceptLavaRisk:true. A block placed in the gap stops a flow.
- Magma blocks hurt while you stand on them unless you sneak.

## Beating the game

Dragon defeat opens exit/credits. These are dependencies, not a fresh-start route: current dimension/gear/access determine what remains. Wood or iron equipment is not required when better gear is already carried. Ways to get each resource and their risks: topic sourcing.

- Each eye needs 1 pearl + 1 blaze powder; 1 rod makes 2 powder. Player-killed blazes (including tamed-wolf credit) drop rods. Pearls come from endermen, adult piglin barter or expert cleric trades.
- Strongholds/end portals generate only in Overworld. Thrown eyes indicate a stronghold, not necessarily its portal room; about 1 in 5 throws breaks. Inside a stronghold, find the portal room by exploring (silverfish spawner, lava, stairs), not by throwing. Keep 12 eyes minus pre-filled frames for the portal. Portal has 12 frames, each 10% chance of an existing eye; empty frames determine activation needs. Search losses vary, so fixed rod/pearl totals are not mandatory.
- Nether portals connect Overworld/Nether (portals). Water/lava casting substitutes for mining obsidian where water works. Being in Nether establishes current access; ruined portals also generate there.
- Crystals heal the dragon, flight/perch and reachable hitboxes determine damage options (bosses/end/combat). Bows reach crystals/flying dragon. Blocks/water/food/armour have independent uses. Bed explosions are risky options, not required progression.
- Dragon death opens central exit and outer gateway. Exit returns to respawn destination. Elytra/netherite/wither kills/full iron armour are optional, not victory requirements.

## The Nether

- **Portal frame:** obsidian 4 wide and 5 tall; the corners are optional, so 10 obsidian is enough. Flint and steel or a fire charge lights it. In the Overworld, water can cast obsidian over lava sources; water cannot be placed in the Nether. Buckets fill at a source and empty against a face through interact_block or use_item; water beside or above a lava source turns that source to obsidian in place. Obsidian broken without a diamond pickaxe drops nothing, so without one a frame is cast where it stands: a lava source emptied into each frame cell turns to obsidian when water reaches it.
- **Respawn before entering:** a bed (3 wool + 3 planks) placed beside the Overworld portal, or by the staircase top before a trip to the lava floors, and used, by day too, sets your respawn there; a Nether death then costs a walk back through the portal instead of a trip from the world spawn, and the dropped items lie about 5 minutes where you died (lava and fire destroy them). Beds explode in the Nether.
- **Travel:** 1 block in the Nether is 8 blocks in the overworld. X/Z are scaled, Y is not; nearby-portal search and safe placement can change the exit (portals).
- **Getting there:** once a fortress or bastion is seen, or its direction is known, one travelTo (x,z or yaw+distance, stopWhenSeen minecraft:nether_bricks or minecraft:polished_blackstone_bricks) covers the whole way at body speed; it bridges gaps and lava, pillars and tunnels with plain blocks and the best tool from your whole inventory (carry 32+ blocks) and stops for threats, damage and missing blocks. moveTo legs cost a decision every few blocks.
- **Fortress and bastion search:** fortress bridges run in long north-south or east-west lines and show at range over lava seas. Bastions do not generate in basalt deltas. Fortresses have dark nether brick bridges and corridors; bastions are blackstone ruins with gold and piglins.
- **Fortress loot:** blazes drop rods; wither skeletons and nether wart also appear; chests may hold diamonds, iron, gold and obsidian.
- **Bastion remnant:** blackstone ruins full of piglins and gold blocks; chests with gold, obsidian, crying obsidian and gear. Piglin brutes always attack.
- **Piglins:** regular piglins attack on sight unless you wear gold armour; gold prevents ordinary on-sight aggression while you wear a golden helmet, chestplate, leggings or boots (holding gold does not count), unless you attack one, or open or break a chest, barrel, ender chest or shulker box, or mine gold blocks (raw too), gold ore or gilded blackstone near them. Piglin brutes always attack. A calm adult piglin barters gold ingots; babies take them without bartering. Hand one over with interact_entity while holding the ingot, or drop it near; the piglin examines it for about 6 s, then throws its return toward you, which you then collect. Adult barter returns 2 to 4 ender pearls; returns are random and pearl trades can consume many ingots; other returns include obsidian, fire resistance potions, string and more.
  <!-- registry-barter-odds -->
  Pearl barter weight 10 of 469 (about 2.13%).
  <!-- /registry-barter-odds -->
- **Dangers:** lava seas and hidden lava pockets, ghast fireballs (can be hit back or blocked by cover), and falls. Soul sand slows movement; magma blocks damage you unless you sneak. Fire resistance protects against fire and lava. Water cannot be placed here; beds explode when used here.
- **Structure distribution:** Nether complex spacing is 27 chunks (432 blocks), fortress:bastion weights 2:3. Biome rejection can leave candidates empty; a region is not guaranteed a structure. Sight and traversable terrain determine exploration options; depth alone finds neither. High open ground extends views, but blocked/unseen terrain remains unknown. Bastions provide gold/obsidian/templates and bartering access.
- **Other mechanics:** blackstone substitutes for cobblestone in stone tools/furnaces. Ordinary compasses/clocks spin; same-dimension lodestone compasses work. Charged anchors set Nether respawn. Light rules vary by mob (spawning).

## The End

- **Finding the stronghold:** a thrown eye of ender (one use while not aiming at an end portal frame) flies about 12 blocks toward the stronghold for 4 seconds, then drops as an item you can pick up or breaks (about 1 in 5). It rises while the stronghold is far and sinks toward it when you are within about 12 blocks horizontally; a sinking eye indicates the stronghold is nearby horizontally and usually underground. Each watched flight stays 30 seconds as eye<id>: throw-point x,y,z; yaw/distance (Minecraft degrees/horizontal blocks flown); up/down/level@Y (last seen absolute height; y74 when the direction is unknown); ending: drop@x,y,z, drop+dx,dy,dz (offset from the throw point), broke, or unseen (ending not seen). ? is unknown; /? means the eye left your view mid-flight, so how far it flew is unknown. Only what your view saw appears. Inspect events add from, to, heading, flewBlocks and lostFromView. The eye heads straight for the stronghold start, so yaw is exact even from a short sighting; face that yaw when throwing to watch the whole flight. A throw 50+ blocks to the side of an earlier eye's line adds cross@x,z N from throw: where the two lines meet, above the stronghold's start stairs. Following eyes also works. The nearest strongholds are 1,280 to 2,816 blocks from the world origin.
- **Portal room:** 12 frame blocks; some may already hold eyes. Silverfish spawner on the stairs. The empty frame count is the number of eyes still needed. Lava: 1x3 by each entrance side wall, 3x3 under the portal.
- **Dragon fight options:**
  - End crystals on top of the obsidian pillars heal the dragon while they stand; arrows reach the open ones from the ground. Two of the three thinnest pillars (crystals at y=80 and y=83) cage theirs in iron bars whose side walls stop every arrow: pillar up beside the cage to the crystal's height, break the wall bars there with a pickaxe, then shoot through that gap from the ground (the barred top lets arrows through from above). A crystal's blast deals about 56 at 3 blocks and breaks the blocks round it.
  - The dragon is in melee reach when perched on the central fountain; bows reach it in flight, but it is immune to arrows while perched.
  - Beds explode when used in the End. A bed set off next to the perched dragon does heavy damage, and heavy damage to you if you stand close; this is a fast but risky option.
- **Before entering:** a bed used by the portal room sets respawn there, a short walk back after an End death. Drops lie ~5 min; the void destroys them.
- **Reaching the main island:** you arrive on a 5x5 obsidian platform about 100 blocks from the centre, usually 20-30 blocks off the island's edge and below its top. A pearl on a previewed arc to seen island ground crosses in one throw; a bridge keeps you minutes in the open over the void.
- **Dragon attacks:** it circles the pillars and swoops at you. Its body hurls you several blocks (fatal on a 1-wide bridge or at the platform edge). Its purple fireballs burst into breath clouds (radius 3 growing to about 7 for 30 s) that hurt each second and push you. A model turn is too slow for either: before exposure, arm reflexes on `fireball_incoming` and `cloud_near` that move you along safe footing; walls or a 2-deep hole stop the shove.
- **End safety:** the void is fatal. Dragon breath and knockback can push you over an edge. Endermen become hostile when you look at their eyes (a carved pumpkin prevents this but limits vision). Blocks and a water bucket manage falls.

Water works here. Charged respawn anchors explode and do not set spawn. Outer islands contain chorus plants and End cities/ships; ships hold elytra, shulkers cause Levitation. Gateways permit pearl/crawling access; bridging risks void falls. Four crystals around the fountain respawn the dragon; the egg is not repeatedly awarded.

## Tools and drops

Breaking a block and receiving drops differ. Bare hands break stone slowly but give no cobblestone; a weak pickaxe can destroy ore without resources. Gold is fast but cannot harvest iron/diamond ore. Copper has stone-tier eligibility and more durability. This table derives from pinned game tags/loot item entries; items include Silk Touch alternatives, not guaranteed counts.

<!-- registry-pickaxe-table -->
| Block | Pickaxe materials that yield drops | Loot items (conditional) |
|---|---|---|
| ancient_debris | diamond,netherite | ancient_debris |
| coal_ore | wooden,gold,stone,copper,iron,diamond,netherite | coal,coal_ore |
| copper_ore | stone,copper,iron,diamond,netherite | copper_ore,raw_copper |
| crying_obsidian | diamond,netherite | crying_obsidian |
| deepslate | wooden,gold,stone,copper,iron,diamond,netherite | cobbled_deepslate,deepslate |
| diamond_ore | iron,diamond,netherite | diamond,diamond_ore |
| emerald_ore | iron,diamond,netherite | emerald,emerald_ore |
| furnace | wooden,gold,stone,copper,iron,diamond,netherite | furnace |
| gold_ore | iron,diamond,netherite | gold_ore,raw_gold |
| iron_ore | stone,copper,iron,diamond,netherite | iron_ore,raw_iron |
| lapis_ore | stone,copper,iron,diamond,netherite | lapis_lazuli,lapis_ore |
| nether_gold_ore | wooden,gold,stone,copper,iron,diamond,netherite | gold_nugget,nether_gold_ore |
| nether_quartz_ore | wooden,gold,stone,copper,iron,diamond,netherite | nether_quartz_ore,quartz |
| obsidian | diamond,netherite | obsidian |
| redstone_ore | iron,diamond,netherite | redstone,redstone_ore |
| stone | wooden,gold,stone,copper,iron,diamond,netherite | cobblestone,stone |
<!-- /registry-pickaxe-table -->

Listed blocks need a suitable pickaxe for survival drops; deepslate ores have the same eligibility. Silk Touch usually yields the block; Fortune increases eligible resource drops, not smelting output. They conflict and neither overrides tier. Crying obsidian cannot form portals.

Axes speed wood, shovels dirt/sand/gravel, hoes leaves/many plants. Logs/dirt/tables drop without matching tools. Shears preserve leaves/cobwebs; swords yield cobweb string. Glass needs Silk Touch. Bedrock/end portal frames cannot be harvested in survival. Airborne mining is 5 times slower; underwater head immersion adds 5 times without Aqua Affinity. Correct tier still spends durability.

## Combat and equipment

- Normal survival reach is 3 blocks from eyes to target hitbox, not feet-to-feet. Height/gaps/walls can make visible mobs unreachable; ordinary melee needs sight. Spears have a minimum and extended maximum reach from their attack-range component.
- Ordinary cooldown depends on weapon speed; rapid repeated swings reduce damage. Charged falling hits crit for 1.5 times base damage if not sprinting/climbing/in water/blinded/riding. Swords sweep while grounded/moving slowly; axes hit harder/slower and can disable shields. Mace smash gains fall damage, but misses leave fall risk.
- Spears jab/charge; charge damage depends on movement/aim/stage, too-close targets take none. Bows draw/consume arrows and arc; crossbows stay loaded. Trident Loyalty returns throws; Riptide works wet and conflicts with Loyalty/Channeling. Infinity needs a normal arrow and conflicts with Mending.
- Raised shield blocks many frontal melee/arrows/explosions after 5 ticks (0.25 s). Rear attacks, piercing arrows, disabling axes and warden sonic bypass normal blocking. Durability matters; eating/attacking share active-item constraints.
- Armour reduces many physical attacks; toughness helps big hits. Ordinary armour does not cover drowning/starvation/void. Enchantments add mitigation; Feather Falling reduces falls. Copper armour is between leather/iron; gold placates regular piglins. Totem works only held in either hand.

## Hostile mobs

- Zombie/zombie villager: melee, sunburn unless protected; babies fast. Husk: sunproof, Hunger; drowned swims, some throw tridents, night extends land pursuit. Zombie horses can carry hostile riders.
- Skeleton bow/sunburn; stray arrows slow, bogged poison, parched weaken/survive desert sun. Camel husk/zombie nautilus riders add mobility; unridden mounts differ.
- Creeper swelling fuse/explosion; distance can interrupt fuse, cats repel, charged blasts stronger. Spider climbs/daylight neutrality unless provoked; cave spider poisons/fits gaps. Silverfish wakes infested blocks; endermite attacks nearby players.
- Slime splits, smallest harmless; magma cube splits, smallest harms, fire immune. Phantom flies after prolonged lack of rest, cats deter. Witch potions/healing/Fire Resistance.
- Pillager crossbow; vindicator axe; evoker fangs/vex/totem; vex passes blocks; ravager heavy knockback/plant destruction. Illusioner is not natural survival spawn.
- Guardian beam interrupted by cover, spikes hurt melee; elder Mining Fatigue. Breeze wind-charge knockback, deflects most projectiles; charges activate controls. Shulker homing shots levitate, closed shell protects, teleports.
- Blaze fireballs/melee/player-credit rods, water hurts. Ghast explosive fireballs reflectable by hits. Wither skeleton tall melee/Wither. Hoglin melee/knockback, warped fungus repels, converts outside Nether. Zoglin attacks nearly all mobs. Piglin brute ignores gold/no barter.
- Warden blind/vibrations/sniffing, huge melee/sonic through cover/shields; wool dampens vibration, sneaking not invisibility. Creaking night puppet tied to heart, stops when watched; puppet damage does not kill, heart destruction does.

## Neutral mobs

Neutral refers to conditions, not guaranteed safety; provocation can anger groups.

- Enderman eye contact/damage provokes, pumpkin prevents stare provocation. Water/rain hurts, teleports/evades most projectiles; tall body excludes 2-high openings.
- Adult piglin: worn gold placates, held gold does not. Attacks, guarded container opening/breaking, gold/gilded blackstone mining can anger anyway. Soul fire/zombified piglins/zoglins repel. Brutes ignore gold. Piglins zombify outside Nether; calm adults barter ingots.
- Zombified piglin damage alerts nearby ones; gold does not clear anger. Wild wolves retaliate together, bones tame, sitting controls following. Bees hive disturbance/damage angers; smoke below hive permits honey harvest, flowers breed, sting poisons/kills bee later.
- Iron golem protects village, attacks/reputation provoke; player-built does not attack creator. Snow golem throws snowballs, water/hot biomes hurt. Polar bears protect cubs, pandas vary by personality, hurt llamas spit.
- Goats ram unprovoked. Dolphins retaliate together/need water and air, fed fish can lead toward ocean loot. Nautilus provoked dash, tame/breed pufferfish, natural despawn unless made persistent.
- Spider often calm in light/hostile in dark; old aggression need not instantly end. Pufferfish poisons by inflation without pursuit. Armadillo curls near threats, brushing yields scutes. Farm animals usually flee.

## Passive mobs

- Cow/mooshroom beef/leather/milk; bowl milks mooshroom stew. Sheep sheared wool/mutton, grass regrows wool. Pig pork, chicken meat/feathers/eggs, rabbit meat/hide/rare foot. Fish food, squid/glow squid ink; babies/kill conditions alter drops.
- Cat/ocelot cod/salmon tames cats or builds ocelot trust; cats repel creepers/phantoms. Fox berries breed trusting babies. Parrot seeds tame, cookies poison, imitates mob sounds. Allay collects matching dropped items; note blocks affect delivery, not resource creation.
- Axolotl aquatic fights/bucket capture/tropical-fish buckets breed. Frog eats small slimes/magma cubes for slime/froglights, slimeballs breed. Turtle seagrass breeds/home-beach eggs/baby growth scutes. Sniffer digs seeds/torchflower seeds breed. Bat no useful normal drops.
- Horse/donkey/mule mounting tames/saddle steers; horse armour, donkey/mule chests. Camel two seats/dash/cactus breeds. Llama chests/caravans, not horse steering. Strider walks lava/warped fungus breeds/fungus-on-stick steers.
- Happy ghast grows from hydrated dried ghast/ghastling, snowballs speed growth, harness carries riders. Copper golem moves items from copper to normal chests, oxidation can stop it; carved pumpkin/jack o'lantern placed on copper block creates one. Villagers trade; nautilus aquatic mount (transport).
- Feeding/attraction/breeding/taming differ (farming). Many land animals persist, fish/squid and others despawn (death). 26.1 name tags craft from paper + metal nugget; anvil naming gives many mobs persistence.

## Bosses

- Dragon crystals heal/explode; perched immune to arrows, head takes full damage/other parts less. Destroys many blocks, knockback/breath clouds harm. End beds harm player/dragon. Death opens exit/gateway/XP; four fountain crystals respawn. Egg not progression material.
- Wither: 4 soul sand/soul soil in T + 3 wither skeleton skulls and space summons. Initial charge explodes; skulls destroy terrain/inflict Wither, boss heals. Half health gains projectile protection/becomes more reachable. Nether star makes beacon, optional for dragon. Java differs from Bedrock.
- Elder guardian monument mini-boss: beam/spikes/periodic Mining Fatigue through walls. Milk clears all effects, another elder can reapply; sponge drop.
- Warden sculk warning hazard, not required boss. Natural shriekers summon after warnings, player-placed cannot. Wool/sneaking/range affect vibrations, not all sniffing/sonic detection. Burrows after losing interest; negligible progression loot.
- Raids/ominous trials have distinct enemies/waves. Evokers drop totems, not all illagers; vault/dragon/wither rewards differ.

## Farming and breeding

- Wheat/carrot/potato/beetroot need farmland/light 9+/random ticks. Water hydrates within 4 blocks horizontally, same level/one above (9x9 plot). Falls/jumps trample. Bone meal speeds many crops, mature crops yield more; poisonous potatoes are not planting stock.
- Cane needs water/suitable soil, cactus clear sides/substrate, melon/pumpkin stems fruit beside them. Wart grows on soul sand in any dimension without light/water, bone meal does not speed it. Mushrooms favour dim light except special substrate; trees need light/space/substrate.
- Two compatible adults in love mode breed; most parents cooldown 5 min/babies grow in 20 min, feeding speeds growth. Golden dandelion pauses/resumes eligible babies, excluding undead/villagers. Fences/leads/boats contain/transport animals.
- Breeding: cows/sheep/goats wheat; pigs carrot/potato/beetroot; chickens seeds; rabbits carrot/dandelion/golden carrot; tamed horses/donkeys golden carrot/apple; camel cactus; strider warped fungus; hoglin crimson fungus. Tamed wolves accept wolf_food including meat/fish; cats raw cod/salmon; bees flowers; fox berries; turtles seagrass; frogs slimeballs; axolotls tropical-fish buckets; sniffer torchflower seeds; nautilus pufferfish. Llamas breed with hay bales; pandas use bamboo and also need nearby bamboo plants. Feeding does not make polar bears or dolphins breed.
- Shears avoid killing sheep; eggs can spawn chicks. Milk removes effects, not nutrition. Fishing food/treasure, treasure needs open water. Most babies lack adult loot; villagers use food/spare beds (villages).

## Villages and trading

- Adult unemployed villagers claim sites; nitwits/babies cannot trade. Lectern librarian, brewing stand cleric, composter farmer, blast furnace armorer, smithing table toolsmith, grindstone weaponsmith. First trade locks profession/offers; before it accessible site changes can reroll. 26.1 uses deterministic random sequences; visible offers are current facts.
- Trades unlock novice through master with trade XP/limited stock. Access to workstation in work hours enables restock, up to twice/day. Demand/reputation/discounts change prices. Experiments/datapacks change pools, biome rebalance is not universal default.
- Farmers crops/food, librarians books, smiths tools/armour, expert clerics pearls. Master librarians no longer sell name tags in 26.1; traders do/tags craftable. Traders need no site/eventually despawn.
- Breeding needs food/willingness/spare valid bed. Zombie conversion: Hard 100%, Normal 50%, Easy 0. Weakness + golden apple cures over time/discounts; repeated cures do not endlessly stack.
- Golems defend village; aggression/reputation matters. Ominous bottle Bad Omen becomes delayed Raid Omen on entry; waves threaten villagers. Milk clears omen before activation. Defeated raid grants Hero of the Village.

## Enchanting and repairs

- Table needs diamonds/obsidian/book, randomized compatible offers for lapis/XP. 15 properly spaced bookshelves with air gap enable level-30 option; requires 30 levels but spends 3 levels/3 lapis. Item/seed affect offers, enchanting changes seed.
- Anvil books/compatible gear combinations/material repairs/renaming. Prior work raises cost; ordinary survival operations at 40+ levels too expensive (rename exception). Equal compatible enchantments combine upward to cap; smithing netherite retains enchants.
- Grindstone removes non-curse enchants/returns some XP/repairs matching items. Craft repair loses enchants, anvil can retain. Mending spends collected XP on held/equipped gear; Unbreaking reduces durability spending, not all breakage.
- Fortune/Silk Touch, Infinity/Mending, Riptide/Loyalty or Channeling, main damage enchants and most Protection variants conflict. Efficiency speed, Fortune block loot, Looting mob loot, Feather Falling falls, Respiration air, Aqua Affinity mining. Treasure-only Mending not ordinary table offer.
- Equipment needs relevant slot/context; curses survive grindstone. Vanishing loses cursed items on ordinary death unless rules retain drops.

## Brewing

- Stand uses blaze powder fuel/up to 3 water bottles/ingredient, 20 s/cycle, 20 cycles/fuel. Wart makes awkward base for most effects; bottles/fuel/ingredients/output are separate.
- Awkward additions: sugar Swiftness, rabbit foot Leaping, glistering melon Healing, spider eye Poison, ghast tear Regeneration, magma cream Fire Resistance, blaze powder Strength, golden carrot Night Vision, pufferfish Water Breathing, turtle shell Turtle Master, phantom membrane Slow Falling; stone Infested, slime block Oozing, cobweb Weaving, breeze rod Wind Charged.
- Fermented eye: Night Vision to Invisibility, Healing/Poison to Harming, Swiftness/Leaping to Slowness. Water + fermented eye directly Weakness. Redstone extends compatible duration/glowstone strengthens, variants normally conflict. Gunpowder splash, dragon breath splash to lingering; not all modifiers apply.
- Fire Resistance does not cover falls/explosions; Water Breathing pauses air, Slow Falling lowers fall risk. Milk removes good/bad effects. Splash effect depends on impact distance; undead harmed by Healing/healed by Harming.

## Building and shelter

- Shelter protects only hazards its geometry/materials exclude. Cover blocks ordinary arrows/sight; gaps admit smaller mobs/projectiles, walls do not stop vex/warden sonic. 2-high gaps exclude endermen, not spiders/babies. Roof does not prevent dark spawns.
- Wood burns, lava/fire ignites nearby flammables without contact. Blast resistance varies, obsidian resists common blasts not all damage. Sand/gravel fall, scaffolding needs support.
- Sneaking usually prevents walking off ledges, not knockback/every shape. Doors/gates control passage; Hard zombies break wood doors, iron needs power. Fences stop walkers, not all climbers/fliers.
- Light/surfaces matter (spawning); bottom slabs/glass prevent many ground spawns. Storage survives player death; tables/furnaces recoverable. Bed/charged anchor sets respawn, blocked/destroyed invalidates. Cooking needs fuel, not underground room.

## Light and spawning

- Most natural Overworld hostile ground spawns need block light 0/sky darkness/floor/space. Torch emits 14, decays with distance, protects positions not entire caves. Sun burns many undead, not creeper/spider/husk/parched/protected undead. Thunder permits some daytime spawns.
- Natural monsters normally spawn beyond 24 from players, not beyond 128; caps/biome/simulation/surfaces matter. Ordinary spawners activate within 16/use other light tests/repeat. Trial spawners detect participants/scaled waves/cooldown/ominous variants.
- Nether rules vary: ghast/magma cube need no darkness, blazes/wither skeletons fortress/light rules, piglin/hoglin own checks. Blanket 'Nether spawns ignore light' false. Slime chunks/swamps differ height/light/moon; End endermen own checks.
- Many animals need grass/light/biome, fish water. Existing mobs enter lit areas; light does not neutralize them. Natural shriekers summon wardens, player-placed cannot; vibration is distinct from light.
- Raids/patrols/reinforcements/portal/persistent mobs differ; mob-free observation is not future safety. Rules/difficulty/datapacks alter spawning.

## Lava and portals

- Water over lava source makes obsidian; flowing-lava contact commonly cobblestone, lava flowing down onto water stone. Not all lava yields obsidian. Nether bucket water evaporates, cauldrons hold it. Water sources renew with adjacent sources/support, lava has no infinite pools but dripstone/cauldrons renew collection.
- Nether frame rectangular obsidian, outside minimum 4x5/inside 2x3, optional corners means 10 blocks; outside maximum 23x23. Crying obsidian invalid, fire inside ignites complete frame.
- Connects Overworld/Nether only, X/Z scale 8:1/Y unscaled. Nearby portal search/safe exit can link elsewhere; exact coordinates do not guarantee a link with alternatives. Mobs/items transit, cooldown applies.
- End portal needs 12 oriented natural frames/eyes; frames uncraftable/uncollectable in survival. Active interior enters End; exits/gateways differ.
- Lava hurts/burns, swims slower than water, flows faster/farther in Nether. Armour differs from Fire Resistance. Water cushions/extinguishes only where it remains; cauldrons differ. Magma hurts unless sneaking/protected.

## Navigation and respawn

- +X east/-X west/+Z south/-Z north/Y height; dimension + position identify place. Overworld placement Y -64..319, Nether/End 0..255; Nether normal terrain/roof roughly 0..127. Terrain is not placement limit.
- Ordinary compass world spawn in Overworld, not bed/goal/stronghold, spins elsewhere. Lodestone compass same-dimension bound block; recovery compass last death only in its dimension. Maps explored terrain/markers/scale, not live hidden threats; treasure maps an area.
- Overworld eyes indicate stronghold/can break; separate sight lines localize, not reveal room. Nether X/Z travel 8 times Overworld distance; coordinates without dimension ambiguous.
- Bed use sets Overworld spawn, sleep skips night/storm when conditions/rules permit. Nearby monsters block sleep; destroyed/obstructed bed falls back. Nether/End beds explode even by day.
- Anchor holds 4 glowstone charges/Nether spawn/one spent per respawn. Charging differs from setting spawn. Charged use outside Nether explodes, empty/invalid anchor fallback. Respawn does not restore dropped inventory.
- Drops age in ticking chunks (death); remembered routes change, compass/memory cannot prove clear access.

## Transport

- Boat water/ice travel/two seats; chest boat trades passenger capacity for storage. Carries many mobs/prevents some despawning, not special timers; no universal threat/air protection. Dismount needs space.
- Cart rails/powered accelerates/unpowered brakes/slopes/momentum matter. Detector signals, activator affects/ejects, chest/hopper/furnace/TNT carts differ. Experiments change physics.
- Horse mounting tames/saddle steers/armour/stats vary; donkey/mule chests, llama leads/caravans. Camel two seats/dash. Saddles craft leather/iron. Pig carrot-on-stick, strider fungus-on-stick with saddles; cold slows strider, lava-safe mount not rider immunity.
- Happy ghast harness aerial passengers; leads eligible mobs/some vehicles, obstacles/range matter. Nautilus saddle/armour/water dash, mounted Breath pauses air without refilling; land suffocates it. Zombie nautilus cannot breed/may carry trident drowned; camel husk/zombie horse can carry enemies.
- Elytra needs space/durability; starless rockets boost without blast. Riptide wet conditions; pearls teleport to impact/usually damage, unsafe edges unsafe destinations.

## Survival redstone

- Power 0-15/dust decays; lever latches/button pulses/plates depend on material. Repeater restores/delays, comparator inventory/compare/subtract, torch inverts/can burn out with rapid toggles.
- Iron doors/trapdoors need power, wood also hand-opens. Piston pushes at most 12, sticky pulls, obsidian/many block entities immovable; observers pulse changes/trigger harvesters.
- Hopper transfers/collects, power locks; dropper ejects/moves, dispenser uses supported arrows/buckets/bone meal. Furnace has input/fuel/output sides. Copper golem sorts within chest/search rules.
- Rails move/sense carts, daylight sensor sky/daylight/invert. Copper bulb toggles per pulse/comparator reads state; crafter needs arranged ingredients/output space/power.
- Supports repeated player-chosen work, not missing-material creation. Water washes dust/torches, updates/space/chunk ticking affect reliability.

## Weather and time

- Default day 24,000 ticks (20 min at 20 TPS), rules alter it. Sun/moon/normal clocks useful Overworld, clocks spin elsewhere. Sleep skips night/clears weather when conditions permit, multiplayer sleep percentage varies.
- Rain extinguishes exposed fire/hydrates farmland/cauldrons, temperature decides rain/snow, dry biomes no local rain. Rain not lava safety; water/rain harms enderman/blaze. Powder snow differs from snowfall.
- Thunder darkens enough for daytime monsters; lightning ignites/transforms pig/creeper/villager. Rod attracts in range, not immunity; Channeling needs thunder/sky exposure.
- Sunburn needs sky/no protection. Moon affects swamp slimes, prolonged lack of rest permits phantoms, sleep resets timer. Time/weather/biome/cover jointly affect threats.

## Death and despawn

- Default death drops gear/inventory/some XP/clears effects/returns valid spawn or world spawn. keepInventory alters, Hardcore prevents normal respawn. Held totem prevents many deaths not void; carried elsewhere does not. Vanishing loses cursed items.
- Items despawn after 6,000 ticking entity ticks (5 min at 20 TPS), unloaded chunks pause. Fire/lava/explosion/cactus/void destroy earlier; netherite resists fire/lava not all causes. Merging stacks affects age; death + 5 min is not always deadline. Remembered drops may be gone.
- Most nonpersistent monsters immediately despawn beyond nearest player 128, after 30 s inactivity randomly beyond 32. Type/persistence/passengers/difficulty/ticking alter; 33 blocks not instant guarantee. Naming usually persists; some equipment pickup/taming/boats affect it, not all special timers.
- Land farm animals/villagers usually persist, fish/squid/other aquatic types differ. Trader/llamas special timers, wardens burrow; despawn not death/no loot/XP, babies often lack adult drops.
- Drops can require player/tamed-wolf kill credit, notably rods. Looting changes eligible chances/counts, not unreachable hit success. Recovery needs actual surviving items/correct dimension.
