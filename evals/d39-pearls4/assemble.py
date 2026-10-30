"""Assemble scores from allowlisted exports; no provider inputs or credentials are copied."""
import collections,datetime,hashlib,json,math,pathlib,re,subprocess,sys
A=pathlib.Path(sys.argv[1]);B=A.parent.parent;Desk=A/(sys.argv[3]if len(sys.argv)>3 else'evidence-final');out=pathlib.Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
load=lambda p:json.loads(p.read_text(encoding='utf-8-sig'))
restart=load(A/'restart-void.json')if(A/'restart-void.json').exists()else{}
stop=load(A/'desktop-stop-void.json')if(A/'desktop-stop-void.json').exists()else{}
stall=load(A/'sol-stall-void.json')if(A/'sol-stall-void.json').exists()else{}
stallTags=set(stall.get('voidCandidateTags',[])+stall.get('voidQueueTags',[]))
voidTags=set(restart.get('voidCandidateTags',[])+stop.get('voidCandidateTags',[])+stop.get('voidQueueTags',[]))|stallTags
def ms(value):
 if isinstance(value,(int,float)):return value if value>1e12 else value*1000
 if isinstance(value,str):
  try:return datetime.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()*1000
  except ValueError:return None
 return None
restartAt=ms(restart.get('effectiveAt')or restart.get('noticeAt'))
launches={}
if(Desk/'launches.jsonl').exists():
 for line in open(Desk/'launches.jsonl',encoding='utf-8-sig'):
  r=json.loads(line);launches[r['job']]=r
def leaf(value):return pathlib.PureWindowsPath(value).name if '\\'in value else pathlib.Path(value).name
summaries={}
def loadSummary(p):
 try:return load(p)
 except(json.JSONDecodeError,UnicodeDecodeError):return {'summaryMissingReason':'Incomplete summary JSON'}
for p in (Desk/'summaries').glob('*.json'):summaries[p.stem.removesuffix('-codex')]=loadSummary(p)
for p in (B/'sub/long').glob('d39-*-codex/long-run.json'):
 if not p.parent.name.startswith(('d39-nether-','d39-pearls4-')):continue
 r=loadSummary(p);r['run']=leaf(r.get('artifacts',''));summaries.setdefault(p.parent.name.removesuffix('-codex'),r)
if(Desk/'game-bindings.json').exists():
 for r in load(Desk/'game-bindings.json'):summaries.setdefault(r['tag'],{}).setdefault('run',r['run'])
for tag in voidTags:summaries.setdefault(tag,{})
for tag,name in restart.get('voidCandidateRuns',{}).items():summaries[tag].setdefault('run',name)
queue={}
for line in open(B/'evals/d39-games/results.jsonl'):
 r=json.loads(line)
 if 'nether' in r.get('tag',''):queue[r['tag']]=r
states={r['tag']:r for r in load(B/'evals/d39-games/state.json')['games']if 'nether'in r['tag']}
index={}
for root in (Desk,A/'evidence-mini-final'):
 for p in root.glob('**/manifest.json'):
  r=load(p);index[r['run']]={'manifest':r,'directory':p.parent,'bucket':p.relative_to(root).parts[0]}
bindings={r.get('run'):tag for tag,r in summaries.items()if r.get('run')}
# Older exports retained the exact game/run binding before queue rotation.
if (A/'queue-summary.json').exists():
 for r in load(A/'queue-summary.json'):bindings.setdefault(leaf(r['run']),r['tag'].removesuffix('-codex'))
metrics={};score=pathlib.Path(__file__).with_name('score.py');dest=A/'metrics-final';dest.mkdir(exist_ok=True)
for name,row in sorted(index.items()):
 run=row['directory']/'run';target=dest/(name+'.json');args=[sys.executable,str(score),str(run),str(target)]
 tag=bindings.get(name);fallback=A/(str(tag)+'.json')
 if tag in voidTags:
  metrics[name]={'void':True,'reason':'Sol provider stall'if tag in stallTags else'User-directed Desktop interruption'};target.write_text(json.dumps(metrics[name],indent=2)+'\n');continue
 if not list((run/'server').glob('**/stats/*.json'))and fallback.exists():args.append(str(fallback))
 result=subprocess.run(args,capture_output=True,text=True)
 if result.returncode:raise RuntimeError(f'Score failed for {name}: {result.stderr[-400:]}')
 metrics[name]=load(target)
def checkpointSeed(state):
 name=state.get('checkpoint')
 if not isinstance(name,str):return None
 p=B/'long/checkpoints'/pathlib.Path(name).name
 return load(p).get('seed')if p.exists()else None
