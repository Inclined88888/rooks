/**
 * A skill as a content of the island workspace: its params hold an id and
 * nothing that names a file, it opens previewed, a read-only one never offers
 * the editor, and a save writes through the skills API to the path the daemon
 * returned.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

test('parseSkillIslandParams: an id of the registry, never a path', async (t) => {
  // The DOM first: React and Radix read it once, when they load, and a dialog's input would never fire onChange.
  await mount(t);
  const { parseSkillIslandParams } = await import('./skill-island');
  assert.deepEqual(parseSkillIslandParams({ id: 'review-pr' }), { id: 'review-pr', mode: 'preview' });
  assert.deepEqual(parseSkillIslandParams({ id: 'plugin:cmd', mode: 'edit' }), { id: 'plugin:cmd', mode: 'edit' });
  assert.deepEqual(parseSkillIslandParams({ id: 'a', mode: 'write', path: '/etc/passwd' }), { id: 'a', mode: 'preview' }, 'a path in the params is dropped');
  assert.equal(parseSkillIslandParams({ id: '../secrets' }), null);
  assert.equal(parseSkillIslandParams({ id: 'a/b' }), null);
  assert.equal(parseSkillIslandParams({ id: 'a\\b' }), null);
  assert.equal(parseSkillIslandParams({ id: 'a..b' }), null);
  assert.equal(parseSkillIslandParams({ id: '' }), null);
  assert.equal(parseSkillIslandParams({ id: 'a'.repeat(129) }), null);
  assert.equal(parseSkillIslandParams(null), null);
  assert.deepEqual(parseSkillIslandParams({ id: 'review-pr', source: 'timon', section: 'recipients' }), {
    id: 'review-pr', mode: 'preview', source: 'timon', section: 'recipients',
  });
  assert.deepEqual(parseSkillIslandParams({ id: 'review-pr', section: 'unknown' }), { id: 'review-pr', mode: 'preview' });
});

test('a masked skill keeps its source in the tab, and reads that entry', async (t) => {
  await mount(t);
  const { parseSkillIslandParams, skillIslandContent, skillReadUrl } = await import('./skill-island');
  assert.deepEqual(
    parseSkillIslandParams({ id: 'helper', source: 'claude-user', format: 'claude-skill' }),
    { id: 'helper', mode: 'preview', source: 'claude-user', format: 'claude-skill' },
  );
  assert.deepEqual(parseSkillIslandParams({ id: 'helper', source: '/etc', format: 'claude-skill' }), { id: 'helper', mode: 'preview' }, 'an unknown source is dropped, its format with it');
  assert.deepEqual(parseSkillIslandParams({ id: 'helper', source: 'plugin', format: 'x' }), { id: 'helper', mode: 'preview', source: 'plugin' });
  assert.deepEqual(skillIslandContent('helper').params, { id: 'helper', mode: 'preview' }, 'a winner names no source');
  assert.equal(skillReadUrl('helper'), '/api/ui/skills/helper');
  assert.equal(skillReadUrl('plugin:x', { source: 'claude-user', format: 'claude-cmd' }), '/api/ui/skills/plugin%3Ax?source=claude-user&format=claude-cmd');
});

type Call = { url: string; method: string; body: string | null };

/** What the import route answers next: a status and its body. */
let importReply: { status: number; body: unknown } = { status: 201, body: { ok: true, id: 'plugin-lint' } };

const SKILLS: Record<string, { editable: boolean; source: string; path: string; content: string }> = {
  'review-pr': { editable: true, source: 'timon', path: '/home/me/.timon/skills/review-pr/SKILL.md', content: '# Review a PR\n\nRead the **diff** first.\n' },
  'plugin:lint': { editable: false, source: 'plugin', path: '/home/me/.claude/plugins/cache/x/commands/lint.md', content: '# Lint\n\nRun the linter.\n' },
};

