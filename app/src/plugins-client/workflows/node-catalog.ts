/**
 * Presentation of workflow node types: icon, family, form fields and the
 * rows a card paints from its config.
 *
 * This is NOT the list of node types. That list lives in the daemon registry
 * (`GET /api/workflows/node-types`) and drives the palette; a type the daemon
 * knows and this file does not still renders, with a generic face
 * (`presentationFor` falls back). Only *looks* are decided here.
 */
import type { LucideIcon } from 'lucide-react';
import {
  ArrowRightLeft,
  Bell,
  BookOpen,
  Bot,
  Boxes,
  CalendarClock,
  Flag,
  GitFork,
  GitMerge,
  Globe,
  Hourglass,
  MousePointerClick,
  PenLine,
  Radio,
  Split,
  Terminal,
  UserCheck,
  Webhook,
  Wand2,
} from 'lucide-react';
import { t } from '@/lib/i18n';
import { formatDuration } from './types';

export type NodeCategory = 'trigger' | 'agent' | 'logic' | 'action' | 'human' | 'memory' | 'end';

export const CATEGORY_ORDER: NodeCategory[] = ['trigger', 'agent', 'logic', 'action', 'human', 'memory', 'end'];

/** Accent per family, as theme tokens so both palettes stay coherent. */
export const CATEGORY_TONE: Record<NodeCategory, string> = {
  trigger: 'hsl(var(--warning))',
  agent: 'hsl(var(--primary))',
  logic: 'hsl(var(--info))',
  action: 'hsl(var(--success))',
  human: 'hsl(var(--warning))',
  memory: 'hsl(var(--info))',
  end: 'hsl(var(--muted-foreground))',
};

export type SelectOption = { value: string; label: string };

export type FieldSpec =
  | { key: string; kind: 'text' | 'textarea' | 'number' | 'cron' | 'json'; placeholder?: string; mono?: boolean }
  | { key: string; kind: 'select'; options: SelectOption[] }
  | { key: string; kind: 'boolean' }
  | { key: string; kind: 'list'; placeholder?: string };