def game(tag,summary,official=None,state=None):
 official=official or{};state=state or{};name=summary.get('run');row=index.get(name,{});m=metrics.get(name,{});manifest=row.get('manifest',{});hasData=m.get('startMs')is not None
 ending=official.get('ending')or summary.get('ending')or{'kind':'ongoing'if state.get('state')in ('running','launching')else'unknown'}
 machine=official.get('machine')or state.get('machine')or('mini'if tag.endswith('-mini')else'desktop')
 launched=ms(official.get('launchedAt')or state.get('launchedAt'))
 finished=ms(ending.get('at'))or ms(summary.get('capturedAt'))or ms(official.get('scoredAt'))
 desktopVoid=tag in voidTags-stallTags or(restartAt is not None and machine=='desktop'and launched is not None and launched<restartAt and(finished is None or finished>restartAt))
 void=desktopVoid or tag in stallTags
 full=not void and ending.get('reason')=='WALL_CLOCK_BUDGET'and summary.get('windowMs',5400000)==5400000 and hasData and manifest.get('playerTurns',0)>0
 sampled=m.get('sampleEnd')or{};endAt=ending.get('at');age=(endAt-sampled['at'])/1000 if isinstance(endAt,(int,float))and isinstance(sampled.get('at'),(int,float))else None
 result={'tag':tag,'run':name,'voidByDesktopInterruption':desktopVoid,'voidBySolStall':tag in stallTags,'planningTimeouts':manifest.get('planningTimeouts',[]),'seed':str(summary.get('seed') or checkpointSeed(state)or manifest.get('seed')or(tag.split('-')[2]if tag.startswith('d39-pearls4-')else None)),'build':official.get('build')or state.get('sha')or(summary.get('build')or{}).get('commit')or('af6f3f0958614ac6401709ba2e3f1fe62399f5c2'if tag.startswith('d39-pearls4-')else None),'machine':machine,'ending':ending,'completed90Minutes':full,'officialObservedMinutes':official.get('observedMinutes'),'rawObservedMinutes':m.get('observedMinutes'),'grossGoldIngots':m.get('grossGoldGatheredIngots')if hasData else None,'minedGold':m.get('vanillaGoldMined')if hasData else None,'endGoldIngots':m.get('endGoldIngotsEquivalent')if hasData else None,'endPearls':m.get('endPearls')if hasData else None,'endEyes':m.get('endEyes')if hasData else None,'peakPearlsEyes':m.get('pearlsEyesMax')if hasData else None,'vanillaPearlPickups':m.get('vanillaPearlsPickedUp')if hasData else None,'endermenKilled':m.get('vanillaEndermenKilled')if hasData else None,'lastInventorySampleAgeSeconds':age,'endInventoryCurrent':age is not None and abs(age)<=15,'handovers':m.get('goldHandoversSucceeded')if hasData else None,'droppedIngots':m.get('ingotsDropped')if hasData else None,'heardBarterStarts':m.get('heardBarterStarts')if hasData else None,'deaths':m.get('vanillaDeaths')if m.get('statsAvailable')else m.get('sampleDeaths')if hasData else None,'piglinDeathEvidence':collections.Counter(d.get('piglinCause')for d in m.get('deaths',[])if'Piglin'in d.get('message','')),'avatarGoldSightings':{k:v for k,v in m.get('seen',{}).items()if'gold'in k or'gilded'in k},'turns':manifest.get('playerTurns'),'turnsWithSeenGoldFact':manifest.get('playerTurnsWithSeenGoldFact'),'explicitWakeGoldCells':manifest.get('goldCellsExplicitInWakeInputs'),'profiles':manifest.get('playerProfiles'),'coverage':m.get('coverage'),'metricFile':name+'.json'if name else None}
 if void:
  for key in ('grossGoldIngots','minedGold','endGoldIngots','endPearls','endEyes','peakPearlsEyes','vanillaPearlPickups','endermenKilled','handovers','droppedIngots','heardBarterStarts','deaths','piglinDeathEvidence','avatarGoldSightings','turns','turnsWithSeenGoldFact','explicitWakeGoldCells'):result[key]=None
  result['ending']={'kind':'void','reason':'Sol provider stall'if tag in stallTags else'User-directed Desktop interruption'}
 return result
