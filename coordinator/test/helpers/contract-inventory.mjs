import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'acorn';
import { MINECRAFT_DYNAMIC_TOOLS, NATIVE_AGENT_INSTRUCTIONS, minecraftCapabilities } from '../../src/native-minecraft-tools.mjs';
import { ARENA_SCRIPT_API_REFERENCE, SCRIPT_ACTION_REFERENCE } from '../../src/prompts.mjs';

export const CONTROL_FILE = 'config/minecraft-agent/.codex/skills/minecraft-control/references/control-reference.md';
export const SKILL_FILE = 'config/minecraft-agent/.codex/skills/minecraft-control/SKILL.md';
export const STRATEGY_FILE = 'config/minecraft-agent/.codex/skills/minecraft-control/references/strategy-guide.md';
export const AGENT_FILE = 'config/minecraft-agent/AGENTS.md';
const root = new URL('../../', import.meta.url);
const lineAt = (source, offset) => source.slice(0, offset).split('\n').length;

// Inventory comes from the actual exported tools, including interpolated text
// and imported schemas. Keeping discovery separate from reviewed predicates
// makes a newly advertised field or paragraph fail closed in npm test.
export function discoverContracts({ sources = {}, tools = MINECRAFT_DYNAMIC_TOOLS } = {}) {
	const read = file => (sources[file] ?? readFileSync(new URL(file, root), 'utf8')).replace(/\r\n/g, '\n');
	const claims = [];
	const add = (id, claim, file, line, kind, extra = {}) => claims.push({ id, claim, kind, ...extra, location: { file: `coordinator/${file}`, line } });
	const native = read('src/native-minecraft-tools.mjs');
	const tableSource = read('src/tool-descriptions.json');
	const table = JSON.parse(tableSource);
	const descriptions = table.toolDescriptions;
	const evidenceSource = read('test/contracts/claims.json');
	for (const rule of JSON.parse(evidenceSource).commonRules ?? []) add(rule.id, rule.claim, 'test/contracts/claims.json', lineAt(evidenceSource, evidenceSource.indexOf(JSON.stringify(rule.claim))), 'common-rule');
	const ast = parse(native, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
	const calls = new Map();
	walk(ast, node => {
		if (node.type === 'CallExpression' && node.callee.name === 'tool' && node.arguments[0]?.type === 'Literal') calls.set(node.arguments[0].value, node);
	});
	for (const tool of tools) {
		const node = calls.get(tool.name);
		if (!node) throw new Error(`Tool has no inventoried source: ${tool.name}`);
		const line = node.loc.start.line;
		const file = 'src/native-minecraft-tools.mjs';
		const definition = descriptions[tool.name][0].claim;
		const descriptionLine = lineAt(tableSource, tableSource.indexOf(JSON.stringify(definition)));
		const description = sources['src/tool-descriptions.json'] === undefined ? tool.description : descriptions[tool.name].map(entry => entry.claim).join(' ');
		sentences(description).forEach(text => add(`tool:${tool.name}:description:${contentId(text)}`, text, 'src/tool-descriptions.json', descriptionLine, 'description', { tool: tool.name }));
		const schema = (value, path) => {
			const own = Object.fromEntries(Object.entries(value).filter(([key]) => !['properties', 'items', 'description', 'enum', 'default'].includes(key)));
			if (Object.keys(own).length) add(`tool:${tool.name}:schema:${path}`, JSON.stringify(own), file, line, 'schema', { tool: tool.name, path, contract: own });
			if (value.description) add(`tool:${tool.name}:parameter:${path}`, value.description, file, line, 'parameter', { tool: tool.name, path });
			for (const member of value.enum ?? []) add(`tool:${tool.name}:enum:${path}:${member}`, JSON.stringify(member), file, line, 'enum', { tool: tool.name, path, value: member });
			if (Object.hasOwn(value, 'default')) add(`tool:${tool.name}:default:${path}`, JSON.stringify(value.default), file, line, 'default', { tool: tool.name, path, value: value.default });
			for (const [key, child] of Object.entries(value.properties ?? {})) schema(child, path ? `${path}.${key}` : key);
			if (value.items) schema(value.items, `${path}[]`);
		};
		schema(tool.inputSchema, '');
	}
	const instructionsLine = lineAt(native, native.indexOf('export const NATIVE_AGENT_INSTRUCTIONS'));
	paragraphs(NATIVE_AGENT_INSTRUCTIONS).forEach(part => add(`native-instructions:${contentId(part.text)}`, part.text, 'src/native-minecraft-tools.mjs', instructionsLine + part.line - 1, 'instructions'));
	const prompts = read('src/prompts.mjs');
	// The program reference is composed from the planner prompt. Resolve each
	// rendered paragraph back to its definition, rather than the interpolation.
	paragraphs(ARENA_SCRIPT_API_REFERENCE).forEach((part, index) => {
		const first = part.text.split('\n')[0];
		let offset = prompts.indexOf(first);
		for (let length = Math.min(55, first.length); offset < 0 && length >= 16; length--) offset = prompts.indexOf(first.slice(0, length));
		add(`program-reference:${contentId(part.text)}`, part.text, 'src/prompts.mjs', offset < 0 ? lineAt(prompts, prompts.indexOf('export const ARENA_SCRIPT_API_REFERENCE')) : lineAt(prompts, offset), 'program-reference');
	});
	for (const text of SCRIPT_ACTION_REFERENCE.split(/, (?=player\.)/)) add(`script-action:${contentId(text)}`, text, 'src/prompts.mjs', lineAt(prompts, prompts.indexOf('export const SCRIPT_ACTION_REFERENCE')), 'script-action');
	const capabilities = minecraftCapabilities();
	for (const action of capabilities.actions) add(`capability:action:${action.actionType}`, JSON.stringify(action), 'src/native-minecraft-tools.mjs', lineAt(native, native.indexOf('actions: Object.entries(ACTION_FIELDS)')), 'action-contract', { actionType: action.actionType });
	for (const [name, value] of Object.entries(capabilities.limits)) add(`capability:limit:${name}`, `${name}: ${value}`, 'src/native-minecraft-tools.mjs', lineAt(native, native.indexOf('limits: { sequenceActions:')), 'limit', { name, value });
	for (const [name, type] of Object.entries(capabilities.controlConditions)) add(`capability:condition:${name}`, `${name}: ${type}`, 'src/native-minecraft-tools.mjs', lineAt(native, native.indexOf('controlConditions:')), 'condition', { name, type });
	for (const [file, prefix] of [[CONTROL_FILE, 'control'], [STRATEGY_FILE, 'strategy'], [SKILL_FILE, 'skill'], [AGENT_FILE, 'agent']]) {
		const source = read(file);
		let topic = 'overview';
		for (const part of paragraphs(source)) {
			if (/^#{1,3} /.test(part.text)) { topic = part.text.replace(/^#+ /, ''); continue; }
			if (part.text === '---' || /^name:|^description:/.test(part.text)) continue;
			add(`${prefix}:${contentId(topic)}:${contentId(part.text)}`, part.text, file, part.line, part.text.startsWith('```') ? 'example' : `${prefix}-reference`, { topic });
		}
	}
	// Result-code entries are separate claims even when embedded in a longer
	// behavioral paragraph, so removing or changing a meaning is reviewable.
	for (const parent of [...claims]) {
		if (['schema', 'enum', 'default', 'example', 'script-action'].includes(parent.kind)) continue;
		for (const code of new Set(parent.claim.match(/\b[A-Z][A-Z_]{3,}\b/g) ?? [])) {
			if (['JSON', 'UUID', 'UTF8'].includes(code)) continue;
			claims.push({ ...parent, id: `${parent.id}:result:${code}`, kind: 'result-code', code, parent: parent.id });
		}
	}
	if (new Set(claims.map(entry => entry.id)).size !== claims.length) throw new Error('Duplicate contract identity: disambiguate repeated content within its topic');
	return claims;
}

const contentId = text => createHash('sha256').update(text).digest('hex').slice(0, 16);

export function contractSnapshot({ location, source, ...contract }) { return contract; }

export function contractChanges(current, reviewed) {
	const entries = new Map(reviewed.map(entry => [entry.id, entry]));
	const changes = [];
	for (const entry of current) {
		const recorded = entries.get(entry.id);
		if (!recorded || JSON.stringify(contractSnapshot(recorded.contract)) !== JSON.stringify(contractSnapshot(entry))) changes.push(entry.id);
		entries.delete(entry.id);
	}
	for (const id of entries.keys()) changes.push(`removed:${id}`);
	return changes;
}

function sentences(text) {
	return text.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean);
}

function paragraphs(source) {
	const rows = source.split('\n');
	const result = [];
	let current = [], start = 1, fence = false;
	const flush = () => { if (current.length) result.push({ text: current.join('\n'), line: start }); current = []; };
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		if (row.startsWith('```')) {
			if (!fence) { flush(); start = index + 1; fence = true; current.push(row); }
			else { current.push(row); fence = false; flush(); }
		} else if (!row.trim() && !fence) flush();
		else { if (!current.length) start = index + 1; current.push(row); }
	}
	flush();
	return result;
}

function walk(node, visit) {
	if (!node || typeof node !== 'object') return;
	if (typeof node.type === 'string') visit(node);
	for (const [key, child] of Object.entries(node)) {
		if (key === 'loc') continue;
		if (Array.isArray(child)) child.forEach(value => walk(value, visit));
		else if (child && typeof child === 'object') walk(child, visit);
	}
}
