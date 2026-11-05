// One terminal for the whole app. The shells stay mounted when you open chat, mail, or settings,
// and the window is only moved over the place that is showing them.
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import TerminalPage from "./pages/TerminalPage";

type PaneSnap = { id: number; name: string };
type Snap = { panes: PaneSnap[]; active: number };

const slots: HTMLElement[] = [];
const slotListeners = new Set<() => void>();
let snap: Snap = { panes: [], active: 0 };
const snapListeners = new Set<() => void>();

function notifySlots() {
  slotListeners.forEach((fn) => fn());
}

function notifySnap() {
  snapListeners.forEach((fn) => fn());
}

export function publishTerminals(panes: PaneSnap[], active: number) {
  if (snap.active === active && snap.panes.length === panes.length && snap.panes.every((p, i) => p.id === panes[i]?.id && p.name === panes[i]?.name)) return;
  snap = { panes: panes.map((p) => ({ id: p.id, name: p.name })), active };
  notifySnap();
}

export function useTerminalSnap(): Snap {
  return useSyncExternalStore(
    (fn) => { snapListeners.add(fn); return () => { snapListeners.delete(fn); }; },
    () => snap,
    () => snap,
  );
}

function currentSlot(): HTMLElement | null {
  return slots[slots.length - 1] ?? null;
}

/** Empty box a screen reserves. The live terminal is drawn over the latest one. */
export function TerminalSlot() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    slots.push(el);
    notifySlots();
    return () => {
      const i = slots.indexOf(el);
      if (i >= 0) slots.splice(i, 1);
      notifySlots();
    };
  }, []);
  return <div ref={ref} className="terminal-slot" />;
}

function useSlot(): HTMLElement | null {
  return useSyncExternalStore(
    (fn) => { slotListeners.add(fn); return () => { slotListeners.delete(fn); }; },
    currentSlot,
    () => null,
  );
}

/** Stays mounted for the life of the window so shells and their text are still there when you come back. */
export function TerminalKeeper() {
  const slot = useSlot();
  const park = useRef<HTMLDivElement>(null);
  const [kept, setKept] = useState(false);

  useLayoutEffect(() => {
    if (slot) setKept(true);
  }, [slot]);

  useLayoutEffect(() => {
    const el = park.current;
    if (!el) return;
    let frame = 0;
    const place = () => {
      const host = slot && slot.isConnected ? slot : null;
      const rect = host?.getBoundingClientRect();
      const visible = !!rect && rect.width >= 40 && rect.height >= 40;
      if (!host || !visible || !rect) {
        el.className = "terminal-park";
        el.style.left = "0px";
        el.style.top = "0px";
        el.style.width = "960px";
        el.style.height = "640px";
        el.toggleAttribute("inert", true);
        return;
      }
      el.className = "terminal-float";
      el.style.left = `${rect.left}px`;
      el.style.top = `${rect.top}px`;
      el.style.width = `${rect.width}px`;
      el.style.height = `${rect.height}px`;
      el.toggleAttribute("inert", false);
    };
    place();
    if (!slot) return;
    const tick = () => {
      place();
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [slot, kept]);

  if (!kept) return null;

  return (
    <div ref={park} className="terminal-park">
      <TerminalPage bare parked={!slot} />
    </div>
  );
}
