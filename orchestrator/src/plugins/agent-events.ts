/**
 * Agent events as a third-party plugin receives them (`ctx.events.on`):
 * `agent_created`, `agent_updated` and `agent_deleted`.
 *
 * The core publishes them whoever wrote the agent — the page, the CLI, an MCP
 * tool, another plugin — and a plugin gets a translation: the agent as that
 * write left it, in the identity-only shape of `ctx.agents.list`, and the
 * `origin` of the write (`write-origin.ts`), so a plugin that synchronises
 * agents with an outside system drops the echo of its own writes.
 *
 * Audience: agents have no owner account, so the only safe default is the one
 * `ctx.agents.list` gives a job — a plugin hears about the agents IT created
 * (`created_by`), as itself. A deleted agent comes with the snapshot taken
 * before the removal, mark included; a renamed one is an `agent_updated` whose
 * `previousName` is the old name.
 */
import type { AgentEventSnapshot, BusEvent } from '../bus.js';
import { currentWriteOrigin, type WriteOrigin } from '../write-origin.js';
import { pluginAgentOrigin } from './agent-origin.js';
import { createPluginEventSubscriber } from './plugin-event-hub.js';

import type { PluginAgentEventKind, PluginAgentSnapshot, PluginAgentEvent } from './contract/agents.js';
import type { Assert, Equals } from '../type-equality.js';
export type {
  PluginAgentEventKind, PluginAgentOrigin, PluginAgentSnapshot, PluginAgentCreatedEvent,
  PluginAgentUpdatedEvent, PluginAgentDeletedEvent, PluginAgentEvent, PluginAgentEventMap,
  PluginAgentEventHandler,
} from './contract/agents.js';

export const PLUGIN_AGENT_EVENT_KINDS = Object.freeze(['agent_created', 'agent_updated', 'agent_deleted'] as const);
/** `PluginAgentEventKind` spells this list out in the public contract; compilation fails if they part. */
type _PluginAgentEventKindsMatchContract = Assert<Equals<(typeof PLUGIN_AGENT_EVENT_KINDS)[number], PluginAgentEventKind>>;

export function isPluginAgentEventKind(kind: unknown): kind is PluginAgentEventKind {
  return typeof kind === 'string' && (PLUGIN_AGENT_EVENT_KINDS as readonly string[]).includes(kind);
}

const snapshot = (a: AgentEventSnapshot): PluginAgentSnapshot => Object.freeze({
  name: a.name, backend: a.backend, model: a.model, project: a.project, role: a.role,
  hasSystemPrompt: a.has_system_prompt, createdBy: a.created_by,
});

/** The plugin's translation of a bus event, or `null` for anything else. */
export function pluginAgentEventFromBus(ev: BusEvent, origin: WriteOrigin): PluginAgentEvent | null {
  switch (ev.kind) {
    case 'agent_created':
      return Object.freeze({ kind: 'agent_created', agent: snapshot(ev.agent), origin });
    case 'agent_updated':
      return Object.freeze({
        kind: 'agent_updated', agent: snapshot(ev.agent), changed: Object.freeze([...ev.changed]),
        previousName: ev.previousName, origin,
      });
    case 'agent_deleted':
      return Object.freeze({ kind: 'agent_deleted', agent: snapshot(ev.agent), origin });
    default:
      return null;
  }
}

export const subscribePluginAgentEvent = createPluginEventSubscriber<PluginAgentEventKind, PluginAgentEvent>({
  label: 'agent',
  kindOf: (ev) => (isPluginAgentEventKind(ev.kind) ? ev.kind : null),
  translate(ev, pluginId) {
    // Read SYNCHRONOUSLY: the writer's store is the one of this callback.
    const translated = pluginAgentEventFromBus(ev, currentWriteOrigin());
    // Only the agents this plugin created: the identity of the others is not its to follow.
    if (!translated || translated.agent.createdBy !== pluginAgentOrigin(pluginId)) return null;
    return { ev: translated, identity: null };
  },
});
