#!/usr/bin/env node
// Live model test. Operator commands construct the arena and introduce mobs, never drive the player.
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, runScenarios } from './run-scenarios.mjs';
import { evaluateRun, ladderRow } from './run-ladder.mjs';

const options = parseArgs(process.argv.slice(2));
if (!process.env.SLOT_PORT_BASE || options.portBase !== Number(process.env.SLOT_PORT_BASE)) throw new Error('Run under slot.sh live with --port-base "$SLOT_PORT_BASE"');
const definition = {
  id: 'REFLEX', name: 'reflex', seed: '20261017',
  goal: 'Stay alive for 100 seconds without dying.', durationBudgetMs: 120000,
  runPolicy: { clock: 'goal-start', continueAfterDeath: false },
  successCheck: 'survive_duration: 2000 ticks; any death fails attempt',
  setup: {
    dimension: 'minecraft:overworld', position: [0.5, 200, 0.5], time: 18000,
    freezeUntilGoalStart: true, weather: 'clear',
    commands: [
      'gamerule minecraft:send_command_feedback false',
      'gamerule minecraft:spawn_mobs false',
      'fill -32 195 -32 32 199 32 minecraft:stone',
      'fill -32 200 -32 32 206 32 minecraft:air',
      'fill -32 200 -32 -32 205 32 minecraft:stone',
      'fill 32 200 -32 32 205 32 minecraft:stone',
      'fill -32 200 -32 32 205 -32 minecraft:stone',
      'fill -32 200 32 32 205 32 minecraft:stone',
      'tp {agent} 0.5 200 0.5 0 0',
    ],
    inventory: [
      { item: 'minecraft:stone_sword', count: 1 }, { item: 'minecraft:stone_pickaxe', count: 1 },
      { item: 'minecraft:cobblestone', count: 32 }, { item: 'minecraft:cooked_beef', count: 8 },
    ], armour: {}, effects: [],
  },
};
await mkdir(options.out, { recursive: true });
await writeFile(path.join(options.out, 'fixture.json'), JSON.stringify({ definition, waves: [20000, 45000, 70000], note: 'Mobs introduced on surface nominally six blocks from current player, clamped inside arena, alternating front/back/side. Shelter remains valid defense.' }, null, 2));
const report = await runScenarios({ ...options, scenarios: ['REFLEX'], definitions: [definition] }, {
  onObserver(observer) {
    const poll = observer.poll.bind(observer);
    let wave = 0;
    observer.poll = async () => {
      await poll();
      if (!observer.startedAt || observer.endedAt || observer.playerInactive || !observer.preparationReleased || !observer.rcon) return;
      if (wave >= 3 || Date.now() - observer.startedAt < [20000, 45000, 70000][wave]) return;
      const index = wave++;
      const variant = (observer.definition.repetition - 1) % 3;
      const bearings = [[0, 6], [0, -6], [6, 0]];
      const [side, forward] = bearings[(index + variant) % 3];
      const mobs = index === 0 ? ['creeper'] : index === 1 ? ['zombie'] : ['creeper', 'zombie'];
      for (const [i, mob] of mobs.entries()) {
        const sign = i ? -1 : 1;
        const pos = (await observer.rcon.command(`data get entity ${observer.agent} Pos`)).text.match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number);
        const yaw = Number((await observer.rcon.command(`data get entity ${observer.agent} Rotation`)).text.match(/\[\s*(-?[\d.]+)f?/)?.[1]) * Math.PI / 180;
        if (!pos || !Number.isFinite(yaw)) throw new Error('REFLEX_POSITION_UNAVAILABLE');
        const clamp = n => Math.max(-26, Math.min(26, n));
        const x = clamp(pos[0] + sign * (side * Math.cos(yaw) - forward * Math.sin(yaw)));
        const z = clamp(pos[2] + sign * (side * Math.sin(yaw) + forward * Math.cos(yaw)));
        const command = `execute positioned ${x.toFixed(2)} 200 ${z.toFixed(2)} positioned over motion_blocking_no_leaves run summon minecraft:${mob} ~ ~ ~ {PersistenceRequired:1b,Tags:["reflex_wave_${index}"]}`;
        const at = Date.now();
        const receipt = await observer.rcon.command(command);
        await appendFile(path.join(observer.directory, 'reflex-waves.jsonl'), JSON.stringify({ at, wave: index, variant, mob, command, receipt }) + '\n');
        if (!/summoned/i.test(receipt.text)) throw new Error(`REFLEX_SPAWN_FAILED: ${receipt.text}`);
      }
    };
  },
});
for (const run of report.runs) run.evaluation = await evaluateRun(run, definition);
await writeFile(path.join(options.out, 'reflex-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.runs.map(ladderRow), null, 2));
// The underlying runner times out a survival goal; observed survival determines this fixture's result.
process.exitCode = report.runs.some(r => !r.evaluation.pass) ? 1 : 0;
