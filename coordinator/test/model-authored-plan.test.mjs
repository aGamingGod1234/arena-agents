import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { NativeProgramExecutor } from '../src/native-program-executor.mjs';
import { normalizeMinecraftToolCall, toolAdjustments } from '../src/native-minecraft-tools.mjs';

const source = readFileSync(new URL('./fixtures/model-authored-plan.js.txt', import.meta.url), 'utf8');
const record = {agentId:'authored-plan',goalRevision:1,provider:'codex',model:'gpt-6.1-sol',reasoningEffort:'low',serviceTier:'priority'};

test('the authored fixture program gathers fresh drops, crafts a chain and travels by its exact authored fallback', async () => {
	let stage = 0, sequence = 1;
	const commands = [], decisions = [];
	const sample = () => ({player:{x:0,y:64,z:0,health:20},inventory:{items:stage >= 2 ? [{itemId:'minecraft:oak_log',count:1}] : [],tagCounts:stage >= 2 ? {'#minecraft:logs':1} : {}},
		blocks:stage === 0 ? [{stableId:'1,64,0',blockId:'minecraft:oak_log',x:1,y:64,z:0,tags:['#minecraft:logs']}] : [],
		items:stage === 1 ? [{stableId:'00000000-0000-4000-8000-000000000001',itemId:'minecraft:oak_log',count:1,x:1,y:64,z:0,tags:['#minecraft:logs']}] : [],entities:[]});
	const executor = new NativeProgramExecutor();
	const parameters = {resourceTag:'#minecraft:logs',targetCount:1,crafts:[{id:'minecraft:oak_planks',count:4},{id:'minecraft:stick',count:4}],route:[{x:10,y:64,z:0}],fallback:{x:4,y:64,z:0}};
	const result = await executor.run(record,{source,parameters,maxActions:16,timeoutMs:180000},{observation:sample(),eventSequence:sequence,
		executeAction:async command=>{
			commands.push(command);
			if(command.action.type==='break_block') stage=1;
			if(command.action.type==='pick_up_item') stage=2;
			const blocked=command.action.type==='navigate_to' && command.action.arguments.x===10;
			return {state:blocked?'FAILED':'SUCCEEDED',reasonCode:blocked?'NO_STANDABLE_PATH':'DONE'};
		},
		cancelAction:async()=>assert.fail('No authored phase required cancellation'),
		refreshObservation:async()=>({observation:sample(),eventSequence:++sequence}),onDecision:decision=>decisions.push(decision)});
	assert.equal(result.reasonCode,'PROGRAM_EXHAUSTED',JSON.stringify(result));
	assert.deepEqual(commands.map(command=>command.action.type),['break_block','pick_up_item','craft_inventory','craft_inventory','navigate_to','navigate_to']);
	assert.deepEqual(commands.filter(command=>command.action.type==='craft_inventory').map(command=>command.action.arguments.recipeId),parameters.crafts.map(recipe=>recipe.id));
	assert.equal(commands.at(-1).action.arguments.x,4);
	assert.equal(commands[1].action.arguments.targetSelector,'00000000-0000-4000-8000-000000000001');
	assert.ok(commands.every(command=>command.provenance.model===record.model && command.provenance.reasoningEffort==='low'));
	assert.deepEqual(decisions,[]);
});

test('long program budgets preserve requested values and cap only above the new explicit ceiling', () => {
	for (const tool of ['runProgram','queueProgram']) {
		const identity=tool==='queueProgram'?{afterProgramId:'program-1',goalRevision:1,programVersion:1,precondition:'true'}:{};
		const args={...identity,source,maxActions:1024,timeoutMs:600000,expectedDurationMs:180000};
		const accepted=normalizeMinecraftToolCall(tool,args);
		assert.equal(accepted.timeoutMs,600000);
		assert.equal(accepted.expectedDurationMs,180000);
		assert.equal(toolAdjustments(accepted),undefined);
		assert.throws(()=>normalizeMinecraftToolCall(tool,{...args,maxActions:1025}),{code:'INVALID_MINECRAFT_TOOL_ARGUMENTS'});
		const capped=normalizeMinecraftToolCall(tool,{...args,timeoutMs:600001,expectedDurationMs:600002});
		assert.equal(capped.timeoutMs,600000);
		assert.equal(capped.expectedDurationMs,600000);
		assert.ok(toolAdjustments(capped));
	}
});
