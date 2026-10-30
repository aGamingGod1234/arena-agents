# Worked construction and blaze programs

Optional examples, not standing orders. Choose the method, thresholds, material, exact route and targets from fresh visible facts. Load `capabilities {section:"program"}` for syntax. Combine **Common prelude** with exactly one body below as `runProgram.source`; put your chosen JSON in `parameters`, use `background:true, maxActions:512, timeoutMs:300000, observationIntervalMs:100`. End of source returns control without verifying the goal. Install the Survival standing guard first if you choose it. These examples stop and release input on surprises; the model must choose the next defense immediately. A stopped routine never proves safety.

## Common prelude

All bodies need `minHealth` (HP), `minAir` (seconds), and `allowedThreat` (`null` for construction; chosen blaze UUID for combat). The guard stops on health below its starting value, fire/lava, low health/air, suffocation or a different urgent threat. Missing geometry is a blocker. `cell` turns to a cell and uses normal reach/visibility inspection, for visible blocks. Focused inspection cannot certify air; placement validates the exact destination, support and body clearance. Absence from the block list remains unknown. `requireCell` compares exact block IDs. `held` uses an observed inventory slot. Each leg first looks toward its chosen feet target to refresh the visible route after building or fluid changes.

```js routine-common
program.onUnhandledAttention("continue_and_notify", {reassessWhen:()=>false});
const p = program.parameters();
const hp = player.state().health;
program.watch(() => player.state().health < hp || player.state().health < p.minHealth || player.state().fire || player.state().inLava || player.state().suffocating || (player.state().underWater && player.state().airSecondsLeft < p.minAir) || (player.state().threat !== null && player.state().threat.uuid !== p.allowedThreat), {mode:"interrupt",after:"reconsider"}, async () => {});
async function checked(r) {
  if (!r.succeeded) program.checkpoint(r.reasonCode);
}
async function go(t) {
  await checked(await player.lookAt({x:t.x,y:t.y+1,z:t.z}));
  await checked(await player.navigateTo({x:t.x,y:t.y,z:t.z,tolerance:0.15,sprint:false,timeoutMs:10000}));
}
async function cell(x,y,z) {
  await checked(await player.lookAt({x:x+0.5,y:y+0.5,z:z+0.5}));
  const page = await world.inspect({section:"block",x:x,y:y,z:z});
  if (page.state !== "SUCCEEDED") program.checkpoint(page.reasonCode);
  return page.block;
}
async function requireCell(x,y,z,id) {
  const b = await cell(x,y,z);
  if (b.blockId !== id) program.checkpoint("unexpected block");
}
async function held(id) {
  for (const s of inventory.slots({itemId:id})) {
    if (s.slot === "offhand") program.checkpoint("move chosen item to main inventory");
    const slot = s.slot === "mainhand" ? inventory.state().selectedSlot : s.slot;
    await checked(await player.selectTool({sourceSlot:slot,hotbarSlot:0,expectedItemId:id,minRemainingDurability:0}));
    return;
  }
  program.checkpoint("missing item");
}
```

## Bucket cast a portal

Use in the Overworld with a dry working ledge, a contained water flow beside each intended lava cell, ten observed lava sources, one water bucket, a nonflammable mold and ignition. Water touching **source** lava makes obsidian. Flowing lava may make cobblestone. Keep your feet outside both fluids; never stand inside the mold or swim to work. Build/inspect the mold and safe access before choosing this program. Reuse an existing partial frame when its facts match.

A worked mold, relative to its bottom-left frame cell: frame plane z=0, x=0..3/y=0..4, back wall at z=1 through y=5, with nonflammable corners (0,0),(3,0),(0,4),(3,4). Choose a dry front scaffold with feet y=2/z=-1.5 and a physically observed route to lava on the same bank. Pour water against the back wall's north face at (1,5,1), creating a waterfall at (1,5,0). Cast left side (0,1),(0,2),(0,3), bottom (1,0), then top (1,4); use two batches so parameters stay bounded. Bottom uses the ground below it with face up; side/top use the back wall's north face. The wet neighbor is the waterfall at the same y, except bottom/top use water directly above. Reclaim the source, move it to x=2, then cast right side (3,1),(3,2),(3,3), bottom (2,0), top (2,4) and reclaim again. For whole-frame inspection/lighting choose a supported central feet position such as (1.5,2,-2.5); a steep view against a wall may hide its lower block. Translate/rotate these coordinates only after checking actual supports, reach, water and dry footing. The model still chooses/builds the mold and access; an ideal schematic is not evidence of current terrain.

