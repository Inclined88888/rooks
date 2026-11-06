import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useStandaloneConfig } from './standalone-config';

function appWith(config: Record<string, unknown> | null, distDir = '.next'): string {
  const dir = mkdtempSync(join(tmpdir(), 'timon-standalone-'));
  if (config) {
    mkdirSync(join(dir, distDir), { recursive: true });
    writeFileSync(join(dir, distDir, 'required-server-files.json'), JSON.stringify({ version: 1, config }));
  }
  return dir;
}

test('standalone build: the serialized config is handed to Next', () => {
  const env: Record<string, string | undefined> = {};
  const config = { output: 'standalone', distDir: '.next', skipTrailingSlashRedirect: true };
  assert.equal(useStandaloneConfig(appWith(config), env), true);
  assert.deepEqual(JSON.parse(env.__NEXT_PRIVATE_STANDALONE_CONFIG!), config);
});

test('regular build or no build: next.config.mjs stays the source', () => {
  const env: Record<string, string | undefined> = {};
  assert.equal(useStandaloneConfig(appWith({ distDir: '.next' }), env), false);
  assert.equal(useStandaloneConfig(appWith(null), env), false);
  assert.equal(env.__NEXT_PRIVATE_STANDALONE_CONFIG, undefined);
});

test('NEXT_DIST_DIR is honoured, like next.config.mjs does', () => {
  const env: Record<string, string | undefined> = { NEXT_DIST_DIR: '.next-staging' };
  assert.equal(useStandaloneConfig(appWith({ output: 'standalone' }, '.next-staging'), env), true);
});
