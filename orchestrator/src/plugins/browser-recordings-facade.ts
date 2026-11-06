/**
 * `ctx.browserRecordings` (TODO #461): the recordings of the built-in browser, for a plugin that
 * extends them (send a reviewed flow to a ticket, mirror it elsewhere) without the core.
 *
 * Bounded like the routes: a recording is its owner's, and a plugin reaches it only inside that
 * owner's request (`browser:recordings:read`, `browser:recordings:write`, both sensitive). A job has
 * nobody behind it and reads nothing; another account's recording answers like a missing one,
 * superadmin included. Writes carry `origin: { kind: 'plugin', id }` on their events.
 */
import { getBrowserProfile } from '../browser-profiles.js';
import {
  deleteBrowserRecording, findBrowserRecordingByRef, getBrowserRecording, listBrowserRecordings,
  patchBrowserRecording, readBrowserRecordingSteps, setBrowserRecordingExternalRef,
  BrowserRecordingPatch, type BrowserRecordingMetadata,
} from '../browser-recordings.js';
import { NativeBrowserError } from '../native-browser-provider.js';
import {
  auditPluginAction, PluginAdminError, type AdminCallerScope, type PluginAdminErrorCode,
} from './admin-support.js';

import type {
  PluginBrowserRecording, PluginBrowserRecordingRef, PluginBrowserRecordingOp,
  PluginBrowserRecordingDetail,
} from './contract/browser-recordings.js';
export type {
  PluginBrowserRecording, PluginBrowserRecordingStep, PluginBrowserRecordingRef,
  PluginBrowserRecordingOp, PluginBrowserRecordingDetail,
} from './contract/browser-recordings.js';

export type ScopedBrowserRecordings = {
  list(filter?: { profileId?: string }): PluginBrowserRecording[];
  /** `undefined` when missing or not the caller's; `steps` is `null` once they were dropped. */
  get(id: string): PluginBrowserRecordingDetail | undefined;
  patch(id: string, ops: readonly PluginBrowserRecordingOp[]): PluginBrowserRecordingDetail;
  delete(id: string): boolean;
  /** Links the recording to an outside object (`null` unlinks); one recording per reference. */
  setRef(id: string, ref: PluginBrowserRecordingRef | null): PluginBrowserRecording;
  findByRef(provider: string, ref: string): PluginBrowserRecording | undefined;
};

export function browserRecordingView(meta: BrowserRecordingMetadata): PluginBrowserRecording {
  const { ownerUserId: _owner, ...view } = meta;
  return Object.freeze({ ...view });
}

const CODES: Record<number, PluginAdminErrorCode> = { 400: 'invalid', 404: 'not_found', 409: 'conflict', 410: 'conflict', 502: 'unavailable', 503: 'unavailable' };

function translate<T>(work: () => T): T {
  try { return work(); } catch (error) {
    if (error instanceof NativeBrowserError) throw new PluginAdminError(CODES[error.status] ?? 'invalid', error.message);
    throw error;
  }
}

export function browserRecordingsFor(scope: AdminCallerScope): ScopedBrowserRecordings {
  const userId = scope.job ? null : scope.userId;
  const mine = (meta: BrowserRecordingMetadata | undefined): meta is BrowserRecordingMetadata =>
    !!meta && !!userId && meta.ownerUserId === userId && getBrowserProfile(meta.profileId)?.owner_user_id === userId;
  const owned = (id: unknown): BrowserRecordingMetadata => {
    const meta = translate(() => getBrowserRecording(id));
    if (!mine(meta)) throw new PluginAdminError('not_found', `no browser recording: ${String(id)}`);
    return meta;
  };
  const origin = { kind: 'plugin' as const, id: scope.pluginId };
  return {
    list(filter) {
      if (!userId) return [];
      return translate(() => listBrowserRecordings({ ownerUserId: userId, profileId: filter?.profileId }))
        .filter((meta) => mine(meta)).map(browserRecordingView);
    },
    get(id) {
      const meta = translate(() => getBrowserRecording(id));
      if (!mine(meta)) return undefined;
      return { recording: browserRecordingView(meta), steps: translate(() => readBrowserRecordingSteps(meta)) };
    },
    patch(id, ops) {
      const meta = owned(id);
      const parsed = BrowserRecordingPatch.safeParse({ ops });
      if (!parsed.success) throw new PluginAdminError('invalid', parsed.error.issues[0]?.message ?? 'invalid operations');
      const result = translate(() => patchBrowserRecording(meta, parsed.data.ops, origin));
      auditPluginAction(scope, 'browser-recording.patch', `browser-recording:${meta.id}`);
      return { recording: browserRecordingView(result.recording), steps: result.steps };
    },
    delete(id) {
      const meta = owned(id);
      translate(() => deleteBrowserRecording(meta, origin));
      auditPluginAction(scope, 'browser-recording.delete', `browser-recording:${meta.id}`);
      return true;
    },
    setRef(id, ref) {
      const meta = owned(id);
      const next = translate(() => setBrowserRecordingExternalRef(meta, ref));
      auditPluginAction(scope, 'browser-recording.ref', `browser-recording:${meta.id}`);
      return browserRecordingView(next);
    },
    findByRef(provider, ref) {
      const meta = translate(() => findBrowserRecordingByRef(provider, ref));
      return mine(meta) ? browserRecordingView(meta) : undefined;
    },
  };
}
