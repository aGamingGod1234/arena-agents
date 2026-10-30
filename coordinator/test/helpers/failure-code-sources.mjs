import fs from 'node:fs';
import path from 'node:path';

// Finds every result code a producer can emit, by source shape, so the failure catalogue cannot fall behind.
const CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const JAVA_LITERAL = /"(?<code>[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)"/g;
const JS_LITERAL = /(['"])(?<code>[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\1/g;
// A producer statement: an exception, controller or executor result, or a code-named variable or constant.
const JAVA_PRODUCER = /\b[A-Za-z]*(?:[Ff]ail[A-Za-z]*|[Tt]imedOut|[Ss]ucceeded|[Cc]ancelled|[Rr]esult|[Ee]mit|Exception|[Rr]eason[A-Za-z]*)\s*\((?!\s*\))|\b(?:static final String\s+[A-Z_]+|[A-Za-z]*(?:[Cc]ode|[Rr]eason))\s*=|\breturn\s/g;
// Coordinator codes also arrive by assignment (`error.code = 'X'`) and as defaults (`reasonCode = 'X'` parameters).
const JS_PRODUCER = /(?:codedError|codedRuntimeError|#error|executionError|[A-Za-z]*Error)\(\s*|\b(?:reasonCode|code)\s*(?::|=(?![=>]))\s*/g;

function walk(directory, extension, files = []) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) walk(file, extension, files);
		else if (file.endsWith(extension)) files.push(file);
	}
	return files;
}

// Files that only read finished codes: presentation of results and expected simulator outcomes.
const CONSUMERS = ['AgentActivityPresentation.java', 'AgentFeedPolicy.java', 'simulator-scenarios.mjs'];

function scan(files, producer, literal, end, root, codes) {
	for (const file of files.filter((candidate) => !CONSUMERS.some((name) => candidate.endsWith(name)))) {
		scanSource(fs.readFileSync(file, 'utf8'), path.relative(root, file).split(path.sep).join('/'), producer, literal, end, codes);
	}
}

function scanSource(source, name, producer, literal, end, codes) {
	for (const match of source.matchAll(producer)) {
		const start = match.index + match[0].length;
		const statement = source.slice(start, start + 400).split(end)[0];
		for (const found of statement.matchAll(literal)) {
			const code = found.groups.code;
			if (!CODE.test(code)) continue;
			const site = `${name}:${source.slice(0, start).split('\n').length}`;
			const sites = codes.get(code) ?? [];
			if (!sites.includes(site)) sites.push(site);
			codes.set(code, sites);
		}
	}
}

const JS_END = /[,;})\n]/;

/** Codes one Java source text produces, excluding no-argument receipt getters. */
export function producedJavaCodes(source) {
	const codes = new Map();
	scanSource(source, 'Fixture.java', JAVA_PRODUCER, JAVA_LITERAL, ';', codes);
	return new Set(codes.keys());
}

/** Codes one coordinator source text produces, for scanner controls that must not touch repository files. */
export function producedJavaScriptCodes(source) {
	const codes = new Map();
	scanSource(source, 'fixture.mjs', JS_PRODUCER, JS_LITERAL, JS_END, codes);
	return new Set(codes.keys());
}

/** Map of code -> producer sites in the Java server and the coordinator. */
export function producedResultCodes(repositoryRoot) {
	const codes = new Map();
	scan(walk(path.join(repositoryRoot, 'src', 'main', 'java'), '.java'), JAVA_PRODUCER, JAVA_LITERAL, ';', repositoryRoot, codes);
	// Coordinator values end at the property or argument boundary; a ternary keeps both branches.
	scan(walk(path.join(repositoryRoot, 'coordinator', 'src'), '.mjs'), JS_PRODUCER, JS_LITERAL, JS_END, repositoryRoot, codes);
	return codes;
}
