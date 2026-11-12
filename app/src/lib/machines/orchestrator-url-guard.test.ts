/**
 * Ratchet: the daemon's address is read in two places only.
 *
 * The app relays a browser request to the machine the user switched to
 * (TODO #329): a file that reads `ORCHESTRATOR_URL` itself always talks to the
 * local daemon, silently, whatever machine is active — or, if it adds a
 * credential, sends the local one where it must not go. The address lives in
 * `lib/paths.ts` and is handed out by `lib/machines/`: `resolveTarget(req)`
 * for a browser request, `localTarget()` for what must stay local (workers,
 * webhooks, daemon-token clients), and `relayFetch` to call either.
 *
 * Tests are exempt: they point the env variable at their fake daemon.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../..', import.meta.url));

const ALLOWED_FILES = ['lib/paths.ts'];
const ALLOWED_DIRS = ['lib/machines/'];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules' && name !== 'vendor') sources(path, out);
    } else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

test('ORCHESTRATOR_URL is read only by lib/paths.ts and lib/machines/', () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const rel = relative(SRC, file).split(sep).join('/');
    if (ALLOWED_FILES.includes(rel) || ALLOWED_DIRS.some((dir) => rel.startsWith(dir))) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (/\bORCHESTRATOR_URL\b/.test(line)) offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], 'go through lib/machines/target.ts: resolveTarget(req) or localTarget(), then relayFetch');
});

test('the allowed places still exist', () => {
  for (const rel of [...ALLOWED_FILES, ...ALLOWED_DIRS]) {
    assert.ok(statSync(join(SRC, ...rel.split('/').filter(Boolean))), rel);
  }
});
