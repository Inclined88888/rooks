import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { codexContextSnapshot, snapshotFromRolloutTail } from '../../official-providers/provider-codex/lib/context.js';

const turn = (model: string) => JSON.stringify({ type: 'turn_context', payload: { model } });
const count = (input: number, window = 258400) => JSON.stringify({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: input * 10 },
      last_token_usage: { input_tokens: input },
      model_context_window: window,
    },
  },
});

test('takes the latest call, not the summed turn usage', () => {
  const tail = [turn('gpt-5.6-sol'), count(35732), count(44121), ''].join('\n');
  assert.deepEqual(snapshotFromRolloutTail(tail), { tokens: 44121, window: 258400, model: 'gpt-5.6-sol' });
});

test('ignores a cut first line and a token_count without info', () => {
  const noInfo = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } });
  const tail = ['"token_count","info":{"last_tok', count(1200), noInfo].join('\n');
  assert.deepEqual(snapshotFromRolloutTail(tail), { tokens: 1200, window: 258400, model: null });
  assert.equal(snapshotFromRolloutTail('nothing here\n'), null);
});

test('reads the newest rollout of the mission CODEX_HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-ctx-'));
  assert.equal(codexContextSnapshot(home), null);
  const day = join(home, 'sessions', '2026', '09', '21');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, 'rollout-a.jsonl'), [turn('gpt-5.6-sol'), count(5000)].join('\n') + '\n');
  assert.equal(codexContextSnapshot(home)?.tokens, 5000);
});
