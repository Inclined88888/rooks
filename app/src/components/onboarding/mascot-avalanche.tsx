'use client';

/**
 * The welcome screen's avalanche on a canvas (docs/ONBOARDING.md). The scene
 * is `avalanche.ts`; this file paints it, lets the reader grab a mascot, and
 * flings them all out on `scatter()`.
 *
 * The mascots are the `agent.mascot` slot's drawing: each look is mounted once
 * through `AgentMascotHost` (so a plugin that replaces the mascot replaces it
 * here too), serialised, and rasterised into a bitmap — a hundred live SVGs
 * with noise filters would not hold sixty frames a second.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactElement } from 'react';
import { AgentMascotHost, usePrefersReducedMotion } from '@/components/mascot/agent-mascot';
import { skullSize } from '@/components/mascot/mascot-geometry';
import {
  avalancheLooks, bodyAt, buildAvalanche, dragTo, drawOrder, grab, release, resizeAvalanche, scatter, stepAvalanche,
  type Avalanche,
} from './avalanche';

const BITMAP = 360;
/** Physics substep: small enough that a fast fall never skips through a head. */
const SUBSTEP = 0.008;
/** A window dragged to a new size fires dozens of resizes: the heaps are laid out once it stops. */
const RELAYOUT_MS = 120;

export type MascotAvalancheHandle = {
  /** "Continue": everyone is flung off screen. */
  scatter: () => void;
};

async function rasterize(svg: SVGSVGElement): Promise<HTMLCanvasElement | null> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(BITMAP));
  clone.setAttribute('height', String(BITMAP));
  const markup = new XMLSerializer().serializeToString(clone);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = BITMAP;
  canvas.height = BITMAP;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, BITMAP, BITMAP);
  return canvas;
}

function paint(ctx: CanvasRenderingContext2D, world: Avalanche, bitmaps: readonly (HTMLCanvasElement | null)[], dpr: number, w: number, h: number): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  for (const b of drawOrder(world)) {
    const bitmap = bitmaps[b.look];
    if (!bitmap) continue;
    const sy = Math.max(0.7, Math.min(1.25, b.sq));
    const sx = 1 / Math.sqrt(sy);
    ctx.save();
    // Squash from the head's base, so a landing presses it into the heap.
    ctx.translate(b.x, b.y + b.vb + b.boff);
    ctx.rotate(b.lean);
    ctx.scale(sx, sy);
    ctx.drawImage(bitmap, -b.size / 2, -b.vb - b.oy - b.size / 2, b.size, b.size);
    ctx.restore();
  }
}

export const MascotAvalanche = forwardRef<MascotAvalancheHandle, { className?: string; density?: number }>(function MascotAvalanche({ className, density = 36 }, ref): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const castRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<Avalanche | null>(null);
  const bitmaps = useRef<(HTMLCanvasElement | null)[]>([]);
  const [ready, setReady] = useState(false);
  const reduced = usePrefersReducedMotion();
  const looks = useMemo(() => avalancheLooks(density), [density]);

  useImperativeHandle(ref, () => ({
    scatter: () => { if (worldRef.current) scatter(worldRef.current); },
  }), []);

  // Rasterise the cast once, a frame after it mounted (a plugin's occupant may paint late).
  useEffect(() => {
    let alive = true;
    const frame = requestAnimationFrame(() => {
      const cells = Array.from(castRef.current?.querySelectorAll<HTMLElement>('[data-avalanche-look]') ?? []);
      void Promise.all(cells.map(async (cell, i) => {
        const svg = cell.querySelector('svg');
        bitmaps.current[i] = svg ? await rasterize(svg).catch(() => null) : null;
      })).finally(() => { if (alive) setReady(true); });
    });
    return () => { alive = false; cancelAnimationFrame(frame); };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ready || !canvas || !ctx) return undefined;
    let dpr = 1;
    let w = 0;
    let h = 0;
    const measure = (): void => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    };
    measure();
    const heads = looks.map((look) => skullSize(look.shape));
    // density ≈ look count; 24 was the original cast size → pack 1.0
    const pack = Math.max(1, density / 24);
    // First paint can run before the absolute stage has a real size (canvas
    // defaults to 300×150). Wait for a usable box before building heaps.
    if (w < 80 || h < 80) {
      const wait = new ResizeObserver(() => {
        measure();
        if (w >= 80 && h >= 80) wait.disconnect();
      });
      wait.observe(canvas);
      // Fall through once measured; if still tiny, build a stub and relayout.
    }
    let world = buildAvalanche({ width: Math.max(w, 320), height: Math.max(h, 240), looks: heads, still: reduced, density: pack });
    worldRef.current = world;
    let relayout = 0;
    // The canvas follows the window at once (a stretched bitmap would blur); the heaps follow it once it stops.
    const resize = (): void => {
      measure();
      window.clearTimeout(relayout);
      relayout = window.setTimeout(() => {
        if (w < 80 || h < 80) return;
        const next = resizeAvalanche(world, w, h, heads);
        if (next === world) return;
        // A mascot in hand is dropped with the old scene — except a first
        // layout from the 300×150 stub: rebuild with motion if we can.
        const firstReal = world.width <= 320 && w > 320;
        world = firstReal && !reduced
          ? buildAvalanche({ width: w, height: h, looks: heads, still: false, density: pack })
          : next;
        worldRef.current = world;
        canvas.style.cursor = '';
      }, RELAYOUT_MS);
    };
    window.addEventListener('resize', resize);
    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);
    // Kick once after layout.
    requestAnimationFrame(() => resize());

    const point = (e: PointerEvent): { x: number; y: number; t: number } => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() };
    };
    const onDown = (e: PointerEvent): void => {
      const p = point(e);
      if (!grab(world, p.x, p.y, p.t)) return;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    };
    const onMove = (e: PointerEvent): void => {
      const p = point(e);
      if (world.drag) dragTo(world, p.x, p.y, p.t);
      else canvas.style.cursor = world.floor && bodyAt(world, p.x, p.y) ? 'grab' : '';
    };
    const onUp = (): void => {
      if (!world.drag) return;
      release(world);
      canvas.style.cursor = '';
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    let raf = 0;
    let prev = performance.now();
    const frame = (now: number): void => {
      const dt = Math.min(0.1, (now - prev) / 1000);
      prev = now;
      const n = Math.max(2, Math.ceil(dt / SUBSTEP));
      for (let k = 0; k < n; k += 1) stepAvalanche(world, dt / n);
      paint(ctx, world, bitmaps.current, dpr, w, h);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(relayout);
      window.removeEventListener('resize', resize);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      worldRef.current = null;
    };
    // The scene is built once: a change of motion preference mid-avalanche keeps the heaps where they are.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, looks]);

  return (
    <>
      <canvas ref={canvasRef} aria-hidden className={className} style={{ display: 'block', width: '100%', height: '100%' }} />
      {/* Keep the cast mounted (hidden) so a late plugin paint can still rasterise. */}
      <div ref={castRef} aria-hidden className="pointer-events-none fixed left-[-9999px] top-0 h-[200px] w-[200px] overflow-hidden opacity-0">
        {looks.map((look, i) => (
          <div key={i} data-avalanche-look="">
            <AgentMascotHost look={look} size={200} fit shadow={false} />
          </div>
        ))}
      </div>
    </>
  );
});
