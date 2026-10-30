import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AgentWorkspaceManager } from '../src/agent-workspace.mjs';
import { MinecraftAgentWorkspace } from '../src/minecraft-agent-workspace.mjs';

test('creates a stable provider-scoped directory for each agent', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'arena-agent-workspaces-'));
	try {
		const manager = new AgentWorkspaceManager(root);
		const first = await manager.prepare('codex', 'agent-1');
		const second = await manager.prepare('codex', 'agent-2');
		const otherProvider = await manager.prepare('kimi', 'agent-1');

		assert.equal(first, path.join(root, 'codex', 'agent-1'));
		assert.notEqual(first, second);
		assert.notEqual(first, otherProvider);
		assert.equal((await stat(first)).isDirectory(), true);
		assert.equal(await manager.prepare('codex', 'agent-1'), first);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('rejects traversal and unsafe workspace segments', async () => {
	const manager = new AgentWorkspaceManager(path.join(os.tmpdir(), 'arena-agent-workspaces-safe'));
	await assert.rejects(() => manager.prepare('../codex', 'agent-1'), /safe path segment/);
	await assert.rejects(() => manager.prepare('codex', '..'), /safe path segment/);
	await assert.rejects(() => manager.prepare('codex', 'agent/escape'), /safe path segment/);
});

test('refreshes one shared native Minecraft workspace from bundled templates', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'minecraft-agent-workspace-'));
	const templateRoot = path.join(root, 'templates');
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(templateRoot, '.codex', 'skills', 'minecraft-control'), { recursive: true });
	await writeFile(path.join(templateRoot, 'AGENTS.md'), '# verified completion\n', 'utf8');
	await writeFile(
		path.join(templateRoot, '.codex', 'skills', 'minecraft-control', 'SKILL.md'),
		'# native Minecraft control\n',
		'utf8',
	);

	const workspace = new MinecraftAgentWorkspace({
		root: path.join(root, 'runtime', 'minecraft-agent'),
		templateRoot,
	});
	const first = await workspace.prepare();
	assert.deepEqual(first, {
		cwd: path.join(root, 'runtime', 'minecraft-agent', 'workspace'),
		codexHome: path.join(root, 'runtime', 'minecraft-agent', '.codex-home'),
		permissionProfile: 'minecraft',
		instructions: '# verified completion\n',
		skillInstructions: '# native Minecraft control\n',
		selectedCapabilityRoots: [{
			id: 'minecraft-control',
			location: {
				type: 'environment',
				environmentId: 'local',
				path: path.join(root, 'runtime', 'minecraft-agent', 'workspace', '.codex', 'skills', 'minecraft-control'),
			},
		}],
	});
	assert.ok(path.relative(first.cwd, first.codexHome).startsWith('..'), 'provider credentials must be outside the model workspace');
	assert.match(await readFile(path.join(first.codexHome, 'config.toml'), 'utf8'), /^default_permissions = "minecraft"\n\n\[permissions\.minecraft\.filesystem\]/);
	assert.equal(await readFile(path.join(first.cwd, 'AGENTS.md'), 'utf8'), '# verified completion\n');
	assert.equal(
		await readFile(path.join(first.cwd, '.codex', 'skills', 'minecraft-control', 'SKILL.md'), 'utf8'),
		'# native Minecraft control\n',
	);

	await writeFile(path.join(templateRoot, 'AGENTS.md'), '# refreshed verified completion\n', 'utf8');
	const second = await workspace.prepare();
	assert.equal(second.cwd, first.cwd);
	assert.deepEqual(second.selectedCapabilityRoots, first.selectedCapabilityRoots);
	assert.notEqual(second.instructions, first.instructions);
	assert.equal(await readFile(path.join(second.cwd, 'AGENTS.md'), 'utf8'), '# refreshed verified completion\n');
	assert.equal(second.instructions, '# refreshed verified completion\n');
});

