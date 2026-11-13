import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cancelDrag,
  crossZoneTarget,
  isZoneDropId,
  resolveDrop,
  zoneAcceptsWidget,
  zoneDropId,
  zoneOfDragId,
  DEFAULT_WIDGET_SLOTS,
} from '../components/widget-host/widget-dnd';
import {
  deplacerWidget,
  fusionnerLayout,
  reordonnerRail,
  retirerWidget,
  widgetsAdmisParConfig,
  widgetsDuRail,
  widgetsRetires,
  widgetsDisponibles,
  orphelins,
  placementHerite,
  type ContraintesWidget,
  type ZoneId,
  type WidgetLayout,
} from '../components/widget-host/widget-layout';
import {
  catalogueWidgets,
  idCourant,
  origineWidget,
  HAUTEUR_DEFAUT_PLUGIN,
  HAUTEUR_MIN_PLUGIN,
  type EntreeCatalogue,
  type EntreeSlotWidget,
} from '../components/widget-host/widget-catalog';
import { zoneDefautDuSlot } from '../components/cockpit/cockpit-zones';
import { loadLayout, saveLayout } from './ui-layout-store';
import { isZoneVisible, type Capabilities } from './capabilities';

const ZONES: readonly ZoneId[] = ['gauche', 'droite'];

const CONTRAINTES: ContraintesWidget[] = [
  { id: 'a', hauteurDefaut: 200, hauteurMin: 100, railDefaut: 'gauche', rangDefaut: 0 },
  { id: 'b', hauteurDefaut: 200, hauteurMin: 100, railDefaut: 'gauche', rangDefaut: 1 },
  { id: 'c', hauteurDefaut: 200, hauteurMin: 100, railDefaut: 'gauche', rangDefaut: 2 },
  { id: 'd', hauteurDefaut: 200, hauteurMin: 100, railDefaut: 'droite', rangDefaut: 0 },
];

function base(): WidgetLayout[] {
  return fusionnerLayout(null, CONTRAINTES);
}

/** `zone:id` pairs, in reading order — the shape a board actually shows. */
function placement(layout: WidgetLayout[]): string[] {
  return ZONES.flatMap((zone) => widgetsDuRail(layout, zone).map((w) => `${zone}:${w.id}`));
}

test('defaults place every widget at its declared rank', () => {
  assert.deepEqual(placement(base()), [
    'gauche:a', 'gauche:b', 'gauche:c', 'droite:d',
  ]);
});

test('a zone drop id designates its zone, a widget id designates the zone holding it', () => {
  const layout = base();
  assert.ok(isZoneDropId(zoneDropId('droite')));
  assert.equal(zoneOfDragId(layout, zoneDropId('droite'), ZONES), 'droite');
  assert.equal(zoneOfDragId(layout, 'b', ZONES), 'gauche');
  assert.equal(zoneOfDragId(layout, 'inconnu', ZONES), null);
  assert.equal(zoneOfDragId(layout, zoneDropId('nulle-part'), ZONES), null);
});

test('hovering inside its own zone moves nothing: the reorder waits for the drop', () => {
  const layout = base();
  assert.equal(crossZoneTarget(layout, 'a', 'c', ZONES), null);
  assert.equal(crossZoneTarget(layout, 'a', zoneDropId('gauche'), ZONES), null);
});

test('hovering another zone targets it, before the hovered widget or at the end', () => {
  const layout = base();
  assert.deepEqual(crossZoneTarget(layout, 'a', 'd', ZONES), { zone: 'droite', before: 'd' });
  assert.deepEqual(
    crossZoneTarget(layout, 'a', zoneDropId('droite'), ZONES),
    { zone: 'droite', before: null },
  );
});

test('the hovered move inserts before the hovered widget and renumbers both zones', () => {
  const cible = crossZoneTarget(base(), 'a', 'd', ZONES);
  assert.ok(cible);
  const moved = deplacerWidget(base(), 'a', cible.zone, cible.before);
  assert.deepEqual(placement(moved), ['gauche:b', 'gauche:c', 'droite:a', 'droite:d']);
});

