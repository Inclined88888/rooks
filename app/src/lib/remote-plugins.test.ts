/**
 * P4d — on a remote machine, a third-party plugin's browser half runs here only
 * from THIS computer's copy of the same version and signature (or, for a
 * built-in, of the same version and browser-half code).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { awaitingLocalApproval, localTwin, mountableOnRemote } from './plugin-host/remote-plugins';
import {
  resetClientPluginsForTests,
  setLoadClientModuleForTests,
  syncClientPlugins,
  type PublicPlugin,
} from './plugin-host/loader';

function third(id: string, over: Partial<PublicPlugin> = {}): PublicPlugin {
  return {
    id,
    state: 'active',
    kind: ['widget'],
    version: '1.2.0',
    signature: { hash: `sha256-${id}`, keyId: 'k1' },
    client: { url: `/plugins/${id}/client.js`, rev: 'remote-rev', slots: ['cockpit.widget'] },
    ...over,
  };
}

const localCopy = (id: string, over: Partial<PublicPlugin> = {}): PublicPlugin => third(id, {
  client: { url: `/plugins/${id}/client.js`, rev: 'local-rev', slots: ['cockpit.widget'], permissions: [] },
  ...over,
});

test('same id, version and signature, running here: the local copy is the twin', () => {
  const twin = localTwin(third('hello'), [localCopy('hello')]);
  assert.equal(twin?.client?.rev, 'local-rev');
});

test('any difference keeps the browser half off', () => {
  const remote = third('hello');
  assert.equal(localTwin(remote, []), null, 'not installed here');
  assert.equal(localTwin(remote, [localCopy('hello', { version: '1.1.0' })]), null, 'another version');
  assert.equal(localTwin(remote, [localCopy('hello', { signature: { hash: 'sha256-other', keyId: 'k1' } })]), null, 'another signature');
  assert.equal(localTwin(remote, [localCopy('hello', { state: 'disabled' })]), null, 'disabled here');
  assert.equal(localTwin(remote, [localCopy('hello', { client: null })]), null, 'no browser half here');
  assert.equal(localTwin(remote, [localCopy('hello', { signature: null })]), null, 'unsigned here');
  // Unsigned there, or a daemon older than P4c that says nothing.
  assert.equal(localTwin(third('hello', { signature: null }), [localCopy('hello', { signature: null })]), null);
  assert.equal(localTwin(third('hello', { signature: undefined, version: undefined }), [localCopy('hello')]), null);
});

test('the mounted list carries the LOCAL client; the rest loses its browser half', () => {
  const bundledLike: PublicPlugin = { id: '@rooks/kanban', state: 'active', client: null };
  const mounted = mountableOnRemote([third('hello'), third('stranger'), bundledLike], [localCopy('hello')]);
  assert.deepEqual(mounted.map((p) => [p.id, p.client?.rev ?? null]), [['hello', 'local-rev'], ['stranger', null], ['@rooks/kanban', null]]);
  assert.deepEqual([...awaitingLocalApproval([third('hello'), third('stranger'), third('off', { state: 'disabled' }), bundledLike], [localCopy('hello')])], ['stranger']);
});

/** The loader, as a page of remote machine `vps` runs it. */
async function syncOnRemote(remote: PublicPlugin[], local: PublicPlugin[] | null): Promise<{ loaded: string[]; fetched: string[] }> {
  const previousFetch = globalThis.fetch;
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    value: { documentElement: { getAttribute: (name: string) => (name === 'data-rooks-machine' ? 'vps' : null) } },
    configurable: true,
  });
  const fetched: string[] = [];
  const loaded: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    if (url === '/api/ui/plugins') return Response.json({ plugins: remote });
    if (url === '/api/ui/plugins/local') return local ? Response.json({ plugins: local }) : Response.json({ error: 'down' }, { status: 502 });
    return Response.json({});
  }) as typeof fetch;
  setLoadClientModuleForTests(async (url) => {
    loaded.push(url);
    return { apply: () => undefined };
  });
  try {
    await syncClientPlugins();
    return { loaded, fetched };
  } finally {
    globalThis.fetch = previousFetch;
    setLoadClientModuleForTests(null);
    resetClientPluginsForTests();
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete (globalThis as Record<string, unknown>).document;
  }
}

test('on a remote machine, only a matched plugin loads, from the local bundle revision', async () => {
  const { loaded, fetched } = await syncOnRemote([third('hello'), third('stranger')], [localCopy('hello')]);
  assert.ok(fetched.includes('/api/ui/plugins/local'));
  assert.deepEqual(loaded, ['/api/ui/plugin-bundles/hello?rev=local-rev']);
});

test('on a remote machine, no local list means no remote browser half at all', async () => {
  const { loaded } = await syncOnRemote([third('hello')], null);
  assert.deepEqual(loaded, []);
});

