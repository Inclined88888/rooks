/**
 * Idle "no CLI session" from an account-usage probe.
 *
 * Distinct from a transport failure: the probe exists, the operator simply
 * has not signed in. Callers must detect this by type or `code`, never by
 * comparing the English message (TIM-0011).
 */
export const USAGE_NOT_SIGNED_IN = 'not_signed_in' as const;
export type UsageNotSignedInCode = typeof USAGE_NOT_SIGNED_IN;

export class UsageNotSignedInError extends Error {
  readonly code: UsageNotSignedInCode = USAGE_NOT_SIGNED_IN;
  constructor(message: string) {
    super(message);
    this.name = 'UsageNotSignedInError';
  }
}

/**
 * By `code`, never by class: a provider shipped as a plugin carries its own copy
 * of this module, so an `instanceof` against the daemon's class would answer
 * "no" for an error the daemon is meant to recognise.
 */
export function isUsageNotSignedInError(error: unknown): error is UsageNotSignedInError {
  return error instanceof Error && (error as { code?: unknown }).code === USAGE_NOT_SIGNED_IN;
}
