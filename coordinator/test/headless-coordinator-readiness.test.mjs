import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { windowsPowerShellEnv } from '../src/benchmark/windows-powershell-env.mjs';

test('Windows PowerShell readiness accepts authenticated evidence without hello_ack', { skip: process.platform !== 'win32' }, () => {
	const script = fileURLToPath(new URL('../../scripts/test-coordinator-readiness.ps1', import.meta.url));
	const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
		env: windowsPowerShellEnv(), encoding: 'utf8', timeout: 60_000, windowsHide: true,
	});
	assert.equal(result.status, 0, result.error?.message ?? result.stderr ?? result.stdout);
	assert.match(result.stdout, /Coordinator readiness checks passed/);
});
