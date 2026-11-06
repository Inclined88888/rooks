/** Public plugin types, extracted from the host implementations (TODO #512). */
/**
 * Integration contracts and public facades (apiVersion 3). Exporting these
 * types enables no capability; runtime operations require manifest permissions.
 * Keep this module free of daemon, database and validation-library imports.
 */
export type PluginJsonValue = null | boolean | number | string | PluginJsonValue[] | PluginJsonObject;

export type PluginJsonObject = { [key: string]: PluginJsonValue };

/** Structural contract: a Zod schema or a small handwritten parser can implement it. */
export type PluginIntegrationSchema = { parse(value: unknown): PluginJsonValue };

export type PluginIntegrationDefinition = {
  /** Local name, e.g. `issue.created`. The host adds the plugin id and version. */
  name: string;
  version: number;
};

export type PluginIntegrationDisposer = () => void | Promise<void>;

/** Resolved by the host, never accepted as authority from an inbound payload. */
export type PluginIntegrationIdentity = { readonly ownerUserId: string };

/** Stored connection configuration contains secret references, not credentials. */
export type PluginConnection = {
  readonly id: string;
  readonly pluginId: string;
  /** Qualified transport registration id: `<plugin>:<name>@<version>`. */
  readonly transport: string;
  readonly identity: PluginIntegrationIdentity;
  readonly config: PluginJsonObject;
  readonly secretRefs: Readonly<Record<string, string>>;
};

export type PluginConnectionInput = {
  transport: string;
  agent: string;
  config?: PluginJsonObject;
  secretRefs?: Record<string, string>;
};

export type PluginMessagingConnection = PluginConnection & {
  readonly agent: string;
  readonly enabled: boolean;
  readonly revision: number;
};

export type PluginConnectionPatch = {
  agent?: string;
  config?: PluginJsonObject;
  secretRefs?: Record<string, string>;
  enabled?: boolean;
};

export type PluginBusinessEventDefinition = PluginIntegrationDefinition & {
  payloadSchema: PluginIntegrationSchema;
};

export type PluginBusinessEventInput = {
  /** Stable external id, reused on retries. */
  id: string;
  payload: PluginJsonValue;
  occurredAt?: number;
};

export type PluginBusinessEvent = PluginBusinessEventInput & {
  /** Qualified event registration id, including its version. */
  type: string;
  occurredAt: number;
  identity: PluginIntegrationIdentity;
  connectionId?: string;
};

export type PluginIntegrationCallContext = {
  readonly signal: AbortSignal;
  readonly identity: PluginIntegrationIdentity;
};

export type PluginWorkflowTriggerContext = PluginIntegrationCallContext & {
  readonly workflowId: string;
  readonly nodeId: string;
  readonly config: PluginJsonValue;
  /** The host stamps the workflow identity and enforces the overlap policy. */
  emit(event: PluginBusinessEventInput): Promise<void>;
};

export type PluginWorkflowTriggerDefinition = PluginIntegrationDefinition & {
  configSchema: PluginIntegrationSchema;
  /** Bounds setup, not the lifetime of the armed trigger. */
  timeoutMs?: number;
  start(context: PluginWorkflowTriggerContext): PluginIntegrationDisposer | Promise<PluginIntegrationDisposer>;
};

export type PluginWorkflowExecutorContext = PluginIntegrationCallContext & {
  readonly runId: string;
  readonly nodeId: string;
  readonly config: PluginJsonValue;
  readonly input: PluginJsonValue;
  /** Stable for retries of this node within this run; a new pass of a loop edge is a new operation with its own key. */
  readonly idempotencyKey: string;
};

export type PluginWorkflowExecutorResult = { output: PluginJsonValue; port: string };

export type PluginWorkflowExecutorDefinition = PluginIntegrationDefinition & {
  configSchema: PluginIntegrationSchema;
  outputPorts: readonly string[];
  timeoutMs?: number;
  execute(context: PluginWorkflowExecutorContext): PluginWorkflowExecutorResult | Promise<PluginWorkflowExecutorResult>;
};

export type PluginTransportContext = PluginIntegrationCallContext & {
  readonly connection: PluginConnection;
  /** Resolves only a secret granted to this plugin and declared by the connection. */
  secret(name: string): Promise<string | undefined>;
};

export type PluginTransportRequest = {
  /** Exact bytes: authenticate before decoding or returning a message. */
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
};

export type PluginInboundMessage = {
  /** Stable authenticated provider id, used for durable deduplication. */
  externalId: string;
  text: string;
  /** JSON persisted for the response; must not contain credentials. */
  replyContext: PluginJsonValue;
};

export type PluginTransportReply = {
  text: string;
  replyContext: PluginJsonValue;
  idempotencyKey: string;
  /** Persisted progress for transports that send multiple fragments. */
  checkpoint: PluginJsonValue;
};

export type PluginTransportDelivery = { done: boolean; checkpoint: PluginJsonValue };

export type PluginTransportDefinition = PluginIntegrationDefinition & {
  configSchema: PluginIntegrationSchema;
  timeoutMs?: number;
  /** Throw on failed authentication; null acknowledges an authenticated ignored event. */
  receive(context: PluginTransportContext, request: PluginTransportRequest): PluginInboundMessage | null | Promise<PluginInboundMessage | null>;
  /** One bounded send step. The host persists its checkpoint before continuing. */
  send(context: PluginTransportContext, reply: PluginTransportReply): PluginTransportDelivery | Promise<PluginTransportDelivery>;
};

