import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const APP_DIR = resolve(__dirname, '..', '..');
const ENTRY = 'src/server.ts';

/** Runs `code` with the arguments of the `start` script, its entry point left out. */
function underStartScript(code: string, env: NodeJS.ProcessEnv): string {
  const manifest = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')) as { scripts: { start: string } };
  const [bin, ...args] = manifest.scripts.start.split(' ');
  assert.equal(bin, 'tsx');
  assert.equal(args.pop(), ENTRY, 'the start script still runs the server');
  const tsx = join(APP_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return execFileSync(process.execPath, [tsx, ...args, '-e', code], { cwd: APP_DIR, env, encoding: 'utf8' }).trim();
}

for (const inherited of ['development', 'test', undefined] as const) {
  test(`npm start runs in production when NODE_ENV is ${inherited ?? 'unset'}`, () => {
    // child_process leaves out a variable whose value is undefined.
    const env = { ...process.env, NODE_ENV: inherited } as NodeJS.ProcessEnv;
    assert.equal(underStartScript('console.log(process.env.NODE_ENV)', env), 'production');
  });
}
