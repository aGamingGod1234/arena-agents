"""Read-only, streaming gold/barter/piglin scorer. RUN OUT [exported vanilla stats JSON]."""
import sys,json,pathlib,collections,re,datetime,math
run=pathlib.Path(sys.argv[1]);dest=pathlib.Path(sys.argv[2]);external=pathlib.Path(sys.argv[3])if len(sys.argv)>3 else None
weights={'minecraft:gold_ingot':1,'minecraft:gold_nugget':1/9,'minecraft:gold_block':9,'minecraft:raw_gold':1,'minecraft:raw_gold_block':9}
rows=lambda v:v if isinstance(v,list)else[]
obj=lambda v:v if isinstance(v,dict)else{}
commands={};terminals={};seen=collections.defaultdict(set);mobs=collections.defaultdict(set);targeting=collections.defaultdict(set);types={};admires=set();goldInventory=[];relevant=[];coverage=collections.Counter();lastSlot={};seenCells={};dimension=None;dimensionTimeline=[];t0=None;end=None;lastInv={};pearlMax=0
for n,line in enumerate(open(run/'quality-protocol.jsonl',errors='replace'),1):
 try:r=json.loads(line);e=r.get('envelope',{});p=obj(e.get('payload'));kind=e.get('type')
 except:coverage['invalidJson']+=1;continue
 if kind=='observation'and p.get('status')=='PLAYER_DEAD':lastInv={}
 if kind=='observation'and p.get('ready')and isinstance(p.get('inventory'),dict):
  at=p.get('observedAtEpochMs');
  if not isinstance(at,(int,float)):continue
  t0=t0 or at;end=at;minute=(at-t0)/60000;inv=collections.Counter();slots={}
  for i in rows(p['inventory'].get('items')):
   if not isinstance(i,dict):coverage['boundedInventoryRows']+=1;continue
   inv[i['itemId']]+=i.get('count',0);slots[i.get('slot')]=i.get('itemId')
  selected=obj(obj(p.get('interaction')).get('input')).get('selectedSlot')
  if isinstance(selected,int)and'mainhand'in slots:slots[selected]=slots['mainhand']
  worn=any(i.get('slot')in ('head','chest','legs','feet')and i.get('count',0)>0 and re.fullmatch('minecraft:golden_(helmet|chestplate|leggings|boots)',i.get('itemId',''))for i in rows(p['inventory'].get('items'))if isinstance(i,dict))
  gold=sum(inv[i]*w for i,w in weights.items());pearls=inv['minecraft:ender_pearl'];eyes=inv['minecraft:ender_eye'];pearlMax=max(pearlMax,pearls+eyes)
  state=(round(gold,3),pearls,eyes,worn)
  if not goldInventory or tuple(goldInventory[-1]['state'])!=state:goldInventory.append({'minute':round(minute,3),'at':at,'state':state})
  lastInv=dict(inv);lastSlot=slots
  dimension=obj(p.get('world')).get('dimension')
  if not dimensionTimeline or dimensionTimeline[-1]['dimension']!=dimension:dimensionTimeline.append({'at':at,'dimension':dimension})
  if not isinstance(p.get('world'),dict):coverage['boundedWorldRows']+=1
  for section in ('blocks','landmarks'):
   if not isinstance(p.get(section),list):coverage['boundedSourceSections']+=1
   for b in rows(p.get(section)):
    if not isinstance(b,dict):coverage['boundedBlockRows']+=1;continue
    seenCells[(dimension,b.get('x'),b.get('y'),b.get('z'))]=b.get('blockId')
    if re.search('gold|gilded|chest|barrel',b.get('blockId','')):seen[b['blockId']].add((dimension,b.get('x'),b.get('y'),b.get('z')))
  for en in rows(p.get('entities')):
   if not isinstance(en,dict):coverage['boundedEntityRows']+=1;continue
   ident=en.get('uuid',en.get('stableId'))
   for k in ('uuid','stableId'):
    if en.get(k):types[en[k]]=en.get('type')
   if re.search('piglin|enderman',en.get('type','')):
    mobs[en['type']].add(ident)
    if en.get('targetingAgent'):targeting[en['type']].add(ident)
  for ev in rows(obj(p.get('perception')).get('events')):
   if isinstance(ev,dict)and ev.get('soundId')=='minecraft:entity.piglin.admiring_item':admires.add((ev.get('sequence'),ev.get('gameTime')))
 elif kind=='action_command':
  commands[p['actionId']]={**p,'dimension':dimension,'minute':round((end-t0)/60000,3)if end and t0 else None,'seenBlockBefore':seenCells.get((dimension,obj(p.get('arguments')).get('x'),obj(p.get('arguments')).get('y'),obj(p.get('arguments')).get('z'))),'itemBefore':lastSlot.get(obj(p.get('arguments')).get('sourceSlot',obj(p.get('arguments')).get('slot','mainhand')))}
 elif kind=='action_result'and p.get('state')in ('SUCCEEDED','FAILED','TIMED_OUT','CANCELLED'):terminals[p['actionId']]=p
