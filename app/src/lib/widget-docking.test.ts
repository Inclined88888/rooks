import assert from 'node:assert/strict';
import test from 'node:test';
import {
  coteInsertion, deplacerOnglet, deplacerWidget, dockWidget, fusionnerLayout, placerEnFinDePile, remettreWidget, retirerWidget, remplacerWidget, selectWidgetTab,
  widgetStacks, widgetsDuRail, type ContraintesWidget, type WidgetLayout,
} from '../components/widget-host/widget-layout';

const constraints: ContraintesWidget[] = ['a', 'b', 'c', 'd', 'e'].map((id, rangDefaut) => ({
  id, railDefaut: 'left', rangDefaut, hauteurDefaut: 200, hauteurMin: 100,
}));
const base = () => fusionnerLayout(null, constraints);
const stacks = (layout: WidgetLayout[], zone = 'left') =>
  widgetStacks(widgetsDuRail(layout, zone)).map((group) => group.map((w) => w.id));
const entry = (layout: WidgetLayout[], id: string) => layout.find((w) => w.id === id)!;

test('docking creates a selected tab and keeps independent widgets below the stack', () => {
  const layout = dockWidget(base(), 'a', 'b');
  assert.deepEqual(stacks(layout), [['a', 'b'], ['c'], ['d'], ['e']]);
  assert.equal(entry(layout, 'a').group, entry(layout, 'b').group);
  assert.equal(entry(layout, 'a').activeTab, true);
  assert.equal(entry(layout, 'b').activeTab, false);
  assert.equal(entry(layout, 'a').hauteur, entry(layout, 'b').hauteur);
});

test('detaching the founding tab dissolves its former singleton without collecting it again', () => {
  let layout = dockWidget(base(), 'a', 'b');
  layout = deplacerWidget(layout, 'b', 'left', null);
  assert.equal(entry(layout, 'a').group, undefined);
  assert.equal(entry(layout, 'a').activeTab, undefined);
  layout = dockWidget(layout, 'c', 'b');
  assert.deepEqual(stacks(layout), [['a'], ['d'], ['e'], ['c', 'b']]);
});

test('new stacks cannot collect the detached founders surviving multi-tab siblings', () => {
  let layout = dockWidget(dockWidget(base(), 'a', 'b'), 'c', 'b');
  const oldGroup = entry(layout, 'b').group;
  layout = deplacerWidget(layout, 'b', 'left', null);
  layout = dockWidget(layout, 'd', 'b');
  assert.equal(entry(layout, 'a').group, oldGroup);
  assert.equal(entry(layout, 'c').group, oldGroup);
  assert.notEqual(entry(layout, 'd').group, oldGroup);
  assert.deepEqual(stacks(layout), [['c', 'a'], ['e'], ['d', 'b']]);
});

test('legacy group identities cannot collide when their original tab forms a new stack', () => {
  const layout = base().map((w) => ['a', 'c'].includes(w.id) ? { ...w, group: 'b' } : w);
  const result = dockWidget(layout, 'd', 'b');
  assert.deepEqual(stacks(result), [['a', 'c'], ['d', 'b'], ['e']]);
  assert.notEqual(entry(result, 'b').group, 'b');
});

test('removing an active tab selects a sibling, then dissolves the final singleton', () => {
  let layout = dockWidget(dockWidget(base(), 'a', 'b'), 'c', 'b');
  layout = retirerWidget(layout, 'c');
  assert.equal(entry(layout, 'a').activeTab, true);
  assert.equal(entry(layout, 'b').activeTab, false);
  assert.equal(entry(layout, 'c').removed, true);
  assert.equal(entry(layout, 'c').group, undefined);
  layout = retirerWidget(layout, 'a');
  assert.equal(entry(layout, 'b').group, undefined);
  assert.equal(entry(layout, 'b').activeTab, undefined);
  const restored = deplacerWidget(layout, 'c', 'left', null);
  assert.deepEqual(stacks(restored), [['b'], ['d'], ['e'], ['c']]);
});

