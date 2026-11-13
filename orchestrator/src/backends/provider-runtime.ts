/**
 * The behaviour a provider is written with, handed to a plugin by the daemon as
 * `ctx.provider.runtime` (`docs/PROVIDERS-SDK.md` § 6.3, decision of 18/10/2026).
 *
 * The first version of the kit shipped this code INSIDE the SDK package, so every
 * plugin carried its own copy: a fix to a codec, to the usage-limit detector or
 * to a session driver reached a plugin only when its author published again. A
 * provider now reaches the daemon's own copy, and a fix made here benefits every
 * installed plugin at once. The package `@rooks/sdk/provider` keeps what has no
 * behaviour — types, the contract's constants, trivial guards — and
 * `@rooks/sdk/testing` builds a stand-in `ctx` that holds a copy of this object
 * for tests run outside the daemon.
 *
 * Rules of this module:
 *  - LEAVES ONLY. Every module reached here is free of the database, the host
 *    adapter, the settings and the license (`sdk-closure.test.ts`), because the
 *    testing kit imports it directly and runs without a daemon.
 *  - Identity never decides. A plugin may hold a different copy of a class (the
 *    testing kit's), so errors are recognised by `code` and drivers by brand.
 *  - Redaction is not here: it needs the secrets only the daemon knows
 *    (`ctx.provider.redact`).
 *  - Every namespace is frozen, so a plugin cannot replace a function other
 *    plugins call. This is hygiene, not containment: a plugin runs in the
 *    daemon's process (`SECURITY.md` § 6.4).
 */

import {
  definitionProblems, dialectFromDefinition, fromLegacy, LineSessionDriver, openProcessSession, openRemoteSession, createLineSplitter,
} from './engine/index.js';
import { mcpScriptPaths } from './mcp-paths.js';
import { declarationProblems, expandDirectory } from './provider-declarations.js';
import { streamJsonSpans } from './stream-json-spans.js';
import { dialectProblems } from './dialect-check.js';
import { encodeJsonLine, parseJsonLine, parseJsonObjectLine } from './codecs/json-lines.js';
import { partialTextDelta, streamJsonUser } from './codecs/stream-json.js';
import {
  assistantDeltaEvent, assistantTextEvent, assistantThinkingEvent, extractInitSessionId, providerRetryEvent,
  providerRetryKind, resultErrorEvent, resultSuccessEvent, systemInitEvent, toolResultEvent, toolUseEvent,
} from './codecs/events.js';
import {
  decodeRpcLine, encodeRpcError, encodeRpcNotification, encodeRpcRequest, encodeRpcResult,
} from './codecs/acp-rpc.js';
import { acpInitEvent, extractAcpSessionId, AcpEventMapper } from './acp/events.js';
import { AcpTransport, AcpTransportError, AcpRpcError } from './acp/transport.js';
import { AcpSessionDriver, RPC_AUTH_REQUIRED } from './acp/driver.js';
import { signInAdvice } from './acp/auth.js';
import { acpTransportOver } from './acp/conversation-transport.js';
import { discoverAcpModels, forgetAcpModels } from './acp/models.js';
import { defineProvider as defineAcpProvider } from './acp/provider.js';
import {
  bestRateLimit, isExhaustedText, isOverloadedEvent, isOverloadedText, isRateLimitText, rateLimitFromEvent,
} from '../rate-limit.js';
import { accountUsage, accountUsageProblems, percentOf, usageWindow } from './account-usage.js';
import { isUsageNotSignedInError, UsageNotSignedInError, USAGE_NOT_SIGNED_IN } from './usage-error.js';
import { credentialValues, parseResumeState, serializeResumeState } from './remote-session.js';
import {
  mcpEnvPairs, serializeAcpMcpServers, serializeCodexMcpToml, serializeGrokMcpToml, serializeMcpJson,
} from './mcp-serialize.js';
import { CODEX_MCP_APPROVAL_TOML } from './codex-mcp-approval.js';
import { claudeAskToolNames } from '../ask-mcp.js';
import { sandboxLevelForPermissionMode } from './permission-models.js';
import { modelIdsFromList, modelIdsFromSessionNew, normalizeDiscoveredModels } from './model-ids.js';
import {
  EXPIRY_MARGIN_MS, exchangeRefreshToken, expiryMs, hhmm, isExpired, serializeRefresh, writeStoreAtomically,
} from './oauth-store.js';

