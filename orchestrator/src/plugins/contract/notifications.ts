/** Public plugin types, extracted from the host implementations (TODO #512). */

// Moved from `db.ts`, which re-exports it (TODO #512, volet 3).
export type NotificationType = 'action_required' | 'alert' | 'report';

export type PluginNotification = Readonly<{
  id: string;
  type: NotificationType;
  urgent: boolean;
  title: string;
  body: string | null;
  taskId: string | null;
  missionId: string | null;
  /** What the notification points at (a question's id, for `action_required`). */
  anchor: string | null;
  /** `plugin:<id>` when a plugin raised it; `null` for the daemon itself. */
  source: string | null;
  /** The agent behind it, read from its mission or task. */
  agent: string | null;
  createdAt: number;
  readAt: number | null;
  dismissedAt: number | null;
}>;

export type PluginNotificationListFilter = {
  type?: NotificationType;
  /** `true` (default): not dismissed. `false`: dismissed ones only. */
  active?: boolean;
  limit?: number;
};

export type PluginNotificationErrorCode = 'invalid' | 'module_disabled';
