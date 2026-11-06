import { machineLocalStorage } from '@/lib/machines/machine-storage';

import type { EngineAdmission } from './engine-recognition';
import { destinationFingerprint, engineDestination, subscribeDictationDeclarations, type VoiceDestination } from './destination';

/**
 * The user's consent to a dictation engine (TODO #484, vault §3.4): given
 * per engine, for the destination it was shown, on one machine.
 *
 *  - per engine: `<pluginId> <engineId>`, the identity the registry checks
 *    the permission on, never the engine's own label;
 *  - for a destination: the consent keeps the fingerprint of the `egress` the
 *    card named. A plugin update that changes it (a new host, `none` →
 *    `daemon`) finds a fingerprint that no longer matches, and the card is
 *    shown again — a refusal is forgotten the same way;
 *  - on one machine: stored through `machineLocalStorage`, so a consent given
 *    while working on a remote machine does not follow the user to another
 *    one, whose daemon would receive the voice instead.
 *
 * A third-party engine needs it whatever its `egress`, `none` included: the
 * declaration is reviewed, not enforced (no CSP confines a plugin's page code,
 * `docs/SECURITY.md` §9), and the engine hears the voice either way. The
 * product's own engine needs none: the desktop's is on this computer, and its
 * model download has its own card.
 */

export type ConsentDecision = 'granted' | 'refused';

export type EngineConsent =
  /** The product's own engine. */
  | 'not-needed'
  | 'granted'
  | 'refused'
  /** Never asked, or asked for another destination. */
  | 'ask'
  /** Its plugin declares no destination for it: never usable, nothing to ask. */
  | 'undeclared';

const STORAGE_KEY = 'timon.dictation.consent';
const VERSION = 1;
/** Way above any real install; a store past it is junk, not consents. */
const MAX_RECORDS = 200;

type ConsentRecord = { decision: ConsentDecision; egress: string };
type Stored = { v: typeof VERSION; engines: Record<string, ConsentRecord> };

const listeners = new Set<() => void>();
/** Changes made by this window when storage is out of reach (private mode): kept for the session. */
let memory: Record<string, ConsentRecord> | null = null;

export function consentKey(pluginId: string, engineId: string): string {
  return `${pluginId} ${engineId}`;
}

function readRecords(): Record<string, ConsentRecord> {
  if (memory) return memory;
  let raw: string | null = null;
  try { raw = machineLocalStorage()?.getItem(STORAGE_KEY) ?? null; } catch { raw = null; }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<Stored> | null;
    if (!parsed || parsed.v !== VERSION || typeof parsed.engines !== 'object' || parsed.engines === null) return {};
    const out: Record<string, ConsentRecord> = {};
    for (const [key, value] of Object.entries(parsed.engines).slice(0, MAX_RECORDS)) {
      const v = value as Partial<ConsentRecord> | null;
      if (!v || (v.decision !== 'granted' && v.decision !== 'refused') || typeof v.egress !== 'string') continue;
      out[key] = { decision: v.decision, egress: v.egress };
    }
    return out;
  } catch {
    return {};
  }
}

function writeRecords(records: Record<string, ConsentRecord>): void {
  const stored: Stored = { v: VERSION, engines: records };
  try {
    const storage = machineLocalStorage();
    if (!storage) throw new Error('no storage');
    storage.setItem(STORAGE_KEY, JSON.stringify(stored));
    memory = null;
  } catch {
    memory = records;
  }
  publish();
}

function publish(): void {
  for (const listener of [...listeners]) listener();
}

/** What the user said of this engine, for where its plugin says the voice goes today. */
export function engineConsent(pluginId: string, engineId: string): EngineConsent {
  return consentFor(engineDestination(pluginId, engineId), readRecords()[consentKey(pluginId, engineId)]);
}

function consentFor(destination: VoiceDestination, record: ConsentRecord | undefined): EngineConsent {
  if (destination.kind === 'device') return 'not-needed';
  const fingerprint = destinationFingerprint(destination);
  if (fingerprint === null) return 'undeclared';
  return record && record.egress === fingerprint ? record.decision : 'ask';
}

/**
 * Records the user's answer for the destination the engine has NOW. False
 * when there is nothing to record (a product engine, an undeclared one): an
 * answer is never stored for a destination nobody was shown.
 */
export function decideEngineConsent(pluginId: string, engineId: string, decision: ConsentDecision): boolean {
  const fingerprint = destinationFingerprint(engineDestination(pluginId, engineId));
  if (fingerprint === null) return false;
  writeRecords({ ...readRecords(), [consentKey(pluginId, engineId)]: { decision, egress: fingerprint } });
  return true;
}

/** Back to "never asked": the next dictation shows the card again. */
export function forgetEngineConsent(pluginId: string, engineId: string): void {
  const records = { ...readRecords() };
  if (!(consentKey(pluginId, engineId) in records)) return;
  delete records[consentKey(pluginId, engineId)];
  writeRecords(records);
}

/** A decision here or in another window, or a plugin whose declaration changed. */
export function subscribeEngineConsent(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.endsWith(STORAGE_KEY)) listener();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  const unsubscribeDeclarations = subscribeDictationDeclarations(listener);
  return () => {
    listeners.delete(listener);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
    unsubscribeDeclarations();
  };
}

export type ConsentRequest = { pluginId: string; engineId: string; engineLabel: string };

/**
 * The gate of a dictation start: `go` for a consented (or product) engine;
 * otherwise the card is asked for (`present`, false when nothing could show
 * it) and the start ends there. Never falls back on another engine: a
 * refused engine is unusable, and the user is told so.
 */
export function admitEngine(request: ConsentRequest, present: (request: ConsentRequest) => boolean): EngineAdmission {
  switch (engineConsent(request.pluginId, request.engineId)) {
    case 'not-needed':
    case 'granted':
      return 'go';
    case 'refused':
      return 'refused';
    case 'undeclared':
      return 'undeclared';
    case 'ask':
      return present(request) ? 'asked' : 'refused';
  }
}
