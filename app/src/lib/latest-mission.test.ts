import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchLatestMission } from './latest-mission';

function withFetch(impl: (url: string) => Promise<Response>, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => impl(String(input))) as typeof fetch;
  return run().finally(() => { globalThis.fetch = original; });
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('asks the proxy for the agent and returns its pick', () => withFetch(
  async (url) => {
    assert.equal(url, '/api/ui/missions/latest?agent=alice.main');
    return json(200, { mission: { id: 'm1', agent_name: 'alice.main', running: true } });
  },
  async () => assert.deepEqual(await fetchLatestMission('alice.main'), { id: 'm1', agent_name: 'alice.main', running: true }),
));

test('null when the agent has no mission, undefined when the lookup fails', async () => {
  await withFetch(async () => json(200, { mission: null }), async () => assert.equal(await fetchLatestMission('a'), null));
  await withFetch(async () => json(404, { error: 'not found' }), async () => assert.equal(await fetchLatestMission('a'), undefined));
  await withFetch(async () => { throw new Error('offline'); }, async () => assert.equal(await fetchLatestMission('a'), undefined));
  await withFetch(async () => json(200, { mission: { nope: 1 } }), async () => assert.equal(await fetchLatestMission('a'), undefined));
});
