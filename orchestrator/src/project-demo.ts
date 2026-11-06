/**
 * The demo project of the developer tour: a tiny git repository the agents can
 * work on when the user has no repository of their own to attach. It lives in
 * the onboarding working folder (`workspacesRoot`, else the workspace folder of
 * the Timon home), never in a place the user did not hand to Timon.
 *
 * Idempotent: a second call returns the project already there. Files already
 * present are never overwritten — the user may have started working in it.
 *
 * It comes with its orchestrator and its coder: the tour opens the project's
 * chat and its agent's browser right after, and a project with no agent has no
 * one to talk to. The orchestrator is seeded first, so the coder reports to it
 * and it to the main agent. Both take the backend of the mission that asked
 * (`inheritedLlm`), like a role agent seeded by a task.
 */
import { bus, type ProjectEventOrigin } from './bus.js';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { config, expandTilde } from './config/load.js';
import { dbApi } from './db.js';
import { getHost } from './host/index.js';
import { WORKSPACE_DIR, agentDir } from './paths.js';
import { createProject, readMeta, type ProjectMeta } from './projects.js';
import { ensureProjectOrchestrator, resolveRoleAgent, type InheritedLlm } from './agent-seed.js';

export const DEMO_PROJECT_SLUG = 'timon-demo';

const FILES: Record<string, string> = {
  'README.md': `# Timon demo

A small project to try Timon's agents on. \`src/greet.js\` says hello; its tests
are in \`test/\` and run with \`npm test\` (Node 20 or later, nothing to install).

Ideas for a first task:

- add a \`farewell(name)\` function, with its test;
- make \`greet\` refuse an empty name;
- write a short changelog.
`,
  'package.json': `${JSON.stringify({ name: 'timon-demo', version: '0.1.0', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
  '.gitignore': 'node_modules/\n',
  [join('src', 'greet.js')]: `/** Says hello to someone. */
export function greet(name) {
  return \`Hello, \${name}!\`;
}
`,
  [join('test', 'greet.test.js')]: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../src/greet.js';

test('greet says hello', () => {
  assert.equal(greet('Ada'), 'Hello, Ada!');
});
`,
};

export type DemoProjectResult = {
  created: boolean;
  project: ProjectMeta & { slug: string };
  /** The project's orchestrator, `null` when it could not be seeded. */
  orchestrator: string | null;
  /** The project's coder, `null` when it could not be seeded. */
  coder: string | null;
  /** `git_unavailable`: the files are there, without a repository. */
  warnings: string[];
};

function demoRoot(): string {
  const raw = config().workspacesRoot;
  const root = raw ? expandTilde(raw) : WORKSPACE_DIR;
  if (!isAbsolute(root)) throw new Error(`the working folder is not an absolute path: "${root}"`);
  return root;
}

/** git, without a shell; a failure is reported, never thrown. */
function initRepository(dir: string): boolean {
  const host = getHost();
  const git = (args: string[]) => host.exec('git', args, { cwd: dir, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    if (!existsSync(join(dir, '.git'))) {
      if (git(['init', '--quiet']).code !== 0) return false;
      // `init -b` needs git 2.28; this works on any version.
      git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    }
    if (git(['rev-parse', '--verify', '--quiet', 'HEAD']).code === 0) return true;
    if (git(['add', '--all']).code !== 0) return false;
    // A fresh machine may have no git identity: the demo commit names Timon.
    return git(['-c', 'user.name=Timon', '-c', 'user.email=demo@timon-ai.com', 'commit', '--quiet', '-m', 'Demo project']).code === 0;
  } catch {
    return false;
  }
}

function seedAgents(cwd: string | null | undefined, inherit: InheritedLlm | null): { orchestrator: string | null; coder: string | null } {
  if (!cwd) return { orchestrator: null, coder: null };
  const orchestrator = ensureProjectOrchestrator(DEMO_PROJECT_SLUG, { cwd, inherit });
  const name = resolveRoleAgent(DEMO_PROJECT_SLUG, 'coder', { cwd, inherit });
  return { orchestrator, coder: name && existsSync(agentDir(name)) ? name : null };
}

export function createDemoProject(opts: { inherit?: InheritedLlm | null; origin?: ProjectEventOrigin } = {}): DemoProjectResult {
  const inherit = opts.inherit ?? null;
  if (dbApi.getProjectRow(DEMO_PROJECT_SLUG)) {
    const meta = readMeta(DEMO_PROJECT_SLUG);
    return { created: false, project: { slug: DEMO_PROJECT_SLUG, ...meta }, ...seedAgents(meta.cwd, inherit), warnings: [] };
  }
  const dir = join(demoRoot(), DEMO_PROJECT_SLUG);
  for (const [rel, content] of Object.entries(FILES)) {
    const file = join(dir, rel);
    if (existsSync(file)) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
  }
  const warnings = initRepository(dir) ? [] : ['git_unavailable'];
  const meta = createProject(DEMO_PROJECT_SLUG, {
    name: 'Timon demo',
    cwd: realpathSync(dir),
    speech: 'A small project to try the agents on.',
  });
  bus.publish({ kind: 'project_created', slug: DEMO_PROJECT_SLUG, origin: opts.origin ?? { kind: 'system', id: null } });
  return { created: true, project: { slug: DEMO_PROJECT_SLUG, ...meta }, ...seedAgents(meta.cwd, inherit), warnings };
}
