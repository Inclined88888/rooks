import { z } from 'zod';
import { integrationRegistries } from '../../plugins/integration-host.js';
import { parseIntegrationId, parseIntegrationValue } from '../../plugins/integration-primitives.js';
import { CronExpressionParser } from 'cron-parser';
import { EVENT_KINDS, SLUG_RE } from '../../triggers/schema.js';
import { AUTH_SCHEMES } from '../../triggers/signature.js';
import { httpNodeConfigSchema } from './http.js';

export type NodeSpec = { type: string; ports: { in?: string[]; out: string[] }; configSchema: z.ZodType };
const empty = z.object({}).passthrough();
export const nodeRegistry: Record<string, NodeSpec> = Object.fromEntries([
  ['trigger.manual', ['out']], ['trigger.schedule', ['out']], ['trigger.webhook', ['out']], ['trigger.event', ['out']], ['trigger.business', ['out']],
  ['agent', ['done', 'failed']], ['skill', ['done', 'failed']], ['condition', ['true', 'false']],
  ['switch', ['default']], ['script', ['done', 'failed']], ['http', ['done', 'failed']], ['parallel', ['out']],
  ['join', ['out']], ['human', ['approved', 'rejected', 'timeout']], ['notify', ['out']],
  ['memory.read', ['out']], ['memory.write', ['out']], ['wait', ['out']], ['output', []],
].map(([type, out]) => [type, { type, ports: { in: ['in'], out }, configSchema: empty }]));

nodeRegistry.condition!.configSchema = z.object({ expr: z.string() });
nodeRegistry.switch!.configSchema = z.object({ on: z.string(), cases: z.array(z.object({ port: z.string(), value: z.unknown() })).default([]) });
nodeRegistry.join!.configSchema = z.object({ mode: z.enum(['all', 'any', 'n']).default('all'), n: z.number().int().positive().optional() });
nodeRegistry.wait!.configSchema = z.object({ ms: z.number().int().nonnegative() });
nodeRegistry.notify!.configSchema = z.object({ type: z.enum(['report', 'alert']).default('report'), title: z.string(), body: z.string().default('') });
nodeRegistry.output!.configSchema = z.object({ template: z.string() });
const agentConfig = z.object({ ref: z.string().optional(), identity: z.object({ name:z.string().optional(), instructions:z.string().optional(), backend:z.string().optional(), model:z.string().optional(), reasoningEffort:z.string().nullable().optional(), skills:z.array(z.string()).optional(), mcpServers:z.array(z.string()).optional(), allowedTools:z.array(z.string()).optional(), permissionMode:z.string().optional(), browserProfileId:z.string().min(1).nullable().optional(), cwd:z.string().optional(), project:z.string().optional() }).optional(), input:z.string().default(''), completion:z.enum(['turn','explicit']).default('turn'), timeoutMs:z.number().int().positive().optional(), retries:z.number().int().nonnegative().default(0), routes:z.array(z.string().min(1)).default([]), backend:z.string().optional(), model:z.string().optional(), reasoningEffort:z.string().nullable().optional(), skills:z.array(z.string()).optional(), mcpServers:z.array(z.string()).optional(), allowedTools:z.array(z.string()).optional(), permissionMode:z.string().optional(), browserProfileId:z.string().min(1).nullable().optional(), outputSchema:z.never().optional() }).refine(v => !!v.ref || !!v.identity, 'ref or identity required');
nodeRegistry.agent!.configSchema = agentConfig;
nodeRegistry.skill!.configSchema = agentConfig.extend({ skillId: z.string() });
// Façade nodes (native-facade.ts): the same values the native triggers accept,
// refused at publish with the node named rather than at the first tick.
nodeRegistry['trigger.schedule']!.configSchema = z.object({ cron: z.string().min(1).max(200), tz: z.string().min(1).max(100).optional() }).superRefine((config, ctx) => {
  try { CronExpressionParser.parse(config.cron, { tz: config.tz }); } catch (err) { ctx.addIssue({ code: 'custom', message: `invalid cron: ${(err as Error).message}` }); }
});
nodeRegistry['trigger.webhook']!.configSchema = z.object({ slug: z.string().regex(SLUG_RE, 'lower-case letters, digits and dashes').optional(), auth: z.enum(AUTH_SCHEMES).optional() });
// `notifications_changed` is the legacy name of `notification`, still read from versions published before.
nodeRegistry['trigger.event']!.configSchema = z.object({ kind: z.enum([...EVENT_KINDS, 'notifications_changed']), filter: z.string().optional() });
nodeRegistry['trigger.business']!.configSchema = z.object({
  event: z.string().refine((id) => integrationRegistries.events.get(id) !== undefined, 'business event is not registered'),
  connectionId: z.string().min(1).max(256).optional(), filter: z.string().optional(),
});
nodeRegistry.script!.configSchema = z.object({ bin: z.string().min(1), args: z.array(z.string()).default([]), cwd: z.string().optional(), timeoutMs: z.number().int().positive().default(30_000), env: z.array(z.string()).default([]) });
nodeRegistry.http!.configSchema = httpNodeConfigSchema;
nodeRegistry.human!.configSchema = z.object({ question: z.string().min(1), options: z.array(z.string().min(1)).default([]), timeoutMs: z.number().int().positive().optional() });
nodeRegistry['memory.read']!.configSchema = z.object({ scope: z.enum(['agent', 'project', 'role', 'global']).optional(), query: z.string().default(''), agent: z.string().optional(), project: z.string().optional(), role: z.string().optional() });
nodeRegistry['memory.write']!.configSchema = z.object({ text: z.string().min(1), kind: z.enum(['decision', 'pitfall', 'preference']).default('pitfall'), scope: z.enum(['agent', 'project', 'role', 'global']).default('agent'), agent: z.string().optional(), project: z.string().optional(), role: z.string().optional() });

/** Syntax remains recognisable after unload, so saved drafts can still be edited. */
export function pluginNodeReference(type: string): { kind: 'trigger' | 'executor'; id: string; pluginId: string } | undefined {
  const kind = type.startsWith('trigger.') ? 'trigger' : type.startsWith('plugin.') ? 'executor' : undefined;
  if (!kind) return undefined;
  const id = type.slice(kind === 'trigger' ? 'trigger.'.length : 'plugin.'.length);
  const parsed = parseIntegrationId(id);
  return parsed ? { kind, id, pluginId: parsed.pluginId } : undefined;
}

export function workflowNodeSpec(type: string): NodeSpec | undefined {
  if (Object.hasOwn(nodeRegistry, type)) return nodeRegistry[type];
  const ref = pluginNodeReference(type);
  if (!ref) return undefined;
  const lease = ref.kind === 'trigger' ? integrationRegistries.triggers.get(ref.id) : integrationRegistries.executors.get(ref.id);
  if (!lease) return undefined;
  const definition = lease.definition;
  return {
    type,
    ports: { in: ['in'], out: 'outputPorts' in definition ? [...definition.outputPorts] : ['out'] },
    configSchema: z.unknown().superRefine((value, ctx) => {
      try { parseIntegrationValue(definition.configSchema, value); }
      catch (error) { ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'invalid plugin configuration' }); }
    }),
  };
}

export function workflowNodeSpecs(): NodeSpec[] {
  const types = [
    ...Object.keys(nodeRegistry),
    ...integrationRegistries.triggers.list().map((lease) => `trigger.${lease.id}`),
    ...integrationRegistries.executors.list().map((lease) => `plugin.${lease.id}`),
  ];
  return types.flatMap((type) => { const spec = workflowNodeSpec(type); return spec ? [spec] : []; });
}
