'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { GripHorizontal, GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMobile } from '@/hooks/use-mobile';
import { t } from '@/lib/i18n';
import { useWidgetHost } from './widget-host';
import { coteInsertion, type WidgetLayout } from './widget-layout';
import { CONTROL, WidgetContextMenu, WidgetGear, wantsNativeMenu } from './widget-menu';
import { effectiveWidgetStyle, useWidgetStyleDefaults } from './use-widget-style';
import type { WidgetOrientation } from './widget-dnd';

/** Side where the insertion cursor is drawn on `targetId`. A widget coming
 *  from another stack has no rank here: it lands BEFORE the hovered tab,
 *  which the drop applies literally. */
function coteDuCurseur(members: WidgetLayout[], dragging: string | null, targetId: string): 'avant' | 'apres' | null {
  if (!dragging || dragging === targetId) return null;
  if (!members.some((m) => m.id === dragging)) return 'avant';
  return coteInsertion(members, dragging, targetId);
}

/** A tab is a drag source AND a drop target, at any time: a stack is reordered
 *  between its tabs, not in the card's body, which belongs to docking. */
function WidgetTab({ entry, selected, onSelect, panelId, cote }: { entry: WidgetLayout; selected: boolean; onSelect: () => void; panelId: string; cote: 'avant' | 'apres' | null }) {
  const host = useWidgetHost();
  const { listeners, setNodeRef, isDragging } = useDraggable({ id: entry.id });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `tab:${entry.id}`, disabled: !host.editing || host.dragging === entry.id });
  const curseur = isOver && cote !== null && host.dragging !== entry.id ? cote : null;
  // Only the pointer lifts a tab: dnd-kit's attributes and keyboard listener
  // would turn Enter and Space on a tab into a drag. A tab keeps its tab
  // semantics; the stack's grip carries the keyboard drag.
  return <button ref={(node) => { setNodeRef(node); setDropRef(node); }} type="button"
    onPointerDown={listeners?.onPointerDown as React.PointerEventHandler<HTMLButtonElement> | undefined}
    role="tab" id={`tab-${entry.id}`} aria-controls={panelId} aria-selected={selected}
    tabIndex={selected ? 0 : -1} onClick={onSelect}
    className={cn('widget-tab relative flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring', selected ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground', isDragging && 'opacity-40')}>
    {/* A line BETWEEN two tabs, not a highlighted tab: highlighting the
        target shows what is hovered, which still leaves you guessing on which
        side the tab will fall. The side is the one `coteInsertion` will decide
        on drop; same function, so the line cannot lie. */}
    {curseur && <span aria-hidden data-cursor={curseur} className={cn('pointer-events-none absolute inset-y-0.5 z-10 w-[3px] rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]', curseur === 'avant' ? '-left-[2px]' : '-right-[2px]')} />}
    <span className="max-w-40 truncate">{host.widget(entry.id)?.titre}</span>
  </button>;
}

/** The free space after the tab group: the target that puts a widget at the
 *  END of the stack. A tab only orders around itself, and a widget from
 *  elsewhere lands before it; without this target, the last place was out of
 *  reach. Outside the tablist, `min-w-6` keeps it visible even when the tabs
 *  overflow. */
function WidgetTabEnd({ entree, members }: { entree: WidgetLayout; members: WidgetLayout[] }) {
  const host = useWidgetHost();
  const { setNodeRef, isOver } = useDroppable({ id: `tab-end:${entree.id}`, disabled: !host.editing });
  // Already last: the drop changes nothing, the line must promise nothing.
  const curseur = isOver && !!host.dragging && members[members.length - 1]?.id !== host.dragging;
  return <div ref={setNodeRef} aria-hidden className="relative h-8 min-w-2 flex-1 self-center">
    {curseur && <span className="pointer-events-none absolute inset-y-0.5 left-0 z-10 w-[3px] rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]" />}
  </div>;
}

/** What a press may never lift the card from: the controls inside the title
 *  bar keep their own click, and a tab lifts itself. */
const INTERACTIF = 'button, a[href], input, textarea, select, label, summary, [role="button"], [role="tab"], [role="menuitem"], [role="slider"], [contenteditable=""], [contenteditable="true"], [data-no-drag]';

/** Height of the strip a card without a header row is lifted by. */
const BANDE_SANS_ENTETE = 28;

/** How long the pointer rests on a title before the drag hint shows. */
export const DELAI_INDICE_DRAG = 2000;

/** The widget's own title bar: the header of the section it paints, if any. */
function enteteDe(frame: HTMLElement): HTMLElement | null {
  return frame.querySelector<HTMLElement>(':scope > .widget-content > section > header');
}

/**
 * Whether a press at `target` lifts the card: its title bar, a stack's tab
 * strip (between the tabs), the whole of a bare form — never a control. A card
 * that paints no header is lifted by its top strip.
 */
export function surPoigneeTitre(
  frame: HTMLElement, target: Element, clientY: number, forme: { bare: boolean; tabbed: boolean }, ongletsCompris = false,
): boolean {
  if (!frame.contains(target)) return false;
  // A stack's tabs ARE its titles: they arm the hint and take the right
  // click. They are left out of the press only, since each lifts itself.
  const onglet = forme.tabbed && ongletsCompris ? target.closest('.widget-tabbar [role="tab"]') : null;
  if (onglet && frame.contains(onglet)) return true;
  const controle = target.closest(INTERACTIF);
  if (controle && frame.contains(controle)) return false;
  if (forme.bare) return true;
  if (forme.tabbed) return !!target.closest('.widget-tabbar');
  const entete = enteteDe(frame);
  if (entete) return entete.contains(target);
  return clientY - frame.getBoundingClientRect().top <= BANDE_SANS_ENTETE;
}

/** A stack has a tab strip and a single visible body. Tabs themselves remain
 * drag sources so they can be detached, reordered or docked into another stack.
 *
 * There is no layout mode: a card is lifted by its title at any time. Resting
 * the pointer on the title for `DELAI_INDICE_DRAG` shows the hint — the grab
 * cursor, and a small pill with the grip and the gear at the top of the card
 * (`data-drag-ready`). The gear's menu also opens by a right click on the
 * title. Heights are the zone's business (`WidgetZone`): a card only receives
 * its share of the column, `part`.
 *
 * On a horizontal zone (the top bar) a card has no frame of its own: no height,
 * no style menu, no docking — a stack of tabs has no room on a 36px line. Only
 * the grip and the gear remain, next to the widget's flat form, once hinted.
 *
 * A compact column (a sidebar) does the same for a widget that has a compact
 * form (`bar: true`) and stands alone: it takes its natural height, its icons
 * stacked. Any other widget keeps its card there, and a stack keeps its tabs. */
export function WidgetCard({ entree, members = [entree], part, orientation = 'vertical', compact = false }: {
  entree: WidgetLayout;
  members?: WidgetLayout[];
  /** Share of the column's height (a flex weight); absent = natural height. */
  part?: number;
  orientation?: WidgetOrientation;
  /** The zone is a narrow column: a widget with a compact form paints it. */
  compact?: boolean;
}) {
  const host = useWidgetHost();
  const siteStyle = useWidgetStyleDefaults();
  const style = effectiveWidgetStyle(entree, siteStyle);
  const widget = host.widget(entree.id);
  const horizontal = orientation === 'horizontal';
  const grouped = members.length > 1 && !horizontal;
  // The frame-less form: always on a line, and in a compact column for a lone
  // widget that knows how to paint it.
  const bare = horizontal || (compact && !grouped && widget?.bar === true);
  // Only a stack has tabs: a lone widget shows its title in its own header,
  // and an untitled one drops even that — a stack ignores the flag, it needs
  // its tabs.
  const untitled = !grouped && !!entree.untitled;
  const tabbed = grouped;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({ id: tabbed ? `frame:${entree.id}` : entree.id });
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const { setNodeRef: setDockRef, isOver } = useDroppable({ id: `dock:${entree.id}`, disabled: bare || !host.editing || host.dragging === entree.id });
  const mobile = useMobile();
  const tablist = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const memberKey = members.map((m) => m.id).join('|');
  // The drag hint: armed while the pointer rests on the title, shown after
  // the delay, kept until the pointer leaves the card — the pill it shows
  // sits below the title, and must stay while the pointer goes to it.
  const [pret, setPret] = useState(false);
  const minuteur = useRef<ReturnType<typeof setTimeout> | null>(null);
  const desarmer = useCallback(() => {
    if (minuteur.current !== null) { clearTimeout(minuteur.current); minuteur.current = null; }
  }, []);
  useEffect(() => desarmer, [desarmer]);
  useEffect(() => { if (host.dragging) { desarmer(); setPret(false); } }, [host.dragging, desarmer]);
  // The scrollbar is hidden, so a mouse without a horizontal wheel needs its
  // vertical wheel translated. Non-passive listener (React's onWheel is passive,
  // it cannot preventDefault), and only while the strip can still move that
  // way: at either end the page keeps its scroll.
  useEffect(() => {
    const el = tablist.current;
    if (!tabbed || !el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth + 1 || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1);
      const max = el.scrollWidth - el.clientWidth;
      if ((delta < 0 && el.scrollLeft <= 0) || (delta > 0 && el.scrollLeft >= max - 1)) return;
      e.preventDefault();
      el.scrollLeft = Math.min(max, Math.max(0, el.scrollLeft + delta));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { el.removeEventListener('wheel', onWheel); };
  }, [tabbed, memberKey]);
  // Brings the selected tab back into view, keyboard included. Done by hand on
  // the strip: `scrollIntoView` would also scroll the page to a card below the
  // fold when it mounts.
  useEffect(() => {
    const el = tablist.current;
    const tab = el?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!el || !tab) return;
    const box = el.getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    const left = rect.left - box.left + el.scrollLeft;
    const right = left + rect.width;
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
  }, [entree.id, memberKey]);
  if (!widget) return null;
  const minimum = Math.max(...members.map((member) => host.widget(member.id)?.hauteurMin ?? 0)) + (tabbed ? 46 : 0);
  const panelId = `panel-${entree.id}`;
  const forme = { bare, tabbed };
  const surTitre = (e: { target: EventTarget | null; clientY: number }, ongletsCompris = false) =>
    !!frame.current && e.target instanceof Element && surPoigneeTitre(frame.current, e.target, e.clientY, forme, ongletsCompris);
  // Keyboard drag goes through the grip (a real button), shown in the pill.
  const grip = <button type="button" ref={setActivatorNodeRef} aria-label={t('cockpit.board.move', { title: widget.titre })} className={cn(CONTROL, 'cursor-grab touch-none active:cursor-grabbing')} {...attributes} {...listeners}>{bare ? <GripVertical className="size-3.5" /> : <GripHorizontal className="size-3.5" />}</button>;
  const gear = <WidgetGear entree={entree} grouped={grouped} bare={bare} />;
  // A bare form has no title bar to float a pill over: the grip leads, the
  // gear follows it, in a box as tall as the line — once hinted.
  const montrerOutils = pret || host.paletteOpen;
  const inline = bare && montrerOutils ? <span className="flex shrink-0 items-center self-center">{gear}</span> : null;
  const leadingGrip = bare && montrerOutils ? <span className="flex shrink-0 items-center self-center">{grip}</span> : null;
  const openMenu = (e: React.MouseEvent) => { e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }); };
  return <div ref={(node) => { setNodeRef(node); frame.current = node; }}
    onPointerDown={(e) => {
      if (e.button !== 0 || !surTitre(e)) return;
      (listeners?.onPointerDown as React.PointerEventHandler<HTMLDivElement> | undefined)?.(e);
    }}
    onPointerMove={(e) => {
      if (e.pointerType !== 'mouse' || host.dragging || pret) return;
      if (!surTitre(e, true)) { desarmer(); return; }
      if (minuteur.current === null) minuteur.current = setTimeout(() => { minuteur.current = null; setPret(true); }, DELAI_INDICE_DRAG);
    }}
    onPointerLeave={() => { desarmer(); setPret(false); }}
    // The title bar's right click is the gear's menu; a stack's strip brings
    // the tab under the pointer forward first, the menu is about it.
    onContextMenu={(e) => {
      if (wantsNativeMenu(e.target) || !surTitre(e, true)) return;
      if (tabbed) {
        const tab = (e.target as Element).closest<HTMLElement>('[role="tab"]');
        const id = tab?.id.startsWith('tab-') ? tab.id.slice(4) : null;
        if (id && id !== entree.id) host.onSelectTab(id);
      }
      openMenu(e);
    }}
    data-widget-id={entree.id} data-borderless={style.borderless || undefined} data-transparent={style.transparent || undefined} data-tabbed={tabbed || undefined} data-untitled={untitled || undefined}
    // A phone stacks cards at their natural height; only the cockpit's centre
    // still stretches its `fill` cards there (cockpit-board.tsx).
    data-height-mode={(mobile ? entree.heightMode === 'fill' : part !== undefined) ? 'fill' : 'fixed'}
    data-drag-ready={pret || undefined}
    // Flex basis at ZERO, and the share as the grow factor: the distributed space
    // is then the whole free height, so three cards at 33 % are equal.
    // `minHeight` stays the floor: a share too small cannot crush a widget below
    // its useful size.
    // `0px` is the same basis as `0`; jsdom drops the whole shorthand without the unit.
    data-orientation={orientation}
    data-compact={bare || undefined}
    style={mobile || bare || part === undefined ? undefined : { flex: `${part / 100} 0 0px`, minHeight: minimum }}
    className={cn('widget-frame group/widget relative flex shrink-0', horizontal ? 'h-full items-center' : 'min-w-0 flex-col', tabbed && 'widget-stack overflow-hidden rounded-xl border border-border bg-card', isDragging && 'opacity-40')}>
    {/* Stack: the whole card carries the frame, and the tab group lives
        INSIDE it, at the top, with no line separating it from the content. */}
    {tabbed && <div className="widget-tabbar relative z-[1] mb-1.5 flex h-10 shrink-0 items-center px-1.5 pt-1.5"><div ref={tablist} role="tablist" aria-label={t('widgets.tabs')} className="widget-tablist flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-lg bg-muted p-[3px]"
      onKeyDown={(e) => {
        if (host.dragging) return;
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const index = members.findIndex((w) => w.id === entree.id);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? members.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + members.length) % members.length;
        host.onSelectTab(members[next]!.id);
        document.getElementById(`tab-${members[next]!.id}`)?.focus();
      }}>
      {members.map((entry) => <WidgetTab key={entry.id} entry={entry} selected={entry.id === entree.id} onSelect={() => host.onSelectTab(entry.id)} panelId={`panel-${entry.id}`} cote={coteDuCurseur(members, host.dragging, entry.id)} />)}
    </div><WidgetTabEnd entree={entree} members={members} /></div>}
    {/* The hint: a pill at the top of the card, over the middle of its title
        bar, with the grip (the keyboard's way to move it) and the gear. It
        stays reachable from the keyboard: focusing it shows it. */}
    {!bare && <div data-widget-hint className={cn('widget-chrome absolute left-1/2 top-1.5 z-30 flex -translate-x-1/2 items-center gap-0.5 rounded-lg bg-popover/95 p-0.5 shadow-elev-2 ring-1 ring-border transition-opacity duration-150',
      montrerOutils ? 'opacity-100' : 'pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100')}>{grip}{gear}</div>}
    {leadingGrip}
    <div id={panelId} role={tabbed ? 'tabpanel' : undefined} aria-labelledby={tabbed ? `tab-${entree.id}` : undefined} className={cn('widget-content flex', horizontal ? 'h-full items-center gap-0.5' : bare ? 'min-w-0 flex-col items-start' : 'min-h-0 min-w-0 flex-1 flex-col', tabbed && 'overflow-hidden', host.dragging && !bare && '[&_*]:!pointer-events-none pointer-events-none')}>
      {widget.rendu({ editing: host.editing || pret, className: mobile || bare ? undefined : 'h-full', poignee: inline ?? undefined, onReplace: (id) => host.onReplace(entree.id, id), orientation, compact: bare })}
    </div>
    {grouped && members.filter((entry) => entry.id !== entree.id).map((entry) => (
      <div key={entry.id} id={`panel-${entry.id}`} role="tabpanel" aria-labelledby={`tab-${entry.id}`} hidden />
    ))}
    {/* The docking target covers the whole card (the surface the hand
        aims at), but the veil is drawn on the TAB BAR, at the top: that is
        where the dropped widget will appear. */}
    {!bare && <div ref={setDockRef} className="pointer-events-none absolute inset-0 z-20">
      {isOver && host.dragging && (
        <div className="absolute inset-x-0 top-0 flex h-9 items-center justify-center gap-2 rounded-t-xl border-2 border-primary bg-primary/25 px-3">
          <span className="truncate text-xs font-medium text-foreground">{t('widgets.dockHint')}</span>
        </div>
      )}
    </div>}
    <WidgetContextMenu entree={entree} grouped={grouped} bare={bare} at={menuAt} onClose={() => setMenuAt(null)} />
  </div>;
}
