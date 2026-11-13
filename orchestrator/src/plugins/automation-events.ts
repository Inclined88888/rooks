/**
 * The lifecycle of routines, triggers, pipelines and workflow runs, as the
 * daemon announces it to the plugins that follow it (`ctx.events.on`, see
 * `automation-event-hub.ts`).
 *
 * Whoever changes one of these says so here, with its ORIGIN: a route or an MCP
 * tool (the user or agent behind the request, `todo-origin.ts`), a plugin
 * facade (that plugin), the daemon itself. A connector that mirrors routines to
 * another system needs the origin to drop the echo of its own writes. Emitting
 * never throws and never blocks the write that caused it.
 */
import { EventEmitter } from 'node:events';
import type { Request } from 'express';
import type { RoutineRow, WorkflowRunRow } from '../db.js';
import type { Pipeline, PipelineRunResult } from '../pipelines.js';
import { todoOriginFromRequest } from '../todo-origin.js';
import type { TriggerRow } from '../triggers/store.js';
import type { AutomationOrigin } from './contract/automation.js';
export type { AutomationOrigin } from './contract/automation.js';

export type RawAutomationEvent = (
  | { kind: 'routine_created' | 'routine_updated' | 'routine_deleted'; row: RoutineRow }
  | { kind: 'trigger_created' | 'trigger_updated' | 'trigger_removed'; row: TriggerRow }
  | { kind: 'pipeline_created' | 'pipeline_updated' | 'pipeline_deleted'; pipeline: Pipeline }
  | { kind: 'pipeline_run_started'; pipeline: Pipeline; run: PipelineRunResult; ownerUserId: string | null }
  | { kind: 'workflow_run_started' | 'workflow_run_cancelled'; run: WorkflowRunRow }
) & { origin: AutomationOrigin };

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function emitAutomationEvent(event: RawAutomationEvent): void {
  try {
    emitter.emit('event', Object.freeze(event));
  } catch (err) {
    console.error(`[automation-events] ${event.kind} listener failed:`, (err as Error).message);
  }
}

export function onAutomationEvent(listener: (event: RawAutomationEvent) => void): () => void {
  emitter.on('event', listener);
  return () => { emitter.off('event', listener); };
}

/** The origin of an HTTP write, as the TO DO notebook reads it. */
export const automationOriginOf = (req: Request): AutomationOrigin => todoOriginFromRequest(req);
