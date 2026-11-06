import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  activeMachineId,
  forgetMachineStorage,
  MACHINE_ATTRIBUTE,
  machineKey,
  machineLocalStorage,
  machineScopedStorage,
  machineSessionStorage,
} from './machine-storage';
import { LOCAL_MACHINE_ID } from './machine-id';

/** An in-memory `Storage`, insertion-ordered like the browser's. */
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
  removeItem(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
  raw(): Record<string, string> { return Object.fromEntries(this.map); }
}

type Globals = { document?: unknown; window?: unknown };
const g = globalThis as Globals;

/** A page rendered for `machine` (no attribute at all for `undefined`). */
function inPage(machine: string | undefined, local = new MemoryStorage(), session = new MemoryStorage()) {
  g.document = { documentElement: { getAttribute: (name: string) => (name === MACHINE_ATTRIBUTE ? machine ?? null : null) } };
  g.window = { localStorage: local, sessionStorage: session };
  return { local, session };
}

test.afterEach(() => {
  delete g.document;
  delete g.window;
});

test('outside a browser, and without the attribute, the machine is local', () => {
  assert.equal(activeMachineId(), LOCAL_MACHINE_ID);
  assert.equal(machineLocalStorage(), null);
  assert.equal(machineSessionStorage(), null);
  inPage(undefined);
  assert.equal(activeMachineId(), LOCAL_MACHINE_ID);
});

test('a malformed machine id is not trusted: the page stays local', () => {
  for (const bad of ['', 'a:b', '../x', 'x'.repeat(65), 'm y']) {
    inPage(bad);
    assert.equal(activeMachineId(), LOCAL_MACHINE_ID, JSON.stringify(bad));
  }
});

test('local keys are unchanged, so nothing stored before is lost', () => {
  const { local } = inPage(LOCAL_MACHINE_ID);
  local.setItem('timon:workspace', 'w1');
  assert.equal(machineKey('timon:workspace'), 'timon:workspace');
  assert.equal(machineLocalStorage()?.getItem('timon:workspace'), 'w1');
});

test('a remote machine reads and writes its own prefixed keys, never local ones', () => {
  const { local, session } = inPage('vps', new MemoryStorage(), new MemoryStorage());
  local.setItem('timon:workspace', 'local-ws');
  assert.equal(machineKey('timon:workspace'), 'm:vps:timon:workspace');
  const store = machineLocalStorage();
  assert.ok(store);
  assert.equal(store.getItem('timon:workspace'), null, 'the local workspace does not follow onto the remote');
  store.setItem('timon:workspace', 'vps-ws');
  machineSessionStorage()?.setItem('draft', 'd');
  assert.deepEqual(local.raw(), { 'timon:workspace': 'local-ws', 'm:vps:timon:workspace': 'vps-ws' });
  assert.deepEqual(session.raw(), { 'm:vps:draft': 'd' });
  store.removeItem('timon:workspace');
  assert.deepEqual(local.raw(), { 'timon:workspace': 'local-ws' });
});

test('enumeration and clear stay inside one machine', () => {
  const base = new MemoryStorage();
  base.setItem('timon-theme', 'dark');
  base.setItem('m:a:x', '1');
  base.setItem('m:a:y', '2');
  base.setItem('m:ab:x', 'other machine, same prefix start');
  const a = machineScopedStorage(base, 'a');
  assert.equal(a.length, 2);
  assert.deepEqual([a.key(0), a.key(1), a.key(2)], ['x', 'y', null]);
  const local = machineScopedStorage(base, LOCAL_MACHINE_ID);
  assert.deepEqual([local.length, local.key(0)], [1, 'timon-theme']);
  a.clear();
  assert.deepEqual(base.raw(), { 'timon-theme': 'dark', 'm:ab:x': 'other machine, same prefix start' });
});

test('forgetting a machine erases its keys in both storages, and never local ones', () => {
  const { local, session } = inPage(LOCAL_MACHINE_ID);
  local.setItem('timon-theme', 'dark');
  local.setItem('m:vps:timon:workspace', 'w');
  session.setItem('m:vps:resume', 'r');
  session.setItem('m:nas:resume', 'kept');
  forgetMachineStorage('vps');
  assert.deepEqual(local.raw(), { 'timon-theme': 'dark' });
  assert.deepEqual(session.raw(), { 'm:nas:resume': 'kept' });
  forgetMachineStorage(LOCAL_MACHINE_ID);
  forgetMachineStorage('../');
  assert.deepEqual(local.raw(), { 'timon-theme': 'dark' });
});

test('the root layout writes the attribute this module reads', () => {
  const layout = readFileSync(fileURLToPath(new URL('../../app/layout.tsx', import.meta.url)), 'utf8');
  assert.match(layout, new RegExp(`${MACHINE_ATTRIBUTE}=\\{target\\.id\\}`));
});

test('a migrated store follows the active machine: a draft stays on the machine it was written for', async () => {
  const { draftKey, loadDraft, saveDraft } = await import('../composer-draft');
  const key = draftKey('main');
  const { local } = inPage('vps');
  saveDraft(key, 'remote draft');
  assert.deepEqual(local.raw(), { [`m:vps:${key}`]: 'remote draft' });
  inPage(LOCAL_MACHINE_ID, local);
  assert.equal(loadDraft(key), '', 'the local conversation does not see the remote draft');
  saveDraft(key, 'local draft');
  inPage('vps', local);
  assert.equal(loadDraft(key), 'remote draft');
});