test('does not rewrite unchanged shared Minecraft templates', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'minecraft-agent-workspace-cache-'));
	const templateRoot = path.join(root, 'templates');
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(templateRoot, '.codex', 'skills', 'minecraft-control'), { recursive: true });
	await writeFile(path.join(templateRoot, 'AGENTS.md'), '# agents\n', 'utf8');
	await writeFile(path.join(templateRoot, '.codex', 'skills', 'minecraft-control', 'SKILL.md'), '# skill\n', 'utf8');

	let writes = 0;
	const workspace = new MinecraftAgentWorkspace({ root: path.join(root, 'runtime'), templateRoot }, {
		sourceCodexHome: path.join(root, 'missing-user-codex-home'),
		fs: {
			async writeFile(...args) {
				writes += 1;
				return writeFile(...args);
			},
		},
	});
	await workspace.prepare();
	assert.equal(writes, 3);
	await workspace.prepare();
	assert.equal(writes, 3);

	await writeFile(path.join(workspace.root, 'workspace', 'AGENTS.md'), '# externally changed\n', 'utf8');
	await workspace.prepare();
	assert.equal(writes, 4);
	assert.equal(await readFile(path.join(workspace.root, 'workspace', 'AGENTS.md'), 'utf8'), '# agents\n');
});

test('synchronizes only auth into the isolated Codex home', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'minecraft-agent-codex-home-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sourceCodexHome = path.join(root, 'user-codex-home');
	const templateRoot = path.join(root, 'templates');
	await mkdir(path.join(templateRoot, '.codex', 'skills', 'minecraft-control'), { recursive: true });
	await mkdir(sourceCodexHome, { recursive: true });
	await writeFile(path.join(templateRoot, 'AGENTS.md'), '# Minecraft instructions\n', 'utf8');
	await writeFile(path.join(templateRoot, '.codex', 'skills', 'minecraft-control', 'SKILL.md'), '# Minecraft skill\n', 'utf8');
	await writeFile(path.join(sourceCodexHome, 'auth.json'), '{"tokens":"preserve"}\n', 'utf8');
	await writeFile(path.join(sourceCodexHome, 'AGENTS.md'), '# Lucas identity must not cross the boundary\n', 'utf8');
	await writeFile(path.join(sourceCodexHome, 'config.toml'), 'model = "user-model"\n', 'utf8');
	const staleCodexHome = path.join(root, 'runtime', 'minecraft-agent', '.codex-home');
	await mkdir(path.join(staleCodexHome, 'memories'), { recursive: true });
	await writeFile(path.join(staleCodexHome, 'AGENTS.md'), '# stale identity\n', 'utf8');
	await writeFile(path.join(staleCodexHome, 'config.toml'), 'model = "stale-model"\n', 'utf8');
	await writeFile(path.join(staleCodexHome, 'memories', 'old.md'), 'stale\n', 'utf8');

	const workspace = new MinecraftAgentWorkspace({
		root: path.join(root, 'runtime', 'minecraft-agent'),
		templateRoot,
	}, { sourceCodexHome });
	const prepared = await workspace.prepare();
	assert.equal(await readFile(path.join(prepared.codexHome, 'auth.json'), 'utf8'), '{"tokens":"preserve"}\n');
	await assert.rejects(() => readFile(path.join(prepared.codexHome, 'AGENTS.md'), 'utf8'), { code: 'ENOENT' });
	assert.match(await readFile(path.join(prepared.codexHome, 'config.toml'), 'utf8'), /":root" = "deny"/);
	assert.equal(prepared.permissionProfile, 'minecraft');
	await assert.rejects(() => readFile(path.join(prepared.codexHome, 'memories', 'old.md'), 'utf8'), { code: 'ENOENT' });
	await writeFile(path.join(prepared.codexHome, 'state.sqlite'), 'runtime state\n', 'utf8');
	await workspace.prepare();
	assert.equal(await readFile(path.join(prepared.codexHome, 'state.sqlite'), 'utf8'), 'runtime state\n');
	assert.equal(await readFile(path.join(prepared.cwd, 'AGENTS.md'), 'utf8'), '# Minecraft instructions\n');
});

