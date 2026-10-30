import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileTurn, fileTurnKey, readFileInTurn, replaceFile } from '../src/file-turns.mjs';

const windows = process.platform === 'win32';
async function directory(t) { const dir = await mkdtemp(path.join(os.tmpdir(), 'arena-file-turns-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
function settle() { return new Promise((resolve) => setImmediate(resolve)); }

test('Windows namespace spellings share one turn key', { skip: !windows }, () => {
	const drive = fileTurnKey(String.raw`C:\Dir\File.json`);
	for (const alias of [String.raw`\\?\C:\dir\file.json`, String.raw`\\.\C:\dir\file.json`, String.raw`\\?\C:\dir\sub\..\file.json`, 'C:/dir/file.json', path.toNamespacedPath(String.raw`C:\dir\file.json`)]) assert.equal(fileTurnKey(alias), drive, alias);
	const unc = fileTurnKey(String.raw`\\server\share\dir\file.json`);
	for (const alias of [String.raw`\\?\UNC\server\share\dir\file.json`, String.raw`\\?\unc\Server\Share\dir\file.json`, String.raw`\\?\UNC\server\share\dir\sub\..\file.json`, path.toNamespacedPath(String.raw`\\server\share\dir\file.json`)]) assert.equal(fileTurnKey(alias), unc, alias);
	assert.notEqual(fileTurnKey(String.raw`C:\dir\file.json`), fileTurnKey(String.raw`C:\dir\other.json`));
});

test('a namespaced spelling waits for the turn held under the plain spelling', async (t) => {
	const file = path.join(await directory(t), 'file.json'), alias = path.toNamespacedPath(file), started = [];
	let release; const gate = new Promise((resolve) => { release = resolve; });
	const first = fileTurn(file, async () => { started.push('plain'); await gate; });
	const second = fileTurn(alias, () => { started.push('namespaced'); });
	const third = fileTurn(file, () => { started.push('plain again'); });
	await settle();
	assert.deepEqual(started, ['plain'], 'later turns must wait while the plain spelling holds the file');
	release(); await Promise.all([first, second, third]);
	assert.deepEqual(started, ['plain', 'namespaced', 'plain again']);
	await replaceFile(alias, '{"a":1}', 'utf8');
	assert.equal(await readFileInTurn(file, 'utf8'), '{"a":1}');
});

test('taking a turn on the same path from inside its own turn is rejected and leaves the path free', async (t) => {
	const dir = await directory(t), file = path.join(dir, 'file.json'), other = path.join(dir, 'other.json');
	await assert.rejects(fileTurn(file, () => fileTurn(file, () => 'inner')), { code: 'FILE_TURN_REENTRY' });
	await assert.rejects(fileTurn(file, () => fileTurn(path.toNamespacedPath(file), () => 'inner')), { code: 'FILE_TURN_REENTRY' });
	await assert.rejects(fileTurn(file, () => fileTurn(other, () => fileTurn(file, () => 'inner'))), { code: 'FILE_TURN_REENTRY' });
	let unawaited;
	assert.equal(await fileTurn(file, async () => { unawaited = fileTurn(file, () => 'inner').catch((error) => error.code); return 'outer'; }), 'outer');
	assert.equal(await unawaited, 'FILE_TURN_REENTRY');
	assert.equal(await fileTurn(file, () => fileTurn(other, () => 'nested other path')), 'nested other path');
	assert.equal(await fileTurn(file, () => 'free'), 'free');
	await fileTurn(file, () => 'first'); assert.equal(await fileTurn(file, () => 'second'), 'second', 'the turn ends with its task');
});
