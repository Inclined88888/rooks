'use client';

/**
 * The agent's mascot: a plush meerkat head whose face is a black screen where
 * the eyes are light (docs/AGENT-MASCOT.md).
 *
 * - `AgentMascot` paints it from props — the product's drawing, and the
 *   default occupant of the `agent.mascot` slot.
 * - `AgentMascotHost` is what a screen mounts: it normalises the request,
 *   hands it to the slot's occupant through `useAgentMascot()`, and paints
 *   `AgentMascot` itself while no occupant is registered (module off, a page
 *   before the plugins load). A screen never mounts `AgentMascot` directly,
 *   or a plugin could not replace it there.
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { AGENT_MASCOT_SLOT } from '@/lib/plugin-host/slots';
import { DEFAULT_LOOK, lookFurHex, normalizeAgentLook, type AgentLook } from './agent-look';
import { useMascotPartsVersion } from './mascot-parts';
import { AgentMascotProvider, useAgentMascot, type AgentMascotValue } from './agent-mascot-context';
import { MascotAccessoryArt, MascotAccessoryIcon } from './mascot-accessories';
import { exprPoints, furOf, headLayout, isDrawableEyes, luma, mix, ptsPath, shade, type MascotEyesKey } from './mascot-geometry';
import { startMascotMotion, type MascotMotion } from './mascot-motion';
import { isMascotState, stateExpression, type MascotState } from './mascot-states';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function subscribeMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia(REDUCED_MOTION);
  mq.addEventListener?.('change', onChange);
  return () => mq.removeEventListener?.('change', onChange);
}
function readMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION).matches;
}
/** The server paints a still mascot; the client wakes it once it knows the user's preference. */
const serverMotion = (): boolean => true;

/** `true` when the user asked the system for reduced motion; follows the setting live. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, readMotion, serverMotion);
}

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export type AgentMascotProps = {
  /** A product skull or a pack's (`<pluginId>:<slug>`); one whose pack is gone draws the classic skull. */
  shape?: AgentLook['shape'];
  /** `#rrggbb` (a natural fur as is, any other colour blended into fur), or a pack's fur. */
  color?: string;
  /** The look's eyes — any expression, beyond the pickers' `EYES`, or a pack's eyes. */
  eyes?: MascotEyesKey;
  acc?: AgentLook['acc'];
  /** Edge of the square box, in CSS pixels. */
  size?: number;
  /** Moving eyes, blinks, states. Ignored under `prefers-reduced-motion`. */
  live?: boolean;
  /** What the agent is doing or how it reacts. Without `live`, its first expression, still. */
  state?: MascotState | null;
  /** Keeps the accessory inside the box instead of spilling past the bottom-right corner. */
  fit?: boolean;
  /** The soft shadow under the head. */
  shadow?: boolean;
  /** Accessible name; absent: decorative (`aria-hidden`). */
  label?: string | null;
  className?: string;
  /**
   * One part alone, for the configurator's cells: the screen with its eyes,
   * or the accessory centred and enlarged. Absent: the whole head.
   */
  part?: MascotDrawnPart | null;
};

/** A part drawn on its own (`AgentMascotProps.part`). */
export type MascotDrawnPart = 'screen' | 'acc';

/** A stable number from a React id: the fur's noise seed, so two mascots side by side are not the same plush. */
function seedOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 9973;
  return h % 97;
}

