"""Condense actual player-visible gold moments and following choices from gameplay-only exports."""
import collections,json,pathlib,sys
A=pathlib.Path(sys.argv[1]);scores=A/'metrics-final';out=[]
measurements=json.load(open(sys.argv[2]))
for game in measurements['queueGames']:
 if game.get('voidByDesktopInterruption')or game.get('voidBySolStall')or not game.get('metricFile'):continue
 m=json.load(open(scores/game['metricFile']));run=pathlib.Path(m['run']);types=collections.Counter();first=None;following=[];commands=[];t0=m['startMs']
 for line in open(run/'quality-protocol.jsonl'):
  try:e=json.loads(line)['envelope'];p=e.get('payload',{})
  except (ValueError,KeyError):continue
  if e['type']=='observation'and p.get('ready')and first is None:
   cells=[b for section in ('blocks','landmarks')for b in (p.get(section)if isinstance(p.get(section),list)else[])if isinstance(b,dict)and b.get('blockId')in ('minecraft:gold_block','minecraft:nether_gold_ore')]
   if cells:first={'minute':round((p['observedAtEpochMs']-t0)/60000,3),'position':p.get('position'),'cells':[{k:b.get(k)for k in ('blockId','x','y','z')}for b in cells]}
  if e['type']=='action_command':
   typ=p.get('actionType');types[typ]+=1
   if first and len(following)<8:following.append({'type':typ,'arguments':p.get('arguments')})
 out.append({'tag':game['tag'],'firstRecordedGoldView':first,'nextCommands':following,'actionCounts':dict(types),'goldActions':m['goldActions'],'goldMined':m['vanillaGoldMined'],'goldPickedUp':m['vanillaGoldPickedUp'],'deaths':m['deaths'],'coverage':m['coverage']})
pathlib.Path(sys.argv[3]).write_text(json.dumps(out,indent=2)+'\n')
for g in out:print(g['tag'],g['actionCounts'],[c['type']for c in g['nextCommands']])
