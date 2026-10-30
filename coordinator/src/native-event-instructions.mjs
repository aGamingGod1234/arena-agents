export const NEW_CONTEXT_EVENT_INSTRUCTION = 'Live Minecraft event. New task context: read now and situation first; done steps need no work. Start from a next step that fits your dimension and gear, using fresh facts; answer pending program decisions.';

export const ROUTINE_NEW_CONTEXT_EVENT_INSTRUCTION = NEW_CONTEXT_EVENT_INSTRUCTION.replace('Live Minecraft event. ', '');

export function isNewContextEventInput(input) {
	// A context entry may append one sentence to the line (Entered the Nether: ...), a respawn its drops (Respawned. ...).
	return [NEW_CONTEXT_EVENT_INSTRUCTION, ROUTINE_NEW_CONTEXT_EVENT_INSTRUCTION].some(line => input.startsWith(`${line}\n`) || input.startsWith(`${line} Entered `) || input.startsWith(`${line} Respawned. `));
}