export function AgentMascot({
  shape = DEFAULT_LOOK.shape, color = DEFAULT_LOOK.color, eyes = DEFAULT_LOOK.eyes, acc = 'none',
  size = 96, live = false, state = null, fit = false, shadow = true, label = null, className, part = null,
}: AgentMascotProps): ReactElement {
  // SVG ids are document-wide: React's `:r1:` would break `url(#…)`.
  const id = `m${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const seed = seedOf(id);
  const reduced = usePrefersReducedMotion();
  const animated = live && !reduced;
  // A pack registering or leaving changes what the ids below draw.
  const partsVersion = useMascotPartsVersion();
  const base: MascotEyesKey = isDrawableEyes(eyes) ? eyes : DEFAULT_LOOK.eyes;
  const current: MascotState | null = isMascotState(state) ? state : null;
  // Keyed on the registry too: a pack's skull id draws differently once its pack is back.
  const L = useMemo(() => headLayout(shape), [shape, partsVersion]);
  const shown = current ? stateExpression(current, base) : base;
  const eyePts = useMemo(() => exprPoints(shown, L.geo), [shown, L, partsVersion]);

  const fur = furOf(lookFurHex(color));
  const light = luma(fur) > 0.56;
  const mask = light ? mix(fur, '#4a2814', 0.72) : mix(fur, '#f2d9b8', 0.78);
  const { screen: s, ring: m, ears: e } = L;

  const svgRef = useRef<SVGSVGElement>(null);
  const eyesRef = useRef<SVGGElement>(null);
  const blinkRef = useRef<SVGGElement>(null);
  const lRef = useRef<SVGPathElement>(null);
  const rRef = useRef<SVGPathElement>(null);
  const mRef = useRef<SVGPathElement>(null);
  const motion = useRef<MascotMotion | null>(null);
  const latest = useRef({ base, current });
  latest.current = { base, current };

  // The engine is (re)built when motion turns on or the skull changes — the
  // eyes' screen moves with it. Layout effects: React has just written the
  // target outline, the engine puts the eyes back where they were before the
  // first paint, then springs them.
  useIsomorphicLayoutEffect(() => {
    if (!animated) return undefined;
    const svg = svgRef.current;
    const eyesG = eyesRef.current;
    const blink = blinkRef.current;
    const l = lRef.current;
    const r = rRef.current;
    const mid = mRef.current;
    if (!svg || !eyesG || !blink || !l || !r || !mid) return undefined;
    const engine = startMascotMotion({ svg, eyes: eyesG, blink, paths: { L: l, R: r, M: mid } }, L.geo, latest.current.base, latest.current.current);
    motion.current = engine;
    return () => {
      engine.dispose();
      motion.current = null;
      // Back to what React painted: a still mascot carries no leftover transform.
      blink.removeAttribute('transform');
      blink.style.opacity = '';
      eyesG.removeAttribute('transform');
    };
  }, [animated, L]);
  useIsomorphicLayoutEffect(() => { motion.current?.setBase(base); }, [base]);
  useIsomorphicLayoutEffect(() => { motion.current?.setState(current); }, [current]);

  const blinkDelay = { '--rooks-mascot-blink-delay': `${((seed % 5) * 0.7).toFixed(1)}s` } as CSSProperties;

  const whole = part === null;
  // The screen alone is framed tight around it; the accessory is redrawn in the full box.
  const viewBox = part === 'screen' ? `${s.x - 2} ${s.y - 2} ${s.w + 4} ${s.h + 4}` : '0 0 100 100';

  return (
    <svg
      ref={svgRef}
      className={className ? `rooks-mascot ${className}` : 'rooks-mascot'}
      viewBox={viewBox}
      width={size}
      height={size}
      style={blinkDelay}
      data-mascot=""
      data-shape={shape}
      data-acc={acc}
      data-expr={shown}
      data-live={animated ? '' : undefined}
      data-motion={reduced ? 'reduced' : 'full'}
      data-mascot-part={part ?? undefined}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <defs>
        <radialGradient id={`${id}g`} cx="40%" cy="22%" r="90%">
          <stop offset="0" stopColor={shade(fur, 0.32)} /><stop offset=".55" stopColor={fur} /><stop offset="1" stopColor={shade(fur, -0.32)} />
        </radialGradient>
        <radialGradient id={`${id}m`} cx="50%" cy="40%" r="70%">
          <stop offset="0" stopColor={shade(mask, 0.12)} /><stop offset="1" stopColor={shade(mask, -0.12)} />
        </radialGradient>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2b2b2e" /><stop offset=".35" stopColor="#0c0c0d" /><stop offset="1" stopColor="#050505" />
        </linearGradient>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset=".55" stopColor={shade(fur, 0.45)} stopOpacity="0" /><stop offset="1" stopColor={shade(fur, 0.45)} stopOpacity={light ? 0.55 : 0.25} />
        </linearGradient>
        <linearGradient id={`${id}h`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".28" /><stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        {/* Fur: the outline frayed by noise, then a dark and a light grain. */}
        <filter id={`${id}f`} x="-15%" y="-15%" width="130%" height="130%">
          <feTurbulence type="fractalNoise" baseFrequency="1.3" numOctaves={2} seed={seed} />
          <feDisplacementMap in="SourceGraphic" scale="5" xChannelSelector="R" yChannelSelector="G" />
          <feGaussianBlur stdDeviation=".25" />
        </filter>
        <filter id={`${id}k`} x="-15%" y="-15%" width="130%" height="130%">
          <feTurbulence type="fractalNoise" baseFrequency="1.5" numOctaves={2} seed={seed + 5} />
          <feDisplacementMap in="SourceGraphic" scale="3.2" xChannelSelector="R" yChannelSelector="G" />
          <feGaussianBlur stdDeviation=".45" />
        </filter>
        <filter id={`${id}t`} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="2.6" numOctaves={1} seed={seed + 3} />
          <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  3 0 0 0 -1.5" />
          <feComposite in2="SourceGraphic" operator="in" />
        </filter>
        <filter id={`${id}w`} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="2.3" numOctaves={1} seed={seed + 9} />
          <feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 3 0 0 -1.75" />
          <feComposite in2="SourceGraphic" operator="in" />
        </filter>
        {/* The eyes' glow: light on a screen, not paint. */}
        <filter id={`${id}e`} filterUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.7" result="b" />
          <feFlood floodColor="#ff9a4a" floodOpacity=".95" />
          <feComposite in2="b" operator="in" result="glow" />
          <feMerge><feMergeNode in="glow" /><feMergeNode in="glow" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id={`${id}a`} filterUnits="userSpaceOnUse" x="-10" y="-10" width="130" height="130">
          <feDropShadow dx="0" dy="1" stdDeviation=".7" floodColor="#000" floodOpacity=".38" />
        </filter>
        <clipPath id={`${id}c`}><rect x={s.x} y={s.y} width={s.w} height={s.h} rx={s.h * 0.32} /></clipPath>
      </defs>
      {whole && shadow && <ellipse cx="50" cy="95" rx={L.bottomWidth * 0.42} ry="3.4" fill="#000" opacity=".42" />}
      {part === 'acc' && (
        <g filter={`url(#${id}a)`} data-mascot-acc={acc}>
          <MascotAccessoryIcon acc={acc} />
        </g>
      )}
      {part !== 'acc' && <g>
        {whole && <g filter={`url(#${id}f)`}>
          <circle cx={e.left} cy={e.y} r={e.r} fill={`url(#${id}g)`} />
          <circle cx={e.right} cy={e.y} r={e.r} fill={`url(#${id}g)`} />
          <ellipse cx={e.left - 2} cy={e.y + 0.5} rx={e.r * 0.4} ry={e.r * 0.6} fill={shade(fur, -0.6)} opacity=".8" />
          <ellipse cx={e.right + 2} cy={e.y + 0.5} rx={e.r * 0.4} ry={e.r * 0.6} fill={shade(fur, -0.6)} opacity=".8" />
          <path d={L.head} fill={`url(#${id}g)`} />
          <path d={L.head} fill={`url(#${id}b)`} />
          <path d={L.head} fill="#000" opacity=".22" filter={`url(#${id}t)`} />
          <path d={L.head} fill="#fff" opacity=".18" filter={`url(#${id}w)`} />
        </g>}
        {whole && <rect x={m.x} y={m.y} width={m.w} height={m.h} rx={m.h * 0.4} fill={`url(#${id}m)`} filter={`url(#${id}k)`} />}
        {whole && <rect x={m.x} y={m.y} width={m.w} height={m.h} rx={m.h * 0.4} fill="#000" opacity=".18" filter={`url(#${id}t)`} />}
        <rect x={s.x - 0.8} y={s.y - 0.8} width={s.w + 1.6} height={s.h + 1.6} rx={s.h * 0.34} fill="#1d1d1f" />
        <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={s.h * 0.32} fill={`url(#${id}s)`} />
        <g clipPath={`url(#${id}c)`}>
          <g ref={eyesRef} className="rooks-mascot-eyes">
            <g ref={blinkRef} className="rooks-mascot-blink" fill="#fff4e6" filter={`url(#${id}e)`}>
              <path ref={lRef} d={ptsPath(eyePts.L)} />
              <path ref={rRef} d={ptsPath(eyePts.R)} />
              <path ref={mRef} d={ptsPath(eyePts.M)} />
            </g>
          </g>
          <rect x={s.x + 3} y={s.y + 1.2} width={s.w - 6} height={s.h * 0.3} rx={s.h * 0.15} fill={`url(#${id}h)`} />
        </g>
        {whole && acc !== 'none' && (
          <g filter={`url(#${id}a)`} data-mascot-acc={acc}>
            <MascotAccessoryArt acc={acc} top={L.top} fit={fit} />
          </g>
        )}
      </g>}
    </svg>
  );
}

