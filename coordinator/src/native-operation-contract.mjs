const DIRECTIVES = new Set(['continue', 'replace', 'pause', 'finish']);
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

/** One acceptance predicate for recovery operations, used by execution and its presenters. */
export function nativeOperationRejection(context, tool) {
	const { goalRevision, program, action, terminal, response } = context;
	const reject = (code, message) => ({ code, message });
	if (tool.kind === 'action_status' || tool.kind === 'program_status') return null;
	if (tool.kind === 'respond_program') {
		if (!DIRECTIVES.has(tool.directive)) return reject('INVALID_PROGRAM_DIRECTIVE', 'Unsupported program directive');
		if (tool.goalRevision !== undefined && tool.goalRevision !== goalRevision) return reject('STALE_PROGRAM_DECISION', 'Decision belongs to an older goal');
		if (!program || program.goalRevision !== goalRevision || program.programId !== tool.programId || program.settled || program.stopping) return reject('STALE_PROGRAM_DECISION', 'Read the current program decision before responding');
		const stop = tool.directive === 'pause' || tool.directive === 'finish';
		if (!response?.currentHandle && !(stop && response?.issuedHandle)) return reject('STALE_PROGRAM_DECISION', 'Read the current program decision before responding');
		if (!response.requestAvailable) return reject('STALE_PROGRAM_DECISION', 'The program no longer needs this decision');
		if (!stop && context.pausedAction) return reject('NATIVE_ACTION_IN_PROGRESS', 'Your fight_target/flee_from still owns the body; wait for its result (or cancelAction it), then respond to the program');
		if (tool.directive === 'continue' && response.actionFailure) return reject('PROGRAM_REPLACEMENT_REQUIRED', 'A routine halted by repeated action failure cannot continue unchanged; this decision accepts replace, pause or finish');
		if (!stop && response.urgent && (!response.notified || (tool.directive === 'replace' ? response.newDanger : response.material)
			|| (tool.directive === 'continue' && response.continueUnsafe))) return reject('STALE_PROGRAM_DECISION', 'New danger facts arrived after this decision');
		return null;
	}
	if (tool.kind === 'cancel_program') {
		return tool.goalRevision === goalRevision && program?.goalRevision === goalRevision && program.programId === tool.programId
			? null : reject('STALE_PROGRAM', 'Cancellation handle does not match the active program');
	}
	if (tool.kind === 'replace_action') {
		if (context.finishing) return reject('NATIVE_ACTION_IN_PROGRESS', 'A finishing native sequence owns the player until its fresh sample and goal verification settle');
		if (context.sweeping) return reject('NATIVE_ACTION_IN_PROGRESS', 'A camera sweep owns this player until sampling completes');
		if (program && !context.pausedReplacement) return reject('NATIVE_PROGRAM_IN_PROGRESS', 'A model-authored program owns this player; use programStatus and cancelProgram before issuing another body operation (fight_target/flee_from are allowed while it is paused for your decision)');
		if (!action && terminal != null && terminal.actionId === tool.actionId && tool.goalRevision === goalRevision && TERMINAL.has(terminal.state)) {
			return context.completing ? reject('NATIVE_COMPLETION_IN_PROGRESS', 'Goal completion verification is already running') : null;
		}
		if (context.blocking) return reject('NATIVE_ACTION_IN_PROGRESS', 'A blocking native body tool is already running');
	}
	if (tool.kind === 'cancel_action' || tool.kind === 'replace_action') {
		if (tool.goalRevision !== goalRevision || action?.goalRevision !== tool.goalRevision || action.actionId !== tool.actionId) return reject('STALE_ACTION', 'Action handle does not match an active action for this goal');
		return action.cancelling ? reject('CANCELLATION_IN_PROGRESS', 'The exact action is already being cancelled') : null;
	}
	return reject('INVALID_NATIVE_TOOL', 'Unsupported recovery operation');
}