Parameters: `water` is an observed solid support `{x,y,z,face,blockId}` whose clicked face puts the initial water in your chosen gutter; `waterStand` is dry feet. `casts` is a bounded array (up to four per 4 KiB parameter batch) of `{source,sourceStand,stand,support,target,wet}`. `source` names an exact observed lava source; `support` is the solid cell/face placing lava in `target`; `wet` is the adjacent **observed water cell** that will touch it. A visible occupied target stops the pour; the exact support face must remain visible for the vanilla bucket click. `wet` may also be the water directly above the destination. All coordinates are absolute. Supply only the next casts whose geometry you have actually seen; resume with a fresh plan when a scaffold changes. With water already running, set `placeWater:false` and begin with an empty bucket; otherwise true. Set `reclaim:false` during a batch; true at the end also needs `reclaimStand` and the exact `waterSource` cell, both currently visible/reachable. Reclaim before repositioning the waterfall or lighting.

```js routine-portal
if (world.state().dimension !== "minecraft:overworld") program.checkpoint("water needs Overworld");
if (p.placeWater) {
  await go(p.waterStand);
  await requireCell(p.water.x,p.water.y,p.water.z,p.water.blockId);
  await held("minecraft:water_bucket");
  await checked(await player.interactBlock({x:p.water.x,y:p.water.y,z:p.water.z,face:p.water.face,hand:"main",expectedItemId:"minecraft:water_bucket"}));
  if (inventory.count("minecraft:bucket") < 1) program.checkpoint("water not placed");
}
for (const c of p.casts) {
  await go(c.sourceStand);
  const lava = await cell(c.source.x,c.source.y,c.source.z);
  if (lava.blockId !== "minecraft:lava" || (lava.state.level !== 0 && lava.state.level !== "0")) program.checkpoint("not a visible lava source");
  await held("minecraft:bucket");
  await checked(await player.interactBlock({x:c.source.x,y:c.source.y,z:c.source.z,face:"up",hand:"main",expectedItemId:"minecraft:bucket"}));
  if (inventory.count("minecraft:lava_bucket") < 1) program.checkpoint("lava not collected");
  await go(c.stand);
  const occupied = world.nearest(world.blocks({x:c.target.x,y:c.target.y,z:c.target.z}));
  if (occupied !== null && occupied.blockId !== "minecraft:water") program.checkpoint("cast destination occupied");
  await requireCell(c.wet.x,c.wet.y,c.wet.z,"minecraft:water");
  await requireCell(c.support.x,c.support.y,c.support.z,c.support.blockId);
  await held("minecraft:lava_bucket");
  await checked(await player.interactBlock({x:c.support.x,y:c.support.y,z:c.support.z,face:c.support.face,hand:"main",expectedItemId:"minecraft:lava_bucket"}));
  await checked(await player.wait(250));
  await requireCell(c.target.x,c.target.y,c.target.z,"minecraft:obsidian");
}
if (p.reclaim) {
  await go(p.reclaimStand);
  await requireCell(p.waterSource.x,p.waterSource.y,p.waterSource.z,"minecraft:water");
  await held("minecraft:bucket");
  await checked(await player.interactBlock({x:p.waterSource.x,y:p.waterSource.y,z:p.waterSource.z,face:"north",hand:"main",expectedItemId:"minecraft:bucket"}));
  if (inventory.count("minecraft:water_bucket") < 1) program.checkpoint("water not reclaimed");
}

if (p.ignite) {
  await go(p.lightStand);
  let minX = p.bottom.x;
  let maxX = p.bottom.x;
  let minZ = p.bottom.z;
  let maxZ = p.bottom.z;
  for (const f of p.frame) {
    minX = math.min(minX,f.x);
    maxX = math.max(maxX,f.x);
    minZ = math.min(minZ,f.z);
    maxZ = math.max(maxZ,f.z);
  }
  for (let i=0;i<20;i++) {
    await checked(await player.lookAt({x:p.bottom.x+0.5,y:p.bottom.y+2.5,z:p.bottom.z+0.5}));
    let wet = false;
    for (const b of world.blocks({blockId:"minecraft:water"})) {
      if (b.x >= minX && b.x <= maxX && b.z >= minZ && b.z <= maxZ && b.y > p.bottom.y && b.y < p.bottom.y+4) wet = true;
    }
    if (!wet) break;
    if (i === 19) program.checkpoint("water still visible inside frame");
    await checked(await player.wait(500));
  }
  for (const f of p.frame) await requireCell(f.x,f.y,f.z,"minecraft:obsidian");
  await held("minecraft:flint_and_steel");
  await checked(await player.interactBlock({x:p.bottom.x,y:p.bottom.y,z:p.bottom.z,face:"up",hand:"main",expectedItemId:"minecraft:flint_and_steel"}));
  await requireCell(p.bottom.x,p.bottom.y+1,p.bottom.z,"minecraft:nether_portal");
}

```

