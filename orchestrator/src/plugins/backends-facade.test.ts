/**
 * `ctx.backends.list` (API 10): the catalogue a plugin reads before it creates
 * an agent with a `backend` and a `model`.
 */
import { admin, anonymous, as, nobody, pluginWith } from '../../tests/helpers/facade-kit.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { PluginPermissionError, PluginCallerError } = await import('./context.js');
const { catalogForViewer } = await import('../plugins-bundled/backends/account-routes.js');

test('without backends:read the catalogue is refused, backends:register notwithstanding', async () => {
  const { plugin, dispose } = await pluginWith(['backends:register']);
  await assert.rejects(as(admin, () => plugin.backends.list()), PluginPermissionError);
  await assert.rejects(plugin.backends.list(), PluginPermissionError);
  await dispose();
});

test('an anonymous request is refused', async () => {
  const { plugin, dispose } = await pluginWith(['backends:read']);
  await assert.rejects(as(anonymous, () => plugin.backends.list()), PluginCallerError);
  await dispose();
});

test('a request and a job read the catalogue the route would give them', async () => {
  const { plugin, dispose } = await pluginWith(['backends:read']);
  const request = await as(nobody, () => plugin.backends.list());
  assert.deepEqual(request, catalogForViewer({ id: 'nobody', isSuperadmin: false, permissions: [] }));
  assert.ok(request.backends.some((b) => b.id === 'claude'), 'the built-in backends are listed');
  assert.equal(typeof request.defaultBackend, 'string');
  const job = await plugin.backends.list();
  assert.deepEqual(job, catalogForViewer(null));
  assert.ok(job.backends.every((b) => !b.account), 'a job has no subscription account');
  await dispose();
});