function frozen<T extends object>(namespace: T): Readonly<T> {
  return Object.freeze(namespace);
}

export const providerRuntime = frozen({
  /** The normalised event vocabulary (C10): what the daemon's readers expect. */
  events: frozen({
    systemInitEvent, assistantTextEvent, assistantThinkingEvent, toolUseEvent, toolResultEvent,
    resultSuccessEvent, resultErrorEvent, assistantDeltaEvent, extractInitSessionId,
    providerRetryEvent, providerRetryKind,
  }),
  /** One JSON object per line. */
  jsonLines: frozen({ encodeJsonLine, parseJsonLine, parseJsonObjectLine }),
  /** The stream-json dialect claude, grok and their kin speak. */
  streamJson: frozen({ partialTextDelta, streamJsonUser }),
  /** Declaring Rooks's MCP servers to a CLI, in the text format each one reads. */
  mcp: frozen({
    serializeMcpJson, serializeCodexMcpToml, serializeGrokMcpToml, serializeAcpMcpServers, mcpEnvPairs,
    claudeAskToolNames, CODEX_MCP_APPROVAL_TOML, scriptPaths: mcpScriptPaths,
  }),
  /** The usage-limit detector. The daemon applies it to every provider's stream; a plugin may ask the same question. */
  limits: frozen({
    rateLimitFromEvent, bestRateLimit, isRateLimitText, isExhaustedText, isOverloadedText, isOverloadedEvent,
  }),
  /** Account gauges, and the error that says "not signed in" (recognised by `code`, never `instanceof`). */
  usage: frozen({
    accountUsage, accountUsageProblems, percentOf, usageWindow,
    UsageNotSignedInError, isUsageNotSignedInError, USAGE_NOT_SIGNED_IN,
  }),
  /** Remote sessions: what a driver may keep for a restart, and how to read it back. */
  resume: frozen({ credentialValues, serializeResumeState, parseResumeState }),
  permissions: frozen({ sandboxLevelForPermissionMode }),
  /** Reading the list of models an agent reports. */
  models: frozen({ modelIdsFromList, modelIdsFromSessionNew, normalizeDiscoveredModels }),
  /** The OAuth refresh-token store: exchange, expiry arithmetic, atomic write. */
  oauth: frozen({
    EXPIRY_MARGIN_MS, exchangeRefreshToken, expiryMs, hhmm, isExpired, serializeRefresh, writeStoreAtomically,
  }),
  /** Driving a session over a process's pipes (the daemon owns the process). */
  engine: frozen({
    LineSessionDriver, openProcessSession, openRemoteSession, fromLegacy, dialectFromDefinition, createLineSplitter,
  }),
  /** Trace spans for the stream-json vocabulary: `declares.spans: 'stream-json'` means this. */
  spans: frozen({ streamJsonSpans }),
  /** Reading what a provider declared (folder templates). */
  declarations: frozen({ expandDirectory }),
  /** JSON-RPC as ACP frames it. */
  rpc: frozen({ decodeRpcLine, encodeRpcRequest, encodeRpcNotification, encodeRpcResult, encodeRpcError }),
  /** R4: the Agent Client Protocol client, over pipes the daemon hands the plugin. */
  acp: frozen({
    AcpTransport, AcpTransportError, AcpRpcError, AcpSessionDriver, AcpEventMapper,
    acpInitEvent, extractAcpSessionId, signInAdvice, RPC_AUTH_REQUIRED,
    /** The Agent Client Protocol over a conversation `binary.converse` opened: the daemon owns the process, the provider speaks the protocol. */
    transportOver: acpTransportOver,
    /**
     * The models an ACP agent reports, asked of the agent itself (`session/new`) through a conversation the provider opens
     * (`open: () => ctx.provider.binary.converse(...)`); cached 12 h, because each probe leaves an empty session in the agent's history.
     */
    discoverModels: discoverAcpModels,
    forgetModels: forgetAcpModels,
    /** An ACP agent written as data: `defineProvider(ctx.provider, { id, args, binary })` is a registrable provider. */
    defineProvider: defineAcpProvider,
  }),
  /** The registration checks the daemon applies, to run before shipping. */
  check: frozen({ dialectProblems, definitionProblems, declarationProblems }),
});

export type ProviderRuntime = typeof providerRuntime;
