import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnOwnedProcess, terminateChildProcess, prepareOwnedJobStop, OWNED_JOB_ENVIRONMENT_VARIABLE } from '../src/child-process-lifecycle.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(read, condition, describeFailure = async () => '') {
	const deadline = performance.now() + 15000;
	while (performance.now() < deadline) {
		const value = await read();
		if (condition(value)) return value;
		await sleep(50);
	}
	throw new Error('owned process fixture did not reach expected state: ' + await describeFailure());
}
const readOrEmpty = filename => readFile(filename, 'utf8').catch(() => '');

test('exited real launcher is never signalled again', async () => {
	const child = spawn(process.execPath, ['-e', '']);
	await once(child, 'close');
	// terminateChildProcess signals only through the retained handle, so a signal on an exited child is the boundary to watch.
	let kills = 0;
	child.kill = () => { kills += 1; return false; };
	await terminateChildProcess(child, { platform: 'win32' });
	assert.equal(kills, 0);
});

test('owned Windows job kills descendants through its wrapper handle and leaves independent children alive', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'arena owned job '));
	const beat = path.join(root, 'descendant.txt');
	const ready = path.join(root, 'ready.txt');
	const script = path.join(root, 'fixture.cjs');
	await writeFile(script, `const fs=require('node:fs'); const {spawn}=require('node:child_process');
if(process.argv[2]==='descendant'){setInterval(()=>fs.appendFileSync(process.argv[3],'x'),25);}
else { spawn(process.execPath,[__filename,'descendant',process.argv[2]],{stdio:'ignore'}); fs.writeFileSync(process.argv[3],'ready'); setInterval(()=>{},1000); }`);
	const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true });
	const child = spawnOwnedProcess(process.execPath, [script, beat, ready], { stdio: ['ignore', 'pipe', 'pipe'] });
	let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
	try {
		await eventually(() => readOrEmpty(ready), value => value === 'ready');
		await eventually(() => readOrEmpty(beat), value => value.length > 2);
		await terminateChildProcess(child, { timeoutMs: 15000 });
		await sleep(200);
		const settled = await readOrEmpty(beat);
		await sleep(200);
		assert.equal(await readOrEmpty(beat), settled, 'descendant stops when the job handle closes');
		assert.equal(sentinel.exitCode, null);
		assert.equal(sentinel.signalCode, null);
		assert.equal(stderr, '');
	} finally {
		await terminateChildProcess(child, { timeoutMs: 15000 });
		await terminateChildProcess(sentinel, { timeoutMs: 15000 });
		await rm(root, { recursive: true, force: true });
	}
});

test('owned Windows job closes remaining descendants on normal launcher exit', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'arena owned exit '));
	const beat = path.join(root, 'beat.txt');
	const script = path.join(root, 'fixture.cjs');
	await writeFile(script, `const fs=require('node:fs'); const {spawn}=require('node:child_process');
if(process.argv[2]==='descendant'){setInterval(()=>fs.appendFileSync(process.argv[3],'x'),25);}
else { const child=spawn(process.execPath,[__filename,'descendant',process.argv[2]],{stdio:'inherit'}); child.unref(); setTimeout(()=>process.exit(0),1000); }`);
	const child = spawnOwnedProcess(process.execPath, [script, beat], { stdio: 'ignore' });
	try {
		await once(child, 'close');
		assert.equal(child.exitCode, 0);
		const stopped = await readOrEmpty(beat);
		assert.ok(stopped.length > 0);
		await sleep(200);
		assert.equal(await readOrEmpty(beat), stopped);
		await terminateChildProcess(child);
	} finally {
		await terminateChildProcess(child, { timeoutMs: 15000 });
		await rm(root, { recursive: true, force: true });
	}
});

