'use client';

import React, { useEffect, type ReactElement, type ReactNode } from 'react';

/**
 * Host that keeps `<meta name="theme-color">` in sync with `--primary`.
 *
 * It sits AROUND the `theme` slot, not inside its occupant. The occupant is
 * replaced whenever a third-party theme claims the slot — the bundled
 * fallback is unmounted and its effects torn down — so an effect living in
 * the occupant would stop syncing exactly when a third-party theme takes
 * over, which is the case T.6 exists for.
 *
 * Nothing is asked of a theme plugin: it paints `--primary` like any other
 * token and the host reads it. There is no `theme-color` API to implement.
 */

/** Current `--primary` as a CSS color (`hsl(H S% L%)`), or null if unset. */
export function readPrimaryCssColor(): string | null {
  if (typeof document === 'undefined') return null;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
  return raw ? `hsl(${raw})` : null;
}

export function applyThemeColorMeta(color: string): void {
  if (typeof document === 'undefined') return;
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', color);
}

function isStyleNode(node: Node): boolean {
  const tag = (node as Element).tagName;
  return tag === 'STYLE' || tag === 'LINK';
}

function listHasStyle(nodes: NodeList): boolean {
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes.item(i);
    if (node && isStyleNode(node)) return true;
  }
  return false;
}

function touchesStyles(records: readonly MutationRecord[]): boolean {
  return records.some((r) => isStyleNode(r.target) || (r.target.parentNode && isStyleNode(r.target.parentNode)) || listHasStyle(r.addedNodes) || listHasStyle(r.removedNodes));
}

/**
 * Repaint the meta on the two events that can change `--primary`:
 * the light/dark class swap on `<html>`, and a `<style>`/`<link>` appearing
 * or leaving anywhere in the document — which is how a theme plugin claims
 * or releases the slot.
 *
 * The meta itself is neither a `<style>` nor an attribute of `<html>`, so
 * writing it cannot re-trigger either observer.
 */
export function startThemeColorSync(): () => void {
  if (typeof document === 'undefined') return () => {};
  const sync = () => {
    const color = readPrimaryCssColor();
    if (color) applyThemeColorMeta(color);
    window.dispatchEvent(new Event('rooks:theme-painted'));
  };

  const scheme = new MutationObserver(sync);
  scheme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  const styles = new MutationObserver((records) => {
    if (touchesStyles(records)) sync();
  });
  styles.observe(document.documentElement, { childList: true, characterData: true, subtree: true });

  sync();
  return () => {
    scheme.disconnect();
    styles.disconnect();
  };
}

export function ThemeColorSync({ children }: { children?: ReactNode }): ReactElement {
  // Children mount first (React runs child effects before the parent's), so
  // the occupant's tokens are already in the DOM on the first read.
  useEffect(() => startThemeColorSync(), []);
  return <>{children}</>;
}
