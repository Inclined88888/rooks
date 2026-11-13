import { randomUUID } from 'node:crypto';
import { runPluginRequest } from './als.js';
import { integrationRegistries, integrationRequestIdentity } from './integration-host.js';
import { callIntegration, integrationJson, parseIntegrationValue } from './integration-primitives.js';
import { IntegrationQueueError, IntegrationStore, type IntegrationReceipt } from './integration-store.js';
import { completedReply, type MissionReplySource } from './integration-replies.js';
import { receiptListOptions, receiptView } from './integration-receipt-view.js';
import { redactDeep } from '../secrets/redact.js';
import { viewerAllows } from '../users/surfaces.js';
import type {
  PluginConnectionInput, PluginConnectionPatch, PluginInboundMessage, PluginJsonObject, PluginJsonValue,
  PluginConnectionReceipts, PluginMessagingConnection, PluginTransportContext, PluginTransportDefinition, PluginTransportRequest,
} from './integration-types.js';

export type IntegrationHost = {
  assert(pluginId: string, permission: string): void;
  secret(pluginId: string, name: string): string | undefined | Promise<string | undefined>;
  spawn(connection: PluginMessagingConnection, receipt: IntegrationReceipt, signal: AbortSignal): Promise<string>;
  mission(id: string, ownerUserId: string): Promise<MissionReplySource | undefined>;
  /** A receipt ran out of retries. Optional: a store without a host still keeps it. */
  gaveUp?(connection: PluginMessagingConnection, receipt: IntegrationReceipt): void;
};

function jsonObject(value: unknown): PluginJsonObject {
  const parsed = integrationJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new IntegrationQueueError(400, 'Expected a JSON object');
  return parsed;
}
function agentName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) throw new IntegrationQueueError(400, 'Invalid connection agent');
  return value;
}
function secretReferences(value: unknown): Record<string, string> {
  const parsed = jsonObject(value);
  if (Object.keys(parsed).length > 32 || Object.entries(parsed).some(([key, value]) => !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)
    || typeof value !== 'string' || !value.trim() || value.length > 128)) throw new IntegrationQueueError(400, 'Invalid secret references');
  return parsed as Record<string, string>;
}
function noSecretValues(value: PluginJsonValue, secrets: Set<string>): void {
  if (typeof value === 'string' && [...secrets].some((secret) => secret && value.includes(secret))) {
    throw new IntegrationQueueError(400, 'Transport returned a credential in persistable data');
  }
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    noSecretValues(key, secrets); noSecretValues(child, secrets);
  }
}
/**
 * The reason a receipt shows its owner. Plugin code wrote the message, so one
 * that echoes a credential read during the call is dropped rather than patched:
 * an encoded or truncated copy of the value would survive a replacement.
 */
function failureText(error: unknown, secrets: ReadonlySet<string>): string {
  const message = error instanceof Error ? error.message : '';
  if (!message.trim()) return 'Unknown failure';
  if ([...secrets].some((secret) => secret && message.includes(secret))) return 'Failure message withheld: it contained a credential';
  return String(redactDeep(message)).slice(0, 500);
}

/**
 * Runtime shared by public ingress, the durable worker and the S4 facades.
 * Its identities stay `unattended` (the default): transport callbacks serve
 * inbound traffic, and a connection's owner is passed by plugin code that may
 * be a job, so no human vouches for what they run.
 */
export class IntegrationService {
  readonly #controller = new AbortController();
  readonly #operations = new Map<AbortController, string>();
  #receiving = 0;
  constructor(readonly store: IntegrationStore, readonly host: IntegrationHost) {}

