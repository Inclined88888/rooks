/**
 * Automation lifecycle events as a third-party plugin receives them
 * (`ctx.events.on`): `routine_*`, `trigger_*`, `pipeline_*` and
 * `workflow_run_started` / `workflow_run_cancelled`.
 *
 * Built SYNCHRONOUSLY in the emitter's callback, i.e. inside the write that
 * caused it: the snapshot is the object as that write left it (the row as it
 * was, for a delete) and projected for THIS plugin — a trigger it does not own
 * comes without its action body, a pipeline without its prompts, `mine` says
 * whose it is. `origin` is the writer. The final status of a workflow run is
 * the existing `workflow_run` event.
 *
 * Audience, as for the TO DO events: an object owned by `plugin:<id>` comes to
 * that plugin's job; one owned by a user who may use the plugin comes inside
 * that user's identity; system rows and another plugin's never leave. Delivery
 * is deferred and serial per plugin.
 */
import type { PluginPermission } from './manifest.js';
import { runPluginRequest, type PluginRequestIdentity } from './als.js';
import { onAutomationEvent, type RawAutomationEvent } from './automation-events.js';
import { pipelineView } from './pipelines-facade.js';
import { routineView } from './routines-facade.js';
import { todoEventAudience } from './todo-events.js';
import { triggerView } from './triggers-facade.js';
import { workflowRunView } from './workflows-facade.js';

import type {
  PluginAutomationEventKind, PluginAutomationEvent, PluginAutomationEventHandler,
} from './contract/automation.js';
import type { Assert, Equals } from '../type-equality.js';
export type {
  PluginAutomationEventKind, PluginRoutineEvent, PluginTriggerEvent, PluginPipelineEvent,
  PluginPipelineRunStartedEvent, PluginWorkflowRunEvent, PluginAutomationEvent,
  PluginAutomationEventMap, PluginAutomationEventHandler,
} from './contract/automation.js';

export const PLUGIN_AUTOMATION_EVENT_KINDS = Object.freeze([
  'routine_created', 'routine_updated', 'routine_deleted',
  'trigger_created', 'trigger_updated', 'trigger_removed',
  'pipeline_created', 'pipeline_updated', 'pipeline_deleted', 'pipeline_run_started',
  'workflow_run_started', 'workflow_run_cancelled',
] as const);
/** `PluginAutomationEventKind` spells this list out in the public contract; compilation fails if they part. */
type _PluginAutomationEventKindsMatchContract = Assert<Equals<(typeof PLUGIN_AUTOMATION_EVENT_KINDS)[number], PluginAutomationEventKind>>;

export function isPluginAutomationEventKind(kind: unknown): kind is PluginAutomationEventKind {
  return typeof kind === 'string' && (PLUGIN_AUTOMATION_EVENT_KINDS as readonly string[]).includes(kind);
}

/** Receiving an event is reading what it carries: any of these permissions opens it. */
export function automationEventPermissions(kind: PluginAutomationEventKind): readonly PluginPermission[] {
  if (kind.startsWith('routine_')) return ['routines:read', 'routines:write'];
  if (kind.startsWith('trigger_')) return ['triggers:read', 'triggers:write', 'triggers:execute'];
  if (kind.startsWith('pipeline_')) return ['pipelines:read', 'pipelines:write', 'pipelines:run'];
  return ['workflows:read', 'workflows:run'];
}