function installFetch(install: (key: string, value: unknown) => void): Call[] {
  const calls: Call[] = [];
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost/');
    const method = init?.method ?? 'GET';
    calls.push({ url: url.pathname + url.search, method, body: typeof init?.body === 'string' ? init.body : null });
    if (method === 'POST' && url.pathname === '/api/ui/skills') return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (method === 'POST' && url.pathname.endsWith('/import')) return new Response(JSON.stringify(importReply.body), { status: importReply.status });
    const id = decodeURIComponent(url.pathname.replace('/api/ui/skills/', ''));
    const skill = SKILLS[id];
    if (!skill) return new Response(JSON.stringify({ error: 'skill not found' }), { status: 404 });
    return new Response(JSON.stringify({
      id, title: id, description: '', format: 'claude-skill', scope: 'global', size: skill.content.length, updated_at: 0, ...skill,
    }), { status: 200 });
  });
  return calls;
}

async function mount(ctx: TestContext) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/skills', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLFormElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'MutationObserver', 'NodeFilter', 'DOMParser', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  Object.defineProperty(dom.window, 'innerWidth', { value: 1400, configurable: true });
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { get: () => 1400, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { get: () => 800, configurable: true });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const calls = installFetch(install);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const slots = await import('@/lib/plugin-host/slots');
  const tree = await import('@/lib/island-tree');
  const { IslandWorkspaceView } = await import('@/components/islands/island-workspace');
  const island = await import('./skill-island');

  slots.resetSlotsForTests();
  slots.declareSlot('island.content', 'list');
  const dispose = slots.register({
    slot: 'island.content',
    pluginId: '@timon/agents',
    key: island.SKILL_ISLAND_KEY,
    island: { title: 'Skill', parseParams: island.parseSkillIslandParams, singletonBy: ['id'] },
  }, island.SkillIsland);

  const root = createRoot(document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  ctx.after(async () => {
    await act(() => root.unmount());
    dispose();
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); });
  const trees: unknown[] = [];
  return {
    calls,
    trees,
    act,
    flush,
    window: dom.window,
    async open(id: string, mode: 'preview' | 'edit' = 'preview', section?: 'recipients') {
      const base = tree.defaultIslandTree();
      const next = tree.insertAt(base, base.root.id, 'right', island.skillIslandContent(id, mode, undefined, section)).tree;
      await act(() => {
        root.render(React.createElement(IslandWorkspaceView, {
          tree: next,
          onTree: (tree: unknown) => { trees.push(tree); },
          route: React.createElement('div', { id: 'route' }, 'the page'),
          className: 'timon-island flex min-h-0 flex-1 flex-col',
        }));
      });
      await flush();
    },
  };
}

test('a skill opens previewed: its markdown rendered, its source and path above it', async (t) => {
  const w = await mount(t);
  await w.open('review-pr');
  assert.equal(w.calls[0]?.url, '/api/ui/skills/review-pr', 'read through the skills API, not an agent folder');
  const strong = document.querySelector('.chat-bubble strong');
  assert.equal(strong?.textContent, 'diff', 'the markdown is rendered, not shown raw');
  const text = document.body.textContent ?? '';
  assert.match(text, /\/home\/me\/\.timon\/skills\/review-pr\/SKILL\.md/);
  assert.ok(document.querySelector('button[aria-label="Edit"]'), 'an editable skill offers the editor');
  assert.ok(document.querySelector('button[aria-label="Delete the skill"]'));
});

test('a read-only skill never offers the editor, even asked for edit', async (t) => {
  const w = await mount(t);
  await w.open('plugin:lint', 'edit');
  assert.match(document.body.textContent ?? '', /read-only/);
  assert.ok(!document.querySelector('button[aria-label="Edit"]'));
  assert.ok(!document.querySelector('button[aria-label="Save"]'));
  assert.ok(!document.querySelector('button[aria-label="Delete the skill"]'));
  assert.ok(!document.querySelector('.chat-bubble strong'));
  assert.match(document.querySelector('.chat-bubble')?.textContent ?? '', /Run the linter/, 'previewed');
});

