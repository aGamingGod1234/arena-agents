#!/usr/bin/env node
// Render every train case through the chosen checkout's actual provider boundary.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const [checkout = '.', output = '/tmp/decision-inputs.json'] = process.argv.slice(2);
const root = path.resolve(checkout);
const { renderWake } = await import(pathToFileURL(path.join(root, 'coordinator/src/decision-eval/render.mjs')));
const { decodeModelFacts } = await import(pathToFileURL(path.join(root, 'coordinator/src/model-fact-encoding.mjs')));
const { minecraftCapabilities } = await import(pathToFileURL(path.join(root, 'coordinator/src/native-minecraft-tools.mjs')));
const { presentNativeToolResult } = await import(pathToFileURL(path.join(root, 'coordinator/src/codex-service.mjs')));
const { ModelObservationViews } = await import(pathToFileURL(path.join(root, 'coordinator/src/model-fact-encoding.mjs')));
const directory = path.join(root, 'coordinator/test/fixtures/decision-eval/train');
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1];
const cases = [];
const texts = [];
for (const name of (await readdir(directory)).filter(name => name.endsWith('.json')).sort()) {
 const fixture = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
 for (const testCase of fixture.cases) {
  const rendered = await renderWake(testCase, { provider: 'codex', model: 'gpt-6.1-sol' });
  const payload = decodeModelFacts(JSON.parse(rendered.encodedInput.slice(rendered.encodedInput.indexOf('\n') + 1)));
  cases.push({ id: testCase.id, quick: testCase.quick === true, bytes: rendered.encodedBytes,
   // A reproducible size proxy, not a tokenizer or provider billing measurement.
   estimatedTokens: Math.ceil(rendered.encodedBytes / 4),
   sections: Object.fromEntries(Object.entries(payload.observation ?? {}).map(([key, value]) => [key, bytes(value)])) });
  texts.push(rendered.encodedInput);
 }
}
const capabilities = [];
for (const section of ['all', 'program', 'control', 'strategy']) {
 const views = new ModelObservationViews();
 const tool = { kind: 'capabilities', section };
 const value = minecraftCapabilities({ section });
 const first = presentNativeToolResult(value, tool, views);
 first.commit();
 const repeat = presentNativeToolResult(value, tool, views);
 capabilities.push({ section, firstBytes: bytes(first.response.contentItems[0].text), repeatBytes: bytes(repeat.response.contentItems[0].text) });
 texts.push(first.response.contentItems[0].text, repeat.response.contentItems[0].text);
}
const sizes = cases.map(row => row.bytes);
const summary = { cases: cases.length, bytes: sizes.reduce((a, b) => a + b, 0), p50Bytes: percentile(sizes, .5), p95Bytes: percentile(sizes, .95),
 estimatedTokens: cases.reduce((n, row) => n + row.estimatedTokens, 0), tokenMethod: 'ceil(UTF-8 bytes / 4), estimate only' };
if (process.argv.includes('--tokens')) {
 // uv's isolated cache leaves the checkout's locked dependencies unchanged.
 const counts = JSON.parse(execFileSync('uv', ['run', '--no-project', '--with', 'tiktoken', 'python', '-c',
  'import json,sys,tiktoken; e=tiktoken.get_encoding("o200k_base"); print(json.dumps([len(e.encode(s,disallowed_special=())) for s in json.load(sys.stdin)]))'],
  { input: JSON.stringify(texts), maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }));
 cases.forEach((row, i) => { row.tokens = counts[i]; });
 capabilities.forEach((row, i) => { row.firstTokens = counts[cases.length + i * 2]; row.repeatTokens = counts[cases.length + i * 2 + 1]; });
 Object.assign(summary, { tokens: cases.reduce((n, row) => n + row.tokens, 0), p50Tokens: percentile(cases.map(row => row.tokens), .5),
  p95Tokens: percentile(cases.map(row => row.tokens), .95), tokenMethod: 'tiktoken o200k_base; model tokenizer proxy, not billing usage' });
}
await writeFile(output, JSON.stringify({ summary, capabilities, cases }, null, 2) + '\n');
console.log(JSON.stringify({ summary, capabilities }));