/** The plugin's translation of an event, with the owner that decides who receives it. */
export function pluginAutomationEvent(raw: RawAutomationEvent, pluginId: string): { ev: PluginAutomationEvent; owner: string | null } | null {
  const { origin } = raw;
  switch (raw.kind) {
    case 'routine_created': case 'routine_updated': case 'routine_deleted':
      return {
        owner: raw.row.owner_user_id,
        ev: Object.freeze({ kind: raw.kind, routineId: raw.row.id, routine: Object.freeze(routineView(raw.row, pluginId)), origin }),
      };
    case 'trigger_created': case 'trigger_updated': case 'trigger_removed': {
      const trigger = triggerView(raw.row, pluginId);
      return trigger ? { owner: raw.row.owner_user_id, ev: Object.freeze({ kind: raw.kind, triggerId: raw.row.id, trigger: Object.freeze(trigger), origin }) } : null;
    }
    case 'pipeline_created': case 'pipeline_updated': case 'pipeline_deleted':
      return {
        owner: raw.pipeline.owner_user_id,
        ev: Object.freeze({ kind: raw.kind, pipelineId: raw.pipeline.id, pipeline: Object.freeze(pipelineView(raw.pipeline, pluginId)), origin }),
      };
    case 'pipeline_run_started':
      return {
        owner: raw.ownerUserId,
        ev: Object.freeze({
          kind: 'pipeline_run_started', runId: raw.run.run_id, pipelineId: raw.run.pipeline_id, origin,
          steps: Object.freeze(raw.run.steps.map((s) => Object.freeze({ stepId: s.step_id, taskId: s.task_id }))),
        }),
      };
    case 'workflow_run_started': case 'workflow_run_cancelled':
      return {
        owner: raw.run.owner_user_id,
        ev: Object.freeze({ kind: raw.kind, runId: raw.run.id, workflowId: raw.run.workflow_id, run: Object.freeze(workflowRunView(raw.run)), origin }),
      };
  }
}

type Delivery = { ev: PluginAutomationEvent; identity: PluginRequestIdentity | null };

class PluginAutomationEventHub {
  private readonly handlers = new Map<PluginAutomationEventKind, Set<PluginAutomationEventHandler>>();
  private readonly queue: Delivery[] = [];
  private draining = false;
  private off: (() => void) | null = null;

  constructor(private readonly pluginId: string, private readonly onEmpty: () => void) {}

  private readonly onRaw = (raw: RawAutomationEvent): void => {
    if (!this.handlers.get(raw.kind)?.size) return;
    let translated: ReturnType<typeof pluginAutomationEvent>;
    try { translated = pluginAutomationEvent(raw, this.pluginId); } catch (err) {
      console.error(`[plugin:${this.pluginId}] automation event translation failed:`, (err as Error).message);
      return;
    }
    if (!translated) return;
    const identity = todoEventAudience(this.pluginId, translated.owner);
    if (identity === undefined) return;
    this.queue.push({ ev: translated.ev, identity });
    if (!this.draining) { this.draining = true; setImmediate(() => { void this.drain(); }); }
  };

  subscribe(kind: PluginAutomationEventKind, handler: PluginAutomationEventHandler): () => void {
    let set = this.handlers.get(kind);
    if (!set) { set = new Set(); this.handlers.set(kind, set); }
    const entry: PluginAutomationEventHandler = (ev) => handler(ev);
    set.add(entry);
    if (!this.off) this.off = onAutomationEvent(this.onRaw);
    return () => {
      set.delete(entry);
      if ([...this.handlers.values()].some((s) => s.size)) return;
      this.off?.();
      this.off = null;
      this.onEmpty();
    };
  }

  private async drain(): Promise<void> {
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        const { ev, identity } = next;
        for (const handler of [...(this.handlers.get(ev.kind) ?? [])]) {
          const run = () => handler(ev);
          try {
            await (identity ? runPluginRequest(identity, run) : run());
          } catch (err) {
            console.error(`[plugin:${this.pluginId}] ${ev.kind} handler failed:`, (err as Error).message);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

const hubs = new Map<string, PluginAutomationEventHub>();

export function subscribePluginAutomationEvent(
  pluginId: string,
  kind: PluginAutomationEventKind,
  handler: PluginAutomationEventHandler,
): () => void {
  let hub = hubs.get(pluginId);
  if (!hub) {
    const created: PluginAutomationEventHub = new PluginAutomationEventHub(pluginId, () => { if (hubs.get(pluginId) === created) hubs.delete(pluginId); });
    hub = created;
    hubs.set(pluginId, hub);
  }
  return hub.subscribe(kind, handler);
}
