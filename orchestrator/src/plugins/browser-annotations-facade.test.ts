/**
 * `ctx.browserAnnotations` and the `browser_annotation_*` events (TODO #468) — refusals first:
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

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-browser-annotations-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { readManifest, PLUGIN_API_VERSION, SENSITIVE_PLUGIN_PERMISSIONS } = await import('./manifest.js');
const { createPluginContext, daemonHost, PluginPermissionError, PluginCallerError, PluginAdminError } = await import('./context.js');
const { runPluginRequest } = await import('./als.js');
const { dbApi } = await import('../db.js');
const { createBrowserProfile } = await import('../browser-profiles.js');
const { saveBrowserAnnotations, setBrowserAnnotationComment, getBrowserAnnotation } = await import('../browser-annotations.js');
const { resolveMasterKey } = await import('../secrets/key.js');
resolveMasterKey({ keyring: null });

type Identity = Parameters<typeof runPluginRequest>[0];
const ada = createTestAccount(dbApi, { email: 'ada-ann@example.com', name: 'Ada', passwordHash: 'unused', isSuperadmin: true });
const bob = createTestAccount(dbApi, { email: 'bob-ann@example.com', name: 'Bob', passwordHash: 'unused' });
const caller = (id: string, isSuperadmin = false): Identity => ({
  viewer: { id, isSuperadmin, permissions: [] },
  user: { id, email: `${id}@example.com`, name: id, is_superadmin: isSuperadmin },
  ownerUserId: id,
});
const anonymous: Identity = { viewer: null, user: undefined, ownerUserId: null };
const as = <T>(who: Identity, fn: () => Promise<T>) => runPluginRequest(who, fn);
const code = (c: string) => (err: unknown) => err instanceof PluginAdminError && err.code === c;

async function pluginWith(permissions: string[], id = 'acme-annotations') {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const res = readManifest({ timon: { id, apiVersion: PLUGIN_API_VERSION, permissions } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const plugin = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost(root));
  return { plugin, dispose: () => root.fiber.dispose() };
}

const COMMENT = 'ada-said-this-about-the-button';
const PAGE = 'page-text-of-the-button';
const pick = () => ({
  version: 1, capturedAt: new Date().toISOString(), url: 'http://localhost:3000/', title: 'App',
  point: { x: 1, y: 1 }, rect: { x: 0, y: 0, width: 10, height: 10 }, viewport: { width: 100, height: 100 },
  target: { tag: 'button', text: PAGE, selector: '#b' }, outerHtml: `<button>${PAGE}</button>`, source: { detected: false },
});
const profile = createBrowserProfile({ name: 'Ada browser', owner_user_id: ada.id });
const [draft] = saveBrowserAnnotations(profile, [pick()], { kind: 'user', id: ada.id }).annotations;
const annotation = setBrowserAnnotationComment(draft!, COMMENT, { kind: 'user', id: ada.id });

test('both permissions are sensitive', () => {
  for (const permission of ['browser:annotations:read', 'browser:annotations:write']) {
    assert.ok((SENSITIVE_PLUGIN_PERMISSIONS as readonly string[]).includes(permission), permission);
  }
});

test('without the permission in the manifest every call refuses', async () => {
  const { plugin, dispose } = await pluginWith(['storage', 'browser:read', 'browser:recordings:read']);
  await assert.rejects(as(caller(ada.id), () => plugin.browserAnnotations.list()), PluginPermissionError);
  await assert.rejects(as(caller(ada.id), () => plugin.browserAnnotations.get(annotation.id)), PluginPermissionError);
  const reader = await pluginWith(['browser:annotations:read'], 'acme-reader');
  await assert.rejects(as(caller(ada.id), () => reader.plugin.browserAnnotations.delete(annotation.id)), PluginPermissionError);
  await assert.rejects(as(caller(ada.id), () => reader.plugin.browserAnnotations.resolve(annotation.id, { status: 'dismissed', reason: 'x' })), PluginPermissionError);
  await assert.rejects(as(caller(ada.id), () => reader.plugin.browserAnnotations.setRef(annotation.id, null)), PluginPermissionError);
  await reader.dispose();
  await dispose();
});

test('anonymous is refused; another account, superadmin included, sees nothing of it', async () => {
  const { plugin, dispose } = await pluginWith(['browser:annotations:read', 'browser:annotations:write']);
  await assert.rejects(as(anonymous, () => plugin.browserAnnotations.list()), PluginCallerError);
  await assert.rejects(plugin.browserAnnotations.list(), PluginCallerError, 'outside any request');
  for (const other of [caller(bob.id), caller('root', true)]) {
    assert.deepEqual(await as(other, () => plugin.browserAnnotations.list()), []);
    assert.equal(await as(other, () => plugin.browserAnnotations.get(annotation.id)), undefined);
    await assert.rejects(as(other, () => plugin.browserAnnotations.delete(annotation.id)), code('not_found'));
    await assert.rejects(as(other, () => plugin.browserAnnotations.resolve(annotation.id, { status: 'resolved', summary: 'x' })), code('not_found'));
    await assert.rejects(as(other, () => plugin.browserAnnotations.setRef(annotation.id, { provider: 'github', ref: 'x', url: null })), code('not_found'));
  }
  assert.equal(getBrowserAnnotation(annotation.id)?.status, 'draft');
  await dispose();
});

test('the owner lists, reads, links, finds by reference and resolves', async () => {
  const { plugin, dispose } = await pluginWith(['browser:annotations:read', 'browser:annotations:write']);
  const me = caller(ada.id);
  const list = await as(me, () => plugin.browserAnnotations.list({ profileId: profile.id, status: 'draft' }));
  assert.deepEqual(list.map((row) => row.id), [annotation.id]);
  assert.equal('ownerUserId' in list[0]!, false);
  await assert.rejects(as(me, () => plugin.browserAnnotations.list({ status: 'open' as never })), code('invalid'));
  const read = await as(me, () => plugin.browserAnnotations.get(annotation.id));
  assert.equal(read?.comment, COMMENT);
  assert.equal(read?.page.target.text, PAGE);
  assert.equal('ownerUserId' in read!.annotation, false);
  const linked = await as(me, () => plugin.browserAnnotations.setRef(annotation.id, { provider: 'github', ref: 'acme/app#9', url: null }));
  assert.deepEqual(linked.externalRef, { provider: 'github', ref: 'acme/app#9', url: null });
  assert.equal((await as(me, () => plugin.browserAnnotations.findByRef('github', 'acme/app#9')))?.id, annotation.id);
  assert.equal(await as(caller(bob.id), () => plugin.browserAnnotations.findByRef('github', 'acme/app#9')), undefined);
  await assert.rejects(as(me, () => plugin.browserAnnotations.resolve(annotation.id, { status: 'resolved', summary: ' ' })), code('invalid'));
  await assert.rejects(as(me, () => plugin.browserAnnotations.resolve(annotation.id, { status: 'resolved', reason: 'x' } as never)), code('invalid'));
  const done = await as(me, () => plugin.browserAnnotations.resolve(annotation.id, { status: 'resolved', summary: 'Issue closed' }));
  assert.equal(done.status, 'resolved');
  assert.deepEqual(done.resolvedBy, { kind: 'plugin', id: 'acme-annotations' });
  await assert.rejects(as(me, () => plugin.browserAnnotations.resolve(annotation.id, { status: 'dismissed', reason: 'x' })), code('conflict'));
  await dispose();
});

test('events reach the owner\'s identity with their origin, never the comment nor the page', async () => {
  const { plugin, dispose } = await pluginWith(['events:subscribe', 'browser:annotations:read', 'browser:annotations:write']);
  const without = await pluginWith(['events:subscribe', 'browser:recordings:read'], 'acme-deaf');
  assert.throws(() => without.plugin.events.on('browser_annotation_created', () => {}), PluginPermissionError);
  const seen: Array<{ kind: string; origin: { kind: string; id: string | null }; annotationId: string; text: string }> = [];
  for (const kind of ['browser_annotation_created', 'browser_annotation_updated', 'browser_annotation_purged'] as const) {
    plugin.events.on(kind, (ev) => { seen.push({ kind: ev.kind, origin: ev.origin, annotationId: ev.annotationId, text: JSON.stringify(ev) }); });
  }
  const [second] = saveBrowserAnnotations(profile, [pick()], { kind: 'user', id: ada.id }).annotations;
  setBrowserAnnotationComment(second!, COMMENT, { kind: 'user', id: ada.id });
  await as(caller(ada.id), () => plugin.browserAnnotations.delete(second!.id));
  // Bob's annotation goes to nobody but Bob.
  saveBrowserAnnotations(createBrowserProfile({ name: 'Bob browser', owner_user_id: bob.id }), [pick()], { kind: 'user', id: bob.id });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const mine = seen.filter((ev) => ev.annotationId === second!.id);
  assert.deepEqual(mine.map((ev) => ev.kind), ['browser_annotation_created', 'browser_annotation_updated', 'browser_annotation_purged']);
  assert.deepEqual(mine[0]!.origin, { kind: 'user', id: ada.id });
  assert.deepEqual(mine[2]!.origin, { kind: 'plugin', id: 'acme-annotations' }, 'a plugin recognizes its own write');
  assert.ok(seen.every((ev) => !ev.text.includes(COMMENT) && !ev.text.includes(PAGE) && !ev.text.includes('ownerUserId')));
  assert.equal(seen.length, mine.length, 'nothing of Bob\'s');
  await without.dispose();
  await dispose();
});
