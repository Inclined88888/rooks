/**
 * The agent import engine (plugins/agent-import, built `lib/index.js`) on the
 * real plugin context and the real facades: refusals first — an invalid
 * manifest, an anonymous caller, a skill that pre-authorises tools — then
 * names, the per-agent rollback, idempotent re-imports and hand edits.
 */
import { account, admin, anonymous, as, type Identity } from '../../tests/helpers/facade-kit.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';

const { createPluginContext, daemonHost } = await import('./context.js');
type PluginContext = import('./context.js').PluginContext;
const { readManifest } = await import('./manifest.js');
const { getAgent, upsertAgent, writeDoc, readDoc } = await import('../agent.js');
const { loadConfig } = await import('../agent-config.js');
const { getMcp } = await import('../mcp.js');
const { skillDir, skillFile } = await import('../paths.js');
const { listTriggerRows } = await import('../triggers/store.js');
const { setMcpHostLookupForTest } = await import('../mcp-url-guard.js');
const { renameAgentKeepingSeat } = await import('../main-agent.js');
const { dbApi } = await import('../db.js');
const { listAgentTrash } = await import('../agent-trash.js');
const inTrash = (name: string): boolean => listAgentTrash().some((e) => e.name === name);
const { TimonConfigSchema } = await import('../config/schema.js');
const { setConfig, resetConfig } = await import('../config/load.js');

setMcpHostLookupForTest(async () => [{ address: '93.184.215.14', family: 4 }]);
test.after(() => { setMcpHostLookupForTest(null); });

const pkg = (await import('../../../plugins/agent-import/package.json', { with: { type: 'json' } })).default as { timon: unknown };

type Json = Record<string, unknown>;
type Preview = { agents: Array<Json & { sourceRef: string; action: string; finalName: string; warnings: string[]; elements: Record<string, { count: number; selected: boolean }> }>; warnings: string[] };
type Applied = { agents: Array<{ sourceRef: string; agent: string | null; status: string; error?: string; warnings: string[] }>; warnings: string[] };
type Engine = { preview(m: unknown, o?: unknown): Promise<Preview>; apply(m: unknown, o?: unknown): Promise<Applied> };
type Records = unknown;

const lib = await import('../../../plugins/agent-import/lib/index.js') as unknown as {
  createEngine(ctx: PluginContext): Engine;
  parseManifest(value: unknown): Json;
  createRecords(kv: PluginContext['storage']['kv']): Records;
  planImport(ctx: unknown, records: Records, manifest: unknown, options?: unknown): Promise<{ agents: unknown[] }>;
  applyPlan(ctx: unknown, records: Records, plan: unknown): Promise<Applied>;
  stripAllowedTools(content: string): { content: string; removed: boolean };
};

const RIGHTS = ['agents:manage', 'skills:manage', 'mcp:manage', 'triggers:manage', 'kanban:write'];
const ada = account('ada', RIGHTS);

async function loaded(): Promise<{ plugin: PluginContext; engine: Engine; dispose: () => Promise<void> }> {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const manifest = readManifest(pkg);
  assert.ok(manifest.ok, manifest.ok ? '' : manifest.message);
  const plugin = createPluginContext(inner, { manifest: manifest.manifest, version: '0.1.0' }, daemonHost(root));
  return { plugin, engine: lib.createEngine(plugin), dispose: () => root.fiber.dispose() };
}

let seq = 0;
/** A source app of its own per test: names and records never cross tests. */
const app = (): string => `src${++seq}`;

function agent(key: string, over: Json = {}): Json {
  return {
    key,
    displayName: key.toUpperCase(),
    title: 'Research assistant',
    soul: `I am ${key}.`,
    instructions: `Help with ${key}.`,
    memories: [{ text: `${key} prefers short answers.`, kind: 'preference' }],
    skills: [{ id: `${key}-brief`, content: `---\nname: ${key}-brief\ndescription: brief\n---\n\nWrite a brief.\n` }],
    routines: [{
      name: 'Morning', instruction: `Brief {issue.title} for ${key}.`, schedule: { kind: 'daily', time: '08:30' },
      timezone: 'Europe/Paris', enabledInSource: false,
    }],
    mcpServers: [{ name: `${key} search`, transport: 'http', url: `https://mcp.${key}.example.com/sse`, secretNames: ['SEARCH_TOKEN'] }],
    sourceRef: `${key}-ref`,
    ...over,
  };
}

