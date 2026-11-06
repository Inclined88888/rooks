/**
 * Moves the outcome of TO DO ideas out of `project_todo` into the table of the
 * `@timon/todo-outcomes` plugin, then drops the three columns.
 *
 * Runs at every boot from `db.ts`, and does nothing once the columns are gone.
 * It lives in the core on purpose: it must run whether the plugin is enabled
 * or not, otherwise dropping the columns would lose what the plugin never
 * copied. Plain migration tooling — the core knows nothing else of outcomes.
 */
import type Database from 'better-sqlite3';

/** Keep identical to the DDL in `plugins-bundled/todo-outcomes/store.ts`. */
export const TODO_OUTCOME_DDL = `
CREATE TABLE IF NOT EXISTS todo_outcome (
  todo_id INTEGER PRIMARY KEY REFERENCES project_todo(id) ON DELETE CASCADE,
  resolution TEXT,
  public_note TEXT,
  duplicate_of TEXT,
  updated_at INTEGER NOT NULL
);`;

/** Name of the table while the plugin was called `@timon/author-feedback`. */
const LEGACY_TABLE = 'author_feedback_outcome';

const COLUMNS = ['resolution', 'public_note', 'duplicate_of'] as const;

const tableExists = (db: Database.Database, name: string): boolean =>
  db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;

export function migrateTodoOutcomeColumns(db: Database.Database): void {
  // Before the column check: installs that already dropped the columns still
  // carry the table under its old name, and the plugin would otherwise start
  // on an empty `todo_outcome` beside it.
  if (tableExists(db, LEGACY_TABLE) && !tableExists(db, 'todo_outcome')) {
    db.exec(`ALTER TABLE ${LEGACY_TABLE} RENAME TO todo_outcome`);
  }
  const cols = (db.prepare(`PRAGMA table_info(project_todo)`).all() as { name: string }[]).map((c) => c.name);
  const present = COLUMNS.filter((c) => cols.includes(c));
  if (!present.length) return;
  db.exec(TODO_OUTCOME_DDL);
  const pick = (c: (typeof COLUMNS)[number]) => (present.includes(c) ? c : 'NULL');
  const filled = present.map((c) => `${c} IS NOT NULL`).join(' OR ');
  db.transaction(() => {
    const expected = (db.prepare(`SELECT COUNT(*) n FROM project_todo WHERE ${filled}`).get() as { n: number }).n;
    // An outcome already in the plugin table is newer than the column: keep it.
    db.prepare(`
      INSERT OR IGNORE INTO todo_outcome (todo_id, resolution, public_note, duplicate_of, updated_at)
      SELECT id, ${pick('resolution')}, ${pick('public_note')}, ${pick('duplicate_of')}, updated_at
      FROM project_todo WHERE ${filled}`).run();
    const copied = (db.prepare(`
      SELECT COUNT(*) n FROM project_todo t JOIN todo_outcome o ON o.todo_id = t.id
      WHERE ${filled.split(' OR ').map((c) => `t.${c}`).join(' OR ')}`).get() as { n: number }).n;
    // Throwing rolls the copy back and keeps the columns: the daemon refuses to
    // boot rather than drop data it could not account for.
    if (copied !== expected) {
      throw new Error(`TO DO outcome migration: ${copied} of ${expected} rows copied, columns kept`);
    }
    for (const c of present) db.exec(`ALTER TABLE project_todo DROP COLUMN ${c}`);
  })();
}
