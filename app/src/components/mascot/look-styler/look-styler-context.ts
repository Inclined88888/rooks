'use client';

/**
 * What an `agent.lookstyler` occupant is painted for: the mascot configurator
 * of one agent, wherever a screen opens it (the onboarding's side panel, the
 * Avatar tab of the agent editor).
 *
 * The slot passes no props — an entry is registered once and painted by every
 * host — so the host (`LookStylerHost`) puts the request here and the
 * occupant reads it with `useLookStyler()`. The container around it (panel,
 * tab, its title and its "Done") belongs to the screen, never to the
 * occupant: changing the configurator in one place changes it everywhere.
 */

import { createContext, useContext } from 'react';
import type { AgentLook } from '../agent-look';
import type { MascotPartId, MascotPartType } from '@/lib/mascot/parts-contract';
import type { MascotState } from '../mascot-states';

export type LookStylerValue = {
  /** Always complete and valid: the host has normalised what the screen passed. */
  look: AgentLook;
  /** Hands a new look to the screen. Normalised again by the host: a value off the lists keeps the current one. */
  onChange: (look: AgentLook) => void;
  /** The agent's name as the screen shows it (a draft name during the onboarding). */
  name: string;
  /** The agent's role (`coder`, `review`…), `null` when it has none. */
  role: string | null;
  /** The states the preview offers to try, in order. */
  states: readonly MascotState[];
  /**
   * What a look is drawn from: the product's lists, then the parts of the
   * mascot packs installed and enabled (`<pluginId>:<slug>`). The daemon
   * refuses anything else.
   */
  choices: {
    shapes: readonly AgentLook['shape'][];
    colors: readonly AgentLook['color'][];
    eyes: readonly AgentLook['eyes'][];
    accessories: readonly AgentLook['acc'][];
  };
  /** The packs whose parts `choices` holds, to group them by pack; empty without any. */
  packs: readonly {
    pluginId: string;
    /** The plugin's name in the gallery, or its id. */
    label: string;
    parts: readonly { id: MascotPartId; type: MascotPartType; label: string }[];
  }[];
  /** A whole look drawn at random from `choices`, packs included. */
  random: () => AgentLook;
};

const LookStylerContext = createContext<LookStylerValue | null>(null);

export const LookStylerProvider = LookStylerContext.Provider;

/** Readable by a plugin that takes the `agent.lookstyler` slot; `null` outside a host. */
export function useLookStyler(): LookStylerValue | null {
  return useContext(LookStylerContext);
}
