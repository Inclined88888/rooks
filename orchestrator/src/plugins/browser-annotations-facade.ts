/**
 * `ctx.browserAnnotations` (TODO #468): the annotations of the built-in browser, for a plugin that
 * extends them (mirror them as issues, close them when the issue closes) without the core.
 *
 * Bounded like the routes: an annotation is its owner's, and a plugin reaches it only inside that
 * owner's request (`browser:annotations:read`, `browser:annotations:write`, both sensitive). A job
 * has nobody behind it and reads nothing; another account's annotation answers like a missing one,
 * superadmin included. Sending a batch to an agent stays the user's act: no plugin call does it.
 * Writes carry `origin: { kind: 'plugin', id }` on their events.
 */
import { getBrowserProfile } from '../browser-profiles.js';
import {
  deleteBrowserAnnotation, findBrowserAnnotationByRef, getBrowserAnnotation, listBrowserAnnotations,
  ownerAnnotationView, resolveBrowserAnnotation, setBrowserAnnotationExternalRef,
  type BrowserAnnotationMetadata,
} from '../browser-annotations.js';
import { NativeBrowserError } from '../native-browser-provider.js';
import {
  auditPluginAction, PluginAdminError, type AdminCallerScope, type PluginAdminErrorCode,
} from './admin-support.js';

import type {
  PluginBrowserAnnotation, PluginBrowserAnnotationRef, PluginBrowserAnnotationDetail,
  PluginBrowserAnnotationResolution, PluginBrowserAnnotationFilter,
} from './contract/browser-annotations.js';
export type {
  PluginBrowserAnnotation, PluginBrowserAnnotationRef, PluginBrowserAnnotationDetail,
  PluginBrowserAnnotationResolution, PluginBrowserAnnotationFilter,
} from './contract/browser-annotations.js';

export type ScopedBrowserAnnotations = {
  list(filter?: PluginBrowserAnnotationFilter): PluginBrowserAnnotation[];
  /** `undefined` when missing or not the caller's. */
  get(id: string): PluginBrowserAnnotationDetail | undefined;
  resolve(id: string, resolution: PluginBrowserAnnotationResolution): PluginBrowserAnnotation;
  delete(id: string): boolean;
  /** Links the annotation to an outside object (`null` unlinks); one annotation per reference. */
  setRef(id: string, ref: PluginBrowserAnnotationRef | null): PluginBrowserAnnotation;
  findByRef(provider: string, ref: string): PluginBrowserAnnotation | undefined;
};

export function browserAnnotationView(meta: BrowserAnnotationMetadata): PluginBrowserAnnotation {
  const { ownerUserId: _owner, thumbnailBytes: _bytes, ...view } = meta;
  return Object.freeze({ ...view });
}

const CODES: Record<number, PluginAdminErrorCode> = { 400: 'invalid', 404: 'not_found', 409: 'conflict', 502: 'unavailable', 503: 'unavailable' };
const STATUSES: readonly string[] = ['draft', 'pending', 'resolved', 'dismissed'];

function translate<T>(work: () => T): T {
  try { return work(); } catch (error) {
    if (error instanceof NativeBrowserError) throw new PluginAdminError(CODES[error.status] ?? 'invalid', error.message);
    throw error;
  }
}

function resolutionOf(raw: unknown): { status: 'resolved' | 'dismissed'; note: string } {
  const value = raw as Partial<{ status: unknown; summary: unknown; reason: unknown }> | null;
  const note = value?.status === 'resolved' ? value.summary : value?.status === 'dismissed' ? value.reason : undefined;
  if (typeof note !== 'string' || !note.trim()) {
    throw new PluginAdminError('invalid', 'a resolution is { status: "resolved", summary } or { status: "dismissed", reason }, with a text');
  }
  return { status: value!.status as 'resolved' | 'dismissed', note };
}

export function browserAnnotationsFor(scope: AdminCallerScope): ScopedBrowserAnnotations {
  const userId = scope.job ? null : scope.userId;
  const mine = (meta: BrowserAnnotationMetadata | undefined): meta is BrowserAnnotationMetadata =>
    !!meta && !!userId && meta.ownerUserId === userId && getBrowserProfile(meta.profileId)?.owner_user_id === userId;
  const owned = (id: unknown): BrowserAnnotationMetadata => {
    const meta = translate(() => getBrowserAnnotation(id));
    if (!mine(meta)) throw new PluginAdminError('not_found', `no browser annotation: ${String(id)}`);
    return meta;
  };
  const origin = { kind: 'plugin' as const, id: scope.pluginId };
  return {
    list(filter) {
      if (!userId) return [];
      if (filter?.status !== undefined && !STATUSES.includes(filter.status)) throw new PluginAdminError('invalid', `unknown status: ${String(filter.status)}`);
      return translate(() => listBrowserAnnotations({ ownerUserId: userId, profileId: filter?.profileId, status: filter?.status, batchId: filter?.batchId }))
        .filter((meta) => mine(meta)).map(browserAnnotationView);
    },
    get(id) {
      const meta = translate(() => getBrowserAnnotation(id));
      if (!mine(meta)) return undefined;
      const view = translate(() => ownerAnnotationView(meta));
      return { ...view, annotation: browserAnnotationView(meta) };
    },
    resolve(id, resolution) {
      const meta = owned(id);
      const next = translate(() => resolveBrowserAnnotation(meta, resolutionOf(resolution), origin));
      auditPluginAction(scope, 'browser-annotation.resolve', `browser-annotation:${meta.id}`);
      return browserAnnotationView(next);
    },
    delete(id) {
      const meta = owned(id);
      translate(() => deleteBrowserAnnotation(meta, origin));
      auditPluginAction(scope, 'browser-annotation.delete', `browser-annotation:${meta.id}`);
      return true;
    },
    setRef(id, ref) {
      const meta = owned(id);
      const next = translate(() => setBrowserAnnotationExternalRef(meta, ref, origin));
      auditPluginAction(scope, 'browser-annotation.ref', `browser-annotation:${meta.id}`);
      return browserAnnotationView(next);
    },
    findByRef(provider, ref) {
      const meta = translate(() => findBrowserAnnotationByRef(provider, ref));
      return mine(meta) ? browserAnnotationView(meta) : undefined;
    },
  };
}
