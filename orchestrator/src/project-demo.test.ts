/**
 * The demo project of the developer tour: a small git repository in the
 * onboarding working folder, registered once; a second call returns it, and
 * files the user already touched are never overwritten.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-demo-project-'));

const { createDemoProject, DEMO_PROJECT_SLUG } = await import('./project-demo.js');
await import('../tests/helpers/claude-provider.js');

const { WORKSPACE_DIR } = await import('./paths.js');
const { dbApi } = await import('./db.js');
const { getAgent } = await import('./agent.js');

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('creates the repository in the working folder and registers the project', () => {
  const r = createDemoProject();
  assert.equal(r.created, true);
  assert.equal(r.project.slug, DEMO_PROJECT_SLUG);
  const dir = join(WORKSPACE_DIR, DEMO_PROJECT_SLUG);
  assert.ok(existsSync(join(dir, 'src', 'greet.js')));
  assert.ok(existsSync(join(dir, 'test', 'greet.test.js')));
  assert.ok(dbApi.getProjectRow(DEMO_PROJECT_SLUG));
  assert.ok(r.project.cwd && r.project.cwd.endsWith(DEMO_PROJECT_SLUG));
  // Its orchestrator, then its coder, in the project's folder: the tour opens
  // the chat next, and the Agents page draws main → orchestrator → coder.
  assert.equal(r.orchestrator, 'rooks-demo.main');
  assert.equal(getAgent('rooks-demo.main')?.role, 'orchestrator');
  assert.equal(getAgent('rooks-demo.main')?.project, DEMO_PROJECT_SLUG);
  assert.equal(r.coder, 'rooks-demo.coder');
  const coder = getAgent('rooks-demo.coder');
  assert.equal(coder?.project, DEMO_PROJECT_SLUG);
  assert.equal(coder?.cwd, r.project.cwd);
  if (hasGit) {
    assert.deepEqual(r.warnings, []);
    const log = execFileSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' });
    assert.match(log, /Demo project/);
  }
});

test('a second call returns the existing project and leaves the files alone', () => {
  const readme = join(WORKSPACE_DIR, DEMO_PROJECT_SLUG, 'README.md');
  writeFileSync(readme, 'mine\n', 'utf8');
  const r = createDemoProject();
  assert.equal(r.created, false);
  assert.equal(r.project.slug, DEMO_PROJECT_SLUG);
  assert.equal(r.orchestrator, 'rooks-demo.main');
  assert.equal(r.coder, 'rooks-demo.coder');
  assert.equal(readFileSync(readme, 'utf8'), 'mine\n');
});
