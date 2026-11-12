/**
 * The composer's Git bar and its picker, rendered: what the bar says, that
 * the lists are read from the store only once the picker opens, and that a
 * checkout leaves from the list with the project's slug.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { answerConfirmsForTests } from '@/components/confirm-dialog/confirm-dialog-context';
import type { AgentGitInfo, GitDashboard, GitWorktreeList } from '@/lib/git-store';

type Call = { url: string; method: string; body: string | null };

const dashboard = (slug: string): GitDashboard => ({
  ok: true, repo: `/r/${slug}`, base: 'main', currentBranch: 'main',
  branches: [
    { name: 'main', current: true, merged: false, ahead: 0, behind: 0, lastCommitTs: 0, lastCommitSubject: 'init', worktree: false },
    { name: 'feat/a', current: false, merged: false, ahead: 2, behind: 0, lastCommitTs: 0, lastCommitSubject: 'wip', worktree: false },
    { name: 'task/42', current: false, merged: false, ahead: 0, behind: 0, lastCommitTs: 0, lastCommitSubject: '', worktree: true },
  ],
  staged: [], unstaged: [], untracked: [],
});

const worktrees = (slug: string): GitWorktreeList => ({
  ok: true, repo: `/r/${slug}`,
  worktrees: [
    { path: `/r/${slug}`, head: 'a', branch: 'main', main: true, current: true, bare: false, detached: false, locked: null, prunable: null },
    { path: '/w/42', head: 'b', branch: 'task/42', main: false, current: false, bare: false, detached: false, locked: null, prunable: null },
  ],
});

async function withDom(run: (calls: Call[]) => Promise<void>, me: unknown = { user: null, can: { 'projects:manage': true } }): Promise<void> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  const calls: Call[] = [];
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  answerConfirmsForTests(() => true);
  install('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null });
    const slug = new URL(url, 'http://localhost').searchParams.get('slug') ?? '';
    const json = url.startsWith('/api/ui/auth/me') ? me
      : url.startsWith('/api/ui/git/worktrees') ? worktrees(slug)
      : url.startsWith('/api/ui/git/checkout') ? { ok: true }
        : url.startsWith('/api/ui/git?') ? dashboard(slug)
          : { branch: 'main', dirty: false, worktree: null };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const React = await import('react');
  install('React', React);
  // `useMe` keeps the account for the whole page: each test reads its own.
  const { refreshMe } = await import('@/hooks/use-me');
  await refreshMe();
  calls.length = 0;
  try {
    await run(calls);
  } finally {
    answerConfirmsForTests(null);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
}

async function render(
  props: { slug: string | null; info: AgentGitInfo; cwd: string },
  run: (host: HTMLElement, act: (fn: () => void | Promise<void>) => Promise<void>) => Promise<void>,
): Promise<void> {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { GitBranchPicker } = await import('./git-branch-picker');
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  const act = async (fn: () => void | Promise<void>) => { await React.act(async () => { await fn(); }); };
  try {
    await act(() => { root.render(React.createElement(GitBranchPicker, props)); });
    await run(host, act);
  } finally {
    await act(() => { root.unmount(); });
    // Radix returns the focus on a timer after the menu unmounts: it must
    // run while the DOM globals are still installed.
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function openPicker(host: HTMLElement, act: (fn: () => void | Promise<void>) => Promise<void>): Promise<void> {
  const trigger = host.querySelector('button')!;
  await act(() => {
    trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  // Let the store's reads answer.
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));

test('the bar reads branch · folder · lines, and reads no list while closed', async () => {
  await withDom(async (calls) => {
    await render(
      { slug: 'closed', info: { branch: 'feat/a', dirty: true, worktree: null, added: 412, removed: 96 }, cwd: '/home/u/projects/rooks' },
      async (host) => {
        const text = host.textContent ?? '';
        assert.match(text, /feat\/a/);
        assert.match(text, /rooks/);
        assert.match(text, /\+412/);
        assert.match(text, /−96/);
        assert.ok(!host.querySelector('.font-mono'), 'no fixed-width font in the bar');
        assert.equal(calls.length, 0, 'nothing is read before the picker opens');
      },
    );
  });
});

test('the open picker lists branches and worktrees and checks a free branch out', async () => {
  await withDom(async (calls) => {
    await render(
      { slug: 'proj', info: { branch: 'main', dirty: false, worktree: null }, cwd: '/r/proj' },
      async (host, act) => {
        await openPicker(host, act);
        assert.ok(calls.some((c) => c.url === '/api/ui/git?slug=proj'));
        assert.ok(calls.some((c) => c.url === '/api/ui/git/worktrees?slug=proj'));
        const items = rows();
        assert.deepEqual(items.map((r) => r.textContent?.split(/current|worktree|↑/)[0]), ['main', 'feat/a', 'task/42']);
        assert.deepEqual(items.map((r) => r.hasAttribute('data-disabled')), [true, false, true]);
        // The worktree section names each folder and where the conversation is.
        const body = document.body.textContent ?? '';
        assert.match(body, /Worktrees/);
        assert.match(body, /42/);

        await act(() => { items[1]!.click(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
        const checkout = calls.find((c) => c.url === '/api/ui/git/checkout');
        assert.ok(checkout, 'a checkout was posted');
        assert.equal(checkout.method, 'POST');
        assert.deepEqual(JSON.parse(checkout.body ?? '{}'), { slug: 'proj', branch: 'feat/a' });
      },
    );
  });
});

test('from a linked worktree nothing is switchable, and the picker says why', async () => {
  await withDom(async () => {
    await render(
      { slug: 'wt', info: { branch: 'task/42', dirty: false, worktree: '42' }, cwd: '/w/42' },
      async (host, act) => {
        await openPicker(host, act);
        assert.deepEqual(rows().map((r) => r.hasAttribute('data-disabled')), [true, true, true]);
        assert.match(document.body.textContent ?? '', /worktree 42/);
      },
    );
  });
});

test('without a project the bar is a plain label, no picker', async () => {
  await withDom(async (calls) => {
    await render(
      { slug: null, info: { branch: 'main', dirty: false, worktree: null }, cwd: '/x/y' },
      async (host) => {
        assert.ok(!host.querySelector('button'), 'no trigger without a project');
        assert.match(host.textContent ?? '', /main/);
        assert.equal(calls.length, 0);
      },
    );
  });
});

// TODO #560: a checkout is `projects:manage`; an account without it reads the
// branches, cannot pick one, and is told why rather than shown "forbidden".
test('an account without projects:manage reads the branches but cannot switch, and is told why', async () => {
  await withDom(async (calls) => {
    await render(
      { slug: 'ro', info: { branch: 'main', dirty: false, worktree: null }, cwd: '/r/ro' },
      async (host, act) => {
        await openPicker(host, act);
        const items = rows();
        assert.equal(items.length, 3, 'the branches are still listed');
        assert.deepEqual(items.map((r) => r.hasAttribute('data-disabled')), [true, true, true]);
        assert.match(document.body.textContent ?? '', /projects:manage/);

        await act(() => { items[1]!.click(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
        assert.ok(!calls.some((c) => c.url === '/api/ui/git/checkout'), 'no checkout is posted');
      },
    );
  }, { user: null, can: { 'projects:manage': false } });
});