test('preserves auth when the configured source is the isolated Codex home', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'minecraft-agent-codex-same-home-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const workspaceRoot = path.join(root, 'runtime', 'minecraft-agent');
	const templateRoot = path.join(root, 'templates');
	await mkdir(path.join(templateRoot, '.codex', 'skills', 'minecraft-control'), { recursive: true });
	await writeFile(path.join(templateRoot, 'AGENTS.md'), '# Minecraft instructions\n', 'utf8');
	await writeFile(path.join(templateRoot, '.codex', 'skills', 'minecraft-control', 'SKILL.md'), '# Minecraft skill\n', 'utf8');
	await mkdir(path.join(workspaceRoot, '.codex-home'), { recursive: true });
	await writeFile(path.join(workspaceRoot, '.codex-home', 'auth.json'), '{"tokens":"keep"}\n', 'utf8');

	const workspace = new MinecraftAgentWorkspace({ root: workspaceRoot, templateRoot }, {
		sourceCodexHome: path.join(workspaceRoot, '.codex-home'),
	});
	const prepared = await workspace.prepare();
	assert.equal(await readFile(path.join(prepared.codexHome, 'auth.json'), 'utf8'), '{"tokens":"keep"}\n');
});

test('re-syncs Codex auth when isolated credentials are missing or source rotates', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'minecraft-agent-codex-auth-resync-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sourceCodexHome = path.join(root, 'user-codex-home');
	const templateRoot = path.join(root, 'templates');
	await mkdir(path.join(templateRoot, '.codex', 'skills', 'minecraft-control'), { recursive: true });
	await mkdir(sourceCodexHome, { recursive: true });
	await writeFile(path.join(templateRoot, 'AGENTS.md'), '# Minecraft instructions\n', 'utf8');
	await writeFile(path.join(templateRoot, '.codex', 'skills', 'minecraft-control', 'SKILL.md'), '# Minecraft skill\n', 'utf8');

	const workspace = new MinecraftAgentWorkspace({
		root: path.join(root, 'runtime', 'minecraft-agent'),
		templateRoot,
	}, { sourceCodexHome });
	const prepared = await workspace.prepare();
	await assert.rejects(() => readFile(path.join(prepared.codexHome, 'auth.json'), 'utf8'), { code: 'ENOENT' });

	await writeFile(path.join(sourceCodexHome, 'auth.json'), '{"tokens":"first"}\n', 'utf8');
	await workspace.prepare();
	assert.equal(await readFile(path.join(prepared.codexHome, 'auth.json'), 'utf8'), '{"tokens":"first"}\n');

	await rm(path.join(prepared.codexHome, 'auth.json'));
	await workspace.prepare();
	assert.equal(await readFile(path.join(prepared.codexHome, 'auth.json'), 'utf8'), '{"tokens":"first"}\n');

	await writeFile(path.join(sourceCodexHome, 'auth.json'), '{"tokens":"rotated"}\n', 'utf8');
	await workspace.prepare();
	assert.equal(await readFile(path.join(prepared.codexHome, 'auth.json'), 'utf8'), '{"tokens":"rotated"}\n');

	await writeFile(path.join(prepared.codexHome, 'auth.json'), '{"tokens":"isolated-refresh"}\n', 'utf8');
	await writeFile(path.join(sourceCodexHome, 'auth.json'), '{"tokens":"source-again"}\n', 'utf8');
	await workspace.prepare();
	assert.equal(
		await readFile(path.join(prepared.codexHome, 'auth.json'), 'utf8'),
		'{"tokens":"isolated-refresh"}\n',
	);
});

test('bundled control references stay within the dedicated read-only skill root and outside base instructions', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'minecraft-agent-references-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const workspace = new MinecraftAgentWorkspace({
		root: path.join(root, 'runtime'),
		templateRoot: fileURLToPath(new URL('../config/minecraft-agent', import.meta.url)),
	}, { sourceCodexHome: path.join(root, 'missing-auth') });
	const prepared = await workspace.prepare();
	const reference = await readFile(new URL('../config/minecraft-agent/.codex/skills/minecraft-control/references/control-reference.md', import.meta.url), 'utf8');
	const copied = await readFile(path.join(prepared.cwd, '.codex', 'skills', 'minecraft-control', 'references', 'control-reference.md'), 'utf8');
	assert.equal(copied, reference);
	assert.ok(!prepared.skillInstructions.includes('```json executor-bad-call'));
	assert.match(prepared.skillInstructions, /capabilities\(\{section:"control"\}\)/);
	assert.ok(prepared.selectedCapabilityRoots[0].location.path.startsWith(prepared.cwd));
	const permissions = await readFile(path.join(prepared.codexHome, 'config.toml'), 'utf8');
	assert.match(permissions, /":root" = "deny"/);
	assert.match(permissions, /enabled = false/);
	assert.match(permissions, /" = "read"/);
});

