// The terminals stay mounted for the life of the window: the shells stay alive when you open chat, mail, or settings,
// and their window is only moved over the place that is showing them. Two keepers, keyed: "app" (the Terminal page's
// shells) and "room" (the Room's terminals, docs/design/0006-room-desktop.md, section 4.4). Each has its own slot list
// and its own parked element; a screen reserves a place with <TerminalSlot kind=… /> and the keeper of that kind draws
// its panes over the latest one.
import { lazy, Suspense, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import TerminalPage from "./pages/TerminalPage";

export type SlotKind = "app" | "room";

// The Room's panes load with the Room's code, the first time a Room slot shows.
const RoomPanes = lazy(() => import("./room/TerminalWindow").then((m) => ({ default: m.RoomPanes })));

type PaneSnap = { id: number; name: string };
type Snap = { panes: PaneSnap[]; active: number };

const slots: Record<SlotKind, HTMLElement[]> = { app: [], room: [] };
const slotListeners: Record<SlotKind, Set<() => void>> = { app: new Set(), room: new Set() };
let snap: Snap = { panes: [], active: 0 };
const snapListeners = new Set<() => void>();

function notifySlots(kind: SlotKind) {
  slotListeners[kind].forEach((fn) => fn());
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

function currentSlot(kind: SlotKind): HTMLElement | null {
  const list = slots[kind];
  return list[list.length - 1] ?? null;
}

/** Empty box a screen reserves. The live terminal of that kind is drawn over the latest one. */
export function TerminalSlot({ kind = "app" }: { kind?: SlotKind }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    slots[kind].push(el);
    notifySlots(kind);
    return () => {
      const i = slots[kind].indexOf(el);
      if (i >= 0) slots[kind].splice(i, 1);
      notifySlots(kind);
    };
  }, [kind]);
  return <div ref={ref} className={kind === "room" ? "terminal-slot room-term-slot" : "terminal-slot"} />;
}

function useSlot(kind: SlotKind): HTMLElement | null {
  return useSyncExternalStore(
    (fn) => { slotListeners[kind].add(fn); return () => { slotListeners[kind].delete(fn); }; },
    () => currentSlot(kind),
    () => null,
  );
}

/** Stays mounted for the life of the window so shells and their text are still there when you come back. */
function Keeper({ kind, render }: { kind: SlotKind; render: (parked: boolean) => ReactNode }) {
  const slot = useSlot(kind);
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
    <div ref={park} className="terminal-park" data-keeper={kind}>
      {render(!slot)}
    </div>
  );
}

/** The app's Terminal page ("app"). */
export function TerminalKeeper() {
  return <Keeper kind="app" render={(parked) => <TerminalPage bare parked={parked} />} />;
}

/** The Room's terminals ("room"): their sockets stay open while you are in chat, so coming back does not reconnect. */
export function RoomTerminalKeeper() {
  return <Keeper kind="room" render={(parked) => <Suspense fallback={null}><RoomPanes parked={parked} /></Suspense>} />;
}
