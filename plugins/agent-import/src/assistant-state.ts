/**
 * The import assistant's rules, kept out of React so they can be tested on
 * their own: the user's choices drawn from a preview, the bodies sent to the
 * routes, and what a failure reads like.
 */
import {
  DEFAULT_IMPORT_ROLE, IMPORT_ELEMENTS,
  type AgentChoice, type AgentImportErrorCode, type ImportElement, type ImportOptions, type ImportPreview,
  type ImportRequest, type PreviewAgent,
} from './contract.js';
import { ZIP_UPLOAD_MAX_BYTES } from './readers/limits.js';

/** The roles a task can be typed with: what an imported agent may hold on its project. */
/** Rooks's built-in agent roles (`agent-roles.ts` ids): an agent's role, not a task type. */
export const IMPORT_ROLES = ['research', 'coder', 'reviewer', 'merger', 'librarian', 'ops'] as const;

export const UPLOAD_MAX_BYTES = ZIP_UPLOAD_MAX_BYTES;

/**
 * What the agent card shows, field by field: the user's choice when there is
 * one, the preview's proposal otherwise. Only what the user touched is ever
 * sent back: an absent field keeps the engine's default, and a role sent for
 * an agent already imported would replace the one it has.
 */
export function shownChoice(agent: PreviewAgent, choice: AgentChoice | undefined) {
  const elements: Partial<Record<ImportElement, boolean>> = {};
  for (const element of IMPORT_ELEMENTS) {
    const shown = agent.elements?.[element];
    if (shown) elements[element] = choice?.elements?.[element] ?? shown.selected;
  }
  return {
    include: choice?.include ?? agent.action !== 'skip',
    /** The engine skips this agent on its own (changed by hand, no free name): the user cannot force it. */
    lockedOut: agent.action === 'skip' && choice?.include === undefined,
    name: choice?.name ?? agent.finalName ?? agent.displayName,
    role: choice?.role ?? agent.role ?? DEFAULT_IMPORT_ROLE,
    project: choice?.project !== undefined ? choice.project : agent.project ?? null,
    cwd: choice?.cwd !== undefined ? choice.cwd : agent.cwd ?? null,
    elements,
    /** Routines on at the source stay on only when the user says so: off by default. */
    keepRoutinesActive: choice?.keepRoutinesActive === true,
  };
}

/**
 * The choices after a new preview: what the user set is kept for the agents
 * still there, and an agent gone from the preview is dropped.
 */
export function mergeChoices(
  previous: Readonly<Record<string, AgentChoice>>,
  preview: ImportPreview,
): Record<string, AgentChoice> {
  const next: Record<string, AgentChoice> = {};
  for (const agent of preview.agents) next[agent.sourceRef] = previous[agent.sourceRef] ?? { sourceRef: agent.sourceRef };
  return next;
}

/** The options sent with `preview` and `apply`: the user's own choices, agents in the preview's order. */
export function importOptions(
  sourceId: string | null,
  preview: ImportPreview | null,
  choices: Readonly<Record<string, AgentChoice>>,
): ImportOptions {
  const agents = (preview?.agents ?? [])
    .map((agent) => choices[agent.sourceRef])
    .filter((choice): choice is AgentChoice => choice !== undefined)
    .map((choice) => {
      const out: AgentChoice = { ...choice };
      if (choice.name !== undefined) out.name = choice.name.trim() || undefined;
      if (out.name === undefined) delete out.name;
      // A cleared folder is a choice: no working folder.
      if (choice.cwd !== undefined) out.cwd = choice.cwd?.trim() || null;
      return out;
    });
  return { ...(sourceId ? { source: sourceId } : {}), agents };
}

/**
 * Body of `preview` and `apply`. Options travel only once the engine answers
 * `ready`: a daemon without it takes the token alone, and the choices would
 * turn a working call into a 400.
 */
export function requestBody(token: string, ready: boolean, options: ImportOptions): ImportRequest {
  return ready ? { token, options } : { token };
}

/** Agents that will be written, and how many of them replace an earlier import. */
export function applySummary(
  preview: ImportPreview | null,
  choices: Readonly<Record<string, AgentChoice>>,
): { included: number; updated: number } {
  let included = 0;
  let updated = 0;
  for (const agent of preview?.agents ?? []) {
    const choice = choices[agent.sourceRef];
    if (agent.action === 'skip' || choice?.include === false) continue;
    included += 1;
    if (agent.action === 'update') updated += 1;
  }
  return { included, updated };
}

/** A failure, as the assistant shows it: a key of its messages, or the daemon's own words. */
export type ImportFailure = { key: string; vars?: Record<string, string | number> } | { text: string };

const KNOWN_CODES: ReadonlySet<AgentImportErrorCode> = new Set<AgentImportErrorCode>([
  'unauthorized', 'forbidden', 'invalid', 'unsupported_media_type', 'not_a_zip', 'empty', 'too_large',
  'too_many', 'not_found', 'archive_changed', 'invalid_manifest', 'not_implemented', 'internal',
]);

const HERMES_CODES: ReadonlySet<string> = new Set(['not_found', 'too_large', 'archive_changed']);

/**
 * What a failed call reads like. `step` tells a refused upload apart: an app
 * older than its binary relay to plugin routes (TODO #804) refuses a zip with
 * `invalid JSON body` before the daemon sees it, which is a missing piece of
 * that app, not a bad file. `hermes/stage` reads a folder of the daemon's
 * machine, not a sent archive: its codes get their own words.
 */
export function failureOf(
  step: 'stage' | 'hermes/stage' | 'preview' | 'apply' | 'discard',
  status: number,
  body: unknown,
): ImportFailure {
  const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {};
  const code = typeof record.code === 'string' ? record.code : '';
  const error = typeof record.error === 'string' ? record.error : '';
  if (step === 'hermes/stage' && HERMES_CODES.has(code)) return { key: `errors.hermes.${code}` };
  if (step === 'stage' && status === 400 && error === 'invalid JSON body') return { key: 'errors.uploadUnavailable' };
  if (KNOWN_CODES.has(code as AgentImportErrorCode)) {
    if (code === 'too_large') return { key: 'errors.too_large', vars: { size: UPLOAD_MAX_BYTES / (1024 * 1024) } };
    return { key: `errors.${code}` };
  }
  if (status === 401) return { key: 'errors.unauthorized' };
  if (status === 403) return { key: 'errors.forbidden' };
  if (error) return { text: error };
  return { key: 'errors.network' };
}

/** A file refused before it is sent, or `null` when it may go. */
export function fileFailure(file: { size: number }): ImportFailure | null {
  if (file.size === 0) return { key: 'errors.empty' };
  if (file.size > UPLOAD_MAX_BYTES) return { key: 'errors.too_large', vars: { size: UPLOAD_MAX_BYTES / (1024 * 1024) } };
  return null;
}