test('moving a tab across sidebars preserves the remaining stack and its selection', () => {
  let layout = dockWidget(dockWidget(base(), 'a', 'b'), 'c', 'b');
  layout = deplacerWidget(layout, 'c', 'right', null);
  assert.deepEqual(stacks(layout), [['a', 'b'], ['d'], ['e']]);
  assert.deepEqual(stacks(layout, 'right'), [['c']]);
  assert.equal(entry(layout, 'a').activeTab, true);
  assert.equal(entry(layout, 'c').group, undefined);
});

test('inserting above any member inserts above the whole stack', () => {
  const layout = deplacerWidget(dockWidget(base(), 'a', 'b'), 'd', 'left', 'b');
  assert.deepEqual(stacks(layout), [['d'], ['a', 'b'], ['c'], ['e']]);
});

test('saved stacks, selection, removal and appearance survive JSON reload', () => {
  let layout = selectWidgetTab(dockWidget(base(), 'a', 'b'), 'b');
  layout = retirerWidget(layout, 'd').map((w) => w.id === 'b' ? { ...w, borderless: true, transparent: true } : w);
  const loaded = fusionnerLayout(JSON.parse(JSON.stringify(layout)), constraints);
  assert.deepEqual(stacks(loaded), [['a', 'b'], ['c'], ['e']]);
  assert.equal(entry(loaded, 'b').activeTab, true);
  assert.equal(entry(loaded, 'a').activeTab, undefined);
  assert.equal(entry(loaded, 'd').removed, true);
  assert.equal(entry(loaded, 'b').borderless, true);
  assert.equal(entry(loaded, 'b').transparent, true);
});

test('unrelated moves preserve a lone registered tab awaiting its plugin sibling', () => {
  const layout = base().map((w) => w.id === 'a' ? { ...w, group: 'plugin-stack', activeTab: true } : w);
  const moved = deplacerWidget(layout, 'c', 'right', null);
  assert.equal(entry(moved, 'a').group, 'plugin-stack');
});


test('creating an instance replaces its template in place and keeps the template in the palette', () => {
  const layout = dockWidget(base(), 'a', 'b').map((w) => w.id === 'a' ? { ...w, borderless: true, transparent: true } : w);
  const result = remplacerWidget(layout, 'a', 'new-instance');
  assert.deepEqual(entry(result, 'new-instance'), { ...entry(layout, 'a'), id: 'new-instance' });
  assert.equal(entry(result, 'a').removed, true);
  assert.equal(entry(result, 'a').group, undefined);
  const reloaded = fusionnerLayout(JSON.parse(JSON.stringify(result)), [...constraints, { ...constraints[0]!, id: 'new-instance' }]);
  assert.equal(entry(reloaded, 'new-instance').activeTab, true);
  assert.equal(entry(reloaded, 'new-instance').transparent, true);
  assert.deepEqual(stacks(reloaded), [['new-instance', 'b'], ['c'], ['d'], ['e']]);
});

test('a tab dropped on a sibling follows the direction of the gesture', () => {
  let layout = dockWidget(dockWidget(base(), 'a', 'b'), 'c', 'b');
  assert.deepEqual(stacks(layout), [['c', 'a', 'b'], ['d'], ['e']]);
  // Vers la droite : on se pose APRÈS la cible.
  layout = deplacerOnglet(layout, 'c', 'a');
  assert.deepEqual(stacks(layout), [['a', 'c', 'b'], ['d'], ['e']]);
  // Vers la gauche : on se pose AVANT.
  layout = deplacerOnglet(layout, 'b', 'a');
  assert.deepEqual(stacks(layout), [['b', 'a', 'c'], ['d'], ['e']]);
  // Le groupe, l'onglet actif et les hauteurs ne bougent pas.
  assert.equal(entry(layout, 'b').group, entry(layout, 'c').group);
  assert.equal(entry(layout, 'c').activeTab, true);
});