test('a drop reorders inside the zone the widget now sits in', () => {
  assert.deepEqual(
    placement(resolveDrop(base(), 'a', 'c', ZONES)),
    ['gauche:b', 'gauche:c', 'gauche:a', 'droite:d'],
  );
  assert.deepEqual(
    placement(resolveDrop(base(), 'c', 'a', ZONES)),
    ['gauche:c', 'gauche:a', 'gauche:b', 'droite:d'],
  );
});

test('a drop on a zone target, on itself, or nowhere leaves the layout untouched', () => {
  const layout = base();
  for (const over of [zoneDropId('gauche'), 'a', null, 'inconnu']) {
    assert.deepEqual(placement(resolveDrop(layout, 'a', over, ZONES)), placement(layout));
  }
});

test('a widget dragged across zones then dropped keeps the place the hover gave it', () => {
  // The full gesture, in the order the host applies it: `dragOver` commits the
  // change of zone, `dragEnd` only settles the order inside the new zone.
  const cible = crossZoneTarget(base(), 'b', zoneDropId('droite'), ZONES);
  assert.ok(cible);
  const survole = deplacerWidget(base(), 'b', cible.zone, cible.before);
  assert.deepEqual(placement(resolveDrop(survole, 'b', 'd', ZONES)), [
    'gauche:a', 'gauche:c', 'droite:b', 'droite:d',
  ]);
});

test('a stored placement survives a widget leaving and a widget joining the registry', () => {
  const stored = [
    { id: 'a', rail: 'droite', rang: 1, hauteur: 260 },
    { id: 'disparu', rail: 'gauche', rang: 0, hauteur: 100 },
  ];
  const merged = fusionnerLayout(stored, CONTRAINTES);
  // `a` kept its zone but not its stored rank: ranks are renumbered densely,
  // and `d` (default rank 0) sorts ahead of it.
  assert.deepEqual(placement(merged), ['gauche:b', 'gauche:c', 'droite:d', 'droite:a']);
  assert.equal(merged.find((w) => w.id === 'a')?.hauteur, 260);
});

// ── Généralisation : zones libres et admission ──────────────────────────────

const COCKPIT_GAUCHE = { id: 'gauche', slot: 'cockpit.widget' };
const SIDEBAR = { id: 'sidebar.left.widget', slot: 'sidebar.left.widget' };
const REGLAGES = { id: 'reglages', slot: 'settings.section' };

test('a widget declaring a widget slot is admitted into every widget zone', () => {
  assert.equal(zoneAcceptsWidget(DEFAULT_WIDGET_SLOTS, COCKPIT_GAUCHE), true);
  assert.equal(zoneAcceptsWidget(DEFAULT_WIDGET_SLOTS, SIDEBAR), true);
});

test('a zone of another nature refuses it, whatever the widget declares', () => {
  assert.equal(zoneAcceptsWidget(DEFAULT_WIDGET_SLOTS, REGLAGES), false);
  assert.equal(zoneAcceptsWidget(['settings.section'], REGLAGES), true);
  assert.equal(zoneAcceptsWidget(['settings.section'], SIDEBAR), false);
});

test('a refused zone is never reached, even if collision detection points at it', () => {
  // Belt and braces: the droppable is disabled up front, and the model refuses
  // the move a second time — a placement admission rejected must not exist.
  const zones = ['gauche', 'droite', 'reglages'];
  const accepte = (_id: string, zone: string) => zone !== 'reglages';
  assert.equal(
    crossZoneTarget(base(), 'a', zoneDropId('reglages'), zones, accepte),
    null,
  );
  assert.deepEqual(
    crossZoneTarget(base(), 'a', zoneDropId('droite'), zones, accepte),
    { zone: 'droite', before: null },
  );
});

test('a widget moves into a zone that held nothing yet, and comes back', () => {
  const parti = deplacerWidget(base(), 'a', 'sidebar.left.widget', null);
  assert.deepEqual(placement(parti), ['gauche:b', 'gauche:c', 'droite:d']);
  assert.deepEqual(widgetsDuRail(parti, 'sidebar.left.widget').map((w) => w.id), ['a']);

  const revenu = deplacerWidget(parti, 'a', 'gauche', 'c');
  assert.deepEqual(placement(revenu), ['gauche:b', 'gauche:a', 'gauche:c', 'droite:d']);
  assert.deepEqual(widgetsDuRail(revenu, 'sidebar.left.widget'), []);
});

