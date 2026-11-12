import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dbApi } from './db.js';
import { agentDir } from './paths.js';
import { resolveWorktree, worktreeDirective } from './dispatcher.js';
import { disposeWorktree, type WorktreeInfo } from './worktree.js';

test('all worktree briefs protect shared dependencies, including retries and cross-project reviewers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rooks-dispatch-deps-'));
  const repo = join(root, 'source');
  const reviewerRepo = join(root, 'other-project');
  const worktrees: WorktreeInfo[] = [];
  try {
    for (const directory of [repo, reviewerRepo]) {
      mkdirSync(join(directory, 'node_modules'), { recursive: true });
      writeFileSync(join(directory, 'package.json'), '{}');
      writeFileSync(join(directory, '.gitignore'), 'node_modules\n');
      const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { stdio: 'pipe' });
      git('init', '-b', 'main');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.invalid');
      git('add', '.');
      git('commit', '-m', 'Initial packages');
    }
    let codeId = '';
    for (const type of ['code', 'merge', 'review'] as const) {
      const id = randomUUID();
      const agent = `deps.${id}`;
      mkdirSync(agentDir(agent), { recursive: true });
      writeFileSync(join(agentDir(agent), 'config.json'), JSON.stringify({ cwd: type === 'review' ? reviewerRepo : repo }));
      writeFileSync(join(agentDir(agent), 'system-prompt.md'), 'Test');
      dbApi.createTask(id, 'Dependencies fixture', agent, { type, deps: type === 'review' ? [codeId] : [] });
      if (type === 'code') codeId = id;
      for (const retry of [false, true]) {
        const task = dbApi.getTask(id)!;
        const wt = await resolveWorktree(task);
        assert.ok(wt);
        if (!retry && type !== 'review') worktrees.push(wt);
        assert.equal(wt.sourceRepo, repo);
        assert.equal(realpathSync(join(wt.path, 'node_modules')), realpathSync(join(repo, 'node_modules')));
        const brief = worktreeDirective(task, wt);
        assert.ok(brief.includes(repo));
        assert.match(brief, /Do NOT run/);
        for (const command of ['npm ci', 'npm install', 'npm rebuild', 'electron-rebuild', 'npx tsc --noEmit']) {
          assert.ok(brief.includes(command), `${type} retry=${retry}: ${command}`);
        }
        assert.match(brief, /overrides generic installation advice/);
        // Force preparation on retry to expose a wrong source even if links already existed.
        rmSync(join(wt.path, 'node_modules'));
      }
      assert.equal(worktreeDirective(dbApi.getTask(id)!, null), '');
    }
  } finally {
    for (const wt of worktrees) await disposeWorktree(wt, true);
    rmSync(root, { recursive: true, force: true });
  }
});
