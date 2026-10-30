// Explicit fake Minecraft/coordinator workload. Real processes and HTTP only.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

if (process.argv[2] === '--descendant') {
  setInterval(() => fs.appendFileSync(process.argv[3], 'x'), 25);
} else if (process.argv[2]) {
  void (async () => {
    const [matrixFile, fixtureRoot, fault = 'none'] = process.argv.slice(2);
    const matrix = JSON.parse(fs.readFileSync(matrixFile, 'utf8'));
    const scenario = matrix.scenarios[0];
    const matrixRoot = path.join(process.cwd(), 'runtime/headless-runs', 'strict-smoke-fixture-' + scenario.id);
    const runRoot = path.join(matrixRoot, 'run');
    const workspace = path.join(runRoot, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const protocolAudit = path.join(runRoot, 'protocol.jsonl');
    const providerTurns = path.join(runRoot, 'provider.jsonl');
    const trace = path.join(runRoot, 'coordinator.jsonl');
    const start = Date.now();
    const rows = ['no-goal', 'late'].includes(fault) ? [] : [{ direction: 'server_to_coordinator', at: start, envelope: { type: 'goal_control', agentId: 'smoke-agent', payload: { operation: 'start', goalRevision: 1, updatedAtEpochMs: start } } }];
    fs.writeFileSync(protocolAudit, rows.map(JSON.stringify).join('\n') + '\n');
    fs.writeFileSync(providerTurns, '');
    fs.writeFileSync(trace, '');
    fs.writeFileSync(path.join(runRoot, 'quality-setup.json'), JSON.stringify({ agent: 'SmokePlayer', definition: {} }));
    fs.writeFileSync(path.join(runRoot, 'manifest.json'), JSON.stringify({ scenarioId: scenario.id, protocolAudit, providerTurns, providerWorkspace: workspace, ports: { rcon: 1 } }));
    fs.writeFileSync(path.join(matrixRoot, 'matrix-manifest.json'), JSON.stringify(matrix));
    fs.writeFileSync(path.join(fixtureRoot, 'matrix-path.txt'), matrixRoot);
    spawn(process.execPath, [__filename, '--descendant', path.join(fixtureRoot, 'descendant-heartbeat.txt')], { stdio: 'inherit', windowsHide: true });
    setInterval(() => {}, 1000);
    // Let the production observer discover the authoritative goal-start before play.
    await new Promise(resolve => setTimeout(resolve, 350));
    // A coordinator without a goal makes no gameplay call. Playing anyway raced the driver's stop: an unmatched
    // gameplay row reached the evaluator only when the fixture won, turning INCOMPLETE into FAIL on loaded runners.
    if (fault === 'no-gameplay' || fault === 'no-goal') return;
    if (fault === 'bypass') for (let i = 0; i < 2; i++) {
      await fetch(process.env.SMOKE_MOCK_UPSTREAM + '/v1/messages', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 100000, messages: [{ role: 'user', content: 'opaque bypass' }] }),
      });
    }
    let firstBody;
    if (['duplicate-correlation', 'distinct-correlations'].includes(fault)) {
      const first = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 4096, messages: [{ role: 'user', content: 'first request' }] }) });
      firstBody = await first.json();
    }
    const response = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 4096, ...(fault === 'cache5m' ? { cache_control: { type: 'ephemeral', ttl: '5m' } } : {}), messages: [{ role: 'user', content: 'Beat the game. Observe the world and choose your next action.' }] }),
    });
    const body = await response.json();
    fs.writeFileSync(path.join(fixtureRoot, 'gameplay-response.json'), JSON.stringify({ status: response.status, body }));
    const usage = body.usage ?? {};
    const event = { event: 'native_model_call', agentId: 'smoke-agent', goalRevision: 1, modelCallId: body.id ?? 'smoke-call', at: Date.now(), startedAt: start + 350, endedAt: Date.now(), totalMs: 20, inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), outputTokens: usage.output_tokens ?? 0, cacheReadInputTokens: usage.cache_read_input_tokens ?? 0, cacheWriteInputTokens: usage.cache_creation_input_tokens ?? 0, partialMessagesAccepted: true, provider: 'claude', model: 'claude-opus-5-5' };
    const traceRows = [event, { ...event, event: 'native_token_usage', scope: 'thread_total' }];
    if (firstBody) {
      traceRows.splice(0, traceRows.length, event, { ...event, modelCallId: fault === 'duplicate-correlation' ? 'session-duplicate:' + body.id : 'session-first:' + firstBody.id }, { ...event, event: 'native_token_usage', scope: 'thread_total', inputTokens: 20, outputTokens: 200 });
      // A correction of the same raw physical call replaces its earlier row.
      if (fault === 'distinct-correlations') traceRows.unshift({ ...event, outputTokens: 50 });
    }
    if (fault === 'auxiliary') traceRows.push({ ...event, modelCallId: 'auxiliary-call', model: 'gpt-6.1-sol', provider: 'codex', goalRevision: 0 });
    if (fault === 'unaccounted') traceRows.push({ ...event, modelCallId: 'unaccounted-second-call' });
    if (fault === 'late') {
      const lateStart = Date.now() - 61000;
      fs.appendFileSync(protocolAudit, JSON.stringify({ direction: 'server_to_coordinator', at: lateStart, envelope: { type: 'goal_control', agentId: 'smoke-agent', payload: { operation: 'start', goalRevision: 1, updatedAtEpochMs: lateStart } } }) + '\n');
    }
    fs.appendFileSync(trace, traceRows.map(JSON.stringify).join('\n') + '\n');
    if (fault === 'damaged') fs.appendFileSync(trace, '{bad evidence}\n');
    if (fault === 'truncated') fs.appendFileSync(trace, '{"event":');
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
