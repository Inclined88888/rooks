/**
 * GET /api/usage — missing CLI session is a typed idle state, not a 503.
 * A real upstream failure stays 503. Detection is by error type/code, never
 * by comparing the English message (TIM-0011).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const HOME = mkdtempSync(join(tmpdir(), 'timon-usage-route-'));
process.env.TIMON_HOME = HOME;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { registerRoutes } = await import('./routes.js');
const { resetClaudeUsageCache } = await import('../../../tests/helpers/claude-provider.js');

async function listening() {
  const app = express();
  registerRoutes(app as never);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  return { base: `http://127.0.0.1:${addr.port}`, server };
}

async function withoutClaudeSession<T>(run: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'timon-usage-no-oauth-'));
  const previousDir = process.env.CLAUDE_CONFIG_DIR;
  const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CONFIG_DIR = dir;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    return await run();
  } finally {
    if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousDir;
    if (previousToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken;
  }
}

test('GET /api/usage without a CLI session is 200 connected=false', { concurrency: false }, async () => {
  resetClaudeUsageCache();
  const { base, server } = await listening();
  try {
    const body = await withoutClaudeSession(async () => {
      const res = await fetch(`${base}/api/usage?backend=claude`);
      assert.equal(res.status, 200);
      return await res.json() as {
        backend?: string;
        supported?: boolean;
        connected?: boolean;
        reason?: string;
        error?: string;
      };
    });
    assert.equal(body.backend, 'claude');
    assert.equal(body.supported, true);
    assert.equal(body.connected, false);
    assert.equal(body.reason, 'not_signed_in');
    assert.equal(body.error, undefined);
  } finally {
    server.close();
  }
});

test('GET /api/usage keeps 503 on a real provider 5xx', { concurrency: false }, async () => {
  resetClaudeUsageCache();
  const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'usage-route-probe-token';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('api.anthropic.com') || url.includes('platform.claude.com')) {
      return new Response('provider exploded', { status: 502 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const { base, server } = await listening();
  try {
    const res = await fetch(`${base}/api/usage?backend=claude`);
    assert.equal(res.status, 503);
    const body = await res.json() as { error?: string; connected?: boolean };
    assert.equal(body.connected, undefined);
    assert.equal(typeof body.error, 'string');
  } finally {
    globalThis.fetch = realFetch;
    if (previousToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken;
    server.close();
  }
});

test('GET /api/usage does not treat a network error as not-signed-in by message text', { concurrency: false }, async () => {
  resetClaudeUsageCache();
  const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'usage-route-spoof-token';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('api.anthropic.com') || url.includes('platform.claude.com')) {
      throw new Error('No Claude Code OAuth session; run `/login` in the CLI and retry');
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const { base, server } = await listening();
  try {
    const res = await fetch(`${base}/api/usage?backend=claude`);
    assert.equal(res.status, 503, 'matching the login sentence must not become 200');
  } finally {
    globalThis.fetch = realFetch;
    if (previousToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken;
    server.close();
  }
});