test('uses a newer refresh of the same Codex login without replacing newer or different-account auth', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'minecraft-agent-codex-auth-refresh-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sourceCodexHome = path.join(root, 'source');
	const templateRoot = path.join(root, 'templates');
	await mkdir(path.join(templateRoot, '.codex', 'skills', 'minecraft-control'), { recursive: true });
	await mkdir(sourceCodexHome, { recursive: true });
	await writeFile(path.join(templateRoot, 'AGENTS.md'), '# Minecraft instructions\n');
	await writeFile(path.join(templateRoot, '.codex', 'skills', 'minecraft-control', 'SKILL.md'), '# Minecraft skill\n');
	const auth = (accountId, lastRefresh) => `${JSON.stringify({
		auth_mode: 'chatgpt', last_refresh: lastRefresh, tokens: { account_id: accountId, access_token: 'fixture' },
	})}\n`;
	const sourceAuth = path.join(sourceCodexHome, 'auth.json');
	const sourceContent = auth('same-account', '2026-09-25T00:00:00Z');
	await writeFile(sourceAuth, sourceContent);
	const workspace = new MinecraftAgentWorkspace({ root: path.join(root, 'runtime'), templateRoot }, { sourceCodexHome });
	const prepared = await workspace.prepare();
	const isolatedAuth = path.join(prepared.codexHome, 'auth.json');
	await writeFile(isolatedAuth, auth('same-account', '2026-09-05T00:00:00Z'));
	await workspace.prepare();
	assert.equal(await readFile(isolatedAuth, 'utf8'), sourceContent, 'unchanged source beats stale isolated refresh');
	await writeFile(isolatedAuth, auth('same-account', '2026-09-05T00:00:00Z'));
	await rm(path.join(root, 'runtime', '.auth-source.sha256'));
	await new MinecraftAgentWorkspace({ root: path.join(root, 'runtime'), templateRoot }, { sourceCodexHome }).prepare();
	assert.equal(await readFile(isolatedAuth, 'utf8'), sourceContent, 'legacy install with no baseline also recovers stale auth');

	const newerIsolated = auth('same-account', '2026-09-26T00:00:00Z');
	await writeFile(isolatedAuth, newerIsolated);
	await workspace.prepare();
	assert.equal(await readFile(isolatedAuth, 'utf8'), newerIsolated, 'newer isolated refresh remains usable');

	await writeFile(sourceAuth, auth('other-account', '2026-09-27T00:00:00Z'));
	await workspace.prepare();
	assert.equal(await readFile(isolatedAuth, 'utf8'), newerIsolated, 'another account cannot replace independent auth');
});

test('uses the platform Codex home for auth when CODEX_HOME is unset', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'minecraft-agent-default-codex-home-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const templateRoot = path.join(root, 'templates');
	await mkdir(path.join(templateRoot, '.codex', 'skills', 'minecraft-control'), { recursive: true });
	await writeFile(path.join(templateRoot, 'AGENTS.md'), '# Minecraft instructions\n', 'utf8');
	await writeFile(path.join(templateRoot, '.codex', 'skills', 'minecraft-control', 'SKILL.md'), '# Minecraft skill\n', 'utf8');
	const previousCodexHome = process.env.CODEX_HOME;
	delete process.env.CODEX_HOME;
	// Serve a synthetic credential at the platform default path so the test never reads the real one and a
	// failed copy cannot hide behind an absent source.
	const sourceAuth = path.join(os.homedir(), '.codex', 'auth.json');
	const syntheticAuth = '{"tokens":"synthetic-default-home"}\n';
	const withDefaultAuth = (present) => ({ fs: {
		readFile: async (file, ...args) => {
			if (path.resolve(String(file)) !== sourceAuth) return readFile(file, ...args);
			if (present) return syntheticAuth;
			throw Object.assign(new Error('absent'), { code: 'ENOENT' });
		},
	} });
	try {
		const workspace = new MinecraftAgentWorkspace({ root: path.join(root, 'runtime'), templateRoot }, withDefaultAuth(true));
		assert.equal(workspace.sourceCodexHome, path.join(os.homedir(), '.codex'));
		const prepared = await workspace.prepare();
		assert.equal(await readFile(path.join(prepared.codexHome, 'auth.json'), 'utf8'), syntheticAuth);
		assert.equal(await readFile(path.join(prepared.cwd, 'AGENTS.md'), 'utf8'), '# Minecraft instructions\n');

		const absent = new MinecraftAgentWorkspace({ root: path.join(root, 'runtime-absent'), templateRoot }, withDefaultAuth(false));
		const preparedAbsent = await absent.prepare();
		await assert.rejects(() => readFile(path.join(preparedAbsent.codexHome, 'auth.json'), 'utf8'), { code: 'ENOENT' });
	} finally {
		if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = previousCodexHome;
	}
});

