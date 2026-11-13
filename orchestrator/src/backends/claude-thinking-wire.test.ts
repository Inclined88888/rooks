/**
 * What the `claude` CLI really puts in the HTTP request for each thinking
 * setting of the dialect, proven against a fake Anthropic endpoint on the
 * loopback: no network, no credit spent.
 *
 * `CLAUDE_CODE_MODEL_CAPABILITIES` and `MAX_THINKING_TOKENS` are CLI internals
 * (measured on 2.1.289). This test is the guard against an update that renames
 * or reinterprets them: it fails when the CLI is installed and the body no
 * longer carries what the dialect promised. Without the CLI it is skipped.
 *
 * The CLI runs in `--print` mode here, a one-shot turn: the thinking settings
 * are read at startup, the same way in the stream-json mode the dialect uses.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { claudeThinking, type ClaudeThinking } from '../../official-providers/provider-claude/lib/thinking.js';
import { resolveModelReasoning, type ModelReasoning } from './reasoning.js';

type Body = { model?: string; thinking?: { type: string; budget_tokens?: number }; output_config?: { effort?: string } };

const RUN_TIMEOUT_MS = 45_000;

/** Answers any Messages call with a one-word reply, streamed or not. */
function reply(body: Body, res: ServerResponse): void {
  const message = {
    id: 'msg_test', type: 'message', role: 'assistant', model: body.model ?? 'test',
    content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  if (!(body as { stream?: boolean }).stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(message));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type: string, data: object): void => { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); };
  send('message_start', { message: { ...message, content: [], stop_reason: null } });
  send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } });
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  send('message_stop', {});
  res.end();
}

/**
 * Runs the CLI once against the fake endpoint and returns the body of its
 * Messages request, or null when the CLI is not installed. The environment is
 * built from scratch: no login of this machine can leak into it.
 */
async function wire(model: string, thinking: ClaudeThinking): Promise<Body | null> {
  const bodies: Body[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      let body: Body = {};
      try { body = JSON.parse(raw) as Body; } catch { /* a GET carries no body */ }
      if (req.method === 'POST' && req.url?.startsWith('/v1/messages') && !req.url.includes('count_tokens')) {
        bodies.push(body);
        reply(body, res);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"input_tokens":1}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = mkdtempSync(join(tmpdir(), 'rooks-claude-wire-'));
  try {
    const { port } = server.address() as AddressInfo;
    const inherited = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]!]));
    const env = {
      ...inherited,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_AUTH_TOKEN: 'test-only',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      ...thinking.env,
    };
    const args = ['-p', 'hi', '--model', model, '--output-format', 'json', ...thinking.args];
    const outcome = await new Promise<'done' | 'missing'>((resolve, reject) => {
      const child = spawn('claude', args, { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.stdout.resume();
      const timer = setTimeout(() => { child.kill(); reject(new Error(`claude did not finish in ${RUN_TIMEOUT_MS} ms`)); }, RUN_TIMEOUT_MS);
      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (err.code === 'ENOENT') resolve('missing');
        else reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve('done');
        else reject(new Error(`claude exited with ${code}: ${stderr.slice(0, 500)}`));
      });
    });
    if (outcome === 'missing') return null;
    const sent = bodies.find((body) => body.model === model);
    assert.ok(sent, `no Messages request for ${model} reached the fake endpoint`);
    return sent;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}

async function bodyOr(t: TestContext, model: string, thinking: ClaudeThinking): Promise<Body | null> {
  const body = await wire(model, thinking);
  if (!body) t.skip('the claude CLI is not installed');
  return body;
}

const BAI = 'https://api.b.ai/v1';
const qwen = resolveModelReasoning({ slug: 'qwen3.8-max', catalog: { baseUrl: BAI } })!;
const sonnetDotted: ModelReasoning = { source: 'declared', thinks: true, controls: [{ type: 'levels', values: ['low', 'high', 'max'] }] };
const toggleOnly: ModelReasoning = { source: 'catalog', thinks: true, controls: [{ type: 'toggle' }] };

test('a budget model gets `thinking.budget_tokens` and no effort', async (t) => {
  const body = await bodyOr(t, 'qwen3.8-max', claudeThinking('medium', qwen));
  if (!body) return;
  assert.deepEqual({ type: body.thinking?.type, budget_tokens: body.thinking?.budget_tokens }, { type: 'enabled', budget_tokens: 8000 });
  assert.equal(body.output_config?.effort, undefined);
});

test('the top budget step is capped by the CLI below its output limit', async (t) => {
  const body = await bodyOr(t, 'qwen3.8-max', claudeThinking('high', qwen));
  if (!body) return;
  assert.equal(body.thinking?.type, 'enabled');
  assert.ok(body.thinking!.budget_tokens! > 8000 && body.thinking!.budget_tokens! <= 32000, String(body.thinking?.budget_tokens));
});

test('a switch turned off sends no thinking', async (t) => {
  const body = await bodyOr(t, 'qwen3.8-27b', claudeThinking('off', toggleOnly));
  if (!body) return;
  assert.equal(body.thinking, undefined);
  assert.equal(body.output_config?.effort, undefined);
});

test('a level reaches `output_config.effort`, even on an id the CLI misreads', async (t) => {
  // Alone, `--effort max` on `claude-sonnet-4.6` is dropped by the CLI.
  const body = await bodyOr(t, 'claude-sonnet-4.6', claudeThinking('max', sonnetDotted));
  if (!body) return;
  assert.equal(body.output_config?.effort, 'max');
});

test('the Claude subscription: `--effort` alone, as before', async (t) => {
  const plain = claudeThinking('low');
  assert.deepEqual(plain.env, {});
  const body = await bodyOr(t, 'claude-sonnet-4-6', plain);
  if (!body) return;
  assert.equal(body.thinking?.type, 'adaptive');
  assert.equal(body.output_config?.effort, 'low');
});
