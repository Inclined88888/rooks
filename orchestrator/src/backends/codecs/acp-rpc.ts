/**
 * JSON-RPC 2.0 as the Agent Client Protocol frames it over stdio: one message
 * per line. This is the codec only — encoding what the client sends, and
 * classifying what the agent sends. Correlating a reply to its request, timeouts
 * and the process's death belong to a transport, and the daemon owns the
 * process; a provider that speaks ACP through `ProviderDefinition` gets pipes
 * and uses these to read and write them.
 *
 * `decodeRpcLine` is total: a banner, a half line, a batch array or a message
 * that fits no shape is `null`, never an exception.
 */

import { parseJsonObjectLine } from './json-lines.js';

export type RpcId = string | number;

export type RpcMessage =
  /** The agent asks us something and waits for `encodeRpcResult` / `encodeRpcError`. */
  | { kind: 'request'; id: RpcId; method: string; params: unknown }
  /** The agent tells us something (`session/update`); no answer. */
  | { kind: 'notification'; method: string; params: unknown }
  /** The agent answers one of our requests. */
  | { kind: 'result'; id: RpcId; result: unknown }
  /** The agent refuses one of our requests. */
  | { kind: 'error'; id: RpcId; code: number; message: string; data?: unknown };

const isId = (v: unknown): v is RpcId => typeof v === 'string' || typeof v === 'number';

export function decodeRpcLine(line: string): RpcMessage | null {
  const rec = parseJsonObjectLine(line.trim());
  if (!rec) return null;
  if (typeof rec.method === 'string') {
    return isId(rec.id)
      ? { kind: 'request', id: rec.id, method: rec.method, params: rec.params }
      : { kind: 'notification', method: rec.method, params: rec.params };
  }
  if (!isId(rec.id)) return null;
  const err = rec.error;
  if (err !== undefined && err !== null) {
    const e = typeof err === 'object' ? err as Record<string, unknown> : {};
    return {
      kind: 'error',
      id: rec.id,
      code: typeof e.code === 'number' ? e.code : -32603,
      message: typeof e.message === 'string' ? e.message : 'agent error',
      ...(e.data !== undefined ? { data: e.data } : {}),
    };
  }
  return 'result' in rec ? { kind: 'result', id: rec.id, result: rec.result } : null;
}

const frame = (message: Record<string, unknown>): string => `${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`;

export function encodeRpcRequest(id: RpcId, method: string, params?: unknown): string {
  return frame({ id, method, params });
}

/** A notification: no id, no answer expected. */
export function encodeRpcNotification(method: string, params?: unknown): string {
  return frame({ method, params });
}

/** Answers a request the agent sent. */
export function encodeRpcResult(id: RpcId, result: unknown): string {
  return frame({ id, result });
}

export function encodeRpcError(id: RpcId, code: number, message: string, data?: unknown): string {
  return frame({ id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}