test('a placement in an unmounted zone is kept, not relocated', () => {
  // A sidebar exists only on the pages that render it; a widget parked there
  // must survive a page that never mounts the zone.
  const stored = [{ id: 'a', rail: 'sidebar.left.widget', rang: 0, hauteur: 200 }];
  const merged = fusionnerLayout(stored, CONTRAINTES);
  assert.equal(merged.find((w) => w.id === 'a')?.rail, 'sidebar.left.widget');
  assert.deepEqual(placement(merged), ['gauche:b', 'gauche:c', 'droite:d']);
});

test('reordering a zone leaves every other zone exactly where it was', () => {
  const etale = deplacerWidget(base(), 'a', 'sidebar.left.widget', null);
  const reordonne = reordonnerRail(etale, 'gauche', ['c', 'b']);
  assert.deepEqual(widgetsDuRail(reordonne, 'gauche').map((w) => w.id), ['c', 'b']);
  assert.deepEqual(widgetsDuRail(reordonne, 'droite').map((w) => w.id), ['d']);
  assert.deepEqual(
    widgetsDuRail(reordonne, 'sidebar.left.widget').map((w) => w.id),
    ['a'],
  );
});

test('a widget moved to a sidebar is still there after a reload', () => {
  // The exit criterion, end to end at the level that decides it: the move, what
  // the daemon is handed, and what the next page load rebuilds from it.
  let stocke: unknown = null;
  const daemon = async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      stocke = (JSON.parse(String(init.body)) as { layout: unknown }).layout;
      return new Response(null, { status: 204 });
    }
    return Response.json({ layout: stocke });
  };

  const deplace = deplacerWidget(base(), 'a', 'sidebar.left.widget', null);
  return saveLayout(deplace, { fetchImpl: daemon, storage: null })
    .then((ok) => {
      assert.equal(ok, true);
      return loadLayout({ fetchImpl: daemon, storage: null });
    })
    .then((out) => {
      assert.equal(out.ok, true);
      const rechargé = fusionnerLayout(out.raw, CONTRAINTES);
      assert.deepEqual(
        widgetsDuRail(rechargé, 'sidebar.left.widget').map((w) => w.id),
        ['a'],
      );
      assert.deepEqual(placement(rechargé), ['gauche:b', 'gauche:c', 'droite:d']);
    });
});


// ── Retirer de l'interface, puis remettre ───────────────────────────────────

/** A layout round-tripped through the daemon: what actually survives a reload. */
function recharger(layout: WidgetLayout[]): WidgetLayout[] {
  return fusionnerLayout(JSON.parse(JSON.stringify(layout)), CONTRAINTES);
}

test('a removed widget leaves its zone and shows up in the palette', () => {
  const apres = retirerWidget(base(), 'b');
  assert.deepEqual(placement(apres), ['gauche:a', 'gauche:c', 'droite:d']);
  assert.deepEqual(widgetsRetires(apres).map((w) => w.id), ['b']);
});

test('a removal survives a reload instead of undoing itself', () => {
  // The whole point of keeping the entry: dropping it would let the merge with
  // the registry treat the widget as new and put it back at its defaults.
  const apres = recharger(retirerWidget(base(), 'b'));
  assert.deepEqual(placement(apres), ['gauche:a', 'gauche:c', 'droite:d']);
  assert.deepEqual(widgetsRetires(apres).map((w) => w.id), ['b']);
});

test('a removed widget is inert: neither a reorder nor a move of others loses it', () => {
  // `b` keeps the stale zone `gauche`, so any regrouping that forgets to set it
  // aside would drop it — and a dropped entry comes back placed on next load.
  const retire = retirerWidget(base(), 'b');

  const reordonne = reordonnerRail(retire, 'gauche', ['c', 'a']);
  assert.deepEqual(placement(reordonne), ['gauche:c', 'gauche:a', 'droite:d']);
  assert.deepEqual(widgetsRetires(reordonne).map((w) => w.id), ['b']);

  const deplace = deplacerWidget(retire, 'a', 'droite', null);
  assert.deepEqual(placement(deplace), ['gauche:c', 'droite:d', 'droite:a']);
  assert.deepEqual(widgetsRetires(deplace).map((w) => w.id), ['b']);
});

