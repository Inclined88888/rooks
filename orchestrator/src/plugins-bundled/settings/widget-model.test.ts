/**
 * The daemon's half of the widget arrangement: the scope hash it shares with
 * the app, and the validation every proposal goes through before a card is
 * shown. The refusals matter most: an unknown zone, a widget of a plugin the
 * owner was not granted, a card without a compact form in the top bar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureRows,
  mergeSnapshot,
  pluginOfWidget,
  placementsOf,
  readColumns,
  readPresets,
  readSnapshot,
  savePreset,
  sharedPresetsKey,
  SnapshotBody,
  validateWidgetsProposal,
  visibleCatalog,
  WidgetsProposal,
  workspaceKey,
  zonesOfView,
  type StoredSnapshot,
} from './widget-model.js';

/** Same vectors as `app/src/lib/workspace-scope.test.ts`: a drift on either side reads another account's rows. */
test('the scope hash matches the app, vector for vector', () => {
  assert.equal(workspaceKey('user-1', '/chat', 'rooks'), 'v2.8291cf877624b87afd146a96827a920d843da0cd');
  assert.equal(workspaceKey('user-1', '/', null), 'v2.487f3eb51e8412ef2ba2c1c58bb149023be5c862');
  assert.equal(sharedPresetsKey('user-1', '/'), 'v2.487f3eb51e8412ef2ba2c1c58bb149023be5c862.shared-presets');
});

test('a widget\'s plugin is read from its id, never from what the browser says', () => {
  assert.equal(pluginOfWidget('plugin:@rooks/git:Git'), '@rooks/git');
  assert.equal(pluginOfWidget('plugin:@rooks/agent-chat:main:card'), '@rooks/agent-chat');
  assert.equal(pluginOfWidget('plugin:acme-crm'), 'acme-crm');
  assert.equal(pluginOfWidget('@rooks/git:3'), null, 'a registration id is not stable');
  assert.equal(pluginOfWidget('plugin:../x'), null);
});

const catalog: SnapshotBody['catalog'] = [
  { id: 'plugin:@rooks/git:Git', title: 'Git', pluginId: '@rooks/git', slots: ['chat.right.widget'] },
  { id: 'plugin:@rooks/missions:Missions', title: 'Missions', pluginId: '@rooks/missions', slots: ['chat.left.widget'] },
  { id: 'plugin:@rooks/notifications', title: 'Bell', pluginId: '@rooks/notifications', slots: ['topbar.widget'], bar: true },
  { id: 'plugin:acme-crm:deals', title: 'Deals', pluginId: 'acme-crm', slots: ['cockpit.widget'] },
  // Claims another plugin than its id: dropped from what the agent sees.
  { id: 'plugin:acme-crm:liar', title: 'Liar', pluginId: '@rooks/git', slots: ['cockpit.widget'] },
];
const snapshot: StoredSnapshot = mergeSnapshot(null, {
  catalog,
  defaults: { '/chat': [{ id: 'plugin:@rooks/missions:Missions', zone: 'chat.left.widget', rank: 0 }] },
  view: { path: '/chat', zones: [{ id: 'chat.left.widget', slot: 'chat.left.widget' }] },
}, 1000);
const granted = (plugin: string) => plugin !== 'acme-crm';

test('the snapshot round-trips through its schema, and a hand-written row reads as absent', () => {
  assert.deepEqual(readSnapshot(JSON.stringify(snapshot)), snapshot);
  assert.equal(readSnapshot('{"catalog": "nope"}'), null);
  assert.equal(readSnapshot('not json'), null);
  assert.equal(SnapshotBody.safeParse({ catalog: [{ id: 'x', title: 'a\nb', slots: [] }] }).success, false);
});

test('a later publication keeps the zones of the other views', () => {
  const next = mergeSnapshot(snapshot, { catalog, view: { path: '/', zones: [{ id: 'gauche', slot: 'cockpit.widget' }] } }, 2000);
  assert.deepEqual(Object.keys(next.views).sort(), ['/', '/chat']);
  assert.deepEqual(next.defaults, snapshot.defaults, 'defaults survive a publication without them');
});

test('the catalog an agent sees is filtered by the owner\'s grants', () => {
  assert.deepEqual(visibleCatalog(snapshot, granted).map((w) => w.id), [
    'plugin:@rooks/git:Git', 'plugin:@rooks/missions:Missions', 'plugin:@rooks/notifications',
  ]);
});

