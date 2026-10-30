export class ArenaScriptError extends Error {
	constructor(code, message, location = null, options = undefined) {
		super(message, options);
		this.name = 'ArenaScriptError';
		this.code = code;
		this.location = location;
	}
}

export function executionError(code, message = `ArenaScript ${code}`, location = null, options = undefined) {
	return new ArenaScriptError(code, message, location, options);
}

/** Only parser-owned, bounded diagnostics cross the provider result boundary. */
export function arenaScriptDiagnosticFields(error) {
	return error instanceof ArenaScriptError && Array.isArray(error.diagnostics)
		? { diagnostics: error.diagnostics, diagnosticsTruncated: error.diagnosticsTruncated === true }
		: {};
}

export function arenaScriptDiagnosticSummary(error) {
	const { diagnostics, diagnosticsTruncated } = arenaScriptDiagnosticFields(error);
	return diagnostics === undefined ? {} : {
		diagnosticCount: diagnostics.length,
		diagnosticCodes: diagnostics.map(({ code }) => code),
		diagnosticsTruncated,
	};
}

export function boundedDiagnosticText(text, maxBytes) {
	if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
	let result = '', bytes = 0;
	for (const character of text) {
		bytes += Buffer.byteLength(character, 'utf8');
		if (bytes > maxBytes) break;
		result += character;
	}
	return result;
}
