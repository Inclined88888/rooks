/**
 * Native triggers that start a workflow (TODO #216): the triggers whose
 * `workflow` action targets it. Read from the triggers' own rows — the action
 * is the one place the link is written, the workflow keeps no copy that could
 * drift from it.
 *
 * A binding only counts when the trigger's owner may launch the workflow
 * (same account, or a superadmin / system trigger): a row nobody could fire
 * must not silence the workflow's own sources either.
 */
import { db } from '../db.js';

export type NativeBinding = {
  trigger_id: string;
  name: string;
  source: string;
  slug: string | null;
  enabled: boolean;
  node_id: string;
};

type BindingRow = Omit<NativeBinding, 'enabled'> & { enabled: number };

export function nativeBindings(workflowId: string): NativeBinding[] {
  const rows = db.prepare(`
    SELECT t.id AS trigger_id, t.name, t.source, t.slug, t.enabled, json_extract(a.value, '$.node') AS node_id
      FROM workflows w, triggers t, json_each(t.actions) a
     WHERE w.id = ?
       AND json_extract(a.value, '$.type') = 'workflow'
       AND json_extract(a.value, '$.workflow') IN (w.id, w.slug)
       AND (t.grants IS NULL
            OR EXISTS (SELECT 1 FROM json_each(t.grants) g WHERE g.value = '*')
            OR t.owner_user_id IS w.owner_user_id)
     ORDER BY t.created_at`).all(workflowId) as BindingRow[];
  return rows.map((row) => ({ ...row, enabled: row.enabled === 1 }));
}
