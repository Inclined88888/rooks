/**
 * Shape of a native trigger (TODO #216): one source, an optional filter, one
 * to five actions. Validated by zod on every way in — API, MCP, CLI — and
 * again when a stored row is read back, so a hand-edited row cannot smuggle
 * an action the vocabulary does not have.
 */
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { TASK_TYPES } from '../db.js';
import { filterSchema } from './filter.js';
import { PATH_RE } from './payload.js';
import { AUTH_SCHEMES } from './signature.js';
import { SECRET_NAME_RE } from '../secrets/resolve.js';
import type {
  TriggerAction as ContractTriggerAction, TriggerDefinition as ContractTriggerDefinition,
} from '../plugins/contract/automation.js';
import type { Assert, Equals } from '../type-equality.js';

export const TRIGGER_SOURCES = ['schedule', 'webhook', 'event'] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

/**
 * Internal bus events a trigger can listen to. `notification` = one created;
 * `todo_done` = a TO DO idea reaching the `done` progress, by hand or when the
 * chain that implements it lands; `todo_resolved` = an idea given a new outcome
 * (fixed, declined, duplicate, needs_info, in_progress, planned).
 */
export const EVENT_KINDS = [
  'mission_complete', 'task_done', 'task_blocked', 'agent_message', 'notification', 'todo_done', 'todo_resolved',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** A webhook route name: lower-case, URL-safe, readable. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Default per-route budget, calls per minute — the workflow webhooks' one. */
export const DEFAULT_RATE_LIMIT = 30;

const todoAction = z.object({
  type: z.literal('todo'),
  /** Templates: `{issue.title}` etc. */
  text: z.string().min(1).max(1000),
  notes: z.string().max(20_000).optional(),
  project: z.string().max(200).optional(),
  /** Rendered, then kept only if it is one of the urgency tags. */
  urgency: z.string().max(200).optional(),
}).strict();

const taskAction = z.object({
  type: z.literal('task'),
  /** Literal on purpose: a payload never chooses which agent runs. */
  agent: z.string().min(1).max(200),
  prompt: z.string().min(1).max(20_000),
  title: z.string().max(1000).optional(),
  task_type: z.enum(TASK_TYPES).optional(),
  project: z.string().max(200).nullable().optional(),
  priority: z.number().int().min(1).max(5).optional(),
  /** Prompt used verbatim, no template — what every migrated routine carries. */
  raw: z.boolean().optional(),
  /**
   * The task's work return never goes up to the pilot: the agent's report
   * lands where the task puts it (an idea's notes, a notification) and the
   * orchestrator's thread is left alone. Off by default.
   */
  silent_return: z.boolean().optional(),
}).strict();

const notifyAction = z.object({
  type: z.literal('notify'),
  title: z.string().min(1).max(1000),
  body: z.string().max(5000).optional(),
  level: z.enum(['report', 'alert']).optional(),
  urgent: z.boolean().optional(),
}).strict();

/**
 * Run a workflow from one of its entry nodes. Executed by the Workflows module
 * when it runs (`registerActionProvider`); this module never imports it.
 */
const workflowAction = z.object({
  type: z.literal('workflow'),
  /** Workflow id (or slug). */
  workflow: z.string().min(1).max(200),
  /** Entry node the run starts from: a run only starts at the node it names. */
  node: z.string().min(1).max(200),
}).strict();

/**
 * POST the trigger's payload to another service, signed the Standard Webhooks
 * way with the trigger's outbound secret. The URL is literal, never a
 * template: a payload does not choose where it is sent. https only, no
 * credentials in it (they would sit in the actions column, shown to anyone who
 * reads the trigger).
 */
const webhookAction = z.object({
  type: z.literal('webhook'),
  url: z.string().max(2000).refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !!url.hostname;
    } catch {
      return false;
    }
  }, 'an https URL without credentials'),
}).strict();

/** Ceiling of `timeout_s`: a script is a quick job, not a service. */
export const SCRIPT_MAX_TIMEOUT_S = 3600;
export const SCRIPT_DEFAULT_TIMEOUT_S = 300;

/**
 * Run a program on the host, without an agent nor a model (TODO #421). Every
 * field is literal, never a template: nothing in a payload reaches the
 * command line, the environment or the folder. No shell: `command` is the
 * executable (a name on PATH, an absolute path, or a path relative to `cwd`)
 * and `args` its argv — a shell is something the owner writes out
 * (`bash -c …`). `cwd` must sit inside a registered project, re-checked at
 * every run. `env` names vault secrets (inject mode, granted globally or to
 * that project): only their names are stored, and their values are scrubbed
 * from what the journal keeps of the output.
 */
const scriptAction = z.object({
  type: z.literal('script'),
  command: z.string().trim().min(1).max(1000),
  args: z.array(z.string().max(4000)).max(64).optional(),
  cwd: z.string().min(1).max(1000).refine((value) => isAbsolute(value), 'an absolute path'),
  env: z.array(z.string().regex(SECRET_NAME_RE, 'a secret name (A-Z, 0-9, _)')).max(20).optional(),
  timeout_s: z.number().int().min(1).max(SCRIPT_MAX_TIMEOUT_S).optional(),
  /** `skip` (default): a tick that finds the previous run still going does nothing. */
  overlap: z.enum(['skip', 'allow']).optional(),
  /** Default true: a failed run raises an `alert` notification with the end of its output. */
  notify_on_failure: z.boolean().optional(),
}).strict();

