// Validate the advertised shape alongside semantic normalization. The semantic
// validators still own conditional fields, budgets and world eligibility.
const schemaPatterns = new WeakMap();

function matchesPattern(value, schema) {
	let cached = schemaPatterns.get(schema);
	if (!cached || cached.pattern !== schema.pattern) {
		cached = { pattern: schema.pattern, expression: new RegExp(schema.pattern) };
		schemaPatterns.set(schema, cached);
	}
	return cached.expression.test(value);
}

export function validateToolSchema(value, schema, path = 'arguments') {
	if (schema.type !== undefined) {
		const types = [schema.type].flat();
		const matches = types.some(type => {
			switch (type) {
				case 'null': return value === null;
				case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
				case 'array': return Array.isArray(value);
				case 'integer': return Number.isSafeInteger(value);
				case 'number': return typeof value === 'number' && Number.isFinite(value);
				default: return typeof value === type;
			}
		});
		if (!matches) invalid(`${path} must be ${types.join(' or ')}`);
	}
	if (schema.enum && !schema.enum.includes(value)) invalid(`${path} is not a supported value`);
	if (typeof value === 'number') {
		if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum) invalid(`${path} is outside its advertised range`);
	}
	if (typeof value === 'string') {
		const length = Array.from(value).length;
		if (schema.minLength !== undefined && length < schema.minLength || schema.maxLength !== undefined && length > schema.maxLength) invalid(`${path} is outside its advertised length`);
		if (schema.pattern && !matchesPattern(value, schema)) invalid(`${path} has an invalid format`);
	}
	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) invalid(`${path} is outside its advertised item count`);
		if (schema.items) for (let index = 0; index < value.length; index++) validateToolSchema(value[index], schema.items, `${path}[${index}]`);
	} else if (value !== null && typeof value === 'object') {
		for (const field of schema.required ?? []) if (!Object.hasOwn(value, field)) invalid(`${path}.${field} is required`);
		for (const field of Object.keys(value)) {
			if (schema.properties?.[field]) {
				if (value[field] === undefined && !schema.required?.includes(field)) continue;
				validateToolSchema(value[field], schema.properties[field], `${path}.${field}`);
			}
			else if (schema.additionalProperties === false) invalid(`${path}.${field} is unsupported`);
		}
	}
	return value;
}

function invalid(message) { throw Object.assign(new TypeError(message), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' }); }