const manifestOf = (source: string, agents: Json[], extra: Json = {}): Json => ({
  format: 'timon-agent-import', version: 1, source: { app: source, exportedAt: null }, agents, ...extra,
});

test('an invalid manifest is refused, and its message never echoes a value', () => {
  const good = manifestOf('openbot', [agent('ada')]);
  assert.ok(lib.parseManifest(good));
  const bad: Array<[string, Json]> = [
    ['unknown top-level field', { ...good, extra: true }],
    ['unknown agent field', manifestOf('openbot', [{ ...agent('ada'), shell: 'rm -rf /' }])],
    ['wrong version', { ...good, version: 2 }],
    ['wrong format', { ...good, format: 'openbot-import' }],
    ['no agent', manifestOf('openbot', [])],
    ['key with a dot', manifestOf('openbot', [agent('a.b')])],
    ['duplicate key', manifestOf('openbot', [agent('ada'), { ...agent('ada'), sourceRef: 'other' }])],
    ['secret path in a skill', manifestOf('openbot', [agent('ada', { skills: [{ id: 'x', content: 'x', companionFiles: ['../.env'] }] })])],
    ['absolute companion path', manifestOf('openbot', [agent('ada', { skills: [{ id: 'x', content: 'x', companionFiles: ['/etc/passwd'] }] })])],
    ['stdio without its transport kind', manifestOf('openbot', [agent('ada', { mcpServers: [{ name: 'x', transport: 'ssh' }] })])],
  ];
  for (const [label, value] of bad) {
    assert.throws(() => lib.parseManifest(value), (err: Error) => err.name === 'ManifestError' && !err.message.includes('rm -rf'), label);
  }
});

test('an anonymous caller gets nothing, and nothing is written', async () => {
  const { engine, dispose } = await loaded();
  try {
    const source = app();
    const m = manifestOf(source, [agent('anon')]);
    await assert.rejects(as(anonymous, () => engine.preview(m)));
    await assert.rejects(as(anonymous, () => engine.apply(m)));
    assert.equal(getAgent(`${source}.anon`), null);
    // Nor an account that may not create agents.
    await assert.rejects(as(account('eve', ['skills:manage']), () => engine.apply(m)));
    assert.equal(getAgent(`${source}.anon`), null);
  } finally { await dispose(); }
});

