import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import path from 'node:path';

import { OpenCodeServerPool, projectFilesAbove, withDirectory } from '../src/decision-eval/opencode-pool.mjs';

function fakeServers() {
	const spawned = [];
	const spawn = (command, args, options) => {
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.pid = 4000 + spawned.length;
		child.kill = () => {};
		spawned.push({ command, args, options, child });
		setImmediate(() => child.stdout.write(`opencode server listening on http://127.0.0.1:${5000 + spawned.length}\n`));
		return child;
	};
	const terminated = [];
	const terminate = async (child) => { terminated.push(child); child.emit('close', 0, null); };
	return { spawned, spawn, terminated, terminate };
}

const launchEnv = (directory) => ({ PATH: '/bin', OPENCODE_CONFIG: `${directory}/opencode.json`, OPENCODE_DISABLE_PROJECT_CONFIG: '1', XDG_CONFIG_HOME: `${directory}/config-home`, OPENCODE_DB: `${directory}/opencode.db`, OPENCODE_SERVER_PASSWORD: 'agent-secret', OPENCODE_DISABLE_CLAUDE_CODE: '1' });
const listening = (child) => new Promise((resolve) => { child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => resolve(String(chunk))); });

test('agent servers become directory instances of one pooled process', async () => {
	const fake = fakeServers();
	const pool = new OpenCodeServerPool({ spawn: fake.spawn, terminate: fake.terminate });
	const requests = [];
	const request = async (server, method, pathname) => { requests.push({ server, method, pathname }); return {}; };
	const deps = pool.playerDependencies({ request });
	const args = ['serve', '--pure', '--port', '0', '--hostname', '127.0.0.1'];
	const first = deps.spawn('opencode', args, { cwd: '/tmp/arena-opencode-a', env: launchEnv('/tmp/arena-opencode-a') });
	const second = deps.spawn('opencode', args, { cwd: '/tmp/arena-opencode-b', env: launchEnv('/tmp/arena-opencode-b') });
	const [lineA, lineB] = await Promise.all([listening(first), listening(second)]);
	assert.equal(fake.spawned.length, 1, 'both samples share one process');
	assert.match(lineA, /listening on http:\/\/127\.0\.0\.1:5001/);
	assert.equal(lineA, lineB);
	const env = fake.spawned[0].options.env;
	assert.equal(env.OPENCODE_CONFIG, undefined, 'each instance reads its own directory config');
	assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, undefined);
	assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE, '1', 'the rest of the build launch environment is kept');
	assert.notEqual(env.OPENCODE_SERVER_PASSWORD, 'agent-secret');

	const state = { child: first, url: 'http://127.0.0.1:5001', auth: 'Basic agent', directory: '/tmp/arena-opencode-a', exited: false };
	await deps.request(state, 'POST', '/session', { title: 'x' });
	assert.equal(requests[0].pathname, '/session?directory=%2Ftmp%2Farena-opencode-a');
	assert.equal(requests[0].server.url, 'http://127.0.0.1:5001');
	assert.match(requests[0].server.auth, /^Basic /);
	assert.notEqual(requests[0].server.auth, 'Basic agent');

	const closed = new Promise((resolve) => first.once('close', (code) => resolve(code)));
	await deps.terminate(first);
	assert.equal(await closed, 0);
	assert.equal(requests[1].pathname, '/instance/dispose?directory=%2Ftmp%2Farena-opencode-a', 'the instance is disposed with its sample');
	assert.equal(fake.terminated.length, 0, 'the shared process keeps running');

	// The process exiting under a sample reaches that sample as its own server exiting.
	const exited = new Promise((resolve) => second.once('close', (code, signal) => resolve([code, signal])));
	fake.spawned[0].child.emit('close', null, 'SIGKILL');
	assert.deepEqual(await exited, [null, 'SIGKILL']);
	const third = deps.spawn('opencode', args, { cwd: '/tmp/arena-opencode-c', env: launchEnv('/tmp/arena-opencode-c') });
	await listening(third);
	assert.equal(fake.spawned.length, 2, 'a dead process is replaced');
	await pool.stop();
	assert.equal(fake.terminated.length, 1);
});

test('launches that differ outside the per-process variables get their own process', async () => {
	const fake = fakeServers();
	const pool = new OpenCodeServerPool({ spawn: fake.spawn, terminate: fake.terminate });
	const deps = pool.playerDependencies({ request: async () => ({}) });
	const args = ['serve', '--pure', '--port', '0', '--hostname', '127.0.0.1'];
	const a = deps.spawn('opencode', args, { cwd: '/tmp/x', env: launchEnv('/tmp/x') });
	const b = deps.spawn('opencode', args, { cwd: '/tmp/y', env: { ...launchEnv('/tmp/y'), LANG: 'C' } });
	await Promise.all([listening(a), listening(b)]);
	assert.equal(fake.spawned.length, 2);
	await pool.stop();
});

test('withDirectory appends the instance query', () => {
	assert.equal(withDirectory('/event', '/tmp/a b'), '/event?directory=%2Ftmp%2Fa%20b');
	assert.equal(withDirectory('/session?x=1', '/tmp/a'), '/session?x=1&directory=%2Ftmp%2Fa');
	assert.equal(withDirectory('/session', null), '/session');
});

test('a sample directory below project files OpenCode would also read is refused', async () => {
	const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const root = await mkdtemp(`${tmpdir()}/opencode-pool-`);
	try {
		await mkdir(`${root}/a/b`, { recursive: true });
		const inherited = projectFilesAbove(root, { claude: false });
		assert.equal(projectFilesAbove(`${root}/a/b`, { claude: false }), inherited);
		await writeFile(`${root}/AGENTS.md`, 'x');
		assert.equal(projectFilesAbove(`${root}/a/b`, { claude: false }), path.join(root, 'AGENTS.md'));
		const fake = fakeServers();
		const pool = new OpenCodeServerPool({ spawn: fake.spawn, terminate: fake.terminate });
		const child = pool.playerDependencies({ request: async () => ({}) }).spawn('opencode', ['serve'], { cwd: `${root}/a/b`, env: launchEnv(`${root}/a/b`) });
		const error = await new Promise((resolve) => child.once('error', resolve));
		assert.match(error.message, /AGENTS\.md/);
		assert.equal(fake.spawned.length, 0);
	} finally { await rm(root, { recursive: true, force: true }); }
});
