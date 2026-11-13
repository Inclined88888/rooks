import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { setConfig } = await import('../../config/load.js');
const { RooksConfigSchema } = await import('../../config/schema.js');
const whatsapp = await import('./index.js');

function appRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rooks-whatsapp-'));
  mkdirSync(join(root, 'orchestrator'), { recursive: true });
  mkdirSync(join(root, 'app', 'node_modules', 'tsx', 'dist'), { recursive: true });
  mkdirSync(join(root, 'app', 'src', 'workers'), { recursive: true });
  writeFileSync(join(root, 'app', 'node_modules', 'tsx', 'dist', 'cli.mjs'), '');
  writeFileSync(join(root, 'app', 'src', 'workers', 'whatsapp-web.ts'), '');
  writeFileSync(join(root, 'app', 'src', 'workers', 'mission-watcher.ts'), '');
  return root;
}

test('whatsapp module stays disabled until enabled: true', () => {
  const root = appRoot();
  const cfg = RooksConfigSchema.parse({ daemon: { installDir: join(root, 'orchestrator') }, modules: {} });
  setConfig(cfg);
  assert.equal(whatsapp.isEnabled(cfg), false);
  const on = RooksConfigSchema.parse({
    daemon: { installDir: join(root, 'orchestrator') },
    modules: { '@rooks/whatsapp': { enabled: true } },
  });
  assert.equal(whatsapp.isEnabled(on), true);
});

test('workersFor includes Baileys only when a whatsapp-web channel exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-channels-'));
  assert.deepEqual(whatsapp.workersFor(dir), []);
  writeFileSync(join(dir, 'cloud.json'), JSON.stringify({
    type: 'whatsapp-cloud', default_agent: 'main',
    phone_number_id: '1234567890', access_token_env: 'A', verify_token_env: 'B',
  }));
  assert.deepEqual(whatsapp.workersFor(dir), ['mission-watcher']);
  writeFileSync(join(dir, 'web.json'), JSON.stringify({
    type: 'whatsapp-web', default_agent: 'main', worker_secret_env: 'S',
  }));
  assert.deepEqual(whatsapp.workersFor(dir).sort(), ['mission-watcher', 'whatsapp-web'].sort());
});