export type NodePresentation = {
  category: NodeCategory;
  icon: LucideIcon;
  fields: FieldSpec[];
  /** Short rows painted inside the card. Empty array = title only. */
  summary: (config: Record<string, unknown>) => string[];
};

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const excerpt = (value: unknown, max = 64): string => {
  const text = str(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const SCOPES: SelectOption[] = ['agent', 'project', 'role', 'global'].map((value) => ({ value, label: value }));
const IDENTITY_FIELDS = ['agent', 'project', 'role'].map((key): FieldSpec => ({ key, kind: 'text' }));

/** Bus kinds a `trigger.event` may listen to — the enum of the daemon schema. */
const EVENT_KINDS = ['mission_complete', 'task_done', 'task_blocked', 'agent_message', 'notification', 'todo_done', 'todo_resolved'];

export const AGENT_FIELDS: FieldSpec[] = [
  { key: 'input', kind: 'textarea', placeholder: '{{input.text}} · {{nodes.previous.output}}' },
  { key: 'completion', kind: 'select', options: [{ value: 'turn', label: 'turn' }, { value: 'explicit', label: 'explicit' }] },
  { key: 'routes', kind: 'list', placeholder: 'escalate, needs-review' },
  { key: 'timeoutMs', kind: 'number' },
  { key: 'retries', kind: 'number' },
];

const CATALOG: Record<string, NodePresentation> = {
  'trigger.manual': { category: 'trigger', icon: MousePointerClick, fields: [], summary: () => [t('workflows.summary.manual')] },
  'trigger.schedule': {
    category: 'trigger', icon: CalendarClock,
    fields: [{ key: 'cron', kind: 'cron' }, { key: 'tz', kind: 'text', placeholder: 'Europe/Paris' }],
    summary: (config) => [config.cron ? `cron ${str(config.cron)}${config.tz ? ` · ${str(config.tz)}` : ''}` : t('workflows.summary.noCron')],
  },
  'trigger.webhook': {
    category: 'trigger', icon: Webhook,
    fields: [{ key: 'slug', kind: 'text', mono: true, placeholder: 'my-route' }, { key: 'auth', kind: 'select', options: ['standard', 'github', 'gitlab', 'generic', 'none'].map((value) => ({ value, label: value })) }],
    summary: (config) => [config.slug ? `POST /api/triggers/hooks/${str(config.slug)}` : t('workflows.summary.webhook')],
  },
  'trigger.event': {
    category: 'trigger', icon: Radio,
    fields: [{ key: 'kind', kind: 'select', options: EVENT_KINDS.map((value) => ({ value, label: value })) }, { key: 'filter', kind: 'text', mono: true, placeholder: 'payload.status == "done"' }],
    summary: (config) => [config.kind ? `on ${str(config.kind)}` : t('workflows.summary.noEvent'), ...(config.filter ? [excerpt(config.filter)] : [])],
  },
  agent: {
    category: 'agent', icon: Bot, fields: AGENT_FIELDS,
    summary: (config) => {
      const identity = (config.identity ?? {}) as Record<string, unknown>;
      const rows = [config.ref ? `@${str(config.ref)}` : identity.name ? str(identity.name) : t('workflows.inline')];
      const model = str(config.model) || str(identity.model);
      if (model) rows.push(model);
      if (config.completion === 'explicit') rows.push(t('workflows.summary.explicit'));
      if (config.input) rows.push(excerpt(config.input));
      return rows;
    },
  },
  skill: {
    category: 'agent', icon: Wand2, fields: [{ key: 'skillId', kind: 'text', placeholder: 'code-review' }, ...AGENT_FIELDS],
    summary: (config) => [config.skillId ? `skill ${str(config.skillId)}` : t('workflows.summary.noSkill'), ...(config.ref ? [`@${str(config.ref)}`] : [])],
  },
  condition: {
    category: 'logic', icon: Split,
    fields: [{ key: 'expr', kind: 'text', mono: true, placeholder: 'nodes.agent-1.output.score > 0.8' }],
    summary: (config) => [config.expr ? excerpt(config.expr) : t('workflows.summary.noExpr')],
  },
  switch: {
    category: 'logic', icon: ArrowRightLeft,
    fields: [{ key: 'on', kind: 'text', mono: true, placeholder: 'nodes.agent-1.output.kind' }, { key: 'cases', kind: 'json', placeholder: '[{ "port": "bug", "value": "bug" }]' }],
    summary: (config) => [config.on ? `on ${str(config.on)}` : t('workflows.summary.noExpr'), t('workflows.summary.cases', { n: Array.isArray(config.cases) ? config.cases.length : 0 })],
  },
  script: {
    category: 'action', icon: Terminal,
    fields: [{ key: 'bin', kind: 'text', mono: true, placeholder: 'node' }, { key: 'args', kind: 'list', placeholder: 'script.js' }, { key: 'cwd', kind: 'text', mono: true }, { key: 'timeoutMs', kind: 'number' }, { key: 'env', kind: 'list', placeholder: 'GITHUB_TOKEN' }],
    summary: (config) => [config.bin ? excerpt(`${str(config.bin)} ${list(config.args).join(' ')}`) : t('workflows.summary.noBin')],
  },
  http: {
    category: 'action', icon: Globe,
    fields: [
      { key: 'url', kind: 'text', mono: true, placeholder: 'https://api.example.com/items/{{input.id}}' },
      { key: 'method', kind: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((value) => ({ value, label: value })) },
      { key: 'headers', kind: 'json', placeholder: '{ "Authorization": "Bearer {{secrets.API_TOKEN}}" }' },
      { key: 'body', kind: 'textarea', placeholder: '{ "text": "{{input.text}}" }' },
      { key: 'timeoutMs', kind: 'number' },
      { key: 'allowPrivateNetwork', kind: 'boolean' },
    ],
    summary: (config) => [config.url ? excerpt(`${str(config.method, 'GET')} ${str(config.url)}`) : t('workflows.summary.noUrl')],
  },
  parallel: { category: 'logic', icon: GitFork, fields: [], summary: () => [t('workflows.summary.parallel')] },
  join: {
    category: 'logic', icon: GitMerge,
    fields: [{ key: 'mode', kind: 'select', options: ['all', 'any', 'n'].map((value) => ({ value, label: value })) }, { key: 'n', kind: 'number' }],
    summary: (config) => [`${t('workflows.fields.mode')} ${str(config.mode, 'all')}${config.mode === 'n' ? ` (${String(config.n ?? 1)})` : ''}`],
  },
  human: {
    category: 'human', icon: UserCheck,
    fields: [{ key: 'question', kind: 'textarea' }, { key: 'options', kind: 'list', placeholder: 'ship, hold' }, { key: 'timeoutMs', kind: 'number' }],
    summary: (config) => [config.question ? excerpt(config.question) : t('workflows.summary.noQuestion'), ...(list(config.options).length ? [list(config.options).join(' · ')] : [])],
  },
  notify: {
    category: 'action', icon: Bell,
    fields: [{ key: 'type', kind: 'select', options: [{ value: 'report', label: 'report' }, { value: 'alert', label: 'alert' }] }, { key: 'title', kind: 'text' }, { key: 'body', kind: 'textarea' }],
    summary: (config) => [`${str(config.type, 'report')}${config.title ? ` · ${excerpt(config.title, 48)}` : ''}`],
  },
  'memory.read': {
    category: 'memory', icon: BookOpen,
    fields: [{ key: 'scope', kind: 'select', options: SCOPES }, { key: 'query', kind: 'text' }, ...IDENTITY_FIELDS],
    summary: (config) => [`${str(config.scope, 'global')}${config.query ? ` · ${excerpt(config.query, 48)}` : ''}`],
  },
  'memory.write': {
    category: 'memory', icon: PenLine,
    fields: [{ key: 'text', kind: 'textarea' }, { key: 'kind', kind: 'select', options: ['pitfall', 'decision', 'preference'].map((value) => ({ value, label: value })) }, { key: 'scope', kind: 'select', options: SCOPES }, ...IDENTITY_FIELDS],
    summary: (config) => [`${str(config.kind, 'pitfall')} · ${str(config.scope, 'agent')}`, ...(config.text ? [excerpt(config.text)] : [])],
  },
  wait: {
    category: 'logic', icon: Hourglass, fields: [{ key: 'ms', kind: 'number' }],
    summary: (config) => [typeof config.ms === 'number' ? formatDuration(config.ms) : t('workflows.summary.noDelay')],
  },
  output: {
    category: 'end', icon: Flag, fields: [{ key: 'template', kind: 'textarea', placeholder: '{{nodes.agent-1.output.text}}' }],
    summary: (config) => [config.template ? excerpt(config.template) : t('workflows.summary.noTemplate')],
  },
};

const GENERIC: NodePresentation = { category: 'action', icon: Boxes, fields: [], summary: () => [] };

export function presentationFor(type: string): NodePresentation {
  return CATALOG[type] ?? GENERIC;
}

/** i18n key segment for a type: `trigger.schedule` → `trigger_schedule`. */
export function nodeKey(type: string): string {
  return type.replace(/\./g, '_');
}

export function nodeTypeLabel(type: string): string {
  const key = `workflows.node.${nodeKey(type)}.label`;
  const label = t(key);
  return label === key ? type : label;
}

export function nodeTypeDescription(type: string): string {
  const key = `workflows.node.${nodeKey(type)}.desc`;
  const text = t(key);
  return text === key ? '' : text;
}

export function categoryLabel(category: NodeCategory): string {
  return t(`workflows.cat.${category}`);
}

/** Default label for a freshly added node. */
export function defaultLabel(type: string): string {
  return nodeTypeLabel(type);
}

/** Default config so a fresh node validates on the daemon side. */
export function defaultConfig(type: string): Record<string, unknown> {
  switch (type) {
    case 'trigger.schedule': return { cron: '0 9 * * 1' };
    case 'trigger.event': return { kind: 'mission_complete' };
    case 'condition': return { expr: 'true' };
    case 'switch': return { on: 'input.kind', cases: [] };
    case 'script': return { bin: 'timon', args: [] };
    case 'http': return { url: 'https://', method: 'GET' };
    case 'join': return { mode: 'all' };
    case 'human': return { question: '' };
    case 'notify': return { type: 'report', title: '' };
    case 'memory.write': return { text: '', kind: 'pitfall', scope: 'agent' };
    case 'wait': return { ms: 60_000 };
    case 'output': return { template: '{{nodes}}' };
    case 'agent': return { input: '', completion: 'turn', retries: 0 };
    case 'skill': return { skillId: '', input: '', completion: 'turn', retries: 0 };
    default: return {};
  }
}
