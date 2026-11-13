/**
 * Every arrangement an onboarding tour proposes passes the daemon's own checks,
 * as its route would run them: the schema, then the validator against a
 * catalog that mirrors the product's (the real widget ids, the real island
 * types and the params they declare). A recipe that drifts fails here, not on
 * a tester's screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ONBOARDING_RECIPES, RECIPE_PLACEHOLDERS, fillRecipe, recipesFor, renderRecipes } from './onboarding-recipes.js';
import { IslandsProposal, readStoredTree, validateIslandsProposal, type StoredIslandSnapshot } from './plugins-bundled/settings/island-model.js';
import { mergeSnapshot, validateWidgetsProposal, WidgetsProposal, type SnapshotBody } from './plugins-bundled/settings/widget-model.js';
import { NavProposal, validateNavProposal } from './plugins-bundled/settings/nav-model.js';

const VALUES: Record<string, string> = {
  '<project>': 'rooks-demo',
  '<chat-agent>': 'rooks-demo.coder',
  '<other-agent>': 'assistant.mails',
};

/** The island types as the browser declares them (`app/src/plugins-client/*`). */
const islandSnapshot: StoredIslandSnapshot = {
  at: 1,
  types: [
    { type: '@rooks/terminal-web:session', title: 'Terminal', params: {
      sessionId: { type: 'string', maxLength: 128 },
      scope: { type: 'string', nullable: true, maxLength: 210 },
      fresh: { type: 'boolean' },
    } },
    { type: '@rooks/browser-embedded:view', title: 'Embedded browser', params: {
      agent: { type: 'string', required: true, maxLength: 128 },
      mission: { type: 'string', nullable: true, maxLength: 64 },
      display: { type: 'string', enum: ['auto', 'mobile', 'desktop'] },
    } },
    { type: '@rooks/missions:chat', title: 'Chat', params: {
      agent: { type: 'string', required: true, maxLength: 128 },
      missionId: { type: 'string', nullable: true, maxLength: 128 },
      fresh: { type: 'boolean' },
    } },
    { type: '@rooks/ui-layout:widget-card', title: 'Widget', params: {
      widget: { type: 'string', required: true, maxLength: 200 },
    } },
    { type: '@rooks/ui-layout:widget-zone', title: 'Widgets', params: {} },
  ],
};

const WIDGETS = [
  'plugin:@rooks/agents:team', 'plugin:@rooks/agents:notifications', 'plugin:@rooks/agents:tasks',
  'plugin:@rooks/missions:recent', 'plugin:@rooks/missions:Missions',
  'plugin:@rooks/projects:overview', 'plugin:@rooks/kanban:todo', 'plugin:@rooks/kanban:project-todo',
  'plugin:@rooks/workflows:trace', 'plugin:@rooks/files-widget:Files', 'plugin:@rooks/git:repository',
  'plugin:@rooks/grepai:grepai',
];
// Checked against a live `widgets_get` (15/10/2026): each of these exists, and
// like every non-compact widget of the product it admits every vertical zone —
// the cockpit's columns and the chat's alike. The slots below are that reality.
const catalog: SnapshotBody['catalog'] = WIDGETS.map((id) => ({
  id,
  title: id,
  pluginId: id.split(':')[1]!.replace(/^(@[^/]+\/[^:]+).*$/, '$1'),
  slots: ['cockpit.widget', 'chat.left.widget', 'chat.right.widget'],
}));
const withCockpit = mergeSnapshot(null, {
  catalog,
  view: { path: '/', zones: ['gauche', 'centre', 'droite'].map((id) => ({ id, slot: 'cockpit.widget' })) },
}, 1);
const widgetSnapshot = mergeSnapshot(withCockpit, {
  catalog,
  view: { path: '/chat', zones: [{ id: 'chat.left.widget', slot: 'chat.left.widget' }, { id: 'chat.right.widget', slot: 'chat.right.widget' }] },
}, 2);

/** What the routes do with `project: ""`: no project. */
function asRouteReads(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.project === '' ? { ...payload, project: null } : payload;
}

for (const recipe of ONBOARDING_RECIPES) {
  test(`${recipe.id} passes the ${recipe.tool} checks`, () => {
    const filled = asRouteReads(fillRecipe(recipe.payload, VALUES) as Record<string, unknown>);
    assert.ok(!JSON.stringify(filled).includes('<'), 'every placeholder is filled');
    if (recipe.tool === 'islands_propose') {
      const parsed = IslandsProposal.safeParse(filled);
      assert.ok(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues));
      const v = validateIslandsProposal(parsed.data, { snapshot: islandSnapshot, current: readStoredTree(null), allowed: () => true });
      assert.deepEqual(v.problems, []);
      assert.deepEqual(v.warnings, []);
    } else if (recipe.tool === 'widgets_propose') {
      const parsed = WidgetsProposal.safeParse(filled);
      assert.ok(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues));
      assert.deepEqual(validateWidgetsProposal(parsed.data, { snapshot: widgetSnapshot, columns: null, allowed: () => true }), []);
    } else {
      const parsed = NavProposal.safeParse(filled);
      assert.ok(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues));
      assert.deepEqual(validateNavProposal(parsed.data), { problems: [], warnings: [] });
    }
  });
}

test('ids are unique, every profile has its list, every placeholder is documented', () => {
  assert.equal(new Set(ONBOARDING_RECIPES.map((r) => r.id)).size, ONBOARDING_RECIPES.length);
  for (const profile of ['developer', 'automation', 'beginner'] as const) assert.ok(recipesFor(profile).length >= 2, profile);
  for (const r of ONBOARDING_RECIPES) {
    for (const p of JSON.stringify(r.payload).match(/<[a-z-]+>/g) ?? []) assert.ok(p in RECIPE_PLACEHOLDERS, `${r.id}: ${p}`);
    assert.ok(r.id.startsWith(`${r.profile}.`), r.id);
  }
});

test('the rendered section carries each payload exactly as tested', () => {
  for (const profile of ['developer', 'automation', 'beginner'] as const) {
    const text = renderRecipes(profile);
    for (const r of recipesFor(profile)) assert.ok(text.includes(JSON.stringify(r.payload)), r.id);
  }
});

test('placeholders are replaced inside strings and keys alike', () => {
  assert.deepEqual(fillRecipe({ scope: 'project:<project>', list: ['<project>'] }, VALUES), { scope: 'project:rooks-demo', list: ['rooks-demo'] });
});

test('the harness does catch a broken arrangement', () => {
  const widgets = WidgetsProposal.safeParse({ view: '/', zones: { centre: ['plugin:@rooks/nope:gone'] } });
  assert.ok(widgets.success);
  assert.notDeepEqual(validateWidgetsProposal(widgets.data, { snapshot: widgetSnapshot, columns: null, allowed: () => true }), []);
  const islands = IslandsProposal.safeParse({ view: '/chat', open: { content: { type: '@rooks/terminal-web:session', params: { scope: 'project:x', fresh: 'yes' } }, edge: 'bottom' } });
  assert.ok(islands.success);
  assert.notDeepEqual(validateIslandsProposal(islands.data, { snapshot: islandSnapshot, current: readStoredTree(null), allowed: () => true }).problems, []);
});