/** Additive public facades, available from apiVersion 3. */
export type PluginBusinessEvents = {
  register(definition: PluginBusinessEventDefinition): () => void;
  publish(type: string, input: PluginBusinessEventInput, options?: { connectionId?: string }): Promise<string[]>;
};

export type PluginWorkflows = {
  registerTrigger(definition: PluginWorkflowTriggerDefinition): () => void;
  registerExecutor(definition: PluginWorkflowExecutorDefinition): () => void;
};

export type PluginTransports = { register(definition: PluginTransportDefinition): () => void };

export type PluginConnections = {
  create(input: PluginConnectionInput): Promise<PluginMessagingConnection>;
  get(id: string): Promise<PluginMessagingConnection | undefined>;
  list(): Promise<PluginMessagingConnection[]>;
  update(id: string, patch: PluginConnectionPatch): Promise<PluginMessagingConnection>;
  /** Relative daemon path; the transport authenticates requests to this endpoint. */
  inboundPath(id: string): Promise<string>;
  /**
   * Declare a connection type users fill in themselves (URL + config + vault
   * secrets), with no messaging transport. `connections:register`, apiVersion 7.
   */
  registerType(definition: PluginConnectionTypeDefinition): () => void;
  /**
   * The connections of this plugin's types that one account registered.
   * `connections:users:read`; inside a request, only the caller's own.
   */
  forUser(ownerUserId: string): Promise<PluginUserConnection[]>;
  /** A secret of an approved, enabled connection of that account, or `undefined`. */
  userSecret(ownerUserId: string, connectionId: string, name: string): Promise<string | undefined>;
  /**
   * Read-only follow-up of one of this plugin's messaging connections: queue
   * counts and the receipts in trouble. `connections:read`, apiVersion 14. Only
   * the current owner's connection (the plugin's own in a job); another one
   * reads as "not found". Replaying stays in Timon's settings.
   */
  receipts(connectionId: string, options?: PluginConnectionReceiptsOptions): Promise<PluginConnectionReceipts>;
};

export type PluginIntegrationReceiptStatus = 'failed' | 'retrying';

export type PluginConnectionReceiptsOptions = {
  /** Only one kind of trouble. Absent: both, failed first. */
  status?: PluginIntegrationReceiptStatus;
  /** 1 to 200, default 50. */
  limit?: number;
};

/** Receipts not delivered yet: waiting their first try, retrying, out of retries. */
export type PluginIntegrationReceiptCounts = { readonly queued: number; readonly retrying: number; readonly failed: number };

/**
 * A receipt as its owner may see it. Never the raw message, the reply, the
 * reply context or the delivery checkpoint: only a masked text preview.
 */
export type PluginIntegrationReceipt = {
  readonly id: string;
  /** The provider's id, with anything that looks like a credential masked. */
  readonly externalId: string;
  /** `inbox`: the mission is not created yet; `reply`: the answer is not delivered yet. */
  readonly stage: 'inbox' | 'reply';
  readonly status: PluginIntegrationReceiptStatus;
  readonly attempts: number;
  /** Scrubbed reason of the last failure. */
  readonly lastError: string | null;
  readonly missionId: string | null;
  /** First 200 characters of the message text, masked. */
  readonly preview: string;
  readonly createdAt: number;
  /** Next retry while retrying; `null` once failed. */
  readonly nextAt: number | null;
  readonly failedAt: number | null;
};

export type PluginConnectionReceipts = {
  readonly counts: PluginIntegrationReceiptCounts;
  /** Newest first, failed ones before retrying ones. */
  readonly receipts: PluginIntegrationReceipt[];
};

/** A field the generic connection form asks for; the value lands in `config`. */
export type PluginConnectionField = { key: string; label: string; required?: boolean; placeholder?: string };

/** A secret the generic form asks for. The value goes to the vault, never to `config`. */
export type PluginConnectionSecretField = { name: string; label: string; required?: boolean };

export type PluginConnectionApproval = 'pending' | 'approved' | 'rejected';

/** A per-user connection (apiVersion 7). Holds secret NAMES, never their values. */
export type PluginUserConnection = {
  readonly id: string;
  readonly pluginId: string;
  /** Qualified type id: `<plugin>:<name>@<version>`. */
  readonly type: string;
  readonly identity: PluginIntegrationIdentity;
  readonly label: string;
  readonly url: string;
  /** Loopback, LAN and Tailscale addresses are refused unless this is true. */
  readonly allowPrivateNetwork: boolean;
  readonly config: PluginJsonObject;
  /** Names of the secrets deposited for this connection. */
  readonly secrets: readonly string[];
  /** Only an approved connection opens its origin to `ctx.fetch`. */
  readonly approval: PluginConnectionApproval;
  readonly enabled: boolean;
  readonly revision: number;
};

export type PluginConnectionTestContext = PluginIntegrationCallContext & {
  readonly connection: PluginUserConnection;
  secret(name: string): Promise<string | undefined>;
  /** `fetch` limited to this connection's origin, through the daemon's SSRF guard. */
  fetch: typeof globalThis.fetch;
};

export type PluginConnectionTestResult = { ok: boolean; message?: string };

export type PluginConnectionTypeDefinition = PluginIntegrationDefinition & {
  label: string;
  description?: string;
  /** Validates `config`; a Zod schema fits. */
  configSchema: PluginIntegrationSchema;
  fields?: readonly PluginConnectionField[];
  secrets?: readonly PluginConnectionSecretField[];
  timeoutMs?: number;
  /** The "Test" button. Absent: the daemon checks the URL answers over HTTP. */
  test?(context: PluginConnectionTestContext): PluginConnectionTestResult | Promise<PluginConnectionTestResult>;
};