test('a widget dragged out of the palette lands where it is dropped, and stays', () => {
  const retire = retirerWidget(base(), 'b');
  // No zone of its own, so any admitting zone it hovers is a target.
  const cible = crossZoneTarget(retire, 'b', 'd', ZONES);
  assert.deepEqual(cible, { zone: 'droite', before: 'd' });

  const remis = recharger(deplacerWidget(retire, 'b', 'droite', 'd'));
  assert.deepEqual(placement(remis), ['gauche:a', 'gauche:c', 'droite:b', 'droite:d']);
  assert.deepEqual(widgetsRetires(remis), []);
});

test('a palette drop released before any hover still places the widget', () => {
  // The flick out of the palette: `dragEnd` fires without a single `dragOver`
  // having moved anything, so the drop has to do the placing itself.
  const retire = retirerWidget(base(), 'b');
  assert.deepEqual(
    placement(resolveDrop(retire, 'b', zoneDropId('droite'), ZONES)),
    ['gauche:a', 'gauche:c', 'droite:d', 'droite:b'],
  );
  assert.deepEqual(
    placement(resolveDrop(retire, 'b', 'a', ZONES)),
    ['gauche:b', 'gauche:a', 'gauche:c', 'droite:d'],
  );
});

test('a palette drag cancelled before the drop leaves the widget removed', () => {
  // Escape mid-gesture. `dragOver` has already committed the preview — the very
  // move the drop test above releases on — so cancelling has to undo it, or the
  // widget stays out of the palette and the next write persists it as placed.
  const avant = retirerWidget(base(), 'b');
  const cible = crossZoneTarget(avant, 'b', 'd', ZONES);
  assert.deepEqual(cible, { zone: 'droite', before: 'd' });
  const apercu = deplacerWidget(avant, 'b', 'droite', 'd');
  assert.deepEqual(widgetsRetires(apercu), []);

  const annule = cancelDrag(avant, apercu);
  assert.deepEqual(widgetsRetires(annule).map((w) => w.id), ['b']);
  assert.deepEqual(placement(annule), ['gauche:a', 'gauche:c', 'droite:d']);
  assert.deepEqual(annule, avant);
  // And it is still removed on the next load: the cancellation is the state the
  // following write will hand to the daemon.
  assert.deepEqual(widgetsRetires(recharger(annule)).map((w) => w.id), ['b']);
  assert.deepEqual(placement(recharger(annule)), ['gauche:a', 'gauche:c', 'droite:d']);
});

test('a cancelled cross-zone drag puts the neighbours back too, not just the widget', () => {
  // Why the snapshot is the whole layout: the preview renumbered both zones, so
  // restoring the dragged entry alone would leave `c` and `d` in an order the
  // user never released.
  const avant = base();
  const apercu = deplacerWidget(avant, 'a', 'droite', 'd');
  assert.deepEqual(placement(apercu), ['gauche:b', 'gauche:c', 'droite:a', 'droite:d']);

  const annule = cancelDrag(avant, apercu);
  assert.deepEqual(placement(annule), ['gauche:a', 'gauche:b', 'gauche:c', 'droite:d']);
  assert.deepEqual(annule, avant);
});

test('no gesture in flight: cancelling keeps the current layout', () => {
  const layout = retirerWidget(base(), 'b');
  assert.equal(cancelDrag(null, layout), layout);
});

test('a palette drop into a zone that refuses the widget places nothing', () => {
  const retire = retirerWidget(base(), 'b');
  const zones = [...ZONES, 'reglages'];
  const refuse = (_id: string, zone: ZoneId) => zone !== 'reglages';
  const apres = resolveDrop(retire, 'b', zoneDropId('reglages'), zones, refuse);
  assert.deepEqual(widgetsRetires(apres).map((w) => w.id), ['b']);
  assert.deepEqual(placement(apres), ['gauche:a', 'gauche:c', 'droite:d']);
});


// ── Ce que la config retire n'est pas « rangé » ─────────────────────────────

