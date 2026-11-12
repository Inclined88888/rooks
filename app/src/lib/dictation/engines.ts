import type { ComponentType } from 'react';

import { clientPluginHolds, DICTATION_ENGINE_PERMISSION, subscribeClientPermissions } from '@/lib/plugin-host/plugin-permissions';
import { slotEntries, subscribeSlots } from '@/lib/plugin-host/slots';

import { DICTATION_ENGINE_SLOT, readDictationAvailability, type DictationAvailability, type DictationEngine } from './contract';

/**
 * The window's single view of the dictation engines (TODO #484): who is
 * registered in `dictation.engine`, and what each last said of its
 * availability. Generalizes the desktop-only store it replaces on the
 * product's side — the desktop's model state now belongs to the occupant
 * that wraps the desktop (`plugins-client/local-dictation`).
 *
 * An engine is a plugin's code: its availability is read through a guard and
 * a deadline, and an answer that fails either counts as unknown, which the
 * route treats as usable — the start answers it for real, the way an
 * unknown desktop state did before.
 */

/** `Panel`: the component registered with the engine, its settings panel (painted in Settings → Voice). */
export type RegisteredEngine = { pluginId: string; engine: DictationEngine; Panel: ComponentType };

/** An engine that does not answer within this is unknown, not stuck. */
export const AVAILABILITY_DEADLINE_MS = 5_000;

type Listener = () => void;

const known = new WeakMap<DictationEngine, DictationAvailability>();
const asking = new WeakMap<DictationEngine, Promise<DictationAvailability | null>>();
const listeners = new Set<Listener>();

function publish(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * The engines the product may hand a microphone to, the product's own first,
 * then in registration order. One whose plugin no longer holds
 * `dictation:engine` is out at once, even before its entry is disposed.
 */
export function dictationEngines(): RegisteredEngine[] {
  const engines: RegisteredEngine[] = [];
  for (const entry of slotEntries(DICTATION_ENGINE_SLOT)) {
    if (!entry.dictation || !clientPluginHolds(entry.pluginId, DICTATION_ENGINE_PERMISSION)) continue;
    engines.push({ pluginId: entry.pluginId, engine: entry.dictation, Panel: entry.Component });
  }
  const product = (pluginId: string) => (pluginId.startsWith('@rooks/') ? 0 : 1);
  return engines.sort((a, b) => product(a.pluginId) - product(b.pluginId));
}

export function dictationEngine(id: string): RegisteredEngine | null {
  return dictationEngines().find((entry) => entry.engine.id === id) ?? null;
}

/** The last availability the engine gave; null while unknown. */
export function knownAvailability(engine: DictationEngine): DictationAvailability | null {
  return known.get(engine) ?? null;
}

/**
 * Asks the engine again; concurrent calls share one question. Resolves to
 * null when it throws, answers out of contract or misses the deadline.
 */
export function readAvailability(engine: DictationEngine, deadlineMs = AVAILABILITY_DEADLINE_MS): Promise<DictationAvailability | null> {
  const inFlight = asking.get(engine);
  if (inFlight) return inFlight;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deadlineMs); });
  const answer = Promise.resolve()
    .then(() => engine.availability())
    .then(readDictationAvailability, () => null);
  const question = Promise.race([answer, deadline]).then((availability) => {
    clearTimeout(timer);
    asking.delete(engine);
    const before = known.get(engine);
    if (availability && (before?.state !== availability.state || before.reason !== availability.reason)) {
      known.set(engine, availability);
      publish();
    }
    return availability;
  });
  asking.set(engine, question);
  return question;
}

/**
 * Repaints on a registration, a grant taken back, or a new availability.
 * Subscribing asks every engine not heard from yet: the route of a composer
 * on screen follows the engines that come and go.
 */
export function subscribeDictationEngines(listener: Listener): () => void {
  listeners.add(listener);
  const ask = () => {
    for (const { engine } of dictationEngines()) {
      if (!known.has(engine)) void readAvailability(engine);
    }
  };
  const onChange = () => { ask(); listener(); };
  const unsubscribeSlots = subscribeSlots(onChange);
  const unsubscribePermissions = subscribeClientPermissions(onChange);
  ask();
  return () => {
    listeners.delete(listener);
    unsubscribeSlots();
    unsubscribePermissions();
  };
}
