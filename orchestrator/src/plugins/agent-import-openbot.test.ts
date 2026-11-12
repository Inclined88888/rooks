/**
 * The OpenBot source adapter of the agent import (plugins/agent-import,
 * `src/sources/openbot.ts`, built `lib/index.js`): `openbot-import.json` v1 and
 * its `agents/<key>/…` files → `rooks-agent-import` v1. Every fixture here is
 * written by hand from the description of the format; none comes from OpenBot.
 * The last tests run a forged zip through the engine on the real facades.
 */
import { account, as } from '../../tests/helpers/facade-kit.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { Context } from '@deepseek-ai/cordis';
import { crc32, forgeZip, type ForgedEntry } from '../../../plugins/agent-import/test/zip-writer.js';

const { createPluginContext, daemonHost } = await import('./context.js');
type PluginContext = import('./context.js').PluginContext;
const { readManifest } = await import('./manifest.js');
const { getAgent, readDoc } = await import('../agent.js');
const { loadConfig } = await import('../agent-config.js');
const { skillFile } = await import('../paths.js');
const { existsSync } = await import('node:fs');
const { listTriggerRows } = await import('../triggers/store.js');
const { dbApi } = await import('../db.js');
const { ownAgentSkills } = await import('../skill-attachments.js');

const pkg = (await import('../../../plugins/agent-import/package.json', { with: { type: 'json' } })).default as { rooks: unknown };

type Json = Record<string, unknown>;
type Tree = { files: Map<string, Uint8Array>; skipped: Array<{ path: string; reason: string }> };
type Agent = Json & {
  key: string; displayName: string; sourceRef: string; title?: string; soul?: string | null;
  memories?: Array<{ text: string; kind: string }>;
  skills?: Array<{ id: string; content: string; companionFiles?: string[]; hasCode?: boolean }>;
  routines?: Array<{ name: string; instruction: string; schedule: Json; timezone?: string | null; enabledInSource: boolean }>;
  avatar?: { mime: string; dataBase64: string } | null;
};
type Manifest = { format: string; version: number; source: { app: string; exportedAt?: string | null }; agents: Agent[]; groups?: Array<{ key: string; name: string; members: string[] }>; warnings?: string[] };
type Adapter = { id: string; accepts: string[]; detect: string[]; wants: string[]; toManifest(tree: Tree): { manifest: Json; warnings: string[] } };
type Preview = { agents: Array<{ sourceRef: string; action: string; finalName: string; warnings: string[]; elements: Record<string, { count: number; selected: boolean }> }>; warnings: string[] };
type Applied = { agents: Array<{ sourceRef: string; agent: string | null; status: string; error?: string; warnings: string[] }>; warnings: string[] };
type Engine = { preview(m: unknown, o?: unknown): Promise<Preview>; apply(m: unknown, o?: unknown): Promise<Applied> };

const lib = await import('../../../plugins/agent-import/lib/index.js') as unknown as {
  openbotSource: Adapter;
  manifestFromSource(adapter: Adapter, tree: Tree): Manifest;
  readManifestFromZip(path: string): Promise<Manifest>;
  createEngine(ctx: PluginContext): Engine;
};

const enc = new TextEncoder();
const bytes = (text: string): Uint8Array => enc.encode(text);