/** Capacités minimales : seuls `ui.hidden` et l'état des modules comptent ici. */
function caps(ui: string[], modules: { id: string; active: boolean }[] = []): Capabilities {
  return {
    edition: 'expert',
    profile: 'linux-desktop',
    capabilities: [],
    modules: modules.map((m) => ({ ...m, tier: 'std', reason: null, missing: [] })),
    ui: { hidden: ui, home: '/' },
    kernel: true,
    developer: { unsignedPlugins: false },
  };
}

/** The host's own derivation, predicate included — not a stand-in for it. */
function affichables(layout: WidgetLayout[], c: Capabilities | null): WidgetLayout[] {
  return widgetsAdmisParConfig(layout, (id) => isZoneVisible(c, `cockpit.${id}`));
}

// `dreams` est porté par le module `dreams` (`ZONE_MODULE`), `vault-graph` par
// `vault` : deux widgets réels, pour exercer la vraie table et non des ids
// inventés qui n'y figurent pas.
const CONTRAINTES_REELLES: ContraintesWidget[] = [
  { id: 'dreams', hauteurDefaut: 220, hauteurMin: 120, railDefaut: 'gauche', rangDefaut: 0 },
  { id: 'vault-graph', hauteurDefaut: 300, hauteurMin: 140, railDefaut: 'gauche', rangDefaut: 1 },
];

test('a widget masked by ui.hidden shows up neither in its zone nor in the palette', () => {
  // Retiré ET masqué : même dans ce cas, la palette ne le propose pas. Le
  // ranger est une décision de l'utilisateur, le masquer une décision de
  // config — et c'est la config qui filtre en premier.
  const layout = retirerWidget(fusionnerLayout(null, CONTRAINTES_REELLES), 'dreams');
  const vus = affichables(layout, caps(['cockpit.dreams']));

  assert.deepEqual(widgetsRetires(vus), []);
  assert.deepEqual(widgetsDuRail(vus, 'gauche').map((w) => w.id), ['vault-graph']);
  // Rien n'est perdu pour autant : le placement garde l'entrée, et retirer
  // `cockpit.dreams` de la config la ramène telle qu'elle était.
  assert.deepEqual(widgetsRetires(affichables(layout, caps([]))).map((w) => w.id), ['dreams']);
});

test('a widget whose module is off is not offered either', () => {
  const layout = retirerWidget(fusionnerLayout(null, CONTRAINTES_REELLES), 'dreams');
  const eteint = caps([], [{ id: '@rooks/dreams', active: false }]);
  assert.deepEqual(widgetsRetires(affichables(layout, eteint)), []);
  assert.deepEqual(
    widgetsRetires(affichables(layout, caps([], [{ id: '@rooks/dreams', active: true }]))).map((w) => w.id),
    ['dreams'],
  );
});

test('capabilities not loaded yet: everything shows, palette included', () => {
  // Politique de repli du front — en cas de doute, on affiche.
  const layout = retirerWidget(fusionnerLayout(null, CONTRAINTES_REELLES), 'dreams');
  assert.deepEqual(widgetsRetires(affichables(layout, null)).map((w) => w.id), ['dreams']);
});

// ── Catalogue : natifs + entrées de slot, une seule source de placement ─────

const NATIFS: EntreeCatalogue[] = CONTRAINTES.map((c) => ({
  ...c,
  titre: c.id.toUpperCase(),
  slots: DEFAULT_WIDGET_SLOTS,
  registrationId: null,
}));

function inscription(
  pluginId: string,
  slot = 'cockpit.widget',
  key?: string,
  n = 1,
): EntreeSlotWidget {
  return { registrationId: `${pluginId}:${n}`, pluginId, key, slot };
}

test('a slot entry becomes a catalogue entry, placed after the native ones', () => {
  const catalogue = catalogueWidgets(NATIFS, [inscription('example-widget')], zoneDefautDuSlot);
  const ajoute = catalogue.at(-1);

  assert.equal(catalogue.length, NATIFS.length + 1);
  assert.deepEqual(ajoute, {
    id: 'plugin:example-widget',
    titre: 'example-widget',
    pluginId: 'example-widget',
    slots: ['cockpit.widget'],
    registrationId: 'example-widget:1',
    hauteurDefaut: HAUTEUR_DEFAUT_PLUGIN,
    hauteurMin: HAUTEUR_MIN_PLUGIN,
    // Les deux rails du cockpit partagent un slot : c'est la seule zone dont le
    // nom ne se déduit pas du slot.
    railDefaut: 'gauche',
    rangDefaut: NATIFS.length,
  });
});