for (const isolatedRefresh of [false, true]) test(`workspace restart preserves independently refreshed auth: ${isolatedRefresh}`, async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'minecraft-agent-codex-auth-restart-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sourceCodexHome = path.join(root, 'source');
	const templateRoot = path.join(root, 'templates');
	await mkdir(path.join(templateRoot, '.codex', 'skills', 'minecraft-control'), { recursive: true });
	await mkdir(sourceCodexHome, { recursive: true });
	await writeFile(path.join(templateRoot, 'AGENTS.md'), '# Minecraft instructions\n');
	await writeFile(path.join(templateRoot, '.codex', 'skills', 'minecraft-control', 'SKILL.md'), '# Minecraft skill\n');
	const options = { root: path.join(root, 'runtime'), templateRoot };
	const sourceAuth = path.join(sourceCodexHome, 'auth.json');
	await writeFile(sourceAuth, '{"tokens":"original-fixture"}\n');
	const first = await new MinecraftAgentWorkspace(options, { sourceCodexHome }).prepare();
	const isolatedAuth = path.join(first.codexHome, 'auth.json');
	if (isolatedRefresh) await writeFile(isolatedAuth, '{"tokens":"provider-refreshed-fixture"}\n');
	else await writeFile(sourceAuth, '{"tokens":"new-source-fixture"}\n');
	const restarted = new MinecraftAgentWorkspace(options, { sourceCodexHome });
	await restarted.prepare();
	assert.equal(await readFile(isolatedAuth, 'utf8'), isolatedRefresh ? '{"tokens":"provider-refreshed-fixture"}\n' : '{"tokens":"new-source-fixture"}\n');
	assert.equal(await readFile(sourceAuth, 'utf8'), isolatedRefresh ? '{"tokens":"original-fixture"}\n' : '{"tokens":"new-source-fixture"}\n');
});

async function credentialWorkspace(t, secureWindowsPath) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'minecraft-agent-dacl-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sourceCodexHome = path.join(root, 'source-home');
	const templateRoot = path.join(root, 'templates');
	await mkdir(path.join(templateRoot, '.codex', 'skills', 'minecraft-control'), { recursive: true });
	await mkdir(sourceCodexHome, { recursive: true });
	await writeFile(path.join(templateRoot, 'AGENTS.md'), '# Minecraft instructions\n', 'utf8');
	await writeFile(path.join(templateRoot, '.codex', 'skills', 'minecraft-control', 'SKILL.md'), '# Minecraft skill\n', 'utf8');
	await writeFile(path.join(sourceCodexHome, 'auth.json'), '{"tokens":"synthetic-dacl"}\n', 'utf8');
	const events = [];
	const create = () => new MinecraftAgentWorkspace({ root: path.join(root, 'custom-agent-root'), templateRoot }, {
		sourceCodexHome,
		platform: 'win32',
		secureWindowsPath: async (target, directory) => { events.push({ kind: 'secure', target, directory }); await secureWindowsPath(target, directory); },
		fs: { writeFile: async (file, content, ...args) => { events.push({ kind: 'write', target: String(file), bytes: String(content).length }); return writeFile(file, content, ...args); } },
	});
	return { workspace: create(), create, events };
}