test('tab reordering refuses everything that is not one', () => {
  const layout = dockWidget(base(), 'a', 'b');
  // Hors pile, autre pile, ou soi-même : le layout revient à l'identique.
  assert.equal(deplacerOnglet(layout, 'a', 'd'), layout);
  assert.equal(deplacerOnglet(layout, 'd', 'e'), layout);
  assert.equal(deplacerOnglet(layout, 'a', 'a'), layout);
  assert.equal(deplacerOnglet(layout, 'a', 'inconnu'), layout);
});

test('the caret side is the side the drop actually uses', () => {
  const layout = dockWidget(dockWidget(base(), 'a', 'b'), 'c', 'b');
  const pile = widgetStacks(widgetsDuRail(layout, 'left'))[0]!;
  assert.deepEqual(pile.map((w) => w.id), ['c', 'a', 'b']);
  assert.equal(coteInsertion(pile, 'c', 'a'), 'apres');
  assert.equal(coteInsertion(pile, 'b', 'a'), 'avant');
  // Un onglet venu d'ailleurs n'a pas de rang dans cette pile : côté forcé.
  assert.equal(coteInsertion(pile, 'd', 'a'), 'avant');
  assert.equal(coteInsertion(pile, 'c', 'a', 'avant'), 'avant');
});

test('a foreign widget dropped on a tab lands just before it, not at the head', () => {
  let layout = dockWidget(dockWidget(base(), 'a', 'b'), 'c', 'b');
  layout = deplacerOnglet(dockWidget(layout, 'd', 'b'), 'd', 'b', 'avant');
  assert.deepEqual(stacks(layout), [['c', 'a', 'd', 'b'], ['e']]);
  assert.equal(entry(layout, 'd').group, entry(layout, 'b').group);
});

test('a widget from another stack can be dropped as the last tab', () => {
  let layout = dockWidget(dockWidget(base(), 'a', 'b'), 'c', 'b');
  layout = dockWidget(layout, 'e', 'd');
  assert.deepEqual(stacks(layout), [['c', 'a', 'b'], ['e', 'd']]);
  layout = placerEnFinDePile(layout, 'e', 'c');
  assert.deepEqual(stacks(layout), [['c', 'a', 'b', 'e'], ['d']]);
  assert.equal(entry(layout, 'e').group, entry(layout, 'c').group);
  assert.equal(entry(layout, 'e').activeTab, true);
  // La pile quittée, réduite à un onglet, redevient une carte seule.
  assert.equal(entry(layout, 'd').group, undefined);
});

test('a widget from another zone or from the palette can be dropped as the last tab', () => {
  let layout = dockWidget(base(), 'a', 'b');
  layout = deplacerWidget(layout, 'd', 'right', null);
  layout = placerEnFinDePile(layout, 'd', 'a');
  assert.deepEqual(stacks(layout), [['a', 'b', 'd'], ['c'], ['e']]);
  assert.equal(entry(layout, 'd').rail, 'left');
  layout = retirerWidget(layout, 'e');
  assert.equal(entry(layout, 'e').removed, true);
  layout = placerEnFinDePile(layout, 'e', 'b');
  assert.deepEqual(stacks(layout), [['a', 'b', 'd', 'e'], ['c']]);
  assert.equal(entry(layout, 'e').removed, undefined);
});

test('a tab of the stack can be moved to the last place, and staying last is a no-op', () => {
  let layout = dockWidget(dockWidget(base(), 'a', 'b'), 'c', 'b');
  assert.deepEqual(stacks(layout), [['c', 'a', 'b'], ['d'], ['e']]);
  layout = placerEnFinDePile(layout, 'c', 'c');
  assert.deepEqual(stacks(layout), [['a', 'b', 'c'], ['d'], ['e']]);
  assert.equal(entry(layout, 'c').activeTab, true);
  assert.equal(placerEnFinDePile(layout, 'c', 'a'), layout);
  // Une carte seule n'a pas de fin de pile.
  assert.equal(placerEnFinDePile(layout, 'd', 'd'), layout);
});

