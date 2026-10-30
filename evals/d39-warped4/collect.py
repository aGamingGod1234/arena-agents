"""Collect only operator measurements and safe player-profile fields; never copy credentials or provider inputs."""
import collections,datetime,json,pathlib,subprocess,sys
A=pathlib.Path(sys.argv[1]);H=pathlib.Path(__file__).resolve().parents[2];B=A.parent.parent
load=lambda p:json.loads(p.read_text())
physical=[]
for p in sorted([*(A/'physical').glob('*/result.json'),*(A/'physical2').glob('*/result.json')]):
 r=load(p);physical.append({'trial':f'{p.parent.parent.name}/{p.parent.name}',**{k:r.get(k)for k in ['cover','fights','seed','repeat','requestedGameTicks','elapsedGameTicks','completedWindow','error','dead','coverBuilt','coverBuiltAfterSeconds','sightings','endermenKilled','pearlsPickedUp','endPearls','deaths','wallSeconds','controllerSha256','jarSha256','checkpointSha256']}})
groups=[]
for seed in ['123456789','8675309','987654321','20261024']:
 rows=[r for r in physical if str(r['seed'])==seed and r['completedWindow']and not r['error']and r['requestedGameTicks']==24000]
 groups.append({'seed':seed,'n':len(rows),'pearlsRetainedPer20MinuteOpportunity':sum(r['endPearls']for r in rows)/len(rows)if rows else None,'pearlsPickedUpPer20MinuteOpportunity':sum(r['pearlsPickedUp']for r in rows)/len(rows)if rows else None,'endermenKilled':sum(r['endermenKilled']for r in rows),'deaths':sum(r['deaths']for r in rows)})
games=[];scores=A/'scores';scores.mkdir(exist_ok=True)
for p in sorted((B/'sub/long').glob('d39-warped4-*-codex/long-run.json')):
 r=load(p);tag=p.parent.name
 if not p.parent.with_name(tag+'.done').exists():
  games.append({'tag':tag,'seed':str(r.get('seed')),'valid':False,'ending':r.get('ending'),'status':'supervisor has not finished'});continue
 if not isinstance(r.get('artifacts'),str)or not(pathlib.Path(r['artifacts'])/'quality-protocol.jsonl').exists():
  games.append({'tag':tag,'seed':str(r.get('seed')),'valid':False,'ending':r.get('ending'),'status':'preflight or gameplay evidence unavailable'});continue
 run=pathlib.Path(r['artifacts']);void=p.parent.with_name(tag+'.void.json').exists();monitorError=p.parent.with_name(tag+'.monitor-error.json').exists()
 scoreFile=scores/(tag+'.json')
 if not scoreFile.exists():subprocess.run([sys.executable,str(H/'evals/d39-pearls4/score.py'),str(run),str(scoreFile)],stdout=subprocess.DEVNULL,check=True)
 m=load(scoreFile);profiles=collections.Counter();turns=0;player=(r.get('profile')or{}).get('model')
 audit=run/'provider-turns.private.jsonl'
 if audit.exists():
  for line in audit.open():
   try:t=json.loads(line)
   except ValueError:continue
   # Player turns run on the native thread; side calls (observer, summaries) have no threadId and may share the model.
   if t.get('model')!=player or not t.get('threadId'):continue
   turns+=1;s=t.get('executionSettings')or{};effective=s.get('effective')or{};evidence=s.get('evidence')or{}
   profiles[(t.get('model'),t.get('reasoningEffort'),(s.get('requested')or{}).get('serviceTier'),effective.get('model'),effective.get('serviceTier'),evidence.get('model'),evidence.get('serviceTier'))]+=1
 profileRows=[dict(zip(['model','effort','requestedTier','effectiveModel','effectiveTier','modelEvidence','tierEvidence'],key),turns=n)for key,n in profiles.items()]
 profileOk=bool(profileRows)and player in('gpt-6.1-sol','gpt-6-luna')and(r.get('profile')or{}).get('serviceTier')=='default'and all(p['effort']=='low'and p['requestedTier']=='default'and p['effectiveModel']==p['model']and p['effectiveTier']=='default'for p in profileRows)
 at=(r.get('ending')or{}).get('at');sample=(m.get('sampleEnd')or{}).get('at');age=(at-sample)/1000 if isinstance(at,(int,float))and isinstance(sample,(int,float))else None
 full=r.get('windowMs')==3600000 and(r.get('ending')or{}).get('reason')=='WALL_CLOCK_BUDGET'
 valid=full and not void and not monitorError and profileOk and age is not None and abs(age)<=15
 g={'tag':tag,'model':player,'seed':str(r.get('seed')),'ending':r.get('ending'),'voidByProviderStall':void,'monitorError':monitorError,'completed60Minutes':full,'valid':valid,'turns':turns,'profiles':profileRows,'endingSampleAgeSeconds':age,'pearlsHeld':m.get('endPearls')if valid else None,'pearlsPickedUp':m.get('vanillaPearlsPickedUp')if valid else None,'endermenKilled':m.get('vanillaEndermenKilled')if valid else None,'deaths':m.get('vanillaDeaths')if valid else None,'minutesPerRetainedPearl':60/m['endPearls']if valid and m.get('endPearls',0)>0 else None,'score':str(scoreFile.relative_to(A))}
 games.append(g)
probes=[]
for p in sorted((A/'probes').glob('*.json')):
 r=load(p);probes.append({k:r.get(k)for k in ['at','model','effort','serviceTier','fastServiceRequested','launcher','observedModel','observedServiceTier','responseMs','passed','failure']})
gates={}
for name in ['gradle','npm-test','contracts']:
 p=A/(name+'.exit');gates[name]=int(p.read_text().strip())if p.exists()else None
report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'survey':load(A/'survey/survey-results.json'),'physical':physical,'physicalGroups':groups,'games':games,'probes':probes,'gates':gates,'physicalCoverageComplete':all(g['n']>=3 for g in groups),'liveCoverageComplete':len([g for g in games if g['valid']])>=3,'notes':['Operator locate output never enters player observations, memory or instructions.','No travel-to-forest performance or safety is established.','Deaths truncate model-free trials and score zero retained pearls in a twenty-minute opportunity; no survivor-rate extrapolation.','Sol games use a sixty-minute wall-clock budget and a beat-game goal with pearl gathering as its next stage.','Minutes per retained pearl is the full sixty-minute budget divided by ending holdings; zero holdings have no finite rate.','Unrun, preflight-failed, void and stale-inventory outcomes are unavailable, not zero-pearl games.']}
(A/'measurements.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'physicalValid':sum(g['n']for g in groups),'validSolGames':sum(g['valid']for g in games),'probesPassed':sum(bool(r.get('passed'))for r in probes),'gates':gates}))
