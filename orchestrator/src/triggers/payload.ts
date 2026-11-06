/**
 * What a trigger reads: the payload of its source plus, for a webhook, the
 * request headers. Filters and templates address it with dotted paths —
 * `issue.title`, `commits.0.id`, `headers.X-GitHub-Event`.
 *
 * Everything in here is untrusted input, authenticated or not: a signed
 * webhook proves who sent it, not that its fields are safe to obey.
 */

export type TriggerInput = {
  body: unknown;
  /** Lower-cased names, auth headers already stripped. */
  headers: Record<string, string>;
};

/** Upper bound on path depth: a path is config, never data, but stays cheap. */
const MAX_SEGMENTS = 32;

export const PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_\-]*(\.[A-Za-z0-9_\-]+)*$/;

/**
 * Resolve a dotted path. `headers.<Name>` reads a header case-insensitively;
 * any other path walks the payload. Own properties only: `__proto__` or
 * `constructor` must resolve to nothing, not to Object's internals.
 */
export function lookup(input: TriggerInput, path: string): unknown {
  const segments = path.split('.');
  if (segments.length > MAX_SEGMENTS) return undefined;
  if (segments[0] === 'headers' && segments.length === 2) {
    const name = segments[1]!.toLowerCase();
    return Object.hasOwn(input.headers, name) ? input.headers[name] : undefined;
  }
  let current: unknown = input.body;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
