/**
 * The body of an API error the webview can translate (TODO #829).
 *
 * The daemon speaks English (AGENTS.md, language rule): `error` stays the
 * English sentence every existing reader shows — CLI, MCP, agents, plugins.
 * `code` is a stable name the webview looks up under `apiErrors.<code>` in the
 * reader's language, `params` the values its message interpolates. A reader
 * that knows nothing of `code` keeps working: the English is still there.
 *
 * Pure on purpose: `@timon-ai/sdk` re-exports it, so a plugin route answers in
 * the same shape without reaching the daemon.
 */

/** Values a translated message interpolates: what ICU `{name}` accepts. */
export type ApiErrorParams = Readonly<Record<string, string | number>>;

export interface ApiErrorBody {
  /** The English message, unchanged for every reader that predates `code`. */
  error: string;
  /** Stable snake_case name: renaming it loses its translations. */
  code: string;
  /** Present only when the message has values to interpolate. */
  params?: ApiErrorParams;
}

/** snake_case, so the code is a valid key segment of a locale file. */
export const API_ERROR_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/**
 * `res.status(404).json(apiError('mission_not_found', 'mission not found'))`.
 *
 * A malformed code throws: it is a programming error, and failing on the first
 * call in a test beats an error no language can ever translate. Params that are
 * neither a string nor a finite number are dropped rather than sent as `null`.
 */
export function apiError(code: string, message: string, params?: Record<string, unknown>): ApiErrorBody {
  if (!API_ERROR_CODE.test(code)) throw new TypeError(`apiError: code must be snake_case, got "${code}"`);
  const body: ApiErrorBody = { error: message, code };
  if (params) {
    const kept: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(params)) {
      if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) kept[name] = value;
    }
    if (Object.keys(kept).length) body.params = kept;
  }
  return body;
}
