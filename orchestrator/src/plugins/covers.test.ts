/**
 * Who may load a plugin picto: an anonymous request stops at the daemon's
 * auth (401), a signed-in viewer without `plugin:<id>` gets the 404 of an
 * unknown plugin, an allowed one gets the SVG.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

const { CoverRegistry, coverRouter } = await import('./covers.js');
const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');

const TOKEN = 'icon-test-daemon-token';

/** `restricted`: a signed-in member whose grants do not include the plugin. */
async function serve(registry: InstanceType<typeof CoverRegistry>, restricted = false): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  if (restricted) {
    app.use((req, _res, next) => {
      (req as unknown as { auth: unknown }).auth = { kind: 'api-token', user: null, isSuperadmin: false, actorId: 'member', permissions: ['missions:read'] };
      next();
    });
  } else {
    app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
  }
  app.use(coverRouter(() => registry));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', () => done()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

test('GET /plugins/<id>/icon: refused to an anonymous viewer, served to an allowed one', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-icon-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const registry = new CoverRegistry();
  const res = registry.registerIcon('acme-crm', dir, 'icon.svg');
  assert.ok(res.ok);

  const daemon = await serve(registry);
  t.after(daemon.close);
  assert.equal((await fetch(`${daemon.url}/plugins/acme-crm/icon`)).status, 401, 'anonymous');

  const member = await serve(registry, true);
  t.after(member.close);
  assert.equal((await fetch(`${member.url}/plugins/acme-crm/icon`)).status, 404, 'no plugin:acme-crm grant');

  const ok = await fetch(`${daemon.url}/plugins/acme-crm/icon`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/svg+xml');
  assert.equal(registry.registerIcon('acme-crm', dir, 'icon.png').ok, false, 'an icon is an SVG');
});
