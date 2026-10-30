"""Derive currency prices from the exact server jar, without a model or live player input."""
import json,pathlib,sys,zipfile,hashlib
jar=pathlib.Path(sys.argv[1]);out=pathlib.Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
z=zipfile.ZipFile(jar)
def mean(v):
 if isinstance(v,(int,float)):return v
 if v.get('type')=='minecraft:uniform':return (v['min']+v['max'])/2
 raise ValueError(f'unsupported number provider: {v}')
def count(entry):
 value=1
 for f in entry.get('functions',[]):
  if f['function']=='minecraft:set_count':value=(value if f.get('add')else 0)+mean(f['count'])
 return value
weights={'minecraft:gold_block':9,'minecraft:gold_ingot':1,'minecraft:gold_nugget':1/9}
chests={}
for kind in ('other','hoglin_stable','bridge','treasure'):
 name='minecraft:chests/bastion_'+kind;table=json.loads(z.read('data/minecraft/loot_table/chests/bastion_'+kind+'.json'));expected=0
 for pool in table['pools']:
  # These tables use ordinary item/empty entries with zero quality and no currency conditions.
  total=sum(e.get('weight',1)for e in pool['entries'])
  for e in pool['entries']:
   if e.get('name')not in weights:continue
   if e.get('conditions')or e.get('quality',0):raise ValueError('conditional/quality currency needs explicit treatment')
   expected+=mean(pool['rolls'])*e.get('weight',1)/total*count(e)*weights[e['name']]
 chests[name]={'expectedGoldIngots':expected}
(out/'chest-odds.json').write_text(json.dumps(chests,indent=2)+'\n')
table=json.loads(z.read('data/minecraft/loot_table/gameplay/piglin_bartering.json'));entries=table['pools'][0]['entries'];total=sum(e.get('weight',1)for e in entries);pearl=next(e for e in entries if e.get('name')=='minecraft:ender_pearl');prob=pearl.get('weight',1)/total
f=next(f for f in pearl['functions']if f['function']=='minecraft:set_count')['count'];lo,hi=int(f['min']),int(f['max']);values=list(range(lo,hi+1));target=12
# Absorbing Markov chain: dp[k] is probability of currently having k (< target) pearls.
dp=[1.]+[0.]*(target-1);survival=[1.];quantiles={};examples=[]
for n in range(1,20001):
 nxt=[v*(1-prob)for v in dp]
 for k,v in enumerate(dp):
  for amount in values:
   if k+amount<target:nxt[k+amount]+=v*prob/len(values)
 dp=nxt;s=sum(dp);survival.append(s)
 for q in (.5,.8,.9,.95):
  if str(q)not in quantiles and 1-s>=q:quantiles[str(q)]=n
 if n in (64,128,188,225):examples.append({'ingots':n,'expectedPearls':n*prob*mean(f),'probabilityAtLeast12':1-s})
 if s<1e-15:break
result={'vanillaVersion':'26.1.2','weightTotal':total,'pearlEntry':pearl,'ingotsFor12ExpectedYield':target/(prob*mean(f)),'expectedIngotsUntilHoldingAtLeast12':sum(survival),'quantilesAtLeast12':quantiles,'examples':examples,'sourceJarSha256':hashlib.sha256(jar.read_bytes()).hexdigest(),'method':'Exact absorbing distribution; mean stopping time sums P(T>n); tail stops below 1e-15.'}
(out/'barter-odds.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items()if k not in ('pearlEntry','examples')},indent=2))
