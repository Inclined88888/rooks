/**
 * TODO #275, decision B: the Kanban runs without git; only code, review and
 * merge tasks need it. Checked at the four places a tester meets it: the
 * module decision (running, with a warning), task creation (refused), the
 * dispatcher (BLOCKED with the reason) and `rooks doctor` (a line).
 *
 * The host here has git pinned to a path that does not exist, so the real
 * host adapter reports the capability missing — no fake host.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const home = mkdtempSync(join(tmpdir(), 'rooks-task-git-'));
process.env.ROOKS_HOME = home;
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
writeFileSync(join(home, 'rooks.config.json'), JSON.stringify({ host: { binaries: { git: join(home, 'no-such-git') } } }));
await import('../tests/helpers/paid-license.js');
await import('../tests/helpers/claude-provider.js');


const { getHost } = await import('./host/index.js');
const { agentDir } = await import('./paths.js');

/** A git directory as git lays it out: what `insideGitRepository` checks. */
function gitDir(dir: string, commondir?: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  if (commondir) writeFileSync(join(dir, 'commondir'), `${commondir}\n`);
  else for (const sub of ['objects', 'refs']) mkdirSync(join(dir, sub), { recursive: true });
}

// `git.agent` works in a git checkout, `sub.agent` in a sub-folder of it,
// `plain.agent` in a folder that is not one.
const repo = join(home, 'repo');
gitDir(join(repo, '.git'));
const repoSub = join(repo, 'packages', 'app');
mkdirSync(repoSub, { recursive: true });
const plain = join(home, 'plain');
mkdirSync(plain, { recursive: true });
for (const [name, cwd] of [['git.agent', repo], ['sub.agent', repoSub], ['plain.agent', plain]] as const) {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ cwd }));
}
const { gitTaskRefusal, insideGitRepository, GIT_MISSING_REASON } = await import('./task-git.js');
const { blockIfGitMissing } = await import('./dispatcher.js');
const { dbApi } = await import('./db.js');
const { CATALOG } = await import('./kernel/catalog.js');
const { planEntries } = await import('./kernel/registry.js');
const { config } = await import('./config/load.js');
const { diagnose, formatDoctor, moduleNotes, BINARIES } = await import('./doctor.js');
const { registerRoutes } = await import('./plugins-bundled/kanban/routes.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');

test('the pinned dead git really leaves the host without the capability', () => {
  assert.equal(getHost().capabilities().includes('git'), false);
});

test('only the task types that work in a git repository need git', () => {
  for (const type of ['code', 'review', 'merge']) {
    assert.equal(gitTaskRefusal(type, { cwd: repo, capabilities: [] }), GIT_MISSING_REASON, type);
  }
  for (const type of ['chore', 'doc', 'research', null, undefined]) {
    assert.equal(gitTaskRefusal(type, { cwd: repo, capabilities: [] }), null, String(type));
  }
  assert.equal(gitTaskRefusal('code', { cwd: repo, capabilities: ['git'] }), null);
});

