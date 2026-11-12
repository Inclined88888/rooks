/**
 * How far an Allow reaches, for an agent that remembers an approval. Mirror of
 * `ApprovalScope` (orchestrator `backends/types.ts`): the daemon lists on the
 * card exactly what the agent understands, and refuses any other value.
 */
export const APPROVAL_SCOPES = ['session', 'always'] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

/** The scopes of a `permission_request` payload, whatever shape it arrived in. */
export function approvalScopesOf(raw: unknown): ApprovalScope[] {
  if (!Array.isArray(raw)) return [];
  return APPROVAL_SCOPES.filter((scope) => raw.includes(scope));
}
