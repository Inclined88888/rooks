import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deplacerWidget, dockWidget, fusionnerLayout, orphelins, selectWidgetTab,
  setWidgetHeightMode, type ContraintesWidget,
} from '../components/widget-host/widget-layout';
import { catalogueWidgets } from '../components/widget-host/widget-catalog';

const constraints: ContraintesWidget[] = [
  { id: 'chat', railDefaut: 'centre', rangDefaut: 0, hauteurDefaut: 520, hauteurMin: 280, heightMode: 'fill' },
  { id: 'clock', railDefaut: 'left', rangDefaut: 0, hauteurDefaut: 140, hauteurMin: 110 },
  { id: 'tasks', railDefaut: 'right', rangDefaut: 0, hauteurDefaut: 400, hauteurMin: 180 },
];
const base = () => fusionnerLayout(null, constraints);

test('legacy chat layouts adopt fill while explicit fixed choices and their pixel height survive reload', () => {
  const legacy = [{ id: 'chat', rail: 'left', rang: 2, hauteur: 637 }];
  const migrated = fusionnerLayout(legacy, constraints);
  assert.equal(migrated.find(w => w.id === 'chat')?.heightMode, 'fill');
  assert.equal(migrated.find(w => w.id === 'chat')?.rail, 'left');
  const fixed = setWidgetHeightMode(migrated, 'chat', 'fixed');
  const loaded = fusionnerLayout(JSON.parse(JSON.stringify(fixed)), constraints);
  assert.equal(loaded.find(w => w.id === 'chat')?.heightMode, 'fixed');
  assert.equal(loaded.find(w => w.id === 'chat')?.hauteur, 637);
  assert.equal(loaded.find(w => w.id === 'clock')?.heightMode, undefined);
});

test('docking adopts the destination sizing and changing it affects the entire stack across tab switches', () => {
  const docked = dockWidget(base(), 'chat', 'tasks');
  assert.equal(docked.find(w => w.id === 'chat')?.heightMode, 'fixed');
  const filled = setWidgetHeightMode(docked, 'tasks', 'fill');
  const loaded = fusionnerLayout(JSON.parse(JSON.stringify(selectWidgetTab(filled, 'tasks'))), constraints);
  for (const id of ['chat', 'tasks']) assert.equal(loaded.find(w => w.id === id)?.heightMode, 'fill');
  const detached = deplacerWidget(loaded, 'chat', 'left', null);
  assert.equal(detached.find(w => w.id === 'chat')?.heightMode, 'fill');
  assert.equal(detached.find(w => w.id === 'tasks')?.heightMode, 'fill');
  assert.equal(detached.find(w => w.id === 'clock')?.heightMode, undefined);
});

test('legacy groups with different widget defaults keep one sizing mode when changing tabs', () => {
  const legacy = base().map(w => w.id === 'clock' ? w : { ...w, rail: 'right', group: 'old', heightMode: undefined, activeTab: w.id === 'tasks' });
  const loaded = fusionnerLayout(legacy, constraints);
  const switched = fusionnerLayout(selectWidgetTab(loaded, 'chat'), constraints);
  assert.equal(switched.find(w => w.id === 'chat')?.heightMode, loaded.find(w => w.id === 'tasks')?.heightMode);
  assert.equal(switched.find(w => w.id === 'chat')?.heightMode, switched.find(w => w.id === 'tasks')?.heightMode);
});

test('temporarily missing plugins retain sizing and malformed values are ignored', () => {
  const raw = [{ id: 'missing', rail: 'left', rang: 0, hauteur: 280, heightMode: 'fill' }];
  assert.equal(orphelins(raw, constraints)[0]?.heightMode, 'fill');
  const bad = base().map(w => ({ ...w, heightMode: 'bogus' }));
  const loaded = fusionnerLayout(bad, constraints);
  assert.equal(loaded.find(w => w.id === 'chat')?.heightMode, 'fill');
  assert.equal(loaded.find(w => w.id === 'clock')?.heightMode, undefined);
});

test('third-party widget sizing preferences reach the placement defaults', () => {
  const catalogue = catalogueWidgets([], [{
    registrationId: 'test:1', pluginId: 'test', slot: 'cockpit.widget',
    options: { heightMode: 'fill', height: 500, minHeight: 200 },
  }]);
  assert.equal(fusionnerLayout(null, catalogue)[0]?.heightMode, 'fill');
});

test('a fill share travels with the stack, survives a reload and never persists its default', () => {
  const half = setWidgetHeightMode(base(), 'chat', 'fill', 50);
  assert.equal(half.find(w => w.id === 'chat')?.fillPercent, 50);
  const loaded = fusionnerLayout(JSON.parse(JSON.stringify(half)), constraints);
  assert.equal(loaded.find(w => w.id === 'chat')?.fillPercent, 50);
  // Le défaut ne s'écrit pas : 100 % laisse le champ absent.
  assert.equal(setWidgetHeightMode(loaded, 'chat', 'fill', 100).find(w => w.id === 'chat')?.fillPercent, undefined);
  // Repasser en hauteur fixe oublie la part plutôt que de la garder en dormance.
  assert.equal(setWidgetHeightMode(half, 'chat', 'fixed').find(w => w.id === 'chat')?.fillPercent, undefined);
  // Une pile a une seule part : l'accostage adopte celle de la cible.
  const stack = dockWidget(half, 'tasks', 'chat');
  for (const id of ['chat', 'tasks']) assert.equal(stack.find(w => w.id === id)?.fillPercent, 50);
});

test('an absurd fill share is ignored rather than shrinking a widget to nothing', () => {
  const raw = [{ id: 'chat', rail: 'left', rang: 0, hauteur: 300, heightMode: 'fill', fillPercent: 0 }];
  assert.equal(fusionnerLayout(raw, constraints).find(w => w.id === 'chat')?.fillPercent, undefined);
  const huge = [{ id: 'chat', rail: 'left', rang: 0, hauteur: 300, heightMode: 'fill', fillPercent: 900 }];
  assert.equal(fusionnerLayout(huge, constraints).find(w => w.id === 'chat')?.fillPercent, undefined);
});
