"""Audit the real collected measurement artifact against the task's required coverage."""
import collections,json,pathlib,sys
r=json.load(open(sys.argv[1]));checks=[]
def check(name,condition):checks.append({'check':name,'passed':bool(condition)})
seeds={'123456789','8675309','987654321','20261024'}
valid=[p for p in r['physical']if p['valid']]
primary=[p for p in valid if p['primary']]
for seed in sorted(seeds):
 for arm in ('base','candidate'):
  rows=[p for p in primary if p['seed']==seed and p['arm']==arm]
  check(f'{seed} {arm}: three distinct prescribed repeats',len(rows)==3 and sorted(p['salt']for p in rows)==[1,2,3])
for seed in sorted(seeds):
 for salt in (1,2,3):
  rows=[p for p in primary if p['seed']==seed and p['salt']==salt]
  check(f'{seed} repeat {salt}: base and candidate on the same host',len(rows)==2 and len({p['machine']for p in rows})==1)
check('all physical arms use the frozen controller',len({p['controllerSha256']for p in valid})==1 and all(p['controllerSha256']=='541b2928c9c391bf7e2f24d9a2a0e0de0150e18a3112e244d82f3f1aca7c5780'for p in valid))
check('all physical arms use the exact same jar',len({p['jarSha256']for p in valid})==1 and all(p['jarSha256']=='adfaa5e3a89d2ed24faf5dd431801ec20dbeb7b739231a17de1a4cec390d8b43'for p in valid))
games=[g for g in r['candidateGames']if g['completed90Minutes']]
check('four completed candidate windows across four seeds',len(games)==4 and {g['seed']for g in games}==seeds)
for g in games:
 check(g['tag']+': frozen player runtime',g['build']=='af6f3f0958614ac6401709ba2e3f1fe62399f5c2')
 check(g['tag']+': Sol low/default player',bool(g['profiles'])and all(p['model']=='gpt-6.1-sol'and p['effort']=='low'and p['tier']=='default'for p in g['profiles']))
 check(g['tag']+': current ending inventory',g['endInventoryCurrent'])
for g in r['candidateGames']+r['queueGames']:
 if g.get('voidByDesktopInterruption')or g.get('voidBySolStall'):check(g['tag']+': interrupted gameplay excluded',all(g[k]is None for k in ('grossGoldIngots','endPearls','deaths','handovers')))
report={'passed':all(c['passed']for c in checks),'checks':checks}
if len(sys.argv)>2:pathlib.Path(sys.argv[2]).write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2));sys.exit(0 if report['passed']else 1)