mined=collections.Counter();hands=offers=dropped=transferred=0;goldWork=[];profiles=collections.Counter()
for aid,c in commands.items():
 a=obj(c.get('arguments'));r=terminals.get(aid,{});typ=c.get('actionType');ok=r.get('state')=='SUCCEEDED'
 provenance=obj(c.get('provenance'));profiles[tuple(provenance.get(k)for k in ('provider','model','reasoningEffort','serviceTier'))]+=1
 bid=a.get('expectedBlockId')or c.get('seenBlockBefore')or''
 if typ=='break_block'and re.search('gold|gilded',bid)and ok:mined[bid]+=1
 if typ=='interact_entity'and(a.get('expectedItemId')=='minecraft:gold_ingot'or c.get('itemBefore')=='minecraft:gold_ingot')and types.get(a.get('targetId'))=='minecraft:piglin':offers+=1;hands+=int(ok)
 if typ=='drop_item'and(c.get('itemBefore')=='minecraft:gold_ingot'or a.get('itemId')=='minecraft:gold_ingot')and ok:dropped+=a.get('count',0)
 if typ=='transfer_container'and ok and r.get('reasonCode')=='TRANSACTION_CONFIRMED'and a.get('sourceKind')=='container'and a.get('destinationKind')=='player':transferred+=a.get('count',0)*weights.get(a.get('expectedItemId'),0)
 targetType=types.get(a.get('targetId'))
 piglinCombat=typ in ('attack','fight_target')and targetType in ('minecraft:piglin','minecraft:piglin_brute')
 guardedBlock=bool(re.search('gold|gilded|chest|barrel|shulker',bid))
 guardedAction=typ in ('break_block','interact_block','transfer_container')and guardedBlock
 if re.search('gold|piglin|barter',json.dumps(a))or piglinCombat or guardedAction:
  goldWork.append({'minute':c['minute'],'type':typ,'args':a,'dimension':c.get('dimension'),'targetType':targetType,'guardedAction':guardedAction,'state':r.get('state'),'reason':r.get('reasonCode'),'message':r.get('message')})
stats=[]
if external and external.exists():
 d=json.load(open(external,encoding='utf-8-sig'));stats=[obj(r).get('stats',{})for r in (d if isinstance(d,list)else[d])]
else:
 for f in (run/'server').glob('**/stats/*.json'):
  try:stats.append(json.load(open(f)).get('stats',{}))
  except:coverage['unreadableStats']+=1
statsMined=collections.Counter();picked=collections.Counter();killedBy=collections.Counter();killed=collections.Counter();deathsCounter=0
for s in stats:
 statsMined.update(s.get('minecraft:mined',{}));picked.update(s.get('minecraft:picked_up',{}));killedBy.update(s.get('minecraft:killed_by',{}));killed.update(s.get('minecraft:killed',{}));deathsCounter+=s.get('minecraft:custom',{}).get('minecraft:deaths',0)
deaths=[]
log=run/'logs/fabric.stdout.log'
if log.exists():
 for line in open(log,errors='replace'):
  m=re.search(r'\[(\d\d):(\d\d):(\d\d)\].*?\[Server thread/INFO\]: (\w+ (?:was |burned|fell|tried|died|drowned|hit|went|walked|blew|withered|starved|froze|suffocated|experienced|discovered).*)',line)
  if not m or not t0:continue
  dt=datetime.datetime.fromtimestamp(t0/1000).replace(hour=int(m[1]),minute=int(m[2]),second=int(m[3]),microsecond=0);at=dt.timestamp()*1000
  if at<t0-43200000:at+=86400000
  minute=(at-t0)/60000
  if -1<=minute<=((end-t0)/60000+1):
   living=next((r for r in reversed(goldInventory)if r['at']<=at),None)
   zombie='Zombified Piglin'in m[4];regular=not zombie and bool(re.search(r'\bPiglin\b(?! Brute)',m[4]));brute='Piglin Brute'in m[4]
   deathDimension=next((d['dimension']for d in reversed(dimensionTimeline)if d['at']<=at),None)
   recent=[a for a in goldWork if a['minute']is not None and minute-1<=a['minute']<=minute and(a['state']=='SUCCEEDED'or a.get('targetType')=='minecraft:piglin')]
   anger='zombified_piglin_separate_cause'if zombie else'not_piglin'if not(regular or brute)else'brute_ignores_gold'if brute else'no_gold_on_sight_or_anger'if not living or not living['state'][3]else'anger_consistent_guarded_action'if any(deathDimension and a.get('dimension')==deathDimension and(a.get('guardedAction')or a.get('targetType')=='minecraft:piglin')for a in recent)else'ordinary_piglin_with_gold_cause_unresolved'
   deaths.append({'minute':round(minute,3),'message':m[4],'goldWornLastChange':living['state'][3]if living else None,'piglinCause':anger,'dimension':deathDimension,'precedingGoldActions':recent})
