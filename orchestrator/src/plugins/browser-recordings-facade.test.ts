/**
 * `ctx.browserRecordings` and the `browser_recording_*` events (TODO #461) — refusals first:
 * the manifest, the anonymous caller, another account (superadmin included); then what the
 * owner gets, and the events with their origin, metadata only.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-plugin-browser-recordings-'));
await import('../../tests/helpers/paid-license.js');
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError, PluginCallerError, PluginAdminError } = await import('./context.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { createBrowserProfile } = await import('../browser-profiles.js');
const { saveBrowserRecording, getBrowserRecording } = await import('../browser-recordings.js');
const { resolveMasterKey } = await import('../secrets/key.js');
resolveMasterKey({ keyring: null });

type Identity = Parameters<typeof runPluginRequest>[0];
// Ada may use every plugin (an admin of her install); Bob may use none.
const ada = createTestAccount(dbApi, { email: 'ada-rec@example.com', name: 'Ada', passwordHash: 'unused', isSuperadmin: true });
const bob = createTestAccount(dbApi, { email: 'bob-rec@example.com', name: 'Bob', passwordHash: 'unused' });
const caller = (id: string, isSuperadmin = false): Identity => ({
  viewer: { id, isSuperadmin, permissions: [] },
  user: { id, email: `${id}@example.com`, name: id, is_superadmin: isSuperadmin },
  ownerUserId: id,
});
const anonymous: Identity = { viewer: null, user: undefined, ownerUserId: null };
const as = <T>(who: Identity, fn: () => Promise<T>) => runPluginRequest(who, fn);
const code = (c: string) => (err: unknown) => err instanceof PluginAdminError && err.code === c;

async function pluginWith(permissions: string[], id = 'acme-recordings') {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ rooks: { id, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(root));
  return { plugin, dispose: () => root.fiber.dispose() };
}

const TYPED = 'ada-typed-this';
const profile = createBrowserProfile({ name: 'Ada browser', owner_user_id: ada.id });
const raw = { version: 1, startedAt: new Date().toISOString(), url: 'https://shop.example/', truncated: false, stoppedReason: 'user',
  steps: [{ t: 0, type: 'input', tabId: 't', selector: '#q', inputType: 'text', name: 'Search', value: TYPED }] };
const recording = saveBrowserRecording(profile, raw, { kind: 'user', id: ada.id });

test('without the permission in the manifest every call refuses', async () => {
  const { plugin, dispose } = await pluginWith(['storage', 'browser:read']);
  await assert.rejects(as(caller(ada.id), () => plugin.browserRecordings.list()), PluginPermissionError);
  await assert.rejects(as(caller(ada.id), () => plugin.browserRecordings.get(recording.id)), PluginPermissionError);
  const reader = await pluginWith(['browser:recordings:read'], 'acme-reader');
  await assert.rejects(as(caller(ada.id), () => reader.plugin.browserRecordings.delete(recording.id)), PluginPermissionError);
  await assert.rejects(as(caller(ada.id), () => reader.plugin.browserRecordings.patch(recording.id, [{ op: 'drop', step: 1 }])), PluginPermissionError);
  await reader.dispose();
  await dispose();
});

test('anonymous is refused; another account, superadmin included, sees nothing of it', async () => {
  const { plugin, dispose } = await pluginWith(['browser:recordings:read', 'browser:recordings:write']);
  await assert.rejects(as(anonymous, () => plugin.browserRecordings.list()), PluginCallerError);
  await assert.rejects(plugin.browserRecordings.list(), PluginCallerError, 'outside any request');
  for (const other of [caller(bob.id), caller('root', true)]) {
    assert.deepEqual(await as(other, () => plugin.browserRecordings.list()), []);
    assert.equal(await as(other, () => plugin.browserRecordings.get(recording.id)), undefined);
    await assert.rejects(as(other, () => plugin.browserRecordings.delete(recording.id)), code('not_found'));
    await assert.rejects(as(other, () => plugin.browserRecordings.patch(recording.id, [{ op: 'drop', step: 1 }])), code('not_found'));
    await assert.rejects(as(other, () => plugin.browserRecordings.setRef(recording.id, { provider: 'github', ref: 'x', url: null })), code('not_found'));
  }
  assert.ok(getBrowserRecording(recording.id));
  await dispose();
});

test('the owner lists, reads, reviews, links and finds by reference', async () => {
  const { plugin, dispose } = await pluginWith(['browser:recordings:read', 'browser:recordings:write']);
  const me = caller(ada.id);
  const list = await as(me, () => plugin.browserRecordings.list({ profileId: profile.id }));
  assert.deepEqual(list.map((row) => row.id), [recording.id]);
  assert.equal('ownerUserId' in list[0]!, false);
  const read = await as(me, () => plugin.browserRecordings.get(recording.id));
  assert.equal(read?.steps?.[0]?.value, TYPED);
  await assert.rejects(as(me, () => plugin.browserRecordings.patch(recording.id, [{ op: 'explode', step: 1 } as never])), code('invalid'));
  await assert.rejects(as(me, () => plugin.browserRecordings.patch(recording.id, [{ op: 'drop', step: 9 }])), code('invalid'));
  const renamed = await as(me, () => plugin.browserRecordings.patch(recording.id, [{ op: 'rename', title: 'Find shoes' }]));
  assert.equal(renamed.recording.title, 'Find shoes');
  const linked = await as(me, () => plugin.browserRecordings.setRef(recording.id, { provider: 'github', ref: 'acme/app#7', url: null }));
  assert.deepEqual(linked.externalRef, { provider: 'github', ref: 'acme/app#7', url: null });
  assert.equal((await as(me, () => plugin.browserRecordings.findByRef('github', 'acme/app#7')))?.id, recording.id);
  assert.equal(await as(caller(bob.id), () => plugin.browserRecordings.findByRef('github', 'acme/app#7')), undefined);
  await dispose();
});

test('events reach the owner\'s identity with their origin, never a step', async () => {
  const { plugin, dispose } = await pluginWith(['events:subscribe', 'browser:recordings:read', 'browser:recordings:write']);
  const without = await pluginWith(['events:subscribe'], 'acme-deaf');
  assert.throws(() => without.plugin.events.on('browser_recording_stopped', () => {}), PluginPermissionError);
  const seen: Array<{ kind: string; origin: { kind: string; id: string | null }; recordingId: string | null; text: string }> = [];
  plugin.events.on('browser_recording_stopped', (ev) => { seen.push({ kind: ev.kind, origin: ev.origin, recordingId: ev.recordingId, text: JSON.stringify(ev) }); });
  plugin.events.on('browser_recording_purged', (ev) => { seen.push({ kind: ev.kind, origin: ev.origin, recordingId: ev.recordingId, text: JSON.stringify(ev) }); });
  const second = saveBrowserRecording(profile, raw, { kind: 'user', id: ada.id });
  await as(caller(ada.id), () => plugin.browserRecordings.delete(second.id));
  // Bob's recording goes to nobody but Bob.
  saveBrowserRecording(createBrowserProfile({ name: 'Bob browser', owner_user_id: bob.id }), raw, { kind: 'user', id: bob.id });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const mine = seen.filter((ev) => ev.recordingId === second.id);
  assert.deepEqual(mine.map((ev) => ev.kind), ['browser_recording_stopped', 'browser_recording_purged']);
  assert.deepEqual(mine[0]!.origin, { kind: 'user', id: ada.id });
  assert.deepEqual(mine[1]!.origin, { kind: 'plugin', id: 'acme-recordings' }, 'a plugin recognizes its own write');
  assert.ok(seen.every((ev) => !ev.text.includes(TYPED) && !ev.text.includes('ownerUserId')));
  await without.dispose();
  await dispose();
});
