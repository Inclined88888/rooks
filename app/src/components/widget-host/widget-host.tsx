'use client';

import dynamic from 'next/dynamic';
import { isChatZone, mergeWorkspaceWidgets, workspaceWidgets } from './widget-defaults';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  type CollisionDetection,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  type ScreenReaderInstructions,
} from '@dnd-kit/core';
import { widgetKeyboardCoordinates } from './widget-keyboard';
import { GripVertical } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { HUD_SURFACE } from '@/components/cockpit/hud-surface';
import { isZoneVisible, useCapabilities } from '@/lib/capabilities';
import { useStoredLayout } from '@/hooks/use-stored-layout';
import { workspaceRowHandover } from '@/lib/workspace-route';
import { useWorkspaceLayout } from '@/components/workspace-layout-provider';
import { t } from '@/lib/i18n';
import {
  deplacerOnglet,
  deplacerWidget,
  dockWidget,
  selectWidgetTab,
  fusionnerLayout,
  orphelins,
  placerEnFinDePile,
  redimensionner,
  remettreWidget,
  repartirHauteurs,
  retirerWidget,
  widgetsRetires,
  remplacerWidget,
  verserZone,
  widgetsAdmisParConfig,
  widgetsDuRail,
  widgetsDisponibles,
  type ZoneId,
  type WidgetLayout,
} from './widget-layout';
import {
  isZoneDropId,
  zoneAcceptsWidget,
  zoneDropId,
  DEFAULT_WIDGET_SLOTS,
  type WidgetZoneDef,
} from './widget-dnd';
import { useWidgetCatalog, type EntreeAffichable } from './use-widget-catalog';
import { usePublishWidgetSnapshot } from './use-widget-snapshot';

// Fetched when the palette first opens (docs/BUNDLE-SIZE.md).
const WidgetPalette = dynamic(() => import('./widget-palette').then((m) => m.WidgetPalette), { ssr: false });

/**
 * The widget host: layout state, persistence and ONE drag context, shared by
 * every zone that shows widgets.
 *
 * One context, not one per surface: a widget only travels from the cockpit to a
 * sidebar if the gesture that lifts it and the zone that catches it belong to
 * the same `DndContext`. That is why the host is mounted by the layout, above
 * the nav rail, the routed page and the right rail alike, rather than by the
 * cockpit board that used to own it.
 *
 * Zones announce themselves instead of being listed here. Third-party layouts
 * declare their own widget slots (§10.8), and zones come and go with the page
 * that renders them — a placement pointing at a zone nobody mounts is simply
 * not shown, and is kept untouched until that zone comes back.
  * What the host places comes from the CATALOGUE (`use-widget-catalog.tsx`),
  * which merges the native table and the slot registry's registrations. There
  * is thus no parallel table any more: a plugin widget is a card like any other,
  * and the old "after the rails" rendering by `<Slot />` disappeared with it.
  */

/** A tab (and the end of the bar after the last one) lies ON its card's
 *  docking target: without an explicit priority, aiming at the tab bar would
 *  dock instead of reorder. */
const CIBLES = /^(tab:|tab-end:|dock:|insert:|rail:)/;
const ONGLET = /^tab(-end)?:/;
const precis = (ids: readonly string[]) => ids.some((id) => ONGLET.test(id));

const widgetCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (hits.length) {
    const specific = hits.filter((hit) => CIBLES.test(String(hit.id)));
    const ids = specific.map((hit) => String(hit.id));
    if (precis(ids)) return specific.filter((hit) => ONGLET.test(String(hit.id)));
    return specific.length ? specific : hits;
  }
  if (args.pointerCoordinates) return [];
  // The keyboard getter positions the dragged rectangle's centre on a target.
  const centre = { x: args.collisionRect.left + args.collisionRect.width / 2, y: args.collisionRect.top + args.collisionRect.height / 2 };
  const keyboardHits = pointerWithin({ ...args, pointerCoordinates: centre });
  return keyboardHits.filter((hit) => CIBLES.test(String(hit.id))).slice(0, 1);
};

