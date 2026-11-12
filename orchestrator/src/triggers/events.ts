/**
 * The `event` source: internal bus events turned into trigger payloads.
 *
 * The bus carries ids, not content (`task_done` is `{ taskId }`), so each
 * event is enriched from the database before filters and templates see it —
 * `{task.title}` must render something.
 *
 * Two guards no test of a single trigger would notice:
 *  - ownership: a trigger fires on its owner's tasks, missions, messages and
 *    notifications only — otherwise it would leak another account's titles.
 *    A superadmin's trigger (grants `*`) sees everything;
 *  - feedback loops: an event caused by what an EVENT trigger created (its
 *    task finishing, its notification) fires no trigger at all. Ignoring only
 *    the trigger's own output is not enough: two `task_done → task` triggers
 *    would feed each other forever, one agent mission per link, and a rate
 *    limit per minute does not slow missions that last minutes. A webhook or
 *    schedule may still chain into an event trigger: depth 2 at most.
 *    A workflow started by a trigger counts as that trigger's output: its
 *    missions carry no task, so the origin is asked of the module that ran it
 *    (`triggerOriginOfMission`).
 */
import type { BusEvent } from '../bus.js';
import { dbApi } from '../db.js';
import { triggerOriginOfMission } from './actions.js';
import { fireTrigger } from './engine.js';
import { rateLimiter } from './limiter.js';
import { DEFAULT_RATE_LIMIT, type EventKind } from './schema.js';
import { getTriggerRow, listEnabledTriggers, recordDelivery, type Trigger } from './store.js';
import { isMirrorTask } from '../task-mirror.js';

export type TriggerEvent = {
  kind: EventKind;
  body: Record<string, unknown>;
  ownerUserId: string | null;
  /** Trigger whose own creation caused this event, if any. */
  originTriggerId: string | null;
};