test('an inherited skill link opens its recipient section expanded', async (t) => {
  const w = await mount(t);
  await w.open('review-pr', 'preview', 'recipients');
  const section = document.querySelector('section[aria-label="Who receives this skill"]');
  assert.equal(section?.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded'), 'true');
});

test('a save writes through the skills API, to the path the daemon returned', async (t) => {
  const w = await mount(t);
  const { skillSource } = await import('./skill-island');
  const { onSkillsChanged } = await import('@/lib/skill-island-content');
  let changed = 0;
  t.after(onSkillsChanged(() => { changed += 1; }));
  const source = skillSource('review-pr', () => {});
  const loaded = await source.load();
  assert.ok('file' in loaded);
  assert.equal(await source.save(loaded.file, '# Review a PR\n\nNew rules.\n'), true);
  const post = w.calls.find((c) => c.method === 'POST');
  assert.equal(post?.url, '/api/ui/skills');
  assert.deepEqual(JSON.parse(post!.body!), { path: SKILLS['review-pr']!.path, content: '# Review a PR\n\nNew rules.\n' });
  assert.equal(changed, 1, 'the Skills page is told to read its list again');
  assert.equal(await source.save(loaded.file, '   '), false, 'empty instructions are refused before the request');
  assert.equal(w.calls.filter((c) => c.method === 'POST').length, 1);
});

test('a plugin skill says it never reaches a mission and offers the import; a Timon skill does neither', async (t) => {
  const w = await mount(t);
  await w.open('review-pr');
  assert.doesNotMatch(document.body.textContent ?? '', /Not available in missions/);
  assert.ok(!Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.includes('Import into')));
});

test('the import copies the skill under the id given, refuses a taken one, then shows the copy', async (t) => {
  const w = await mount(t);
  await w.open('plugin:lint');
  assert.match(document.body.textContent ?? '', /Not available in missions/);
  const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Import into'));
  assert.ok(button, 'an import is offered');
  await w.act(() => { button.click(); });
  await w.flush();
  const field = () => document.querySelector('input[aria-label="ID of the copy"]') as HTMLInputElement | null;
  const input = field();
  assert.ok(input);
  assert.equal(input.value, 'plugin-lint', 'the namespace is folded into the default id');
  assert.match(document.body.textContent ?? '', /never the plugin's hooks or MCP servers/);
  const submit = async () => {
    await w.act(() => { input.form!.dispatchEvent(new w.window.Event('submit', { bubbles: true, cancelable: true })); });
    await w.flush();
  };

  importReply = { status: 409, body: { error: 'exists', code: 'skill_exists' } };
  await submit();
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /already exists/);
  const post = w.calls.find((c) => c.method === 'POST' && c.url.endsWith('/import'));
  assert.equal(post?.url, '/api/ui/skills/plugin%3Alint/import');
  assert.deepEqual(JSON.parse(post!.body!), { source: 'plugin', as: 'plugin-lint' });

  importReply = { status: 403, body: { error: 'forbidden', reason: 'allowed_tools in a skill pre-authorises tools: that needs agents:privileged-config' } };
  await submit();
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /agents:privileged-config/);

  const setter = Object.getOwnPropertyDescriptor(w.window.HTMLInputElement.prototype, 'value')!.set!;
  await w.act(() => { setter.call(input, 'Bad Id'); input.dispatchEvent(new w.window.Event('input', { bubbles: true })); });
  const before = w.calls.length;
  await submit();
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /lowercase/);
  assert.equal(w.calls.length, before, 'an invalid id is refused before the request');

  t.after(() => { importReply = { status: 201, body: { ok: true, id: 'plugin-lint' } }; });
  importReply = { status: 201, body: { ok: true, id: 'lint-copy' } };
  await w.act(() => { setter.call(input, 'lint-copy'); input.dispatchEvent(new w.window.Event('input', { bubbles: true })); });
  await submit();
  assert.ok(!field(), 'the dialog closes');
  assert.match(JSON.stringify(w.trees.at(-1)), /"id":"lint-copy"/, 'the tab now shows the Timon copy');
});