queueRows=[game(tag,summaries.get(tag,{}),queue.get(tag),states.get(tag))for tag in sorted(set(queue)|set(states),key=lambda t:int(t.rsplit('-',1)[-1]))]
candidates=[game(tag,r)for tag,r in sorted(summaries.items())if tag.startswith('d39-pearls4-')]
physical=[]
for p in [*(Desk/'physical').glob('*/*/result.json'),*(A/'physical-mini').glob('*/*/result.json')]:
 machine='mini'if p.is_relative_to(A/'physical-mini')else'desktop'
 try:r=load(p)
 except(json.JSONDecodeError,UnicodeDecodeError):r={'error':'Incomplete result JSON after interruption'}
 gold=r.get('ingotsGained');job='physical-'+p.parent.parent.name+'-'+p.parent.name
 launch=launches.get(job,{});receipt=Desk/'launch-receipts'/f'{job}.done';done=load(receipt)if receipt.exists()else{}
 began=ms(launch.get('at'));ended=ms(done.get('at'));void=machine=='desktop'and(p.parent.parent.name+'/'+p.parent.name in restart.get('voidPhysicalTrials',[])or(restartAt is not None and began is not None and began<restartAt and ended is not None and ended>restartAt))
 expectedSalt=int(re.search(r'-r([0-9]+)',p.parent.name)[1]);elapsed=r.get('elapsedSeconds');identityOk=r.get('salt')==expectedSalt and str(r.get('seed'))==p.parent.name.split('-r')[0]
 valid=not void and identityOk and not r.get('error')and isinstance(gold,(int,float))and math.isfinite(gold)and r.get('completedWindow')is True and isinstance(elapsed,(int,float))and 0<=elapsed<=665
 physical.append({'machine':machine,'arm':p.parent.parent.name,'trial':p.parent.name,'seed':str(r.get('seed')or p.parent.name.split('-r')[0]),'salt':r.get('salt'),'expectedSalt':expectedSalt,'identityOk':identityOk,'valid':valid,'voidByDesktopInterruption':void,'grossGoldIngots':None if void else gold,'securedNewGoldIngots':(0 if r.get('dead')else gold)if valid else None,'elapsedMinutes':r.get('elapsedSeconds',0)/60 if isinstance(r.get('elapsedSeconds'),(int,float))else None,'dead':r.get('dead'),'error':str(r.get('error','')).split('\n')[0]if r.get('error')else None,'controllerSha256':r.get('controllerSha256'),'jarSha256':r.get('jarSha256'),'mined':r.get('mined')})
# Freeze a host-matched primary matrix before replacement outcomes are observed.
# Extra retained candidate salt-2 Desktop runs stay supplementary when its base is repeated on Mini.
miniPairs={('8675309',3),('987654321',2),('987654321',3),('20261024',2),('20261024',3)}
for p in physical:
 wanted='mini'if(p['seed'],p['salt'])in miniPairs else'desktop'
 p['primary']=p['valid']and p['machine']==wanted
attempts=[]
for job,launch in sorted(launches.items()):
 if not job.startswith('physical-'):continue
 receipt=Desk/'launch-receipts'/f'{job}.done';done=load(receipt)if receipt.exists()else{}
 match=next((p for p in physical if job=='physical-'+p['arm']+'-'+p['trial']),None)
 attempts.append({'job':job,'machine':'desktop','launchedAt':launch.get('at'),'capturedCompletionReceiptAt':done.get('at'),'exit':done.get('exit'),'resultCaptured':match is not None,'validCapturedResult':bool(match and match['valid']),'note':'No receipt in an older snapshot is incomplete capture, not proof of active gameplay at the later interruption.'if not done else None})
groups=[]
for seed in ('123456789','8675309','987654321','20261024'):
 for arm in ('base','candidate'):
  rows=[r for r in physical if r['seed']==seed and r['arm']==arm and r['primary']];n=len(rows)
  groups.append({'seed':seed,'arm':arm,'n':n,'salts':sorted(r['salt']for r in rows),'grossMeanPerOpportunity':sum(r['grossGoldIngots']for r in rows)/n if n else None,'securedMeanPerOpportunity':sum(r['securedNewGoldIngots']for r in rows)/n if n else None,'deaths':sum(bool(r['dead'])for r in rows)})
def decision(name):
 r=load(A/name/'screen/report.json');o=r['overall'];return{'verdict':r['verdict'],'baseGood':o['baseline']['good'],'candidateGood':o['candidate']['good'],'baseN':o['baseline']['n'],'candidateN':o['candidate']['n'],'noContinuationCases':r.get('continuationCoverage'),'uninformativeCases':len(r.get('uninformativeCases',[]))}
report={'assembledAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'physical':physical,'physicalLaunchReceipts':attempts,'physicalGroups':groups,'primaryPhysicalPolicy':'For both arms, Mini PC for 8675309 salt 3; 987654321 salts 2,3; 20261024 salts 2,3. Desktop for the other seven seed/salt pairs. Other valid retained runs are supplementary.','candidateGames':candidates,'queueGames':queueRows,'normalDecision':decision('decision-normal'),'diagnosticDecision':decision('decision-final'),'desktopInterruption':stop,'solStallInterruption':stall,'notes':['Gross live pickups can include recovered own drops; initial /give and crafting are excluded.','Dead physical attempts end early and score zero secured gold in a ten-minute opportunity; gross is not extrapolated.','The fact-only change cannot affect the identical model-free controller; numerical body differences are stochastic controls.','Queued/preflight/failed games are not completed 90-minute controls; final inventory is unverified when its sample is stale.','Explicit delivered wake gold cells omit tool replies and retained-view reconstruction; avatar visibility and delivery are separate counts.']}
(out/'measurements.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'physicalValid':sum(r['valid']for r in physical),'physicalPrimary':sum(r['primary']for r in physical),'physicalInvalid':sum(not r['valid']for r in physical),'candidateCompleted90':sum(r['completed90Minutes']for r in candidates),'queueGames':len(queueRows),'queueCompleted90':sum(r['completed90Minutes']for r in queueRows)}))