test('Windows credential homes get an owner-only DACL before any credential bytes are written', async (t) => {
	const { workspace, create, events } = await credentialWorkspace(t, async () => {});
	const prepared = await workspace.prepare();
	const homeSecured = events.findIndex(({ kind, target, directory }) => kind === 'secure' && target === prepared.codexHome && directory === true);
	assert.ok(homeSecured >= 0, 'the isolated Codex home is secured');
	assert.ok(events.slice(0, homeSecured).every(({ kind, target }) => kind !== 'write' || !target.startsWith(prepared.codexHome)), 'nothing is written into the home before its DACL');
	const authWrite = events.findIndex(({ kind, target, bytes }) => kind === 'write' && bytes > 0 && path.basename(target).startsWith('.auth.json.'));
	assert.ok(authWrite > homeSecured, 'auth bytes are written only inside the already secured home');
	const authSecured = events.findIndex(({ kind, target, directory }) => kind === 'secure' && target === path.join(prepared.codexHome, 'auth.json') && directory === false);
	assert.ok(authSecured > authWrite, 'the committed auth file is secured and verified after it is written');
	assert.equal(events.filter(({ kind, bytes }) => kind === 'write' && bytes === 0).length, 0, 'no extra placeholder writes');

	// The same workspace verifies auth again only after rewriting it: an unchanged file costs no DACL call.
	events.length = 0;
	await workspace.prepare();
	assert.equal(events.some(({ kind }) => kind === 'secure'), false, 'an unchanged, already secured home and auth file are left alone');

	// A restarted workspace does not rewrite an unchanged auth.json; it still repairs that file's DACL.
	events.length = 0;
	await create().prepare();
	assert.equal(events.some(({ kind, target }) => kind === 'write' && path.basename(target).startsWith('.auth.json.')), false);
	assert.ok(events.some(({ kind, target, directory }) => kind === 'secure' && target === path.join(prepared.codexHome, 'auth.json') && directory === false));
});

test('a Windows DACL failure rejects preparation before credentials are copied', async (t) => {
	const { workspace, events } = await credentialWorkspace(t, async () => { throw new Error('Unable to enforce private artifact permissions'); });
	await assert.rejects(() => workspace.prepare(), /Unable to enforce private artifact permissions/);
	assert.equal(events.some(({ kind, bytes }) => kind === 'write' && bytes > 0), false, 'no credential bytes are written');
	await assert.rejects(() => readFile(path.join(workspace.codexHome, 'auth.json'), 'utf8'), { code: 'ENOENT' });
});

async function defaultAdapterWorkspace(t, report) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'minecraft-agent-dacl-default-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sourceCodexHome = path.join(root, 'source-home');
	const templateRoot = path.join(root, 'templates');
	await mkdir(path.join(templateRoot, '.codex', 'skills', 'minecraft-control'), { recursive: true });
	await mkdir(sourceCodexHome, { recursive: true });
	await writeFile(path.join(templateRoot, 'AGENTS.md'), '# Minecraft instructions\n', 'utf8');
	await writeFile(path.join(templateRoot, '.codex', 'skills', 'minecraft-control', 'SKILL.md'), '# Minecraft skill\n', 'utf8');
	await writeFile(path.join(sourceCodexHome, 'auth.json'), '{"tokens":"synthetic-default-adapter"}\n', 'utf8');
	const sid = 'S-1-5-21-1000-2000-3000-1001';
	const acl = [];
	// Only the SID lookup and PowerShell ACL execution are replaced; the workspace's default adapter and
	// applyWindowsOwnerOnlyDacl's read-back verification stay in the path.
	const create = () => new MinecraftAgentWorkspace({ root: path.join(root, 'custom-agent-root'), templateRoot }, {
		sourceCodexHome,
		platform: 'win32',
		windowsAcl: {
			currentWindowsSid: async () => sid,
			runWindowsAcl: async ({ target, directory, sid: requested }) => {
				let content = null;
				if (!directory) content = await readFile(target, 'utf8');
				acl.push({ target, directory, sid: requested, content });
				return JSON.stringify(report({ sid: requested, directory }));
			},
		},
	});
	return { create, acl };
}

const ownerOnly = ({ sid, directory }) => ({ protected: true, entries: [{ sid, type: 'Allow', inherited: false, rights: 0x1f01ff, inheritance: directory ? 3 : 0 }] });

