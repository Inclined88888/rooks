/**
 * `examples/plugin-agent-import-source`: a third-party source adapter for the
 * agent import, written with the SDK alone. It must be admitted into the
 * import's socket like any plugin naming it, and what it hands the assistant
 * must be an archive the real engine reads (`readManifestFromZip` of
 * `plugins/agent-import`), secrets left behind.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { register, resetSlotsForTests, slotEntries, slotKind } from './plugin-host/slots';
import { clientContext } from './plugin-host/loader';
import { UI_LAYOUT_CHILD_SLOTS } from './plugin-host/ui-layout';

type Manifest = { timon: { id: string; client: { slots: string[] }; declares?: Record<string, 'single' | 'list' | 'keyed'> } };
type Assistant = { busy: boolean; submitFile(sourceId: string, file: Blob): Promise<void> };
type Example = {
  SOURCE_ID: string;
  apply(ctx: unknown): () => void;
  toManifest(text: string): { manifest: unknown; warnings: string[] };
  zipOne(name: string, bytes: Uint8Array): Uint8Array;
  importFile(assistant: Assistant, file: Blob): Promise<string | null>;
};
type Engine = {
  readManifestFromZip(path: string): Promise<{ source: { app: string }; agents: Array<Record<string, unknown>>; warnings?: string[] }>;
  parseManifest(value: unknown): unknown;
};

const repo = resolve(process.cwd(), '..');
const example = join(repo, 'examples', 'plugin-agent-import-source');
const own = JSON.parse(readFileSync(join(example, 'package.json'), 'utf8')) as Manifest;
const importer = JSON.parse(readFileSync(join(repo, 'plugins', 'agent-import', 'package.json'), 'utf8')) as Manifest;

const ACME = JSON.stringify({
  format: 'acme-bots',
  version: 1,
  timezone: 'Europe/Paris',
  bots: [
    {
      id: 'Ada Lovelace', name: 'Ada', role: 'Research assistant', persona: 'Curious and precise.',
      prompt: 'Read the papers\r\nand summarise them.', notes: ['Prefers short answers'],
      jobs: [
        { title: 'Morning digest', task: 'Summarise the new papers.', dailyAt: '08:00', enabled: false },
        { title: 'Every so often', task: 'Ping.', cron: '* * * * *' },
      ],
      apiKeyName: 'ACME_API_KEY', apiKey: 'sk-acme-never-leaves', history: [{ role: 'user', text: 'hi' }],
    },
    { id: 'ada-lovelace', name: 'Ada again' },
  ],
});

/** Loaded as the platform loads a browser half: `react` and `@timon/ui` are the platform's own. */
async function loadExample(): Promise<{ mod: Example; cleanup: () => void }> {
  const source = readFileSync(join(example, 'lib', 'client.js'), 'utf8');
  const platform = source
    .replace(/import React from 'react'\n/, 'const React = globalThis.__agentImportSourceTestReact\n')
    .replace(/import \{([^}]*)\} from '@timon\/ui'\n/, 'const {$1} = globalThis.__agentImportSourceTestUi\n');
  assert.notEqual(platform, source, 'the client still imports react and @timon/ui');
  const { UI_KIT } = await import('./plugin-host/ui-kit');
  Object.assign(globalThis, { __agentImportSourceTestReact: React, __agentImportSourceTestUi: UI_KIT });
  const dir = mkdtempSync(join(tmpdir(), 'agent-import-source-example-'));
  const file = join(dir, 'client.mjs');
  writeFileSync(file, platform);
  const mod = await import(pathToFileURL(file).href) as Example;
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function loadEngine(): Promise<Engine> {
  const url = pathToFileURL(join(repo, 'plugins', 'agent-import', 'lib', 'index.js')).href;
  return await import(url) as Engine;
}

const Empty = () => React.createElement('div');

test('the template names the import socket and nothing else, with no permission', () => {
  const [socket] = Object.keys(importer.timon.declares ?? {});
  assert.deepEqual(own.timon.client.slots, [socket]);
  assert.equal(own.timon.declares, undefined);
  assert.deepEqual((own.timon as { permissions?: unknown }).permissions, []);
});

test('its apply() is admitted into the socket while the import is on, and goes with it', async () => {
  const { mod, cleanup } = await loadExample();
  try {
    resetSlotsForTests();
    register({ slot: 'root', pluginId: '@timon/ui-layout', children: UI_LAYOUT_CHILD_SLOTS }, Empty);
    const host = clientContext(importer.timon.id, importer.timon.client.slots);
    const section = host.slots.register({ slot: 'settings.section', children: importer.timon.declares ?? {} }, Empty);
    const dispose = mod.apply(clientContext(own.timon.id, own.timon.client.slots));
    assert.deepEqual(slotEntries('agentimport.source').map((e) => e.pluginId), [own.timon.id]);
    dispose();
    assert.equal(slotEntries('agentimport.source').length, 0);
    section();
    assert.equal(slotKind('agentimport.source'), null);
  } finally {
    resetSlotsForTests();
    cleanup();
  }
});

test('acme-bots.json becomes a v1 manifest the engine accepts, read back from the zip it builds', async () => {
  const { mod, cleanup } = await loadExample();
  const engine = await loadEngine();
  const dir = mkdtempSync(join(tmpdir(), 'agent-import-source-zip-'));
  try {
    const { manifest } = mod.toManifest(ACME);
    engine.parseManifest(manifest);
    const path = join(dir, 'acme.zip');
    writeFileSync(path, mod.zipOne('timon-agent-import.json', new TextEncoder().encode(JSON.stringify(manifest))));
    const read = await engine.readManifestFromZip(path);
    assert.equal(read.source.app, 'acme-bots');
    assert.deepEqual(read.agents.map((a) => [a.key, a.sourceRef]), [['ada-lovelace', 'acme-bots:ada-lovelace'], ['ada-lovelace-2', 'acme-bots:ada-lovelace-2']]);
    const ada = read.agents[0]!;
    assert.equal(ada.instructions, 'Read the papers\nand summarise them.');
    assert.deepEqual(ada.routines, [{ name: 'Morning digest', instruction: 'Summarise the new papers.', schedule: { kind: 'daily', time: '08:00' }, timezone: 'Europe/Paris', enabledInSource: false }]);
    assert.deepEqual(ada.hints, { secretNames: ['ACME_API_KEY'], hasHistory: true });
    assert.match((read.warnings ?? []).join('\n'), /Every so often.*left out/);
    assert.doesNotMatch(JSON.stringify(read), /sk-acme-never-leaves/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});

test('a file that is not an acme-bots export is refused by the field, before anything is sent', async () => {
  const { mod, cleanup } = await loadExample();
  try {
    const sent: Blob[] = [];
    const assistant: Assistant = { busy: false, submitFile: async (_id, file) => { sent.push(file); } };
    assert.equal(await mod.importFile(assistant, new Blob(['{"format":"other"}'])), 'format is not acme-bots');
    assert.equal(await mod.importFile(assistant, new Blob(['not json'])), 'not a JSON file');
    assert.match(await mod.importFile(assistant, new Blob([JSON.stringify({ format: 'acme-bots', version: 1, bots: [{ apiKey: 'sk-x' }] })])) ?? '', /^bots\[0\]\.name is missing$/);
    assert.equal(sent.length, 0);

    assert.equal(await mod.importFile(assistant, new Blob([ACME])), null);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.type, 'application/zip');
    assert.equal(new TextDecoder().decode(new Uint8Array(await sent[0]!.arrayBuffer()).subarray(0, 2)), 'PK');
  } finally {
    cleanup();
  }
});
