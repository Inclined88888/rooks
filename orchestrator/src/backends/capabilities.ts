/**
 * Declared backend capabilities (cf. `BackendCapabilities` in `./types.ts`):
 * the one resolver the catalogue, the dispatcher and the chat routes read, so
 * they can never disagree on what a backend can do.
 */
import { BACKEND_CAPABILITIES, DEFAULT_BACKEND_CAPABILITIES, type BackendCapabilities, type BackendProfile, type Dialect } from './types.js';
import { getDialect, installedProfiles } from './registry.js';
import { baseBackendId } from './instance-id.js';

/** Dialect AND profile, every key absent = true: a profile narrows, it never
 *  gives back what its dialect declared it cannot do. */
export function resolveCapabilities(
  dialect: Pick<Dialect, 'capabilities'> | undefined,
  profile: Pick<BackendProfile, 'capabilities'> | undefined,
): BackendCapabilities {
  const resolved = { ...DEFAULT_BACKEND_CAPABILITIES };
  for (const key of BACKEND_CAPABILITIES) {
    resolved[key] = dialect?.capabilities?.[key] !== false && profile?.capabilities?.[key] !== false;
  }
  return Object.freeze(resolved);
}

/**
 * Capabilities of backend `id`, read off the installed definitions (an
 * inactive profile still says what it cannot do). An unknown id gets the
 * default: refusing on a name nobody registered is `isBackendName`'s job, not
 * this one's.
 */
export function backendCapabilities(id: string | null | undefined): BackendCapabilities {
  const profile = id ? installedProfiles().find((entry) => entry.id === id) : undefined;
  if (!profile) return DEFAULT_BACKEND_CAPABILITIES;
  return resolveCapabilities(getDialect(profile.dialect), profile);
}

/**
 * The message that makes backend `id` compact its own session
 * (`SessionStrategy.compact`), or null when it cannot. Read off the dialect,
 * never off a name; an account instance (`claude@<id>`) is its backend's
 * dialect. Not one of the `BackendCapabilities` flags: those default to true
 * and only narrow, whereas compaction is something a provider has to declare.
 */
export function nativeCompactCommand(id: string | null | undefined): string | null {
  if (!id) return null;
  const base = baseBackendId(id);
  const profile = installedProfiles().find((entry) => entry.id === base);
  const dialect = profile ? getDialect(profile.dialect) : undefined;
  return dialect?.nativeCompact?.command ?? null;
}

/**
 * Can an agent of this backend read a skill's body when it wants to? `skill_get`
 * needs Rooks's MCP, the file needs Rooks's disk, which `attachments` declares
 * (a path on that disk is only read by a local agent). With neither, a catalogue
 * line has no follow-up, so the spawn pastes the body instead.
 */
export function canReadSkillOnDemand(caps: Pick<BackendCapabilities, 'novaMcp' | 'attachments'>): boolean {
  return caps.novaMcp || caps.attachments;
}

/** Stable `code` of the 400 a route answers when the backend takes no files. */
export const ATTACHMENTS_UNSUPPORTED = 'attachments_unsupported';

/**
 * Why `backend` cannot receive these attachments, or null. Checked BEFORE
 * `persistChatAttachments` (`chat-attachments.ts`): a refused turn writes nothing on disk. A file is
 * announced to the agent by its path on Rooks's disk, which an agent without
 * the `attachments` capability (a remote one) cannot open — dropping the files
 * silently would let the user believe the agent read them.
 */
export function attachmentsRefusal(backend: string, inputs: unknown): string | null {
  if (!Array.isArray(inputs) || inputs.length === 0) return null;
  if (backendCapabilities(backend).attachments) return null;
  return `Backend \`${backend}\` does not accept attached files (images only): remove the files, or switch this conversation to a local backend.`;
}