/** The default occupant of `agent.mascot`: the product's drawing, from the host's request. */
export function ProductAgentMascot(): ReactElement | null {
  const v = useAgentMascot();
  if (!v) return null;
  return <AgentMascotFromValue value={v} />;
}

function AgentMascotFromValue({ value: v, part = null }: { value: AgentMascotValue; part?: MascotDrawnPart | null }): ReactElement {
  return (
    <AgentMascot
      part={part}
      {...v.look}
      color={v.fur}
      size={v.size}
      live={v.live}
      state={v.state}
      fit={v.fit}
      shadow={v.shadow}
      label={v.label}
    />
  );
}

export type AgentMascotHostProps = {
  /** Any value: what is not a valid `AgentLook` field falls back to `base`, field by field. */
  look?: Partial<AgentLook> | null;
  /** What a field falls back to — a pack's part whose plugin is not here included. Default: `DEFAULT_LOOK`. */
  base?: AgentLook;
  size?: number;
  live?: boolean;
  state?: MascotState | null;
  fit?: boolean;
  shadow?: boolean;
  label?: string | null;
  /**
   * One part alone (the configurator's cells). Drawn by the product's mascot
   * only: a plugin's replacement keeps drawing its whole head, outside the
   * slot's contract.
   */
  part?: MascotDrawnPart | null;
};