test('apply creates the agent with its documents, skills, MCP server, rules and routine', async () => {
  const { plugin, engine, dispose } = await loaded();
  try {
    const source = app();
    const m = manifestOf(source, [agent('ada')]);
    const preview = await as(ada, () => engine.preview(m));
    const p = preview.agents[0]!;
    assert.equal(p.action, 'create');
    assert.equal(p.finalName, `${source}.ada`);
    assert.equal(p.role, 'research');
    assert.deepEqual(Object.keys(p.elements).sort(), ['mcp', 'memory', 'routines', 'skills', 'soul', 'team']);
    assert.deepEqual(p.elements.skills, { count: 1, selected: true });
    assert.deepEqual(p.elements.team, { count: 0, selected: false });
    assert.ok(p.warnings.some((w) => w.includes('SEARCH_TOKEN')), 'secret names are listed');
    assert.equal(getAgent(`${source}.ada`), null, 'a preview writes nothing');

    const result = await as(ada, () => engine.apply(m));
    assert.deepEqual(result.agents.map((a) => [a.status, a.agent]), [['created', `${source}.ada`]], JSON.stringify(result));
    const name = `${source}.ada`;
    const cfg = loadConfig(name)!;
    assert.equal(cfg.created_by, 'plugin:agent-import');
    assert.equal(cfg.role, 'research');
    assert.deepEqual(cfg.mcp_servers, ['ada-search']);
    assert.match(readDoc(name, 'SOUL.md') ?? '', /^# ADA\n\n\*Research assistant\*\n\nI am ada\./);
    assert.equal(readDoc(name, 'system-prompt.md'), 'Help with ada.');
    assert.ok(existsSync(skillFile('ada-brief')));
    assert.equal((getMcp('ada-search')!.transport as { url: string }).url, 'https://mcp.ada.example.com/sse');
    assert.equal((getMcp('ada-search')!.transport as { headers?: unknown }).headers, undefined, 'no secret value travels');
    const rules = dbApi.listRules({ agent: name });
    assert.deepEqual(rules.map((r) => [r.text, r.kind, r.source]), [['ada prefers short answers.', 'preference', 'plugin:agent-import']]);
    const triggers = listTriggerRows().filter((t) => t.name === `${name}: Morning`);
    assert.equal(triggers.length, 1);
    assert.equal(triggers[0]!.enabled, 0, 'the state of the source is kept');
    const def = JSON.parse(triggers[0]!.config) as { cron: string; tz: string };
    assert.deepEqual(def, { cron: '30 8 * * *', tz: 'Europe/Paris' });
    const action = (JSON.parse(triggers[0]!.actions) as Array<Json>)[0]!;
    assert.equal(action.raw, true, 'the instruction is never a template');
    assert.equal(action.agent, name);
  } finally { await dispose(); }
});

test('names: a name taken gets -2, a prefix used by another writer falls back to import.', async () => {
  const { engine, dispose } = await loaded();
  try {
    const source = app();
    // Somebody else's agent under the prefix the user chose.
    upsertAgent({ name: `${source}.ada`, system_prompt: 'mine', config: { role: 'research', backend: 'claude' } });
    const chosen = await as(ada, () => engine.preview(manifestOf(source, [agent('ada')]), { prefix: source }));
    assert.equal(chosen.agents[0]!.finalName, `${source}.ada-2`);
    assert.ok(chosen.agents[0]!.warnings.some((w) => w.includes('-2')));

    // Without a chosen prefix: `<source>.` is another writer's namespace (Hermes Gateway's `hermes.<conn>.<profile>`).
    const fallback = await as(ada, () => engine.preview(manifestOf(source, [agent('bob')])));
    assert.equal(fallback.agents[0]!.finalName, 'import.bob');
    assert.ok(fallback.warnings.some((w) => w.includes('import.')));

    // Two agents of one manifest asking for the same name, and an invalid name.
    const twins = await as(ada, () => engine.preview(manifestOf(app(), [agent('x1'), agent('x2')]), {
      agents: [{ sourceRef: 'x1-ref', name: 'shared' }, { sourceRef: 'x2-ref', name: 'shared' }],
    }));
    assert.deepEqual(twins.agents.map((a) => a.finalName), ['shared', 'shared-2']);
    const invalid = await as(ada, () => engine.preview(manifestOf(source, [agent('cy')]), { prefix: source, agents: [{ sourceRef: 'cy-ref', name: '../etc' }] }));
    assert.equal(invalid.agents[0]!.finalName, `${source}.cy`);
  } finally { await dispose(); }
});

test('rollback: a failure in the middle of an agent removes it and what it created; the others are imported', async () => {
  const { plugin, dispose } = await loaded();
  try {
    const source = app();
    const records = lib.createRecords(plugin.storage.kv);
    const m = lib.parseManifest(manifestOf(source, [agent('one'), agent('two', { avatar: null }), agent('three')]));
    // The facades of the plugin, with the trigger of `two` refused once its agent, skill, server and rule exist.
    const failing = new Proxy(plugin, {
      get(target, prop, receiver) {
        if (prop !== 'triggers') return Reflect.get(target, prop, receiver);
        return {
          ...target.triggers,
          create: async (input: { name: string }) => {
            if (input.name.startsWith(`${source}.two:`)) throw Object.assign(new Error('trigger store unavailable'), { code: 'unavailable' });
            return target.triggers.create(input as Parameters<typeof target.triggers.create>[0]);
          },
        };
      },
    });
    const result = await as(ada, async () => lib.applyPlan(failing, records, await lib.planImport(failing, records, m)));
    assert.deepEqual(result.agents.map((a) => [a.sourceRef, a.status]), [['one-ref', 'created'], ['two-ref', 'failed'], ['three-ref', 'created']]);
    const failed = result.agents[1]!;
    assert.equal(failed.agent, null);
    assert.match(failed.error ?? '', /trigger store unavailable/);
    assert.equal(getAgent(`${source}.two`), null, 'the agent is removed');
    assert.equal(inTrash(`${source}.two`), false, 'purged: nothing left to restore');
    assert.equal(existsSync(skillFile('two-brief')), false, 'its skill too');
    assert.equal(getMcp('two-search') ?? null, null, 'and its MCP server');
    assert.equal(dbApi.listRules({ agent: `${source}.two` }).length, 0, 'and its rule');
    assert.ok(getAgent(`${source}.one`) && getAgent(`${source}.three`));
    assert.ok(existsSync(skillFile('one-brief')) && existsSync(skillFile('three-brief')));
    const kept = (await plugin.storage.kv.list('ref:')).map((e) => (e.value as { agent: string }).agent);
    assert.ok(kept.includes(`${source}.one`) && kept.includes(`${source}.three`));
    assert.ok(!kept.includes(`${source}.two`), 'no record for the agent rolled back');
  } finally { await dispose(); }
});

test('rollback: a team made for an agent that fails is removed with it', async () => {
  const { plugin, dispose } = await loaded();
  try {
    const source = app();
    const records = lib.createRecords(plugin.storage.kv);
    const teamName = `Desk ${source}`;
    const m = lib.parseManifest(manifestOf(source, [agent('solo')], { groups: [{ key: 'desk', name: teamName, members: ['solo'] }] }));
    // The last write of the agent, joining its new team, is refused.
    const failing = new Proxy(plugin, {
      get(target, prop, receiver) {
        if (prop !== 'agents') return Reflect.get(target, prop, receiver);
        return {
          ...target.agents,
          update: async (name: string, patch: { team?: unknown }) => {
            if (patch.team !== undefined) throw Object.assign(new Error('team store unavailable'), { code: 'unavailable' });
            return target.agents.update(name, patch as Parameters<typeof target.agents.update>[1]);
          },
        };
      },
    });
    const result = await as(ada, async () => lib.applyPlan(failing, records, await lib.planImport(failing, records, m)));
    assert.equal(result.agents[0]!.status, 'failed', JSON.stringify(result));
    assert.deepEqual(result.agents[0]!.warnings.filter((w) => w.includes('Could not undo')), []);
    assert.equal(getAgent(`${source}.solo`), null);
    assert.equal(inTrash(`${source}.solo`), false);
    assert.equal(dbApi.listTeams(null).some((t) => t.name === teamName), false, 'the team is gone too');
  } finally { await dispose(); }
});

test('rollback of a re-import: prompt and documents come back, the previous routines stay', async () => {
  const { plugin, engine, dispose } = await loaded();
  try {
    const source = app();
    const name = `${source}.back`;
    await as(ada, () => engine.apply(manifestOf(source, [agent('back', { docs: [{ name: 'NOTES.md', content: 'First notes.' }] })])));
    const soulBefore = readDoc(name, 'SOUL.md');
    const triggersBefore = listTriggerRows().filter((t) => t.name.startsWith(`${name}:`)).map((t) => t.id);
    assert.equal(triggersBefore.length, 1);

    const second = lib.parseManifest(manifestOf(source, [agent('back', {
      instructions: 'Rewritten prompt.', soul: 'Rewritten soul.', docs: [{ name: 'NOTES.md', content: 'Rewritten notes.' }, { name: 'EXTRA.md', content: 'New file.' }],
      skills: [{ id: 'back-brief', content: '---\nname: back-brief\ndescription: brief\n---\n\nRewritten skill.\n' }],
    })]));
    // The store refuses the record of the second import: everything is undone.
    const kv = plugin.storage.kv;
    const failingKv = { ...kv, set: async (key: string, value: unknown) => {
      if (key.startsWith('ref:')) throw new Error('store unavailable');
      return kv.set(key, value as never);
    } } as typeof kv;
    const plan = await as(ada, () => lib.planImport(plugin, lib.createRecords(failingKv), second));
    const result = await as(ada, () => lib.applyPlan(plugin, lib.createRecords(failingKv), plan));
    assert.equal(result.agents[0]!.status, 'failed', JSON.stringify(result));
    assert.deepEqual(result.agents[0]!.warnings.filter((w) => w.includes('Could not undo')), []);
    assert.equal(readDoc(name, 'system-prompt.md'), 'Help with back.');
    assert.equal(readDoc(name, 'SOUL.md'), soulBefore);
    assert.equal(readDoc(name, 'NOTES.md'), 'First notes.');
    assert.equal(readDoc(name, 'EXTRA.md'), null);
    assert.ok(readFileSync(skillFile('back-brief'), 'utf8').includes('Write a brief.'), 'the skill text too');
    const triggersAfter = listTriggerRows().filter((t) => t.name.startsWith(`${name}:`)).map((t) => t.id);
    assert.deepEqual(triggersAfter, triggersBefore, 'the routine of the first import is still there, the new one is gone');
    // The record of the first import still leads the next one to an update.
    const preview = await as(ada, () => engine.preview(manifestOf(source, [agent('back')])));
    assert.equal(preview.agents[0]!.action, 'update');
  } finally { await dispose(); }
});

test('re-import: the same agent is updated, nothing is duplicated', async () => {
  const { plugin, engine, dispose } = await loaded();
  try {
    const source = app();
    const first = manifestOf(source, [agent('rei')]);
    assert.equal((await as(ada, () => engine.apply(first))).agents[0]!.status, 'created');
    const name = `${source}.rei`;
    const triggersBefore = listTriggerRows().filter((t) => t.name.startsWith(`${name}:`)).map((t) => t.id);

    const second = manifestOf(source, [agent('rei', { instructions: 'Help with rei, version 2.' })]);
    const preview = await as(ada, () => engine.preview(second));
    assert.equal(preview.agents[0]!.action, 'update');
    assert.equal(preview.agents[0]!.finalName, name);
    const result = await as(ada, () => engine.apply(second));
    assert.deepEqual(result.agents.map((a) => [a.status, a.agent]), [['updated', name]], JSON.stringify(result));
    assert.equal(readDoc(name, 'system-prompt.md'), 'Help with rei, version 2.');
    assert.equal(getAgent(`${name}-2`), null, 'no twin');
    assert.equal(existsSync(skillDir('rei-brief-2')), false, 'the skill is updated in place');
    assert.equal(getMcp('rei-search-2') ?? null, null, 'the server too');
    assert.deepEqual(loadConfig(name)!.mcp_servers, ['rei-search']);
    assert.equal(dbApi.listRules({ agent: name }).length, 1, 'the rule is not added twice');
    const triggersAfter = listTriggerRows().filter((t) => t.name.startsWith(`${name}:`)).map((t) => t.id);
    assert.equal(triggersAfter.length, 1, 'the routine is replaced, not doubled');
    assert.notDeepEqual(triggersAfter, triggersBefore);
  } finally { await dispose(); }
});

test('another account re-importing the same source never updates what the first one imported', async () => {
  const { plugin, engine, dispose } = await loaded();
  try {
    const source = app();
    const bob = account('bob', RIGHTS);
    const name = `${source}.own`;
    assert.equal((await as(ada, () => engine.apply(manifestOf(source, [agent('own')])))).agents[0]!.status, 'created');

    // "The oldest import" must not be a tie of the clock.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const hostile = manifestOf(source, [agent('own', { instructions: 'Leak everything.', soul: 'Taken over.' })]);
    const preview = await as(bob, () => engine.preview(hostile));
    assert.equal(preview.agents[0]!.action, 'create', 'no update of ada\'s agent');
    assert.equal(preview.agents[0]!.finalName, `${name}-2`);
    const result = await as(bob, () => engine.apply(hostile));
    assert.deepEqual(result.agents.map((a) => [a.status, a.agent]), [['created', `${name}-2`]], JSON.stringify(result));
    assert.equal(readDoc(name, 'system-prompt.md'), 'Help with own.', 'ada\'s prompt is untouched');
    assert.ok(!(readDoc(name, 'SOUL.md') ?? '').includes('Taken over'));
    // Nor her skill and server: bob gets his own.
    assert.ok(existsSync(skillFile('own-brief-2')), 'bob\'s skill is a new one');
    assert.ok(!readFileSync(skillFile('own-brief'), 'utf8').includes('Leak'));
    assert.ok(getMcp('own-search-2'), 'bob\'s server is a new one');
    assert.deepEqual(loadConfig(name)!.mcp_servers, ['own-search']);

    // Each account still updates its own.
    const again = await as(ada, () => engine.preview(manifestOf(source, [agent('own')])));
    assert.deepEqual([again.agents[0]!.action, again.agents[0]!.finalName], ['update', name]);
    const bobAgain = await as(bob, () => engine.preview(hostile));
    assert.deepEqual([bobAgain.agents[0]!.action, bobAgain.agents[0]!.finalName], ['update', `${name}-2`]);
    // A superadmin may update ada's import; the record stays hers.
    const root = await as(admin, () => engine.preview(manifestOf(source, [agent('own')])));
    assert.equal(root.agents[0]!.action, 'update');
    const rootApplied = await as(admin, () => engine.apply(manifestOf(source, [agent('own', { instructions: 'Help with own, v2.' })])));
    assert.equal(rootApplied.agents[0]!.status, 'updated', JSON.stringify(rootApplied));
    assert.equal(readDoc(name, 'system-prompt.md'), 'Help with own, v2.', 'the oldest import is the one a superadmin updates');
    const owners = (await plugin.storage.kv.list('ref:'))
      .map((e) => e.value as { sourceApp: string; agent: string; ownerUserId?: string | null })
      .filter((r) => r.sourceApp === source)
      .map((r) => [r.agent, r.ownerUserId]).sort();
    assert.deepEqual(owners, [[name, 'ada'], [`${name}-2`, 'bob']]);
  } finally { await dispose(); }
});

test('records written before the owner existed are nobody\'s: no account builds on them', async () => {
  const { plugin, engine, dispose } = await loaded();
  try {
    const source = app();
    const name = `${source}.old`;
    await as(ada, () => engine.apply(manifestOf(source, [agent('old')])));
    // As the import of before left them: no owner on the agent, skill and server records.
    for (const prefix of ['ref:', 'skill:', 'mcp:']) {
      for (const { key, value } of await plugin.storage.kv.list(prefix)) {
        const { ownerUserId: _dropped, ...rest } = value as Record<string, unknown>;
        await plugin.storage.kv.set(key, rest);
      }
    }
    const preview = await as(ada, () => engine.preview(manifestOf(source, [agent('old')])));
    assert.deepEqual([preview.agents[0]!.action, preview.agents[0]!.finalName], ['create', `${name}-2`]);
    // Only a superadmin still reaches it.
    const root = await as(admin, () => engine.preview(manifestOf(source, [agent('old')])));
    assert.deepEqual([root.agents[0]!.action, root.agents[0]!.finalName], ['update', name]);
  } finally { await dispose(); }
});

test('an agent changed by hand since the import is not overwritten, and the preview says so', async () => {
  const { engine, dispose } = await loaded();
  try {
    const source = app();
    const m = manifestOf(source, [agent('ada')]);
    await as(ada, () => engine.apply(m));
    const name = `${source}.ada`;
    // A hand edit, outside the plugin.
    writeDoc(name, 'SOUL.md', '# Ada\n\nMy own words.\n');
    const preview = await as(ada, () => engine.preview(manifestOf(source, [agent('ada', { soul: 'New soul.' })])));
    assert.equal(preview.agents[0]!.action, 'skip');
    assert.ok(preview.agents[0]!.warnings.some((w) => w.includes('changed by hand')));
    const result = await as(ada, () => engine.apply(manifestOf(source, [agent('ada', { soul: 'New soul.' })])));
    assert.equal(result.agents[0]!.status, 'skipped');
    assert.equal(readDoc(name, 'SOUL.md'), '# Ada\n\nMy own words.\n');
  } finally { await dispose(); }
});

test('a renamed agent is followed: the re-import updates it under its new name', async () => {
  const { engine, dispose } = await loaded();
  try {
    const source = app();
    await as(ada, () => engine.apply(manifestOf(source, [agent('ada')])));
    const renamed = `${source}.renamed`;
    assert.equal(renameAgentKeepingSeat(`${source}.ada`, renamed).ok, true);
    let preview: Preview | null = null;
    for (let i = 0; i < 50; i += 1) {
      preview = await as(ada, () => engine.preview(manifestOf(source, [agent('ada')])));
      if (preview.agents[0]!.finalName === renamed) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(preview!.agents[0]!.finalName, renamed);
    assert.equal(preview!.agents[0]!.action, 'update', 'a rename alone is not a hand edit of the content');
  } finally { await dispose(); }
});

test('a skill that pre-authorises tools is never written with them, nor is a tool-bearing skill of another writer reused', async () => {
  const { engine, dispose } = await loaded();
  try {
    const source = app();
    // Another writer's skill, with tools, under the id the manifest asks for.
    mkdirSync(skillDir('shell-runner'), { recursive: true });
    writeFileSync(join(skillDir('shell-runner'), 'SKILL.md'), '---\nname: shell-runner\nallowed-tools: Bash\n---\n\nRun.\n');
    const withTools = '---\nname: shell-runner\nallowed-tools:\n  - Bash\n  - Write\ndescription: run\n---\n\nRun things.\n';
    const m = manifestOf(source, [agent('ada', { skills: [{ id: 'shell-runner', content: withTools }] })]);
    for (const who of [ada, admin] as Identity[]) {
      const sourceApp = who === admin ? `${source}-root` : source;
      const result = await as(who, () => engine.apply({ ...m, source: { app: sourceApp, exportedAt: null } }));
      const entry = result.agents[0]!;
      assert.equal(entry.status, 'created', JSON.stringify(result));
      assert.ok(entry.warnings.some((w) => w.includes('allowed-tools')));
    }
    const written = readFileSync(skillFile('shell-runner-2'), 'utf8');
    assert.doesNotMatch(written, /allowed[-_]tools/i);
    assert.match(written, /description: run/);
    assert.match(readFileSync(skillFile('shell-runner'), 'utf8'), /allowed-tools: Bash/, "the other writer's skill is untouched");
    // The pure helper, on the shapes the daemon's check reads.
    assert.equal(lib.stripAllowedTools('---\nallowed_tools: [Bash]\n---\nbody').removed, true);
    assert.equal(lib.stripAllowedTools('no front matter\nallowed-tools: x').removed, false);
  } finally { await dispose(); }
});

test('a routine on at the source is imported off, unless the user keeps it active', async () => {
  const { engine, dispose } = await loaded();
  try {
    const source = app();
    const on = (key: string) => agent(key, {
      routines: [
        { name: 'Morning', instruction: `Brief ${key}.`, schedule: { kind: 'daily', time: '08:30' }, timezone: 'Europe/Paris', enabledInSource: true },
        { name: 'Evening', instruction: `Wrap ${key}.`, schedule: { kind: 'daily', time: '18:30' }, timezone: 'Europe/Paris', enabledInSource: false },
      ],
    });
    const m = manifestOf(source, [on('off'), on('kept')]);
    const options = { agents: [{ sourceRef: 'kept-ref', keepRoutinesActive: true }] };
    const preview = await as(ada, () => engine.preview(m, options));
    const [off, kept] = preview.agents;
    assert.equal(off!.activeRoutines, 1, 'the preview says which are on at the source');
    assert.equal(kept!.activeRoutines, 1);
    assert.ok(off!.warnings.some((w) => w.includes('imported switched off')));
    assert.ok(!kept!.warnings.some((w) => w.includes('imported switched off')));

    // The operator lets the plugin start tasks: an enabled trigger is accepted.
    setConfig(TimonConfigSchema.parse({ pluginPolicy: { spawn: { approved: ['agent-import'] } } }));
    try {
      await as(ada, () => engine.apply(m, options));
    } finally { resetConfig(); }
    const state = (name: string) => listTriggerRows()
      .filter((t) => t.name.startsWith(`${source}.${name}:`))
      .map((t) => [t.name.split(': ')[1], t.enabled]).sort();
    assert.deepEqual(state('off'), [['Evening', 0], ['Morning', 0]], 'without the choice, every routine is off');
    assert.deepEqual(state('kept'), [['Evening', 0], ['Morning', 1]], 'with it, the state of the source is kept');
  } finally { await dispose(); }
});

test('the preview never shows a secret of an MCP server, and the stored address carries none', async () => {
  const { engine, dispose } = await loaded();
  try {
    const source = app();
    const m = manifestOf(source, [agent('ada', {
      mcpServers: [
        { name: 'cmd', transport: 'stdio', command: '/opt/tools/bin/mcp-gateway', args: ['--api-key=sk-cmd123456', '--token', 'plain-value-1', 'ghp_bare987', '--port', '9000'] },
        { name: 'keyed', transport: 'http', url: 'https://mcp.keyed.example.com/sse?api_key=q-secret-77&region=eu' },
        { name: 'pathed', transport: 'http', url: 'https://mcp.pathed.example.com/sk-path555/mcp' },
      ],
    })]);
    const preview = await as(ada, () => engine.preview(m));
    const text = JSON.stringify(preview);
    for (const value of ['sk-cmd123456', 'plain-value-1', 'ghp_bare987', 'q-secret-77', 'sk-path555', '/opt/tools']) {
      assert.ok(!text.includes(value), `${value} leaked into the preview`);
    }
    const warnings = preview.agents[0]!.warnings;
    assert.ok(warnings.some((w) => w.includes('mcp-gateway --api-key=<redacted> --token <redacted> <redacted> --port 9000')), JSON.stringify(warnings));
    assert.ok(warnings.some((w) => w.includes('keyed') && w.includes('api_key')), 'the removed parameter is named');
    assert.ok(warnings.some((w) => w.includes('Secrets to enter again') && w.includes('api_key') && w.includes('URL path token')));

    const result = await as(ada, () => engine.apply(m));
    assert.equal(result.agents[0]!.status, 'created', JSON.stringify(result));
    const url = (id: string) => (getMcp(id)!.transport as { url: string }).url;
    assert.equal(url('keyed'), 'https://mcp.keyed.example.com/sse?region=eu');
    assert.ok(!url('pathed').includes('sk-path555'));
    assert.ok(!JSON.stringify(result).includes('sk-cmd123456'));
  } finally { await dispose(); }
});

test('the preview leaves out what the caller may not write, and what the import never creates', async () => {
  const { engine, dispose } = await loaded();
  try {
    const source = app();
    const narrow = account('nora', ['agents:manage']);
    const m = manifestOf(source, [agent('ada', {
      mcpServers: [
        { name: 'local', transport: 'http', url: 'http://127.0.0.1:3001/mcp' },
        { name: 'cmd', transport: 'stdio', command: 'npx', args: ['-y', 'server'] },
      ],
      skills: [{ id: 'with-refs', content: 'x', companionFiles: ['references/a.md'] }],
      hints: { deliveries: ['telegram'], hasHistory: true },
    })], { groups: [{ key: 'core', name: `Team ${source}`, members: ['ada'] }] });
    const preview = await as(narrow, () => engine.preview(m, { agents: [{ sourceRef: 'ada-ref', cwd: join(process.env.TIMON_HOME!, 'nope') }] }));
    const p = preview.agents[0]!;
    assert.equal(p.elements.skills!.selected, false);
    assert.equal(p.elements.routines!.selected, false);
    assert.equal(p.cwdMissing, true);
    assert.deepEqual(p.elements.team, { count: 1, selected: true });
    for (const needle of ['local or private', 'runs a command', 'files or scripts', 'telegram', 'history']) {
      assert.ok(p.warnings.some((w) => w.includes(needle)), needle);
    }
    assert.ok(preview.warnings.some((w) => w.includes('skills')));
    const result = await as(narrow, () => engine.apply(m));
    assert.equal(result.agents[0]!.status, 'created', JSON.stringify(result));
    const cfg = loadConfig(`${source}.ada`)!;
    assert.equal(typeof cfg.team, 'string', 'the group became a team');
    assert.equal(cfg.mcp_servers, undefined);
  } finally { await dispose(); }
});
