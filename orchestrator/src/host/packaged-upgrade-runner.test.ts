import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

/** Runtime imports reachable from `entry`, each mapped to the file that pulled it in. */
function importGraph(entry: string): Map<string, string | null> {
  const seen = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    const source = readFileSync(join(SRC, file), 'utf8');
    for (const match of source.matchAll(/^\s*(import|export)\s([^;]*?)from\s*['"](\.[^'"]+)['"]/gms)) {
      if (/^type\s/.test(match[2])) continue;
      const target = relative(SRC, join(SRC, dirname(file), match[3].replace(/\.js$/, '.ts')));
      if (!seen.has(target)) {
        seen.set(target, file);
        queue.push(target);
      }
    }
  }
  return seen;
}

function chain(graph: Map<string, string | null>, file: string): string {
  const path: string[] = [];
  for (let at: string | null | undefined = file; at; at = graph.get(at)) path.unshift(at);
  return path.join(' -> ');
}

for (const runner of ['packaged-upgrade-runner.ts', 'packaged-apply.ts', 'windows-restart-runner.ts', 'desktop-uninstall-runner.ts', 'desktop-service-runner.ts', 'diagnostic-report-runner.ts', 'mission-process-sweep-runner.ts']) {
  test(`the ${runner} desktop runner never loads the database module`, () => {
    // db.ts refuses to load while the update is unapproved, and the desktop
    // only records the approval after the upgrade runner has moved the service:
    // a runner that reaches db.ts leaves the service in place (#126, #207).
    const graph = importGraph(join('host', runner));
    for (const forbidden of ['db.ts', 'onboarding.ts']) {
      assert.equal(graph.has(forbidden), false, chain(graph, forbidden));
    }
  });
}

test('the terminal host loads nothing of the daemon: no database, no settings, no config', () => {
  // It outlives the daemon and runs whatever release launched it: state it
  // read at start would go stale, and db.ts would open a second writer.
  const graph = importGraph(join('terminal-host', 'main.ts'));
  for (const forbidden of ['db.ts', 'settings.ts', join('config', 'load.ts'), 'paths.ts']) {
    assert.equal(graph.has(forbidden), false, chain(graph, forbidden));
  }
  for (const file of graph.keys()) assert.ok(file.startsWith(`terminal-host${sep}`), `${file} is outside src/terminal-host`);
});
