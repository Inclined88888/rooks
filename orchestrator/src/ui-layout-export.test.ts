/**
 * Le placement des widgets doit voyager avec `timon export` / `timon import`.
 *
 * Aucun code ne l'y met : il vit dans `ui_layout`, et la base part entière par
 * `VACUUM INTO`. Ce test existe pour que cette gratuité reste vraie — le jour
 * où quelqu'un filtrerait des tables à l'export, c'est ici que ça casse.
 *
 * Piège de méthode : `export.test.ts` passe `vacuumInto: () => {}`, ce qui
 * n'emporte AUCUNE base. Copier cette forme donnerait un test vert qui ne
 * prouve rien. On exerce ici le vrai chemin, celui de `/api/admin/export`.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { db, dbApi } = await import('./db.js');
const { exportTimon, importTimon } = await import('./export.js');

test('un export emporte le placement des widgets, et un import le restaure', () => {
  const home = process.env.TIMON_HOME!;
  const layout = [{ id: 'agenda', rail: 'droite', rang: 1, hauteur: 320 }];
  dbApi.uiLayoutSet('', 'cockpit', JSON.stringify(layout));

  const out = join(mkdtempSync(join(tmpdir(), 'timon-layout-archive-')), 'export.tar.gz');
  exportTimon({
    out,
    home,
    // Exactement ce que fait la route /api/admin/export : la base ouverte du
    // daemon, copiée à chaud sans son -wal serait tronquée.
    vacuumInto: (dest) => { db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); },
  });

  const to = mkdtempSync(join(tmpdir(), 'timon-layout-import-'));
  importTimon({ file: out, to });

  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  const restored = new Database(join(to, 'timon.db'), { readonly: true });
  try {
    const row = restored.prepare(`SELECT value FROM ui_layout WHERE scope=?`).get('cockpit') as
      { value: string } | undefined;
    assert.ok(row, 'la table ui_layout doit avoir voyagé avec la base');
    assert.deepEqual(JSON.parse(row.value), layout);
  } finally {
    restored.close();
  }
});
