/**
 * `ctx.ui.documents` (API 9, ADR-MCPUI D8): the HTML documents a plugin shows
 * in a mission's conversation, as the CALLER sees them.
 *
 * Bounded like `ctx.missions`: in a request, the missions of that account; in
 * a job, the missions owned by `plugin:<id>`. A document on a mission outside
 * that view answers as one that does not exist. The origin of what a plugin
 * creates is `{ kind: 'plugin', id }`, set here from the plugin's identity,
 * never from the arguments. Every document leaves through
 * `projectUiDocument`: the reply is there only on this plugin's own documents.
 */
import { randomUUID } from 'node:crypto';
import { dbApi, type DbViewer, type UiDocumentRow, type UiDocumentStatus } from '../db.js';
import { moduleActive } from '../kernel/module-state.js';
import {
  createUiDocument, PluginCreateInput, projectUiDocument,
} from '../plugins-bundled/ui-documents/model.js';
import { resolveUiDocument } from '../plugins-bundled/ui-documents/requests.js';
import { scopedDb } from '../users/scoped-db.js';

import type {
  PluginUiDocument, PluginOwnUiDocument, PluginUiDocumentInput, PluginUiDocumentErrorCode,
} from './contract/ui-documents.js';
export type {
  PluginUiDocument, PluginOwnUiDocument, PluginUiDocumentInput, PluginUiDocumentErrorCode,
} from './contract/ui-documents.js';

export class PluginUiDocumentError extends Error {
  constructor(readonly code: PluginUiDocumentErrorCode, message: string = code) {
    super(message);
    this.name = 'PluginUiDocumentError';
  }
}

export type ScopedUiDocuments = {
  create(input: PluginUiDocumentInput): PluginOwnUiDocument;
  get(id: string): PluginUiDocument | PluginOwnUiDocument | undefined;
  list(filter?: { missionId?: string; status?: UiDocumentStatus; limit?: number }): Array<PluginUiDocument | PluginOwnUiDocument>;
  findByRef(provider: string, ref: string): PluginOwnUiDocument | undefined;
  dismiss(id: string): PluginOwnUiDocument | undefined;
};

export type UiDocumentCallerScope = { pluginId: string; viewer: DbViewer | null };

export function uiDocumentsFor(scope: UiDocumentCallerScope): ScopedUiDocuments {
  const { pluginId, viewer } = scope;
  const reader = { kind: 'plugin', id: pluginId } as const;
  const active = (): void => {
    if (!moduleActive('@timon/ui-documents')) throw new PluginUiDocumentError('module_disabled', 'module @timon/ui-documents is disabled');
  };
  const visible = (row: UiDocumentRow | undefined): UiDocumentRow | undefined =>
    row && scopedDb(viewer).getMission(row.mission_id) ? row : undefined;
  const own = (row: UiDocumentRow): PluginOwnUiDocument => projectUiDocument(row, reader) as PluginOwnUiDocument;
  const mine = (row: UiDocumentRow): boolean => row.origin_kind === 'plugin' && row.origin_id === pluginId;

  return {
    create(input) {
      active();
      const parsed = PluginCreateInput.safeParse(input);
      if (!parsed.success) throw new PluginUiDocumentError('invalid', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const mission = scopedDb(viewer).getMission(parsed.data.missionId);
      if (!mission) throw new PluginUiDocumentError('not_found', 'mission not found');
      const out = createUiDocument({
        id: randomUUID(),
        mission,
        origin: { kind: 'plugin', id: pluginId },
        title: parsed.data.title,
        html: parsed.data.html,
        bridge: parsed.data.bridge,
        height: parsed.data.height ?? null,
        expectsReply: parsed.data.expectsReply === true,
        ref: parsed.data.ref ?? null,
      });
      if (!out.ok) throw new PluginUiDocumentError(out.error);
      return own(out.row);
    },
    get(id) {
      active();
      if (typeof id !== 'string') return undefined;
      const row = visible(dbApi.getUiDocument(id.toLowerCase()));
      return row ? projectUiDocument(row, reader) : undefined;
    },
    list(filter = {}) {
      active();
      const limit = Math.max(1, Math.min(500, Math.floor(filter.limit ?? 100)));
      if (filter.missionId !== undefined) {
        if (typeof filter.missionId !== 'string' || !scopedDb(viewer).getMission(filter.missionId)) return [];
        return dbApi.listUiDocuments({ missionId: filter.missionId, status: filter.status, limit })
          .map((row) => projectUiDocument(row, reader));
      }
      // Without a mission: the documents of the caller's own missions, never wider than its view.
      const ownerUserId = viewer && !viewer.isSuperadmin ? viewer.id : undefined;
      return dbApi.listUiDocuments({ ownerUserId, status: filter.status, limit })
        .filter((row) => visible(row))
        .map((row) => projectUiDocument(row, reader));
    },
    findByRef(provider, ref) {
      active();
      if (typeof provider !== 'string' || typeof ref !== 'string') return undefined;
      const row = visible(dbApi.findUiDocumentByRef(pluginId, provider, ref));
      return row ? own(row) : undefined;
    },
    dismiss(id) {
      active();
      if (typeof id !== 'string') return undefined;
      const row = visible(dbApi.getUiDocument(id.toLowerCase()));
      if (!row || !mine(row)) return undefined;
      // Through the resolver: an agent waiting on this document (none for a plugin's own today) is released too.
      const settled = resolveUiDocument(row.id, { status: 'dismissed' }, { kind: 'plugin', id: pluginId });
      return own(settled.ok ? settled.row : dbApi.getUiDocument(row.id)!);
    },
  };
}
