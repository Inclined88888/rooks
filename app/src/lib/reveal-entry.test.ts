import assert from 'node:assert/strict';
import { test } from 'node:test';
import { revealOnDesktop } from './reveal-entry';
import { setLocale, t } from './i18n';
import './i18n-test-locales';

type Call = { url: string; body: unknown };

function fakeFetch(status: number, reply: unknown, calls: Call[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), { status });
  }) as unknown as typeof fetch;
}

test('the daemon opened it: success, no client call, no client hint without a bridge', async () => {
  const calls: Call[] = [];
  const out = await revealOnDesktop({
    agentId: 'a b', path: 'x/y.txt', bridge: null,
    fetchFn: fakeFetch(200, { kind: 'revealed', path: 'x/y.txt', via: 'explorer' }, calls),
  });
  assert.deepEqual(out, { status: 'opened' });
  assert.deepEqual(calls, [{ url: '/api/ui/agents/a%20b/files/reveal', body: { path: 'x/y.txt' } }]);
});

test('with the desktop shell the renderer sends an agent and a relative path, and no request of its own', async () => {
  const calls: Call[] = [];
  const asked: unknown[] = [];
  const out = await revealOnDesktop({
    agentId: 'a', path: 'a b.txt',
    bridge: { revealPath: async (request) => { asked.push(request); return { status: 'opened' }; } },
    fetchFn: fakeFetch(200, { kind: 'client', absolutePath: '/x' }, calls),
  });
  assert.deepEqual(out, { status: 'opened' });
  assert.deepEqual(asked, [{ agentId: 'a', path: 'a b.txt' }]);
  assert.deepEqual(calls, [], 'the shell calls the route itself');
});

test('the shell outcome is relayed: no-desktop, failure message, malformed reply, throw', async () => {
  const via = (reply: unknown) => revealOnDesktop({
    agentId: 'a', path: '', bridge: { revealPath: async () => reply },
  });
  assert.deepEqual(await via({ status: 'no-desktop' }), { status: 'no-desktop' });
  assert.deepEqual(await via({ status: 'failed', message: 'Invalid path.' }), { status: 'failed', message: 'Invalid path.' });
  assert.deepEqual(await via(undefined), { status: 'failed', message: null });
  assert.deepEqual(await via({ status: 'opened-ish' }), { status: 'failed', message: null });
  assert.deepEqual(
    await revealOnDesktop({ agentId: 'a', path: '', bridge: { revealPath: async () => { throw new Error('boom'); } } }),
    { status: 'failed', message: 'boom' },
  );
});

test('no desktop session and no client: the explicit status, never opened', async () => {
  const out = await revealOnDesktop({
    agentId: 'a', path: '', bridge: null,
    fetchFn: fakeFetch(409, { error: 'x', code: 'no_desktop_session' }, []),
  });
  assert.deepEqual(out, { status: 'no-desktop' });
});

test('a client reply without a client to act on it is never a success', async () => {
  const out = await revealOnDesktop({
    agentId: 'a', path: '', bridge: null,
    fetchFn: fakeFetch(200, { kind: 'client', path: '', absolutePath: '/x', isDir: true }, []),
  });
  assert.deepEqual(out, { status: 'no-desktop' });
});

test('errors: daemon message kept, non-JSON 404 and network failure handled', async () => {
  assert.deepEqual(
    await revealOnDesktop({ agentId: 'a', path: 'z', bridge: null, fetchFn: fakeFetch(400, { error: 'not found: z' }, []) }),
    { status: 'failed', message: 'not found: z' },
  );
  assert.deepEqual(
    await revealOnDesktop({ agentId: 'a', path: 'z', bridge: null, fetchFn: fakeFetch(404, 'Not Found', []) }),
    { status: 'failed', message: null },
  );
  const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  assert.deepEqual(
    await revealOnDesktop({ agentId: 'a', path: 'z', bridge: null, fetchFn: down }),
    { status: 'failed', message: 'Error: offline' },
  );
});

test('the "file is on the daemon machine" message exists in both languages', () => {
  for (const locale of ['en', 'fr'] as const) {
    setLocale(locale);
    assert.notEqual(t('chatPage.revealNoDesktop'), 'chatPage.revealNoDesktop', locale);
  }
  setLocale('en');
});
