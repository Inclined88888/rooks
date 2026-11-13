/**
 * `ctx.sql` end to end (API 15): the loader opens the plugin's own database,
 * applies the manifest's migrations before `apply`, refuses to mount a plugin
 * whose migration fails, and closes the file when the plugin is unloaded.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import type { ModuleSetting } from '../config/schema.js';

const { createHttpPlugin } = await import('../kernel/http-service.js');
const { PluginLoader } = await import('./loader.js');
const { daemonHost } = await import('./context.js');
const { readManifest } = await import('./manifest.js');
const { PLUGIN_API_VERSION } = await import('./manifest.js');

function sqlPlugin(id: string, migrations: Record<string, string>, opts: { permissions?: string[] } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'rooks-plugin-db-'));
  const dir = join(root, 'node_modules', '@fixtures', id);
  mkdirSync(join(dir, 'lib'), { recursive: true });
  mkdirSync(join(dir, 'migrations'), { recursive: true });
  for (const [name, sql] of Object.entries(migrations)) writeFileSync(join(dir, 'migrations', name), sql);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `@fixtures/${id}`, version: '1.0.0', private: true, type: 'module', main: 'lib/index.js',
    rooks: {
      id, apiVersion: PLUGIN_API_VERSION, kind: ['behavior'], label: id, description: 'ctx.sql fixture',
      permissions: opts.permissions ?? ['storage:sql'], migrations: 'migrations',
    },
  }));
  writeFileSync(join(dir, 'lib', 'index.js'), [
    `export const name = '${id}'`,
    'export let applied = 0',
    'export function apply(ctx) {',
    '  applied++',
    "  ctx.sql.prepare('INSERT INTO notes (body) VALUES (?)').run('mounted')",
    "  ctx.router().get('/count', (_req, res) => res.json(ctx.sql.prepare('SELECT count(*) AS n FROM notes').get()))",
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [`@fixtures/${id}`]: 'file:fixture' } }));
  return root;
}

async function daemon() {
  const app = express();
  const ctx = new Context();
  await ctx.plugin(createHttpPlugin(app));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return { ctx, url: (p: string) => `http://127.0.0.1:${port}${p}`, close: async () => { server.close(); await ctx.fiber.dispose(); } };
}

test('a plugin with storage:sql gets its own migrated database, kept across remounts', async () => {
  const d = await daemon();
  const root = sqlPlugin('fixture-sql', { '001-notes.sql': 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);' });
  let plugins: Record<string, ModuleSetting> = {};
  const host = daemonHost(d.ctx);
  const loader = new PluginLoader(d.ctx, { dir: root, host, plugins: () => plugins, allowUnsigned: () => true });

  const [first] = await loader.update();
  assert.equal(first?.state, 'active', first?.error ?? '');
  assert.deepEqual(await (await fetch(d.url('/api/plugins/fixture-sql/count'))).json(), { n: 1 });
  assert.ok(existsSync(join(host.dataDir('fixture-sql'), 'plugin.db')), 'the file lives in the plugin data folder');

  // Unmounting closes the file; mounting again finds the data and does not re-run the migration.
  plugins = { 'fixture-sql': false };
  assert.equal((await loader.update())[0]?.state, 'disabled');
  plugins = {};
  const [again] = await loader.update();
  assert.equal(again?.state, 'active', again?.error ?? '');
  assert.deepEqual(await (await fetch(d.url('/api/plugins/fixture-sql/count'))).json(), { n: 2 });

  await loader.dispose();
  await d.close();
  rmSync(root, { recursive: true, force: true });
});

test('a failing migration leaves the plugin unmounted: apply never runs on a half-migrated schema', async () => {
  const d = await daemon();
  const root = sqlPlugin('fixture-sql-broken', {
    '001-notes.sql': 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);',
    '002-broken.sql': 'INSERT INTO missing_table VALUES (1);',
  });
  const loader = new PluginLoader(d.ctx, { dir: root, host: daemonHost(d.ctx), plugins: () => ({}), allowUnsigned: () => true });

  const [failed] = await loader.update();
  assert.equal(failed?.reason, 'skipped:migration');
  assert.match(failed?.error ?? '', /002-broken\.sql failed/);
  const res = await fetch(d.url('/api/plugins/fixture-sql-broken/count'));
  assert.equal(res.status, 404, 'no route: apply did not run');

  await loader.dispose();
  await d.close();
  rmSync(root, { recursive: true, force: true });
});

test('migrations without storage:sql are refused at the manifest', () => {
  const read = readManifest({
    rooks: { id: 'fixture-no-perm', apiVersion: PLUGIN_API_VERSION, kind: ['behavior'], label: 'x', description: 'x', permissions: ['storage'], migrations: 'migrations' },
  });
  assert.equal(read.ok, false);
  assert.match(!read.ok ? read.message : '', /`migrations` requires permission `storage:sql`/);
});