test('placements come from the stored row, else from the starters the browser published', () => {
  const stored = [
    { id: 'plugin:@rooks/git:Git', rail: 'chat.right.widget', rang: 0, hauteur: 200 },
    { id: 'plugin:@rooks/missions:Missions', rail: 'chat.left.widget', rang: 0, hauteur: 200, removed: true },
  ];
  const fromRow = placementsOf(stored, snapshot.defaults['/chat'], visibleCatalog(snapshot, granted));
  assert.deepEqual([...fromRow.byZone.keys()], ['chat.right.widget']);
  assert.ok(fromRow.removed.includes('plugin:@rooks/missions:Missions'));
  const fromDefaults = placementsOf(null, snapshot.defaults['/chat'], visibleCatalog(snapshot, granted));
  assert.equal(fromDefaults.known, true);
  assert.deepEqual(fromDefaults.byZone.get('chat.left.widget')?.map((w) => w.id), ['plugin:@rooks/missions:Missions']);
  assert.equal(placementsOf(null, undefined, []).known, false);
});

// TODO #479: the top bar's agent tabs became a widget placed by default. A view
// stored before never names it, and the browser shows it in the bar: the agent
// must read the same, not "in the palette". An explicit removal still wins.
test('a widget placed by default sits in its zone on a stored row that never named it', () => {
  const working = 'plugin:@rooks/agents:working';
  const withWorking: StoredSnapshot['catalog'] = [
    ...visibleCatalog(snapshot, granted),
    { id: working, title: 'Working agents', pluginId: '@rooks/agents', slots: ['cockpit.widget'], bar: true, placedByDefault: true, zone: 'topbar.center.widget' },
  ];
  assert.equal(SnapshotBody.safeParse({ catalog: withWorking }).success, true);
  assert.equal(SnapshotBody.safeParse({ catalog: [{ ...withWorking.at(-1)!, zone: '../x' }] }).success, false);
  const before479 = [
    { id: 'plugin:@rooks/git:Git', rail: 'chat.right.widget', rang: 0, hauteur: 200 },
    { id: 'plugin:@rooks/agents:team', rail: 'chat.right.widget#k1', rang: 1, hauteur: 300 },
  ];
  const read = placementsOf(before479, snapshot.defaults['/chat'], withWorking);
  assert.deepEqual(read.byZone.get('topbar.center.widget')?.map((w) => w.id), [working]);
  assert.ok(!read.removed.includes(working));
  const removed = placementsOf([...before479, { id: working, rail: 'topbar.center.widget', rang: 0, hauteur: 300, removed: true }], undefined, withWorking);
  assert.equal(removed.byZone.get('topbar.center.widget'), undefined);
  assert.ok(removed.removed.includes(working), 'removed by hand after #479: back in the palette');
  const moved = placementsOf([{ id: working, rail: 'sidebar.left.widget', rang: 0, hauteur: 300 }], undefined, withWorking);
  assert.deepEqual(moved.byZone.get('sidebar.left.widget')?.map((w) => w.id), [working], 'a place given by hand is kept');
});

test('columns are read with the chat\'s own field names, tabs only under their column', () => {
  const columns = readColumns({
    ordre: ['chat.right.widget', 'chat.left.widget'],
    masquees: ['chat.left.widget'],
    onglets: { 'chat.right.widget': ['chat.right.widget#k1', 'chat.left.widget#x'] },
    actifs: { 'chat.right.widget': 'chat.right.widget#k1' },
    largeurs: { 'chat.right.widget#k1': 320, ghost: 300 },
    noms: { 'chat.right.widget#k1': 'Ops' },
  });
  assert.deepEqual(columns.order, ['chat.right.widget', 'chat.left.widget']);
  assert.deepEqual(columns.tabs, { 'chat.right.widget': ['chat.right.widget#k1'] });
  assert.deepEqual(columns.widths, { 'chat.right.widget#k1': 320 });
  assert.deepEqual(columns.names, { 'chat.right.widget#k1': 'Ops' });
  assert.ok(zonesOfView('/chat', snapshot, columns).some((z) => z.id === 'chat.right.widget#k1'));
});

const check = (raw: unknown, columns = readColumns(null)) => {
  const parsed = WidgetsProposal.parse(raw);
  return validateWidgetsProposal(parsed, { snapshot, columns, allowed: granted }).map((p) => p.code);
};

test('a proposal on known zones with granted widgets passes', () => {
  assert.deepEqual(check({
    view: '/chat',
    zones: { 'chat.left.widget': ['plugin:@rooks/git:Git', 'plugin:@rooks/missions:Missions'], 'new:1': [] },
    columns: { tabs: { 'chat.right.widget': ['new:1'] }, active: { 'chat.right.widget': 'new:1' }, widths: { 'new:1': 360 }, names: { 'new:1': 'Ops' } },
  }), []);
  assert.deepEqual(check({ view: '/chat', zones: { 'topbar.widget': ['plugin:@rooks/notifications'] } }), []);
  assert.deepEqual(check({ view: '/', zones: { 'topbar.center.widget': ['plugin:@rooks/notifications'] } }), [], 'the middle of the top bar, on every view');
});

