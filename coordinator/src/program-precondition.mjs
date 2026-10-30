import { parseArenaScriptPrecondition } from './arena-script/parser.mjs';
import { ArenaScriptInterpreter } from './arena-script/interpreter.mjs';
import { createInterpreterFacts } from './arena-script/facts.mjs';
import { SCRIPT_BINDINGS } from './arena-script/minecraft-api.mjs';
import { adaptObservation } from './observation-adapter.mjs';
import { validateProgramParameters } from './program-parameters.mjs';

const compiledPreconditions = new WeakSet();

/** Validates one bounded, read-only expression before it can be queued. */
export function compileProgramPrecondition(source) {
	try {
		const compiled = parseArenaScriptPrecondition(source);
		compiledPreconditions.add(compiled);
		return compiled;
	} catch (cause) {
		throw Object.assign(new TypeError('precondition must be one bounded, side-effect-free ArenaScript expression', { cause }), { code: 'INVALID_PROGRAM_PRECONDITION' });
	}
}

/** Evaluate against the caller's fresh observation; parameters remain independent literals. */
export function evaluateProgramPrecondition(precondition, { observation, parameters } = {}) {
	const compiled = typeof precondition === 'string' ? compileProgramPrecondition(precondition) : precondition;
	if (!compiledPreconditions.has(compiled)) throw Object.assign(new TypeError('precondition must be compiled by compileProgramPrecondition'), { code: 'INVALID_PROGRAM_PRECONDITION' });
	return evaluatePreconditionFacts(compiled, preconditionFacts(observation), parameters);
}

/**
 * Adapt one observation once, so several compiled conditions can read the same facts. Passing the previous sample's
 * facts shares every unchanged domain with it, as the program engine does for watchers.
 */
export function preconditionFacts(observation, previousFacts = null) {
	const raw = observation && Object.hasOwn(observation, 'ready') && (Object.hasOwn(observation, 'position') || observation.ready === false)
		? adaptObservation(observation) : observation;
	return createInterpreterFacts(raw, previousFacts);
}

export function evaluatePreconditionFacts(compiled, facts, parameters) {
	return preconditionEvaluator(compiled, parameters)(facts);
}

/** One started interpreter that re-evaluates its condition on each new sample, like a program's watcher. */
export function preconditionEvaluator(compiled, parameters) {
	if (!compiledPreconditions.has(compiled)) throw Object.assign(new TypeError('precondition must be compiled by compileProgramPrecondition'), { code: 'INVALID_PROGRAM_PRECONDITION' });
	const vm = new ArenaScriptInterpreter(compiled, SCRIPT_BINDINGS, { parameters: validateProgramParameters(parameters) });
	let started = false;
	return (facts) => {
		if (!started) { vm.start(facts); started = true; }
		return vm.evaluateWatcher('watcher-0', facts);
	};
}
