import { randomBytes } from 'node:crypto';
import http from 'node:http';

import { MINECRAFT_DYNAMIC_TOOLS } from './native-minecraft-tools.mjs';

const MCP_PATH = '/mcp';
const MAX_REQUEST_BYTES = 1_024 * 1_024;
const SERVER_INFO = Object.freeze({ name: 'minecraft', title: 'Arena Agents Minecraft tools', version: '1.0.0' });
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';
// JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/**
 * Serves the exact native Minecraft tool set to Claude Code over loopback MCP
 * (Streamable HTTP, JSON responses). Codex receives the same tools as app-server
 * dynamic tools; each Claude agent gets its own bearer token so a process can only
 * reach the body it was launched for.
 */
export class ClaudeToolServer {
	#routes = new Map();
	#server = null;
	#starting = null;
	#port = null;
	// Each stop starts a new generation so listens and registrations begun earlier cannot outlive it.
	#generation = 0;
	#tools = MINECRAFT_DYNAMIC_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

	/** Registers one agent route. `callTool(name, args, meta)` returns MCP tool-call content. */
	async register({ callTool, onToolsListed = () => {}, onToolResponded = () => {} }) {
		if (typeof callTool !== 'function') throw new TypeError('callTool must be a function');
		const generation = this.#generation;
		await this.#start();
		if (generation !== this.#generation) throw stoppedError();
		const token = randomBytes(32).toString('hex');
		this.#routes.set(token, { callTool, onToolsListed, onToolResponded });
		return {
			url: `http://127.0.0.1:${this.#port}${MCP_PATH}`,
			token,
			unregister: () => { this.#routes.delete(token); },
		};
	}

	async stop() {
		this.#generation += 1;
		this.#routes.clear();
		const server = this.#server;
		const starting = this.#starting;
		this.#server = null;
		this.#starting = null;
		this.#port = null;
		if (server !== null) {
			server.closeAllConnections?.();
			await new Promise((resolve) => server.close(() => resolve()));
		}
		// A listen still pending closes its own server before it settles.
		await starting?.catch(() => {});
	}

	#start() {
		if (this.#server !== null) return Promise.resolve();
		const generation = this.#generation;
		this.#starting ??= new Promise((resolve, reject) => {
			const server = http.createServer((request, response) => { void this.#handle(request, response); });
			// Tool calls such as runProgram legitimately hold a request open for minutes.
			server.requestTimeout = 0;
			server.headersTimeout = 30_000;
			server.once('error', (error) => { this.#starting = null; reject(error); });
			server.listen(0, '127.0.0.1', () => {
				server.unref();
				if (generation !== this.#generation) {
					server.close(() => reject(stoppedError()));
					return;
				}
				this.#server = server;
				this.#port = server.address().port;
				resolve();
			});
		});
		return this.#starting;
	}

	async #handle(request, response) {
		// Every error after the id is known echoes it: Claude Code matches responses by id, and an unmatched
		// error leaves the call hanging until MCP_TOOL_TIMEOUT. Only an unreadable body or one without a
		// usable id is answered with a null id.
		let id = null;
		try {
			if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== MCP_PATH) return send(response, 404);
			const route = this.#routes.get(bearerToken(request.headers.authorization));
			if (route === undefined) return send(response, 401);
			// The JSON-response flavour of Streamable HTTP has no server-initiated stream.
			if (request.method !== 'POST') return send(response, 405, null, { allow: 'POST' });
			const body = await readBody(request);
			if (body === null) return sendJson(response, rpcError(null, INVALID_REQUEST, 'MCP request exceeded the size limit'));
			let message;
			try { message = JSON.parse(body); } catch { return sendJson(response, rpcError(null, PARSE_ERROR, 'Parse error')); }
			if (message === null || typeof message !== 'object' || Array.isArray(message)) {
				return sendJson(response, rpcError(null, INVALID_REQUEST, 'Expected one JSON-RPC message'));
			}
			if (message.id === undefined || message.id === null) return send(response, 202);
			if (typeof message.id !== 'string' && typeof message.id !== 'number') {
				return sendJson(response, rpcError(null, INVALID_REQUEST, 'JSON-RPC id must be a string or number'));
			}
			id = message.id;
			if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
				return sendJson(response, rpcError(id, INVALID_REQUEST, 'Expected a JSON-RPC 2.0 request with a method'));
			}
			if (message.params !== undefined && (message.params === null || typeof message.params !== 'object')) {
				return sendJson(response, rpcError(id, INVALID_PARAMS, 'params must be an object or array'));
			}
			sendJson(response, await this.#dispatch(route, message, response));
		} catch (error) {
			if (!response.headersSent) sendJson(response, rpcError(id, INTERNAL_ERROR, String(error?.message ?? error).slice(0, 256)));
		}
	}

	async #dispatch(route, { id, method, params }, response) {
		switch (method) {
			case 'initialize':
				return rpcResult(id, {
					protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : FALLBACK_PROTOCOL_VERSION,
					capabilities: { tools: { listChanged: false } },
					serverInfo: SERVER_INFO,
				});
			case 'ping':
				return rpcResult(id, {});
			case 'tools/list':
				try { route.onToolsListed(); } catch { /* readiness reporting cannot fail discovery */ }
				return rpcResult(id, { tools: this.#tools });
			case 'tools/call': {
				if (typeof params?.name !== 'string') return rpcError(id, INVALID_PARAMS, 'tools/call requires a tool name');
				if (params.arguments !== undefined && (params.arguments === null || typeof params.arguments !== 'object' || Array.isArray(params.arguments))) {
					return rpcError(id, INVALID_PARAMS, 'tools/call arguments must be an object');
				}
				const toolUseId = typeof params?._meta?.['claudecode/toolUseId'] === 'string' ? params._meta['claudecode/toolUseId'] : null;
				const result = await route.callTool(params.name, params.arguments ?? {}, { toolUseId });
				// 'finish' fires once the tool result has been handed to the operating system, the last point this process controls.
				response.once('finish', () => { try { route.onToolResponded({ toolUseId }); } catch { /* latency tracing cannot fail delivery */ } });
				return rpcResult(id, result);
			}
			default:
				return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${String(method).slice(0, 64)}`);
		}
	}
}

function stoppedError() {
	return Object.assign(new Error('Claude tool server was stopped'), { code: 'PROVIDER_STOPPED' });
}

function bearerToken(header) {
	const match = /^Bearer ([0-9a-f]{64})$/.exec(typeof header === 'string' ? header : '');
	return match === null ? null : match[1];
}

/** Returns the request body as text, or null when it exceeds the size limit. */
async function readBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_REQUEST_BYTES) return null;
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

function send(response, status, body = null, headers = {}) {
	response.writeHead(status, headers);
	response.end(body ?? undefined);
}

function sendJson(response, value) {
	send(response, 200, JSON.stringify(value), { 'content-type': 'application/json' });
}