/**
 * TIM-0135 — a built-in (`builtin-plugins.json`) ships unsigned: trusted by its
 * location in each release, matched on its browser-half code. `digest` is the
 * daemon's line-ending-blind hash: the Windows build (CRLF checkout) and the
 * Linux one of a release share it while their `rev` differ.
 */
const RELEASE_A = 'digest-quota-0.1.0-release-a';
const RELEASE_B = 'digest-quota-0.1.0-release-b';
const builtinThere = (id: string, over: Partial<PublicPlugin> = {}): PublicPlugin => third(id, {
  builtin: true,
  signature: null,
  version: '0.1.0',
  client: { url: `/plugins/${id}/client.js`, rev: 'remote-rev-crlf', digest: RELEASE_A, slots: ['cockpit.widget'] },
  ...over,
});
const builtinHere = (id: string, over: Partial<PublicPlugin> = {}): PublicPlugin => third(id, {
  builtin: true,
  signature: null,
  version: '0.1.0',
  client: { url: `/plugins/${id}/client.js`, rev: 'local-rev', digest: RELEASE_A, slots: ['cockpit.widget'], permissions: [] },
  ...over,
});
const withClient = (plugin: PublicPlugin, client: Partial<NonNullable<PublicPlugin['client']>>): PublicPlugin => ({
  ...plugin,
  client: { ...(plugin.client ?? { url: '', rev: '', slots: [] }), ...client },
});

test('a built-in with the same version and code on both machines, running here: the local copy is the twin', () => {
  // Same release built on Windows there, Linux here: other bytes, same code.
  const twin = localTwin(builtinThere('quota-monitor'), [builtinHere('quota-monitor')]);
  assert.equal(twin?.client?.rev, 'local-rev');
  assert.deepEqual([...awaitingLocalApproval([builtinThere('quota-monitor')], [builtinHere('quota-monitor')])], []);
});

test('two Rooks releases shipping quota-monitor 0.1.0 with different code: the built-in waits', () => {
  const remote = withClient(builtinThere('quota-monitor'), { digest: RELEASE_B });
  assert.equal(localTwin(remote, [builtinHere('quota-monitor')]), null);
  assert.deepEqual([...awaitingLocalApproval([remote], [builtinHere('quota-monitor')])], ['quota-monitor']);
  // Same bytes do not override a different digest: a digest is the code identity.
  assert.equal(localTwin(withClient(remote, { rev: 'local-rev' }), [builtinHere('quota-monitor')]), null);
});

test('from a daemon without digest, a built-in matches on identical bytes only', () => {
  const old = (rev: string): PublicPlugin => withClient(builtinThere('quota-monitor'), { rev, digest: undefined });
  assert.equal(localTwin(old('local-rev'), [builtinHere('quota-monitor')])?.client?.rev, 'local-rev');
  assert.equal(localTwin(old('remote-rev-crlf'), [builtinHere('quota-monitor')]), null);
  assert.equal(localTwin(old(''), [withClient(builtinHere('quota-monitor'), { rev: '', digest: undefined })]), null, 'no revision at all');
});

test('a built-in still waits when its local copy differs or does not run', () => {
  const remote = builtinThere('quota-monitor');
  assert.equal(localTwin(remote, [builtinHere('quota-monitor', { version: '0.2.0' })]), null, 'another version');
  assert.equal(localTwin(remote, [builtinHere('quota-monitor', { state: 'disabled' })]), null, 'disabled here');
  assert.equal(localTwin(remote, [builtinHere('quota-monitor', { client: null })]), null, 'no browser half here');
  assert.equal(localTwin(remote, []), null, 'absent here');
  // An unsigned package installed here under the same id is not the built-in.
  assert.equal(localTwin(remote, [builtinHere('quota-monitor', { builtin: false })]), null, 'not a built-in here');
  // A remote that does not say it ships it (older daemon, installed package).
  assert.equal(localTwin(builtinThere('quota-monitor', { builtin: undefined }), [builtinHere('quota-monitor')]), null);
  assert.equal(localTwin(builtinThere('quota-monitor', { version: undefined }), [builtinHere('quota-monitor')]), null);
  assert.deepEqual([...awaitingLocalApproval([remote], [builtinHere('quota-monitor', { version: '0.2.0' })])], ['quota-monitor']);
});

test('on a remote machine, a running built-in loads from the local bundle revision', async () => {
  const { loaded } = await syncOnRemote(
    [builtinThere('quota-monitor'), builtinThere('hermes-gateway')],
    [builtinHere('quota-monitor'), builtinHere('hermes-gateway', { state: 'disabled' })],
  );
  assert.deepEqual(loaded, ['/api/ui/plugin-bundles/quota-monitor?rev=local-rev']);
});
