import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertEntriesResolve, externalRequires } from './entry-resolve.mjs';

test('externalRequires: bare package names only, scoped and deep paths folded', () => {
  const src = 'require("node:http"); require("fs"); require("./x"); require("next"); require("next/dist/a"); require(\'@scope/pkg/deep\');';
  assert.deepEqual(externalRequires(src), ['@scope/pkg', 'next']);
});

test('assertEntriesResolve fails the build when an entry needs a package the app lacks', () => {
  const app = mkdtempSync(join(tmpdir(), 'timon-entry-'));
  writeFileSync(join(app, 'package.json'), '{"name":"app"}');
  mkdirSync(join(app, 'node_modules', 'next'), { recursive: true });
  writeFileSync(join(app, 'node_modules', 'next', 'package.json'), '{"name":"next","main":"index.js"}');
  writeFileSync(join(app, 'node_modules', 'next', 'index.js'), '');
  const server = join(app, 'server.cjs');
  writeFileSync(server, 'require("next"); require("node:http");');
  assertEntriesResolve(app, [server]);
  const worker = join(app, 'worker.cjs');
  writeFileSync(worker, 'require("better-sqlite3"); require("next");');
  assert.throws(() => assertEntriesResolve(app, [server, worker]), /lacks: better-sqlite3 \(required by worker\.cjs\)$/);
});
