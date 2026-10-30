"""Operator estimates from the census, separate from measured production-body trials."""
import pathlib,json,math,collections,sys
base=pathlib.Path(sys.argv[1]);surveys=json.load(open(base/'survey/summary.json'));loot=json.load(open(base/'chest-odds.json'));out=[]
# Vanilla unenchanted iron pickaxe: hardness 3, speed 6, harvest divisor 30 => 15 ticks;
# allow the 5-tick post-break delay. Walking on level ground is 4.317 blocks/s.
for s in surveys:
 remaining={tuple(r['at']):r for r in s['oreReachableByUnmodifiedWalking']};patches=[]
 while remaining:
  a,r=remaining.popitem();q=[a];rows=[r]
  for x,y,z in q:
   for dx,dy,dz in ((1,0,0),(-1,0,0),(0,1,0),(0,-1,0),(0,0,1),(0,0,-1)):
    k=(x+dx,y+dy,z+dz)
    if k in remaining:q.append(k);rows.append(remaining.pop(k))
  reach=min(rows,key=lambda r:r['walkSteps']);secs=reach['walkSteps']/4.317+len(rows)+2
  patches.append({'count':len(rows),'at':reach['at'],'walkSteps':reach['walkSteps'],'expectedIngots':len(rows)*4/9,'idealAccessAndMiningSeconds':secs,'idealIngotsPerMinute':len(rows)*4/9/secs*60})
 bastions=[]
 for b in s['bastions']:
  expectedChest=sum(loot.get(c.get('lootTable'),{}).get('expectedGoldIngots',0)for c in b['chests'])
  nearestGold=min(b['goldPositions'],key=lambda g:math.dist(g,s['portal'])) if b['goldPositions']else None
  # Euclidean distance is a lower bound on a supported walk, not a measured route.
  travel=math.dist(s['portal'],nearestGold)/4.317 if nearestGold else None
  ideal=(travel+b['actualGoldBlocks']) if travel is not None else None
  bastions.append({'type':b['type'],'bounds':b['bounds'],'goldBlocks':b['actualGoldBlocks'],'blockIngots':9*b['actualGoldBlocks'],'chests':len(b['chests']),'chestExpectedIngots':expectedChest,
   'closestGold':nearestGold,'straightLineAccessLowerBoundSeconds':travel,'blockMiningLowerBoundSeconds':b['actualGoldBlocks'],'optimisticBlockIngotsPerMinute':9*b['actualGoldBlocks']/ideal*60 if ideal else None})
 out.append({'seed':s['seed'],'oreCountMappedReachable':len(s['oreReachableByUnmodifiedWalking']),'oreExpectedIngots':len(s['oreReachableByUnmodifiedWalking'])*4/9,'nearestOrePatches':sorted(patches,key=lambda r:r['walkSteps'])[:8],'bastions':bastions})
result={'assumptions':{'walkingBlocksPerSecond':4.317,'ironPickBreakAndDelaySeconds':1,'oreNuggetsExpected':4,'pickupSecondsPerPatch':2},'limits':'Optimistic geometry/timing estimates for a player who already knows the route. Ore cluster estimates omit search, turns, other veins and hazards; the closest sight point need not see every cluster cell at once. Bastion figures omit safe access, wall removal, guarding mobs, chests, lava and collection, so are upper bounds on yield rate, NOT measured player yields. Actual body-window measurements are separate.','seeds':out}
(base/'source-prices.json').write_text(json.dumps(result,indent=2))
for r in out:print(r['seed'],'nearest ore',[(p['count'],p['walkSteps'],round(p['idealIngotsPerMinute'],1))for p in r['nearestOrePatches'][:3]],'bastions',[(b['type'],b['blockIngots'],round(b['chestExpectedIngots'],1))for b in r['bastions']])
