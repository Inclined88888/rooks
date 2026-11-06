/**
 * What the import remembers between two imports, in the plugin's key-value
 * store: for each agent of a source, the Timon agent it became and everything
 * the import wrote for it, plus the fingerprint of its documents. A second
 * import of the same source updates that agent instead of making a twin, and
 * leaves alone an agent somebody changed by hand since.
 *
 * Keys hold a digest, never a name from the manifest: a source string does not
 * choose a key of the store.
 */
import { createHash } from 'node:crypto';
import * as z from 'zod/mini';
import type { PluginContext } from '@timon-ai/sdk';

const REF_PREFIX = 'ref:';
const SKILL_PREFIX = 'skill:';
const MCP_PREFIX = 'mcp:';

/** The identity documents whose fingerprint tells a hand edit. */
export const FINGERPRINTED_DOCS = ['SOUL.md', 'system-prompt.md'] as const;

/**
 * The account that ran the import (`null`: a job, no account). Absent on a
 * record written before it existed: such a record is nobody's, so only a
 * superadmin reaches it (fail closed).
 */
const OwnerSchema = z.optional(z.nullable(z.string()));

const ImportRecordSchema = z.strictObject({
  sourceApp: z.string(),
  sourceRef: z.string(),
  ownerUserId: OwnerSchema,
  agent: z.string(),
  /** SHA-256 of each document as the import left it; `null` = absent. */
  docs: z.record(z.string(), z.nullable(z.string())),
  skills: z.array(z.string()),
  mcpServers: z.array(z.string()),
  triggers: z.array(z.string()),
  rules: z.array(z.int()),
  /** The team the import put the agent in; absent on a record written before. */
  team: z.optional(z.nullable(z.string())),
  /** Somebody else changed the agent since the import. */
  touched: z.boolean(),
  importedAt: z.number(),
});
export type ImportRecord = z.infer<typeof ImportRecordSchema>;

const OwnedSchema = z.strictObject({ sourceApp: z.string(), sourceId: z.string(), ownerUserId: OwnerSchema });
export type OwnedRecord = z.infer<typeof OwnedSchema>;

const digest = (...parts: string[]): string => createHash('sha256').update(parts.join('\0')).digest('hex');

export const fingerprint = (content: string | null): string | null => (content === null ? null : digest(content));

/** Who is asking: the account's id (`null` for a job), and whether it is a superadmin. */
export type RecordCaller = { userId: string | null; superadmin: boolean };

/**
 * A record or an owned skill / server this caller may build on: its own, or
 * anybody's for a superadmin. A record without an owner is nobody's.
 */
export function ownedBy(owner: string | null | undefined, caller: RecordCaller): boolean {
  if (caller.superadmin) return true;
  return owner !== undefined && owner === caller.userId;
}

type Kv = PluginContext['storage']['kv'];

export type Records = ReturnType<typeof createRecords>;

export function createRecords(kv: Kv) {
  // One record per account and source agent: two accounts importing the same
  // source each keep their own. A record without an owner sits under the key
  // of before, which no account's lookup reaches.
  const refKey = (sourceApp: string, sourceRef: string, owner?: string | null): string => (owner === undefined
    ? REF_PREFIX + digest(sourceApp, sourceRef)
    : REF_PREFIX + digest(sourceApp, sourceRef, 'owner', owner ?? ''));

  async function all(): Promise<Array<{ key: string; record: ImportRecord }>> {
    const out: Array<{ key: string; record: ImportRecord }> = [];
    for (const { key, value } of await kv.list(REF_PREFIX)) {
      const parsed = ImportRecordSchema.safeParse(value);
      if (parsed.success) out.push({ key, record: parsed.data });
    }
    return out;
  }

  const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

  return {
    /**
     * The record of this source agent the caller may build on: its own, else —
     * for a superadmin only — anybody's, a record without an owner included;
     * among several accounts' records, the oldest import.
     */
    async find(sourceApp: string, sourceRef: string, caller: RecordCaller): Promise<{ key: string; record: ImportRecord } | null> {
      const key = refKey(sourceApp, sourceRef, caller.userId);
      const parsed = ImportRecordSchema.safeParse(await kv.get(key));
      if (parsed.success && ownedBy(parsed.data.ownerUserId, caller)) return { key, record: parsed.data };
      if (!caller.superadmin) return null;
      const candidates = (await all()).filter(({ record }) => record.sourceApp === sourceApp && record.sourceRef === sourceRef);
      return candidates.sort((a, b) => a.record.importedAt - b.record.importedAt)[0] ?? null;
    },
    /** Writes `record` under its owner's key; `previousKey` (another key it was read from) is dropped. */
    async put(record: ImportRecord, previousKey?: string | null): Promise<void> {
      const key = refKey(record.sourceApp, record.sourceRef, record.ownerUserId);
      await kv.set(key, record);
      if (previousKey && previousKey !== key) await kv.del(previousKey);
    },
    /** Every record naming `agent` (one normally). */
    async byAgent(agent: string): Promise<Array<{ key: string; record: ImportRecord }>> {
      return (await all()).filter(({ record }) => sameName(record.agent, agent));
    },
    async set(key: string, record: ImportRecord): Promise<void> {
      await kv.set(key, record);
    },
    async del(key: string): Promise<void> {
      await kv.del(key);
    },

    /** A skill this plugin wrote, and which source skill it holds. */
    async skill(id: string): Promise<OwnedRecord | null> {
      const parsed = OwnedSchema.safeParse(await kv.get(SKILL_PREFIX + id));
      return parsed.success ? parsed.data : null;
    },
    async putSkill(id: string, owner: OwnedRecord): Promise<void> { await kv.set(SKILL_PREFIX + id, owner); },
    async dropSkill(id: string): Promise<void> { await kv.del(SKILL_PREFIX + id); },

    async mcp(id: string): Promise<OwnedRecord | null> {
      const parsed = OwnedSchema.safeParse(await kv.get(MCP_PREFIX + id));
      return parsed.success ? parsed.data : null;
    },
    async putMcp(id: string, owner: OwnedRecord): Promise<void> { await kv.set(MCP_PREFIX + id, owner); },
    async dropMcp(id: string): Promise<void> { await kv.del(MCP_PREFIX + id); },
  };
}

/**
 * Keeps the records true to the agents: a rename moves the record to the new
 * name, a write by anybody but this plugin marks the agent as changed by hand,
 * a removal forgets it (the next import creates it again).
 */
export function trackAgents(ctx: Pick<PluginContext, 'events' | 'id' | 'log'>, records: Records): void {
  const ours = (origin: { kind: string; id: string | null }): boolean => origin.kind === 'plugin' && origin.id === ctx.id;
  ctx.events.on('agent_updated', async (ev) => {
    // This plugin's own writes never rename, and the engine writes the record
    // itself: reading it here would race that write.
    if (ours(ev.origin)) return;
    const lookup = ev.previousName ?? ev.agent.name;
    for (const { key, record } of await records.byAgent(lookup)) {
      const next: ImportRecord = { ...record, agent: ev.agent.name };
      if (ev.changed.some((field) => field !== 'name')) next.touched = true;
      await records.set(key, next);
    }
  });
  ctx.events.on('agent_deleted', async (ev) => {
    for (const { key } of await records.byAgent(ev.agent.name)) await records.del(key);
  });
}
