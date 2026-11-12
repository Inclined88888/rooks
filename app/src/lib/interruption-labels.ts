/**
 * System death causes, and the i18n key that says each one in plain words.
 *
 * Local copy of `INTERRUPTION_REASONS` from `orchestrator/src/interruption.ts`:
 * the two packages are independent (same convention as `brand.ts`), so the
 * daemon's enum is mirrored here rather than imported.
 *
 * The map is typed `Record<InterruptionReason, string>` on purpose. It used to
 * be a `Record<string, string>` built inline in the Kanban page, which can
 * never notice a missing cause: `stopped` shipped in the daemon and was
 * displayed as the generic "mission interrupted" for weeks, precisely where the
 * distinction matters (a stopped turn is resumable, it is not a crash). With
 * the union, adding a cause to the daemon and forgetting it here fails `tsc`.
 */
export const INTERRUPTION_REASONS = [
  'rate_limit',
  'exhausted',
  'backend_unavailable',
  'overloaded',
  'permission_denied',
  'killed',
  'stopped',
  'timeout',
  'turn_budget',
  'crash',
  'unknown',
] as const;

export type InterruptionReason = (typeof INTERRUPTION_REASONS)[number];

export const INTERRUPTION_LABEL_KEYS: Record<InterruptionReason, string> = {
  rate_limit: 'kanbanPage.interruptionRateLimit',
  exhausted: 'kanbanPage.interruptionExhausted',
  backend_unavailable: 'kanbanPage.interruptionBackendUnavailable',
  overloaded: 'kanbanPage.interruptionOverloaded',
  permission_denied: 'kanbanPage.interruptionPermissionDenied',
  killed: 'kanbanPage.interruptionKilled',
  stopped: 'kanbanPage.interruptionStopped',
  timeout: 'kanbanPage.interruptionTimeout',
  turn_budget: 'kanbanPage.interruptionTurnBudget',
  crash: 'kanbanPage.interruptionCrash',
  // Explicit, and above all NOT empty: a missing cause reads as a business
  // block set by the agent, which it is not.
  unknown: 'kanbanPage.interruptionUnknown',
};
