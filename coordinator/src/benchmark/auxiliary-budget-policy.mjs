import { fallbackCompiledDragonGoal } from '../goal-spec-translator.mjs';

export const OBSERVER_BUDGET_POLICY = 'Observer estimate only: Codex preparation, play and judging can exceed their allowances and the ledger cap. Reservations constrain admission estimates, not provider charges.';
export const STRICT_BUDGET_POLICY = 'Strict: Claude text requests reserve their published maximum charge before forwarding; auxiliary translation and live judges are disabled. The server verifies the locally compiled dragon goal. Open or interrupted calls retain conservative charges in the shared ledger.';

export function isStrictBudget({ codexObserverCap } = {}) { return codexObserverCap !== true; }
export function requireRunBudgetPolicy(options = {}) {
 if (!isStrictBudget(options)) return;
 if (options.provider !== 'claude') throw new Error('Strict spend requires Claude through the per-call gateway; Codex needs --codex-observer-cap yes and is not a hard cap');
}
export function requireStrictGoal(goal) {
 if (!fallbackCompiledDragonGoal({ requestId: '00000000-0000-4000-8000-000000000001', originalRequest: goal, candidateIds: ['minecraft:ender_dragon'] })) {
  throw new Error('Strict run requires the locally compiled Beat the game goal; auxiliary goal translation is disabled');
 }
}
