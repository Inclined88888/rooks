/**
 * The queue of a messaging integration, as the daemon serves it through
 * `/api/ui/integration-receipts`: what is retrying, what ran out of retries.
 * A preview of the message, never its reply context nor the connection's config.
 */
export type IntegrationReceipt = {
  id: string;
  externalId: string;
  stage: 'inbox' | 'reply';
  status: 'failed' | 'retrying';
  attempts: number;
  lastError: string | null;
  missionId: string | null;
  preview: string;
  createdAt: number;
  nextAt: number | null;
  failedAt: number | null;
};

export type IntegrationReceiptConnection = {
  id: string;
  pluginId: string;
  transport: string;
  agent: string;
  enabled: boolean;
  /** Set for an administrator looking at someone else's connection. */
  owner: { id: string; name: string | null; email: string | null } | null;
  counts: { queued: number; retrying: number; failed: number };
  receipts: IntegrationReceipt[];
};

const BASE = '/api/ui/integration-receipts';

export async function loadIntegrationReceipts(): Promise<IntegrationReceiptConnection[] | null> {
  const response = await fetch(BASE, { cache: 'no-store' });
  if (!response.ok) return null;
  return (await response.json() as { connections: IntegrationReceiptConnection[] }).connections;
}
export function replayReceipt(id: string): Promise<Response> {
  return fetch(`${BASE}/${encodeURIComponent(id)}/replay`, { method: 'POST', cache: 'no-store' });
}
export function discardReceipt(id: string): Promise<Response> {
  return fetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE', cache: 'no-store' });
}
export function replayFailedReceipts(connectionId: string): Promise<Response> {
  return fetch(`${BASE}/connections/${encodeURIComponent(connectionId)}/replay-failed`, { method: 'POST', cache: 'no-store' });
}

/** A failure stays on screen until someone acts: connections with one come first. */
export function byAttention(connections: IntegrationReceiptConnection[]): IntegrationReceiptConnection[] {
  const weight = (connection: IntegrationReceiptConnection) => (connection.counts.failed > 0 ? 2 : connection.counts.retrying > 0 ? 1 : 0);
  return [...connections].sort((a, b) => weight(b) - weight(a));
}
