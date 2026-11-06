/**
 * TIM-0064: a backend switch whose summary failed on the backend being left
 * sent only the transcript tail. The arriving backend now gets one try.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { registerDialect, registerProfile } = await import('./backends/registry.js');
const { summarizeForSwitch, unknownModelFallback } = await import('./summary.js');
const { memoryDialect } = await import('../tests/helpers/example-dialects.js') as {
  memoryDialect: import('./backends/types.js').RemoteDialect;
};

const OWNER = 'summary-switch-test';
registerDialect(OWNER, 'switch-remote', memoryDialect);
registerProfile(OWNER, { id: 'switch-remote', dialect: 'switch-remote', label: 'remote', defaultModel: 'gw-1', models: [{ slug: 'gw-1', label: 'gw-1' }], env: {} });

type Llm = { backend: string; model: string | null } | undefined;

/** A summariser that fails on the mission's own backend, and answers (or not)
 *  on the one it is pointed at. */
function summarizer(onTarget: 'ok' | 'fail', calls: Llm[]) {
  return async (_missionId: string, opts: { llm?: { backend: string; model: string | null } } = {}) => {
    calls.push(opts.llm);
    if (!opts.llm) throw new Error('summary failed: Failed to authenticate');
    if (onTarget === 'fail') throw new Error('summary failed: model not available');
    return { summary: `by ${opts.llm.backend}`, cached: false, eventId: 1 };
  };
}

{
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test('the backend being left summarises when it can', async () => {
  const calls: Llm[] = [];
  const out = await summarizeForSwitch('m-1', { backend: 'codex', model: 'gpt-5.5' }, async (_id, opts = {}) => {
    calls.push(opts.llm);
    return { summary: 'by source', cached: false, eventId: 1 };
  });
  assert.deepEqual(out, { summary: 'by source', summarizedBy: 'source', sourceError: null });
  assert.deepEqual(calls, [undefined]);
});

test('when it fails, the arriving backend summarises, with its own model', async () => {
  const calls: Llm[] = [];
  const out = await summarizeForSwitch('m-2', { backend: 'codex', model: 'gpt-5.5' }, summarizer('ok', calls));
  assert.equal(out.summary, 'by codex');
  assert.equal(out.summarizedBy, 'target');
  assert.equal(out.sourceError, 'summary failed: Failed to authenticate');
  assert.deepEqual(calls, [undefined, { backend: 'codex', model: 'gpt-5.5' }]);
});

test('both failures reach the caller', async () => {
  await assert.rejects(
    summarizeForSwitch('m-3', { backend: 'codex', model: null }, summarizer('fail', [])),
    /Failed to authenticate; on codex: .*model not available/,
  );
});

test('a backend that cannot run a one-shot is not retried', async () => {
  const calls: Llm[] = [];
  await assert.rejects(
    summarizeForSwitch('m-4', { backend: 'switch-remote', model: 'gw-1' }, summarizer('ok', calls)),
    /^Error: summary failed: Failed to authenticate$/,
  );
  assert.deepEqual(calls, [undefined]);
});

test('a model the CLI does not know gets one more run on the provider\'s default', () => {
  const claude404 = "summary failed: There's an issue with the selected model (claude-haiku-4.5). It may not exist or you may not have access to it. (HTTP 404)";
  assert.deepEqual(unknownModelFallback('claude', 'claude-haiku-4.5', claude404), { retry: true, model: 'sonnet' });
  assert.deepEqual(unknownModelFallback('claude', 'claude-haiku-4.5', 'summary failed: [claude-code:unrecognized_model] {"model":"claude-haiku-4.5"}'), { retry: true, model: 'sonnet' });
  assert.deepEqual(unknownModelFallback('claude', 'sonnet', claude404), { retry: false }, 'the default itself failed: nothing better to try');
  assert.deepEqual(unknownModelFallback('claude', undefined, claude404), { retry: false }, 'no model was asked: the CLI chose');
  assert.deepEqual(unknownModelFallback('claude', 'claude-haiku-4.5', 'summary failed: Failed to authenticate'), { retry: false }, 'another cause is not a model problem');
});