test('owned Windows launcher preserves exact arguments and raw bidirectional JSONL stdio', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'arena owned stdio '));
	const script = path.join(root, 'echo.cjs');
	await writeFile(script, `process.stderr.write('diagnostic\\n'); process.stdout.write(JSON.stringify(process.argv.slice(2))+'\\n'); process.stdin.pipe(process.stdout);`);
	const args = ['', 'with spaces', 'quotes"inside', 'trailing\\', '{"key":"\u6f22\u5b57"}', 'line\nbreak'];
	const child = spawnOwnedProcess(process.execPath, [script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
	let stdout = '', stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
	child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
	try {
		const closed = once(child, 'close');
		child.stdin.end('{"unicode":"\u6f22\u5b57","value":1}\n{"next":true}\n');
		await closed;
		assert.equal(child.exitCode, 0, stderr);
		assert.equal(stderr, 'diagnostic\n');
		assert.deepEqual(JSON.parse(stdout.slice(0, stdout.indexOf('\n'))), args);
		assert.equal(stdout.slice(stdout.indexOf('\n') + 1), '{"unicode":"\u6f22\u5b57","value":1}\n{"next":true}\n');
	} finally {
		await terminateChildProcess(child, { timeoutMs: 15000 });
		await rm(root, { recursive: true, force: true });
	}
});

test('job completion witness observes forced owned cleanup without termination rights', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'arena job witness '));
	const proof = path.join(root, 'proof.json');
	const ready = path.join(root, 'ready');
	const fixture = path.join(root, 'child.cjs');
	await writeFile(fixture, `const fs=require('node:fs');const {spawn}=require('node:child_process');if(process.argv[2]==='leaf'){setInterval(()=>{},1000)}else{spawn(process.execPath,[__filename,'leaf'],{stdio:'ignore'});fs.writeFileSync(process.argv[2],'ready');setInterval(()=>{},1000)}`);
	const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true });
	const child = spawnOwnedProcess(process.execPath, [fixture, ready], { stdio: ['ignore', 'pipe', 'pipe'], ownedJobEvidencePath: proof });
	let diagnostics = ''; child.stderr.on('data', value => { diagnostics += value; });
	const closed = once(child, 'close');
	const startupDiagnostics = async () => JSON.stringify({ exitCode: child.exitCode, signalCode: child.signalCode, stderr: diagnostics, proof: await readOrEmpty(proof) });
	try {
		await eventually(async () => {
			if (child.exitCode !== null || child.signalCode !== null) throw new Error('owned witness launcher exited before fixture readiness: ' + await startupDiagnostics());
			return readOrEmpty(ready);
		}, value => value === 'ready', startupDiagnostics);
		await sleep(100);
		const preparation = prepareOwnedJobStop(child);
		assert.equal(prepareOwnedJobStop(child), preparation, 'concurrent stop paths share one freeze operation');
		await preparation;
		await terminateChildProcess(child, { timeoutMs: 15000 });
		await closed;
		const observed = JSON.parse(await readFile(proof, 'utf8'));
		assert.equal(observed.status, 'COMPLETE', diagnostics + JSON.stringify(observed));
		await prepareOwnedJobStop(child); // A later watchdog/timeout race keeps the completed proof.
		assert.equal(observed.allMembersExited, true);
		assert.equal(observed.jobHandleClosedBeforeStop, true);
		assert.equal(observed.wrapperExited, true);
		assert.equal(observed.observationHandlesClosed, true);
		assert.ok(observed.frozenMemberCount >= 3);
		assert.equal(sentinel.exitCode, null);
		assert.equal(sentinel.signalCode, null);
	} finally {
		await terminateChildProcess(child, { timeoutMs: 15000 });
		await closed;
		await terminateChildProcess(sentinel, { timeoutMs: 15000 });
		await rm(root, { recursive: true, force: true });
	}
});



test('job witness promptly reports incomplete when launcher exits without a frozen census', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'arena job incomplete '));
	const proof = path.join(root, 'proof.json');
	const child = spawnOwnedProcess(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe'], ownedJobEvidencePath: proof });
	let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
	try {
		await once(child, 'close');
		const observed = JSON.parse(await readFile(proof, 'utf8'));
		assert.equal(observed.status, 'INCOMPLETE', stderr);
		assert.equal(observed.allMembersExited, false);
		assert.equal(observed.jobHandleClosedBeforeStop, false);
		assert.equal(observed.observationHandlesClosed, true);
	} finally {
		await terminateChildProcess(child, { timeoutMs: 15000 });
		await rm(root, { recursive: true, force: true });
	}
});

