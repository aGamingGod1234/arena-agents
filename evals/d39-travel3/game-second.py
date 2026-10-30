import datetime,hashlib,json,os,pathlib,subprocess,time
B=pathlib.Path('/home/agaminggod/Desktop/Projects/arena-beat-game');E=B/'evals/d39-travel3';A=json.loads((E/'artifact.json').read_text());ROOT=pathlib.Path(A['root']);W=pathlib.Path('/home/agaminggod/Desktop/Projects/aa-d39-travel3');results=json.loads((E/'before-admission-adjustment.json').read_text())['results']
def save(phase,**kw):
 d=dict(at=datetime.datetime.now(datetime.timezone.utc).isoformat(),phase=phase,results=results,**kw);p=E/'games-state.json';p.with_suffix('.tmp').write_text(json.dumps(d,indent=2));p.with_suffix('.tmp').replace(p)
try:
 for seed in ['987654321']:
  tag='d39-travel3-'+seed+'-r2';cp=B/f'long/checkpoints/9-nether-entry-{seed}-v2.json';out=B/f'sub/long/{tag}-codex'
  assert not out.exists(),f'Already exists: {out}'
  game=dict(tag=tag,machine='mini',sha=A['commit'],checkpoint=cp.name,minutes=90,arenaRoot=str(B),maxCost=1000,createdAt=time.time(),checkpointSha256=hashlib.sha256(cp.read_bytes()).hexdigest())
  (E/f'{tag}-manifest.json').write_text(json.dumps(game,indent=2));save('WAITING_OR_PLAYING',tag=tag)
  env=os.environ.copy();env.update(EFFORT='low',MODEL='gpt-6.1-sol',MAX_COST='1000',CHECKPOINT=str(cp),BASH_ENV='/tmp/d39-travel3/slot-env.sh')
  rc=subprocess.run([str(B/'api/long-sub.sh'),tag,A['jar'],str(ROOT),'codex','90'],env=env).returncode
  j=json.loads((out/'long-run.json').read_text());t=j['timeline'];assert j['profile']==dict(provider='codex',model='gpt-6.1-sol',reasoningEffort='low',serviceTier='default')
  assert j['build']['jar']['sha256']==A['jarSha256']
  protocol=pathlib.Path(j['artifacts'])/'quality-protocol.jsonl';assert protocol.is_relative_to(ROOT/'runtime/headless-runs')
  metrics=E/f'{tag}-nether.json'
  subprocess.run(['node',str(W/'scripts/quality/nether-travel-metrics.mjs'),str(protocol),str(metrics),str(t['startedAt']),str(t['endedAt'])],check=True)
  subprocess.run(['node','/home/agaminggod/Desktop/Projects/aa-d39-games/scripts/quality/d39-game-score.mjs',str(E/f'{tag}-manifest.json'),str(E/f'{tag}-score.json')],check=True)
  r=dict(seed=seed,tag=tag,nativeExitCode=rc,playedMinutes=t['playedMs']/60000,stopReason=t['stopReason'],measurementStatus=j.get('measurementStatus'),observerErrors=j.get('observerErrors'),artifacts=j['artifacts'],metrics=json.loads(metrics.read_text()),score=json.loads((E/f'{tag}-score.json').read_text()))
  results.append(r);save('COLLECTED',tag=tag)
  if t['playedMs']<89*60000 and not t.get('authoritativeDragon'):raise RuntimeError('Early ending requires inspection; no automatic outcome resampling')
 save('COMPLETE');(E/'games.done').write_text(datetime.datetime.now().isoformat())
except Exception as ex:
 save('REQUIRES_INSPECTION',error=str(ex));raise
