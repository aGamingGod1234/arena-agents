// JSON Schema string lengths count Unicode code points, independently of UTF-8 byte budgets.
export function codePointLength(value) {
	let length = 0;
	for (const character of value) length++;
	return length;
}
