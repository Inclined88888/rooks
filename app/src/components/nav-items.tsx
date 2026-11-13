'use client';

/**
 * The entries of `nav.item`, in the order the person chose (`lib/nav-order.ts`):
 * the main list here, the foot of the menu in `NavFooter`.
 *
 * The host, not the entry, owns what makes a row movable and hidable: a
 * third-party plugin paints its own link (it cannot import `NavLink`), and a
 * row that relied on the entry to join the drag and drop or to honour `hidden`
 * left every plugin page stuck after the product's and impossible to hide
 * (TODO #456). So a hidden entry is simply not painted, and in "Customize the
 * menu" every entry that carries a path is wrapped in a sortable row with its
 * grip and its eye, its own content made inert.
 *
 * Separators and the boundary of the foot are rows of the same sortable list.
 * A separator is a gap — no rule is drawn (AGENTS.md rule 16).
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type Modifier,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDownToLine, Eye, EyeOff, GripVertical, Plus, X } from 'lucide-react';
import { useSlotEntries } from '@/lib/plugin-host/render';
import { PluginBoundary } from '@/lib/plugin-host/plugin-boundary';
import type { SlotEntry } from '@/lib/plugin-host/slots';
import {
  NAV_FOOTER_MARK,
  NAV_SEPARATOR,
  isNavPath,
  keepAbsentPaths,
  layoutNav,
  moveKey,
  navEditIds,
  navLayoutFromIds,
  visibleNavRows,
  type NavLayout,
  type NavRow,
} from '@/lib/nav-order';
import { NavChromeProvider, useNavChrome } from '@/components/nav-link';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

export const NAV_ITEM_SLOT = 'nav.item';

export type NavMenu = { main: NavRow<SlotEntry>[]; footer: NavRow<SlotEntry>[]; present: ReadonlySet<string> };
export type NavLayoutChange = (layout: { order: string[]; footer: string[] }) => void;

/** The rows of the menu: the registered entries placed by the stored menu. */
export function useNavMenu(stored: NavLayout): NavMenu {
  const entries = useSlotEntries(NAV_ITEM_SLOT);
  const present = new Set(entries.flatMap((e) => (isNavPath(e.key) ? [e.key] : [])));
  return { ...layoutNav(entries, (e) => e.key, stored), present };
}

/** A separator outside of the editor: a gap, never a drawn rule. */
export function NavGap(): React.ReactElement {
  return <div aria-hidden data-nav-separator="" className="h-3 shrink-0" />;
}

function renderEntry(entry: SlotEntry): React.ReactElement {
  const { Component } = entry;
  return <PluginBoundary key={entry.id} pluginId={entry.pluginId}><Component /></PluginBoundary>;
}

/** What the menu paints outside of the editor: hidden entries left out, a separator only between two entries. */
export function renderNavRows(rows: readonly NavRow<SlotEntry>[], hidden: readonly string[]): React.ReactElement[] {
  return visibleNavRows(rows, hidden).map((row) => (row.kind === 'separator' ? <NavGap key={row.id} /> : renderEntry(row.entry)));
}

// A menu is a column: a sideways pull would only drag the row out of the rail.
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

function labelOf(data: unknown): string {
  const label = (data as { label?: unknown } | undefined)?.label;
  return typeof label === 'string' ? label : '';
}

/**
 * An edit-mode row that moves by drag and drop. The whole row takes the
 * pointer; the keyboard goes through the grip, a real button, so that Enter on
 * the eye beside it hides the page instead of picking the row up (dnd-kit only
 * starts a keyboard drag from the activator node).
 */
function SortableRow({ id, label, className, children }: { id: string; label: string; className?: string; children: ReactNode }): React.ReactElement {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, data: { label } });
  const text = t('nav.reorder', { page: label });
  return (
    <div
      ref={setNodeRef}
      data-nav-row={id}
      {...listeners}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'relative flex shrink-0 cursor-grab select-none items-center rounded-md text-[12.5px] motion-reduce:!transition-none',
        className,
        isDragging && 'z-10 cursor-grabbing bg-muted shadow-elev-2',
      )}
    >
      {/* In the row's left padding: the label keeps all of its width. */}
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        aria-label={text}
        title={text}
        className="absolute inset-y-0 left-0 z-[1] flex w-3 touch-none cursor-grab items-center justify-center rounded-sm text-muted-foreground/50 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      >
        <GripVertical className="size-3" />
      </button>
      {children}
    </div>
  );
}

const rowButton = 'shrink-0 cursor-pointer rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

/**
 * An entry in the editor. Its own content stays what the plugin paints, made
 * inert so that a click on it never navigates; the label the grip and the
 * announcements speak is read from that content, the only place a third-party
 * entry states it.
 */
