/**
 * Opening `/chat` sent `/api/ui/auth/me` eight times and most other reads
 * twice; the duplicates queued in front of the conversation. What this locks:
 * overlapping identical reads leave as ONE request, and nothing settled is
 * ever replayed (a read after a save or a login reaches the daemon).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { sharedGet } from '@/lib/shared-read';

test('overlapping identical reads share one request, each caller owns its body', async (t) => {
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((done) => { release = done; });
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    await gate;
    return Response.json({ user: { id: 'u1' } });
  });
  const reads = Promise.all([sharedGet('/api/ui/auth/me'), sharedGet('/api/ui/auth/me'), sharedGet('/api/ui/auth/me')]);
  release();
  const [a, b, c] = await reads;
  assert.equal(calls, 1);
  assert.deepEqual(await a.json(), { user: { id: 'u1' } });
  assert.deepEqual(await b.json(), { user: { id: 'u1' } });
  assert.deepEqual(await c.json(), { user: { id: 'u1' } });
});

test('a settled read is never replayed, and distinct urls never share', async (t) => {
  const seen: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return Response.json({ n: seen.length });
  });
  await sharedGet('/api/ui/projects');
  await sharedGet('/api/ui/projects');
  await Promise.all([sharedGet('/api/ui/skills'), sharedGet('/api/ui/skills?cwd=x')]);
  assert.deepEqual(seen, ['/api/ui/projects', '/api/ui/projects', '/api/ui/skills', '/api/ui/skills?cwd=x']);
});

test('a failed read is not kept: the next one asks again', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) throw new TypeError('offline');
    return new Response(null, { status: 503 });
  });
  await assert.rejects(sharedGet('/api/ui/mcp'));
  assert.equal((await sharedGet('/api/ui/mcp')).status, 503);
  assert.equal(calls, 2);
});
