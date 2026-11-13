/**
 * An agent exported by another Rooks, imported here (SUG-0084): what the
 * source's settings become on this machine. Its working directory is used
 * when it exists, said and replaced by a proposal when it does not (a
 * Windows path read on Linux); a backend or model this Rooks lacks is said in
 * the preview and left out; a setting Rooks refuses (a directory outside every
 * project) falls back to the defaults instead of failing the agent.
 */
import { account, admin, as } from '../../tests/helpers/facade-kit.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';

const { createPluginContext, daemonHost } = await import('./context.js');
type PluginContext = import('./context.js').PluginContext;
const { readManifest } = await import('./manifest.js');
const { loadConfig } = await import('../agent-config.js');
const { dbApi } = await import('../db.js');

const pkg = (await import('../../../plugins/agent-import/package.json', { with: { type: 'json' } })).default as { rooks: unknown };

type Json = Record<string, unknown>;
type PreviewAgent = {
  sourceRef: string; action: string; finalName: string; warnings: string[]; role: string; project: string | null;
  cwd: string | null; sourceCwd: string | null; cwdSuggestion: string | null;
  backend: string | null; model: string | null; backendMissing: boolean; modelMissing: boolean;
};
type Engine = {
  preview(m: unknown, o?: unknown): Promise<{ agents: PreviewAgent[]; warnings: string[] }>;
  apply(m: unknown, o?: unknown): Promise<{ agents: Array<{ status: string; agent: string | null; warnings: string[]; error?: string }> }>;
};

const lib = await import('../../../plugins/agent-import/lib/index.js') as unknown as {
  createEngine(ctx: PluginContext): Engine;
  suggestCwd(sourceCwd: string, home?: string, exists?: (path: string) => boolean): string | null;
};

const ada = account('ada-rooks', ['agents:manage', 'skills:manage', 'mcp:manage', 'triggers:manage', 'kanban:write']);

async function loaded(): Promise<{ engine: Engine; dispose: () => Promise<void> }> {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const manifest = readManifest(pkg);
  assert.ok(manifest.ok, manifest.ok ? '' : manifest.message);
  const plugin = createPluginContext(inner, { manifest: manifest.manifest, version: '0.1.0' }, daemonHost(root));
  return { engine: lib.createEngine(plugin), dispose: () => root.fiber.dispose() };
}

let seq = 0;
const app = (): string => `tsrc${++seq}`;

const manifestOf = (source: string, agents: Json[]): Json => ({
  format: 'rooks-agent-import', version: 1, source: { app: source, exportedAt: null }, agents,
});

const agent = (key: string, hints: Json): Json => ({
  key, displayName: key, soul: null, instructions: `Help with ${key}.`, hints, sourceRef: `${key}-ref`,
});

test('suggestCwd: the trailing folders of a path of any OS, under this home, longest first', () => {
  const home = join(tmpdir(), 'home-x');
  const present = new Set([join(home, 'code', 'app'), join(home, 'app')]);
  const exists = (p: string): boolean => present.has(p);
  assert.equal(lib.suggestCwd('C:\\Users\\bob\\code\\app', home, exists), join(home, 'code', 'app'));
  assert.equal(lib.suggestCwd('/Users/bob/code/app', home, exists), join(home, 'code', 'app'));
  assert.equal(lib.suggestCwd('/srv/other/app', home, exists), join(home, 'app'));
  assert.equal(lib.suggestCwd('/srv/nothing/here', home, exists), null);
  // `..` never climbs out of the home, and the home itself is never proposed.
  assert.equal(lib.suggestCwd('C:\\..\\..', home, () => true), null);
  assert.equal(lib.suggestCwd('/bob', home, () => true), null);
});

