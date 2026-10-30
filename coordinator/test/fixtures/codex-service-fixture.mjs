import { EventEmitter } from 'node:events';
import { finishDecisionJson } from '../provider-decision-fixtures.mjs';
const MODEL = {
	id: 'gpt-5.6-sol',
	model: 'gpt-5.6-sol',
	supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
	serviceTiers: [{ id: 'fast' }, { id: 'priority' }],
};

class FakeSharedTransport extends EventEmitter {
	calls = [];
	threadSequence = 0;
	turnSequence = 0;
	autoComplete = true;
	rejectInterrupt = false;
	rejectRespond = false;
	holdTurnStart = false;
	turnStartResolvers = [];
	message = finishDecisionJson();

	async start() { this.calls.push({ method: '$start' }); }
	async stop() { this.calls.push({ method: '$stop' }); }
	notify(method, params) { this.calls.push({ method, params }); }
	respond(id, result) {
		this.calls.push({ method: '$respond', id, result });
		if (this.rejectRespond) return Promise.reject(Object.assign(new Error('response write failed'), { code: 'EPIPE' }));
	}

	async request(method, params, options) {
		this.calls.push({ method, params, options });
		if (method === 'initialize') return { userAgent: 'fake' };
		if (method === 'model/list') return { data: [MODEL], nextCursor: null };
		if (method === 'thread/start') return { thread: { id: `thread-${++this.threadSequence}` } };
		if (method === 'turn/start') {
			if (this.holdTurnStart) {
				return new Promise((resolve) => this.turnStartResolvers.push(resolve));
			}
			const turnId = `turn-${++this.turnSequence}`;
			if (this.autoComplete) queueMicrotask(() => this.complete(params.threadId, turnId));
			return { turn: { id: turnId } };
		}
		if (method === 'turn/interrupt') {
			if (this.rejectInterrupt) throw Object.assign(new Error('turn already completed'), { code: 'RPC_ERROR' });
			return {};
		}
		if (method === 'turn/steer') return { turnId: params.expectedTurnId };
		throw new Error(`Unexpected method ${method}`);
	}

	complete(threadId, turnId) {
		this.emit('notification', { method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', text: this.message } } });
		this.emit('notification', { method: 'turn/completed', params: { threadId, turnId, turn: { id: turnId, status: 'completed' } } });
	}
}

export { FakeSharedTransport };
