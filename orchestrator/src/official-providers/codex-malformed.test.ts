import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-codex-malformed-'));
process.env.TIMON_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const kit = await import('../../../packages/sdk/src/testing/index.js');
const plugin = await import('../../official-providers/provider-codex/lib/index.js') as { apply(ctx: unknown): void };
const ctx = kit.createProviderContext();
plugin.apply(ctx);
const codexDialect = ctx.registered.dialect('codex') as import('../backends/types.js').Dialect;
process.on('exit', () => ctx.cleanup());

test('a completed item that carries no item is dropped, it does not throw into the stream reader', () => {
  for (const line of ['{"type":"item.completed"}', '{"type":"item.completed","item":null}', '{"type":"item.completed","item":"x"}']) {
    assert.deepEqual(codexDialect.parseLine(line), [], line);
  }
});
