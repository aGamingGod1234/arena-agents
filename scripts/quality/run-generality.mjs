#!/usr/bin/env node
import path from 'node:path';
import { requireRunBudgetPolicy, isStrictBudget, requireStrictGoal, STRICT_BUDGET_POLICY, OBSERVER_BUDGET_POLICY } from '../../coordinator/src/benchmark/auxiliary-budget-policy.mjs';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { terminateChildProcess, spawnOwnedProcess } from '../../coordinator/src/child-process-lifecycle.mjs';
import { loadGeneralityFixtures, extractGeneralityMarkers, summarizeGenerality, buildGeneralityJudgeTimeline } from '../../coordinator/src/benchmark/generality-suite.mjs';
import { parseJsonlDiagnostics } from '../../coordinator/src/benchmark/quality-metrics.mjs';
import { judgeTimeline, invokeJudgeCli, JudgeAttemptError } from '../../coordinator/src/benchmark/generality-judge.mjs';
import { SpendGate, startAnthropicGateway, codexJudgeWorstUsd } from '../../coordinator/src/benchmark/spend-gate.mjs';
import { readArtifactReport, writeArtifactReport } from '../../coordinator/src/benchmark/report-artifacts.mjs';
import { runScenarios, validateArmBuild, instrumentationFingerprint } from './run-scenarios.mjs';
import { SpendLedger, runSpendUsd, defaultRunReserveUsd, JUDGE_ALLOWANCE_USD, MIN_SUITE_RESERVE_USD } from '../../coordinator/src/benchmark/spend-ledger.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function parseSuiteArgs(argv) {
	const values = {}, accepted = new Set(['fixtures','split','scenarios','runs','arms','arm','concurrency','port-base','out','provider','model','effort','service-tier','judge-provider','judge-model','judge-effort','judge-executable','server-template','java','worker-job','max-play-cost-usd','max-total-cost-usd','expect-fixture-sha256','smoke-window-ms','run-reserve-usd','prior-spend-usd','ledger','codex-observer-cap']);
	for(let i=0;i<argv.length;i++) { if(argv[i]==='--help') return {help:true}; const key=argv[i].replace(/^--/,''); if(!accepted.has(key)||!argv[i+1]||argv[i+1].startsWith('--')) throw new Error(`Invalid argument ${argv[i]}`); values[key]=argv[++i]; }
	const runs=Number(values.runs??1), concurrency=Number(values.concurrency??3), portBase=Number(values['port-base']??26900);
	if(!Number.isInteger(runs)||runs<1||runs>32||!Number.isInteger(concurrency)||concurrency<1||concurrency>4||!Number.isInteger(portBase)||portBase<1024||portBase+10*concurrency>65535) throw new Error('runs 1..32; concurrency 1..4; safe port block required');
	if(values['worker-job']) return {workerJob:path.resolve(values['worker-job'])};
	if(!values.arms||!values.out) throw new Error('--arms and --out required');
	const judgeProvider=values['judge-provider'];
	if(judgeProvider&&!['claude','codex'].includes(judgeProvider)) throw new Error('judge-provider claude or codex');
	for(const key of ['judge-model','judge-effort']) if(values[key]&&!/^[a-z0-9._-]+$/i.test(values[key])) throw new Error(`Invalid ${key}`);
	if(values['judge-effort']&&!['low','medium','high','xhigh'].includes(values['judge-effort'])) throw new Error('Unsupported judge effort');
	const split=values.split??'train'; if(!['train','heldout'].includes(split)) throw new Error('split must be train or heldout');
	if(values['smoke-window-ms']&&(split!=='train'||!Number.isInteger(Number(values['smoke-window-ms']))||Number(values['smoke-window-ms'])<30000||Number(values['smoke-window-ms'])>120000)) throw new Error('Smoke window must be 30000..120000ms and train only');
	if(split==='heldout'&&!values.fixtures) throw new Error('Held-out path must be explicit; fixers must not read it');
	if(split==='heldout'&&!/^[a-f0-9]{64}$/i.test(values['expect-fixture-sha256']??'')) throw new Error('Held-out fixtures require --expect-fixture-sha256');
	if(values['prior-spend-usd']!==undefined&&!(Number.isFinite(Number(values['prior-spend-usd']))&&Number(values['prior-spend-usd'])>=0)) throw new Error('Invalid --prior-spend-usd');
	if(values['run-reserve-usd']!==undefined&&!(Number(values['run-reserve-usd'])>=MIN_SUITE_RESERVE_USD)) throw new Error(`Invalid --run-reserve-usd: a run needs at least $${MIN_SUITE_RESERVE_USD} for preparation, both judgments and some play`);
	if(values['codex-observer-cap']!==undefined&&values['codex-observer-cap']!=='yes') throw new Error('--codex-observer-cap takes yes');
	if((values.provider??'claude')==='codex'&&values['codex-observer-cap']!=='yes') throw new Error('Codex play cannot be metered per call; pass --codex-observer-cap yes to accept an observer estimate that may exceed the cap');
	const arm=values.arm??'paired'; if(!['A','B','paired'].includes(arm)) throw new Error('arm A, B or paired');
	const provider=values.provider??'claude'; if(!['claude','codex'].includes(provider)) throw new Error('provider claude or codex');
	const effectiveJudgeProvider=judgeProvider??(provider==='claude'?'codex':'claude');
	if(effectiveJudgeProvider==='claude'&&values['judge-effort']==='xhigh') throw new Error('Unsupported claude judge effort');
	return { ...values, runs, concurrency, portBase, split, arm, provider, model:values.model??(provider==='claude'?'claude-opus-5-5':'gpt-6.1-sol'), effort:values.effort??'low', serviceTier:values['service-tier']??(provider==='codex'?'default':'priority'), fixtures:path.resolve(values.fixtures??path.join(ROOT,'scripts/quality/scenarios-train.json')), out:path.resolve(values.out), arms:path.resolve(values.arms), maxPlayCostUsd:Number(values['max-total-cost-usd']??values['max-play-cost-usd']??Infinity), runReserveUsd:values['run-reserve-usd']===undefined?null:Number(values['run-reserve-usd']), priorSpendUsd:values['prior-spend-usd']===undefined?null:Number(values['prior-spend-usd']), ledger:values.ledger?path.resolve(values.ledger):null, codexObserverCap:values['codex-observer-cap']==='yes' };
}
export function suiteSchedule(ids,runs,arm='paired') {
	return Array.from({length:runs},(_,i)=>ids.map((id,j)=>({id,repetition:i+1,arms:arm==='paired'?((i+j)%2?['B','A']:['A','B']):[arm]}))).flat();
}
export async function boundedMap(items, concurrency, execute) {
	let next=0; const result=new Array(items.length);
	await Promise.all(Array.from({length:Math.min(items.length,concurrency)},async(_,slot)=>{ while(next<items.length) { const index=next++; result[index]=await execute(items[index],slot); } }));
	return result;
}
async function worker(jobFile) {
	const job=JSON.parse(await readFile(jobFile,'utf8'));
	await validateArmBuild(job.options,job.arm,job.options.provider,{requireCapture:job.requireCapture});
	const run=await gatedSuiteRun(job);
	await writeArtifactReport(path.join(job.options.out,'suite-run.json'),run);
}
/**
 * The explicit observer mode shares estimated allowances across play, preparation and judging.
 * Codex estimates are not enforced provider bounds and may overrun R.
 */
