'use client';

/**
 * Writes on the teams API, with the daemon's own words on failure.
 *
 * The teams routes sit behind `agents:manage`: a viewer without it takes a
 * 403 here. That must be readable, not a stack trace — so every call returns
 * the `error` field the daemon sends, and the caller shows it as is.
 */
import { t } from '@/lib/i18n';
import { explainDaemonError } from './cloisonnement';

async function write(method: string, path: string, body?: unknown): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    return t('bots.daemonUnreachable');
  }
  if (response.ok) return null;
  const payload = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (response.status === 403) return t('bots.forbidden');
  return typeof payload.error === 'string' && payload.error.trim().length > 0
    ? explainDaemonError(payload.error)
    : t('bots.writeFailed');
}

export function createTeam(name: string, color: string | null): Promise<string | null> {
  return write('POST', '/api/ui/teams', { name, color });
}

export function updateTeam(id: string, patch: { name?: string; color?: string | null }): Promise<string | null> {
  return write('PATCH', `/api/ui/teams/${encodeURIComponent(id)}`, patch);
}

export function deleteTeam(id: string): Promise<string | null> {
  return write('DELETE', `/api/ui/teams/${encodeURIComponent(id)}`);
}

export function addMember(teamId: string, agent: string): Promise<string | null> {
  return write('POST', `/api/ui/teams/${encodeURIComponent(teamId)}/members`, { agent });
}

export function removeMember(teamId: string, agent: string): Promise<string | null> {
  return write(
    'DELETE',
    `/api/ui/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(agent)}`,
  );
}
