/** Evaluator-owned fixture data. None of these facts is appended to the model goal. */
export function normalizeQualitySetup(value) {
	if (!value || !['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'].includes(value.dimension)) throw new TypeError('qualitySetup.dimension is required');
	if (value.startAt !== undefined && (value.startAt !== 'world_spawn' || value.dimension !== 'minecraft:overworld' || value.position !== undefined || value.locate !== undefined)) throw new TypeError('qualitySetup.startAt world_spawn is overworld-only and excludes position and locate');
	if (value.startAt !== 'world_spawn' && (!Array.isArray(value.position) || value.position.length !== 3 || value.position.some(n => !Number.isFinite(n) || Math.abs(n) > 29_000_000))) throw new TypeError('qualitySetup.position must have three finite coordinates');
	if (value.airBlock !== undefined && !['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'].includes(value.airBlock)) throw new TypeError('qualitySetup.airBlock must be an air variant');
	if (value.standingOn !== undefined && !/^#?minecraft:[a-z0-9_\/]+$/.test(value.standingOn)) throw new TypeError('qualitySetup.standingOn must be a block or block tag');
	if (value.settleTicks !== undefined && (!Number.isInteger(value.settleTicks) || value.settleTicks < 1 || value.settleTicks > 100)) throw new TypeError('qualitySetup.settleTicks must be 1..100');
	if (value.loadChunks !== undefined && (!Array.isArray(value.loadChunks) || value.loadChunks.length > 8 || value.loadChunks.some(c => !['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'].includes(c.dimension) || !Array.isArray(c.position) || c.position.length !== 3 || c.position.some(n => !Number.isFinite(n) || Math.abs(n) > 29_000_000)))) throw new TypeError('qualitySetup.loadChunks must contain bounded dimension/position pairs');
	if (value.foodLevelTarget !== undefined && (!Number.isInteger(value.foodLevelTarget) || value.foodLevelTarget < 1 || value.foodLevelTarget > 19)) throw new TypeError('qualitySetup.foodLevelTarget must be 1..19');
	if (value.requireCover !== undefined && typeof value.requireCover !== 'boolean') throw new TypeError('qualitySetup.requireCover must be boolean');
	if (value.activation !== undefined && value.activation !== 'first-decision') throw new TypeError('Invalid activation stage');
	if (value.weather !== undefined && !['clear', 'rain', 'thunder'].includes(value.weather)) throw new TypeError('qualitySetup.weather is invalid');
	if (value.hungerSetupTicks !== undefined && (!Number.isInteger(value.hungerSetupTicks) || value.hungerSetupTicks < 1 || value.hungerSetupTicks > 20)) throw new TypeError('qualitySetup.hungerSetupTicks must be 1..20');
	if (value.randomSalt !== undefined && (!Number.isInteger(value.randomSalt) || value.randomSalt < -2147483648 || value.randomSalt > 2147483647)) throw new TypeError('qualitySetup.randomSalt must be a 32-bit integer');
	if (value.usedBedSpawn !== undefined && (value.usedBedSpawn.dimension !== 'minecraft:overworld' || !Array.isArray(value.usedBedSpawn.position) || value.usedBedSpawn.position.length !== 3 || value.usedBedSpawn.position.some(n => !Number.isInteger(n) || Math.abs(n) > 29_000_000))) throw new TypeError('qualitySetup.usedBedSpawn needs an Overworld bed position');
	if (value.finalCommands !== undefined && (!Array.isArray(value.finalCommands) || value.finalCommands.length > 128 || value.finalCommands.some(c => typeof c !== 'string' || /[\r\n]/.test(c) || c.length > 4096))) throw new TypeError('qualitySetup.finalCommands must contain bounded single-line commands');
	if (!Array.isArray(value.commands) || value.commands.length > 128 || value.commands.some(c => typeof c !== 'string' || /[\r\n]/.test(c) || c.length > 4096)) throw new TypeError('qualitySetup.commands must contain bounded single-line RCON commands');
	return structuredClone(value);
}

export function parseLocatedPosition(text) {
	const match = String(text).match(/\[\s*(-?\d+)\s*,\s*(?:-?\d+|~)\s*,\s*(-?\d+)\s*\]/);
	if (!match) throw new Error(`QUALITY_SETUP_LOCATION: ${text}`);
	return [Number(match[1]), Number(match[2])];
}

// Cover against ghast fire: a solid roof 2..6 blocks above the feet and a solid block beside the head.
export async function qualityCovered(command, dimension, at) {
	const solid = offset => `unless block ${offset} minecraft:air unless block ${offset} minecraft:cave_air unless block ${offset} minecraft:lava`;
	const anyOf = async texts => { for (const text of texts) if (/time is \d+/i.test(String((await command(text)).text))) return true; return false; };
	const roof = [2,3,4,5,6].map(h => `execute in ${dimension} positioned ${at} ${solid(`~ ~${h} ~`)} run time query gametime`);
	const wall = [[1,0],[-1,0],[0,1],[0,-1]].map(([wx,wz]) => `execute in ${dimension} positioned ${at} ${solid(`~${wx} ~1 ~${wz}`)} run time query gametime`);
	return await anyOf(roof) && await anyOf(wall);
}

export async function applyQualitySetup(value, command, agent) {
	const setup = normalizeQualitySetup(value);
	const receipts = [];
	let fixtureActor=agent, probeCreated=false;
	const probe=`@e[type=minecraft:armor_stand,tag=qo_prepare_${agent},limit=1]`;
	const run = async text => {
		const result = await command(text.replaceAll('{agent}', fixtureActor));
		const response = String(result.text ?? result);
		if (/unknown|incorrect argument|no entity was found|no player was found|not a valid|failed|could not|not loaded|is invulnerable/i.test(response) && !( /\brun kill\b|^kill\b/.test(text) && /no entity was found/i.test(response))) throw new Error(`QUALITY_SETUP: ${text}: ${response}`);
		receipts.push({ command: text, response });
	};
	// Build around an evaluator-only marker; the real player stays in survival throughout.
	// Otherwise an arm can retain construction observations in its first model input.
	if(setup.generality) await run('gamerule send_command_feedback false');
	if (setup.freezeUntilGoalStart) await run('tick freeze');
	if(!setup.generality) await run('gamemode creative {agent}');
	if (setup.locate) {
		if (!['biome', 'structure'].includes(setup.locate.type) || !/^minecraft:[a-z0-9_\/]+$/.test(setup.locate.id)) throw new TypeError('Invalid qualitySetup.locate');
		const text = `execute in ${setup.dimension} positioned ${setup.position.join(' ')} run locate ${setup.locate.type} ${setup.locate.id}`;
		const response = (await command(text)).text;
		const [lx, lz] = parseLocatedPosition(response);
		setup.locationTarget = [lx, lz];
		setup.position = [lx + .5 + (setup.locate.offset?.[0] ?? 0), setup.position[1], lz + .5 + (setup.locate.offset?.[1] ?? 0)];
		receipts.push({ command: text, response });
	}
	if (setup.startAt === 'world_spawn') {
		// The launcher already summoned the player at the generated world spawn, where a fresh vanilla player starts.
		const pos = String((await command(`data get entity ${agent} Pos`)).text).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/);
		if (!pos) throw new Error('QUALITY_SETUP_POSITION');
		setup.position = [+pos[1], +pos[2], +pos[3]];
	}
	const [x, y, z] = setup.position;
	const ticket = setup.generality ? `${Math.floor(x)-64} ${Math.floor(z)-64} ${Math.floor(x)+64} ${Math.floor(z)+64}` : `${Math.floor(x)} ${Math.floor(z)}`;
	await run(`execute in ${setup.dimension} run forceload add ${ticket}`);
	const extraTickets = [];
	try {
		for (const chunk of setup.loadChunks ?? []) {
			const ticket = `${Math.floor(chunk.position[0])} ${Math.floor(chunk.position[2])}`;
			await run(`execute in ${chunk.dimension} run forceload add ${ticket}`);
			extraTickets.push({ ...chunk, ticket });
		}
		if (setup.generality || setup.naturalCave || setup.standingOn || setup.loadChunks?.length) {
			for (const chunk of [{ dimension: setup.dimension, position: [x,y,z] }, ...(setup.loadChunks ?? [])]) {
				for (let wait = 0; wait < 100; wait++) {
					const response = String((await command(`execute in ${chunk.dimension} if loaded ${chunk.position.map(Math.floor).join(' ')} run time query gametime`)).text);
					if (/time is \d+/i.test(response)) break;
					await command('tick step 1');
					await new Promise(resolve => setTimeout(resolve, 100));
					if (wait === 99) throw new Error('QUALITY_SETUP_CHUNK_READY');
				}
			}
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		if(setup.generality) {
			await run(`execute in ${setup.dimension} run summon minecraft:armor_stand ${x} ${y} ${z} {Tags:["qo_prepare_${agent}"],Marker:1b,Invisible:1b,Invulnerable:1b,NoGravity:1b}`);
			probeCreated=true;fixtureActor=probe;
		}
		if (setup.startAt !== 'world_spawn') await run(`execute in ${setup.dimension} positioned ${x} ${y} ${z}${setup.surface ? ' positioned over world_surface' : ''} run tp {agent} ~ ~ ~`);
		if (setup.groundBelowCanopy || setup.naturalCave || setup.standingOn) {
			const pos = String((await command(`data get entity ${fixtureActor} Pos`)).text).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/);
			if (!pos) throw new Error('QUALITY_SETUP_POSITION');
			const air = setup.airBlock ?? 'minecraft:air';
			const biomeTest = setup.expectedBiome ? ` if biome ~ ~ ~ ${setup.expectedBiome}` : '';
			const body = setup.groundBelowCanopy ? 'if block ~ ~ ~ #minecraft:replaceable if block ~ ~1 ~ #minecraft:replaceable' : `if block ~ ~ ~ ${air} if block ~ ~1 ~ ${air}`;
			const floorTest = `${body} unless block ~ ~-1 ~ minecraft:air unless block ~ ~-1 ~ #minecraft:leaves unless block ~ ~-1 ~ minecraft:water unless block ~ ~-1 ~ minecraft:lava unless block ~ ~-1 ~ minecraft:magma_block`;
			const offsets = [[0,0],...Array.from({length:17},(_,i)=>Array.from({length:17},(_,j)=>[(i-8)*8,(j-8)*8])).flat().filter(([dx,dz])=>dx||dz).sort((a,b)=>Math.hypot(...a)-Math.hypot(...b))];
			// A surface start is read from the heightmap, never from a vertical scan: a scan accepts cave air under the surface.
			const heightmapSearch = Boolean(setup.groundBelowCanopy);
			const top = setup.caveMaxY ?? (setup.dimension === 'minecraft:the_nether' ? 110 : 100);
			const bottom = setup.caveMinY ?? -48;
			const matches = async text => /time is \d+/i.test(String((await command(text)).text));
			const covered = at => qualityCovered(command, setup.dimension, at);
			let found = false, coverHit = false, fallback = null, fallbackRadius = Infinity;
			for (const [dx,dz] of offsets) {
				if (fallback && Math.hypot(dx,dz) > fallbackRadius + 32) break;
				const heights = heightmapSearch ? [null] : Array.from({length: top-bottom+1}, (_, i) => top-i);
				for (const sy of heights) {
					const where = heightmapSearch ? `positioned ${+pos[1]+dx} 0 ${+pos[3]+dz} positioned over motion_blocking_no_leaves` : `positioned ${+pos[1]+dx} ${sy} ${+pos[3]+dz}`;
					const base = `execute in ${setup.dimension} ${where} ${floorTest}${heightmapSearch ? ' unless block ~ ~-1 ~ #minecraft:logs' : ''}${biomeTest}${setup.standingOn ? ` if block ~ ~-1 ~ ${setup.standingOn}` : ''}`;
					if (!setup.requireCover) {
						const check = `${base} run tp ${fixtureActor} ~ ~ ~`;
						const response = String((await command(check)).text);
						if (/teleported/i.test(response)) { receipts.push({command:check,response}); found = true; break; }
						continue;
					}
					if (!await matches(`${base} run time query gametime`)) continue;
					const tp = `${base} run tp ${fixtureActor} ~ ~ ~`;
					const response = String((await command(tp)).text);
					const placed = String((await command(`data get entity ${fixtureActor} Pos`)).text).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/);
					if (!placed) continue;
					if (await covered(`${placed[1]} ${placed[2]} ${placed[3]}`)) { receipts.push({command:tp,response}); found = true; coverHit = true; break; }
					if (!fallback) { fallback = tp; fallbackRadius = Math.hypot(dx,dz); }
				}
				if (found) break;
			}
			if (!found && fallback) {
				const response = String((await command(fallback)).text);
				if (/teleported/i.test(response)) { receipts.push({command:fallback,response}); found = true; }
			}
			if (setup.requireCover) setup.coverFound = coverHit;
			if (!found) throw new Error(heightmapSearch ? `QUALITY_SETUP_SURFACE_GROUND_SEARCH: no sky-exposed standing ground${setup.expectedBiome ? ` in ${setup.expectedBiome}` : ''} near the start` : 'QUALITY_SETUP_NATURAL_GROUND_SEARCH');
		}
		if (setup.surface) {
			// Fail setup rather than start the model underground or beneath a roof.
			const text = `execute in ${setup.dimension} as ${fixtureActor} at @s positioned over motion_blocking_no_leaves if entity @s[distance=..6] run data get entity @s Pos`;
			const response = String((await command(text)).text);
			if (!/has the following entity data/.test(response)) throw new Error(`QUALITY_SETUP_SURFACE: start is not within a few blocks of the surface heightmap: ${response}`);
			receipts.push({ command: text, response });
		}
		if (setup.expectedBiome) {
			const text = `execute at ${fixtureActor} if biome ~ ~ ~ ${setup.expectedBiome} run data get entity ${fixtureActor} Pos`;
			const response = (await command(text)).text;
			if (!/has the following entity data/.test(response)) throw new Error(`QUALITY_SETUP_BIOME: expected ${setup.expectedBiome}: ${response}`);
			receipts.push({ command: text, response });
		}

		// A fresh vanilla player starts and respawns at the world spawn, so a moved start moves the spawn with it.
		if (setup.respawnAtStart) await run('execute at {agent} run setworldspawn ~ ~ ~');
		// Loot rolls (piglin barters, mob drops, fishing) draw from per-world random sequences seeded by the world seed and
		// the table id alone, so one save point repeats the same barters and drops in every game. A salt reseeds them all.
		if (setup.randomSalt !== undefined) await run(`random reset * ${setup.randomSalt}`);
		for (const text of setup.commands) {
			await run(text);
			const player=text.match(/^player (\w+) spawn/);
			if(player) for(let ready=0;ready<100;ready++){
				if(/has the following entity data/.test(String((await command(`data get entity ${player[1]} Pos`)).text))) break;
				await new Promise(resolve=>setTimeout(resolve,50));
				if(ready===99) throw new Error('QUALITY_SETUP_HELPER_JOIN');
			}
		}
		if (setup.naturalGround) {
			const text = `execute at ${fixtureActor} ${setup.groundBelowCanopy ? 'if block ~ ~ ~ #minecraft:replaceable if block ~ ~1 ~ #minecraft:replaceable' : `if block ~ ~ ~ ${setup.airBlock ?? 'minecraft:air'} if block ~ ~1 ~ ${setup.airBlock ?? 'minecraft:air'}`} unless block ~ ~-1 ~ minecraft:air unless block ~ ~-1 ~ #minecraft:leaves unless block ~ ~-1 ~ minecraft:water unless block ~ ~-1 ~ minecraft:lava unless block ~ ~-1 ~ minecraft:magma_block run data get entity ${fixtureActor} Pos`;
			const response = (await command(text)).text;
			if (!/has the following entity data/.test(response)) throw new Error(`QUALITY_SETUP_GROUND: expected natural standing ground: ${response}`);
			receipts.push({ command: text, response });
		}
		if(setup.generality) {
			fixtureActor=agent;
			await run(`execute at ${probe} run tp {agent} ~ ~ ~`);
			await run(`execute in ${setup.dimension} run kill ${probe}`);probeCreated=false;
		}
		// Frozen worlds do not advance vanilla's 60-tick client-load immunity timer.
		// Advance it while the prepared player is safe, before adding threats or timed effects.
		if(setup.generality && (setup.finalCommands??[]).some(c=>/^damage /.test(c))){
			await run('tick step 60');
			await new Promise(resolve=>setTimeout(resolve,3100));
		}
		await run('clear {agent}');
		if (setup.usedBedSpawn) {
			// Crouch-use with a held item bypasses the bed. The idle brink stance can already be crouching.
			await run('effect clear {agent}');
			const bed = setup.usedBedSpawn, [bx, by, bz] = bed.position;
			const original = String((await command(`data get entity ${agent} Pos`)).text).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number);
			if (!original) throw new Error('QUALITY_SETUP_BED_POSITION');
			// Use the bed through the same vanilla interaction as the player. /spawnpoint makes an
			// unconditional spawn that survives a broken bed; this must remain a block-dependent spawn.
			await run('time set 13000');
			await run(`execute in ${bed.dimension} run tp {agent} ${bx + .5} ${by} ${bz + 1.5}`);
			// Preparation can retain sneak; with a held item vanilla then bypasses the bed.
			await run('player {agent} unsneak');
			await run(`player {agent} look at ${bx + 1.5} ${by + .5} ${bz + .5}`);
			await run('player {agent} use once');
			if (setup.freezeUntilGoalStart) await run('tick step 2');
			await new Promise(resolve => setTimeout(resolve, 200));
			await run('player {agent} stop');
			const response = String((await command(`data get entity ${agent} respawn`)).text);
			if (!response.includes(`pos: [I; ${bx + 1}, ${by}, ${bz}]`) || /forced: 1b/.test(response) || !response.includes(bed.dimension)) throw new Error(`QUALITY_SETUP_BED_NOT_USED: ${response}`);
			receipts.push({ command: 'used bed respawn receipt', response });
			await run(`execute in ${setup.dimension} run tp {agent} ${original.join(' ')}`);
		}
		for (const { item, count = 1 } of setup.inventory ?? []) await run(`give {agent} ${item} ${count}`);
		for (const [slot, item] of Object.entries(setup.armour ?? {})) await run(`item replace entity {agent} armor.${slot} with ${item}`);
		// A save point may name what the body starts looking at (the spawner-in-view fortress start); the place stays as prepared.
		if (Array.isArray(setup.facing)) await run(`execute in ${setup.dimension} at {agent} run tp {agent} ~ ~ ~ facing ${setup.facing.join(' ')}`);
		if(setup.generality) await run('execute at {agent} run kill @e[type=minecraft:item,distance=..4]');
		await run('effect clear {agent}');
		if(!setup.generality) for (const effect of setup.effects ?? []) await run(`effect give {agent} ${effect.id} ${effect.seconds} ${effect.amplifier ?? 0}`);
		await run(`time set ${setup.time ?? 1000}`);
		if (setup.weather) await run(`weather ${setup.weather} 1000000`);
		if (setup.foodLevelTarget !== undefined || setup.hungerSetupTicks) {
			const target = setup.foodLevelTarget ?? 8;
			await run('gamemode survival {agent}');
			await run('effect give {agent} minecraft:hunger 30 255');
			let food = 20;
			for(let steps=0;steps<240 && food>target;steps++) {
				await run('tick step 1');
				await new Promise(resolve => setTimeout(resolve, 70));
				const response=String((await command(`data get entity ${agent} foodLevel`)).text);
				food=Number(response.match(/entity data:\s*(\d+)/)?.[1]);
				if(!Number.isFinite(food)) throw new Error('QUALITY_SETUP_FOOD_RECEIPT');
				receipts.push({command:'foodLevel receipt',response});
			}
			await run('effect clear {agent} minecraft:hunger');
			if(!setup.generality) await run('gamemode creative {agent}');
			if(food>target || food<1) throw new Error('QUALITY_SETUP_FOOD_TARGET');
			setup.measuredFoodLevel=food;
		}
		for (const mob of setup.mobs ?? []) {
			let offset = mob.offset;
			if (mob.naturalGround) {
				offset = null;
				const candidates = [];
				for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -4; dy <= 4; dy++) {
					const candidate = [mob.offset[0] + dx, mob.offset[1] + dy, mob.offset[2] + dz];
					if (Math.hypot(candidate[0], candidate[2]) >= 5) candidates.push({ candidate, distance: dx * dx + dy * dy + dz * dz });
				}
				const nearby=candidates.sort((a,b)=>a.distance-b.distance);
				const fallback=[];
				// A requested offset can cross a natural cliff or canopy. Keep the original
				// local search first, then find standing ground farther around that offset.
				for(let dx=-8;dx<=8;dx++) for(let dz=-8;dz<=8;dz++) for(let dy=-16;dy<=16;dy++){
					if(Math.abs(dx)<=3&&Math.abs(dz)<=3&&Math.abs(dy)<=4) continue;
					const candidate=[mob.offset[0]+dx,mob.offset[1]+dy,mob.offset[2]+dz];
					if(Math.hypot(candidate[0],candidate[2])>=5) fallback.push({candidate,distance:dx*dx+dy*dy+dz*dz});
				}
				for (const { candidate } of [...nearby,...fallback.sort((a,b)=>a.distance-b.distance)]) {
					const text = `execute at ${agent} positioned ${candidate.map(n => `~${n}`).join(' ')} if block ~ ~ ~ ${setup.airBlock ?? 'minecraft:air'} if block ~ ~1 ~ ${setup.airBlock ?? 'minecraft:air'} unless block ~ ~-1 ~ minecraft:air unless block ~ ~-1 ~ #minecraft:leaves unless block ~ ~-1 ~ minecraft:water unless block ~ ~-1 ~ minecraft:lava unless block ~ ~-1 ~ minecraft:magma_block run data get entity ${agent} Pos`;
					const response = (await command(text)).text;
					receipts.push({ command: text, response });
					if (/has the following entity data/.test(response)) { offset = candidate; break; }
				}
				if (!offset) throw new Error(`QUALITY_SETUP_MOB_GROUND: ${mob.id}`);
			}
			await run(`execute at {agent} run summon ${mob.id} ${offset.map(n => `~${n}`).join(' ')} ${mob.nbt ?? '{}'}`);
			if (mob.tag) {
				// Frozen ticks can leave newly summoned entities pending insertion.
				if (setup.freezeUntilGoalStart) { await run('tick step 1'); await new Promise(resolve => setTimeout(resolve, 70)); }
				const text = `execute at ${agent} run data get entity @e[type=${mob.id},tag=${mob.tag},limit=1,sort=nearest] Pos`;
				const response = (await command(text)).text;
				if (!/has the following entity data/.test(response)) throw new Error(`QUALITY_SETUP_MOB_MISSING: ${mob.tag}`);
				receipts.push({ command: text, response });
			}
		}
		for (const [name, criterion] of [['qo_damage', 'minecraft.custom:minecraft.damage_taken'], ['qo_death', 'deathCount']]) {
			await run(`scoreboard objectives add ${name} ${criterion}`);
			await run(`scoreboard players set {agent} ${name} 0`);
		}
		if(setup.generality) await run(`time set ${setup.time??1000}`);
		// Initialize natural boss entities while the fixture player is still safe.
		if (setup.settleTicks) {
			await run(`tick step ${setup.settleTicks}`);
			await new Promise(resolve => setTimeout(resolve, setup.settleTicks * 50 + 100));
		}
		// Generality fixtures separate construction from activation; legacy fixtures keep their lifecycle.
		await run('gamemode survival {agent}');
		if(setup.generality && setup.freezeUntilGoalStart) {
			// Publish the completed, safe survival start before goal compilation can reuse a construction observation.
			await run('tick step 1');
			await new Promise(resolve=>setTimeout(resolve,70));
		}
		if(!setup.generality) for(const text of setup.finalCommands??[]) await run(text);
		if(!setup.generality && setup.freezeUntilGoalStart) {
			// A frozen world publishes no new observation, so the model would plan from the pre-setup one
			// (wrong position, no gear, no task). Step the prepared player through observation ticks and
			// confirm the final pose before the goal is released.
			const posOf = async () => String((await command(`data get entity ${agent} Pos`)).text).match(/\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]/)?.slice(1).map(Number);
			const before = await posOf();
			for (let i = 0; i < 3; i++) { await run('tick step 1'); await new Promise(resolve => setTimeout(resolve, 100)); }
			const after = await posOf();
			if (before && after && Math.hypot(...before.map((v, i) => v - after[i])) > 1.5) throw new Error(`QUALITY_SETUP_FRESH_OBSERVATION: prepared pose moved while publishing it: ${before} -> ${after}`);
			if (after) setup.freshObservation = { position: after, ticks: 3, at: Date.now() };
		}
		const initial = {};
		for (const field of ['Pos', 'Dimension', 'Health', 'Inventory']) initial[field] = (await command(`data get entity ${agent} ${field}`)).text;
		initial.entity = (await command(`data get entity ${agent}`)).text;
		return { definition: setup, agent, receipts, initial, preparedAt: Date.now(), terrainModified: setup.commands.length > 0 };
	} finally {
		if(probeCreated) await command(`execute in ${setup.dimension} run kill ${probe}`).catch(()=>{});
		for (const chunk of extraTickets.reverse()) await command(`execute in ${chunk.dimension} run forceload remove ${chunk.ticket}`).catch(()=>{});
		await command(`execute in ${setup.dimension} run forceload remove ${ticket}`);
	}
}

