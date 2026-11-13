/**
 * What `POST /api/agents/:name/rename` left for a person to read: the triggers
 * whose filter it could not carry over, and what else it could not move. Read
 * defensively: the rename has happened, a malformed answer must not undo a Save.
 */
export type RenameFollowUps = { triggers: string[]; warnings: string[] };

export function renameFollowUps(body: unknown): RenameFollowUps {
  const answer = (body && typeof body === 'object' ? body : {}) as { triggers_to_check?: unknown; warnings?: unknown };
  const triggers = Array.isArray(answer.triggers_to_check)
    ? answer.triggers_to_check.flatMap((item: unknown) => {
        const name = item && typeof item === 'object' ? (item as { name?: unknown }).name : undefined;
        return typeof name === 'string' ? [name] : [];
      })
    : [];
  const warnings = Array.isArray(answer.warnings)
    ? answer.warnings.filter((w: unknown): w is string => typeof w === 'string')
    : [];
  return { triggers, warnings };
}