sampleEnd=None;sampleMax=0;sampleDeaths=0
sampleFile=run/'quality-samples.jsonl'
if sampleFile.exists():
 for line in open(sampleFile,errors='replace'):
  try:sample=json.loads(line)
  except:continue
  sampleDeaths=max(sampleDeaths,sample.get('deathCounter')or 0)
  nbt=sample.get('inventoryNbt')
  if not isinstance(nbt,str):continue
  if not(nbt.startswith('[')and nbt.endswith(']')):coverage['invalidInventoryNbt']+=1;continue
  def count(item):return sum(int(n)for n in re.findall(r'count: (\d+), (?:Slot: -?\d+b, )?id: "minecraft:%s"'%item,nbt))
  sampleEnd={'at':sample.get('at'),'health':sample.get('health'),'pearls':count('ender_pearl'),'eyes':count('ender_eye'),'gold':count('gold_ingot')+9*count('gold_block')+count('gold_nugget')/9}
  sampleMax=max(sampleMax,sampleEnd['pearls']+sampleEnd['eyes'])
output={'run':str(run),'actionProfiles':[{'provider':k[0],'model':k[1],'effort':k[2],'serviceTier':k[3],'commands':n}for k,n in profiles.items()],'startMs':t0,'observedMinutes':round((end-t0)/60000,3)if t0 and end else None,'seen':{k:len(v)for k,v in seen.items()},'mobsSeen':{k:len(v)for k,v in mobs.items()},'mobsTargeting':{k:len(v)for k,v in targeting.items()},'explicitGoldMined':dict(mined),'vanillaGoldMined':{k:v for k,v in statsMined.items()if re.search('gold|gilded',k)},'vanillaGoldPickedUp':{k:v for k,v in picked.items()if 'gold'in k},'goldPickedUpIngots':sum(v*weights.get(k,0)for k,v in picked.items())if stats else None,'goldFromContainersIngots':transferred,'grossGoldGatheredIngots':sum(v*weights.get(k,0)for k,v in picked.items())+transferred if stats else None,'statsAvailable':bool(stats),'vanillaPearlsPickedUp':picked.get('minecraft:ender_pearl',0)if stats else None,'vanillaEndermenKilled':killed.get('minecraft:enderman',0)if stats else None,'goldHandoversOffered':offers,'goldHandoversSucceeded':hands,'ingotsDropped':dropped,'heardBarterStarts':len(admires),'endPearls':sampleEnd['pearls']if sampleEnd else lastInv.get('minecraft:ender_pearl',0),'endEyes':sampleEnd['eyes']if sampleEnd else lastInv.get('minecraft:ender_eye',0),'endHoldingsBasis':'last vanilla inventory sample'if sampleEnd else'last ready protocol inventory','sampleEnd':sampleEnd,'sampleDeaths':sampleDeaths,'pearlsEyesMax':max(pearlMax,sampleMax),'endGoldIngotsEquivalent':sampleEnd['gold']if sampleEnd else sum(lastInv.get(k,0)*w for k,w in weights.items()),'vanillaDeaths':deathsCounter if stats else None,'vanillaKilledBy':dict(killedBy),'deaths':deaths,'goldTimeline':goldInventory,'goldActions':goldWork,'coverage':dict(coverage),'notes':'Gross pickups include recovered own drops; starting /give and currency crafting are excluded. Gold mined is independent of pickups. Heard starts and handovers are not exact completed barters. Piglin anger classification is event-consistent, not a saved AI-memory proof; brute and naked aggression are separate. Bounded fields are counted as missing, not zero evidence.'}
dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(json.dumps(output,indent=2)+'\n');print(json.dumps({k:v for k,v in output.items()if k not in ('deaths','goldActions','goldTimeline','run')},indent=2))
