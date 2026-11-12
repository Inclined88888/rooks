/**
 * Calls of the Triggers page to the app's same-origin proxy (`/api/ui/…`).
 * One shape for every answer, so a refusal is shown with the daemon's reason
 * instead of a bare status.
 */

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: string };

export async function requestJson<T>(method: string, url: string, body?: unknown): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      cache: 'no-store',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message };
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error
      : `HTTP ${response.status}`;
    return { ok: false, status: response.status, error };
  }
  return { ok: true, status: response.status, data: data as T };
}

export const TRIGGERS_API = '/api/ui/triggers';

export function triggerApi(id: string, sub = ''): string {
  return `${TRIGGERS_API}/${encodeURIComponent(id)}${sub ? `/${sub}` : ''}`;
}
