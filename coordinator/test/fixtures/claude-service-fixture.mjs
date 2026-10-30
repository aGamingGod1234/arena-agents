import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeProviderService } from '../../src/claude-service.mjs';
import { ClaudeToolServer } from '../../src/claude-tool-server.mjs';
const AGENTS_TEXT = '# Your role\nYou are the selected model controlling one persistent Minecraft player.';
const SKILL_TEXT = '---\nname: minecraft-control\n---\n# Minecraft player control';

/** Emulates the Claude Code stream-json CLI, including real MCP calls to the coordinator's tool server. */
class FakeClaudeCode extends EventEmitter {
	constructor(command, args, options, script) {
		super();
		this.command = command;
		this.args = args;
		this.options = options;
		this.pid = 4_242;
		this.exitCode = null;
		this.signalCode = null;
		this.lines = [];
		this.stdout = new EventEmitter();
		this.stdout.setEncoding = () => {};
		this.stderr = new EventEmitter();
		this.stdin = new EventEmitter();
		this.stdin.destroyed = false;
		this.stdin.write = (text) => { for (const line of String(text).split('\n').filter(Boolean)) this.#onLine(JSON.parse(line)); return true; };
		this.stdin.end = (text) => { if (typeof text === 'string') this.oneShotPrompt = text; };
		this.script = script;
		const configIndex = args.indexOf('--mcp-config');
		this.mcp = configIndex < 0 ? null : JSON.parse(args[configIndex + 1]).mcpServers.minecraft;
		if (script.rejectPartialMessages === true && args.includes('--include-partial-messages')) {
			queueMicrotask(() => { this.stderr.emit('data', "error: unknown option '--include-partial-messages'"); this.exit(1); });
			return;
		}
		if (this.mcp !== null) queueMicrotask(() => { this.connected = this.#connect().catch(() => {}); });
		else queueMicrotask(() => script.oneShot?.(this));
	}

	async rpc(method, params = {}, id = Math.random()) {
		const response = await fetch(this.mcp.url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...this.mcp.headers },
			body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
		});
		return response.json();
	}

	emitLine(value) { this.stdout.emit('data', `${JSON.stringify(value)}\n`); }

	exit(code = 0) {
		this.exitCode = code;
		this.emit('close', code, null);
	}

	async #connect() {
		await this.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code' } });
		await this.script.beforeToolsListed?.(this);
		this.tools = (await this.rpc('tools/list')).result.tools;
		this.emitLine({ type: 'system', subtype: 'init', session_id: 'session-1', model: this.args[this.args.indexOf('--model') + 1] });
	}

	#onLine(message) {
		this.lines.push(message);
		if (message.type === 'user') void Promise.resolve(this.connected).then(() => this.script.onUser?.(this, message.message.content)).catch(() => {});
		if (message.type === 'control_request' && message.request.subtype === 'interrupt' && this.script.ignoreInterrupt !== true) {
			this.emitLine({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
			this.emitLine({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'session-1' });
		}
	}
}

async function harness(script = {}, overrides = {}, dependencies = {}) {
	const root = await mkdtemp(path.join(tmpdir(), 'claude-service-'));
	const children = [];
	const toolServer = new ClaudeToolServer();
	const ProviderService = dependencies.ProviderService ?? ClaudeProviderService;
	const service = new ProviderService({
		provider: 'claude',
		cwd: root,
		runtimeRoot: path.join(root, 'claude'),
		planningTimeoutMs: 2_000,
		interruptTimeoutMs: 500,
		environment: { PATH: 'test', ANTHROPIC_API_KEY: 'anthropic-key', OPENAI_API_KEY: 'openai-key', ARENA_AGENT_BRIDGE_SECRET: 'bridge-secret' },
		bridgeSecretEnvironmentVariable: 'ARENA_AGENT_BRIDGE_SECRET',
		...overrides,
	}, {
		spawn(command, args, options) {
			const child = new FakeClaudeCode(command, args, options, script);
			children.push(child);
			return child;
		},
		terminate: dependencies.terminate ?? (async (child) => { if (child.exitCode === null) child.exit(0); }),
		toolServer,
		minecraftWorkspace: {
			root,
			prepare: async () => ({ cwd: path.join(root, 'workspace'), instructions: AGENTS_TEXT, skillInstructions: SKILL_TEXT }),
		},
	});
	return {
		root, service, children, toolServer,
		async close() {
			await service.stop();
			await toolServer.stop();
			await rm(root, { recursive: true, force: true });
		},
	};
}

function profile(overrides = {}) {
	return { agentId: 'claude-a', provider: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'medium', serviceTier: 'priority', ...overrides };
}

export { harness, profile, AGENTS_TEXT, SKILL_TEXT };