function EntryRow({ id, entry }: { id: string; entry: SlotEntry }): React.ReactElement {
  const chrome = useNavChrome();
  const { hidden, onToggleHidden } = chrome;
  const content = useRef<HTMLDivElement>(null);
  const [label, setLabel] = useState(id);
  useLayoutEffect(() => {
    const node = content.current;
    if (!node) return;
    // React 18 has no `inert` prop.
    node.setAttribute('inert', '');
    const text = node.textContent?.trim();
    if (text && text !== label) setLabel(text);
  });
  const isHidden = hidden?.includes(id) ?? false;
  const toggle = t(isHidden ? 'nav.showPage' : 'nav.hidePage', { page: label });
  return (
    <SortableRow id={id} label={label}>
      <div ref={content} className={cn('pointer-events-none min-w-0 flex-1 overflow-hidden', isHidden && 'opacity-60')}>
        <NavChromeProvider value={{ ...chrome, editRow: true }}>{renderEntry(entry)}</NavChromeProvider>
      </div>
      {onToggleHidden && (
        <button type="button" onClick={() => onToggleHidden(id)} aria-pressed={!isHidden} aria-label={toggle} title={toggle} className={rowButton}>
          {isHidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      )}
    </SortableRow>
  );
}

function SeparatorRow({ id, onRemove }: { id: string; onRemove: () => void }): React.ReactElement {
  return (
    <SortableRow id={id} label={t('nav.separator')} className="my-1 bg-muted/50 pl-3 text-muted-foreground">
      <span className="min-w-0 flex-1 truncate py-0.5 text-[11.5px]">{t('nav.separator')}</span>
      <button type="button" onClick={onRemove} aria-label={t('nav.removeSeparator')} title={t('nav.removeSeparator')} className={rowButton}>
        <X className="size-3.5" />
      </button>
    </SortableRow>
  );
}

/** The boundary of the foot: what is dropped under it sits at the bottom of the menu, above Settings. */
function FooterMarkRow(): React.ReactElement {
  return (
    <SortableRow id={NAV_FOOTER_MARK} label={t('nav.footerMark')} className="mt-3 gap-3 px-3 py-1.5 text-[11.5px] text-muted-foreground">
      <ArrowDownToLine className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={t('nav.footerMarkHint')}>{t('nav.footerMark')}</span>
    </SortableRow>
  );
}

function EditableNav({ menu, stored, onLayoutChange, onDraggingChange }: {
  menu: NavMenu;
  stored: NavLayout;
  onLayoutChange: NavLayoutChange;
  onDraggingChange?: (dragging: boolean) => void;
}): React.ReactElement {
  const chrome = useNavChrome();
  const ids = navEditIds(menu);
  // Only the moved rows are the person's: a page of a plugin switched off keeps its stored place.
  const commit = (next: readonly string[]) => onLayoutChange(keepAbsentPaths(stored, navLayoutFromIds(next), menu.present));
  const sensors = useSensors(
    // 4 px, as in the widget host: a plain click on the row's eye must stay a click.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const position = (id: UniqueIdentifier) => ({ position: ids.indexOf(String(id)) + 1, count: ids.length });
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('nav.a11y.picked', { page: labelOf(active.data.current) }),
    onDragOver: ({ active, over }) => (over ? t('nav.a11y.over', { page: labelOf(active.data.current), ...position(over.id) }) : undefined),
    onDragEnd: ({ active, over }) => t('nav.a11y.dropped', { page: labelOf(active.data.current), ...position(over?.id ?? active.id) }),
    onDragCancel: ({ active }) => t('nav.a11y.cancelled', { page: labelOf(active.data.current) }),
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    onDraggingChange?.(false);
    if (over && active.id !== over.id) commit(moveKey(ids, String(active.id), String(over.id)));
  };
  const addSeparator = () => {
    const mark = ids.indexOf(NAV_FOOTER_MARK);
    commit([...ids.slice(0, mark), NAV_SEPARATOR, ...ids.slice(mark)]);
  };
  const row = (r: NavRow<SlotEntry>) => {
    if (r.kind === 'separator') return <SeparatorRow key={r.id} id={r.id} onRemove={() => commit(ids.filter((id) => id !== r.id))} />;
    // An entry with no path cannot be named by the order: it shows, in place, as it is.
    if (r.id === null) return renderEntry(r.entry);
    return <EntryRow key={r.id} id={r.id} entry={r.entry} />;
  };
  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[verticalOnly]}
        accessibility={{ announcements, screenReaderInstructions: { draggable: t('nav.a11y.instructions') } }}
        onDragStart={() => onDraggingChange?.(true)}
        onDragEnd={onDragEnd}
        onDragCancel={() => onDraggingChange?.(false)}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <NavChromeProvider value={chrome}>
            {menu.main.map(row)}
            <FooterMarkRow />
            {menu.footer.map(row)}
          </NavChromeProvider>
        </SortableContext>
      </DndContext>
      <button
        type="button"
        onClick={addSeparator}
        className="mt-1 flex shrink-0 items-center gap-3 whitespace-nowrap rounded-md px-3 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Plus className="size-4 shrink-0" />
        <span>{t('nav.addSeparator')}</span>
      </button>
    </>
  );
}

/** True when the menu paints its editor: "Customize the menu" is on and the labels show. */
export function isNavEditable(chrome: { editing?: boolean; expanded: boolean; forceLabel: boolean }): boolean {
  return !!chrome.editing && (chrome.expanded || chrome.forceLabel);
}

export function NavItems({ stored, onLayoutChange, onDraggingChange }: {
  stored: NavLayout;
  /** The menu after a change in the editor (a drop, a separator added or removed). */
  onLayoutChange?: NavLayoutChange;
  /** While a row is held: the rail must not fold under the pointer. */
  onDraggingChange?: (dragging: boolean) => void;
}): React.ReactElement {
  const chrome = useNavChrome();
  const menu = useNavMenu(stored);
  if (isNavEditable(chrome) && onLayoutChange) {
    return <EditableNav menu={menu} stored={stored} onLayoutChange={onLayoutChange} onDraggingChange={onDraggingChange} />;
  }
  return <>{renderNavRows(menu.main, chrome.hidden ?? [])}</>;
}