Set `ignite:false` during casting. Flow takes several seconds to drain; the body checks visible water within the frame for up to twenty bounded samples rather than assuming a fixed delay clears it. Missing water rows alone do not prove air: the ignition receipt and purple-block check remain authoritative. To light after draining, choose `ignite:true` with `frame` (all ten exact frame cells), `lightStand` (dry feet) and `bottom` (one inside bottom obsidian cell). Verify the 2x3 clear interior and choose ignition; the body rechecks the complete frame and purple portal blocks. Then choose entry. Reclaim the water source and verify drainage before lighting. A dimension-transition receipt ends a leg; choose fresh Nether actions after it. Obsidian cast in the wrong place needs a diamond pickaxe to recover.

## Pillar up

Parameters: `base:{x,y,z}` is the air cell at your starting feet, `height` is 1..8, `blockId` is a carried nonflammable full block, `supportId` is the observed block below. Start centered on that support, stationary, with dry feet; choose another method under a ceiling. The body looks up, then combines jump and downward block use in one frame so the click occurs while airborne, and checks the block and landing. A blocked jump or unchanged support ends the routine. It never digs the support out or steps off the pillar.

```js routine-pillar
if (p.height !== math.floor(p.height) || p.height < 1 || p.height > 8) program.checkpoint("height bound");
await go({x:p.base.x+0.5,y:p.base.y,z:p.base.z+0.5});
await requireCell(p.base.x,p.base.y-1,p.base.z,p.supportId);
await held(p.blockId);
for (let i=0;i<8;i++) {
  if (i >= p.height) break;
  const y = p.base.y+i;
  await checked(await player.lookAt({x:p.base.x+0.5,y:y+2.5,z:p.base.z+0.5}));
  if (!player.state().onGround || player.state().inWater) program.checkpoint("pillar footing changed");
  await checked(await player.control({forward:0,strafe:0,jump:true,sneak:false,sprint:false,attack:false,use:true,yaw:player.state().yaw,pitch:90,instantLook:true,selectedSlot:0,hand:"main",ticks:8}));
  await checked(await player.wait(400));
  await requireCell(p.base.x,y,p.base.z,p.blockId);
  if (!player.state().onGround || player.state().y < y+0.9) program.checkpoint("pillar landing unverified");
}
```

## Bridge a gap or cross Nether lava

Parameters: `start:{x,y,z}` is the solid block under centered feet, `supportId` its exact ID, `dx,dz` one cardinal unit (one is +/-1, other 0), `length` 1..8, `blockId` a carried full nonflammable block. `nether:true` requires the Nether and a three-wide starting ledge of `supportId`, and builds three-wide footing with one-high side rails before each step. `nether:false` makes a one-wide bridge. Choose a level route **above** lava with dry headroom and a reachable far bank; no blind bridge into fog. Nether water evaporates. Fire Resistance is useful when you choose it and verify its effect, but cannot replace footing. A strider needs its own chosen saddle/control plan. Stop for ghasts, piglins or incoming fire; build real cover before resuming.

The body sneaks to the lip so the support's outward face is visible, places one cell, checks it, then crosses. No sprint or gap jump. Material needed per cell: one for a narrow bridge, five for Nether footing/rails; reserve enough for the destination. It leaves you on the last new block, requiring a new choice for the bank or next segment.

