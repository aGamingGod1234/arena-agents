import json,pathlib,subprocess,shutil,collections,hashlib
B=pathlib.Path('/home/agaminggod/Desktop/Projects/arena-beat-game');E=B/'evals/d39-travel3';W=pathlib.Path('/home/agaminggod/Desktop/Projects/aa-d39-travel3')
assert (E/'courses.done').exists() and (E/'games.done').exists()
for path,expected in json.loads((E/'analysis-provenance.json').read_text())['files'].items():
 assert hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()==expected, 'Analysis source changed: '+path
state=json.loads((E/'course-state.json').read_text())
for p in state['pairs']:
 a=p['attempts'][0];b=a['base']['hostCpu']['mean'];c=a['candidate']['hostCpu']['mean']
 p['loadFlags']=['host mean CPU differs by over 15 percentage points'] if b is not None and c is not None and abs(b-c)>15 else []
(E/'course-state.json').write_text(json.dumps(state,indent=2))
subprocess.run(['node',str(W/'scripts/quality/summarize-travel-pairs.mjs'),str(E/'course-state.json'),str(E/'course-summary.json')],check=True)
c=json.loads((E/'course-summary.json').read_text())
c['samplingNotes']=state.get('samplingNotes',[])
c['d39Acceptance']=dict(sixMatchedPairs=c['acceptedPairs']>=6,paceGain=c['candidate']['pace']>c['base']['pace'],bothArmsZeroDeathsFireLava=all(c[a][k]==0 for a in ['base','candidate'] for k in ['deaths','fire','lava']))
reasons={arm:collections.Counter() for arm in ['base','candidate']}
for resultFile in (E/'courses').glob('pair-*/results.json'):
 arm='candidate' if 'candidate' in resultFile.parent.name else 'base'
 for stop in json.loads(resultFile.read_text())['results'][0]['stops']:reasons[arm][stop['reasonCode']]+=1
c['handbacks']={arm:dict(counts) for arm,counts in reasons.items()}
(E/'course-summary.json').write_text(json.dumps(c,indent=2))
bases=json.loads((E/'base-games.json').read_text());games=json.loads((E/'games-state.json').read_text())['results'];compare=[]
for candidate in games:
 seed=candidate['seed'];base=next(b for b in bases if b['score']['checkpoint']==f'9-nether-entry-{seed}-v2.json')
 report=json.loads((B/f'sub/long/{candidate["tag"]}-codex/long-run.json').read_text());artifact=json.loads((E/'artifact.json').read_text())
 assert report['build']['jar']['sha256']==artifact['jarSha256']
 assert report['build']['coordinatorSha256']==artifact['coordinatorNativeFingerprint']
 nativeRun=json.loads((B/f'sub/long/{candidate["tag"]}-codex/run/results.json').read_text())
 assert nativeRun['sourceChangedDuringRun'] is False
 assert str(nativeRun['runs'][0]['definition']['seed'])==seed
 t=report['timeline'];start=t['startedAt'];duration=base['score']['observedMinutes']
 fullEnd=min(t['endedAt'],start+report['windowMs'])
 if fullEnd != candidate['metrics']['playingWindow']['endedAt']:
  fullOut=E/f'{candidate["tag"]}-nether.json'
  subprocess.run(['node',str(W/'scripts/quality/nether-travel-metrics.mjs'),str(pathlib.Path(report['artifacts'])/'quality-protocol.jsonl'),str(fullOut),str(start),str(fullEnd)],check=True)
  candidate['metrics']=json.loads(fullOut.read_text())
 end=min(fullEnd,start+duration*60000)
 out=E/f'{candidate["tag"]}-common-nether.json'
 subprocess.run(['node',str(W/'scripts/quality/nether-travel-metrics.mjs'),str(pathlib.Path(report['artifacts'])/'quality-protocol.jsonl'),str(out),str(start),str(end)],check=True)
 common=json.loads(out.read_text());native=None
 sample=pathlib.Path(report['artifacts'])/'quality-samples.jsonl'
 if sample.exists():
  with sample.open() as f:
   for line in f:
    try:r=json.loads(line)
    except:continue
    if start<=r.get('at',-1)<=end and isinstance(r.get('deathCounter'),(int,float)):native=max(native or 0,r['deathCounter'])
 common['nativeDeaths']=native
 cm={k:(v if v and start<=v['at']<=end else None) for k,v in candidate['score']['milestones'].items()}
 compare.append(dict(seed=seed,baselineTag=base['tag'],baselineMachine=base['score']['machine'],baselineObservedMinutes=duration,base=base['metrics'],baseScore=base['score'],candidateTag=candidate['tag'],candidatePlayedMinutes=candidate['playedMinutes'],candidate=candidate['metrics'],candidateScore=candidate['score'],commonWindowMinutes=(end-start)/60000,candidateCommon=common,candidateCommonMilestones=cm))
(E/'game-comparison.json').write_text(json.dumps(compare,indent=2))
updatedState=json.loads((E/'games-state.json').read_text());updatedState['results']=games;(E/'games-state.json').write_text(json.dumps(updatedState,indent=2))
D=W/'evals/d39-travel3';D.mkdir(parents=True,exist_ok=True)
for file in ['artifact.json','resource-proof.json','void-d38-window.json','game-startup-void.json','admission-adjustment.json','admission-lock-check.json','fire-diagnostic-conclusion.json','course-state.json','course-summary.json','pair-provenance-check.json','analysis-provenance.json','base-games.json','baseline-native-identity.json','game-input-matching.json','game2-start-verification.json','admission-process-check.json','game-comparison.json','games-state.json']:
 shutil.copy2(E/file,D/file)
for file in E.glob('*-nether.json'):shutil.copy2(file,D/file.name)
for file in E.glob('*-score.json'):shutil.copy2(file,D/file.name)
for file in E.glob('*-manifest.json'):shutil.copy2(file,D/file.name)
for p in (E/'courses').glob('pair-*/results.json'):
 d=D/'courses'/p.parent.name;d.mkdir(parents=True,exist_ok=True);shutil.copy2(p,d/'results.json')
for file in ['course-worker.py','game-worker.py','game-second.py','wait-ports.py','slot-env.sh','finalize.py','render-report.py','collect.sh']:shutil.copy2(E/file,D/file)
print(json.dumps(dict(courseBase=c['base'],courseCandidate=c['candidate'],acceptance=c['d39Acceptance'],games=[dict(seed=r['seed'],baseBpm=r['base']['blocksPerNetherMinute'],candidateBpm=r['candidate']['blocksPerNetherMinute'],commonBpm=r['candidateCommon']['blocksPerNetherMinute'],baseDeaths=r['baseScore']['deaths'],candidateDeaths=r['candidateScore']['deaths']) for r in compare]),indent=2))
