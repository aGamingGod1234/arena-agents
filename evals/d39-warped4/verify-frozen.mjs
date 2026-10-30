import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=process.argv[2],r=JSON.parse(await readFile(path.join(root,'frozen.json'),'utf8'));
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
if(await hash('scripts/quality/test-warped-pearl-live.mjs')!==r.controllerSha256)throw Error('Controller changed since freeze');
if(await hash(r.jar)!==r.jarSha256)throw Error('Jar changed since freeze');
for(const [seed,sha]of Object.entries(r.checkpointSha256))if(await hash(path.join(root,'survey',seed,'checkpoint.json'))!==sha)throw Error('Checkpoint changed since freeze');

if(execFileSync('git',['-C',r.coordinatorRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==r.coordinatorCommit)throw Error('Player runtime changed since freeze');
execFileSync('git',['-C',r.coordinatorRoot,'diff','--exit-code','--','coordinator/src','coordinator/config'],{stdio:'pipe'});
