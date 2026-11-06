/**
 * `examples/plugin-todo-connector`: the template a third party copies. It must
 * keep loading against the public contract, or it stops being a template.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import type { PluginHost, PluginTodoEventKind } from './context.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../examples/plugin-todo-connector');
const { readManifest } = await import('./manifest.js');
const { createPluginContext } = await import('./context.js');
const { apply } = await import(join(DIR, 'lib/index.js')) as { apply(ctx: unknown): void };

test('the template has a valid manifest and registers its webhook and its closure handler', async () => {
  const parsed = readManifest(JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8')));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const webhooks: string[] = [];
  const events: PluginTodoEventKind[] = [];
  const host = {
    webhooks: { register: (_id: string, name: string) => { webhooks.push(name); return () => undefined; } },
    todoEvents: { subscribe: (_id: string, kind: PluginTodoEventKind) => { events.push(kind); return () => undefined; } },
  } as unknown as PluginHost;
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  apply(createPluginContext(inner, { manifest: parsed.manifest, version: '0.1.0' }, host));
  assert.deepEqual(webhooks, ['issues']);
  assert.deepEqual(events, ['todo_done']);
  await root.fiber.dispose();
});
