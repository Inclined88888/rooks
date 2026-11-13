/**
 * The one place the webview turns a daemon error into words (TODO #829,
 * docs/I18N.md, section `Erreurs d'API`).
 *
 * The daemon answers `{ error, code?, params? }`: `error` is English, `code` a
 * stable name. With a code the dictionary knows (`apiErrors.<code>`, read in
 * the reader's language down to English), the reader gets the translation;
 * otherwise the daemon's English, as before; with no message at all, the
 * caller's fallback, then a generic sentence with the HTTP status.
 */
import { hasKey, t } from './i18n';

/** Mirror of `ApiErrorBody` (orchestrator/src/plugins/contract/api-error.ts): the two packages share no code. */
export interface ParsedApiError {
  /** The daemon's English message, `''` when the body has none. */
  message: string;
  code: string | null;
  params: Record<string, string | number>;
}

const CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** The error a body carries, or `null` when it carries none. */
export function parseApiError(body: unknown): ParsedApiError | null {
  if (body === null || typeof body !== 'object') return null;
  const raw = body as { error?: unknown; code?: unknown; params?: unknown };
  const message = typeof raw.error === 'string' ? raw.error.trim() : '';
  const code = typeof raw.code === 'string' && CODE.test(raw.code) ? raw.code : null;
  if (!message && !code) return null;
  const params: Record<string, string | number> = {};
  if (raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)) {
    for (const [name, value] of Object.entries(raw.params as Record<string, unknown>)) {
      if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) params[name] = value;
    }
  }
  return { message, code, params };
}

/** The dictionary key of a code, exported for the tests and the scanner. */
export function apiErrorKey(code: string): string {
  return `apiErrors.${code}`;
}

/**
 * What to show for an error body. `fallback` is read only when the body says
 * nothing; give the HTTP status rather than a sentence when you have it.
 */
export function apiErrorMessage(body: unknown, fallback?: string | { status: number }): string {
  const parsed = parseApiError(body);
  if (parsed?.code && hasKey(apiErrorKey(parsed.code))) return t(apiErrorKey(parsed.code), parsed.params);
  if (parsed?.message) return parsed.message;
  if (typeof fallback === 'string' && fallback) return fallback;
  if (fallback && typeof fallback === 'object') return t('apiErrors.http_status', { status: fallback.status });
  return t('apiErrors.unknown');
}

/**
 * The message of a failed `Response`, body read as JSON. The body is consumed:
 * call it instead of `res.json()`, not after.
 */
export async function responseErrorMessage(res: Response, fallback?: string): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  return apiErrorMessage(body, fallback || { status: res.status });
}
