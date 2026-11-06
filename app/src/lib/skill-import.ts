import type { SkillSource } from '@/lib/skill-sources';

/**
 * A claude mission runs with its own Claude config dir: `~/.claude/skills`,
 * `~/.claude/commands` and `~/.claude/plugins` never reach it. Only Timon
 * skills (attached) and the project's `.claude` (loaded natively by Claude Code
 * only: Codex and the other backends never read it) do.
 */
export function skillReachesMissions(source: SkillSource): boolean {
  return source === 'timon' || source === 'project';
}

export type ImportableSource = Extract<SkillSource, 'claude-user' | 'plugin'>;

export function isImportableSource(source: SkillSource): source is ImportableSource {
  return source === 'claude-user' || source === 'plugin';
}

/** `orchestrator/src/skill-registry.ts` `defaultImportId`: a Timon id has no namespace. */
export function defaultImportId(sourceId: string): string {
  return sourceId.toLowerCase().replace(/:/g, '-');
}

/** `orchestrator/src/skill-registry.ts` `isImportableId`. */
export function isImportableId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/.test(id) && !id.endsWith('.');
}

/** The i18n key of what went wrong, under `skillMission.`. */
export type SkillImportError =
  | 'idError' | 'exists' | 'needsPrivileged' | 'forbidden' | 'unauthorized' | 'tooLarge' | 'notFound' | 'failed' | 'network';

export type SkillImportResult = { ok: true; id: string } | { ok: false; error: SkillImportError };

/** Copies a `claude-user` / `plugin` skill into the Timon skills folder under `as`. */
export async function requestSkillImport(sourceId: string, source: ImportableSource, as: string): Promise<SkillImportResult> {
  const target = as.trim();
  if (!isImportableId(target)) return { ok: false, error: 'idError' };
  let r: Response;
  try {
    r = await fetch(`/api/ui/skills/${encodeURIComponent(sourceId)}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source, as: target }),
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  let body: { id?: unknown; code?: unknown; reason?: unknown } = {};
  try { body = await r.json() as typeof body; } catch { /* an empty or non-JSON body says nothing more than its status */ }
  if (r.ok) return { ok: true, id: typeof body.id === 'string' ? body.id : target };
  if (r.status === 401) return { ok: false, error: 'unauthorized' };
  if (r.status === 403) {
    return { ok: false, error: String(body.reason ?? '').includes('agents:privileged-config') ? 'needsPrivileged' : 'forbidden' };
  }
  if (r.status === 404) return { ok: false, error: 'notFound' };
  if (r.status === 409) return { ok: false, error: 'exists' };
  if (r.status === 413) return { ok: false, error: 'tooLarge' };
  if (r.status === 400 && body.code === 'invalid_id') return { ok: false, error: 'idError' };
  return { ok: false, error: 'failed' };
}