test('the default Windows adapter applies and verifies the owner-only DACL on the credential home and files', async (t) => {
	const { create, acl } = await defaultAdapterWorkspace(t, ownerOnly);
	const workspace = create();
	const prepared = await workspace.prepare();
	assert.ok(acl.some(({ target, directory }) => target === prepared.codexHome && directory === true), 'the home DACL is applied');
	const auth = acl.find(({ target }) => target === path.join(prepared.codexHome, 'auth.json'));
	assert.ok(auth, 'the written auth file DACL is applied and verified');
	assert.equal(auth.content, '{"tokens":"synthetic-default-adapter"}\n', 'it is the committed credential that is verified');
	assert.ok(acl.findIndex(({ target }) => target === prepared.codexHome) < acl.indexOf(auth), 'the home is secured first');
	assert.ok(acl.every(({ sid }) => sid === 'S-1-5-21-1000-2000-3000-1001'));
	assert.equal(await readFile(path.join(prepared.codexHome, 'auth.json'), 'utf8'), '{"tokens":"synthetic-default-adapter"}\n');

	acl.length = 0;
	await create().prepare();
	assert.ok(acl.some(({ target, directory }) => target === path.join(prepared.codexHome, 'auth.json') && directory === false),
		'a restarted workspace repairs the unchanged auth file through the default adapter');
});

test('the default Windows adapter rejects a DACL read-back that still grants broad access', async (t) => {
	const broad = ({ sid, directory }) => ({ protected: false, entries: [
		{ sid, type: 'Allow', inherited: false, rights: 0x1f01ff, inheritance: directory ? 3 : 0 },
		{ sid: 'S-1-5-32-545', type: 'Allow', inherited: true, rights: 0x1200a9, inheritance: 0 },
	] });
	const { create } = await defaultAdapterWorkspace(t, broad);
	const workspace = create();
	await assert.rejects(() => workspace.prepare(), /Unable to enforce private artifact permissions/);
	await assert.rejects(() => readFile(path.join(workspace.codexHome, 'auth.json'), 'utf8'), { code: 'ENOENT' });
});

test('on Windows the real default adapter leaves the credential home and auth file owner-only', { skip: process.platform !== 'win32', timeout: 120_000 }, async (t) => {
	const { execFile } = await import('node:child_process');
	const { promisify } = await import('node:util');
	const run = promisify(execFile);
	const root = await mkdtemp(path.join(os.tmpdir(), 'minecraft-agent-real-dacl-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sourceCodexHome = path.join(root, 'source-home');
	const templateRoot = path.join(root, 'templates');
	await mkdir(path.join(templateRoot, '.codex', 'skills', 'minecraft-control'), { recursive: true });
	await mkdir(sourceCodexHome, { recursive: true });
	await writeFile(path.join(templateRoot, 'AGENTS.md'), '# Minecraft instructions\n', 'utf8');
	await writeFile(path.join(templateRoot, '.codex', 'skills', 'minecraft-control', 'SKILL.md'), '# Minecraft skill\n', 'utf8');
	await writeFile(path.join(sourceCodexHome, 'auth.json'), '{"tokens":"synthetic-real-dacl"}\n', 'utf8');
	const prepared = await new MinecraftAgentWorkspace({ root: path.join(root, 'agent-root'), templateRoot }, { sourceCodexHome }).prepare();
	// Read the ACLs back independently of the code that set them.
	const read = async (target) => JSON.parse((await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
		'$ProgressPreference = "SilentlyContinue"; $acl = Get-Acl -LiteralPath $env:ACL_TARGET; '
		+ '[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; owner = $acl.Owner; '
		+ 'entries = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }) } | ConvertTo-Json -Compress'],
	{ env: { ...process.env, ACL_TARGET: target }, windowsHide: true })).stdout);
	const user = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
		'[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { windowsHide: true })).stdout.trim();
	for (const target of [prepared.codexHome, path.join(prepared.codexHome, 'auth.json'), path.join(prepared.codexHome, 'config.toml')]) {
		const acl = await read(target);
		const entries = [].concat(acl.entries);
		assert.ok(entries.length > 0 && entries.every((sid) => sid === user), `${target} grants only the current user: ${JSON.stringify(acl)}`);
	}
	assert.equal((await read(prepared.codexHome)).protected, true, 'the home does not inherit its parent');
	assert.equal((await read(path.join(prepared.codexHome, 'auth.json'))).protected, true, 'auth.json has an explicit owner-only DACL');
	assert.equal(await readFile(path.join(prepared.codexHome, 'auth.json'), 'utf8'), '{"tokens":"synthetic-real-dacl"}\n');
});