type WidgetHostValue = {
  /**
   * A layout gesture is under way: the widget window is open or a widget is in
   * the hand. There is no Edit Layout mode any more — cards drag by their title
   * and resize by their edges at any time — so this only says when empty zones
   * and column commands must show to give the gesture somewhere to land.
   */
  editing: boolean;
  /** The widget catalog panel, opened from the Customize interface menu. */
  paletteOpen: boolean;
  setPaletteOpen: (value: boolean) => void;
  zones: readonly WidgetZoneDef[];
  /** Placed widgets of a zone, ordered, minus those whose module is off. */
  widgetsOf: (zone: ZoneId) => WidgetLayout[];
  /** Declares a zone for as long as it is mounted. Returns its disposer. */
  registerZone: (zone: WidgetZoneDef) => () => void;
  /** Widget being dragged right now, `null` outside of a gesture. */
  dragging: string | null;
  /** Whether the widget being dragged may land in this zone. */
  accepts: (zone: WidgetZoneDef) => boolean;
  /** Widgets taken out of the interface, i.e. the inventory to drag back from. */
  palette: WidgetLayout[];
  /** Catalogue entry behind a placement: its title, its constraints, its body. */
  widget: (id: string) => EntreeAffichable | undefined;
  /** Takes a widget out of the interface. */
  onRemove: (id: string) => void;
  onReplace: (id: string, replacement: string) => void;
  /** Zone a click would put a removed widget back into, `null` if none is mounted. */
  restoreTargetOf: (id: string) => ZoneId | null;
  onRestore: (id: string, zone?: ZoneId) => void;
  /** Moves every card of a zone to the end of another, stacks kept. */
  onMergeZone: (from: ZoneId, to: ZoneId) => void;
  /** Height shares of a zone's stacks, by stack head id, in percent. `persist: false` while dragging. */
  onShares: (shares: ReadonlyArray<{ id: string; percent: number }>, persist: boolean) => void;
  onSelectTab: (id: string) => void;
  onDetach: (id: string) => void;
  /** `undefined` for a field removes the widget's own choice: it follows the site's again. */
  onStyle: (id: string, patch: { borderless?: boolean | undefined; transparent?: boolean | undefined; untitled?: boolean }) => void;
};

const WidgetHostContext = createContext<WidgetHostValue | null>(null);

export function useWidgetHost(): WidgetHostValue {
  const value = useContext(WidgetHostContext);
  if (!value) throw new Error('WidgetZone used outside of a WidgetHost');
  return value;
}

/** Is a layout gesture under way (widget window open, widget in the hand)? False outside a host. */
export function useWidgetEditing(): boolean {
  return useContext(WidgetHostContext)?.editing ?? false;
}

/** What the hand holds: a copy of the widget's frame, shrunk so it never
 *  covers more than a third of the window, scaled around the grab point so the
 *  pointer stays on the spot it picked up. `dx`/`dy` place the frame relative to
 *  the dragged node (a tab, for a stack). */
type Apercu = { node?: HTMLElement; /** Id of a widget that is not on screen (picked from the window): painted live. */ live?: string; w: number; h: number; dx: number; dy: number; gx: number; gy: number; scale: number };
const APERCU_MAX = 0.33;

/** A stack's body drags as `frame:<id>` (its active tab already owns `<id>`):
 *  both gestures move the same widget. */
export function widgetIdOfDrag(dragId: string): string {
  return dragId.startsWith('frame:') ? dragId.slice(6) : dragId;
}

function captureApercu(dragId: string, e: DragStartEvent): Apercu | null {
  const id = widgetIdOfDrag(dragId);
  // The node dnd-kit dragged, which the overlay wrapper sits on: the tab for a
  // tab, the card itself for a lone card or a stack picked by its body.
  const tab = dragId === id ? document.getElementById(`tab-${id}`) : null;
  const frame = tab?.closest<HTMLElement>('.widget-frame')
    ?? Array.from(document.querySelectorAll<HTMLElement>('.widget-frame')).find((f) => f.dataset.widgetId === id);
  if (!frame) return null;
  const box = frame.getBoundingClientRect();
  const origin = (tab ?? frame).getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return null;
  const ev = e.activatorEvent as Partial<PointerEvent>;
  const gx = typeof ev.clientX === 'number' ? ev.clientX - box.left : box.width / 2;
  const gy = typeof ev.clientY === 'number' ? ev.clientY - box.top : box.height / 2;
  const node = frame.cloneNode(true) as HTMLElement;
  // A stack's copy keeps only the tab of the widget in hand: its siblings stay
  // where they are, and showing them in the hand suggested they came along.
  node.querySelectorAll<HTMLElement>('[role="tab"]').forEach((other) => { if (other.id !== `tab-${id}`) other.remove(); });
  // Duplicated ids would break `aria-controls` and the tab lookups; the copy
  // must not answer dnd-kit or the dock queries either.
  node.removeAttribute('data-widget-id');
  node.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  node.style.opacity = '1';
  node.style.margin = '0';
  const scale = Math.min(1, (APERCU_MAX * window.innerWidth) / box.width, (APERCU_MAX * window.innerHeight) / box.height);
  return { node, w: box.width, h: box.height, dx: box.left - origin.left, dy: box.top - origin.top, gx, gy, scale };
}