export async function gatedSuiteRun(job,{execute=runScenarios,judge=judgeTimeline,invokeJudge=invokeJudgeCli,gatewayFactory=startAnthropicGateway,readText=file=>readFile(file,'utf8')}={}) {
	const strict = isStrictBudget(job);
	requireRunBudgetPolicy({ ...job.options, codexObserverCap: job.codexObserverCap });
	if (strict) requireStrictGoal(job.scenario.goal);
	const reserveUsd=job.reserveUsd, judgeProvider=job.judge.provider??(job.judge.armProvider==='claude'?'codex':'claude');
	const playGate=new SpendGate({budgetUsd:reserveUsd});
	if(!strict && !playGate.admit('judge-allowance',JUDGE_ALLOWANCE_USD,'judge allowance')) throw new Error(`Run reservation $${reserveUsd} cannot hold the judge allowance`);
	const claudeProfile=model=>({provider:'claude',model,reasoningEffort:job.options.effort,serviceTier:'priority'});
	const gateway=job.options.provider==='claude'||judgeProvider==='claude'?await gatewayFactory({gate:playGate,profileFor:claudeProfile,strict}):null;
	const previousBaseUrl=process.env.ANTHROPIC_BASE_URL;
	try {
		const report=await execute({...job.options,spendGate:playGate,gateway:job.options.provider==='claude'?gateway:undefined,codexObserverCap:job.codexObserverCap===true});
		const run=report.runs[0], samples=run.artifacts ? JSON.parse(await readText(path.join(run.artifacts,'quality-samples.json'))).samples : [];
		run.arm=job.arm; run.pairId=`${job.scenario.id}-r${job.repetition}`; run.categories=job.scenario.categories;
		const protocolRows=run.artifacts ? parseJsonlDiagnostics(await readText(path.join(run.artifacts,'quality-protocol.jsonl'))).rows : [];
		run.markers=extractGeneralityMarkers({scenario:{...job.scenario,fixtureActivatedAt:run.setup?.activatedAt,setup:run.setup?.definition??job.scenario.setup},metrics:run.metrics,samples,protocolRows});
		if (!strict) playGate.settle('judge-allowance',0);
		run.gate={...(run.gate??{}),...playGate.totals(),playMetering:run.gate?.playMetering??(job.options.provider==='claude'?'gateway':'observer')};
		if (strict) {
			run.judge = { deferred: true, costUsd: 0, reason: 'No live model grading in strict mode; authoritative game completion is recorded separately' };
			run.budgetPolicy = STRICT_BUDGET_POLICY;
			return run;
		}
		const spentBeforeJudging=runSpendUsd(run,{reserveUsd}).usd;
		const judgeGate=new SpendGate({budgetUsd:Math.max(1e-9,reserveUsd-spentBeforeJudging)});
		if(gateway) { gateway.gate=judgeGate; process.env.ANTHROPIC_BASE_URL=gateway.url; }
		const judgeProfile={provider:judgeProvider,model:job.judge.model??(judgeProvider==='claude'?'claude-opus-5-5':'gpt-6.1-sol'),reasoningEffort:job.judge.effort,serviceTier:job.judge.serviceTier??(judgeProvider==='codex'?'default':'priority')};
		// Codex attempts reserve an estimate only. Strict owners are refused above before play or judging launches.
		const invoke=judgeProvider==='claude'?invokeJudge:async args=>{
			const id=`judge-${args.round}-${args.attempt}`;
			if(!judgeGate.admit(id,codexJudgeWorstUsd(args.prompt,judgeProfile),'judge')) throw new JudgeAttemptError('Evaluator spend cap: judge attempt refused before launch',{costUsd:0});
			try { const result=await invokeJudge(args); judgeGate.settle(id,Number.isFinite(result.costUsd)?result.costUsd:null); return result; }
			catch(error) { judgeGate.settle(id,Number.isFinite(error.costUsd)?error.costUsd:null); throw error; }
		};
		try { run.judge=await judge({goal:job.scenario.goal,timeline:buildGeneralityJudgeTimeline(run.metrics,run.markers,protocolRows,{activatedAt:run.setup?.activatedAt}),...job.judge,invoke}); }
		catch(error) { run.judge={error:error.message}; }
		const judgeTotals=judgeGate.totals();
		run.gate={...run.gate,chargeUsd:run.gate.chargeUsd+judgeTotals.chargeUsd,judge:judgeTotals};
		run.budgetPolicy=OBSERVER_BUDGET_POLICY;
		return run;
	} finally {
		if(gateway) await gateway.close();
		if(previousBaseUrl===undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL=previousBaseUrl;
	}
}
export async function launchWorker(file,{timeoutMs=25*60*1000,spawnChild=spawnOwnedProcess,stopChild=terminateChildProcess}={}) {
	return new Promise((resolve,reject)=>{
		const c=spawnChild(process.execPath,[fileURLToPath(import.meta.url),'--worker-job',file],{cwd:ROOT,windowsHide:true,stdio:['ignore','pipe','pipe']});
		let stopping=false;
		const timer=setTimeout(()=>{stopping=true;void stopChild(c).then(()=>reject(new Error(`Suite worker exceeded ${timeoutMs}ms`)),reject);},timeoutMs);
		c.stdout.on('data',b=>process.stdout.write(b));c.stderr.on('data',b=>process.stderr.write(b));
		c.once('error',error=>{clearTimeout(timer);reject(error)});
		c.once('close',code=>{clearTimeout(timer);if(!stopping)resolve(code)});
	});
}
/** Reserve estimated R before launch; the explicit observer mode can still overrun its estimate. */
export function suiteRunAllowance(options,scenario) {
	const reserveUsd=options.runReserveUsd??defaultRunReserveUsd(scenario.durationBudgetMs);
	// playCapUsd only drives the observer-enforced Codex mode; gateway-metered play is bounded by the gate itself.
	return {reserveUsd,playCapUsd:Math.max(0.01,reserveUsd-JUDGE_ALLOWANCE_USD-0.25)};
}
export async function suiteFingerprint() {
	const hash=createHash('sha256');
	hash.update(await instrumentationFingerprint());
	for(const file of ['scripts/quality/run-generality.mjs','scripts/quality/run-long.mjs','coordinator/src/benchmark/long-run.mjs','scripts/quality/reextract-generality.mjs','coordinator/src/benchmark/generality-suite.mjs','coordinator/src/benchmark/generality-judge.mjs']) hash.update(file+'\0').update(await readFile(path.join(ROOT,file)));
	return hash.digest('hex');
}
export async function runSuite(options) {
	requireRunBudgetPolicy(options);
	if (isStrictBudget(options) && !Number.isFinite(options.maxPlayCostUsd)) throw new Error('Strict suite requires --max-total-cost-usd');
	if(!options['port-base']) throw new Error('--port-base must explicitly reserve a port block');
	const fixtures=await loadGeneralityFixtures(options.fixtures,options.split,options['expect-fixture-sha256']);
	if(options.split==='heldout'){const relative=path.relative(path.dirname(options.fixtures),options.out);if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)) throw new Error('Held-out outputs must stay inside the evaluator-only fixture directory');}
	const arms=JSON.parse(await readFile(options.arms,'utf8'));
	if (!Number.isFinite(options.maxPlayCostUsd) && options.maxPlayCostUsd !== Infinity || options.maxPlayCostUsd <= 0) throw new Error('Cost budget must be positive');
	const ids=options.scenarios?options.scenarios.split(','):fixtures.scenarios.map(s=>s.id);
	if (isStrictBudget(options)) for (const id of ids) { const scenario = fixtures.scenarios.find(s => s.id === id); if (scenario) requireStrictGoal(scenario.goal); }
	if(new Set(ids).size!==ids.length||ids.some(id=>!fixtures.scenarios.some(s=>s.id===id))) throw new Error('Unknown or duplicate subset');
	for(const arm of options.arm==='paired'?['A','B']:[options.arm]) {
		const build=arms[arm]; if(!build) throw new Error(`Missing arm ${arm}`);
		// Single smoke permits original stacks without first-response capture; judge needs only actions.
		await validateArmBuild(build,arm,options.provider,{requireCapture:options.arm==='paired'});
	}
	if(options.arm==='paired' && arms.A.expectedJarSha256===arms.B.expectedJarSha256 && arms.A.expectedCoordinatorSha256===arms.B.expectedCoordinatorSha256) throw new Error('Paired arms must differ');
	await mkdir(options.out,{recursive:true});
	if((await import('node:fs')).existsSync(path.join(options.out,'results.json'))) throw new Error('Use fresh output directory');
	const ledger=new SpendLedger({capUsd:options.maxPlayCostUsd,priorSpendUsd:options.priorSpendUsd,file:options.ledger});
	const report={version:2,benchmark:'generality-suite',invocationId:randomUUID(),split:options.split,fixtureSha256:fixtures.sha256,suiteInstrumentationSha256:await suiteFingerprint(),configuration:options,pinnedArms:arms,budgetPolicy:isStrictBudget(options)?STRICT_BUDGET_POLICY:OBSERVER_BUDGET_POLICY,runs:[],failures:[],totalSpendEstimateUsd:0,complete:false};
	let totalCost=0;
	await writeArtifactReport(path.join(options.out,'results.json'),report);
	await boundedMap(suiteSchedule(ids,options.runs,options.arm),options.concurrency,async(pair,slot)=>{
		const fixture=fixtures.scenarios.find(s=>s.id===pair.id);
		const scenario=options['smoke-window-ms']?{...fixture,declaredDurationBudgetMs:fixture.durationBudgetMs,durationBudgetMs:Number(options['smoke-window-ms']),smoke:true}:fixture;
		for(const arm of pair.arms) {
			const {reserveUsd,playCapUsd}=suiteRunAllowance(options,scenario), entry=`${report.invocationId}/${arm}/${pair.id}-r${pair.repetition}`;
			if(!await ledger.reserve(entry,reserveUsd,`${options.split} ${options.provider} ${arm} ${pair.id}-r${pair.repetition}`)) {report.failures.push({pairId:`${pair.id}-r${pair.repetition}`,arm,error:'Total spend budget reached before launch'});continue;}
			const out=path.join(options.out,arm,`${pair.id}-r${pair.repetition}`); await mkdir(out,{recursive:true});
			const jobFile=path.join(out,'job.json'), build=arms[arm];
			const job={scenario,arm,reserveUsd,codexObserverCap:options.codexObserverCap,requireCapture:options.arm==='paired',repetition:pair.repetition,judge:{armProvider:options.provider,provider:options['judge-provider'],model:options['judge-model'],effort:options['judge-effort']??'medium',executable:options['judge-executable']},options:{...build,definitions:[{...scenario,spendCapUsd:playCapUsd,runReserveUsd:reserveUsd}],scenarios:[scenario.id],runs:1,repetition:pair.repetition,provider:options.provider,model:options.model,effort:options.effort,serviceTier:options.serviceTier,budget:scenario.durationBudgetMs,goalStartClock:true,portBase:options.portBase+slot*10,out,sourceCommit:build.commit,template:path.resolve(options['server-template']??path.join(ROOT,'runtime/server-template')),java:options.java??process.env.ARENA_HEADLESS_JAVA??path.join(process.env.JAVA_HOME??path.join(ROOT,'runtime/toolchains/temurin-25/jdk-25.0.3+9'),'bin/java.exe')}};
			await writeFile(jobFile,JSON.stringify(job));
			let run=null;
			try { const exitCode=await launchWorker(jobFile,{timeoutMs:scenario.durationBudgetMs+12*60*1000}); run=await readArtifactReport(path.join(out,'suite-run.json')); run.workerExitCode=exitCode; report.runs.push(run); }
			catch(error) {report.failures.push({pairId:`${pair.id}-r${pair.repetition}`,arm,error:error.message});}
			const spend=runSpendUsd(run,{reserveUsd}); if(run) run.spend=spend; else report.failures.at(-1).spend=spend;
			report.ledger=await ledger.settle(entry,spend.usd,{meteredUsd:spend.meteredUsd,reservedUsd:spend.reservedUsd,notes:spend.notes});
			totalCost+=spend.usd; report.totalSpendEstimateUsd=totalCost; report.reservedSpendUsd=(report.reservedSpendUsd??0)+spend.reservedUsd;
			// Serialize checkpoint writes because independent workers finish concurrently.
			await checkpoint();
		}
	});
	report.suiteSourceChanged=report.suiteInstrumentationSha256!==await suiteFingerprint();
	if(report.suiteSourceChanged) for(const run of report.runs) {run.measurementStatus='INCOMPLETE';run.observerErrors=[...(run.observerErrors??[]),'Suite instrumentation changed during run'];}
	report.complete=!report.suiteSourceChanged && report.runs.length===ids.length*options.runs*(options.arm==='paired'?2:1)&&!report.failures.length;
	report.summary=summarizeGenerality(report.runs); await checkpoint();
	const rows=report.summary.categories;
	await writeFile(path.join(options.out,'summary.md'),`Invalid runs (excluded from means): ${report.summary.invalidRuns.length}\n\n`+'| Category | Runs | Invalid | Measured | Goal rate | Survival | Play USD | Judge agreement |\n|---|---:|---:|---:|---:|---:|---:|---:|\n'+rows.map(r=>`| ${r.category} | ${r.runs} | ${r.invalid} | ${r.measured} | ${r.success.mean??'?'} | ${r.survival.mean??'?'} | ${r.playCostUsd.mean??'?'} | ${r.judgeAgreement.mean??'?'} |`).join('\n')+'\n\n| Waste class | Observed n | Mean |\n|---|---:|---:|\n'+report.summary.waste.map(r=>`| ${r.className} | ${r.n} | ${r.mean??'?'} |`).join('\n')+'\n');
	if(!report.complete||report.runs.some(r=>r.judge?.error||r.measurementStatus!=='MEASURED')) process.exitCode=1;
	return report;
	function checkpoint() { const snapshot=structuredClone(report); checkpoint.queue=(checkpoint.queue??Promise.resolve()).then(()=>writeArtifactReport(path.join(options.out,'results.json'),snapshot));return checkpoint.queue; }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
	try { const o=parseSuiteArgs(process.argv.slice(2)); if(o.help) console.log('run-generality.mjs --arms arms.json --arm paired|A|B --scenarios T01,T02 --runs 1 --concurrency 3 --out DIR [--split heldout --fixtures PRIVATE_FILE] [--judge-provider claude|codex] [--max-total-cost-usd N --ledger FILE --prior-spend-usd P --run-reserve-usd R]'); else if(o.workerJob) await worker(o.workerJob); else await runSuite(o); } catch(error) {console.error(error);process.exitCode=1;}
}
