import { apiErrorMessage } from '@/lib/api-error';
/**
 * Per-user plugin connections, as the daemon serves them through
 * `/api/ui/plugin-connections`. Secret NAMES only: no response carries a value.
 */
export type ConnectionField = { key: string; label: string; required?: boolean; placeholder?: string };
export type ConnectionSecretField = { name: string; label: string; required?: boolean };

export type ConnectionType = {
  id: string;
  pluginId: string;
  label: string;
  description: string | null;
  fields: ConnectionField[];
  secrets: ConnectionSecretField[];
  customTest: boolean;
};

export type ConnectionApproval = 'pending' | 'approved' | 'rejected';

export type UserConnection = {
  id: string;
  pluginId: string;
  type: string;
  label: string;
  url: string;
  allowPrivateNetwork: boolean;
  config: Record<string, unknown>;
  secrets: string[];
  approval: ConnectionApproval;
  enabled: boolean;
  revision: number;
  owner?: { id: string; name: string | null; email: string | null };
};

/** What a form submits; the owner is the session, never a field. */
export type ConnectionInput = {
  label: string;
  url: string;
  allowPrivateNetwork?: boolean;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
};

export type ConnectionSubmitResult = { ok: true; connection: UserConnection } | { ok: false; error: string };

/** What `PATCH` takes: only the fields that changed. A `null` secret removes it. */
export type ConnectionPatch = {
  label?: string;
  url?: string;
  allowPrivateNetwork?: boolean;
  config?: Record<string, unknown>;
  secrets?: Record<string, string | null>;
  enabled?: boolean;
};

// The generic form holds every value as text: `8642` and `'8642'` are the same
// field, so an untouched form never sends its config back.
const configText = (value: unknown) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value));
function sameConfig(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = (config: Record<string, unknown>) => Object.keys(config).filter((key) => config[key] !== undefined).sort();
  const left = keys(a); const right = keys(b);
  return left.length === right.length && left.every((key, index) => key === right[index] && configText(a[key]) === configText(b[key]));
}

/**
 * The edit of `initial` that `input` describes. A secret left empty keeps the
 * stored one: the browser never had its value to send back. The config is
 * replaced whole, because the daemon validates it whole against the plugin's
 * schema.
 */
export function connectionChanges(initial: UserConnection, input: ConnectionInput): ConnectionPatch {
  const patch: ConnectionPatch = {};
  const label = input.label.trim();
  if (label !== initial.label) patch.label = label;
  const url = input.url.trim();
  if (url !== initial.url) patch.url = url;
  if (input.allowPrivateNetwork !== undefined && input.allowPrivateNetwork !== initial.allowPrivateNetwork) {
    patch.allowPrivateNetwork = input.allowPrivateNetwork;
  }
  if (input.config !== undefined && !sameConfig(input.config, initial.config)) patch.config = input.config;
  const secrets = Object.fromEntries(Object.entries(input.secrets ?? {}).filter(([, value]) => value !== ''));
  if (Object.keys(secrets).length) patch.secrets = secrets;
  return patch;
}

const originOf = (url: string): string | null => { try { return new URL(url).origin; } catch { return null; } };

/**
 * Whether the edit asks for a new approval: what an approver looked at is the
 * origin and the local-network flag. The daemon decides; this only warns.
 */
export function reopensApproval(initial: UserConnection, patch: ConnectionPatch): boolean {
  if (patch.allowPrivateNetwork !== undefined && patch.allowPrivateNetwork !== initial.allowPrivateNetwork) return true;
  return patch.url !== undefined && originOf(patch.url) !== originOf(initial.url);
}

const BASE = '/api/ui/plugin-connections';

async function submitted(response: Response): Promise<ConnectionSubmitResult> {
  const body = await response.json().catch(() => ({})) as { connection?: UserConnection; error?: string };
  return response.ok && body.connection ? { ok: true, connection: body.connection } : { ok: false, error: apiErrorMessage(body, { status: response.status }) };
}

export async function createConnection(type: string, input: ConnectionInput): Promise<ConnectionSubmitResult> {
  return submitted(await fetch(BASE, {
    method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ type, ...input }),
  }));
}

export async function updateConnection(id: string, patch: ConnectionPatch): Promise<ConnectionSubmitResult> {
  return submitted(await patchConnection(id, patch));
}

export async function connectionAction(id: string, action: 'test' | 'approve' | 'reject'): Promise<Response> {
  return fetch(`${BASE}/${encodeURIComponent(id)}/${action}`, { method: 'POST', cache: 'no-store' });
}

export async function patchConnection(id: string, patch: ConnectionPatch): Promise<Response> {
  return fetch(`${BASE}/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, cache: 'no-store', body: JSON.stringify(patch),
  });
}

export async function deleteConnection(id: string): Promise<Response> {
  return fetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE', cache: 'no-store' });
}
