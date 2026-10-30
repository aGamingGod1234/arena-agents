import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArenaScript } from '../src/arena-script/parser.mjs';
import { arenaScriptDiagnosticFields } from '../src/arena-script/errors.mjs';
import { toolResultContent } from '../src/native-minecraft-tools.mjs';
import { buildPlannerInput } from '../src/prompts.mjs';

function rejection(source) {
	try { parseArenaScript(source); assert.fail('invalid source compiled'); }
	catch (error) { assert.equal(error.name, 'ArenaScriptError'); return error; }
}

test('reports independent syntax, security, action-field and policy errors together with locations and fixes', () => {
	const error = rejection('const a = `template`;\nconst b = player["constructor"];\nawait player.mine({x:1,y:64,z:1,expectedBlockId:"minecraft:stone",wrong:true});');
	assert.deepEqual(error.diagnostics.map(({ code }) => code), ['UNSUPPORTED_SYNTAX', 'UNSAFE_MEMBER_ACCESS', 'UNKNOWN_FIELD', 'MISSING_UNHANDLED_POLICY']);
	assert.deepEqual(error.diagnostics.map(({ location }) => location.line), [1, 2, 3, 1]);
	assert.ok(error.diagnostics.every(({ fixHint, location }) => fixHint.length > 0 && fixHint.length <= 160 && Number.isInteger(location.column)));
	assert.match(error.diagnostics[0].fixHint, /quoted string/);
	assert.match(error.diagnostics[1].fixHint, /row.field/);
	assert.match(error.diagnostics[2].fixHint, /expectedBlockId/);
	assert.match(error.diagnostics[3].fixHint, /onUnhandledAttention/);
	assert.equal(error.diagnosticsTruncated, false);
	assert.ok(Object.isFrozen(error.diagnostics) && error.diagnostics.every(Object.isFrozen));
});

test('collects sibling errors inside callbacks, bad calls and distinct literal fields', () => {
	const error = rejection('program.onUnhandledAttention("pause_and_notify"); async function helper(){ const a = player["constructor"]; const b = `text`; } await player.mine({x:1,y:64,z:1,expectedBlockId:"minecraft:stone",a:1,b:2}); process.exit(missing);');
	assert.equal(error.diagnostics.filter(({ code }) => code === 'UNKNOWN_FIELD').length, 2);
	assert.equal(error.diagnostics.filter(({ message }) => /computed and optional/.test(message)).length, 1);
	assert.ok(error.diagnostics.some(({ message }) => /TemplateLiteral/.test(message)));
	assert.ok(error.diagnostics.some(({ message }) => /unapproved member call/.test(message)));
	assert.ok(error.diagnostics.some(({ message }) => /identifier missing/.test(message)));
});

test('alias rewriting collects fields and subsequent statements without duplicate direct-field errors', () => {
	const error = rejection('await mine({x:1,y:64,z:1,expectedBlockId:"minecraft:stone",bad:1,worse:2}); await act("move_to",{x:1,y:64,z:1,wrong:1}); const a = player["prototype"];');
	assert.equal(error.diagnostics.length, 4);
	assert.equal(error.diagnostics.filter(({ message }) => /does not accept field/.test(message)).length, 3);
	assert.equal(error.diagnosticsTruncated, false);
});

test('recursion, closure initialization and watcher purity remain rejecting alongside unrelated errors', () => {
	const error = rejection('program.onUnhandledAttention("pause_and_notify"); program.watch(()=>{player.wait(1);player.chat("x");return true;},{mode:"boundary"},async()=>{await player.chat("x");}); function a(){a();} const b=()=>later; b(); const later=1; const unsafe=player["constructor"];');
	assert.ok(error.diagnostics.some(({ code }) => code === 'RECURSION_FORBIDDEN'));
	assert.ok(error.diagnostics.some(({ message }) => /dependency later/.test(message)));
	assert.ok(error.diagnostics.some(({ message }) => /watcher handlers cannot call player.chat/.test(message)));
	assert.equal(error.diagnostics.filter(({ message }) => /only factual Arena APIs/.test(message)).length, 2);
});

test('diagnostics are bounded while later security errors still prevent compilation', () => {
	const error = rejection('program.onUnhandledAttention("pause_and_notify");' + Array.from({ length: 30 }, (_, i) => `const v${i}=player["constructor"];`).join(''));
	assert.equal(error.diagnostics.length, 12);
	assert.equal(error.diagnosticsTruncated, true);
	assert.ok(error.diagnostics.every(({ message }) => message.length <= 240));
	const content = toolResultContent({state:'FAILED', message:error.message.slice(0,512), ...arenaScriptDiagnosticFields(error)}, false);
	assert.equal(JSON.parse(content.contentItems[0].text).diagnostics.length, 12);
	assert.ok(Buffer.byteLength(JSON.stringify(content)) < 8192);
	assert.deepEqual(arenaScriptDiagnosticFields(new Error('ordinary failure')), {});
});