const APERCU_CLASSES = 'pointer-events-none absolute overflow-hidden rounded-xl opacity-90 shadow-elev-2 ring-1 ring-primary/40';
const apercuStyle = (a: Apercu): React.CSSProperties => ({ left: a.dx, top: a.dy, width: a.w, height: a.h, transformOrigin: `${a.gx}px ${a.gy}px`, transform: `scale(${a.scale})` });

function ApercuWidget({ apercu }: { apercu: Apercu }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !apercu.node) return;
    el.replaceChildren(apercu.node);
    return () => el.replaceChildren();
  }, [apercu]);
  return <div ref={ref} aria-hidden className={APERCU_CLASSES} style={apercuStyle(apercu)} />;
}

/** The hand for a widget picked from the window: the widget itself, painted at
 *  its default size, exactly as it will be placed. A widget that paints nothing
 *  outside its own page (the chat's panels read the open conversation) falls
 *  back to a card with its name, so the hand is never empty. */
function ApercuVivant({ apercu, id }: { apercu: Apercu; id: string }) {
  const { widget } = useWidgetHost();
  const entree = widget(id);
  const ref = useRef<HTMLDivElement>(null);
  const [vide, setVide] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && el.childElementCount === 0) setVide(true);
  }, []);
  if (!entree) return null;
  return <div ref={ref} aria-hidden className={cn(APERCU_CLASSES, 'bg-background')} style={apercuStyle(apercu)}>
    {vide ? (
      <div className="flex h-full flex-col gap-2 p-3">
        <span className="text-xs font-semibold text-foreground">{entree.titreCatalogue ?? entree.titre}</span>
        {[0, 1, 2, 3].map((n) => <span key={n} className="h-2 rounded-full bg-muted-foreground/15" style={{ width: `${90 - n * 12}%` }} />)}
      </div>
    ) : entree.rendu({ editing: false, poignee: null, className: 'h-full', orientation: 'vertical', compact: false })}
  </div>;
}

/** Width of a column: what a widget from the window is painted at in the hand. */
const APERCU_LARGEUR = 320;

function apercuDepuisFenetre(e: DragStartEvent, hauteur: number): Apercu {
  const carte = e.active.rect.current.initial;
  const ev = e.activatorEvent as Partial<PointerEvent>;
  const scale = Math.min(1, (APERCU_MAX * window.innerWidth) / APERCU_LARGEUR, (APERCU_MAX * window.innerHeight) / hauteur);
  // The pointer keeps the spot it picked on the thumbnail, now over the new
  // widget's title bar, wherever it is on the card.
  const px = carte && typeof ev.clientX === 'number' ? ev.clientX - carte.left : 0;
  const py = carte && typeof ev.clientY === 'number' ? ev.clientY - carte.top : 0;
  return { live: widgetIdOfDrag(String(e.active.id)), w: APERCU_LARGEUR, h: hauteur, dx: px - 28 * scale, dy: py - 14 * scale, gx: 0, gy: 0, scale };
}

