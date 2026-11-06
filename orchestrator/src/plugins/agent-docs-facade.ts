/**
 * `ctx.agents.docs`: the identity documents of an agent (`SOUL.md`, `USER.md`,
 * any `*.md` at its root — `system-prompt.md` included), as the page of an
 * agent edits them.
 *
 * These files are injected into every mission the agent runs: reading one is
 * reading its instructions, writing one is rewriting how it behaves. So, unlike
 * `ctx.agents.list`, which gives an identity only, this facade reaches ONLY the
 * agents this plugin created (`resolveOwnAgent`), for a job and a request alike
 * — a superadmin caller excepted. It needs its own permissions, separate for
 * reading and writing, on top of `agents:*`'s caller rule (the account must be
 * allowed to read, or to manage, agents).
 */
import { z } from 'zod';
import { AGENT_DOC_MAX_BYTES, deleteDoc, listDocs, readDoc, writeDoc } from '../agent.js';
import { withWriteOrigin } from '../write-origin.js';
import { PluginAgentError, resolveOwnAgent, type AgentCallerScope } from './agents-facade.js';

import type { PluginAgentDoc } from './contract/agents.js';
export type { PluginAgentDoc } from './contract/agents.js';

export type ScopedAgentDocs = {
  list(agent: string): Promise<PluginAgentDoc[]>;
  /** `null` when the document does not exist. */
  get(agent: string, file: string): Promise<string | null>;
  /** An empty document is refused: to remove one, `rm`. */
  put(agent: string, file: string, content: string): Promise<PluginAgentDoc>;
  /** `true` when the document existed. `system-prompt.md` cannot be removed. */
  rm(agent: string, file: string): Promise<boolean>;
};

const DocFile = z.string().regex(/^[\w.-]+\.md$/, 'a doc is a *.md file at the root of the agent').max(200);
const Content = z.string().refine((c) => c.trim().length > 0, 'empty content (to delete the doc: rm)');

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const res = schema.safeParse(value);
  if (!res.success) throw new PluginAgentError('invalid', res.error.issues[0]?.message ?? 'invalid input');
  return res.data;
}

/** The core throws plain errors for a doc it refuses (system prompt, bad name). */
function refused<T>(fn: () => T): T {
  try { return fn(); } catch (err) { throw new PluginAgentError('invalid', (err as Error).message); }
}

export function agentDocsFor(scope: AgentCallerScope): ScopedAgentDocs {
  return {
    async list(agent) {
      const { name } = resolveOwnAgent(scope, agent);
      return listDocs(name);
    },

    async get(agent, file) {
      const { name } = resolveOwnAgent(scope, agent);
      return refused(() => readDoc(name, parse(DocFile, file)));
    },

    async put(agent, file, content) {
      const { name } = resolveOwnAgent(scope, agent);
      const doc = parse(DocFile, file);
      const text = parse(Content, content);
      if (Buffer.byteLength(text, 'utf8') > AGENT_DOC_MAX_BYTES) {
        throw new PluginAgentError('invalid', `doc too large (max ${AGENT_DOC_MAX_BYTES} bytes)`);
      }
      return refused(() => withWriteOrigin({ kind: 'plugin', id: scope.pluginId }, () => writeDoc(name, doc, text)));
    },

    async rm(agent, file) {
      const { name } = resolveOwnAgent(scope, agent);
      return refused(() => withWriteOrigin({ kind: 'plugin', id: scope.pluginId }, () => deleteDoc(name, parse(DocFile, file))));
    },
  };
}
