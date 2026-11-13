/**
 * What the agent import shows the outside world: the socket a source adapter
 * plugs into, the shapes its routes answer with, and its declared event.
 * No runtime dependency here: the browser half and a third-party adapter read
 * the same file.
 */

/**
 * The list socket a source adapter registers into (`client.slots` of the
 * adapter). Slot names admit no hyphen (`[a-z][a-z0-9]*` segments), hence
 * `agentimport` rather than the plugin id.
 */
export const SOURCE_SLOT = 'agentimport.source';

/** Local name of the event published per imported agent; qualified `<id>:applied@1`. */
export const APPLIED_EVENT_NAME = 'applied';
export const APPLIED_EVENT_VERSION = 1;

/** Payload of `agent-import:applied@1`, one per agent the import created or updated. */
export type AgentImportApplied = {
  /** Stable identity of the agent in its source, the key of a re-import. */
  sourceRef: string;
  /** Name of the Rooks agent created or updated. */
  agent: string;
  /** Who wrote it: always `plugin:<id>` of the import. */
  origin: string;
  /** The application the agent came from (`hermes`, `openbot`, `rooks`…). */
  sourceApp: string;
};

/** A staged archive, as `stage` and `preview` describe it. Never carries the token. */
export type StagedArchive = {
  sha256: string;
  size: number;
  /** Epoch ms after which the token no longer opens anything. */
  expiresAt: number;
};

export type StageResponse = StagedArchive & {
  /** Single-use, bound to the account that staged it. Sent back in a JSON body only. */
  token: string;
};

export type PreviewAgentAction = 'create' | 'update' | 'skip';

/** What an imported agent may bring besides its instructions, each one a box the user may untick. */
export const IMPORT_ELEMENTS = ['soul', 'memory', 'skills', 'mcp', 'routines', 'team'] as const;
export type ImportElement = (typeof IMPORT_ELEMENTS)[number];

/** Role an imported agent gets unless the user picks another. */
export const DEFAULT_IMPORT_ROLE = 'research';

export type PreviewElement = {
  /** What would actually be written (after the rules of the import and the caller's rights). */
  count: number;
  selected: boolean;
};

export type PreviewAgent = {
  sourceRef: string;
  displayName: string;
  action: PreviewAgentAction;
  warnings: string[];
  /** The Rooks name the agent gets (or already has, for an update). */
  finalName?: string;
  role?: string;
  project?: string | null;
  cwd?: string | null;
  /** The chosen working directory does not exist: the agent is created without it. */
  cwdMissing?: boolean;
  /** The working directory at the source (manifest `hints.cwd`), as written there. */
  sourceCwd?: string | null;
  /**
   * A directory of this machine that looks like the source's one (same
   * trailing folders under the home directory, or the project's), proposed
   * when `sourceCwd` does not exist here. Applied only if chosen (`cwd`).
   */
  cwdSuggestion?: string | null;
  /** The backend and model the agent gets: the source's when they exist here, else `null` (Rooks's default). */
  backend?: string | null;
  model?: string | null;
  /** The source names a backend this Rooks does not have. */
  backendMissing?: boolean;
  /** The source names a model its backend does not offer here. */
  modelMissing?: boolean;
  /**
   * Routines that are switched on at the source. They are imported switched
   * off unless the user chooses `keepRoutinesActive` for this agent.
   */
  activeRoutines?: number;
  elements?: Partial<Record<ImportElement, PreviewElement>>;
};

export type ImportPreview = {
  agents: PreviewAgent[];
  warnings: string[];
  /** The application the manifest came from, and when it was exported. */
  source?: { app: string; exportedAt: string | null };
};

export type PreviewResponse = {
  archive: StagedArchive;
  preview: ImportPreview;
  /** `true` once the import engine reads the archive. */
  ready: boolean;
};

/** The user's choice for one agent of the manifest; absent fields keep the preview's default. */
export type AgentChoice = {
  sourceRef: string;
  /** `false` leaves the agent out. */
  include?: boolean;
  /** Full Rooks name, instead of `<prefix>.<key>`. */
  name?: string;
  role?: string;
  project?: string | null;
  /** A directory of this machine; `null` = none, even if the source had one. Absent: the source's, when it exists here. */
  cwd?: string | null;
  elements?: Partial<Record<ImportElement, boolean>>;
  /**
   * Routines switched on at the source stay on. Absent or `false`: every
   * routine is imported switched off. An imported instruction starts tasks
   * with nobody in front, so only an explicit choice turns one on.
   */
  keepRoutinesActive?: boolean;
};

export type ImportOptions = {
  /** Id of the source adapter that produced the manifest (informational). */
  source?: string;
  /** Name prefix instead of the source application's (`hermes` → `hermes.<key>`). */
  prefix?: string;
  agents?: AgentChoice[];
};

/** Body of `preview` and `apply`. */
export type ImportRequest = { token: string; options?: ImportOptions };

export type ImportResultStatus = 'created' | 'updated' | 'skipped' | 'failed';

export type ImportResultAgent = {
  sourceRef: string;
  displayName: string;
  /** The Rooks agent, `null` when nothing was kept. */
  agent: string | null;
  status: ImportResultStatus;
  error?: string;
  warnings: string[];
};

export type ApplyResponse = {
  agents: ImportResultAgent[];
  warnings: string[];
};

export type AgentImportErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid'
  | 'unsupported_media_type'
  | 'not_a_zip'
  | 'empty'
  | 'too_large'
  | 'too_many'
  | 'not_found'
  | 'archive_changed'
  | 'invalid_manifest'
  | 'not_implemented'
  | 'internal';

export type AgentImportError = { error: string; code: AgentImportErrorCode };

/** A Hermes profile the daemon found on its own disk. Named, never located: no path reaches a browser. */
export type HermesProfileSummary = { name: string; displayName: string };

/** `GET hermes`: the Hermes installation of the daemon's machine, if any. */
export type HermesDetectResponse = {
  found: boolean;
  /** Where it was found, as the user knows it (`~/.hermes`, `%LOCALAPPDATA%\hermes`). */
  label?: string;
  profiles: HermesProfileSummary[];
};

/** `POST hermes/stage`: profile names among the detected ones, all of them when absent. Answers a `StageResponse`. */
export type HermesStageRequest = { profiles?: string[] };
