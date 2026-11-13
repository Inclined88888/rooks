/**
 * The rules of the export dialog, apart from React so they are tested on
 * their own: the selection, the body sent to `export`, the file name, and
 * which message a refusal shows.
 */

/** What `GET agents` answers, one per agent the account may export. */
export type ExportableAgent = { name: string; role: string | null; project: string | null };

/** One archive holds this many agents at most (`EXPORT_MAX_AGENTS` of the host). */
export const EXPORT_DIALOG_MAX = 100;

export const EXPORT_ERROR_CODES = ['unauthorized', 'forbidden', 'invalid', 'not_found', 'too_many', 'too_large'] as const;

/** `name` added to the selection, or taken out of it. */
export function toggled(selected: readonly string[], name: string): string[] {
  return selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name];
}

/** Every agent when some are missing, none when all are there. */
export function toggledAll(selected: readonly string[], agents: readonly ExportableAgent[]): string[] {
  const all = agents.map((a) => a.name);
  return all.every((name) => selected.includes(name)) ? [] : all;
}

/** The names still offered, in the order of the list: an agent removed meanwhile drops out. */
export function kept(selected: readonly string[], agents: readonly ExportableAgent[]): string[] {
  return agents.map((a) => a.name).filter((name) => selected.includes(name));
}

/** The body of `export`, or `null` when nothing can be sent. */
export function exportBody(selected: readonly string[]): { agents: string[] } | null {
  if (selected.length === 0 || selected.length > EXPORT_DIALOG_MAX) return null;
  return { agents: [...selected] };
}

/** The proxy does not hand the browser the daemon's file name: the same one is made here. */
export function exportFileName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `rooks-agents-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.zip`;
}

/** The message key of a refusal of `agents` or `export`. */
export function exportFailureKey(status: number, body: unknown): string {
  const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {};
  const code = typeof record.code === 'string' ? record.code : '';
  if ((EXPORT_ERROR_CODES as readonly string[]).includes(code)) return `export.errors.${code}`;
  if (status === 401) return 'export.errors.unauthorized';
  if (status === 403) return 'export.errors.forbidden';
  if (status === 404) return 'export.errors.unavailable';
  return 'export.errors.network';
}
