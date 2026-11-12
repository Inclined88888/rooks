'use client';

/**
 * What an `agent.mascot` occupant is painted for: one agent's mascot, as the
 * screen asked for it (the onboarding, the agent creation, the chat).
 *
 * The slot passes no props — an entry is registered once and painted by every
 * host — so the host (`AgentMascotHost`) puts the request here and the
 * occupant reads it with `useAgentMascot()`.
 */

import { createContext, useContext } from 'react';
import type { AgentLook } from './agent-look';
import type { MascotState } from './mascot-states';

export type AgentMascotValue = {
  /**
   * Always complete and valid: the host has normalised what the screen passed.
   * A field may hold a mascot pack's part (`<pluginId>:<slug>`): draw an id
   * you do not know with a default.
   */
  look: AgentLook;
  /** The `#rrggbb` the look's colour paints — the colour itself, or a pack fur's. */
  fur: string;
  /** Edge of the square box, in CSS pixels. */
  size: number;
  /** The screen wants it alive (moving eyes, blinks, states). `false` under `prefers-reduced-motion`, whatever the screen asked. */
  live: boolean;
  /** What the agent is doing or how it reacts; `null`: just its look. */
  state: MascotState | null;
  /** The accessory must stay inside the box (a bitmap, a cell that clips). */
  fit: boolean;
  /** The soft shadow under the head (off in pickers and tight rows). */
  shadow: boolean;
  /** Accessible name; `null`: decorative, a word beside it names the agent. */
  label: string | null;
  /** The user asked for reduced motion: paint a still mascot. */
  reducedMotion: boolean;
};

const AgentMascotContext = createContext<AgentMascotValue | null>(null);

export const AgentMascotProvider = AgentMascotContext.Provider;

/** Readable by a plugin that takes the `agent.mascot` slot; `null` outside a host. */
export function useAgentMascot(): AgentMascotValue | null {
  return useContext(AgentMascotContext);
}
