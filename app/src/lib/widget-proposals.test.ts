/**
 * Applying an agent's proposal with the drag's own model. What breaks
 * silently here: a card dropped instead of sent to the widget window, a closed
 * tab that takes its cards with it, an absent plugin's placement lost, a new
 * tab that never receives the cards meant for it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ContraintesWidget, WidgetLayout } from '@/components/widget-host/widget-layout';
import type { EntreeCatalogue } from '@/components/widget-host/widget-catalog';
import { applyWidgetsProposal, buildWidgetSnapshot, newTabZones, parseWidgetsProposal } from './widget-proposals';

const c = (id: string, railDefaut = 'chat.right.widget'): ContraintesWidget =>
  ({ id, hauteurDefaut: 200, hauteurMin: 100, railDefaut, rangDefaut: 0 });
const GIT = 'plugin:@timon/git:Git';
const MISSIONS = 'plugin:@timon/missions:Missions';
const FILES = 'plugin:@timon/files-widget:Files';
const constraints = [c(GIT), c(MISSIONS, 'chat.left.widget'), c(FILES, 'chat.left.widget')];

const row = (id: string, rail: string, rang: number, extra: Partial<WidgetLayout> = {}): WidgetLayout =>
  ({ id, rail, rang, hauteur: 200, ...extra });

function placed(widgets: unknown[], zone: string): string[] {
  return (widgets as WidgetLayout[]).filter((w) => !w.removed && w.rail === zone).sort((a, b) => a.rang - b.rang).map((w) => w.id);
}

test('a listed zone holds exactly its cards; one left out goes to the widget window', () => {
  const { widgets } = applyWidgetsProposal({
    proposal: { view: '/chat', zones: { 'chat.left.widget': [GIT, MISSIONS] } },
    widgetsRaw: [row(MISSIONS, 'chat.left.widget', 0), row(FILES, 'chat.left.widget', 1), row(GIT, 'chat.right.widget', 0)],
    columnsRaw: null,
    constraints,
    suffix: (n) => `t${n}`,
  });
  assert.deepEqual(placed(widgets, 'chat.left.widget'), [GIT, MISSIONS]);
  assert.deepEqual(placed(widgets, 'chat.right.widget'), []);
  assert.equal((widgets as WidgetLayout[]).find((w) => w.id === FILES)?.removed, true, 'removed, not forgotten');
});

test('a placement of an absent plugin survives, and a card this browser lacks is reported', () => {
  const ghost = row('plugin:acme-crm:deals', 'gauche', 0);
  const out = applyWidgetsProposal({
    proposal: { view: '/chat', zones: { 'chat.right.widget': [GIT, 'plugin:acme-crm:other'] } },
    widgetsRaw: [row(GIT, 'chat.left.widget', 0), ghost],
    columnsRaw: null,
    constraints,
    suffix: (n) => `t${n}`,
  });
  assert.ok((out.widgets as WidgetLayout[]).some((w) => w.id === ghost.id), 'an orphan placement is written back');
  assert.deepEqual(out.missing, ['plugin:acme-crm:other']);
  assert.deepEqual(placed(out.widgets, 'chat.right.widget'), [GIT]);
});

test('a new tab is opened, named, shown, and receives the cards meant for it', () => {
  const out = applyWidgetsProposal({
    proposal: {
      view: '/chat',
      zones: { 'new:1': [GIT] },
      columns: {
        tabs: { 'chat.right.widget': ['new:1'] },
        active: { 'chat.right.widget': 'new:1' },
        names: { 'new:1': 'Ops' },
        widths: { 'new:1': 360 },
        order: ['chat.right.widget', 'chat.left.widget'],
      },
    },
    widgetsRaw: [row(GIT, 'chat.right.widget', 0)],
    columnsRaw: null,
    constraints,
    suffix: (n) => `abc${n}`,
  });
  const tab = 'chat.right.widget#abc1';
  assert.deepEqual(out.columns?.onglets, { 'chat.right.widget': [tab] });
  assert.equal(out.columns?.actifs?.['chat.right.widget'], tab);
  assert.equal(out.columns?.noms?.[tab], 'Ops');
  assert.equal(out.columns?.largeurs?.[tab], 360);
  assert.deepEqual(out.columns?.ordre, ['chat.right.widget', 'chat.left.widget']);
  assert.deepEqual(placed(out.widgets, tab), [GIT]);
});

test('a tab left out of the list is closed and its cards are poured into its column', () => {
  const tab = 'chat.left.widget#old';
  const out = applyWidgetsProposal({
    proposal: { view: '/chat', columns: { tabs: { 'chat.left.widget': [] } } },
    widgetsRaw: [row(MISSIONS, 'chat.left.widget', 0), row(FILES, tab, 0)],
    columnsRaw: { ordre: ['chat.left.widget', 'chat.right.widget'], masquees: [], onglets: { 'chat.left.widget': [tab] }, actifs: { 'chat.left.widget': tab }, noms: { [tab]: 'Old' } },
    constraints,
    suffix: (n) => `t${n}`,
  });
  assert.equal(out.columns?.onglets, undefined);
  assert.equal(out.columns?.actifs, undefined);
  assert.equal(out.columns?.noms, undefined, 'the name leaves with its tab');
  assert.deepEqual(placed(out.widgets, 'chat.left.widget'), [MISSIONS, FILES]);
});

test('columns are left alone off the chat, and null resets a width or a second column', () => {
  const off = applyWidgetsProposal({
    proposal: { view: '/', columns: { hidden: ['chat.left.widget'] } },
    widgetsRaw: null, columnsRaw: null, constraints, suffix: (n) => `t${n}`,
  });
  assert.equal(off.columns, null);
  const tab = 'chat.right.widget#s';
  const reset = applyWidgetsProposal({
    proposal: { view: '/chat', columns: { widths: { 'chat.right.widget': null }, second: { 'chat.right.widget': null } } },
    widgetsRaw: null,
    columnsRaw: { ordre: [], masquees: [], onglets: { 'chat.right.widget': [tab] }, secondes: { 'chat.right.widget': tab }, largeurs: { 'chat.right.widget': 420 } },
    constraints, suffix: (n) => `t${n}`,
  });
  assert.equal(reset.columns?.largeurs, undefined);
  assert.equal(reset.columns?.secondes, undefined);
  assert.deepEqual(reset.columns?.onglets, { 'chat.right.widget': [tab] }, 'the second column folds back into the tabs');
});

test('the stored payload is parsed defensively, and new tab refs map to their column', () => {
  assert.equal(parseWidgetsProposal({ zones: {} }), null);
  const p = parseWidgetsProposal({ view: '/chat', zones: { a: [GIT, 3] }, columns: { tabs: { 'chat.left.widget': ['new:2'] }, widths: { x: 'big' } } });
  assert.deepEqual(p?.zones, {});
  assert.deepEqual(p?.columns?.widths, {});
  assert.deepEqual([...newTabZones(p!, (n) => `z${n}`)], [['new:2', 'chat.left.widget#z2']]);
});

test('the snapshot keeps stable ids only, hides what the configuration hides, and carries the starters', () => {
  const entry = (id: string, extra: Partial<EntreeCatalogue> = {}): EntreeCatalogue => ({
    ...c(id), titre: id.split(':').pop()!, slots: ['chat.right.widget'], registrationId: `${id}:1`, pluginId: '@timon/x', ...extra,
  });
  const snap = buildWidgetSnapshot({
    entries: [entry(GIT), entry('@timon/x:3'), entry(MISSIONS, { bar: true, description: 'line\none' }), entry(FILES)],
    visible: (id) => id !== FILES,
    view: '/chat',
    zones: [{ id: 'chat.left.widget', slot: 'chat.left.widget' }, { id: 'bad zone', slot: 'x' }],
  });
  assert.deepEqual(snap.catalog.map((w) => w.id), [GIT, MISSIONS]);
  assert.equal(snap.catalog[1]?.description, 'line one');
  assert.deepEqual(Object.keys(snap.defaults), ['/', '/agents', '/chat']);
  assert.deepEqual(snap.view?.zones.map((z) => z.id), ['chat.left.widget']);
  assert.equal(buildWidgetSnapshot({ entries: [], visible: () => true, view: '/chat?x', zones: [] }).view, undefined);
  // A widget placed by default says where (TODO #479): the daemon puts it there
  // on a stored view that never named it, as the browser does.
  const bar = buildWidgetSnapshot({
    entries: [entry(GIT, { placedByDefault: true, railDefaut: 'topbar.center.widget' }), entry(MISSIONS)], visible: () => true, view: null, zones: [],
  });
  assert.deepEqual([bar.catalog[0]?.placedByDefault, bar.catalog[0]?.zone], [true, 'topbar.center.widget']);
  assert.equal('zone' in (bar.catalog[1] ?? {}), false);
});
