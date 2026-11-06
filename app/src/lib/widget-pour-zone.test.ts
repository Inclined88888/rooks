import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dockWidget, fusionnerLayout, retirerWidget, setWidgetHeightMode, verserZone,
  widgetStacks, widgetsDuRail, type ContraintesWidget, type WidgetLayout,
} from '../components/widget-host/widget-layout';

// Closing a chat column tab pours its cards into the first tab: stacks and
// height shares the user composed there must survive the trip.

const constraints: ContraintesWidget[] = ['a', 'b', 'c', 'd', 'e'].map((id, rangDefaut) => ({
  id, railDefaut: 'col', rangDefaut, hauteurDefaut: 200, hauteurMin: 100,
}));
const entry = (layout: WidgetLayout[], id: string) => layout.find((w) => w.id === id)!;
const ids = (layout: WidgetLayout[], zone: string) =>
  widgetStacks(widgetsDuRail(layout, zone)).map((group) => group.map((w) => w.id));

/** a, b in `col`; c, d, e in the tab `col#2`, c and d stacked, e filling a third. */
function setup(): WidgetLayout[] {
  let layout = fusionnerLayout(null, constraints).map((w) =>
    ['c', 'd', 'e'].includes(w.id) ? { ...w, rail: 'col#2' } : w);
  layout = dockWidget(layout, 'c', 'd');
  layout = setWidgetHeightMode(layout, 'e', 'fill', 33);
  return layout;
}

test('the cards of a closed tab land after those of the first one, in order', () => {
  const out = verserZone(setup(), 'col#2', 'col');
  assert.deepEqual(ids(out, 'col'), [['a'], ['b'], ['c', 'd'], ['e']]);
  assert.deepEqual(widgetsDuRail(out, 'col#2'), []);
  assert.deepEqual(widgetsDuRail(out, 'col').map((w) => w.rang), [0, 1, 2, 3, 4]);
});

test('a stack and a height share keep their shape', () => {
  const avant = setup();
  const out = verserZone(avant, 'col#2', 'col');
  assert.equal(entry(out, 'c').group, entry(avant, 'c').group);
  assert.equal(entry(out, 'c').activeTab, true);
  assert.equal(entry(out, 'e').heightMode, 'fill');
  assert.equal(entry(out, 'e').fillPercent, 33);
});

test('a stack name already used in the target zone is renamed, not merged', () => {
  let layout = setup();
  const group = entry(layout, 'c').group!;
  layout = layout.map((w) => (w.id === 'a' || w.id === 'b' ? { ...w, group, activeTab: w.id === 'a' } : w));
  const out = verserZone(layout, 'col#2', 'col');
  assert.deepEqual(ids(out, 'col'), [['a', 'b'], ['c', 'd'], ['e']]);
  assert.notEqual(entry(out, 'c').group, group);
  assert.equal(entry(out, 'c').group, entry(out, 'd').group);
});

test('a removed card keeps its zone, and an empty or identical zone changes nothing', () => {
  const layout = retirerWidget(setup(), 'e');
  const out = verserZone(layout, 'col#2', 'col');
  assert.equal(entry(out, 'e').removed, true);
  assert.equal(entry(out, 'e').rail, 'col#2');
  assert.equal(verserZone(layout, 'col', 'col'), layout);
  assert.equal(verserZone(layout, 'nowhere', 'col'), layout);
});
