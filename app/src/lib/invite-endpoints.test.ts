import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inviteEndpoints, resolveInviteEndpoints } from './invite-endpoints';

const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

test('with an account provider, the page calls its public routes, the token encoded', async () => {
  const endpoints = await resolveInviteEndpoints(answer(200, { provider: 'multi-user' }));
  assert.ok(endpoints);
  assert.equal(endpoints.lookup('a/b?c'), '/api/ui/plugins/multi-user/invite/a%2Fb%3Fc');
  assert.equal(endpoints.accept, '/api/ui/plugins/multi-user/invite/accept');
});

test('without a provider, or when the daemon cannot say, there is nothing to call', async () => {
  const calls: string[] = [];
  for (const fetcher of [
    answer(200, { provider: null }),
    answer(200, { provider: '' }),
    answer(200, { provider: 42 }),
    answer(500, { error: 'boom' }),
    async () => { throw new Error('offline'); },
  ]) {
    const endpoints = await resolveInviteEndpoints(async (input) => {
      calls.push(input);
      return fetcher();
    });
    assert.equal(endpoints, null);
  }
  assert.ok(calls.every((url) => url === '/api/ui/auth/account-provider'), 'no core invitation route is tried');
});

test('a provider id cannot climb out of the plugin proxy', () => {
  assert.equal(inviteEndpoints('../users').accept, '/api/ui/plugins/..%2Fusers/invite/accept');
});
