'use client';

import { isAddWidgetPlaceholder } from './add-widget';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { GripVertical, Search, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Picto } from '@/components/picto';
import { HUD_SURFACE } from '@/components/cockpit/hud-surface';
import { t } from '@/lib/i18n';
import { useWidgetHost } from './widget-host';
import { origineWidget, pageDuWidget, PAGES_WIDGET, type PageWidget } from './widget-catalog';
import type { WidgetLayout } from './widget-layout';

/**
 * The inventory of widgets the user took out of the interface, and the way back
 * in: drag one into any mounted zone, or click to send it home.
 *
 * It only lists what the host would otherwise be showing. A widget masked by
 * `ui.hidden`, or one whose module is off, never reaches this list — it is not
 * tidied away, it does not exist for this installation, and offering to put it
 * back would promise something the config refuses.
 *
 * The panel lives with the host rather than with a page: a widget removed from
 * the cockpit has to be droppable into a sidebar, from wherever the user is.
 * It opens from "Add widget" and carries a Done button; closing it (Done, the
 * cross, Escape) puts the empty zones away again.
 */
/** Where the user dragged the panel, in viewport pixels. `null` = its default
 *  place, centred near the top. */
type Position = { x: number; y: number };

export function WidgetPalette() {
  const { palette, paletteOpen, setPaletteOpen, dragging, widget: catalogue } = useWidgetHost();
  const [recherche, setRecherche] = useState('');
  const [page, setPage] = useState<PageWidget | 'all'>('all');
  const [position, setPosition] = useState<Position | null>(null);
  const panneau = useRef<HTMLDivElement>(null);
  const champ = useRef<HTMLInputElement>(null);
  const prise = useRef<{ dx: number; dy: number } | null>(null);
  const fermer = () => { setPaletteOpen(false); setRecherche(''); setPage('all'); };

  // Typing goes straight to the search. Focus is taken on the next frame: the
  // menu that opened the panel hands focus back to its trigger as it closes,
  // which would otherwise win over `autoFocus`.
  useEffect(() => {
    if (!paletteOpen) return;
    // Hosts with no animation frames (a headless DOM): a timer stands in for the frame there.
    const frames = typeof requestAnimationFrame === 'function';
    const focus = () => champ.current?.focus();
    const handle = frames ? requestAnimationFrame(focus) : setTimeout(focus, 16);
    return () => { if (frames) cancelAnimationFrame(handle as number); else clearTimeout(handle as ReturnType<typeof setTimeout>); };
  }, [paletteOpen]);

  // Substring match on the title, the only thing the row shows: the user types
  // what they read. An empty field lists the whole inventory, entries without a
  // catalogue entry included — filtering them out here would hide from the
  // unfiltered list what `PaletteItem` already declines to render.
  // The search reads what the card shows: its name and its sentence.
  const pagesPresentes = useMemo(
    () => PAGES_WIDGET.filter((p) => palette.some((entree) => { const w = !isAddWidgetPlaceholder(entree.id) && catalogue(entree.id); return w && pageDuWidget(w) === p; })),
    [palette, catalogue],
  );
  // A tab whose widgets have all been placed disappears: fall back to All.
  const pageActive = page === 'all' || pagesPresentes.includes(page) ? page : 'all';
  const visibles = useMemo(() => {
    const aiguille = recherche.trim().toLowerCase();
    return palette.filter((entree) => {
      if (isAddWidgetPlaceholder(entree.id)) return false;
      const widget = catalogue(entree.id);
      if (pageActive !== 'all' && (!widget || pageDuWidget(widget) !== pageActive)) return false;
      if (!aiguille) return true;
      return `${widget?.titreCatalogue ?? widget?.titre ?? ''} ${widget?.description ?? ''}`.toLowerCase().includes(aiguille);
    });
  }, [palette, recherche, pageActive, catalogue]);

  // The panel moves by its header, out of the way of the zone the user aims
  // at. Plain pointer events, not dnd-kit: the panel is not a widget and must
  // never be offered a drop zone. The header stays reachable inside the window.
  const deplacer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!prise.current || !panneau.current) return;
    const { width } = panneau.current.getBoundingClientRect();
    setPosition({
      x: Math.min(Math.max(e.clientX - prise.current.dx, 8 - width + 80), window.innerWidth - 80),
      y: Math.min(Math.max(e.clientY - prise.current.dy, 8), window.innerHeight - 48),
    });
  };
  const lacher = (e: React.PointerEvent<HTMLDivElement>) => {
    prise.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <>
      {/* Opened from Customize interface > Add widget. Pinned by its TOP edge:
          it grows downwards, so the search field stays put while the results
          change. No backdrop, and it fades during a drag: the zones behind it
          are where the widget goes. */}
      {paletteOpen && (
        <div
          ref={panneau}
          role="dialog"
          aria-label={t('widgets.palette.title')}
          onKeyDown={(e) => { if (e.key === 'Escape') fermer(); }}
          style={position ? { left: position.x, top: position.y } : undefined}
          className={cn(
            'fixed z-40 flex w-[min(46rem,calc(100vw-2rem))] flex-col rounded-xl border p-2 shadow-lg transition-opacity print:hidden',
            !position && 'left-1/2 top-[12dvh] -translate-x-1/2',
            HUD_SURFACE,
            dragging !== null && 'pointer-events-none opacity-30',
          )}
        >
          <div
            onPointerDown={(e) => {
              if (e.button !== 0 || (e.target as Element).closest('button')) return;
              const box = panneau.current?.getBoundingClientRect();
              if (!box) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              prise.current = { dx: e.clientX - box.left, dy: e.clientY - box.top };
            }}
            onPointerMove={deplacer}
            onPointerUp={lacher}
            onPointerCancel={lacher}
            title={t('widgets.palette.move')}
            className="flex cursor-grab touch-none select-none items-center justify-between gap-2 px-1.5 pb-1.5 active:cursor-grabbing"
          >
            <span className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <GripVertical className="size-3.5 text-muted-foreground/50" />
              {t('widgets.palette.title')}
            </span>
            <button
              type="button"
              aria-label={t('widgets.palette.close')}
              onClick={fermer}
              className="rounded-md p-0.5 text-muted-foreground/60 transition-colors hover:text-primary"
            >
              <X className="size-3.5" />
            </button>
          </div>

          <div className="relative px-1.5 pb-2">
            <Search className="pointer-events-none absolute left-3.5 top-4 size-3.5 -translate-y-1/2 text-primary" />
            <Input
              ref={champ}
              value={recherche}
              onChange={(event) => setRecherche(event.target.value)}
              placeholder={t('widgets.palette.search')}
              aria-label={t('widgets.palette.search')}
              className="h-8 border-primary/40 bg-primary/5 pl-8 text-xs placeholder:text-muted-foreground/70 focus-visible:border-primary focus-visible:ring-primary/40"
            />
          </div>

          {pagesPresentes.length > 1 && (
            // One tab per page the widgets belong to, as the column tabs do:
            // a surface the user looks for a widget by.
            <div role="tablist" aria-label={t('widgets.palette.pages')} className="mx-1.5 mb-2 flex min-w-0 items-center gap-0.5 rounded-lg bg-muted p-[3px]">
              {(['all', ...pagesPresentes] as const).map((p) => (
                <button key={p} type="button" role="tab" aria-selected={pageActive === p} onClick={() => setPage(p)}
                  className={cn('h-7 min-w-0 flex-1 truncate rounded-md px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                    pageActive === p ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                  {t(`widgets.palette.page.${p}`)}
                </button>
              ))}
            </div>
          )}

          <ul className="grid max-h-[60dvh] grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-2 overflow-y-auto px-1.5 pb-1">
            {visibles.map((entree) => (
              <PaletteItem key={entree.id} entree={entree} />
            ))}
          </ul>

          {visibles.length === 0 && recherche.trim() !== '' && (
            <p className="px-1.5 py-4 text-center text-[11px] text-muted-foreground">{t('widgets.palette.noMatch')}</p>
          )}

          {palette.length === 0 && (
            <p className="px-1.5 py-4 text-center text-[11px] text-muted-foreground">{t('widgets.palette.empty')}</p>
          )}

          <div className="flex items-end justify-between gap-3 px-1.5 pt-2">
            <p className="text-[10.5px] leading-snug text-muted-foreground/70">
              {t('widgets.palette.hint')}
            </p>
            <button type="button" onClick={fermer} className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">{t('appearance.menu.done')}</button>
          </div>
        </div>
      )}
    </>
  );
}

/** The place a widget's thumbnail will take. Until widgets ship one, a sketch
 *  of the form it takes: a line of icons for a widget with a flat form, a card
 *  with a header and rows otherwise. */
function ApercuSchematique({ bar, icone }: { bar: boolean; icone?: string }) {
  if (icone) {
    return (
      <div aria-hidden className="flex h-20 w-full items-center justify-center rounded-md bg-muted/60">
        <Picto icon={icone} className="size-8 text-foreground/70" />
      </div>
    );
  }
  return (
    <div aria-hidden className="flex h-20 w-full flex-col gap-1.5 rounded-md bg-muted/60 p-2">
      {bar ? (
        <div className="flex flex-1 items-center justify-center gap-1.5">
          {[0, 1, 2].map((i) => <span key={i} className="size-3.5 rounded-full bg-muted-foreground/25" />)}
        </div>
      ) : (
        <>
          <span className="h-2 w-1/2 rounded-full bg-muted-foreground/30" />
          <span className="h-1.5 w-full rounded-full bg-muted-foreground/15" />
          <span className="h-1.5 w-5/6 rounded-full bg-muted-foreground/15" />
          <span className="h-1.5 w-2/3 rounded-full bg-muted-foreground/15" />
        </>
      )}
    </div>
  );
}

/**
 * One widget of the inventory. The row itself is the drag source; the button
 * beside it is the same gesture without a pointer — it drops the widget into
 * the first mounted zone that admits it, its default one whenever that zone is
 * on screen. No such zone on this page, and the button says so rather than
 * placing the widget somewhere invisible.
 */
function PaletteItem({ entree }: { entree: WidgetLayout }) {
  const { widget: catalogue } = useWidgetHost();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: entree.id });
  const widget = catalogue(entree.id);

  if (!widget) return null;

  // Two widgets often carry the same title (the two "Missions"), and the plugin
  // does not tell them apart: the surface of origin does. It is read from the
  // declared slot, never from the mounted zones: an entry is in the palette
  // precisely because its zone is not mounted.
  const origine = origineWidget(widget);
  const surface = origine.cleSurface ? t(origine.cleSurface) : origine.surface;
  const contexte = origine.plugin
    ? t('widgets.palette.origin', { surface, plugin: origine.plugin })
    : surface;
  // The subtitle is only read by the eye: the assistive labels carry the same
  // disambiguation, otherwise the palette announces "Add Missions" three times,
  // and only one of those three acts.
  const designation = `${widget.titreCatalogue ?? widget.titre} (${contexte})`;

  return (
    // A card laid on a card goes one step up the surface scale (--surface-2 on
    // the panel's --card): without this offset, the inventory was a uniform flat
    // area where the eye no longer told the entries apart.
    <li className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-surface-2 p-1.5 shadow-elev-1">
      <button
        ref={setNodeRef}
        type="button"
        aria-label={t('widgets.palette.drag', { title: designation })}
        className={cn(
          'flex cursor-grab touch-none flex-col gap-1.5 rounded-md p-0.5 text-left',
          'text-[11px] text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary',
          'active:cursor-grabbing',
          isDragging && 'opacity-40',
        )}
        {...attributes}
        {...listeners}
      >
        <ApercuSchematique bar={widget.bar === true} icone={widget.icone} />
        <span className="flex w-full min-w-0 flex-col px-1">
          <span className="truncate font-medium text-foreground">{widget.titreCatalogue ?? widget.titre}</span>
          {widget.description && <span className="line-clamp-3 text-[10.5px] leading-snug text-muted-foreground">{widget.description}</span>}
          <span className="truncate text-[9.5px] leading-tight text-muted-foreground/60">{contexte}</span>
        </span>
      </button>

    </li>
  );
}
