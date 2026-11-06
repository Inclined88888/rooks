/**
 * Whether an element is on screen, for the mascots: one off-screen does not
 * animate. Every mascot of the page shares ONE `IntersectionObserver` — thirty
 * avatars in a scrolled list are thirty entries of one observer, not thirty
 * observers.
 */
import { useEffect, useState, type RefObject } from 'react';

type Watch = (visible: boolean) => void;

const watched = new Map<Element, Watch>();
let observer: IntersectionObserver | null = null;

function shared(): IntersectionObserver | null {
  if (observer) return observer;
  if (typeof IntersectionObserver === 'undefined') return null;
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) watched.get(e.target)?.(e.isIntersecting);
  });
  return observer;
}

/** Starts watching `el`; returns the stop. `null` when the browser has no observer (then: on screen). */
export function watchOnScreen(el: Element, fn: Watch): (() => void) | null {
  const io = shared();
  if (!io) return null;
  watched.set(el, fn);
  io.observe(el);
  return () => {
    watched.delete(el);
    io.unobserve(el);
    if (watched.size === 0) { io.disconnect(); observer = null; }
  };
}

/** Number of elements the shared observer watches (the tests read it). */
export function onScreenWatchCount(): number {
  return watched.size;
}

/**
 * `true` while `ref`'s element is on screen. Not `enabled`: not watched, and
 * reported on screen (nothing to save). Before the first report: on screen,
 * so a mascot in view does not wait a frame to wake up.
 */
export function useOnScreen(ref: RefObject<Element | null>, enabled: boolean): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return undefined;
    const stop = watchOnScreen(el, setVisible);
    return () => { stop?.(); setVisible(true); };
  }, [ref, enabled]);
  return enabled ? visible : true;
}
