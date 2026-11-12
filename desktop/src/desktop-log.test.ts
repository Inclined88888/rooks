import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

test('the copied log naming, stamping and purge are verbatim from the orchestrator (TODO #343)', () => {
  const copy = readFileSync(join(here, 'desktop-log.ts'), 'utf8');
  const source = readFileSync(join(here, '..', '..', 'orchestrator', 'src', 'log-file.ts'), 'utf8');
  const start = copy.indexOf('// --- copy of orchestrator/src/log-file.ts ---');
  const end = copy.indexOf('// --- end of copy ---');
  assert.ok(start > 0 && end > start);
  const blocks = copy.slice(start, end).split('\n').slice(1).join('\n').split(/\n\n+/).map((block) => block.trim()).filter(Boolean);
  assert.ok(blocks.length > 10);
  for (const block of blocks) assert.ok(source.includes(block), `drifted from orchestrator/src/log-file.ts:\n${block.slice(0, 200)}`);
});

test('the desktop log stamps what the main process prints into desktop-<day>.log', { timeout: 30_000 }, () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-desktop-log-'));
  try {
    const module = new URL('./desktop-log.ts', import.meta.url).href;
    const script = join(home, 'logged.mjs');
    writeFileSync(script, `
      import { installDesktopLog } from ${JSON.stringify(module)};
      installDesktopLog(${JSON.stringify(home)});
      console.error('[desktop] service upgrade failed');
    `);
    const result = spawnSync(process.execPath, ['--import', 'tsx', script], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr);
    const files = readdirSync(join(home, 'tmp'));
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^desktop-\d{4}-\d{2}-\d{2}\.log$/);
    assert.match(readFileSync(join(home, 'tmp', files[0]!), 'utf8'), /^\d{4}-\d{2}-\d{2}T\S+[+-]\d{2}:\d{2} \[desktop\] service upgrade failed\n$/);
    assert.match(result.stderr, /\[desktop\] service upgrade failed/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