/** A real 1×1 PNG: the daemon's image reader checks more than the signature. */
function png(): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(bytes(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1);
  new DataView(ihdr.buffer).setUint32(4, 1);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const idat = deflateSync(Buffer.from([0, 0x33, 0x66, 0x99, 0xff]));
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP = new Uint8Array([...bytes('RIFF'), 4, 0, 0, 0, ...bytes('WEBPVP8 ')]);

const SKILL = (name: string): string => `---\r\nname: ${name}\r\ndescription: Writes the weekly digest.\r\n---\r\n\r\nGather the week, then write it up.\r\n`;

/** The manifest of an export, written by hand. */
function exportOf(over: Json = {}, agents: Json[] = [fullAgent()]): Json {
  return {
    format: 'openbot-agent-import',
    version: 1,
    source: { app: 'grok-bot', exportedAt: '2026-11-02T18:30:00+01:00' },
    agents,
    ...over,
  };
}

function fullAgent(over: Json = {}): Json {
  return {
    key: 'Ada_Writer',
    name: 'Ada',
    title: 'Weekly writer',
    description: 'You write the weekly digest.\r\nKeep it short.\r\n',
    avatar: 'agents/Ada_Writer/avatar.png',
    files: 'agents/Ada_Writer/files/',
    skills: ['agents/Ada_Writer/skills/digest', 'agents/Ada_Writer/skills/deploy'],
    memories: ['Robin prefers bullet points.', '  ', 'The digest goes out on Fridays.\r\nNever on Mondays.'],
    routines: [
      { name: 'Friday digest', instruction: 'Write the digest.', active: false, timezone: 'Europe/Paris', schedule: { kind: 'weekly', weekday: 5, time: '16:00' } },
    ],
    ...over,
  };
}

function treeOf(manifest: Json, files: Record<string, Uint8Array | string> = {}, skipped: Tree['skipped'] = []): Tree {
  const map = new Map<string, Uint8Array>([['openbot-import.json', bytes(JSON.stringify(manifest))]]);
  for (const [path, data] of Object.entries(files)) map.set(path, typeof data === 'string' ? bytes(data) : data);
  return { files: map, skipped };
}

const ADA_FILES = (): Record<string, Uint8Array | string> => ({
  'agents/Ada_Writer/avatar.png': png(),
  'agents/Ada_Writer/skills/digest/SKILL.md': SKILL('digest'),
  'agents/Ada_Writer/skills/deploy/SKILL.md': SKILL('deploy'),
  'agents/Ada_Writer/skills/deploy/scripts/run.sh': '#!/bin/sh\necho deploy\n',
});

const decode = (tree: Tree): Manifest => lib.manifestFromSource(lib.openbotSource, tree);
const refusedWith = (re: RegExp) => (err: unknown): boolean => {
  assert.ok(err instanceof Error && err.name === 'ManifestError', String(err));
  assert.match(err.message, re);
  return true;
};

test('the adapter declares what it reads, and never the workspace copy', () => {
  const a = lib.openbotSource;
  assert.equal(a.id, 'openbot');
  assert.deepEqual(a.accepts, ['zip']);
  assert.deepEqual(a.detect, ['openbot-import.json']);
  assert.ok(a.wants.includes('agents/*/skills/**'));
  assert.ok(!a.wants.some((w) => w.includes('files')), 'files/ is never read');
});

test('a complete export becomes a valid rooks-agent-import manifest', () => {
  const m = decode(treeOf(exportOf(), ADA_FILES()));
  assert.equal(m.format, 'rooks-agent-import');
  assert.equal(m.version, 1);
  assert.deepEqual(m.source, { app: 'grok-bot', exportedAt: '2026-11-02T17:30:00.000Z' });
  const ada = m.agents[0]!;
  assert.equal(ada.key, 'ada-writer');
  assert.equal(ada.sourceRef, 'openbot:Ada_Writer', 'the source key, untouched, is the re-import identity');
  assert.equal(ada.displayName, 'Ada');
  assert.equal(ada.title, 'Weekly writer');
  assert.equal(ada.soul, 'You write the weekly digest.\nKeep it short.', 'CRLF normalised');
  assert.deepEqual(ada.memories, [
    { text: 'Robin prefers bullet points.', kind: 'decision' },
    { text: 'The digest goes out on Fridays.\nNever on Mondays.', kind: 'decision' },
  ]);
  const digest = ada.skills!.find((s) => s.id === 'digest')!;
  assert.ok(!digest.content.includes('\r'));
  assert.equal(digest.hasCode, undefined);
  assert.equal(digest.companionFiles, undefined);
  const deploy = ada.skills!.find((s) => s.id === 'deploy')!;
  assert.equal(deploy.hasCode, true, 'a skill with scripts/ is flagged, so the engine leaves it out');
  assert.deepEqual(deploy.companionFiles, ['scripts/run.sh']);
  assert.deepEqual(ada.routines, [{
    name: 'Friday digest', instruction: 'Write the digest.', schedule: { kind: 'weekly', days: [5], time: '16:00' },
    timezone: 'Europe/Paris', enabledInSource: false,
  }]);
  assert.equal(ada.avatar!.mime, 'image/png');
  assert.deepEqual(new Uint8Array(Buffer.from(ada.avatar!.dataBase64, 'base64')), png(), 'base64 of the very bytes');
  assert.ok(m.warnings!.some((w) => w.includes('working files') && w.includes('agents/Ada_Writer/files')));
});

test('a minimal export: a key, a name, a description', () => {
  const m = decode(treeOf({ format: 'openbot-agent-import', version: 1, agents: [{ key: 'solo', name: 'Solo', description: '' }] }));
  assert.deepEqual(m.source, { app: 'import', exportedAt: null });
  assert.deepEqual(m.agents, [{ key: 'solo', displayName: 'Solo', soul: null, sourceRef: 'openbot:solo' }]);
  assert.equal(m.groups, undefined);
  assert.deepEqual(m.warnings, []);
});

test('an unknown version, another format or a broken structure is refused, naming where', () => {
  assert.throws(() => decode(treeOf(exportOf({ version: 2 }))), refusedWith(/version 2 is not supported/));
  assert.throws(() => decode(treeOf(exportOf({ format: 'rooks-agent-import' }))), refusedWith(/format/));
  assert.throws(() => decode(treeOf(exportOf({ agents: [] }))), refusedWith(/agents/));
  assert.throws(() => decode(treeOf(exportOf({}, [fullAgent({ description: undefined })]))), refusedWith(/agents\[0\]\.description/));
  assert.throws(() => decode(treeOf(exportOf({}, [fullAgent(), fullAgent({ name: 'Twin' })]))), refusedWith(/agents\[1\]\.key/));
  for (const avatar of ['agents/Other/avatar.png', 'agents/Ada_Writer/../Other/a.png', '/etc/passwd', 'agents/Ada_Writer/.env']) {
    assert.throws(() => decode(treeOf(exportOf({}, [fullAgent({ avatar })]), ADA_FILES())), refusedWith(/agents\[0\]\.avatar/), avatar);
  }
  const notJson = { files: new Map([['openbot-import.json', bytes('{ nope')]]), skipped: [] };
  assert.throws(() => decode(notJson), refusedWith(/not valid JSON/));
});

test('a picture whose bytes are not what it claims is left out; JPEG and WebP pass', () => {
  const files = { ...ADA_FILES(), 'agents/Ada_Writer/avatar.png': bytes('<svg onload="alert(1)"/>') };
  const m = decode(treeOf(exportOf(), files));
  assert.equal(m.agents[0]!.avatar, undefined);
  assert.ok(m.warnings!.some((w) => w.includes('not a PNG, JPEG or WebP')));
  const missing = decode(treeOf(exportOf({}, [fullAgent({ avatar: 'agents/Ada_Writer/me.webp' })]), ADA_FILES()));
  assert.ok(missing.warnings!.some((w) => w.includes('picture is missing')));
  for (const [file, data, mime] of [['me.jpg', JPEG, 'image/jpeg'], ['me.webp', WEBP, 'image/webp']] as const) {
    const ok = decode(treeOf(exportOf({}, [fullAgent({ avatar: `agents/Ada_Writer/${file}` })]), { ...ADA_FILES(), [`agents/Ada_Writer/${file}`]: data }));
    assert.equal(ok.agents[0]!.avatar!.mime, mime);
  }
});

test('skills: text only; a skill without SKILL.md or with unreadable files is named, not imported', () => {
  const m = decode(treeOf(
    exportOf({}, [fullAgent({ skills: ['agents/Ada_Writer/skills/digest', 'agents/Ada_Writer/skills/empty', 'agents/Ada_Writer/skills/keyed'] })]),
    { 'agents/Ada_Writer/skills/digest/SKILL.md': SKILL('digest'), 'agents/Ada_Writer/skills/keyed/SKILL.md': SKILL('keyed') },
    [{ path: 'agents/Ada_Writer/skills/keyed/.env', reason: 'blocked' }],
  ));
  assert.deepEqual(m.agents[0]!.skills!.map((s) => s.id), ['digest']);
  assert.ok(m.warnings!.some((w) => w.includes('skill empty has no readable SKILL.md')));
  assert.ok(m.warnings!.some((w) => w.includes('skill keyed comes with files that cannot be read')));
  assert.ok(m.warnings!.some((w) => w.startsWith('Left out of the archive, secrets') && w.includes('keyed/.env')));
});

test('every routine shape maps to a schedule the engine reads; what cannot run is left out with a reason', () => {
  const r = (name: string, schedule: Json, more: Json = {}): Json => ({ name, instruction: `Do ${name}.`, schedule, ...more });
  const m = decode(treeOf(exportOf({}, [fullAgent({
    routines: [
      r('hourly', { kind: 'hourly', minute: 15 }),
      r('daily', { kind: 'daily', time: '08:30' }),
      r('weekdays', { kind: 'weekdays', time: '09:00' }),
      r('weekly', { kind: 'weekly', weekday: 0, time: '18:45' }),
      r('monthly', { kind: 'monthly', day: 31, time: '23:59' }),
      r('interval', { kind: 'interval', amount: 2, unit: 'hours', anchorAt: '2026-11-01T10:00:00Z' }),
      r('custom', { kind: 'custom', expression: '  0 6 * * 1-5 ' }),
      r('advanced-at', { kind: 'advanced', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], days: { kind: 'days-of-week', days: [3, 1] }, time: { kind: 'at-time', time: '07:05' } }),
      r('advanced-every', { kind: 'advanced', months: [6, 1], days: { kind: 'days-of-month', days: [15, 1] }, time: { kind: 'every', amount: 15, unit: 'minutes' } }),
      r('advanced-hours', { kind: 'advanced', months: [3], days: { kind: 'every-day' }, time: { kind: 'every', amount: 6, unit: 'hours' } }),
      r('once', { kind: 'once', date: '2026-12-24', time: '20:00' }),
      r('uneven', { kind: 'advanced', months: [1], days: { kind: 'every-day' }, time: { kind: 'every', amount: 7, unit: 'minutes' } }),
      r('bad time', { kind: 'daily', time: '25:00' }),
      r('mystery', { kind: 'lunar' }),
      { name: 'silent', schedule: { kind: 'daily', time: '08:00' } },
    ],
  })]), ADA_FILES()));
  const got = Object.fromEntries(m.agents[0]!.routines!.map((x) => [x.name, x.schedule]));
  assert.deepEqual(got, {
    'hourly': { kind: 'hourly', minute: 15 },
    'daily': { kind: 'daily', time: '08:30' },
    'weekdays': { kind: 'weekdays', time: '09:00' },
    'weekly': { kind: 'weekly', days: [0], time: '18:45' },
    'monthly': { kind: 'monthly', day: 31, time: '23:59' },
    'interval': { kind: 'interval', minutes: 120 },
    'custom': { kind: 'cron', expression: '0 6 * * 1-5' },
    'advanced-at': { kind: 'cron', expression: '5 7 * * 1,3' },
    'advanced-every': { kind: 'cron', expression: '*/15 * 1,15 1,6 *' },
    'advanced-hours': { kind: 'cron', expression: '0 */6 * 3 *' },
  });
  assert.ok(m.agents[0]!.routines!.every((x) => x.enabledInSource), 'active by default, as at the source');
  const w = m.warnings!.join('\n');
  assert.match(w, /routine "once" is not imported: it runs only once/);
  assert.match(w, /routine "uneven" is not imported: every 7 minutes/);
  assert.match(w, /routine "bad time" is not imported: its time is not valid/);
  assert.match(w, /routine "mystery" is not imported: its schedule kind is unknown/);
  assert.match(w, /routine "silent" has no instruction/);
  assert.match(w, /routine "interval": it now runs on the clock/);
});