export async function activateQualitySetup(receipt, command, {stage='goal-start'} = {}) {
	const setup=receipt.definition, agent=receipt.agent;
	if(!setup.generality){
		if(stage==='first-decision'&&setup.freezeUntilGoalStart&&!receipt.releasedAt){await command('tick unfreeze');receipt.releasedAt=Date.now();}
		return receipt;
	}
	const run=async text=>{
		const result=await command(text.replaceAll('{agent}',agent));
		const response=String(result.text??result);
		if(/unknown|incorrect argument|no entity was found|no player was found|not a valid|failed|could not|not loaded|is invulnerable/i.test(response)) throw new Error(`QUALITY_SETUP_ACTIVATION: ${text}: ${response}`);
		(receipt.activationReceipts??=[]).push({command:text,response,at:Date.now()});
	};
	if(stage==='goal-start') {
		if(receipt.goalStartedAt) return receipt;
		await run('gamemode survival {agent}');
		receipt.goalStartedAt=Date.now();
		if(setup.activation==='first-decision') return receipt;
	}
	if(!receipt.activatedAt) {
		for(const effect of setup.effects??[]) await run(`effect give {agent} ${effect.id} ${effect.seconds} ${effect.amplifier??0}`);
		for(const text of setup.finalCommands??[]) await run(text);
		receipt.activatedAt=Date.now();
	}
	if(stage==='first-decision' && setup.freezeUntilGoalStart && !receipt.releasedAt) {
		await run('tick unfreeze');
		receipt.releasedAt=Date.now();
	}
	return receipt;
}

