/**
 * The gallery identity of every bundled module — kinds, slots, routes.
 *
 * What this locks: a module added to the catalog without an identity would
 * show up as `behavior` again, which is exactly the lie the gallery used to
 * tell about Agent chat (a widget) and Settings (a page).
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { CATALOG } = await import('../kernel/catalog.js');
const { BUNDLED_AUTHOR, BUNDLED_IDENTITY, bundledIdentity } = await import('./bundled-identity.js');
const { toPublicBundled } = await import('./public.js');
const { PLUGIN_KINDS } = await import('./manifest.js');
const { BUNDLED_ICONS, bundledIconUrl } = await import('./bundled-icons.js');

test('chaque module du catalogue a une identité de galerie', () => {
  const catalogIds = CATALOG.map((m) => m.id).sort();
  const identityIds = Object.keys(BUNDLED_IDENTITY).sort();
  assert.deepEqual(identityIds, catalogIds);
});

test('Agent chat est un widget, Settings une page, le noyau un backend', () => {
  assert.deepEqual(bundledIdentity('@rooks/agent-chat').kind, ['widget']);
  assert.deepEqual(bundledIdentity('@rooks/agent-chat').slots, ['cockpit.widget']);
  assert.equal(bundledIdentity('@rooks/settings').route, '/settings');
  assert.deepEqual(bundledIdentity('@rooks/settings').kind, ['page']);
  assert.deepEqual(bundledIdentity('@rooks/db').kind, ['behavior']);
  // The layout also paints the cockpit clock: the Widget filter must list it.
  assert.deepEqual(bundledIdentity('@rooks/ui-layout').kind, ['layout', 'widget']);
  assert.deepEqual(bundledIdentity('@rooks/grepai').kind, ['widget']);
  assert.equal(bundledIdentity('@rooks/ui-layout').slots[0], 'root');
  assert.deepEqual(bundledIdentity('@rooks/ui-theme').kind, ['theme']);
  assert.deepEqual(bundledIdentity('@rooks/ui-theme').slots, ['theme', 'settings.section']);
  // The /dreams page follows `@rooks/dreams`, the "TO DO" notebook follows
  // `@rooks/kanban`.
  assert.deepEqual(bundledIdentity('@rooks/dreams').kind, ['widget', 'page']);
  assert.equal(bundledIdentity('@rooks/dreams').route, '/dreams');
  // Volet 4/4 : le carnet a repris une tuile, le Kanban est donc AUSSI un
  // widget — deux `kind`, comme dreams.
  assert.deepEqual(bundledIdentity('@rooks/kanban').kind, ['page', 'widget']);
  assert.deepEqual(bundledIdentity('@rooks/kanban').slots, ['nav.item', 'kanban.column', 'cockpit.widget', 'task.form', 'kanban.card', 'todo.form']);
  // TODO #311: the code pipeline paints nothing any more. TODO #356, #357:
  // the chat's Files, Skills and MCP cards are widgets of their own, so the
  // agents module leaves both chat rails.
  assert.deepEqual(bundledIdentity('@rooks/kanban-code').kind, ['behavior']);
  assert.deepEqual(bundledIdentity('@rooks/files-widget').kind, ['widget']);
  assert.deepEqual(bundledIdentity('@rooks/files-widget').slots, ['chat.left.widget']);
  assert.equal(bundledIdentity('@rooks/files-widget').route, null);
  for (const id of ['@rooks/skills-widget', '@rooks/mcp-widget']) {
    assert.deepEqual(bundledIdentity(id).kind, ['widget'], id);
    assert.deepEqual(bundledIdentity(id).slots, ['chat.right.widget'], id);
    assert.equal(bundledIdentity(id).route, null, id);
  }
  assert.deepEqual(bundledIdentity('@rooks/agents').slots, ['nav.item', 'cockpit.widget', 'settings.agenttrash', 'agent.mascot', 'agent.lookstyler']);
  // A host module that also occupies the browser's chrome (TODO #461): still `behavior`, its slots named.
  assert.deepEqual(bundledIdentity('@rooks/browser-recording').kind, ['behavior']);
  assert.deepEqual(bundledIdentity('@rooks/browser-recording').slots, ['browser.toolbar', 'browser.drawer']);
});

test('toPublicBundled pose le kind réel, plus Rooks comme auteur', () => {
  const agentChat = toPublicBundled({
    id: '@rooks/agent-chat', tier: 'std', active: true, reason: null, missing: [], wanted: 'auto',
  });
  assert.deepEqual(agentChat.kind, ['widget']);
  assert.deepEqual(agentChat.slots, ['cockpit.widget']);
  assert.equal(agentChat.author, BUNDLED_AUTHOR);
  assert.equal(agentChat.signed, null, 'un bundled n\'a pas de signature : le catalogue est la confiance');
  assert.equal(agentChat.label, null, 'le libellé traduit vit dans le front, pas ici');
  assert.deepEqual(agentChat.screenshots, []);

  const core = toPublicBundled({
    id: '@rooks/db', tier: 'core', active: true, reason: null, missing: [], wanted: 'auto',
  });
  assert.deepEqual(core.kind, ['behavior']);
  assert.equal(core.author, 'Rooks');
});

test('the Files card plugin reaches the gallery as a widget, under its -widget name (TODO #356)', () => {
  // The gallery paints one badge per kind (PluginKindBadge, KIND_TONE.widget):
  // this is the kind it receives, not a guess from the slots.
  const files = toPublicBundled({ id: '@rooks/files-widget', tier: 'std', active: true, reason: null, missing: [], wanted: 'auto' });
  assert.deepEqual(files.kind, ['widget']);
  assert.deepEqual(files.slots, ['chat.left.widget']);
  assert.equal(BUNDLED_IDENTITY['@rooks/files'], undefined, 'the short-lived name is gone');
});

test('un id inconnu retombe sur behavior, sans inventer de surface', () => {
  const ghost = bundledIdentity('not-in-the-catalog');
  assert.deepEqual(ghost.kind, ['behavior']);
  assert.deepEqual(ghost.slots, []);
  assert.equal(ghost.route, null);
});

test('ui-layout déclare les prises de greffe settings, sans tiret', () => {
  const declares = bundledIdentity('@rooks/ui-layout').declares;
  assert.equal(declares['settings.section'], 'keyed');
  assert.equal(declares['settings.missions'], 'list');
  assert.equal(declares['settings.llmfallback'], 'list');
  assert.equal(declares['settings.notifications'], 'list');
  assert.equal(declares['settings.memoryinjection'], 'list');
  assert.equal(declares['settings.llm-fallback'], undefined);
});

test('aucun kind hors contrat', () => {
  const allowed = new Set<string>(PLUGIN_KINDS);
  for (const [id, identity] of Object.entries(BUNDLED_IDENTITY)) {
    for (const kind of identity.kind) {
      assert.equal(allowed.has(kind), true, `${id} déclare un kind inconnu : ${kind}`);
    }
  }
});

test('every catalogue module has a gallery picto, served as an SVG data URL', () => {
  assert.deepEqual(Object.keys(BUNDLED_ICONS).sort(), CATALOG.map((m) => m.id).sort());
  for (const [id, body] of Object.entries(BUNDLED_ICONS)) {
    // A mask loads nothing external and runs nothing: a body is plain shapes.
    assert.doesNotMatch(body, /<script|href|url\(|<text|on\w+=/i, id);
    assert.equal(toPublicBundled({ id, tier: 'std', active: true, reason: null, missing: [], wanted: 'auto' }).icon, bundledIconUrl(id));
  }
  assert.match(bundledIconUrl('@rooks/agent-chat') ?? '', /^data:image\/svg\+xml,%3Csvg/);
  assert.equal(bundledIconUrl('@rooks/absent'), null);
});

test('ui-layout déclare côté daemon exactement les prises que l’app ouvre au démarrage', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { join } = await import('node:path');
  const appHost = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'app', 'src', 'lib', 'plugin-host');
  const block = (file: string, start: string): string => {
    const source = readFileSync(join(appHost, file), 'utf8');
    const from = source.indexOf(start);
    assert.notEqual(from, -1, `${start} not found in ${file}`);
    return source.slice(from, source.indexOf('\n};', from));
  };
  const expected: Record<string, string> = {};
  for (const m of block('ui-layout.tsx', 'export const UI_LAYOUT_CHILD_SLOTS').matchAll(/^\s*'?([a-z][\w.]*)'?:\s*'(single|list|keyed)'/gm)) {
    expected[m[1]!] = m[2]!;
  }
  for (const m of block('settings-slots.ts', 'SETTINGS_GROUP_TO_SLOT').matchAll(/:\s*'(settings\.[a-z]+)'/g)) {
    expected[m[1]!] = 'list';
  }
  assert.equal(expected['nav.footer'], 'list');
  assert.equal(expected['dictation.engine'], 'keyed');
  assert.deepEqual(
    Object.fromEntries(Object.entries(bundledIdentity('@rooks/ui-layout').declares).sort(([a], [b]) => a.localeCompare(b))),
    Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b))),
  );
});