test('multiple reserved declarations and independent recursive components are rejected in one pass', () => {
	const error = rejection('const player=1; const world=2; function a(){a();} function b(){b();}');
	assert.equal(error.diagnostics.filter(({ message }) => /cannot be shadowed/.test(message)).length, 2);
	assert.equal(error.diagnostics.filter(({ code }) => code === 'RECURSION_FORBIDDEN').length, 2);
});

test('compiler correction retains the complete list beyond ordinary message truncation and rejects unsafe diagnostic records', () => {
	const error = rejection('program.onUnhandledAttention("pause_and_notify");' + Array.from({length:12}, (_,i) => `const row${i}=player["constructor"];`).join(''));
	const input = {decisionContext:'arena_script_compiler_error', compilerError:{code:error.code, message:error.message, line:1, column:0, ...arenaScriptDiagnosticFields(error)}, rejectedSourceHash:'sha256:test', observation:{}};
	const result = JSON.parse(buildPlannerInput(input).split('\n').slice(1).join('\n'));
	assert.deepEqual(result.compilerError.diagnostics, error.diagnostics);
	assert.ok(result.compilerError.message.length <= 2048);
	const unsafe = Object.defineProperty({}, 'fixHint', {enumerable:true, get(){assert.fail('getter invoked');}});
	assert.throws(() => buildPlannerInput({...input,compilerError:{...input.compilerError,diagnostics:[unsafe]}}), /own data/);
});

test('multibyte authored property names cannot overflow the bounded diagnostic response', () => {
	const fields = Array.from({length:12},(_,i)=>`${JSON.stringify('界'.repeat(250)+i)}:true`).join(',');
	const error = rejection(`program.onUnhandledAttention("pause_and_notify"); await player.wait({${fields}});`);
	assert.equal(error.diagnostics.length,12);
	assert.ok(error.diagnostics.every(({message})=>Buffer.byteLength(message,'utf8')<=240));
	const result = toolResultContent({state:'FAILED',message:error.message.slice(0,512),...arenaScriptDiagnosticFields(error)},false);
	assert.equal(JSON.parse(result.contentItems[0].text).diagnostics.length,12);
});

test('authored use-only text cannot contaminate field hints or abort planner correction', () => {
	const key = JSON.stringify('use only ' + 'é'.repeat(200));
	for (const call of [`player.wait({${key}:1})`, `mine({x:1,y:64,z:1,expectedBlockId:"minecraft:stone",${key}:1})`]) {
		const error = rejection(`program.onUnhandledAttention("pause_and_notify"); await ${call};`);
		assert.ok(error.diagnostics.every(({fixHint}) => Buffer.byteLength(fixHint) <= 160));
		assert.ok(error.diagnostics.every(({fixHint}) => !fixHint.includes('é')));
		assert.doesNotThrow(() => buildPlannerInput({decisionContext:'arena_script_compiler_error', compilerError:{code:error.code,message:error.message,line:1,column:0,...arenaScriptDiagnosticFields(error)},rejectedSourceHash:'sha256:test',observation:{}}));
	}
});

test('planner truncates oversized diagnostic text while retaining valid locations', () => {
	const input = {decisionContext:'arena_script_compiler_error',compilerError:{code:'UNKNOWN_FIELD',message:'bad field',line:1,column:0,diagnostics:[{code:'UNKNOWN_FIELD',message:'é'.repeat(200),fixHint:'界'.repeat(200),location:{start:0,end:10,line:1,column:0}}]},rejectedSourceHash:'sha256:test',observation:{}};
	const result = JSON.parse(buildPlannerInput(input).split('\n').slice(1).join('\n'));
	assert.ok(Buffer.byteLength(result.compilerError.diagnostics[0].message) <= 240);
	assert.ok(Buffer.byteLength(result.compilerError.diagnostics[0].fixHint) <= 160);
	assert.deepEqual(result.compilerError.diagnostics[0].location, {start:0,end:10,line:1,column:0});
});

test('JSON-escaped authored fields retain bounded diagnostics and a repair message', () => {
	const fields = Array.from({length:12},(_,i)=>`${JSON.stringify('use only ' + '\u0001'.repeat(230)+i)}:true`).join(',');
	const error = rejection(`program.onUnhandledAttention("pause_and_notify"); await player.wait({${fields}}); const unsafe=player["constructor"];`);
	assert.ok(Buffer.byteLength(JSON.stringify(error.diagnostics)) <= 8192);
	assert.equal(error.diagnosticsTruncated, true);
	const response = toolResultContent({state:'FAILED',reasonCode:error.code,message:error.message.slice(0,512),...arenaScriptDiagnosticFields(error)},false);
	const result = JSON.parse(response.contentItems[0].text);
	assert.ok(result.diagnostics.length > 0);
	assert.equal(result.diagnosticsTruncated, true);
	assert.match(result.failure.blockedBy, /UNKNOWN_FIELD/);
	assert.ok(Buffer.byteLength(response.contentItems[0].text) <= 16384);
});