// Flood-fill the bounded indoor space at the player's feet. A solid roof and
// enclosing walls are required; one two-block-high doorway may lead outdoors.
// Action traces separately establish that the player built or dug the shelter.
export async function sampleQualityShelter(command, agent) {
 const nonSolid = ['#minecraft:replaceable', '#minecraft:leaves', '#minecraft:flowers', '#minecraft:crops', '#minecraft:rails', '#minecraft:buttons', '#minecraft:pressure_plates', '#minecraft:climbable', '#minecraft:signs', '#minecraft:wall_signs', '#minecraft:banners', '#minecraft:doors[open=true]', '#minecraft:trapdoors[open=true]', ...['air','cave_air','void_air','water','lava','fire','soul_fire','torch','wall_torch','soul_torch','soul_wall_torch','redstone_torch','redstone_wall_torch','redstone_wire','tripwire','tripwire_hook','lever','cobweb','nether_portal','end_portal','end_gateway'].map(b=>`minecraft:${b}`)];
 const solidCache = new Map(), insideCache = new Map();
 const isSolid = async (x,y,z) => {
  const key=`${x},${y},${z}`;
  if(!solidCache.has(key)) {
   const position=`~${x} ~${y} ~${z}`;
   let solid=true;
   // Minecraft's RCON receive buffer rejects oversized commands, so sample in bounded groups.
   for(let offset=0;offset<nonSolid.length;offset+=12) {
    const check=`execute at ${agent} ${nonSolid.slice(offset,offset+12).map(block=>`unless block ${position} ${block}`).join(' ')} run time query gametime`;
    const response=String((await command(check)).text);
    if(/unknown|incorrect argument|not a valid|can't find element|cannot find (?:tag|block)/i.test(response)) throw new Error(`QUALITY_SHELTER_SAMPLE: ${response}`);
    if(!/time is \d+/i.test(response)) {solid=false;break;}
   }
   solidCache.set(key,solid);
  }
  return solidCache.get(key);
 };
 const cell = async (x,z) => {
  const key=`${x},${z}`;
  if(insideCache.has(key)) return insideCache.get(key);
  if(await isSolid(x,0,z)||await isSolid(x,1,z)) { insideCache.set(key,'wall'); return 'wall'; }
  let covered=false;
  for(let height=2;height<=4;height++) if(await isSolid(x,height,z)) {covered=true;break;}
  const value=covered&&await isSolid(x,-1,z)?'inside':'outside';
  insideCache.set(key,value);return value;
 };
 if(await cell(0,0)!=='inside') return false;
 const queue=[[0,0]], visited=new Set(['0,0']), exits=new Set();
 for(let index=0;index<queue.length;index++) {
  const [x,z]=queue[index];
  for(const [dx,dz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
   const nx=x+dx,nz=z+dz,key=`${nx},${nz}`;
   if(visited.has(key)) continue;
   visited.add(key);
   if(Math.abs(nx)>8||Math.abs(nz)>8) return false;
   const type=await cell(nx,nz);
   if(type==='wall') continue;
   if(type==='outside') {exits.add(key);if(exits.size>1)return false;continue;}
   queue.push([nx,nz]);if(queue.length>81)return false;
  }
 }
 // An enclosed cave or hillside room is valid; an unbounded overhang is not.
 return true;
}