test('a project that is not a git repository keeps code and review without git; merge never runs', () => {
  assert.equal(gitTaskRefusal('code', { cwd: plain, capabilities: [] }), null);
  assert.equal(gitTaskRefusal('review', { cwd: plain, capabilities: [] }), null);
  assert.equal(gitTaskRefusal('code', { cwd: null, capabilities: [] }), null);
  assert.equal(gitTaskRefusal('merge', { cwd: plain, capabilities: [] }), GIT_MISSING_REASON);
  // A task worktree carries a `.git` FILE, not a folder: still a repository.
  const worktree = join(home, 'worktree');
  mkdirSync(worktree);
  gitDir(join(repo, '.git', 'worktrees', 'worktree'), '../..');
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'worktree')}\n`);
  assert.equal(gitTaskRefusal('code', { cwd: worktree, capabilities: [] }), GIT_MISSING_REASON);
});

test('a repository is recognised from any folder inside it, checkout or worktree', () => {
  const worktree = join(home, 'wt-root');
  const worktreeSub = join(worktree, 'src', 'deep');
  mkdirSync(worktreeSub, { recursive: true });
  // A relative `gitdir:` resolves from the folder of the `.git` file.
  gitDir(join(repo, '.git', 'worktrees', 'wt-root'), '../..');
  writeFileSync(join(worktree, '.git'), 'gitdir: ../repo/.git/worktrees/wt-root\n');
  for (const cwd of [repo, repoSub, worktree, worktreeSub]) {
    assert.equal(insideGitRepository(cwd), true, cwd);
    assert.equal(gitTaskRefusal('code', { cwd, capabilities: [] }), GIT_MISSING_REASON, cwd);
    assert.equal(gitTaskRefusal('review', { cwd, capabilities: [] }), GIT_MISSING_REASON, cwd);
  }
  const plainSub = join(plain, 'nested');
  mkdirSync(plainSub, { recursive: true });
  for (const cwd of [plain, plainSub]) {
    assert.equal(insideGitRepository(cwd), false, cwd);
    assert.equal(gitTaskRefusal('code', { cwd, capabilities: [] }), null, cwd);
  }
});

test('a stray .git in a parent is not a repository: the projects below it stay non-git', () => {
  const decoys: Array<[string, (entry: string) => void]> = [
    ['empty-dir', (entry) => mkdirSync(entry)],
    ['head-only', (entry) => { mkdirSync(entry); writeFileSync(join(entry, 'HEAD'), 'ref: refs/heads/main\n'); }],
    ['bad-head', (entry) => { gitDir(entry); writeFileSync(join(entry, 'HEAD'), 'not a ref\n'); }],
    ['empty-file', (entry) => writeFileSync(entry, '')],
    ['garbage-file', (entry) => writeFileSync(entry, 'hello\n')],
    ['dangling-gitdir', (entry) => writeFileSync(entry, 'gitdir: elsewhere\n')],
    ['gitdir-to-empty', (entry) => { mkdirSync(join(home, 'empty-target'), { recursive: true }); writeFileSync(entry, `gitdir: ${join(home, 'empty-target')}\n`); }],
  ];
  for (const [name, plant] of decoys) {
    const parent = join(home, 'decoy', name);
    const project = join(parent, 'project', 'app');
    mkdirSync(project, { recursive: true });
    plant(join(parent, '.git'));
    for (const cwd of [parent, project]) {
      assert.equal(insideGitRepository(cwd), false, `${name}: ${cwd}`);
      assert.equal(gitTaskRefusal('code', { cwd, capabilities: [] }), null, `${name}: ${cwd}`);
    }
  }
  // A real repository below a stray marker is still found.
  const nested = join(home, 'decoy', 'empty-dir', 'real');
  gitDir(join(nested, '.git'));
  mkdirSync(join(nested, 'src'), { recursive: true });
  assert.equal(insideGitRepository(join(nested, 'src')), true);
});

test('without git the Kanban runs, warns, and its git half is off', () => {
  const decisions = new Map(planEntries(CATALOG, { config: config(), capabilities: [] }).map((d) => [d.id, d]));
  const kanban = decisions.get('@rooks/kanban')!;
  assert.equal(kanban.disabled, false);
  assert.match(kanban.warning ?? '', /^git not found on this host: code, review and merge tasks of a git project are refused/);
  for (const id of ['@rooks/routines', '@rooks/triggers']) assert.equal(decisions.get(id)?.disabled, false, id);
  assert.equal(decisions.get('@rooks/git')?.disabled, true);
  assert.equal(decisions.get('@rooks/kanban-code')?.disabled, true);

  const withGit = planEntries(CATALOG, { config: config(), capabilities: ['git'] }).find((d) => d.id === '@rooks/kanban')!;
  assert.equal(withGit.warning ?? null, null);
});

test('the dispatcher blocks a code task with the reason instead of spawning it in the shared checkout', () => {
  const id = randomUUID();
  dbApi.createTask(id, 'code without git', 'git.agent', { type: 'code' });
  assert.equal(blockIfGitMissing(dbApi.getTask(id)!), true);
  const task = dbApi.getTask(id)!;
  assert.equal(task.status, 'BLOCKED');
  assert.equal(task.blocked_reason, GIT_MISSING_REASON);

  const sub = randomUUID();
  dbApi.createTask(sub, 'review from a sub-folder without git', 'sub.agent', { type: 'review' });
  assert.equal(blockIfGitMissing(dbApi.getTask(sub)!), true);
  assert.equal(dbApi.getTask(sub)!.blocked_reason, GIT_MISSING_REASON);

  const plainCode = randomUUID();
  dbApi.createTask(plainCode, 'code outside any repository', 'plain.agent', { type: 'code' });
  assert.equal(blockIfGitMissing(dbApi.getTask(plainCode)!), false);

  const chore = randomUUID();
  dbApi.createTask(chore, 'chore without git', 'git.agent', { type: 'chore' });
  assert.equal(blockIfGitMissing(dbApi.getTask(chore)!), false);
  assert.notEqual(dbApi.getTask(chore)!.status, 'BLOCKED');
});

test('without git the machine has no global blocker: git is optional in the report', () => {
  assert.equal(BINARIES.find((b) => b.name === 'git')?.required ?? false, false);
  const report = diagnose();
  assert.equal(report.binaries.find((b) => b.name === 'git')?.ok, false);
  assert.equal(report.blockers.some((b) => b.startsWith('git')), false, report.blockers.join('\n'));
  // The cost stays visible, module by module, and the git tasks stay refused.
  assert.ok(report.modules.some((n) => n.startsWith('@rooks/kanban reduced: git not found')), report.modules.join('\n'));
});

test('rooks doctor names what the missing git costs', () => {
  const notes = moduleNotes([]);
  assert.ok(notes.includes('@rooks/git off: host capability unavailable: git'), notes.join('\n'));
  assert.ok(notes.some((n) => n.startsWith('@rooks/kanban reduced: git not found on this host')), notes.join('\n'));
  assert.equal(moduleNotes(['git', 'grepai', 'systemd', 'uvx', 'containers', 'gui']).length, 0);
  assert.match(formatDoctor(diagnose()), /modules limited by this machine:\n(?:.*\n)*\s+- @rooks\/kanban reduced: git not found/);
});

const app = express();
app.use(express.json());
app.use(createDaemonAuthMiddleware({ token: 'git-test', required: true }));
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function create(type: string, agent = 'git.agent'): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { Authorization: 'Bearer git-test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `${type} task`, agent_name: agent, type }),
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}

test('creating a code task is refused with the reason; a chore is not', async () => {
  const code = await create('code');
  assert.equal(code.status, 400);
  assert.equal(code.body.error, GIT_MISSING_REASON);
  assert.equal(code.body.code, 'git_missing');
  assert.equal(dbApi.listTasks().some((t) => t.title === 'code task'), false, 'a refused task leaves nothing behind');

  const subCode = await create('code', 'sub.agent');
  assert.equal(subCode.status, 400, 'an agent in a sub-folder of a repository is in that repository');
  assert.equal(subCode.body.code, 'git_missing');

  const chore = await create('chore');
  assert.notEqual(chore.status, 400, JSON.stringify(chore.body));

  const plainCode = await create('code', 'plain.agent');
  assert.notEqual(plainCode.status, 400, JSON.stringify(plainCode.body));
});
