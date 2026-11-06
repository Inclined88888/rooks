import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { providerRuntime } from '../backends/provider-runtime.js';
import { createGrokUsage, parseGrokUsage } from '../../official-providers/provider-grok/lib/usage.js';

// The daemon's own runtime, as `ctx.provider.runtime` hands it to the plugin.
const { getGrokUsage } = createGrokUsage(providerRuntime) as {
  getGrokUsage(opts?: { force?: boolean; fetchImpl?: typeof fetch }): Promise<import('../backends/types.js').AccountUsage>;
};

const now = Date.parse('2026-09-04T12:00:00Z');

test('normalizes the current Grok weekly subscription pool', () => {
  assert.deepEqual(parseGrokUsage({
    config: {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-09-01T00:00:00Z',
        end: '2026-09-08T00:00:00Z',
      },
      creditUsagePercent: 63,
    },
  }, now), { usedPercent: 63, periodEnd: '2026-09-08T00:00:00.000Z' });
});

test('rejects stale periods and malformed percentages', () => {
  const base = {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-08-20T00:00:00Z',
      end: '2026-08-27T00:00:00Z',
    },
  };
  assert.equal(parseGrokUsage({ config: { ...base, creditUsagePercent: 20 } }, now), null);
  assert.equal(parseGrokUsage({ config: {
    ...base,
    currentPeriod: { ...base.currentPeriod, start: '2026-09-01T00:00:00Z', end: '2026-09-08T00:00:00Z' },
    creditUsagePercent: 140,
  } }, now), null);
});

test('refreshes an expired OIDC token and preserves the Grok auth store', { concurrency: false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-grok-usage-'));
  const path = join(dir, 'auth.json');
  const scope = 'https://auth.x.ai::account';
  writeFileSync(path, JSON.stringify({
    untouched: { key: 'another-account' },
    [scope]: {
      key: 'expired-access',
      auth_mode: 'oidc',
      oidc_issuer: 'https://auth.x.ai',
      oidc_client_id: 'client-id',
      refresh_token: 'refresh-old',
      expires_at: '2026-09-04T10:00:00Z',
      user_id: 'user-id',
      preference: 'keep-me',
    },
  }));
  const previous = process.env.GROK_AUTH_JSON;
  process.env.GROK_AUTH_JSON = path;
  const calls: Array<{ url: string; authorization?: string; body?: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      authorization: new Headers(init?.headers).get('authorization') ?? undefined,
      body: init?.body instanceof URLSearchParams ? init.body.toString() : undefined,
    });
    if (url.endsWith('/.well-known/openid-configuration')) {
      return Response.json({ token_endpoint: 'https://auth.x.ai/oauth/token' });
    }
    if (url.endsWith('/oauth/token')) {
      return Response.json({ access_token: 'fresh-access', refresh_token: 'refresh-new', expires_in: 3600 });
    }
    return Response.json({
      config: {
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: new Date(Date.now() - 60_000).toISOString(),
          end: new Date(Date.now() + 60_000).toISOString(),
        },
        creditUsagePercent: 42,
      },
    });
  }) as typeof fetch;
  try {
    const usage = await getGrokUsage({ force: true, fetchImpl });
    assert.equal(usage.windows.weekly?.utilization, 42);
    assert.equal(calls.length, 3);
    assert.match(calls[1]?.body ?? '', /refresh_token=refresh-old/);
    assert.equal(calls[2]?.authorization, 'Bearer fresh-access');
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>;
    assert.equal(stored[scope]?.key, 'fresh-access');
    assert.equal(stored[scope]?.refresh_token, 'refresh-new');
    assert.equal(stored[scope]?.preference, 'keep-me');
    assert.equal(stored.untouched?.key, 'another-account');
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    if (previous === undefined) delete process.env.GROK_AUTH_JSON;
    else process.env.GROK_AUTH_JSON = previous;
  }
});

test('shares one upstream billing request between concurrent callers', { concurrency: false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-grok-shared-'));
  const path = join(dir, 'auth.json');
  writeFileSync(path, JSON.stringify({
    'https://accounts.x.ai/sign-in': {
      key: 'shared-access',
      auth_mode: 'oidc',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      user_id: 'user-id',
    },
  }));
  const previous = process.env.GROK_AUTH_JSON;
  process.env.GROK_AUTH_JSON = path;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetchImpl = (async () => {
    calls += 1;
    await gate;
    return Response.json({
      config: {
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: new Date(Date.now() - 60_000).toISOString(),
          end: new Date(Date.now() + 60_000).toISOString(),
        },
        creditUsagePercent: 42,
      },
    });
  }) as typeof fetch;
  try {
    const first = getGrokUsage({ force: true, fetchImpl });
    const second = getGrokUsage({ force: true, fetchImpl });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(calls, 1);
  } finally {
    if (previous === undefined) delete process.env.GROK_AUTH_JSON;
    else process.env.GROK_AUTH_JSON = previous;
  }
});

test('does not expose the credential path when the Grok session is absent', { concurrency: false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-grok-missing-'));
  const path = join(dir, 'auth.json');
  writeFileSync(path, '{}');
  const previous = process.env.GROK_AUTH_JSON;
  process.env.GROK_AUTH_JSON = path;
  try {
    await assert.rejects(
      getGrokUsage({ force: true, fetchImpl: (async () => { throw new Error('must not fetch'); }) as typeof fetch }),
      (error: Error) => {
        assert.match(error.message, /run `grok login`/);
        assert.doesNotMatch(error.message, new RegExp(dir));
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.GROK_AUTH_JSON;
    else process.env.GROK_AUTH_JSON = previous;
  }
});
