/**
 * The Skills page hands a skill to the island workspace: a card opens it
 * previewed in a popup, and a new skill is written from a template and opens
 * in the editor.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { IslandContent } from '@/lib/island-tree';

type Opened = { content: IslandContent; edge: string };

async function mount(ctx: TestContext) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/skills', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'MutationObserver', 'NodeFilter', 'HTMLFormElement', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const posts: unknown[] = [];
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ skills: [
      { id: 'review-pr', title: 'Review a PR', description: 'Reads the diff', source: 'timon', format: 'timon', scope: 'global', path: '/x/SKILL.md', editable: true, size: 10, updated_at: Date.now() },
      { id: 'geo-audit', title: 'Geo audit', description: 'Audits', source: 'claude-user', format: 'claude-skill', scope: 'global', path: '/c/SKILL.md', editable: true, size: 10, updated_at: Date.now() },
      { id: 'proj-lint', title: 'Lint', description: 'Lints', source: 'project', format: 'claude-skill', scope: 'project', path: '/p/SKILL.md', editable: true, size: 10, updated_at: Date.now() },
    ] }), { status: 200 });
  });

  const opened: Opened[] = [];
  const bus = await import('@/lib/island-bus');
  const withdraw = bus.announceIslandWorkspace({
    open: (content, edge) => { opened.push({ content, edge }); return true; },
    activate() {},
    close() {},
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { SkillsClient } = await import('./skills-client');
  const root = createRoot(document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  ctx.after(async () => {
    await act(() => root.unmount());
    withdraw();
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); });
  await act(() => { root.render(React.createElement(SkillsClient)); });
  await flush();
  return { act, flush, opened, posts, window: dom.window };
}

test('a card opens its skill previewed, in a popup of the workspace', async (t) => {
  const w = await mount(t);
  const card = Array.from(document.querySelectorAll('article[role="button"]')).find((el) => el.textContent?.includes('/review-pr'));
  assert.ok(card, 'the skill is listed');
  assert.ok(!document.querySelector('textarea'), 'no raw text area left on the page');
  await w.act(() => { (card as HTMLElement).click(); });
  assert.deepEqual(w.opened, [{ content: { type: '@timon/agents:skill', params: { id: 'review-pr', mode: 'preview' } }, edge: 'float' }]);
});

test('a new skill is written from a template, then opens in the editor', async (t) => {
  const w = await mount(t);
  const button = Array.from(document.querySelectorAll('button')).find((el) => el.textContent?.includes('New'));
  assert.ok(button);
  await w.act(() => { button.click(); });
  await w.flush();
  const input = document.querySelector('input[aria-label="Skill ID"]') as HTMLInputElement | null;
  assert.ok(input, 'the dialog asks for the id only');
  const type = async (value: string) => {
    const setter = Object.getOwnPropertyDescriptor(w.window.HTMLInputElement.prototype, 'value')!.set!;
    await w.act(() => { setter.call(input, value); input.dispatchEvent(new w.window.Event('input', { bubbles: true })); });
  };
  const submit = async () => {
    await w.act(() => { input.form!.dispatchEvent(new w.window.Event('submit', { bubbles: true, cancelable: true })); });
    await w.flush();
  };

  await type('review-pr');
  await submit();
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /already exists/, 'an existing skill is never overwritten');
  assert.equal(w.posts.length, 0);

  await type('Bad Id');
  await submit();
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /lowercase/);
  assert.equal(w.posts.length, 0);

  await type('triage');
  await submit();
  assert.equal(w.posts.length, 1);
  const post = w.posts[0] as { id: string; content: string };
  assert.equal(post.id, 'triage');
  assert.match(post.content, /^# triage\n/);
  assert.deepEqual(w.opened, [{ content: { type: '@timon/agents:skill', params: { id: 'triage', mode: 'edit' } }, edge: 'float' }]);
});

test('a ~/.claude skill says it never reaches a mission; Timon and project skills do not', async (t) => {
  await mount(t);
  const card = (id: string) => Array.from(document.querySelectorAll('article[role="button"]')).find((el) => el.textContent?.includes(`/${id}`));
  assert.match(card('geo-audit')?.textContent ?? '', /Not available in missions/);
  assert.doesNotMatch(card('review-pr')?.textContent ?? '', /Not available in missions/);
  assert.doesNotMatch(card('proj-lint')?.textContent ?? '', /Not available in missions/);
  assert.match(document.body.textContent ?? '', /not loaded by missions/, 'the section hint no longer claims they are auto-loaded');
});

test('the skills are rows grouped by source, each section listed in the table of contents', async (t) => {
  await mount(t);
  const headings = Array.from(document.querySelectorAll('h2[data-toc]')).map((h) => [h.id, h.getAttribute('data-toc'), h.getAttribute('data-toc-count')]);
  assert.deepEqual(headings, [
    ['skills-timon', 'Timon skills', '1'],
    ['skills-claude-user', 'Global Claude skills', '1'],
    ['skills-project', 'Project skills', '1'],
  ]);
  assert.deepEqual(Array.from(document.querySelectorAll('nav a')).map((a) => a.getAttribute('href')), ['#skills-timon', '#skills-claude-user', '#skills-project']);
  const row = Array.from(document.querySelectorAll('article[role="button"]')).find((el) => el.textContent?.includes('/review-pr'));
  assert.match(row?.textContent ?? '', /Reads the diff/);
  assert.ok(!row?.querySelector('[class*="badge"], .border-dashed'), 'no chips on a row');
});