/**
 * One agent's mascot, painted by the `agent.mascot` occupant — a plugin's
 * replacement, or the product's drawing. The screens of the onboarding, the
 * agent creation and the chat mount this, never `AgentMascot`.
 */
export function AgentMascotHost({
  look, base = DEFAULT_LOOK, size = 96, live = false, state = null, fit = false, shadow = true, label = null, part = null,
}: AgentMascotHostProps): ReactElement {
  const occupant = useSlotEntries(AGENT_MASCOT_SLOT)[0];
  const claimed = occupant !== undefined;
  const product = !occupant || occupant.Component === ProductAgentMascot;
  const reducedMotion = usePrefersReducedMotion();
  const shape = look?.shape;
  const color = look?.color;
  const eyes = look?.eyes;
  const acc = look?.acc;
  // A pack coming or going changes what normalises.
  const parts = useMascotPartsVersion();
  const value = useMemo<AgentMascotValue>(() => {
    const normal = normalizeAgentLook({ shape, color, eyes, acc }, base);
    return {
      look: normal,
      fur: lookFurHex(normal.color),
      size,
      live: live && !reducedMotion,
      state: isMascotState(state) ? state : null,
      fit,
      shadow,
      label: label || null,
      reducedMotion,
    };
  }, [shape, color, eyes, acc, base, size, live, reducedMotion, state, fit, shadow, label, parts]);
  return (
    <AgentMascotProvider value={value}>
      {part && product
        ? <AgentMascotFromValue value={value} part={part} />
        : claimed ? <SlotSingle name={AGENT_MASCOT_SLOT} /> : <AgentMascotFromValue value={value} />}
    </AgentMascotProvider>
  );
}