test('the palette can tell two homonymous widgets apart by their surface', () => {
  // Les deux « Missions » du produit : même titre, même plugin, deux surfaces.
  const [cockpit, chat] = catalogueWidgets([], [
    { ...inscription('@rooks/missions', 'cockpit.widget', 'recent'), options: { title: 'Missions' } },
    { ...inscription('@rooks/missions', 'chat.left.widget', 'Missions', 2), options: { title: 'Missions' } },
  ], zoneDefautDuSlot);

  assert.ok(cockpit && chat);
  assert.equal(cockpit.titre, chat.titre);
  assert.deepEqual(origineWidget(cockpit), {
    cleSurface: 'widgets.surface.cockpit',
    surface: 'cockpit.widget',
    plugin: 'missions',
  });
  assert.deepEqual(origineWidget(chat), {
    cleSurface: 'widgets.surface.chatLeft',
    surface: 'chat.left.widget',
    plugin: 'missions',
  });
});

test('an unknown slot shows itself, a native widget shows no plugin', () => {
  const [tiers] = catalogueWidgets([], [inscription('acme', 'acme.board.widget')]);
  assert.ok(tiers);
  assert.deepEqual(origineWidget(tiers), {
    cleSurface: null,
    surface: 'acme.board.widget',
    plugin: 'acme',
  });
  assert.equal(origineWidget(NATIFS[0]!).plugin, null);
});

test('a widget slot other than the cockpit names its own zone', () => {
  const [entree] = catalogueWidgets([], [inscription('p', 'sidebar.right.widget')], zoneDefautDuSlot);
  assert.equal(entree?.railDefaut, 'sidebar.right.widget');
});

test('the placement id is stable across reloads, and a key separates two widgets', () => {
  const premier = catalogueWidgets([], [inscription('acme', 'cockpit.widget', undefined, 1)]);
  // Même plugin, autre session : le compteur d'inscription a changé, pas l'id.
  const second = catalogueWidgets([], [inscription('acme', 'cockpit.widget', undefined, 7)]);
  assert.equal(premier[0]?.id, second[0]?.id);

  const deux = catalogueWidgets([], [
    inscription('acme', 'cockpit.widget', 'gauche'),
    inscription('acme', 'cockpit.widget', 'droite', 2),
  ]);
  assert.deepEqual(deux.map((e) => e.id), ['plugin:acme:gauche', 'plugin:acme:droite']);
});

test('two keyless registrations of one plugin: the second falls back on its registration id', () => {
  const deux = catalogueWidgets([], [
    inscription('acme', 'cockpit.widget', undefined, 1),
    inscription('acme', 'cockpit.widget', undefined, 2),
  ]);
  assert.deepEqual(deux.map((e) => e.id), ['plugin:acme', 'acme:2']);
});

test('a plugin widget is admitted into every widget zone, and refused elsewhere', () => {
  const [entree] = catalogueWidgets([], [inscription('acme', 'cockpit.widget')]);
  assert.ok(entree);
  assert.equal(zoneAcceptsWidget(entree.slots, SIDEBAR), true);
  assert.equal(zoneAcceptsWidget(entree.slots, COCKPIT_GAUCHE), true);
  assert.equal(zoneAcceptsWidget(entree.slots, REGLAGES), false);
});

test('a registration declares its title, its heights and its first zone', () => {
  // Sans ces quatre champs, toute carte de plugin s'appelle du nom de son
  // plugin, fait 260 px et se pose dans le rail gauche : les tuiles du produit
  // ne pourraient pas devenir des plugins sans y perdre leur mise en page.
  const [entree] = catalogueWidgets([], [{
    ...inscription('vault', 'cockpit.widget', 'vault-graph'),
    options: { title: 'Vault', zone: 'droite', height: 420, minHeight: 200 },
  }], zoneDefautDuSlot);

  assert.equal(entree?.titre, 'Vault');
  assert.equal(entree?.railDefaut, 'droite');
  assert.equal(entree?.hauteurDefaut, 420);
  assert.equal(entree?.hauteurMin, 200);
});