export const actionSchema = z.discriminatedUnion('type', [todoAction, taskAction, notifyAction, workflowAction, webhookAction, scriptAction]);
export type TriggerAction = z.infer<typeof actionSchema>;
/** The public contract spells the schema out; compilation fails if they part. */
type _TriggerActionMatchesContract = Assert<Equals<TriggerAction, ContractTriggerAction>>;
export type ActionType = TriggerAction['type'];

/**
 * The permission an action needs, checked against the grants frozen on the
 * trigger — never against whoever happens to send the payload.
 */
export const ACTION_PERMISSION: Record<ActionType, string> = {
  todo: 'kanban:write',
  task: 'kanban:write',
  notify: 'notify',
  workflow: 'workflows:run',
  webhook: 'http:outbound',
  // Never in the mission token cap: an agent cannot schedule code on its own.
  script: 'scripts:run',
};

const coalesceSchema = z.object({
  /** Path of the entity key: one run per burst of events on the same entity. */
  key: z.string().min(1).max(200).regex(PATH_RE, 'invalid path'),
  /** Quiet period that closes a burst. */
  quiet_ms: z.number().int().min(500).max(3_600_000),
  /** Ceiling: a burst that never calms down still runs. */
  max_ms: z.number().int().min(500).max(86_400_000).optional(),
}).strict();

const rateLimit = z.number().int().min(1).max(600);

export const scheduleConfigSchema = z.object({
  cron: z.string().min(1).max(200),
  tz: z.string().min(1).max(100).optional(),
}).strict().superRefine((config, ctx) => {
  try {
    CronExpressionParser.parse(config.cron, { tz: config.tz });
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: `invalid cron: ${(err as Error).message}` });
  }
});

/**
 * Why a cron expression ticks more often than once a minute, or null — the
 * floor of every schedule (a plugin's routine has its own, five minutes:
 * `MIN_ROUTINE_INTERVAL_MS`), since each tick may open a task that burns a
 * subscription. Five
 * fields never do; six only when the seconds field holds several values, so
 * that field alone decides — exactly, whatever the time zone or DST.
 *
 * Checked when a schedule is written, never when a stored row is read back: a
 * row saved before the floor must stay readable, hence switchable off.
 */
export function scheduleCadenceProblem(cron: string, tz?: string): string | null {
  let seconds: readonly number[];
  try {
    seconds = CronExpressionParser.parse(cron, { tz }).fields.second.values;
  } catch (err) {
    return `invalid cron: ${(err as Error).message}`;
  }
  return seconds.length > 1
    ? 'cron: a schedule runs at most once a minute — drop the seconds field or give it a single value'
    : null;
}

export const webhookConfigSchema = z.object({
  auth: z.enum(AUTH_SCHEMES),
  rate_limit: rateLimit.optional(),
  coalesce: coalesceSchema.optional(),
}).strict();

export const eventConfigSchema = z.object({
  event: z.enum(EVENT_KINDS),
  rate_limit: rateLimit.optional(),
  coalesce: coalesceSchema.optional(),
}).strict();

export type ScheduleConfig = z.infer<typeof scheduleConfigSchema>;
export type WebhookConfig = z.infer<typeof webhookConfigSchema>;
export type EventConfig = z.infer<typeof eventConfigSchema>;

const name = z.string().trim().min(1).max(120);
const actions = z.array(actionSchema).min(1).max(5);

/**
 * Definition of a trigger, everything but its identity and bookkeeping. A
 * schedule has no payload from outside, hence no filter.
 */
export const triggerDefinitionSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('schedule'), name, enabled: z.boolean().optional(), actions,
    config: scheduleConfigSchema,
  }).strict(),
  z.object({
    source: z.literal('webhook'), name, enabled: z.boolean().optional(), actions,
    slug: z.string().regex(SLUG_RE, 'slug: lower-case letters, digits and dashes'),
    config: webhookConfigSchema,
    filter: filterSchema.nullable().optional(),
  }).strict(),
  z.object({
    source: z.literal('event'), name, enabled: z.boolean().optional(), actions,
    config: eventConfigSchema,
    filter: filterSchema.nullable().optional(),
  }).strict(),
]);
export type TriggerDefinition = z.infer<typeof triggerDefinitionSchema>;
type _TriggerDefinitionMatchesContract = Assert<Equals<TriggerDefinition, ContractTriggerDefinition>>;

/**
 * A webhook secret the sender imposes (Standard Webhooks providers generate
 * their own). Read apart from the definition, whose objects are strict.
 */
export const providedSecretSchema = z.string().min(16).max(256);

/** Patch body: the source is fixed at creation, everything else may move. */
export const updateTriggerSchema = z.object({
  name: z.unknown().optional(),
  enabled: z.unknown().optional(),
  slug: z.unknown().optional(),
  config: z.unknown().optional(),
  filter: z.unknown().optional(),
  actions: z.unknown().optional(),
}).strict();

export const testTriggerSchema = z.object({
  payload: z.unknown().optional(),
  headers: z.record(z.string().max(200), z.string().max(4000)).optional(),
  /** Off by default: a test shows what would happen, it does not do it. */
  execute: z.boolean().optional(),
}).strict();
