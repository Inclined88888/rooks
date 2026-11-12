'use client';

import { useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { GLASS_EVENT } from '@/plugins-client/ui-theme-variants';

/**
 * Frosted chat bubbles, paid only for the bubbles on screen.
 *
 * A `backdrop-filter` per bubble down a whole thread is what pinned /chat at
 * 30-35 % GPU on 27/08/2026 (77bd776f): every blurred layer is recomposited
 * whenever anything behind it moves, visible or not. Here the blur is a CSS
 * rule gated on `data-glass-visible`, and ONE IntersectionObserver for the
 * whole page sets that attribute on the bubbles within reach of the viewport
 * — the margin lets a bubble arrive already frosted when scrolling. A thread
 * of 500 messages blurs the dozen being read. The callback writes the
 * attribute straight onto the node: no React state, no re-render while
 * scrolling.
 */
export const GLASS_VISIBLE_ATTR = 'data-glass-visible';
const GLASS_BUBBLES_ATTR = 'data-glass-bubbles';

let observer: IntersectionObserver | null = null;
function sharedObserver(): IntersectionObserver {
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) entry.target.toggleAttribute(GLASS_VISIBLE_ATTR, entry.isIntersecting);
  }, { rootMargin: '25% 0px' });
  return observer;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(GLASS_EVENT, onChange);
  return () => window.removeEventListener(GLASS_EVENT, onChange);
}
function glassBubblesEnabled(): boolean {
  return document.documentElement.hasAttribute(GLASS_BUBBLES_ATTR);
}

/**
 * Registers the bubble behind `ref` with the shared observer while the
 * setting is on. Call it before any early return; a render path that never
 * attaches the ref simply observes nothing.
 */
export function useGlassBubble(ref: RefObject<HTMLElement | null>): void {
  const enabled = useSyncExternalStore(subscribe, glassBubblesEnabled, () => false);
  const observed = useRef<HTMLElement | null>(null);
  // No dependency list: the node can change between renders (a message that
  // becomes a card), and the comparison below makes an unchanged render free.
  useEffect(() => {
    const el = enabled ? ref.current : null;
    if (el === observed.current) return;
    const previous = observed.current;
    if (previous) { sharedObserver().unobserve(previous); previous.removeAttribute(GLASS_VISIBLE_ATTR); }
    observed.current = el;
    if (el) sharedObserver().observe(el);
  });
  useEffect(() => () => {
    const el = observed.current;
    if (el) { sharedObserver().unobserve(el); el.removeAttribute(GLASS_VISIBLE_ATTR); }
    observed.current = null;
  }, []);
}
