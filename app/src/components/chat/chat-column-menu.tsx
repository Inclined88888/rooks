'use client';

import { useCallback, useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent, type TouchEvent } from 'react';
import { ArrowLeftRight, Columns2, PanelLeftClose, PanelRightClose, Plus, X } from 'lucide-react';

import { t as i18n } from '@/lib/i18n';
import type { FileMenuItem } from './file-context-menu';
import type { CoteColonne } from './chat-columns';

/** What a column lets its menu do. Absent = the row is not offered. */
export type CommandesColonne = {
  cote: CoteColonne;
  /** The column's zone, which is also its first tab: it cannot be closed. */
  zone: string;
  onAddTab?: () => void;
  onCloseTab?: (zone: string) => void;
  onAddColumn?: () => void;
  onRemoveColumn?: () => void;
  onSwap?: () => void;
  onCollapse?: () => void;
};

/**
 * The rows of the column menu opened on the tab `cible`: "close" acts on that
 * tab, the rest on the column as a whole.
 */
export function itemsColonne(c: CommandesColonne, cible: string): FileMenuItem[] {
  const items: FileMenuItem[] = [];
  const icone = 'size-3.5';
  if (c.onAddTab) {
    items.push({ key: 'add-tab', label: i18n('chatPage.addColumnTab'), icon: <Plus className={icone} aria-hidden />, onSelect: c.onAddTab });
  }
  const fermer = c.onCloseTab;
  if (fermer && cible !== c.zone) {
    items.push({ key: 'close-tab', label: i18n('chatPage.closeColumnTab'), title: i18n('chatPage.closeColumnTabHint'), icon: <X className={icone} aria-hidden />, onSelect: () => fermer(cible) });
  }
  if (c.onAddColumn) {
    items.push({ key: 'add-column', label: i18n('chatPage.addColumn'), title: i18n('chatPage.addColumnHint'), icon: <Columns2 className={icone} aria-hidden />, onSelect: c.onAddColumn });
  }
  if (c.onRemoveColumn) {
    items.push({ key: 'remove-column', label: i18n('chatPage.removeColumn'), title: i18n('chatPage.removeColumnHint'), icon: <X className={icone} aria-hidden />, onSelect: c.onRemoveColumn });
  }
  if (c.onSwap) {
    items.push({ key: 'swap', label: i18n('chatPage.swapColumns'), title: i18n('chatPage.swapColumnsHint'), icon: <ArrowLeftRight className={icone} aria-hidden />, onSelect: c.onSwap });
  }
  if (c.onCollapse) {
    const Icone = c.cote === 'left' ? PanelLeftClose : PanelRightClose;
    items.push({ key: 'collapse', label: i18n('chatPage.collapseRail'), title: i18n('chatPage.collapseRailHint'), icon: <Icone className={icone} aria-hidden />, onSelect: c.onCollapse });
  }
  return items;
}

/** How long a finger rests on a tab before its menu opens, in ms. */
export const APPUI_LONG_MS = 500;
/** How far, in px, the finger may drift before the press stops being a press. */
const DERIVE_MAX = 8;
/**
 * After a long press or a key opened the menu, the browser may still send its
 * own `contextmenu` (Android on a long press, some keyboards on key up) and the
 * finger's click: both are the same gesture, not a new one.
 */
const ECHO_MS = 800;

type Ouvrir = (x: number, y: number) => void;

/**
 * The three ways to open a tab's menu, on the element that carries it: a right
 * click at the pointer, the Menu key or Shift+F10 under the element, a long
 * press for a finger (the drawer of narrow screens has no right click).
 */
export function useAppuiMenu(ouvrir: Ouvrir | undefined) {
  const appui = useRef<{ id: number; x: number; y: number; minuterie: ReturnType<typeof setTimeout> } | null>(null);
  const ouvertA = useRef(0);

  const annuler = useCallback(() => {
    if (appui.current) clearTimeout(appui.current.minuterie);
    appui.current = null;
  }, []);
  useEffect(() => annuler, [annuler]);

  const sousElement = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.bottom };
  };

  if (!ouvrir) return {};
  return {
    'aria-haspopup': 'menu' as const,
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (Date.now() - ouvertA.current < ECHO_MS) return;
      // A keyboard-made event carries no pointer position on every browser.
      const p = e.clientX === 0 && e.clientY === 0 ? sousElement(e.currentTarget) : { x: e.clientX, y: e.clientY };
      ouvrir(p.x, p.y);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
      e.preventDefault();
      ouvertA.current = Date.now();
      const p = sousElement(e.currentTarget);
      ouvrir(p.x, p.y);
    },
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType === 'mouse') return;
      annuler();
      const { pointerId: id, clientX: x, clientY: y } = e;
      appui.current = {
        id, x, y,
        minuterie: setTimeout(() => {
          appui.current = null;
          ouvertA.current = Date.now();
          ouvrir(x, y);
        }, APPUI_LONG_MS),
      };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const a = appui.current;
      if (a && a.id === e.pointerId && Math.hypot(e.clientX - a.x, e.clientY - a.y) > DERIVE_MAX) annuler();
    },
    onPointerUp: annuler,
    onPointerCancel: annuler,
    // The finger lifting after a long press is not a tap: no click, no
    // mouse events the browser would make up for it.
    onTouchEnd: (e: TouchEvent<HTMLElement>) => {
      if (Date.now() - ouvertA.current < ECHO_MS) e.preventDefault();
    },
    onClickCapture: (e: MouseEvent<HTMLElement>) => {
      if (Date.now() - ouvertA.current < ECHO_MS && appui.current === null && e.detail > 0) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
  };
}
