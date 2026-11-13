/**
 * Ratchet: browser storage is per machine unless a file says otherwise.
 *
 * The interface switches daemons on one origin (TODO #329), so a key written
 * through raw `localStorage`/`sessionStorage` is seen by every machine. A key
 * naming an object of one daemon must go through `machine-storage.ts`. Only
 * state that describes the DEVICE (microphone, push-to-talk, dictation, the
 * theme cache read before first paint, a local debug switch) stays global —
 * those files are listed here, each with its reason. A new raw access fails
 * this test: route it through `machineScopedStorage()` / `machineLocalStorage()`,
 * or add the file below if the state truly belongs to the device.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../..', import.meta.url));

const DEVICE_STATE: Record<string, string> = {
  'lib/machines/machine-storage.ts': 'the scoping itself',
  'lib/push-to-talk.ts': 'a key binding of this keyboard',
  'lib/stt-mic-exclusif.ts': 'the microphone of this device',
  'components/voice-dictation-settings.tsx': 'dictation of this device',
  'plugins-client/local-dictation/voice-settings.ts': 'language and models of the desktop\'s local dictation: the models are on this computer',
  'components/theme-provider.tsx': 'drops the pre-paint theme cache of this browser',
  'lib/agent-editor-diagnostic.ts': 'a local debug switch',
  'lib/dev-logo.ts': 'the development copy\'s product-logo switch, kept per browser for screenshots',
  'lib/first-run-gate.ts': 'the light/dark picked on the onboarding\'s switch, before any account exists to hold it',
  'lib/scheme-mode.ts': 'colour mode of this browser (Customize system/auto), kept per device like the theme cache',
  'app/layout.tsx': 'the pre-paint script reads that onboarding pick before any module can run',
};

/** Raw storage access left once the machine-scoped wrappings are taken out. */
const RAW = /(?<![\w$])(?:window\.)?(?:localStorage|sessionStorage)\b/;
/** The one way a raw storage may appear outside the device files: handed
 *  straight to `machineScopedStorage`, which scopes it. Nothing else — a raw
 *  storage passed to any other call escapes the scoping just the same. */
const SCOPED = /\bmachineScopedStorage\(\s*(?:window\.)?(?:localStorage|sessionStorage)\s*[,)]/g;

/** True when a source line touches browser storage without the scoping. */
export function rawStorageAccess(line: string): boolean {
  const code = line.trim();
  if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return false;
  return RAW.test(line.replace(SCOPED, ''));
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules' && name !== 'vendor') sources(path, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

test('no raw browser storage outside per-device files', () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const rel = relative(SRC, file).split(sep).join('/');
    if (rel in DEVICE_STATE) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (rawStorageAccess(line)) offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], 'per-machine state must go through lib/machines/machine-storage.ts');
});

test('every per-device exemption still exists', () => {
  for (const rel of Object.keys(DEVICE_STATE)) {
    assert.ok(statSync(join(SRC, ...rel.split('/'))).isFile(), rel);
  }
});

test('the ratchet catches a raw storage handed to anything but machineScopedStorage', () => {
  for (const line of [
    'const v = window.localStorage.getItem(k);',
    'sessionStorage.setItem(k, v);',
    'persist(window.localStorage);',
    'persist(localStorage)',
    'useStore(sessionStorage, key);',
    'const s = typeof window === "undefined" ? null : window.localStorage;',
    'notMachineScopedStorage(localStorage)',
    'machineScopedStorage(localStorage); persist(window.sessionStorage);',
  ]) assert.equal(rawStorageAccess(line), true, line);
  for (const line of [
    'const s = machineScopedStorage(window.localStorage);',
    'machineScopedStorage(sessionStorage, id).clear();',
    'machineScopedStorage( localStorage )',
    '// window.localStorage is per device here',
    ' * sessionStorage of the active machine',
    'const machineLocalStorage = () => null;',
  ]) assert.equal(rawStorageAccess(line), false, line);
});
