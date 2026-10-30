// A runner that leaves a detached grandchild behind: the grandchild has its own stdio, ignores graceful termination,
// and the runner exits (or hangs, with 'hang') before any process snapshot can see the grandchild.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [pidFile, mode = 'exit'] = process.argv.slice(2);
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); setInterval(() => {}, 1000);'], {
	detached: true,
	stdio: 'ignore',
	windowsHide: true,
});
writeFileSync(pidFile, String(child.pid));
child.unref();
process.stdout.write(`${JSON.stringify({ status: 'passed', detachedChildPid: child.pid })}\n`);
if (mode === 'hang') setInterval(() => {}, 1000);
