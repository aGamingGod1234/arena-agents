#!/usr/bin/env python3
"""Collect only successful, current-fixture live results. No logs or secret files are copied.
Usage: collect-savepoint-results.py CHECKPOINT_DIR EVAL_ROOT OUTPUT_DIR
"""
import hashlib,json,pathlib,sys
checkpoints,root,out=map(pathlib.Path,sys.argv[1:]);out.mkdir(parents=True,exist_ok=True)
files={p.name:p for p in checkpoints.glob('*-v2.json')};hashes={name:hashlib.sha256(p.read_bytes()).hexdigest() for name,p in files.items()};accepted={};failures=[]
# Preserve earlier passing evidence separately when a fixture changes after its check.
for p in out.glob('*.json'):
    old=json.loads(p.read_text())
    if old.get('sha256')!=hashes.get(p.name):
        archive=out.parent/'superseded-results';archive.mkdir(exist_ok=True)
        stamp=old.get('finishedAt','unknown').replace(':','').replace('/','-')
        p.rename(archive/f"{p.stem}-{old.get('sha256','unknown')[:8]}-{stamp}.json")
for p in [*root.rglob('result.json'),*out.glob('*.json')]:
    if 'server' in p.parts:continue
    try:r=json.loads(p.read_text())
    except (OSError,json.JSONDecodeError):continue
    name=r.get('checkpoint')
    if name not in files:continue
    current=r.get('sha256')==hashes[name]
    safety=r.get('safety',{});bar=r.get('pass') and safety.get('wallMs',0)>=60000 and (safety.get('ticks') or 0)>=1200 and safety.get('minHealth')==20
    if bar and current:
        if name not in accepted or r.get('finishedAt','')>accepted[name][0].get('finishedAt',''):accepted[name]=(r,p)
    else:failures.append({'checkpoint':name,'current':current,'pass':r.get('pass'),'error':r.get('error'),'file':str(p)})
for name,(r,p) in accepted.items():
    # Keep compact evidence for each successful current artifact; full logs remain in its live run directory.
    r={**r,'evidenceDirectory':r.get('evidenceDirectory',str(p.parent))}
    (out/name).write_text(json.dumps(r,indent=2)+'\n')
summary={'total':len(files),'passed':len(accepted),'pending':sorted(set(files)-set(accepted)),'accepted':{name:str(p) for name,(r,p) in sorted(accepted.items())},'failedOrSupersededAttempts':failures}
(out.parent/'verification-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({k:summary[k] for k in ['total','passed','pending']},indent=2))