test("OpenBot's own ceilings are accepted without being imposed", () => {
  const long = 'x'.repeat(6000);
  const m = decode(treeOf(exportOf({}, [fullAgent({
    description: long,
    memories: [...Array.from({ length: 100 }, (_, i) => `fact ${i} ${'y'.repeat(700)}`), 'z'.repeat(4001)],
  })]), ADA_FILES()));
  assert.equal(m.agents[0]!.soul, long, 'past 2,000 characters');
  assert.equal(m.agents[0]!.memories!.length, 100, 'past 64 memories of 500 characters');
  assert.ok(m.warnings!.some((w) => w.includes('1 memories longer than 4000')));
});

test('Grok Bot groups become teams: members carry over, lead and instructions are named', () => {
  const m = decode(treeOf(exportOf({
    channels: [
      { key: 'Launch Room', name: 'Launch room', lead: 'Ada_Writer', instructions: 'Ship on Thursdays.', members: ['Ada_Writer', 'bob', 'ghost', 'bob'], routines: [{ name: 'Standup' }], memories: ['We ship on Thursdays.'] },
      { key: 'empty', name: 'Nobody here', members: ['ghost'] },
    ],
  }, [fullAgent(), { key: 'bob', name: 'Bob', description: 'Reviewer.' }]), ADA_FILES()));
  assert.deepEqual(m.groups, [{ key: 'launch-room', name: 'Launch room', members: ['ada-writer', 'bob'] }]);
  const w = m.warnings!.join('\n');
  assert.match(w, /Group "Launch room": Ada led it at the source; a Rooks team has no lead/);
  assert.match(w, /Group "Launch room": its instructions are not carried over/);
  assert.match(w, /Group "Launch room": its routines are not imported \(Standup\)/);
  assert.match(w, /Group "Launch room": its 1 memories are not imported/);
  assert.match(w, /Group "Launch room": 1 members are not agents of this export/);
  assert.match(w, /Group "Nobody here" has no member in this export: no team is made/);
});

