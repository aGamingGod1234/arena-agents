#!/usr/bin/env python3
"""Render the d38 report from committed fixtures and accepted live evidence. Run the collector first."""
import hashlib,json,pathlib
root=pathlib.Path(__file__).resolve().parents[2];out=root/'evals/d38-savepoints'
summary=json.loads((out/'verification-summary.json').read_text());truth=json.loads((out/'structure-truth.json').read_text());manifest=json.loads((out/'manifest.json').read_text())
results={p.name:json.loads(p.read_text()) for p in (out/'results').glob('*.json')};rows=[]
for p in sorted((out/'checkpoints').glob('*.json')):
    c=json.loads(p.read_text());r=results.get(p.name);r=r if r and r['sha256']==hashlib.sha256(p.read_bytes()).hexdigest() else None;s=c['setup'];route=c.get('recoveryRoute');dim=s['dimension'].split(':')[1]
    route_text=f"ladder {route['bottom'][1]} → {route['top'][1]}" if route else 'surface camp'
    status=f"[PASS](results/{p.name})" if r else 'pending'
    rows.append(f"| `{p.name}` | {dim}, y{s['position'][1]} | {c['bedSpawn']['position'][1]} | {route_text} | {status} |")
seed_rows=[]
for s in sorted(truth['seeds'],key=lambda s:s['seed']):seed_rows.append(f"| `{s['seed']}` | {s['fortress']['distanceBlocks']:.1f} | {s['bastion_remnant']['distanceBlocks']:.1f} |")
valid=list(results.values());seconds=[r['safety']['wallMs']/1000 for r in valid if r.get('pass')];ticks=[r['safety']['ticks'] for r in valid if r.get('pass')]
window=f"{min(seconds):.1f}–{max(seconds):.1f} wall seconds; {min(ticks)}–{max(ticks)} game ticks" if seconds else 'not yet complete'
base=out/'baseline-forced.json'
baseline='Baseline control pending.'
if base.exists():
    b=json.loads(base.read_text());baseline=f"Original `9-nether-entry-sol-bed-gold.json`: respawn NBT `{b.get('respawnConfig','unavailable').split('entity data: ')[-1]}`. Intact-bed position `{b.get('bedRespawn',{}).get('pos')}`; after breaking both halves `{b.get('brokenBedRespawn',{}).get('pos')}`; world-spawn fallback check `{b.get('brokenBedRespawn',{}).get('pass')}`. This control tests spawn semantics only; its idle window is deliberately skipped."
