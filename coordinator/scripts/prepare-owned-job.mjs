#!/usr/bin/env node
// Builds the Windows job wrapper's helper before the test suite, so no test with a short provider
// deadline pays the first compile. A no-op on other platforms.
import { prepareOwnedProcessHelper } from '../src/child-process-lifecycle.mjs';

const started = Date.now();
const result = await prepareOwnedProcessHelper();
if (process.platform === 'win32') {
	console.log(`owned job helper ${result.prepared ? 'ready' : 'not prepared'} in ${Date.now() - started} ms${result.error ? `: ${result.error}` : ''}`);
}