const TEXT_MAX = 4000;
const cap = (text: string | null | undefined): string | null =>
  text == null ? null : text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}…` : text;

function taskOrigin(taskId: string | null | undefined): string | null {
  return taskId ? dbApi.getTask(taskId)?.trigger_id ?? null : null;
}

function missionOrigin(mission: { id: string; task_id: string | null } | undefined): string | null {
  return mission ? taskOrigin(mission.task_id) ?? triggerOriginOfMission(mission.id) : null;
}

export function eventFromBus(ev: BusEvent): TriggerEvent | null {
  switch (ev.kind) {
    case 'task_done':
    case 'task_blocked': {
      const task = dbApi.getTask(ev.taskId);
      // Inert by definition: a user's trigger (which may spawn an agent) never
      // reacts to the image of an external ticket.
      if (!task || isMirrorTask(task)) return null;
      return {
        kind: ev.kind,
        ownerUserId: task.owner_user_id,
        originTriggerId: task.trigger_id ?? triggerOriginOfMission(task.mission_id),
        body: {
          event: ev.kind,
          task: {
            id: task.id, title: task.title, agent: task.agent_name, status: task.status, type: task.type,
            project: task.project, priority: task.priority, mission_id: task.mission_id,
            reason: ev.kind === 'task_blocked' ? cap(ev.reason ?? task.blocked_reason) : null,
            comment: cap(task.done_comment), summary: cap(task.done_summary), merged_sha: task.merged_commit_sha,
          },
        },
      };
    }
    case 'mission_complete': {
      const mission = dbApi.getMission(ev.missionId);
      if (!mission) return null;
      return {
        kind: 'mission_complete',
        ownerUserId: mission.owner_user_id,
        originTriggerId: missionOrigin(mission),
        body: {
          event: 'mission_complete',
          mission: {
            id: mission.id, agent: mission.agent_name, status: ev.status, exit_code: ev.exitCode,
            reason: ev.reason ?? null, task_id: mission.task_id,
          },
        },
      };
    }
    case 'agent_message': {
      const message = dbApi.getMessage(ev.messageId);
      if (!message) return null;
      const mission = dbApi.getMission(message.from_mission);
      return {
        kind: 'agent_message',
        ownerUserId: message.owner_user_id,
        originTriggerId: missionOrigin(mission),
        body: {
          event: 'agent_message',
          message: {
            id: message.id, from_agent: message.from_agent, to_agent: message.to_agent,
            from_mission: message.from_mission, kind: message.kind, text: cap(message.payload),
          },
        },
      };
    }
    case 'notifications_changed': {
      if (!ev.notificationId) return null;
      const notification = dbApi.getNotification(ev.notificationId);
      if (!notification) return null;
      const source = notification.source ?? '';
      return {
        kind: 'notification',
        ownerUserId: notification.owner_user_id,
        originTriggerId: source.startsWith('trigger:')
          ? source.slice('trigger:'.length)
          : taskOrigin(notification.task_id) ?? triggerOriginOfMission(notification.mission_id),
        body: {
          event: 'notification',
          notification: {
            id: notification.id, type: notification.type, urgent: notification.urgent === 1,
            title: notification.title, body: cap(notification.body), task_id: notification.task_id,
            mission_id: notification.mission_id, source: notification.source,
          },
        },
      };
    }
    case 'todo_done': {
      const todo = dbApi.getProjectTodo(ev.todoId);
      if (!todo) return null;
      // Only what names the idea: its notes stay in the notebook, since a
      // trigger may forward this body outside (a `webhook` action).
      return {
        kind: 'todo_done',
        ownerUserId: todo.owner_user_id,
        originTriggerId: null,
        body: {
          event: 'todo_done',
          todo: {
            id: todo.id, text: todo.text, project: todo.project, progress: todo.progress,
            previous_progress: ev.previousProgress ?? 'todo', urgency: todo.urgency, done_at: todo.done_at,
          },
        },
      };
    }
    case 'todo_resolved': {
      // Built from the snapshot taken at the write, never from a re-read: the
      // dispatcher runs deferred, and a second outcome given in between would
      // otherwise go out twice. The snapshot holds no private `notes`.
      const { todo } = ev;
      return {
        kind: 'todo_resolved',
        ownerUserId: todo.owner_user_id,
        originTriggerId: null,
        body: {
          event: 'todo_resolved',
          todo: {
            id: todo.id, text: todo.text, project: todo.project, resolution: todo.resolution,
            public_note: todo.public_note, duplicate_of: todo.duplicate_of,
          },
        },
      };
    }
    default:
      return null;
  }
}

function sees(trigger: Trigger, ownerUserId: string | null): boolean {
  if (trigger.grants === null || trigger.grants.includes('*')) return true;
  return ownerUserId !== null && ownerUserId === trigger.ownerUserId;
}

export type EventDispatcher = (ev: BusEvent) => void;

export function createEventDispatcher(allow = rateLimiter()): EventDispatcher {
  return (ev) => {
    let event: TriggerEvent | null;
    try { event = eventFromBus(ev); } catch (err) {
      console.error('[triggers] event enrichment failed:', (err as Error).message);
      return;
    }
    if (!event) return;
    if (event.originTriggerId && getTriggerRow(event.originTriggerId)?.source === 'event') return;
    for (const trigger of listEnabledTriggers('event')) {
      // Its own output, whatever its source (a webhook trigger's task too).
      if (event.originTriggerId === trigger.id) continue;
      if (trigger.source !== 'event' || trigger.config.event !== event.kind) continue;
      if (!sees(trigger, event.ownerUserId)) continue;
      if (!allow([{ key: `trigger:${trigger.id}`, max: trigger.config.rate_limit ?? DEFAULT_RATE_LIMIT }])) {
        recordDelivery({ triggerId: trigger.id, status: 'error', reason: 'rate limited' });
        continue;
      }
      try {
        fireTrigger(trigger, { body: event.body, headers: {} });
      } catch (err) {
        recordDelivery({ triggerId: trigger.id, status: 'error', reason: (err as Error).message });
      }
    }
  };
}
