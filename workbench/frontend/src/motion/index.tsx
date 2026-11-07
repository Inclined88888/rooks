import { useEffect, useState } from "react";

/**
 * What is left of motion in design system v3 (docs/design/0003-workroom.md, section 6): motion explains, never
 * decorates. The only movement is the ui-fade in ui/ui.css (150 ms or less) when something appears or disappears.
 * This file holds the small runtime helpers: whether fades are on, the still "Thinking" line, a screenshot that
 * swaps to each new frame, and a short exit so a removed row can fade before it goes.
 */
export type Level = "on" | "off";

export function motionLevel(): Level {
  if (typeof window === "undefined") return "off";
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return "off";
  return document.documentElement.dataset.motion === "off" ? "off" : "on";
}

/* ------------------------------------------------------------------ thinking */

/**
 * A still line while the assistant thinks. After 6 s it says how long it has been, and it names the tool it is using
 * when there is one, so a long wait becomes a described one. Nothing moves.
 */
export function Thinking({ phase, line, since, announce = true }: { phase?: string; line?: string; since: number; announce?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const secs = Math.floor((now - since) / 1000);
  const label = line || (phase ? `Using ${phase}` : "Thinking");
  return (
    <div className="thinking-line" role={announce ? "status" : undefined} aria-live={announce ? "polite" : undefined}>
      <span className="thinking-label">{label}</span>
      {secs >= 6 && <span className="thinking-time">{secs}s</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ live screen */

/** A screenshot that shows each new frame once it has loaded (the old frame stays until then, so it never blinks). */
export function LiveShot({ src, alt, children, onSize }:
  { src: string; alt: string; children?: React.ReactNode; onSize?: (w: number, h: number) => void }) {
  const [shown, setShown] = useState(src);
  useEffect(() => {
    if (src === shown) return;
    const im = new Image();
    im.onload = () => setShown(src);
    im.onerror = () => setShown(src);
    im.src = src;
  }, [src, shown]);
  return (
    <div className="live-shot">
      <img src={shown} alt={alt} onLoad={(e) => onSize?.(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ exits */

/** Keep an item on screen for its fade before it is removed. `leaving(id)` says whether to add the .is-leaving class. */
export function useExit<T extends string | number>(ms = 120) {
  const [out, setOut] = useState<Set<T>>(new Set());
  const run = (id: T, then: () => void) => {
    if (motionLevel() === "off") return then();
    setOut((s) => new Set(s).add(id));
    setTimeout(() => { then(); setOut((s) => { const n = new Set(s); n.delete(id); return n; }); }, ms);
  };
  return { run, leaving: (id: T) => out.has(id) };
}