/* ── Through the engine, from a zip ─────────────────────────────────────── */

const dir = mkdtempSync(join(tmpdir(), 'agent-import-openbot-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let counter = 0;
function zipFile(entries: readonly ForgedEntry[]): string {
  const file = join(dir, `${++counter}.zip`);
  writeFileSync(file, forgeZip(entries));
  return file;
}

async function loaded(): Promise<{ plugin: PluginContext; engine: Engine; dispose: () => Promise<void> }> {
  const root = new Context();
  let inner!: Context;
  await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const manifest = readManifest(pkg);
  assert.ok(manifest.ok, manifest.ok ? '' : manifest.message);
  const plugin = createPluginContext(inner, { manifest: manifest.manifest, version: '0.1.0' }, daemonHost(root));
  return { plugin, engine: lib.createEngine(plugin), dispose: () => root.fiber.dispose() };
}

const ada = account('ada', ['agents:manage', 'skills:manage', 'mcp:manage', 'triggers:manage', 'kanban:write']);

test('an archive with neither manifest is refused, naming only the format of Rooks', async () => {
  const file = zipFile([{ name: 'README.md', data: 'hello' }]);
  await assert.rejects(lib.readManifestFromZip(file), refusedWith(/no rooks-agent-import\.json at its root/));
  await assert.rejects(lib.readManifestFromZip(file), (err: Error) => !/openbot/i.test(err.message));
});

test('an OpenBot zip is imported end to end: agent, identity, picture, skill, rules, routine, team', async () => {
  const app = `grok-bot-${process.pid}`;
  const keyA = `ada${process.pid}`;
  const manifest = exportOf({
    source: { app },
    channels: [{ key: 'room', name: `Room ${process.pid}`, lead: keyA, members: [keyA, 'bob'] }],
  }, [
    fullAgent({ key: keyA, avatar: `agents/${keyA}/avatar.png`, files: undefined, skills: [`agents/${keyA}/skills/digest${process.pid}`, `agents/${keyA}/skills/deploy`] }),
    { key: 'bob', name: 'Bob', description: 'Reviewer.' },
  ]);
  const file = zipFile([
    { name: 'openbot-import.json', data: JSON.stringify(manifest) },
    { name: `agents/${keyA}/avatar.png`, data: png() },
    { name: `agents/${keyA}/skills/digest${process.pid}/SKILL.md`, data: SKILL('digest') },
    { name: `agents/${keyA}/skills/deploy/SKILL.md`, data: SKILL('deploy') },
    { name: `agents/${keyA}/skills/deploy/scripts/run.sh`, data: 'echo\n' },
    { name: `agents/${keyA}/files/notes.md`, data: 'workspace-notes-content' },
    { name: `agents/${keyA}/.env`, data: 'TOKEN=secret-value' },
  ]);
  const m = await lib.readManifestFromZip(file);
  assert.ok(!JSON.stringify(m).includes('secret-value'), 'no secret value is read');
  assert.ok(!JSON.stringify(m).includes('workspace-notes-content'), 'working files are not read');

  const { engine, dispose } = await loaded();
  try {
    const preview = await as(ada, () => engine.preview(m));
    const p = preview.agents.find((a) => a.sourceRef === `openbot:${keyA}`)!;
    assert.equal(p.finalName, `${app}.${keyA}`);
    assert.deepEqual(p.elements.skills, { count: 1, selected: true });
    assert.deepEqual(p.elements.team, { count: 1, selected: true });
    assert.ok(p.warnings.some((w) => w.includes('Skill deploy comes with files or scripts')));

    const result = await as(ada, () => engine.apply(m));
    assert.deepEqual(result.agents.map((a) => a.status), ['created', 'created'], JSON.stringify(result));
    const name = `${app}.${keyA}`;
    assert.match(readDoc(name, 'SOUL.md') ?? '', /^# Ada\n\n\*Weekly writer\*\n\nYou write the weekly digest\.\nKeep it short\.\n$/);
    assert.ok(getAgent(name)?.icon_url, 'the picture is set');
    assert.ok(existsSync(skillFile(`digest${process.pid}`)));
    assert.deepEqual(ownAgentSkills(name), [`digest${process.pid}`], 'the skill with scripts is left out');
    assert.equal(dbApi.listRules({ agent: name }).length, 2);
    const trigger = listTriggerRows().find((t) => t.name === `${name}: Friday digest`);
    assert.ok(trigger);
    assert.equal(trigger.enabled, 0, 'inactive at the source, inactive here');
    assert.deepEqual(JSON.parse(trigger.config), { cron: '0 16 * * 5', tz: 'Europe/Paris' });
    const team = loadConfig(name)?.team;
    assert.equal(typeof team, 'string');
    assert.equal(loadConfig(`${app}.bob`)?.team, team, 'both members in the one team');
  } finally { await dispose(); }
});
