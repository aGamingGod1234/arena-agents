import { readFile, writeFile, rename } from 'node:fs/promises';

async function writeAcknowledgement(file, text) {
	await writeFile(`${file}.tmp`, text);
	await rename(`${file}.tmp`, file);
}

/** A headless owner waits for this acknowledgement before killing any capture writers. */
export function watchCaptureShutdown(requestPath, shutdown, { intervalMs = 100, read = readFile, write = writeAcknowledgement } = {}) {
	if (!requestPath) return () => {};
	let active = false;
	const poll = async () => {
		if (active) return;
		active = true;
		try { await read(requestPath, 'utf8'); } catch (error) {
			if (error.code === 'ENOENT') { active = false; return; }
			active = true; clearInterval(timer);
			await write(`${requestPath}.closed`, JSON.stringify({ status: 'FAILED', error: String(error.message).slice(0, 512) }));
			return;
		}
		active = true;
		clearInterval(timer);
		try {
			await shutdown();
			await write(`${requestPath}.closed`, JSON.stringify({ status: 'CLOSED', at: Date.now() }));
		} catch (error) {
			await write(`${requestPath}.closed`, JSON.stringify({ status: 'FAILED', error: String(error.message).slice(0, 512) }));
		}
	};
	// If even the acknowledgement cannot be written, the owner reports its bounded close timeout.
	const timer = setInterval(() => { void poll().catch(() => {}); }, intervalMs);
	timer.unref();
	return () => clearInterval(timer);
}

/** Escalation still attempts to drain capture before terminating a stuck owned launcher. */
export async function requestCaptureShutdown(requestPath, { timeoutMs = 15_000, read = readFile, write = writeFile, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
	await write(requestPath, '{}');
	const deadline = now() + timeoutMs;
	while (now() < deadline) {
		let closed;
		try { closed = JSON.parse(await read(`${requestPath}.closed`, 'utf8')); }
		catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
		if (closed) {
			if (closed.status !== 'CLOSED') throw new Error(`Capture close failed: ${closed.error ?? closed.status}`);
			return closed;
		}
		await wait(Math.min(50, Math.max(0, deadline - now())));
	}
	throw new Error('Capture close acknowledgement timed out');
}
