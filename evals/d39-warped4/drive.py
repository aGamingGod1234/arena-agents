"""Durable operator-side sequencing. Never chooses gameplay actions or retries a broken physical trial."""
import datetime,hashlib,json,pathlib,subprocess,time
H=pathlib.Path('/home/agaminggod/Desktop/Projects/aa-d39-pearls4')
R=pathlib.Path('/home/agaminggod/Desktop/Projects/aa-d39-warped4-live')
B=pathlib.Path('/home/agaminggod/Desktop/Projects/arena-beat-game');A=B/'evals/d39-warped4'
load=lambda p:json.loads(p.read_text())
def state(stage,**fields):
 r={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'stage':stage,**fields};p=A/'driver-status.json';tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps(r,indent=2)+'\n');tmp.replace(p)
def unit(name):
 r=subprocess.run(['systemctl','--user','show',name,'-p','ActiveState','--value'],capture_output=True,text=True);return r.stdout.strip()
def launch(name,script,arg,log):
 if unit(name)in ('active','activating'):return
 subprocess.run(['systemd-run','--user','--collect','--unit',name,'-p','Nice=10','-p','IOSchedulingClass=idle','/bin/bash','-c',f'exec bash "{H/script}" {arg} > "{A/log}" 2>&1'],check=True)
def collect():subprocess.run(['python3',str(H/'evals/d39-warped4/collect.py'),str(A)],cwd=H,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
def wait_calibration():
 p=A/'calibration-3/result.json'
 while True:
  try:r=load(p)
  except (FileNotFoundError,ValueError):r={}
  if r.get('error')or r.get('dead'):
   state('blocked_calibration',error=r.get('error'),dead=r.get('dead'));raise SystemExit(2)
  if r.get('completedWindow')and r.get('coverBuilt'):return r
  state('waiting_calibration');time.sleep(10)
try:
 r=wait_calibration();controller=H/'scripts/quality/test-warped-pearl-live.mjs';jar=B/'evals/d39-pearls4/windows-base.jar'
 sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
 if r['controllerSha256']!=sha(controller):raise RuntimeError('Calibration controller changed; inspect before freezing')
 if not(A/'frozen.json').exists():
  subprocess.run(['git','diff','--exit-code','--','scripts/quality/test-warped-pearl-live.mjs'],cwd=H,check=True,stdout=subprocess.DEVNULL)
  freeze={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'controllerSha256':sha(controller),'jar':str(jar),'jarSha256':sha(jar),'coordinatorRoot':str(R),'coordinatorCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=R,text=True).strip(),'checkpointSha256':{seed:sha(A/'survey'/seed/'checkpoint.json')for seed in ['123456789','8675309','987654321','20261024']},'primaryPhysicalCohort':'Three twenty-game-minute repeats per seed, salts 1,2,3; calibration excluded.'}
  (A/'frozen.json').write_text(json.dumps(freeze,indent=2)+'\n')
 if not(A/'physical-summary.json').exists():
  for w in (0,1):launch(f'd39-pearls4-warped-physical{w}',pathlib.Path('evals/d39-warped4/run-physical.sh'),str(w),f'physical-worker{w}.log')
  while not(A/'physical-summary.json').exists():
   errors=[]
   for p in(A/'physical').glob('*/result.json'):
    try:v=load(p)
    except ValueError:continue
    if v.get('error'):errors.append({'trial':p.parent.name,'error':v['error']})
   if errors:state('blocked_physical_harness',errors=errors);raise SystemExit(2)
   if not any(unit(f'd39-pearls4-warped-physical{w}')in ('active','activating')for w in (0,1)):
    state('blocked_physical_harness',error='Workers stopped without a complete validated summary');raise SystemExit(2)
   collect();state('physical_trials');time.sleep(30)
 for w in (0,1):launch(f'd39-pearls4-warped-games{w}',pathlib.Path('evals/d39-warped4/run-games.sh'),f'worker {w}',f'games-worker{w}.log')
 while True:
  collect();report=load(A/'measurements.json');n=sum(g['valid']for g in report['games'])
  running=any(unit(f'd39-pearls4-warped-games{w}')in ('active','activating')for w in (0,1))
  state('sol_games'if running else'complete'if n>=3 else'blocked_game_evidence',validGames=n,probesPassed=sum(bool(p.get('passed'))for p in report['probes']))
  if not running:raise SystemExit(0 if n>=3 else 2)
  time.sleep(30)
except Exception as error:
 state('operator_error',error=str(error));raise
