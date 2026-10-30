"""Freeze recorded queue gold turns before any decision model calls; one best eligible moment per seed."""
import json,pathlib,collections,math,hashlib,copy
B=pathlib.Path('/home/agaminggod/Desktop/Projects/arena-beat-game');R=pathlib.Path('/home/agaminggod/Desktop/Projects/aa-d39-pearls4');O=B/'evals/d39-pearls4'
old=json.load(open(R/'coordinator/test/fixtures/decision-eval/extra/d31-pearls.json'))['cases'];cases=[]
for summary in sorted(O.glob('d39-nether-entry-*-codex.json')):
 d=json.load(open(summary));run=pathlib.Path(d['run']);prev=collections.deque(maxlen=8);best=None;score=-1;initial=None
 for l in open(run/'provider-turns.private.jsonl'):
  r=json.loads(l)
  if r.get('output'):
   try:v=json.loads(r['output'])
   except:continue
   if v.get('plan') and v.get('predicate'):initial=v;break
 for n,l in enumerate(open(run/'quality-protocol.jsonl'),1):
  try:r=json.loads(l);e=r.get('envelope',{});p=e.get('payload',{})
  except:continue
  if e.get('type')!='observation' or not p.get('ready'):continue
  if not isinstance(p.get('world'),dict) or not isinstance(p.get('inventory'),dict) or not isinstance(p.get('blocks'),list) or not isinstance(p.get('landmarks'),list):continue
  pos=p.get('position',{});hp=p.get('player',{}).get('health',0);inv=p['inventory'].get('items',[]);entities=p.get('entities',[])
  if not isinstance(entities,list):continue
  rows=[b for b in p['blocks']+p['landmarks'] if isinstance(b,dict) and b.get('blockId')=='minecraft:nether_gold_ore']
  rows=[b for b in rows if math.dist([b[k]+.5 for k in ('x','y','z')],[pos.get('x',0),pos.get('y',0)+1.62,pos.get('z',0)])<=6]
  healthy=hp>=18 and not p.get('player',{}).get('inLava') and not p.get('player',{}).get('onFire')
  equipped=any(i.get('itemId')=='minecraft:iron_pickaxe' for i in inv) and any(i.get('slot')in ('head','chest','legs','feet') and i.get('itemId','').startswith('minecraft:golden_')for i in inv)
  danger=any(en.get('targetingAgent')and en.get('distance',999)<12 for en in entities if isinstance(en,dict))
  if rows and healthy and equipped and not danger and p['world'].get('dimension')=='minecraft:the_nether':
   dist=min(math.dist([b[k]+.5 for k in ('x','y','z')],[pos['x'],pos['y']+1.62,pos['z']])for b in rows);sc=len(rows)*2-dist
   if sc>score:best=(n,p,list(prev),rows);score=sc
  prev.append(p)
 if not best:print('NO_ELIGIBLE',d['tag']);continue
 n,p,previous,rows=best
 agent=copy.deepcopy(old[0]['state']['agent']);agent['goal']='Beat the game: defeat the Ender Dragon.';agent['goalSpec']=copy.deepcopy(old[0]['state']['agent']['goalSpec']);agent['taskPlan']=initial['plan'] if initial else agent['taskPlan'];agent['recentResults']=[];agent['intent']=None;agent['taskMemory']=None
 case={'id':'d39p4-'+d['tag'].removeprefix('d39-nether-entry-').removesuffix('-codex'),'family':'d39-gold','causeClass':'seen-gold-budget','split':'heldout','quick':False,
  'rationale':'Recorded healthy equipped Nether turn with visible nearby ore; compare partial gold work against generic travel. The initial game plan is frozen; checks are re-evaluated by the production renderer.',
  'source':{'trace':str(run.relative_to(B)) if run.is_relative_to(B) else run.name,'line':n,'atMs':p['observedAtEpochMs'],'observationSha256':hashlib.sha256(json.dumps(p,sort_keys=True).encode()).hexdigest(),'taskPlan':'initial goal compiler plan, not an invented gold-specific plan'},
  'state':{'observation':p,'previousObservations':previous,'agent':agent,'wakeReason':'attention'},
  'expect':{'judge':{'rubric':'The goal is to beat the game; pearls remain unmet. Judge the recorded observation and actual tools. Good: concrete harvesting or a safe supported approach to the seen ore patch, collecting its gold drops, crafting held nuggets to ingots, or bartering held ingots with an observed calm adult piglin. Gold is partial progress, not a guarantee of 12 pearls. A concrete visible/audible piglin or route danger justifies declining that patch when the answer commits to another feasible pearl source; never demand mining through a real danger. Immediate danger handling takes priority. Neutral: reads, a general statement or tool selection alone, continuing unrelated fortress travel, vague exploration without gold access. Bad: claiming enough pearls without evidence, attacking neutral piglins, mining guarded gold despite a piglin within 16 or a close piglin sound without addressing anger; inventing buried blocks or an unseen route. Grade the next substantive action/intent; setup followed by a harvest program counts as that program.'},'threshold':.5}}
 cases.append(case);print(case['id'],'near ores',len(rows),'line',n,'at',p['position'])
# Six legacy gold/barter cases are reused regression evidence, not fresh holdout data.
for c in old:
 if c['id'] in ('d31-pearls-01','d31-pearls-02','d31-pearls-03','d31-pearls-05','d31-pearls-06','d31-pearls-07'):
  c=copy.deepcopy(c);c['split']='heldout';cases.append(c)
# Reused guard/seen-block cases exercise safety and actual bastion sources.
prior=json.load(open(B/'evals/d38-pearls/new-cases.json'))
for c in prior.get('cases',[]):
 if c['id'] in ('d38-pearls-seen-unmined','d38-pearls-unseen-piglins'):
  c=copy.deepcopy(c);c['split']='heldout';cases.append(c)
f=O/'cases.json';f.write_text(json.dumps({'family':'d39-gold','cases':cases},indent=2));print('frozen',len(cases),'cases')