test('the Windows job witness publishes every signal file by rename, so the wrapper never deletes a file still being written', async () => {
	// The wrapper polls File.Exists(control + ".ready") and deletes the file at once. Written in place with
	// File.WriteAllText, the name appears before the witness closes it, and that delete failed on Windows CI with
	// "being used by another process": AttachWithEvidence threw, the command never ran, and the cleanup proof read
	// INCOMPLETE with wrapperExited false.
	const witness = await readFile(new URL('../src/owned-job-witness.ps1', import.meta.url), 'utf8');
	const wrapper = await readFile(new URL('../src/owned-windows-job.ps1', import.meta.url), 'utf8');
	assert.match(witness, /static void Publish\(string path,string text\) \{\s*File\.WriteAllText\(path\+"\.writing",text\);File\.Move\(path\+"\.writing",path\);/);
	for (const signal of ['control+".ready"', 'evidence+".ready"']) assert.ok(witness.includes(`Publish(${signal},`), `${signal} is published by rename`);
	assert.doesNotMatch(witness, /WriteAllText\((control|evidence)\+"\.ready"/, 'no polled signal is written in place');
	// The wrapper's own control file is published the same way, and its cleanup of the witness's signal cannot fail the attach.
	assert.match(wrapper, /File\.WriteAllText\(control \+ "\.writing",[^\n]*\n\s*File\.Move\(control \+ "\.writing", control\);/);
	assert.match(wrapper, /try \{ File\.Delete\(control \+ "\.ready"\); \} catch \(IOException\) \{ \}/);
	assert.equal(wrapper.match(/File\.Delete\(control \+ "\.ready"\)/g).length, 1, 'no unguarded delete of the ready signal');
});

test('the Windows job wrapper starts System32 PowerShell even when the provider PATH omits it', () => {
	const calls = [];
	spawnOwnedProcess('codex.cmd', ['app-server'], { env: { PATH: 'C:\fake-bin' } }, { platform: 'win32', spawn: (command, args, options) => { calls.push({ command, options }); return {}; } });
	assert.equal(path.win32.isAbsolute(calls[0].command), true);
	assert.deepEqual(calls[0].command.toLowerCase().split(path.win32.sep).slice(-4), ['system32', 'windowspowershell', 'v1.0', 'powershell.exe']);
	assert.equal(calls[0].options.env.PATH, 'C:\fake-bin');
});

test('the Windows job wrapper gets system variables while the command keeps exactly its environment', () => {
	const calls = [];
	const env = { PATH: 'C:\\provider', Path: 'C:\\shadowed', ARENA_PROVIDER_ONLY: '1' };
	spawnOwnedProcess('codex.cmd', ['app-server'], { env }, { platform: 'win32', spawn: (command, args, options) => { calls.push({ args, options }); return {}; } });
	const requested = JSON.parse(calls[0].options.env[OWNED_JOB_ENVIRONMENT_VARIABLE]);
	// Node keeps the first name in sorted order for case-insensitive duplicates; the wrapper must match it.
	assert.deepEqual(requested, { ARENA_PROVIDER_ONLY: '1', PATH: 'C:\\provider' });
	const added = Object.keys(calls[0].options.env).filter((name) => !Object.hasOwn(requested, name) && name !== OWNED_JOB_ENVIRONMENT_VARIABLE);
	for (const name of added) assert.match(name.toUpperCase(), /^(ALLUSERSPROFILE|COMMONPROGRAM.*|COMPUTERNAME|DRIVERDATA|LOGONSERVER|NUMBER_OF_PROCESSORS|OS|PROCESSOR_.*|PSMODULEPATH|PUBLIC|SESSIONNAME|USERDOMAIN.*|USERNAME)$/);
});

test('the Windows job wrapper never puts provider secrets on its command line', () => {
	const calls = [];
	const secrets = { ANTHROPIC_API_KEY: 'sk-ant-argv-canary-1', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-argv-canary-2', OPENAI_API_KEY: 'sk-openai-argv-canary-3' };
	spawnOwnedProcess('claude.exe', ['--print'], { env: { PATH: 'C:\\provider', ...secrets } }, { platform: 'win32', spawn: (command, args, options) => { calls.push({ command, args, options }); return {}; } });
	const { command, args, options } = calls[0];
	// Decode every argument as well: base64 hid the whole environment in -CommandJson before.
	const argv = [command, ...args].flatMap((arg) => [arg, Buffer.from(arg, 'base64').toString('utf8')]).join('\n');
	for (const [name, value] of Object.entries(secrets)) {
		assert.equal(argv.includes(value), false, `${name} appeared in the wrapper argv`);
		assert.equal(options.env[name], value, `${name} reaches the wrapper through its environment`);
	}
	const invocation = JSON.parse(Buffer.from(args[args.indexOf('-CommandJson') + 1], 'base64').toString('utf8'));
	assert.deepEqual(invocation, { command: 'claude.exe', args: ['--print'] });
	assert.deepEqual(JSON.parse(options.env[OWNED_JOB_ENVIRONMENT_VARIABLE]), { PATH: 'C:\\provider', ...secrets });
});

test('the Windows job wrapper refuses an environment Windows could not hold in one variable', () => {
	const env = { PATH: 'C:\\provider', HUGE: 'x'.repeat(40_000) };
	assert.throws(() => spawnOwnedProcess('codex.cmd', [], { env }, { platform: 'win32', spawn: () => { throw new Error('must not spawn'); } }), /Windows allows 32767/);
});

test('an owned child receives exactly the requested environment', { skip: process.platform !== 'win32' }, async () => {
	const env = { SYSTEMROOT: process.env.SystemRoot, ARENA_PROVIDER_ONLY: '1' };
	const child = spawnOwnedProcess(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
	let stdout = '';
	child.stdout.on('data', chunk => { stdout += chunk; });
	child.stdin.end();
	await once(child, 'close');
	const names = JSON.parse(stdout).map((name) => name.toUpperCase());
	assert.ok(names.includes('ARENA_PROVIDER_ONLY'));
	assert.equal(names.includes('PROCESSOR_ARCHITECTURE'), false, 'wrapper-only system variables stay out of the command');
	assert.equal(names.includes(OWNED_JOB_ENVIRONMENT_VARIABLE), false, 'the environment hand-off variable stays out of the command');
});

test('an owned child answers a line-delimited request while stdin stays open', { skip: process.platform !== 'win32' }, async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'owned-stdin-'));
	const script = path.join(directory, 'echo.mjs');
	await writeFile(script, [
		"import readline from 'node:readline';",
		"readline.createInterface({ input: process.stdin }).on('line', line => console.log('echo ' + line));",
	].join('\n'));
	const child = spawnOwnedProcess(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
	try {
		let output = '';
		child.stdout.on('data', chunk => { output += chunk; });
		child.stdin.write('ping\n');
		await eventually(async () => output, value => value.includes('echo ping'), async () => `output: ${JSON.stringify(output)}`);
	} finally {
		child.stdin.end();
		await terminateChildProcess(child, { timeoutMs: 10000 });
		await rm(directory, { recursive: true, force: true });
	}
});

test('the Windows job wrapper adds nothing to the child stdout or stderr', { skip: process.platform !== 'win32' }, async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'owned-exact-'));
	const script = path.join(directory, 'exact.mjs');
	await writeFile(script, "process.stdout.write('{\"ok\":1}'); process.stderr.write('E');");
	const child = spawnOwnedProcess(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
	try {
		let stdout = '', stderr = '';
		child.stdout.on('data', chunk => { stdout += chunk; });
		child.stderr.on('data', chunk => { stderr += chunk; });
		child.stdin.end();
		await once(child, 'close');
		assert.equal(JSON.stringify(stdout), JSON.stringify('{"ok":1}'));
		assert.equal(JSON.stringify(stderr), JSON.stringify('E'));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
