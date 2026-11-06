export type SkillWrite = { id: string; content: string } | { path: string; content: string };
export type SkillFormErrors = { id?: boolean; content?: boolean };

export function prepareSkillWrite(
  draft: { id: string; content: string },
  path?: string,
): { ok: true; payload: SkillWrite } | { ok: false; errors: SkillFormErrors } {
  const id = draft.id.trim();
  const errors: SkillFormErrors = {};
  if (!path && (!/^[a-z0-9._-]+$/.test(id) || id === '.' || id === '..')) errors.id = true;
  if (!draft.content.trim()) errors.content = true;
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, payload: path ? { path, content: draft.content } : { id, content: draft.content } };
}
