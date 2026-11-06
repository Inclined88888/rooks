/**
 * The declared event `agent-import:applied@1`: one per agent an import created
 * or updated, so another plugin can keep a log or a sync without touching the
 * import (workflow trigger, business event). The payload names the agent and
 * where it came from, never the archive nor anything it held.
 */
import * as z from 'zod/mini';
import type { PluginContext } from '@timon-ai/sdk';
import { APPLIED_EVENT_NAME, APPLIED_EVENT_VERSION, type AgentImportApplied } from './contract.js';

const AppliedSchema = z.strictObject({
  sourceRef: z.string().check(z.minLength(1), z.maxLength(300)),
  agent: z.string().check(z.minLength(1), z.maxLength(100)),
  origin: z.string().check(z.regex(/^plugin:[a-z0-9][a-z0-9-]*$/)),
  sourceApp: z.string().check(z.minLength(1), z.maxLength(64)),
});

export function appliedEventId(pluginId: string): string {
  return `${pluginId}:${APPLIED_EVENT_NAME}@${APPLIED_EVENT_VERSION}`;
}

export function registerAppliedEvent(ctx: Pick<PluginContext, 'businessEvents'>): () => void {
  return ctx.businessEvents.register({
    name: APPLIED_EVENT_NAME,
    version: APPLIED_EVENT_VERSION,
    payloadSchema: { parse: (value: unknown): AgentImportApplied => AppliedSchema.parse(value) },
  });
}

/**
 * Published by the engine once an agent is written. `importId` + `sourceRef`
 * make the event id: a retried publication is deduplicated by the host.
 */
export function publishApplied(
  ctx: Pick<PluginContext, 'businessEvents' | 'id'>,
  importId: string,
  input: Omit<AgentImportApplied, 'origin'>,
): Promise<string[]> {
  const payload: AgentImportApplied = AppliedSchema.parse({ ...input, origin: `plugin:${ctx.id}` });
  return ctx.businessEvents.publish(appliedEventId(ctx.id), { id: `${importId}:${input.sourceRef}`, payload });
}