test('a plugin widget places, moves and is taken out like a native one', () => {
  const catalogue = catalogueWidgets(NATIFS, [inscription('acme')], zoneDefautDuSlot);
  const id = 'plugin:acme';
  const pose = fusionnerLayout(null, catalogue);
  assert.deepEqual(placement(pose), ['gauche:a', 'gauche:b', 'gauche:c', `gauche:${id}`, 'droite:d']);

  const deplace = deplacerWidget(pose, id, 'droite', 'd');
  assert.deepEqual(placement(deplace), ['gauche:a', 'gauche:b', 'gauche:c', `droite:${id}`, 'droite:d']);

  const retire = retirerWidget(deplace, id);
  assert.deepEqual(widgetsRetires(retire).map((w) => w.id), [id]);
  assert.deepEqual(placement(retire), ['gauche:a', 'gauche:b', 'gauche:c', 'droite:d']);
});

// ── Orphelins : le catalogue est vivant, le placement ne doit pas s'effacer ──

test('a stored placement waits for a plugin that has not registered yet', () => {
  // Le cas réel : le layout revient du daemon avant que le loader de plugins
  // ait fini. Sans orphelin, un simple glissement dans cet intervalle effacerait
  // la place du plugin pour toujours.
  const stocke = [
    { id: 'a', rail: 'droite', rang: 0, hauteur: 200 },
    { id: 'plugin:acme', rail: 'droite', rang: 1, hauteur: 300 },
  ];
  const sansPlugin = catalogueWidgets(NATIFS, [], zoneDefautDuSlot);

  assert.equal(fusionnerLayout(stocke, sansPlugin).some((w) => w.id === 'plugin:acme'), false);
  assert.deepEqual(orphelins(stocke, sansPlugin).map((w) => w.id), ['plugin:acme']);

  // Ce que l'hôte réécrit après un geste : le layout placé, plus les orphelins.
  const ecrit = [
    ...retirerWidget(fusionnerLayout(stocke, sansPlugin), 'a'),
    ...orphelins(stocke, sansPlugin),
  ];

  // Le plugin s'enregistre enfin : sa place et sa hauteur sont intactes.
  const avecPlugin = catalogueWidgets(NATIFS, [inscription('acme')], zoneDefautDuSlot);
  const revenu = fusionnerLayout(ecrit, avecPlugin).find((w) => w.id === 'plugin:acme');
  assert.equal(revenu?.rail, 'droite');
  assert.equal(revenu?.hauteur, 300);
  assert.deepEqual(orphelins(ecrit, avecPlugin), []);
});

test('an entry the catalogue claims is never an orphan, and a corrupt one is dropped', () => {
  const catalogue = catalogueWidgets(NATIFS, [], zoneDefautDuSlot);
  const stocke = [
    { id: 'a', rail: 'gauche', rang: 0, hauteur: 200 },
    { id: 'plugin:x', rail: 'gauche', rang: 1 },
    'pas un objet',
    { id: 'plugin:y', rail: 'gauche', rang: 2, hauteur: 200, removed: true },
    { id: 'plugin:y', rail: 'droite', rang: 3, hauteur: 200 },
  ];
  const restants = orphelins(stocke, catalogue);
  assert.deepEqual(restants.map((w) => w.id), ['plugin:y']);
  assert.equal(restants[0]?.removed, true);
  assert.deepEqual(orphelins(null, catalogue), []);
});

test('the catalog offers cockpit widgets on a chat without stealing visible placements', () => {
  const layout = base();
  assert.deepEqual(widgetsDisponibles(layout, ['chat.left.widget', 'chat.right.widget']), layout);
  const added = deplacerWidget(layout, 'a', 'chat.right.widget', null);
  assert.deepEqual(widgetsDisponibles(added, ['chat.left.widget', 'chat.right.widget']).map(w => w.id).sort(), ['b', 'c', 'd']);
  assert.equal(widgetsDuRail(layout, 'gauche').length, 3, 'the original cockpit layout is not mutated');
  assert.ok(widgetsDisponibles(retirerWidget(added, 'a'), ['chat.right.widget']).some(w => w.id === 'a'));
});