test('a widget of a plugin the owner was not granted is refused', () => {
  assert.deepEqual(check({ view: '/', zones: { gauche: ['plugin:acme-crm:deals'] } }), ['unknown_widget']);
});

test('unknown zones, unknown widgets, duplicates and non-compact bar cards are refused', () => {
  assert.deepEqual(check({ view: '/', zones: { nowhere: ['plugin:@rooks/git:Git'] } }), ['unknown_zone']);
  assert.deepEqual(check({ view: '/', zones: { gauche: ['plugin:@rooks/ghost'] } }), ['unknown_widget']);
  assert.deepEqual(check({ view: '/', zones: { gauche: ['plugin:@rooks/git:Git'], droite: ['plugin:@rooks/git:Git'] } }), ['duplicate_widget']);
  assert.deepEqual(check({ view: '/', zones: { 'topbar.widget': ['plugin:@rooks/git:Git'] } }), ['not_compact']);
  assert.deepEqual(check({ view: '/', zones: { 'topbar.center.widget': ['plugin:@rooks/git:Git'] } }), ['not_compact']);
  assert.deepEqual(check({ view: '/', remove: ['plugin:@rooks/git:Git'], zones: { gauche: ['plugin:@rooks/git:Git'] } }), ['duplicate_widget']);
  assert.deepEqual(check({ view: '/elsewhere', zones: {} }), ['unknown_view']);
});

test('columns are a /chat matter, and tabs must exist where they are named', () => {
  assert.deepEqual(check({ view: '/', columns: { hidden: ['chat.left.widget'] } }), ['columns_outside_chat']);
  assert.deepEqual(check({ view: '/chat', columns: { active: { 'chat.left.widget': 'chat.left.widget#nope' } } }), ['unknown_tab']);
  assert.deepEqual(check({ view: '/chat', columns: { tabs: { 'chat.left.widget': ['chat.right.widget#k1'] } } }, readColumns({
    onglets: { 'chat.right.widget': ['chat.right.widget#k1'] },
  })), ['unknown_tab']);
  assert.deepEqual(check({ view: '/chat', zones: { 'new:2': [] } }), ['unknown_zone'], 'a new tab must be opened by the proposal');
});

test('the schema bounds widths and names, and refuses extra fields', () => {
  assert.equal(WidgetsProposal.safeParse({ view: '/chat', columns: { widths: { 'chat.left.widget': 100 } } }).success, false);
  assert.equal(WidgetsProposal.safeParse({ view: '/chat', columns: { names: { 'chat.left.widget': 'x'.repeat(41) } } }).success, false);
  assert.equal(WidgetsProposal.safeParse({ view: '/chat', extra: 1 }).success, false);
  assert.equal(WidgetsProposal.safeParse({ view: '/chat?agent=x' }).success, false);
});

test('without a snapshot nothing can be checked, so nothing is proposed', () => {
  const parsed = WidgetsProposal.parse({ view: '/', zones: {} });
  assert.deepEqual(validateWidgetsProposal(parsed, { snapshot: null, columns: null, allowed: granted }).map((p) => p.code), ['no_snapshot']);
});

test('presets: capture skips the preset rows and the rail\'s leftover, save refuses a duplicate unless asked to replace', () => {
  const rows = [
    { scope: 'v2.k.widgets', value: '[1]' },
    { scope: 'v2.k.presets', value: '{}' },
    { scope: 'v2.k.shared-presets', value: '{}' },
    { scope: 'v2.k.nav', value: '{"pinned":true}' },
    { scope: 'v2.k.columns', value: '{"ordre":[]}' },
  ];
  assert.deepEqual(captureRows('v2.k.', rows), { widgets: [1], columns: { ordre: [] } });
  const first = savePreset([], '  Focus  mode ', { widgets: [1] }, { replace: false, id: 'a', now: 5 });
  assert.ok(first.ok);
  assert.equal(first.preset.name, 'Focus mode');
  const dup = savePreset(first.presets, 'FOCUS MODE', {}, { replace: false, id: 'b', now: 6 });
  assert.deepEqual(dup, { ok: false, error: 'duplicate-name' });
  const replaced = savePreset(first.presets, 'focus mode', { widgets: [2] }, { replace: true, id: 'b', now: 6 });
  assert.ok(replaced.ok && replaced.replaced);
  assert.equal(replaced.preset.id, 'a');
  assert.deepEqual(readPresets({ v: 1, presets: [...replaced.presets, { id: '', name: 'bad', scopes: {} }] }).length, 1);
  const full = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `n${i}`, createdAt: 0, scopes: {} }));
  assert.deepEqual(savePreset(full, 'thirteenth', {}, { replace: false, id: 'z', now: 0 }), { ok: false, error: 'too-many' });
});