original_dir=pathlib.Path('/home/agaminggod/Desktop/Projects/arena-beat-game/long/checkpoints');originals=[m for m in manifest if 'originalSha256' in m];unchanged=all(hashlib.sha256((original_dir/m['variantOf']).read_bytes()).hexdigest()==m['originalSha256'] for m in originals)
text=f'''# d38: competent-player save points

Status: **{summary['passed']}/{summary['total']} current fixtures verified**. All {len(originals)} original files remain byte-for-byte unchanged: **{unchanged}**. Branch: `claude/d38-savepoints`, based on `claude/d22-int` at `86692ef6`.

## What the old save points actually restored

`api/long-sub.sh` passes `CHECKPOINT` to `scripts/quality/run-long.mjs`. That script reads the checkpoint seed, replaces the generated long-run setup, and keeps the normal goal, run budget, death continuation and stop-on-dragon rules. `source` is provenance, not a world snapshot: `run-scenarios.mjs` still launches a fresh natural world from the seed. Only `setup.commands` rebuild placed or dug blocks. Inventory and armour come from the JSON, and ground-search flags can move the body to another nearby natural standing spot. Old underground mining routes, chests and placed crafting tables therefore vanished.

Relevant history, inspected locally:

- `c2034afd`: checkpoints from recorded samples, with rebuilt portal pairs.
- `7d7c26c1`: armour slots and offhand parsed from player NBT.
- `e149bc2d`: rebuild a starting Nether portal for games that began there.
- `bb2fafc1`: bed fixture and model-free respawn probe, implemented with `/spawnpoint`.
- `75670c53`: move the End bed into the portal room.
- `e32992c1`: fresh loot salt per checkpoint game. `setup.randomSalt` runs vanilla `random reset *`; `--random-salt N` repeats a salt and `none` keeps the seed's default sequences. Salt changes loot rolls, not terrain or structure locations. Long-run salt behavior is unchanged here. Verification uses salt `380038`.

The old helper claimed `/spawnpoint` behaved like a used bed. Live NBT exposes `forced: 1b`; that keeps a coordinate spawn after the bed disappears. The replacement taps the bed through vanilla Carpet player interaction, briefly beginning sleep at night, and checks that vanilla recorded the **head** position without a forced flag. It then restores the body to the checkpoint's start. Old JSON still runs its old forced-spawn commands, preserving reproduction of past setups.

## What changed and why

All 27 fixtures have a lit Overworld bed camp, a placed crafting table, and a chest containing a stone pick, stone axe, 16 food, 64 blocks, eight logs and a shield. Nether recovery chests also contain a gold helmet and flint and steel. End recovery chests add a water bucket, another stack of blocks, a bow and arrows.

Primary kits contain an iron pick and sword, shield, 32 cooked beef, 128 cobblestone, wood, a water bucket and flint and steel. Iron armour is worn; Nether starts wear a gold helmet with iron chestplate, leggings and boots. Lava stages retain **two empty buckets** for casting. Stronghold stages keep their eyes; End stages keep a bow, arrows and pearls. The gold10 variants retain ten barter ingots.

Underground camps have a lined ladder shaft to the surveyed surface, with its entrance visible from the bed. No checkpoint interface seeds player terrain history or a route notebook, so route information is supplied by real visible blocks. Fixed prepared starts replace the old nearby-ground search, which could separate the body from its kit history or portal. The old `2b` and `9-nether-entry-sol*` portal pairs also sat at vanilla's linking boundary. The `2b` Overworld portal now has a short protected passage from its bed camp; the `9` portals move to the camp's rear wall. These variants additionally make a live round trip through the right portal column, check both prepared destinations, and retain full health. The actual 26.1.2 `PortalForcer` and `PoiManager` bytecode confirms the inclusive square search radii of 16 Nether blocks and 128 Overworld blocks.

`6-end-portal-room-v2.json` covers all **15 original lava cells**, removes the silverfish spawner at `(328,-26,2553)`, clears existing silverfish, lights the room and restores steps to the filled portal. The bed stays in the room, and a ladder reaches the surface. Those same Overworld preparations support direct End variants.

The direct End starts also needed preparation: an exposed-platform trial died to dragon magic at about **54 seconds**. They now begin in a dug two-block-high shelter under the island, with an end-stone bridge and guard blocks connecting the arrival platform, plus a visible ladder to the surface. Platform regeneration leaves the bridge's end intact. The dragon, endermen, normal damage and monster spawning remain enabled. Prefer the portal-room checkpoint when measuring the first crossing itself.

Nineteen `*-v2.json` files replace each original by name. Four independent seeds add both Nether-entry and natural lava-pool starts. Pools were found cheaply in the already-generated survey worlds using the existing offline NBT reader; the live check confirms at least ten natural source blocks remain after camp construction. Ground surveys exclude logs, leaves and mangrove roots, and an obstructed exit gets a clear landing with two blocks of headroom. This corrected one mangrove shaft that initially stopped under leaves. Nether shelter doors open onto surveyed natural standing ground, and their Overworld portals have matching camps.

## New checkpoint list

Every PASS means the exact current JSON passed inventory, spare chest, crafting table, full-health idle, intact-bed respawn, broken-bed world-spawn fallback and route checks. Bed y is the Overworld recovery camp; the start column names the gameplay dimension.

| Checkpoint | Start | Bed y | Recovery route | Verification |
|---|---|---:|---|---|
'''+ '\n'.join(rows)+f'''

## Independent seed distances, evaluator only

Actual `/locate` results and coordinates are in `structure-truth.json`; natural exits and matching camp surveys are in `nether-survey.json`. Candidates were first checked with `evals/d37-blaze/locate.py`, then re-located from the actual selected Nether portal positions. Distances below are horizontal Euclidean distances to the nearest structure start. Neither these sidecars nor their facts are added to the model's goal, notebook, observations or provider workspace.

| Seed | Fortress blocks | Bastion blocks |
|---|---:|---:|
'''+ '\n'.join(seed_rows)+f'''

The two original lava-pool variants retain **85 natural lava sources, 69 exposed**, in their verified worlds. The original `-8891462362762682724` family is retained, as are the existing `20261009` Nether/fortress stages. New lava starts use the same four independent seeds; their portals are for the player to build.

## Live verification

`test-savepoints-live.mjs` boots a fresh disposable Fabric world for each fixture, applies production `applyQualitySetup` and `activateQualitySetup`, and never calls a model. It uses the production jar `d25-bb227cbc.jar`, Minecraft 26.1.2, normal difficulty and monster spawning. Every heavy job holds a live slot. Launchers survive the session with `setsid`, and write logs and status under `arena-beat-game/evals/d38-savepoints/`.

Accepted idle windows: **{window}**. Every accepted body stayed at **20 HP**, with zero deaths, for at least 60 wall seconds and 1,200 game ticks. Each carried stack and armour slot is checked against NBT. Chest contents and the placed crafting table are checked after death. Underground routes are checked block by block, including ladder supports, bed access, head clearance and the surface opening; the body also climbs each shaft with vanilla `/player Probe move forward` input. This proves physical access, not an autonomous pathfinder route. Direct End fixtures additionally check the bridge and island ladder. Portal-room fixtures check the 15 original lava positions and original spawner position directly.

The body is killed with `/kill` and respawned through its real respawn action. The checker records actual health, dimension and position: the current body may label its action `CANCELLED` when respawn changes its lifecycle to `STARTING`, even though the new player exists. The checker follows goal revisions and verifies the living body instead of mistaking that receipt for a failed spawn. Before kills it lets 65 game ticks pass, so client-load immunity cannot invalidate `/kill` under slow chunk generation.

For the broken-bed check only, the disposable copy gets a distinctive world spawn at `(4096,300,4096)` on a safe platform. The final checker uses vanilla `respawn_radius=0` to avoid random scatter; acceptance always requires the actual new body to land within three blocks of that configured world spawn. Both bed halves are removed; the next actual respawn must reach that world spawn. This avoids confusing beds near natural world spawn with successful fallback. The artificial world spawn is never included in a delivered checkpoint.

{baseline}

`results/` contains only successful evidence whose SHA-256 matches the current fixture. `verification-summary.json` retains failed and superseded attempts separately; those do not count as passes. The original platform death prompted the island-shelter change. Early checker attempts exposed stale goal revisions, client-load immunity, and the renamed `respawn_radius` rule; affected fixtures were rerun. Full server logs and disposable worlds remain outside git in the external evaluation directory. No credential files are copied.

## Gates and limits

- `./gradlew build verifyCore --offline`: PASS, including the final build after harness changes.
- `npm test`: **6,943 pass, 11 known Windows-only failures, 75 skipped** out of 7,029 tests on Linux.
- `npm run test:contracts`: **631/631 pass**.
- Focused checkpoint, setup and failure-schema tests: **41/41 pass**.
- Build-only launcher check: all 27 preserve `usedBedSpawn` through `buildQualityScenario` and `normalizeHeadlessScenario`, with the player goal and death continuation unchanged.
- All 27 JSON setups normalize; maximum setup-command count is **58**, below the existing limit of 128. No byte budgets were raised.

No model games, pathfinder success-rate trial, or agent-success-rate comparison was run: this measures fixture correctness. Windows-only checks remain unverified on Windows. Body and model code are unchanged; harness changes restore used-bed preparation, expose monster spawning to the model-free boot helper, and verify the fixtures.

## Launcher from now on

Use the version 2 filename corresponding to the old checkpoint, and rotate the four new seed variants for Nether and lava evaluations. Use a coordinator checkout containing this branch's `usedBedSpawn` support; an older coordinator ignores that field.

```bash
B=/home/agaminggod/Desktop/Projects/arena-beat-game
ROOT=/home/agaminggod/Desktop/Projects/aa-d38-savepoints
CHECKPOINT="$B/long/checkpoints/9-nether-entry-sol-bed-gold-v2.json" \\
  "$B/api/long-sub.sh" d38-nether "$B/jars/d25-bb227cbc.jar" "$ROOT" codex 90
```

After integration, `ROOT` can be the merged `aa-d22-int` checkout. `long-sub.sh` keeps Sol on `gpt-6.1-sol`, low effort and the default service tier. No push, PR or integration merge is part of this task.
'''
(out/'REPORT.md').write_text(text)
print(f'Wrote report: {summary["passed"]}/{summary["total"]} current fixtures verified')
