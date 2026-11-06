import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { NextRequest } from 'next/server';
import { getSortedRoutes } from 'next/dist/shared/lib/router/utils/sorted-routes';
import { getRouteRegex } from 'next/dist/shared/lib/router/utils/route-regex';
import { getRouteMatcher } from 'next/dist/shared/lib/router/utils/route-matcher';
import * as fallback from '../app/api/[[...route]]/route';

// Use Next's route ordering over the actual files: a handler-only test would
// miss the original bug, where the plugin page won before any API handler ran.
const root = join(process.cwd(), 'src', 'app');
const routes = getSortedRoutes(readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /^(page|route)\.tsx?$/.test(entry.name))
  .map((entry) => '/' + relative(root, entry.parentPath).split(sep).filter((part) => part && !/^\(.*\)$/.test(part)).join('/')));
const resolveRoute = (path: string) => routes.find((route) => getRouteMatcher(getRouteRegex(route))(path));

test('unknown API URLs resolve to the API fallback, never the plugin shell', () => {
  for (const path of ['/api', '/api/ui/kanban', '/api/unknown.json', '/api/ui/unknown/deep']) {
    assert.equal(resolveRoute(path), '/api/[[...route]]', path);
  }
  assert.equal(resolveRoute('/api/ui/auth/login'), '/api/ui/auth/login');
  assert.equal(resolveRoute('/api/health'), '/api/health');
  assert.equal(resolveRoute('/some-plugin'), '/[...route]');
});

test('anonymous requests to unknown APIs are refused as uncached JSON for every method', async () => {
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const) {
    const response = fallback[method](new NextRequest('http://localhost/api/ui/kanban', { method }));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type')!, /application\/json/);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  }
});

test('even an arbitrary session cookie cannot obtain the shell from an unknown API', async () => {
  const response = fallback.GET(new NextRequest('http://localhost/api/ui/kanban', {
    headers: { cookie: 'timon_session=not-a-valid-session' },
  }));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
});