  get(pluginId: string, ownerUserId: string, id: string): PluginMessagingConnection | undefined {
    integrationRequestIdentity(pluginId, ownerUserId);
    const connection = this.store.getConnection(id);
    return connection?.pluginId === pluginId && connection.identity.ownerUserId === ownerUserId ? connection : undefined;
  }
  list(pluginId: string, ownerUserId: string): PluginMessagingConnection[] {
    integrationRequestIdentity(pluginId, ownerUserId);
    return this.store.listConnections(pluginId, ownerUserId);
  }
  /**
   * The follow-up of one connection, read by its plugin. Ownership is checked
   * before anything is counted, so another account's connection and a missing
   * one answer alike.
   */
  receipts(pluginId: string, ownerUserId: string, id: string, options: unknown): PluginConnectionReceipts {
    const parsed = receiptListOptions.safeParse(options ?? {});
    if (options === null || !parsed.success) throw new IntegrationQueueError(400, 'Invalid receipt options');
    const connection = typeof id === 'string' ? this.get(pluginId, ownerUserId, id) : undefined;
    if (!connection) throw new IntegrationQueueError(404, 'Connection not found');
    // A request may retain its viewer after the account's permissions change.
    if (ownerUserId !== `plugin:${pluginId}` && !viewerAllows(integrationRequestIdentity(pluginId, ownerUserId).viewer, 'connections:read')) {
      throw new IntegrationQueueError(403, 'Owner lacks connections:read');
    }
    return {
      counts: this.store.receiptCounts(connection.id),
      receipts: this.store.listTroubled(connection.id, parsed.data.status ?? null, parsed.data.limit).map(receiptView),
    };
  }
  async create(pluginId: string, ownerUserId: string, input: PluginConnectionInput): Promise<PluginMessagingConnection> {
    const value = jsonObject(input);
    if (Object.keys(value).some((key) => !['transport', 'agent', 'config', 'secretRefs'].includes(key))) throw new IntegrationQueueError(400, 'Unknown connection field');
    const lease = typeof value.transport === 'string' && integrationRegistries.transports.get(value.transport);
    if (!lease || lease.pluginId !== pluginId) throw new IntegrationQueueError(400, 'Transport belongs to another plugin or is unavailable');
    this.host.assert(pluginId, 'transports:register');
    const identity = integrationRequestIdentity(pluginId, ownerUserId);
    const config = await lease.invoke((definition) => runPluginRequest(identity, () => jsonObject(parseIntegrationValue(definition.configSchema, value.config ?? {}))));
    this.#controller.signal.throwIfAborted(); lease.signal.throwIfAborted();
    const connection: PluginMessagingConnection = {
      id: randomUUID(), pluginId, identity: { ownerUserId }, transport: lease.id, agent: agentName(value.agent),
      config, secretRefs: secretReferences(value.secretRefs ?? {}), enabled: true, revision: 1,
    };
    integrationRequestIdentity(pluginId, ownerUserId);
    this.host.assert(pluginId, 'transports:register');
    this.capability(connection, 'connections:write');
    this.store.createConnection(connection);
    return connection;
  }
  async update(pluginId: string, ownerUserId: string, id: string, patch: PluginConnectionPatch): Promise<PluginMessagingConnection> {
    this.host.assert(pluginId, 'transports:register');
    const old = this.get(pluginId, ownerUserId, id);
    if (!old) throw new IntegrationQueueError(404, 'Connection not found');
    const value = jsonObject(patch);
    if (Object.keys(value).some((key) => !['agent', 'config', 'secretRefs', 'enabled'].includes(key))) throw new IntegrationQueueError(400, 'Connection identity and transport are immutable');
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new IntegrationQueueError(400, 'Invalid enabled flag');
    let config = old.config;
    if (value.config !== undefined) {
      const lease = integrationRegistries.transports.get(old.transport);
      if (!lease) throw new IntegrationQueueError(503, 'Transport unavailable');
      config = await lease.invoke((definition) => runPluginRequest(integrationRequestIdentity(pluginId, ownerUserId), () => jsonObject(parseIntegrationValue(definition.configSchema, value.config))));
      lease.signal.throwIfAborted();
    }
    this.#controller.signal.throwIfAborted();
    const next: PluginMessagingConnection = {
      ...old, config, revision: old.revision + 1,
      agent: value.agent === undefined ? old.agent : agentName(value.agent),
      secretRefs: value.secretRefs === undefined ? old.secretRefs : secretReferences(value.secretRefs),
      enabled: value.enabled === undefined ? old.enabled : value.enabled,
    };
    integrationRequestIdentity(pluginId, ownerUserId);
    this.host.assert(pluginId, 'transports:register');
    this.capability(next, 'connections:write');
    this.store.updateConnection(next, old.revision);
    if (!next.enabled) for (const [controller, connectionId] of this.#operations) if (connectionId === id) controller.abort(new Error('Connection disabled'));
    return next;
  }

  private live(connection: PluginMessagingConnection): void {
    this.#controller.signal.throwIfAborted();
    const current = this.store.getConnection(connection.id);
    if (!current?.enabled || current.pluginId !== connection.pluginId || current.transport !== connection.transport
      || current.identity.ownerUserId !== connection.identity.ownerUserId) throw new IntegrationQueueError(503, 'Connection unavailable');
    integrationRequestIdentity(connection.pluginId, connection.identity.ownerUserId);
    this.host.assert(connection.pluginId, 'transports:register');
  }
  private capability(connection: PluginMessagingConnection, permission: string): void {
    this.host.assert(connection.pluginId, permission);
    const identity = integrationRequestIdentity(connection.pluginId, connection.identity.ownerUserId);
    if (connection.identity.ownerUserId !== `plugin:${connection.pluginId}` && !viewerAllows(identity.viewer, permission)) {
      throw new IntegrationQueueError(403, 'Connection owner lacks the required capability');
    }
  }

  private async run<T>(connection: PluginMessagingConnection,
    work: (definition: Readonly<PluginTransportDefinition>, context: PluginTransportContext, protect: (value: PluginJsonValue) => void) => Promise<T> | T,
    options: { timeoutMs?: number; signal?: AbortSignal; secrets?: Set<string> } = {},
  ): Promise<T> {
    this.live(connection);
    const lease = integrationRegistries.transports.get(connection.transport);
    if (!lease) throw new IntegrationQueueError(503, 'Transport unavailable');
    const controller = new AbortController();
    this.#operations.set(controller, connection.id);
    try {
      const result = await callIntegration((signal) => runPluginRequest(integrationRequestIdentity(connection.pluginId, connection.identity.ownerUserId), async () => {
        const secrets = options.secrets ?? new Set<string>();
        const snapshot = jsonObject(connection) as unknown as PluginMessagingConnection;
        const context: PluginTransportContext = {
          signal, identity: Object.freeze({ ...connection.identity }), connection: snapshot,
          secret: async (alias) => {
            signal.throwIfAborted(); controller.signal.throwIfAborted(); this.live(connection);
            if (!Object.hasOwn(connection.secretRefs, alias)) return undefined;
            this.capability(connection, 'secrets:read');
            const secret = await this.host.secret(connection.pluginId, connection.secretRefs[alias]!);
            signal.throwIfAborted(); controller.signal.throwIfAborted();
            this.live(connection); this.capability(connection, 'secrets:read');
            if (secret !== undefined) secrets.add(secret);
            return secret;
          },
        };
        return work(lease.definition, context, (value) => noSecretValues(value, secrets));
      }), {
        timeoutMs: options.timeoutMs ?? lease.definition.timeoutMs,
        signals: [this.#controller.signal, controller.signal, lease.signal, ...(options.signal ? [options.signal] : [])],
      });
      lease.signal.throwIfAborted(); controller.signal.throwIfAborted(); this.live(connection);
      return result;
    } finally {
      this.#operations.delete(controller);
      controller.abort(new Error('Integration operation finished'));
    }
  }

  async receive(id: string, request: PluginTransportRequest, signal?: AbortSignal): Promise<IntegrationReceipt | null> {
    const connection = this.store.getConnection(id);
    if (!connection?.enabled) throw new IntegrationQueueError(404, 'Connection not found');
    if (!(request.body instanceof Uint8Array) || request.body.byteLength > 256 * 1024) throw new IntegrationQueueError(413, 'Payload too large');
    if (this.#receiving >= 8) throw new IntegrationQueueError(503, 'Inbound capacity reached');
    this.#receiving++;
    try {
      const message = await this.run(connection, async (definition, context, protect) => {
        let received: PluginInboundMessage | null;
        try { received = await definition.receive(context, { body: new Uint8Array(request.body), headers: { ...request.headers } }); }
        catch { context.signal.throwIfAborted(); throw new IntegrationQueueError(401, 'Transport authentication failed'); }
        if (received === null) return null;
        const value = jsonObject(received);
        if (typeof value.externalId !== 'string' || !value.externalId.trim() || value.externalId.length > 256
          || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 64_000 || !Object.hasOwn(value, 'replyContext')) {
          throw new IntegrationQueueError(400, 'Invalid normalized message');
        }
        const normalized = { externalId: value.externalId, text: value.text, replyContext: value.replyContext! };
        protect(normalized);
        return normalized;
      }, { signal });
      return message === null ? null : this.store.accept(connection, message);
    } finally { this.#receiving--; }
  }

  async processInbox(now = Date.now()): Promise<boolean> {
    const row = this.store.claim('inbox', now);
    if (!row) return false;
    const connection = JSON.parse(row.connection) as PluginMessagingConnection;
    const secrets = new Set<string>();
    try {
      this.capability(connection, 'missions:spawn');
      const missionId = await this.run(connection, (_definition, context) => this.host.spawn(connection, row, context.signal), { timeoutMs: 60_000, secrets });
      if (typeof missionId !== 'string' || !missionId) throw new Error('Mission creation returned no id');
      this.capability(connection, 'missions:spawn');
      this.store.attachMission(row, missionId);
    } catch (error) { this.failed(connection, row, error, secrets); }
    return true;
  }
  async processReply(now = Date.now()): Promise<boolean> {
    const row = this.store.claim('reply', now);
    if (!row) return false;
    const connection = JSON.parse(row.connection) as PluginMessagingConnection;
    const secrets = new Set<string>();
    try {
      this.capability(connection, 'missions:read');
      let text = row.reply_text;
      if (text === null) {
        const mission = await this.run(connection, () => this.host.mission(row.mission_id!, connection.identity.ownerUserId), { timeoutMs: 30_000, secrets });
        if (!mission) throw new Error('Mission unavailable');
        const result = completedReply(mission);
        if (result === undefined) { this.store.defer(row, false); return true; }
        text = String(redactDeep(result)).slice(0, 64_000);
        if (!this.store.saveReplyText(row, text)) return true;
      }
      this.capability(connection, 'missions:read');
      const message = JSON.parse(row.message) as PluginInboundMessage;
      const delivery = await this.run(connection, async (definition, context, protect) => {
        const value = jsonObject(await definition.send(context, {
          text: text!, replyContext: integrationJson(message.replyContext), idempotencyKey: `integration:${row.id}`,
          checkpoint: integrationJson(JSON.parse(row.checkpoint)),
        }));
        if (typeof value.done !== 'boolean' || !Object.hasOwn(value, 'checkpoint')) throw new Error('Invalid delivery checkpoint');
        protect(value.checkpoint!);
        return { done: value.done, checkpoint: value.checkpoint! };
      }, { secrets });
      this.store.saveDelivery(row, delivery.checkpoint, delivery.done);
    } catch (error) { this.failed(connection, row, error, secrets); }
    return true;
  }
  private failed(connection: PluginMessagingConnection, row: IntegrationReceipt, error: unknown, secrets: ReadonlySet<string>): void {
    const givenUp = this.store.defer(row, true, undefined, failureText(error, secrets));
    if (!givenUp) { console.error(`[integrations] receipt ${row.id} ${row.stage} failed; retry scheduled`); return; }
    console.error(`[integrations] receipt ${row.id} ${row.stage} failed ${row.attempts + 1} times; retries stopped until replayed`);
    try { this.host.gaveUp?.(connection, row); }
    catch { console.error('[integrations] could not report a failed receipt'); }
  }

  stop(): void { this.#controller.abort(new Error('Integration runtime stopped')); }
}

/** One daemon worker, with exclusive claims also protecting against a second worker. */
export function startIntegrationWorker(service: IntegrationService, intervalMs = 1000): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  const tick = () => {
    pending = (async () => {
      for (let count = 0; count < 10 && !stopped; count++) {
        const worked = await Promise.all([service.processInbox(), service.processReply()]);
        if (!worked.some(Boolean)) break;
      }
    })().catch(() => { console.error('[integrations] worker failed; retry scheduled'); }).finally(() => {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    });
  };
  tick();
  return async () => {
    stopped = true; if (timer) clearTimeout(timer);
    service.stop(); await pending;
  };
}
