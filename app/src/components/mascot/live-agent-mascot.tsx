'use client';

/**
 * An agent's mascot that shows what the agent is doing (docs/AGENT-MASCOT.md,
 * section `États vivants hors du chat`). The views mount this wherever an agent's
 * head is its mascot — `AgentAvatar`, `FaceAgent`, the chat's bubbles, the
 * Multichat, the Agents graph — and it goes through `AgentMascotHost`, so a
 * plugin that takes the `agent.mascot` slot paints these too.
 *
 * - The state comes from the page's one store (`useAgentLiveState`).
 * - It moves only when everything allows it: `live`, "Animate mascots" on,
 *   on screen, awake, and no `prefers-reduced-motion` (the host checks that
 *   one). Otherwise the state still shows, by the eyes, still. A sleeping
 *   agent — most of them, most of the time — keeps its closed eyes without
 *   running the motion engine: the cost follows the agents at work.
 * - `live={false}`: the bare look, still, and no subscription at all — for
 *   menus, pickers and very long lists.
 */

import { useRef, type ReactElement } from 'react';
import { cn } from '@/lib/utils';
import type { AgentLook } from './agent-look';
import { AgentMascotHost } from './agent-mascot';
import { RESTING, useAgentLiveState } from './agent-live-state';
import type { MascotState } from './mascot-states';
import { useMascotAnimation } from './mascot-animation-pref';
import { useOnScreen } from './use-on-screen';

export type LiveAgentMascotProps = {
  /** The agent whose activity the mascot shows. */
  name: string;
  look: AgentLook;
  /** Where an invalid field falls back (the agent's role default); see `AgentMascotHost`. */
  base?: AgentLook;
  size: number;
  /** `false`: the bare look, still, no live state. */
  live?: boolean;
  fit?: boolean;
  shadow?: boolean;
  label?: string | null;
  /** On the wrapper, which the off-screen observer watches. */
  className?: string;
  /**
   * The state to show instead of the page's store, when the caller knows
   * better: a chat knows whether ITS conversation waits, while the store only
   * knows the agent, across all its conversations. `undefined`: the store.
   */
  state?: MascotState;
};

export function LiveAgentMascot({
  name, look, base, size, live = true, fit = true, shadow = false, label = null, className, state: given,
}: LiveAgentMascotProps): ReactElement {
  const ref = useRef<HTMLSpanElement>(null);
  const stored = useAgentLiveState(live && given === undefined ? name : null);
  const state = live ? given ?? stored : null;
  const animate = useMascotAnimation();
  const onScreen = useOnScreen(ref, live && animate);
  return (
    <span ref={ref} className={cn('inline-grid place-items-center', className)} data-mascot-state={state ?? undefined}>
      <AgentMascotHost look={look} base={base} size={size} live={live && animate && onScreen && state !== RESTING} state={state} fit={fit} shadow={shadow} label={label} />
    </span>
  );
}
