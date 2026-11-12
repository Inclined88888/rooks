/**
 * A display name typed by a human → the agent name Rooks will actually use.
 *
 * The daemon is authoritative (`orchestrator/src/onboarding-main-agent.ts`
 * holds the same conversion, and it is the one that writes the directory).
 * This copy exists so the onboarding screen can SHOW the result while the
 * user types instead of surprising them after the fact — an agent name is a
 * filesystem identity, so "Rooks, mon assistante" cannot be one verbatim.
 */
export function toAgentName(raw: string): string {
  return raw
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48);
}