// TODO #647: the undo of a removal puts back that widget only, so that it can
// be replayed over another window's write without undoing that write.
test('undoing a removal puts the widget back at its rank, in its stack, with its selected tab', () => {
  const avant = dockWidget(base(), 'b', 'c');
  const layout = remettreWidget(retirerWidget(avant, 'b'), avant, 'b');
  assert.deepEqual(stacks(layout), stacks(avant));
  assert.equal(entry(layout, 'b').group, entry(avant, 'b').group);
  assert.equal(entry(layout, 'b').activeTab, true);
  assert.equal(entry(layout, 'c').activeTab, false);
  assert.equal(entry(layout, 'b').removed, undefined);
});

test('undoing a removal keeps what changed elsewhere in the meantime', () => {
  const avant = base();
  let layout = retirerWidget(avant, 'b');
  // Another window moves `e` to the other side, and removes `d`.
  layout = retirerWidget(deplacerWidget(layout, 'e', 'right', null), 'd');
  layout = remettreWidget(layout, avant, 'b');
  assert.deepEqual(stacks(layout), [['a'], ['b'], ['c']]);
  assert.deepEqual(stacks(layout, 'right'), [['e']]);
  assert.equal(entry(layout, 'd').removed, true);
});

test('undoing a removal does nothing to a widget already back by other means', () => {
  const avant = base();
  const back = deplacerWidget(retirerWidget(avant, 'b'), 'b', 'right', null);
  assert.deepEqual(remettreWidget(back, avant, 'b'), back);
});

test('an edge between two cards trades height between them only, and sticks to the known shares', async () => {
  const { deplacerBord, partsDepuisHauteurs, repartirHauteurs } = await import('../components/widget-host/widget-layout');
  // A 900px column, three cards at 300px.
  const h = [300, 300, 300];
  const mins = [100, 100, 100];
  const free = deplacerBord(h, mins, 0, 47, false);
  assert.deepEqual(free, [347, 253, 300], 'only the pair moves, the column stays full');
  // 300 + 145 lands 5px from half the column, inside the tolerance (2.5 % of
  // 900px): it sticks to 50 %.
  assert.deepEqual(deplacerBord(h, mins, 0, 145, true), [450, 150, 300]);
  // A third of the column for the second card is a snap too (the complement side).
  assert.deepEqual(deplacerBord([450, 150, 300], mins, 0, -148, true), [300, 300, 300]);
  // Floors hold.
  assert.deepEqual(deplacerBord(h, mins, 0, 1000, false), [500, 100, 300]);
  // Shares in percent sum to 100 and land on the layout as `fill` cards.
  assert.deepEqual(partsDepuisHauteurs([450, 150, 300]), [50, 16.7, 33.3]);
  const layout = [
    { id: 'a', rail: 'left', rang: 0, hauteur: 200 },
    { id: 'b', rail: 'left', rang: 1, hauteur: 200, heightMode: 'fill' as const },
  ];
  const next = repartirHauteurs(layout, [{ id: 'a', percent: 25 }, { id: 'b', percent: 75 }]);
  assert.deepEqual(next.map((w) => [w.heightMode, w.fillPercent]), [['fill', 25], ['fill', 75]]);
});

test('the stored shares of a column are weights against each other: a card left alone fills the column', async () => {
  const { partsNormalisees } = await import('../components/widget-host/widget-layout');
  // Two cards at 50 %, one dragged to another column: the one left keeps 50
  // in the layout, and must still take the whole height (TODO #786).
  assert.deepEqual(partsNormalisees([50]), [100]);
  assert.deepEqual(partsNormalisees([50, 50]), [50, 50]);
  // A card arriving at 50 % next to one at 100 % gets a third.
  assert.deepEqual(partsNormalisees([100, 50]).map((p) => Math.round(p * 10) / 10), [66.7, 33.3]);
  assert.deepEqual(partsNormalisees([25, 25, 25]).map((p) => Math.round(p * 10) / 10), [33.3, 33.3, 33.3]);
  // Nothing usable: an even split rather than a column of zero-height cards.
  assert.deepEqual(partsNormalisees([0, Number.NaN]), [50, 50]);
  assert.deepEqual(partsNormalisees([]), []);
});
