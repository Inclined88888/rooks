import { machineLocalStorage } from '@/lib/machines/machine-storage';

/**
 * The dictation engine the user chose (TODO #492), kept per machine through
 * `machineLocalStorage` like the consent beside it (`consent.ts`): a choice
 * made while working on a remote machine does not follow the user home.
 *
 *  - `auto`: the order the product always had (its own engines first, Web
 *    Speech before any engine in a browser). The default: nothing changes
 *    for whoever never opens the selector;
 *  - `web-speech`: the browser's recognizer;
 *  - `engine`: one registered engine, named by its plugin AND its id — an
 *    engine id taken over by another plugin after an uninstall is another
 *    engine, with another destination, and never matches.
 *
 * A chosen engine that cannot run is never replaced in silence by one that
 * sends the voice elsewhere (`recognition.ts`). One whose plugin is gone for
 * good is reset to `auto`, and the reset is kept as a notice until the user
 * chooses again, so the Voice pane can say it.
 */

export type DictationChoice =
  | { kind: 'auto' }
  | { kind: 'web-speech' }
  /** `label` is the engine's as it was chosen: what to name it once it is gone. */
  | { kind: 'engine'; pluginId: string; engineId: string; label: string };

export const AUTO_CHOICE: DictationChoice = { kind: 'auto' };

const STORAGE_KEY = 'timon.dictation.engine';
const VERSION = 1;
const MAX_FIELD = 214;

type Stored = { v: typeof VERSION; choice: DictationChoice; resetFrom?: string };

const listeners = new Set<() => void>();
/** This window's state when storage is out of reach (private mode). */
let memory: Stored | null = null;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD ? value : null;
}

function readChoice(value: unknown): DictationChoice | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.kind === 'auto' || v.kind === 'web-speech') return { kind: v.kind };
  if (v.kind !== 'engine') return null;
  const pluginId = text(v.pluginId);
  const engineId = text(v.engineId);
  const label = text(v.label);
  return pluginId && engineId && label ? { kind: 'engine', pluginId, engineId, label } : null;
}

function readStored(): Stored {
  if (memory) return memory;
  let raw: string | null = null;
  try { raw = machineLocalStorage()?.getItem(STORAGE_KEY) ?? null; } catch { raw = null; }
  if (!raw) return { v: VERSION, choice: AUTO_CHOICE };
  try {
    const parsed = JSON.parse(raw) as Partial<Stored> | null;
    // Out of shape = never chosen: `auto` is what the product did before.
    const choice = parsed?.v === VERSION ? readChoice(parsed.choice) : null;
    if (!choice) return { v: VERSION, choice: AUTO_CHOICE };
    const resetFrom = text(parsed?.resetFrom);
    return resetFrom ? { v: VERSION, choice, resetFrom } : { v: VERSION, choice };
  } catch {
    return { v: VERSION, choice: AUTO_CHOICE };
  }
}

function writeStored(stored: Stored): void {
  try {
    const storage = machineLocalStorage();
    if (!storage) throw new Error('no storage');
    storage.setItem(STORAGE_KEY, JSON.stringify(stored));
    memory = null;
  } catch {
    memory = stored;
  }
  for (const listener of [...listeners]) listener();
}

export function dictationChoice(): DictationChoice {
  return readStored().choice;
}

/** The engine a reset to `auto` replaced, until the user chooses again. */
export function dictationChoiceResetFrom(): string | null {
  return readStored().resetFrom ?? null;
}

export function setDictationChoice(choice: DictationChoice): void {
  writeStored({ v: VERSION, choice });
}

/** Back to `auto` because the chosen engine is gone, remembering which one. */
export function resetDictationChoice(label: string): void {
  writeStored({ v: VERSION, choice: AUTO_CHOICE, resetFrom: label.slice(0, MAX_FIELD) });
}

/** The notice of a reset, read: the pane stops showing it. */
export function dismissDictationChoiceReset(): void {
  const stored = readStored();
  if (!stored.resetFrom) return;
  writeStored({ v: VERSION, choice: stored.choice });
}

export function sameChoice(a: DictationChoice, b: DictationChoice): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind !== 'engine' || b.kind !== 'engine') return true;
  return a.pluginId === b.pluginId && a.engineId === b.engineId;
}

/** A choice here or in another window of this machine. */
export function subscribeDictationChoice(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.endsWith(STORAGE_KEY)) listener();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/** Test seam: forget this window's in-memory state. */
export function resetDictationChoiceForTests(): void {
  memory = null;
}
