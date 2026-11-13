/**
 * Bridge between ROOKS's historical bus and the Cordis events.
 *
 * The `bus` EventEmitter stays the source: all the existing code publishes and
 * listens on it, and rewriting it would bring nothing. The bridge re-emits each
 * `BusEvent` on the context under the name `rooks/<kind>`, which gives
 * modules automatic unsubscription (`ctx.on` is an effect) without forcing
 * a migration: both worlds coexist for as long as needed.
 *
 * One-way, on purpose. A Cordis → bus bridge would loop every
 * event onto itself at the first republication.
 *
 * Each listener is isolated (TODO #630). Cordis' `ctx.emit` calls them in a
 * row with no `try`: one module's `throw` skipped the listeners after it, then
 * left `ctx.emit`, the bus `emit` and finally the `bus.publish` of a core write
 * that has nothing to do with that module. The plugin facade already guards
 * `ctx.events.on` this way (#614); the bridge does the same for the raw
 * `ctx.on('rooks/…')` of bundled modules.
 */
import type { Context } from '@deepseek-ai/cordis';
import { bus, type BusEvent } from '../bus.js';
import { guardCallback, type RejectionOwner } from './rejection-guard.js';

/** Cordis event name matching a `BusEvent`. */
export type RooksEventName = `rooks/${BusEvent['kind']}`;

declare module '@deepseek-ai/cordis' {
  interface Events {
    'rooks/plugin_realtime'(ev: Extract<BusEvent, { kind: 'plugin_realtime' }>): void;
    'rooks/ui_navigate'(ev: Extract<BusEvent, { kind: 'ui_navigate' }>): void;
    'rooks/event'(ev: Extract<BusEvent, { kind: 'event' }>): void;
    'rooks/event_delta'(ev: Extract<BusEvent, { kind: 'event_delta' }>): void;
    'rooks/mission_complete'(ev: Extract<BusEvent, { kind: 'mission_complete' }>): void;
    'rooks/turn_complete'(ev: Extract<BusEvent, { kind: 'turn_complete' }>): void;
    'rooks/turn_started'(ev: Extract<BusEvent, { kind: 'turn_started' }>): void;
    'rooks/onboarding_step'(ev: Extract<BusEvent, { kind: 'onboarding_step' }>): void;
    'rooks/compact_progress'(ev: Extract<BusEvent, { kind: 'compact_progress' }>): void;
    'rooks/mission_started'(ev: Extract<BusEvent, { kind: 'mission_started' }>): void;
    'rooks/mission_child_started'(ev: Extract<BusEvent, { kind: 'mission_child_started' }>): void;
    'rooks/mission_title_changed'(ev: Extract<BusEvent, { kind: 'mission_title_changed' }>): void;
    'rooks/task_blocked'(ev: Extract<BusEvent, { kind: 'task_blocked' }>): void;
    'rooks/task_done'(ev: Extract<BusEvent, { kind: 'task_done' }>): void;
    'rooks/task_started'(ev: Extract<BusEvent, { kind: 'task_started' }>): void;
    'rooks/task_unblocked'(ev: Extract<BusEvent, { kind: 'task_unblocked' }>): void;
    'rooks/task_created'(ev: Extract<BusEvent, { kind: 'task_created' }>): void;
    'rooks/task_updated'(ev: Extract<BusEvent, { kind: 'task_updated' }>): void;
    'rooks/task_assigned'(ev: Extract<BusEvent, { kind: 'task_assigned' }>): void;
    'rooks/task_deleted'(ev: Extract<BusEvent, { kind: 'task_deleted' }>): void;
    'rooks/todo_done'(ev: Extract<BusEvent, { kind: 'todo_done' }>): void;
    'rooks/todo_resolved'(ev: Extract<BusEvent, { kind: 'todo_resolved' }>): void;
    'rooks/todo_deleted'(ev: Extract<BusEvent, { kind: 'todo_deleted' }>): void;
    'rooks/project_created'(ev: Extract<BusEvent, { kind: 'project_created' }>): void;
    'rooks/project_updated'(ev: Extract<BusEvent, { kind: 'project_updated' }>): void;
    'rooks/agent_created'(ev: Extract<BusEvent, { kind: 'agent_created' }>): void;
    'rooks/agent_updated'(ev: Extract<BusEvent, { kind: 'agent_updated' }>): void;
    'rooks/agent_deleted'(ev: Extract<BusEvent, { kind: 'agent_deleted' }>): void;
    'rooks/agent_message'(ev: Extract<BusEvent, { kind: 'agent_message' }>): void;
    'rooks/workflow_run'(ev: Extract<BusEvent, { kind: 'workflow_run' }>): void;
    'rooks/workflow_proposal'(ev: Extract<BusEvent, { kind: 'workflow_proposal' }>): void;
    'rooks/notifications_changed'(ev: Extract<BusEvent, { kind: 'notifications_changed' }>): void;
    'rooks/plugins_changed'(ev: Extract<BusEvent, { kind: 'plugins_changed' }>): void;
    'rooks/browser_recording'(ev: Extract<BusEvent, { kind: 'browser_recording' }>): void;
    'rooks/browser_annotation'(ev: Extract<BusEvent, { kind: 'browser_annotation' }>): void;
    'rooks/backends_changed'(ev: Extract<BusEvent, { kind: 'backends_changed' }>): void;
    'rooks/license_changed'(ev: Extract<BusEvent, { kind: 'license_changed' }>): void;
    'rooks/update_available'(ev: Extract<BusEvent, { kind: 'update_available' }>): void;
  }
}

export const name = 'rooks-bus-bridge';

/** The fiber that registered the listener: a bundled module's is named by its manifest. */
function listenerOwner(owner: Context): RejectionOwner {
  const name = owner.fiber.name;
  return name === 'root' ? { kind: 'core' } : { kind: 'module', id: name };
}

/**
 * `ctx.emit`, minus the propagation. Same listeners, same order, same `this`
 * (`null`, no filter: the bridge passes no `thisArg`), and the same
 * `internal/dispatch` notice first. The list is copied before the loop, as
 * Cordis does, so a listener that unsubscribes does not shift the next one.
 */
function emitIsolated(ctx: Context, name: RooksEventName, ev: BusEvent): void {
  const hooks = [...(ctx.events._hooks[name] ?? [])];
  guardCallback({ kind: 'core' }, `event ${name} dispatch notice`, () => ctx.emit('internal/dispatch', 'emit', name, [ev], null))();
  for (const hook of hooks) {
    guardCallback(listenerOwner(hook.ctx), `event ${name}`, (payload: BusEvent) => hook.callback.call(null, payload))(ev);
  }
}

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const forward = (ev: BusEvent) => {
      emitIsolated(ctx, `rooks/${ev.kind}` as RooksEventName, ev);
    };
    bus.on('event', forward);
    return () => void bus.off('event', forward);
  });
}