export function WidgetHost({ children }: { children: React.ReactNode }) {
  const catalogue = useWidgetCatalog();

  // The STORED value, never merged: the catalogue is live (a plugin registers
  // after the page loads), and checking it against the catalogue of the moment
  // would drop the placements of plugins not there yet. The merge happens at
  // render, with the current catalogue.
  //
  // First render on what the scope has already answered: the server seed, a
  // value already read in this document, or nothing. Until it has answered
  // (`known`), the board stays empty: painting the factory defaults would show
  // an arrangement that is nobody's, replaced a second later by the account's.
  const workspace = useWorkspaceLayout();
  const { raw: stocke, update: updateLayout, ready, known } = useStoredLayout(
    workspace.key ? `${workspace.key}.widgets` : null,
    workspaceRowHandover(workspace.previousKey, 'widgets', 'cockpit'),
  );
  const [enCours, setEnCours] = useState<string | null>(null);
  // The whole widget in the hand, not a label: a snapshot taken at pickup.
  const [apercu, setApercu] = useState<Apercu | null>(null);
  const retiresRef = useRef<ReadonlySet<string>>(new Set());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const editing = paletteOpen || enCours !== null;
  // One registration per call, not per id: a chat column tab is declared
  // hidden by its column while not shown, then by its own `WidgetZone` once
  // picked. If the first disposal erased the id, the second registrant would
  // lose its zone depending on the order React runs effects in.
  const [inscrites, setInscrites] = useState<ReadonlyArray<{ jeton: number; zone: WidgetZoneDef }>>([]);
  const prochainJeton = useRef(0);
  const zones = useMemo<readonly WidgetZoneDef[]>(() => {
    const parId = new Map<ZoneId, WidgetZoneDef>();
    for (const { zone } of inscrites) {
      const deja = parId.get(zone.id);
      // The zone on screen wins over its hidden declaration.
      if (!deja || (deja.hidden && !zone.hidden)) parId.set(zone.id, zone);
    }
    return [...parId.values()];
  }, [inscrites]);

  // A chat open on a view that is not `/chat` starts from `/chat`'s places (Q14).
  const chatZonesMounted = useMemo(() => zones.some((z) => isChatZone(z.id)), [zones]);
  const layout = useMemo(
    () => workspaceWidgets(stocke, known, catalogue.entrees, workspace.view, chatZonesMounted),
    [stocke, known, catalogue, workspace.view, chatZonesMounted],
  );

  /**
   * The only write path of the placement. `op` receives the merged layout,
   * never the raw stored value, which still holds the entries of a plugin
   * missing from the catalogue. These orphans are put back at the end of what
   * is written: losing them would erase for good the place of a plugin still
   * loading, or of a plugin just turned off.
   */
  const muter = useCallback(
    (op: (l: WidgetLayout[]) => WidgetLayout[], ecrire: boolean) => {
      updateLayout((brut: unknown) => {
        const suivant = [
          ...op(mergeWorkspaceWidgets(brut, catalogue.entrees, workspace.view, chatZonesMounted)),
          ...orphelins(brut, catalogue.entrees),
        ];
        return suivant;
      }, ecrire);
    },
    [catalogue, updateLayout, workspace.view, chatZonesMounted],
  );

  /** Slots a widget declares, i.e. where admission will let it land. */
  const declaredSlotsOf = useCallback(
    (widgetId: string): readonly string[] =>
      catalogue.parId.get(widgetId)?.slots ?? DEFAULT_WIDGET_SLOTS,
    [catalogue],
  );

  /** Admission of one widget into one zone: its slots, and its flat form. */
  const admissible = useCallback(
    (widgetId: string, zone: WidgetZoneDef): boolean =>
      zoneAcceptsWidget(declaredSlotsOf(widgetId), zone, catalogue.parId.get(widgetId)?.bar === true),
    [declaredSlotsOf, catalogue],
  );

  const titreDe = useCallback(
    (widgetId: string | null): string =>
      (widgetId && catalogue.parId.get(widgetId)?.titre) || '',
    [catalogue],
  );

  const widget = useCallback(
    (id: string) => catalogue.parId.get(id),
    [catalogue],
  );

  const registerZone = useCallback((zone: WidgetZoneDef) => {
    const jeton = prochainJeton.current++;
    setInscrites((liste) => [...liste, { jeton, zone }]);
    return () => setInscrites((liste) => liste.filter((i) => i.jeton !== jeton));
  }, []);

  const sensors = useSensors(
    // A 4 px threshold: without it, a plain click on the handle would start a
    // drag and steal the focus from the neighbouring header buttons.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // The keyboard goes through the same path as the mouse: the handle is already
    // a `<button>`, dnd-kit sets its listeners on it, and the arrows move the drag
    // cursor from one card to the next, hence from one zone to the next, since
    // the collision detection is the same.
    useSensor(KeyboardSensor, { coordinateGetter: widgetKeyboardCoordinates }),
  );

  // A widget whose module is not running is removed from the layout BEFORE
  // placement: keeping it would show a card permanently in error, and removing
  // it at render would leave a hole in the column. The persisted layout is not
  // rewritten: turning the module back on brings the card back to its place.
  const caps = useCapabilities();
  const layoutVisible = useMemo(
    () => widgetsAdmisParConfig(layout, (id) => isZoneVisible(caps, `cockpit.${id}`)),
    [layout, caps],
  );
  retiresRef.current = useMemo(() => new Set(widgetsRetires(layout).map((w) => w.id)), [layout]);

  // What an agent's `widgets_get` reads, and its `widgets_propose` is checked against.
  const affichable = useCallback((id: string) => isZoneVisible(caps, `cockpit.${id}`), [caps]);
  const zonesPubliees = useMemo(
    () => zones.map((z) => ({ id: z.id, slot: z.slot, ...(z.orientation ? { orientation: z.orientation } : {}) })),
    [zones],
  );
  usePublishWidgetSnapshot({
    owner: workspace.owner, entries: catalogue.entrees, visible: affichable, view: workspace.view, zones: zonesPubliees,
  });

  const widgetsOf = useCallback(
    (zone: ZoneId) => widgetsDuRail(layoutVisible, zone),
    [layoutVisible],
  );

  const accepts = useCallback(
    (zone: WidgetZoneDef) => (enCours === null ? true : admissible(enCours, zone)),
    [enCours, admissible],
  );

  // Removing and putting back write right away: they are one-off gestures, not
  // a stream of pixels like resizing.
  // The toast brings the widget back exactly where it was — zone, rank, stack —
  // from the placement read before the removal. A removal is one click in a
  // menu, so the way back has to be as cheap as the way out. Skipped when the
  // widget has been put back by other means in the meantime. Only that widget
  // goes back (`remettreWidget`): writing the whole placement from before
  // would undo, too, whatever another window changed since (TODO #647).
  const stockeRef = useRef(stocke);
  stockeRef.current = stocke;
  const onRemove = useCallback(
    (id: string) => {
      const avant = mergeWorkspaceWidgets(stockeRef.current, catalogue.entrees, workspace.view, chatZonesMounted);
      muter((l) => retirerWidget(l, id), true);
      toast(t('widgets.removed', { title: catalogue.parId.get(id)?.titre ?? id }), {
        action: {
          label: t('widgets.undo'),
          onClick: () => { if (!retiresRef.current.has(id)) return; muter((l) => remettreWidget(l, avant, id), true); },
        },
      });
    },
    [muter, catalogue, workspace.view, chatZonesMounted],
  );
  const onReplace = useCallback(
    (id: string, replacement: string) => muter((l) => remplacerWidget(l, id, replacement), true),
    [muter],
  );

  const admis = useCallback(
    (widgetId: string, zoneId: ZoneId) => {
      const zone = zones.find((z) => z.id === zoneId);
      return zone ? admissible(widgetId, zone) : false;
    },
    [zones, admissible],
  );

  // The inventory only shows what the host would display: `layoutVisible` has
  // already dropped the widgets hidden by `ui.hidden` and those whose module is
  // not running. A single visibility predicate, and the palette is a subset of
  // it, never a second list to keep in agreement with the first.
  //
  // The list is recomputed DURING the gesture: a widget pulled out of the
  // palette stops being removed as soon as it is hovered, its row leaves the
  // inventory and the card appears in the zone under the SAME dnd-kit id. That
  // is the usual cross-container move, which follows its node from one parent
  // to another; freezing the inventory during the drag would render it twice,
  // hence two nodes registered under a single id.
  const retires = useMemo(() => widgetsDisponibles(layoutVisible, zones.map(z => z.id)), [layoutVisible, zones]);

  /** Mounted zone that would take the widget back, its default zone by preference. */
  const restoreTargetOf = useCallback(
    (id: string): ZoneId | null => {
      const admises = zones.filter((z) => admissible(id, z));
      const prefere = catalogue.parId.get(id)?.railDefaut;
      // A click putting the card into a hidden tab would make it vanish
      // before the eyes of whoever just asked for it.
      return (admises.find((z) => z.id === prefere && !z.hidden)
        ?? admises.find((z) => !z.hidden)
        ?? admises[0])?.id ?? null;
    },
    [zones, admissible, catalogue],
  );

  // The pointer-free path: put the widget back in a zone that is REALLY
  // mounted. Putting it on its default zone without checking would make it
  // vanish from a page that does not mount that zone: out of the inventory, and
  // visible nowhere.
  const onRestore = useCallback(
    (id: string, destination?: ZoneId) => {
      const zone = destination ?? restoreTargetOf(id);
      if (!zone || !admis(id, zone)) return;
      muter((l) => deplacerWidget(l, id, zone, null), true);
    },
    [restoreTargetOf, admis, muter],
  );

  const onMergeZone = useCallback(
    (from: ZoneId, to: ZoneId) => muter((l) => verserZone(l, from, to), true),
    [muter],
  );

  // Navigation invalidates any gesture started in the previous workspace.
  useEffect(() => { setEnCours(null); }, [workspace.key]);
  const onDragStart = useCallback((e: DragStartEvent) => {
    if (!ready) return;
    setEnCours(widgetIdOfDrag(String(e.active.id)));
    const id = widgetIdOfDrag(String(e.active.id));
    setApercu(captureApercu(String(e.active.id), e) ?? apercuDepuisFenetre(e, catalogue.parId.get(id)?.hauteurDefaut ?? 260));
  }, [ready, catalogue]);

  useEffect(() => { setPaletteOpen(false); }, [workspace.owner]);

  // Docking and insertion have distinct targets. Hover never mutates the
  // layout: a disappearing source must not displace the target under the pointer.
  const onDragEnd = useCallback((e: DragEndEvent) => {
    setEnCours(null);
    const id = widgetIdOfDrag(String(e.active.id));
    const over = e.over ? String(e.over.id) : null;
    if (!over || enCours === null) return;
    muter((l) => {
      // Drop after the last tab: the only way to put a widget from elsewhere at the
      // end of the stack, since a tab only orders around itself.
      if (over.startsWith('tab-end:')) {
        const target = l.find((w) => w.id === over.slice(8) && !w.removed);
        const source = l.find((w) => w.id === id && !w.removed);
        if (!target) return l;
        const memePile = !!source?.group && source.group === target.group && source.rail === target.rail;
        return memePile || admis(id, target.rail) ? placerEnFinDePile(l, id, target.id) : l;
      }
      // Drop on a tab: reorder if it is the same stack, dock otherwise. It is the
      // same gesture from the user's side, "put it here".
      if (over.startsWith('tab:')) {
        const cible = over.slice(4);
        const source = l.find((w) => w.id === id && !w.removed);
        const target = l.find((w) => w.id === cible && !w.removed);
        if (!target || cible === id) return l;
        if (source?.group && source.group === target.group && source.rail === target.rail) {
          return deplacerOnglet(l, id, cible);
        }
        // From elsewhere: dock, then move BEFORE the hovered tab. `dockWidget` alone
        // would put the new tab at the head of the stack, far from the line the user
        // saw under the pointer.
        return admis(id, target.rail) ? deplacerOnglet(dockWidget(l, id, target.id), id, cible, 'avant') : l;
      }
      const docking = over.startsWith('dock:');
      const insertion = over.startsWith('insert:');
      const targetId = docking ? over.slice(5) : insertion ? over.slice(7) : over;
      const target = l.find((w) => w.id === targetId && !w.removed);
      const zone = /^(rail:|zone:)/.test(over) ? over.slice(5) : target?.rail;
      if (!zone || !admis(id, zone) || targetId === id) return l;
      if (docking && target) {
        const grouped = dockWidget(l, id, target.id);
        const group = grouped.find((w) => w.id === id)?.group;
        const minimum = Math.max(...grouped.filter((w) => w.group === group && w.rail === zone).map((w) => catalogue.parId.get(w.id)?.hauteurMin ?? 0)) + 36;
        return redimensionner(grouped, id, Math.max(target.hauteur, minimum), minimum);
      }
      return deplacerWidget(l, id, zone, target?.id ?? null);
    }, true);
  }, [muter, admis, enCours, catalogue]);

  const onShares = useCallback((shares: ReadonlyArray<{ id: string; percent: number }>, persist: boolean) =>
    muter((l) => repartirHauteurs(l, shares), persist), [muter]);


  const onSelectTab = useCallback((id: string) => muter((l) => selectWidgetTab(l, id), true), [muter]);
  const onDetach = useCallback((id: string) => muter((l) => {
    const entry = l.find((w) => w.id === id);
    return entry ? deplacerWidget(l, id, entry.rail, null) : l;
  }, true), [muter]);
  const onStyle = useCallback((id: string, patch: { borderless?: boolean | undefined; transparent?: boolean | undefined; untitled?: boolean }) =>
    muter((l) => l.map((w) => {
      if (w.id !== id) return w;
      const next = { ...w, ...patch };
      // A choice is dated: it outranks the site's style only if made after the
      // style's last change. Removing the choice removes its date.
      if ('borderless' in patch) { if (patch.borderless === undefined) delete next.borderlessAt; else next.borderlessAt = Date.now(); }
      if ('transparent' in patch) { if (patch.transparent === undefined) delete next.transparentAt; else next.transparentAt = Date.now(); }
      return next;
    }), true), [muter]);

  // Hover has not changed state, so Escape only dismisses the preview.
  const onDragCancel = useCallback(() => setEnCours(null), []);

  // The closed hand follows the whole gesture, over any element: the pointer
  // is captured by the drag, so a per-element cursor would flicker.
  useEffect(() => {
    if (enCours === null) { setApercu(null); return; }
    document.documentElement.classList.add('widget-dragging');
    return () => document.documentElement.classList.remove('widget-dragging');
  }, [enCours]);

  const titreEnCours = enCours ? titreDe(enCours) : null;

  // Without these messages, a keyboard user hears "button" and nothing else:
  // neither where the widget is, nor what the next arrow will do.
  const instructions = useMemo<ScreenReaderInstructions>(
    () => ({ draggable: t('widgets.a11y.instructions') }),
    [],
  );
  // What the screen reader names: a widget by its title, a zone by its label.
  // Never the drop id, which means nothing to the ear.
  const nomDeCible = useCallback(
    (id: string) => {
      if (id.startsWith('tab-end:')) return t('widgets.lastTabWith', { title: titreDe(id.slice(8)) });
      if (id.startsWith('tab:')) return t('widgets.groupWith', { title: titreDe(id.slice(4)) });
      if (id.startsWith('dock:')) return t('widgets.groupWith', { title: titreDe(id.slice(5)) });
      if (id.startsWith('insert:')) return t('widgets.insertBefore', { title: titreDe(id.slice(7)) });
      if (!isZoneDropId(id)) return titreDe(id);
      const zone = zones.find((z) => zoneDropId(z.id) === id);
      return zone?.label ?? '';
    },
    [zones, titreDe],
  );

  const announcements = useMemo<Announcements>(
    () => ({
      onDragStart: ({ active }) => t('widgets.a11y.picked', { title: titreDe(widgetIdOfDrag(String(active.id))) }),
      onDragOver: ({ active, over }) => {
        const cible = over ? nomDeCible(String(over.id)) : '';
        return cible
          ? t('widgets.a11y.over', { title: titreDe(widgetIdOfDrag(String(active.id))), target: cible })
          : undefined;
      },
      onDragEnd: ({ active }) => t('widgets.a11y.dropped', { title: titreDe(widgetIdOfDrag(String(active.id))) }),
      onDragCancel: ({ active }) => t('widgets.a11y.cancelled', { title: titreDe(widgetIdOfDrag(String(active.id))) }),
    }),
    [nomDeCible, titreDe],
  );

  const valeur = useMemo<WidgetHostValue>(
    () => ({
      editing, paletteOpen, setPaletteOpen, zones,
      widgetsOf,
      registerZone,
      dragging: enCours,
      accepts,
      palette: retires,
      widget,
      onRemove,
      onReplace,
      restoreTargetOf,
      onRestore,
      onMergeZone,
      onShares,
      onSelectTab, onDetach, onStyle,
    }),
    [
      editing, paletteOpen, zones,
      widgetsOf,
      registerZone,
      enCours,
      accepts,
      retires,
      widget,
      onRemove,
      onReplace,
      restoreTargetOf,
      onRestore,
      onMergeZone,
      onShares,
      onSelectTab, onDetach, onStyle,
    ],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={widgetCollision}
      accessibility={{ announcements, screenReaderInstructions: instructions }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <WidgetHostContext.Provider value={valeur}>
        {children}
        {paletteOpen && <WidgetPalette />}
      </WidgetHostContext.Provider>

      <DragOverlay dropAnimation={null}>
        {apercu?.live ? <WidgetHostContext.Provider value={valeur}><ApercuVivant apercu={apercu} id={apercu.live} /></WidgetHostContext.Provider> : apercu ? <ApercuWidget apercu={apercu} /> : titreEnCours ? (
          <div
            className={cn(
              'flex items-center gap-2 rounded-2xl border px-4 py-2.5 shadow-lg',
              HUD_SURFACE,
            )}
          >
            <GripVertical className="size-3.5 text-primary/70" />
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {titreEnCours}
            </span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
