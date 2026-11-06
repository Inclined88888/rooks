/**
 * `ctx.notifications` (API 10): the notification centre as the CALLER sees it —
 * list what is waiting, close what is handled. `ctx.notify` stays the way to
 * RAISE one.
 *
 * Bounded by the owner column, through `scopedDb(viewer)` (SECU-USERS U-1,
 * `notifications:read:all` widens it for an account that holds it): in a
 * request, that account's notifications; in a job, the ones owned by
 * `plugin:<id>`. A notification outside that view answers as one that does not
 * exist. Dismissing goes through the function the route calls, so the system
 * notification on the devices closes too.
 */
import { dbApi, type DbViewer, type NotificationRow, type NotificationType } from '../db.js';
import { dismissNotificationRow, notificationsEnabled } from '../notifications.js';
import { scopedDb } from '../users/scoped-db.js';

import type {
  PluginNotification, PluginNotificationListFilter, PluginNotificationErrorCode,
} from './contract/notifications.js';
export type {
  PluginNotification, PluginNotificationListFilter, PluginNotificationErrorCode,
} from './contract/notifications.js';

const TYPES: readonly NotificationType[] = ['action_required', 'alert', 'report'];

export class PluginNotificationError extends Error {
  constructor(readonly code: PluginNotificationErrorCode, message: string = code) {
    super(message);
    this.name = 'PluginNotificationError';
  }
}

export type ScopedNotifications = {
  list(filter?: PluginNotificationListFilter): PluginNotification[];
  /** `true` when a notification of the caller's view was open and is now closed. */
  dismiss(id: string): boolean;
};

export type NotificationCallerScope = { pluginId: string; viewer: DbViewer | null };

function project(row: NotificationRow, agents: Map<string, string>): PluginNotification {
  return Object.freeze({
    id: row.id, type: row.type, urgent: row.urgent === 1, title: row.title, body: row.body,
    taskId: row.task_id, missionId: row.mission_id, anchor: row.anchor, source: row.source,
    agent: agents.get(row.id) ?? null,
    createdAt: row.created_at, readAt: row.read_at, dismissedAt: row.dismissed_at,
  });
}

export function notificationsFor(scope: NotificationCallerScope): ScopedNotifications {
  const { viewer } = scope;
  const active = (): void => {
    if (!notificationsEnabled()) throw new PluginNotificationError('module_disabled', 'module @timon/notifications is disabled');
  };
  return {
    list(filter = {}) {
      active();
      if (filter.type !== undefined && !TYPES.includes(filter.type)) {
        throw new PluginNotificationError('invalid', `\`type\` accepts ${TYPES.join(', ')}`);
      }
      if (filter.active !== undefined && typeof filter.active !== 'boolean') throw new PluginNotificationError('invalid', '`active` must be a boolean');
      const limit = Math.max(1, Math.min(200, Math.floor(filter.limit ?? 50)));
      const wantActive = filter.active !== false;
      // Filters apply after the read, so it takes the widest page first; the archive query also returns live rows.
      const rows = scopedDb(viewer).listNotifications({ archived: !wantActive, limit: 200 })
        .filter((row) => (filter.type === undefined || row.type === filter.type) && (wantActive || row.dismissed_at !== null))
        .slice(0, limit);
      const agents = dbApi.notificationAgents(rows);
      return rows.map((row) => project(row, agents));
    },
    dismiss(id) {
      active();
      if (typeof id !== 'string') return false;
      const row = scopedDb(viewer).getNotification(id);
      return row ? dismissNotificationRow(row) : false;
    },
  };
}
