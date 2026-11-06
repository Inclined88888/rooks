/**
 * `useAgentImport()` — the import assistant as a source adapter sees it.
 *
 * A third-party adapter registers its component in the `agentimport.source`
 * socket and reads this hook from inside it. Plugin bundles do not share
 * modules, only React: the context object is therefore kept under a global
 * symbol, so the copy of this file an adapter bundles and the one the import
 * bundles hand out the very same context. Import it from
 * `@timon-ai/plugin-agent-import/hooks`, with `react` left external.
 */
import React from 'react';

export { SOURCE_SLOT } from './contract.js';
export type { AgentChoice, ApplyResponse, ImportPreview, StagedArchive, StageResponse } from './contract.js';
import type { AgentChoice, ApplyResponse, ImportPreview, StagedArchive, StageResponse } from './contract.js';

/** A source an adapter offers: what the assistant lists as "where from". */
export type AgentImportSource = {
  /** Unique in the assistant; the adapter's plugin id is a good choice. */
  id: string;
  label: string;
  /** What the source is read from: a folder the daemon detects, or a zip the user picks. */
  accepts: ReadonlyArray<'dir' | 'zip'>;
  /** One line under the label: what to export from the other tool, where to find it. */
  description?: string;
  /**
   * A button of its own on the card, beside the file button: what the user
   * needs before picking a file (the export skill to give the other tool).
   */
  action?: { label: string; run: () => void | Promise<void> };
};

export type AgentImportStep = 'source' | 'preview' | 'result';

export type AgentImportState = {
  step: AgentImportStep;
  /** The archive waiting for `apply`, once staged. The token never leaves the assistant. */
  staged: StagedArchive | null;
  warnings: readonly string[];
  /** The source the staged archive came from. */
  sourceId: string | null;
  /** What the engine says it will do, with the user's choices applied. */
  preview: ImportPreview | null;
  /** `false` while the engine is not shipped: the preview is then empty and nothing can be applied. */
  ready: boolean;
  /** The user's choices, by `sourceRef`. */
  choices: Readonly<Record<string, AgentChoice>>;
  result: ApplyResponse | null;
  /** A request is running (stage, preview, apply). */
  busy: boolean;
  /** Readable message of the last failure, in the user's language when the code is known. */
  error: string | null;
};

export type AgentImportValue = AgentImportState & {
  sources: readonly AgentImportSource[];
  /** Shown in the preview next to the engine's own warnings. */
  addWarning(text: string): void;
  /** Lists a source in the assistant; the returned function removes it (call it on unmount). */
  registerSource(source: AgentImportSource): () => void;
  /** Stages a zip the user picked, then opens its preview. */
  submitFile(sourceId: string, file: Blob): Promise<void>;
  /**
   * For a source that stages through its own route (a folder the daemon
   * detects): `stage` answers like the import's `stage` route, and the
   * assistant takes the token from there, then opens the preview.
   */
  submitStaged(sourceId: string, stage: () => Promise<StageResponse>): Promise<void>;
};

const CONTEXT_KEY = Symbol.for('timon.plugin.agent-import.context');
type ContextHolder = { [CONTEXT_KEY]?: React.Context<AgentImportValue | null> };

/** The one context every bundle shares. */
export function agentImportContext(): React.Context<AgentImportValue | null> {
  const holder = globalThis as ContextHolder;
  holder[CONTEXT_KEY] ??= React.createContext<AgentImportValue | null>(null);
  return holder[CONTEXT_KEY];
}

/** The assistant around the calling component, or `null` outside of it. */
export function useAgentImport(): AgentImportValue | null {
  return React.useContext(agentImportContext());
}
