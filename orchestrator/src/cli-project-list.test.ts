/**
 * `rooks project list` prints one slug per line (TIM-0055: it printed
 * `[object Object]` once `GET /api/projects` returned objects instead of slugs).
 *
 * Témoin HTTP sur `127.0.0.1:0`, jamais le daemon de la machine.
 */
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-cli-project-list-test-'));

const ROOKS = fileURLToPath(new URL('../bin/rooks', import.meta.url));

function run(projects: unknown[]): Promise<{ code: number | null; stdout: string }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ projects, workspaces: [] }));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const env = { ...process.env, ROOKS_API: `http://127.0.0.1:${port}`, ROOKS_RESOURCE_GUARD_ENABLED: '0' };
      delete env.ROOKS_API_TOKEN;
      const child = spawn(process.execPath, [ROOKS, 'project', 'list'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (c: Buffer | string) => { stdout += String(c); });
      child.on('error', reject);
      child.on('close', (code) => server.close(() => resolve({ code, stdout })));
    });
  });
}

test('prints the slug of each project object, not [object Object]', async () => {
  const r = await run([{ slug: 'rooks', name: 'Rooks', color: '#fff' }, { slug: 'nimbus', name: 'Nimbus' }]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'rooks\nnimbus\n');
});

test('still accepts a bare slug', async () => {
  const r = await run(['rooks', { slug: 'nimbus' }]);
  assert.equal(r.stdout, 'rooks\nnimbus\n');
});