test('the working directory of the source: used when it exists here, else said with a proposal', async () => {
  const { engine, dispose } = await loaded();
  try {
    const project = mkdtempSync(join(tmpdir(), 'agent-import-proj-'));
    const work = join(project, 'work');
    mkdirSync(work);
    dbApi.upsertProject('rooks-proj', { name: 'proj', cwd: project });
    const source = app();
    const m = manifestOf(source, [
      agent('here', { cwd: work, role: 'coder', project: 'rooks-proj' }),
      agent('win', { cwd: 'C:\\Users\\bob\\code\\no-such-folder-on-this-machine' }),
    ]);
    const preview = await as(ada, () => engine.preview(m));
    const [here, win] = preview.agents;
    assert.equal(here!.cwd, work);
    assert.equal(here!.role, 'coder', 'a Rooks role is kept');
    assert.equal(here!.project, 'rooks-proj', 'a project that exists here is kept');
    assert.equal(win!.cwd, null);
    assert.equal(win!.sourceCwd, 'C:\\Users\\bob\\code\\no-such-folder-on-this-machine');
    assert.ok(win!.warnings.some((w) => w.includes('does not exist on this machine')), JSON.stringify(win!.warnings));

    const result = await as(ada, () => engine.apply(m));
    assert.deepEqual(result.agents.map((a) => a.status), ['created', 'created'], JSON.stringify(result));
    const cfg = loadConfig(`${source}.here`)!;
    assert.equal(cfg.cwd, work);
    assert.equal(cfg.role, 'coder');
    assert.equal(cfg.project, 'rooks-proj');
    assert.equal(loadConfig(`${source}.win`)!.cwd, undefined);
  } finally { await dispose(); }
});

test('a directory Rooks refuses (outside every project) falls back to the defaults, the agent is still made', async () => {
  const { engine, dispose } = await loaded();
  try {
    const loose = mkdtempSync(join(tmpdir(), 'agent-import-loose-'));
    const source = app();
    const m = manifestOf(source, [agent('loose', { cwd: loose, project: 'no-such-project-here' })]);
    const result = await as(ada, () => engine.apply(m));
    assert.equal(result.agents[0]!.status, 'created', JSON.stringify(result));
    assert.ok(result.agents[0]!.warnings.some((w) => w.includes('refused here')));
    const cfg = loadConfig(`${source}.loose`)!;
    assert.equal(cfg.cwd, undefined);
    assert.equal(cfg.project, undefined);
    // A superadmin is not bound by the project rule: the directory is kept.
    const kept = app();
    const res = await as(admin, () => engine.apply(manifestOf(kept, [agent('loose', { cwd: loose })])));
    assert.equal(res.agents[0]!.status, 'created');
    assert.equal(loadConfig(`${kept}.loose`)!.cwd, loose);
  } finally { await dispose(); }
});

test('backends and models: kept when this Rooks has them, said in the preview when it does not', async () => {
  const { engine, dispose } = await loaded();
  try {
    const source = app();
    const m = manifestOf(source, [
      agent('gone', { backend: 'no-such-backend', model: 'whatever' }),
      agent('nomodel', { backend: 'claude', model: 'no-such-model-x' }),
      agent('instance', { backend: 'claude@0123456789' }),
      agent('kept', { backend: 'claude', model: 'opus' }),
    ]);
    const preview = await as(ada, () => engine.preview(m));
    const by = Object.fromEntries(preview.agents.map((a) => [a.sourceRef, a]));
    assert.equal(by['gone-ref']!.backendMissing, true);
    assert.equal(by['gone-ref']!.backend, null);
    assert.ok(by['gone-ref']!.warnings.some((w) => w.includes('no-such-backend')));
    assert.equal(by['nomodel-ref']!.backend, 'claude');
    assert.equal(by['nomodel-ref']!.modelMissing, true);
    assert.equal(by['nomodel-ref']!.model, null);
    assert.equal(by['instance-ref']!.backend, 'claude', 'an account of the source machine maps to its provider');
    assert.equal(by['kept-ref']!.backend, 'claude');
    assert.equal(by['kept-ref']!.model, 'opus');
    assert.equal(by['kept-ref']!.backendMissing, false);
  } finally { await dispose(); }
});
