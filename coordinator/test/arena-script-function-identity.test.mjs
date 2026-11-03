import assert from 'node:assert/strict';
import test from 'node:test';

import { ArenaScriptInterpreter } from '../src/arena-script/interpreter.mjs';
import { SCRIPT_BINDINGS } from '../src/arena-script/minecraft-api.mjs';
import { parseArenaScript } from '../src/arena-script/parser.mjs';

function start(source) {
	return new ArenaScriptInterpreter(parseArenaScript(`program.onUnhandledAttention("continue_and_notify"); ${source}`), SCRIPT_BINDINGS)
		.start({ player: { x: 0, y: 64, z: 0 }, world: {}, inventory: { tagCounts: {} } });
}

for (const [key, marker] of [['kind', 'arena-function'], ['builtin', 'tryResult']]) {
	test(`ordinary records with ${key}: ${marker} retain readable members`, () => {
		const command = start(`const record = {${key}: "${marker}", value: 7};
			await player.wait(record.${key} === "${marker}" && record.missing === null ? record.value : 0);`);
		assert.equal(command.kind, 'command');
		assert.equal(command.call.primitive, 'wait');
		assert.equal(command.call.arguments, 7);
	});

	test(`function-returned records with ${key}: ${marker} remain data`, () => {
		const command = start(`const make = () => ({${key}: "${marker}", value: 7});
			const box = {record: make()}; const alias = box.record; await player.wait(alias.value);`);
		assert.equal(command.kind, 'command');
		assert.equal(command.call.arguments, 7);
	});
}

for (const definition of [
	'function fn() { return 7; }',
	'const fn = () => 7;',
	'const fn = function () { return 7; };',
	'const fn = tryResult;',
]) {
	test(`actual functions stay opaque through aliases: ${definition}`, () => {
		for (const member of ['kind', 'builtin', 'node', 'environment', 'missing']) {
			assert.throws(() => start(`${definition} const box = {fn: fn}; const alias = box.fn; alias.${member};`),
				error => error.code === 'UNKNOWN_MEMBER' && error.message.includes(`functions have no member ${member}`));
		}
	});
}
