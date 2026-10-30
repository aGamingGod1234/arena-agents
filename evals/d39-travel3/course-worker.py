import json,os,pathlib,subprocess,time,threading,datetime,hashlib
B=pathlib.Path('/home/agaminggod/Desktop/Projects/arena-beat-game'); E=B/'evals/d39-travel3'; W=pathlib.Path('/home/agaminggod/Desktop/Projects/aa-d39-travel3')
manifest=json.loads((E/'artifact.json').read_text())
state=dict(runtimeHead=manifest['commit'],protocol='Six substantive original travel courses, fresh base 4682f12e and candidate arms, same Mini PC worker, CPU quota 400%, JVM ActiveProcessorCount=4. Odd pairs base first, even pairs candidate first. No outcome resampling.',pairs=[])
def save():
 p=E/'course-state.json';p.with_suffix('.tmp').write_text(json.dumps(state,indent=2));p.with_suffix('.tmp').replace(p)
def cpu():
 a=list(map(int,pathlib.Path('/proc/stat').read_text().splitlines()[0].split()[1:]));return sum(a),a[3]+a[4]
env=os.environ.copy();env.update(JAVA_HOME='/usr/lib/jvm/temurin-25-jdk-amd64',ARENA_HEADLESS_SERVER_TEMPLATE='/home/agaminggod/.t3/worktrees/agents arena/t3-ba7399a1/runtime/server-template',REPLAY_JAVA_OPTS='-XX:ActiveProcessorCount=4')
ids=['entry9-fortress','y55-fortress','high110-fortress','entry9-east300','gold2-north300','fortress3-bastion']
for i,c in enumerate(ids,1):
 pair=dict(pair=i,run=1,courseId=c,state='RUNNING',attempts=[dict(index=1,state='RUNNING')]);state['pairs'].append(pair);save();a=pair['attempts'][0]
 for arm in (['base','candidate'] if i%2 else ['candidate','base']):
  out=E/f'courses/pair-{i}-{arm}';out.parent.mkdir(parents=True,exist_ok=True)
  jar=B/'jars/d25-4682f12e.jar' if arm=='base' else pathlib.Path(manifest['jar'])
  samples=[];stop=threading.Event()
  def sample():
   prev=cpu()
   while not stop.wait(2):
    cur=cpu();d=cur[0]-prev[0];samples.append((time.time()*1000,100*(1-(cur[1]-prev[1])/d) if d else 0));prev=cur
  t=threading.Thread(target=sample);t.start();started=time.time()
  with (E/f'courses/pair-{i}-{arm}.log').open('w') as log:
   rc=subprocess.run([str(B/'slot.sh'),'live','node','scripts/quality/test-travel-live.mjs','scripts/quality/travel-courses.json',str(out),'--mode','travel','--jar',str(jar),'--only',c],cwd=W,env=env,stdout=log,stderr=subprocess.STDOUT).returncode
  stop.set();t.join()
  data=json.loads((out/'results.json').read_text()) if (out/'results.json').exists() else {}
  run=data.get('results',[{}])[0]
  activeSamples=[value for at,value in samples if run.get('startedAtEpochMs',float('inf')) <= at <= run.get('endedAtEpochMs',float('-inf'))]
  meta=dict(out=str(out),exitCode=rc,host='minipc',cpuCount=4,cpuQuota='400%',jvmActiveProcessorCount=4,hostCpu=dict(mean=sum(activeSamples)/len(activeSamples) if activeSamples else None,max=max(activeSamples) if activeSamples else None,samples=len(activeSamples),basis='host /proc/stat at 2-second cadence, only the measured course interval'),bootRequestedAt=started,endedAt=time.time(),jarSha256=hashlib.sha256(jar.read_bytes()).hexdigest())
  a[arm]=meta;save()
  if rc or len(data.get('results',[]))!=1 or data['results'][0].get('error'):
   pair['state']='FAILED';a['state']='FAILED';save();raise RuntimeError(f'{c} {arm} failed; evidence retained, no automatic resampling')
 a['state']='COMPLETE';pair.update(state='COMPLETE',acceptedAttempt=1,loadFlags=[]);save()
subprocess.run(['node',str(W/'scripts/quality/summarize-travel-pairs.mjs'),str(E/'course-state.json'),str(E/'course-summary.json')],check=True)
(E/'courses.done').write_text(datetime.datetime.now().isoformat())
