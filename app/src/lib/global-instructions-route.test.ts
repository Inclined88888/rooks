/**
 * The app reaches the daemon only through a route file per endpoint: the pane
 * reads and writes `/api/ui/global-instructions`, so that file must exist and
 * carry both verbs. (A settings pane once shipped without it and answered
 * "not_found" in front of the user.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const route = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'api', 'ui', 'global-instructions', 'route.ts');

test('the global instructions route proxies GET and a plain-text PUT to the daemon', () => {
  const source = readFileSync(route, 'utf8');
  assert.match(source, /export async function GET/);
  assert.match(source, /export async function PUT/);
  assert.match(source, /\/api\/global-instructions/);
  assert.match(source, /text\/plain/);
  assert.match(source, /sessionProxyHeaders\(\)/, 'the caller\'s session travels with the write');
});