```js routine-bridge
if (p.dx !== math.floor(p.dx) || p.dz !== math.floor(p.dz) || math.abs(p.dx)+math.abs(p.dz) !== 1 || p.length !== math.floor(p.length) || p.length < 1 || p.length > 8) program.checkpoint("bridge bounds");
if (p.nether && world.state().dimension !== "minecraft:the_nether") program.checkpoint("dimension changed");
const yaw = math.atan2(-p.dx,p.dz)*180/3.141592653589793;
await requireCell(p.start.x,p.start.y,p.start.z,p.supportId);
if (p.nether) {
  for (const side of [-1,1]) await requireCell(p.start.x+p.dz*side,p.start.y,p.start.z-p.dx*side,p.supportId);
}
await go({x:p.start.x+0.5,y:p.start.y+1,z:p.start.z+0.5});
await held(p.blockId);
for (let i=0;i<8;i++) {
  if (i >= p.length) break;
  const x = p.start.x+p.dx*(i+1);
  const z = p.start.z+p.dz*(i+1);
  const y = p.start.y;
  await checked(await player.lookAt({x:x+0.5,y:y+1.5,z:z+0.5}));
  if (!player.state().onGround || player.state().inWater) program.checkpoint("bridge footing changed");
  await checked(await player.control({forward:1,strafe:0,jump:false,sneak:true,sprint:false,attack:false,use:false,yaw:yaw,pitch:55,selectedSlot:0,hand:"main",ticks:12}));
  await checked(await player.place({x:x,y:y,z:z,face:"up",itemId:p.blockId}));
  await requireCell(x,y,z,p.blockId);
  if (p.nether) {
    for (const side of [-1,1]) {
      const sx = x+p.dz*side;
      const sz = z-p.dx*side;
      await checked(await player.place({x:sx,y:y,z:sz,face:"up",itemId:p.blockId}));
      await checked(await player.place({x:sx,y:y+1,z:sz,face:"up",faceMode:"strict",itemId:p.blockId}));
      await requireCell(sx,y+1,sz,p.blockId);
    }
  }
  await go({x:x+0.5,y:y+1,z:z+0.5});
  if (!player.state().onGround) program.checkpoint("bridge landing unverified");
}
```

## Fight one blaze from cover

Parameters: `targetId` and `allowedThreat` are the same currently seen blaze UUID; `cover` and `peek` are observed dry feet on supported ground; `minHealth` is your retreat threshold. Equip a shield in offhand and choose `weaponId` from a carried sword before starting. Choose `ranged:true` only with a usable bow and arrows, otherwise false. `cover` must actually block the blaze's line of fire; a held block is not cover. Place supported nonflammable cover first when needed. `peek` must give a clear shot or put the chosen blaze within melee reach on safe ground; floating targets over lava need a different choice. This bounded exchange shields facing the blaze, peeks, shoots or swings once, then returns behind cover. Reobserve before another exchange; a missing blaze is not a kill. Health below its starting value or another threat stops the exchange for a new decision. Cover/retreat failures also stop, leaving the model responsible for immediate defense. Shields face the threat and reduce frontal fireball damage; burning ground and melee still matter.

```js routine-blaze
const target = world.nearest(world.entities({stableId:p.targetId,type:"minecraft:blaze"}));
if (target === null) program.checkpoint("blaze no longer visible");
if (p.ranged) {
  if (inventory.count("minecraft:arrow") < 1) program.checkpoint("no arrows");
  await held("minecraft:bow");
} else await held(p.weaponId);
await go(p.cover);
await checked(await player.lookAt({x:target.x,y:target.y+0.8,z:target.z}));
await checked(await player.blockWithShield({durationMs:3500}));
await go(p.peek);
await checked(await player.lookAt({x:target.x,y:target.y+0.8,z:target.z}));
const seen = world.nearest(world.entities({stableId:p.targetId,type:"minecraft:blaze"}));
if (seen === null) program.checkpoint("blaze lost behind cover");
if (p.ranged) {
  await checked(await player.lookAt({x:seen.x,y:seen.y+0.8,z:seen.z}));
  await checked(await player.useRanged({targetId:seen.stableId,drawDurationMs:1000,timeoutMs:4000,trackTarget:true}));
} else {
  if (seen.distance > 3) program.checkpoint("choose a nearer supported peek or a bow");
  await checked(await player.lookAt({x:seen.x,y:seen.y+0.8,z:seen.z}));
  await checked(await player.attack({targetId:seen.stableId,timeoutMs:1000}));
}
await go(p.cover);
```