test('a horizontal zone only admits widgets that have a flat form', () => {
  const bar = { id: 'topbar.widget', slot: 'topbar.widget', orientation: 'horizontal' as const };
  const column = { id: 'sidebar.left.widget', slot: 'sidebar.left.widget' };
  assert.equal(zoneAcceptsWidget(['cockpit.widget'], bar), false, 'a card without `bar` never lands in the bar');
  assert.equal(zoneAcceptsWidget(['cockpit.widget'], bar, true), true);
  assert.equal(zoneAcceptsWidget(['cockpit.widget'], column, true), true, 'a bar widget still goes to any column');
  assert.equal(zoneAcceptsWidget(['topbar.item'], bar, true), false, 'the flat form does not open a non-widget slot');
});

test('the catalogue carries the flat form, the default placement and the former ids', () => {
  const [entree] = catalogueWidgets([], [{
    registrationId: 'n:0', pluginId: '@rooks/notifications', key: 'bell', slot: 'cockpit.widget',
    options: { zone: 'topbar.widget', bar: true, placedByDefault: true, formerKeys: ['inbox'] },
  }]);
  assert.equal(entree?.bar, true);
  assert.equal(entree?.placedByDefault, true);
  assert.deepEqual(entree?.formerIds, ['plugin:@rooks/notifications:inbox']);
  assert.equal(entree?.railDefaut, 'topbar.widget');
  assert.equal(origineWidget(entree!).cleSurface, 'widgets.surface.topbar');
  // `''` names the keyless registration a plugin had before giving it a key.
  const [renamed] = catalogueWidgets([], [{
    registrationId: 'q:0', pluginId: 'quota-monitor', key: 'quota', slot: 'cockpit.widget', options: { formerKeys: [''] },
  }]);
  assert.deepEqual(renamed?.formerIds, ['plugin:quota-monitor']);
});

test('a former id leads to the widget that carries it now; a current id always wins (TODO #540)', () => {
  const entrees = catalogueWidgets([], [
    { registrationId: 'g:0', pluginId: '@rooks/git', key: 'repository', slot: 'chat.right.widget', options: { formerIds: ['plugin:@rooks/git:Git', 'plugin:@rooks/kanban-code:Git'] } },
    { registrationId: 'o:0', pluginId: '@rooks/other', key: 'x', slot: 'chat.right.widget', options: { formerIds: ['plugin:@rooks/git:Git', 'plugin:@rooks/git:repository'] } },
  ]);
  assert.equal(idCourant(entrees, 'plugin:@rooks/kanban-code:Git'), 'plugin:@rooks/git:repository');
  assert.equal(idCourant(entrees, 'plugin:@rooks/git:Git'), 'plugin:@rooks/git:repository', 'the first claimant keeps it');
  assert.equal(idCourant(entrees, 'plugin:@rooks/git:repository'), 'plugin:@rooks/git:repository', 'a live id is never redirected');
  assert.equal(idCourant(entrees, 'plugin:@rooks/git:gone'), null);
});

test('a product card moved to another module keeps its place; a third party cannot claim one', () => {
  const [moved] = catalogueWidgets([], [{
    registrationId: 'g:0', pluginId: '@rooks/git', key: 'Git', slot: 'chat.left.widget',
    options: { formerIds: ['plugin:@rooks/kanban-code:Git'] },
  }]);
  assert.deepEqual(moved?.formerIds, ['plugin:@rooks/kanban-code:Git']);
  const stored = [{ id: 'plugin:@rooks/kanban-code:Git', rail: 'chat.right.widget', rang: 4, hauteur: 260 }];
  assert.deepEqual(placementHerite(stored, moved!.formerIds!, moved!.id), { ...stored[0], id: 'plugin:@rooks/git:Git' });

  const [thief] = catalogueWidgets([], [{
    registrationId: 't:0', pluginId: 'acme-git', key: 'Git', slot: 'chat.left.widget',
    options: { formerIds: ['plugin:@rooks/kanban-code:Git'] },
  }]);
  assert.equal(thief?.formerIds, undefined);
});
