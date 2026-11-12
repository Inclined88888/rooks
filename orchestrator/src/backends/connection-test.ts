/**
 * "Test" button of a user-added backend: one minimal call that tells apart
 * "it answers", "the key is refused" and "nothing is there".
 *
 * The call is the provider's model listing: it costs no token and needs no
 * model name, which the user may not know yet. What it returns doubles as the
 * model list of the profile when the endpoint exposes one.
 *
 * On the Anthropic protocol, the same listing may say which effort levels each
 * model honours (`capabilities.effort`, Anthropic's own API — compatible
 * gateways such as B.AI send nothing of the kind). Those levels come back too:
 * they are what the endpoint itself claims, the best source short of a
 * declaration.
 *
 * The key exists in this function's scope and nowhere else. The outcome is an
 * enum, a status code, model ids and level names checked against a strict
 * pattern: no error message, no other part of the body, no header is relayed —
 * a provider (or a proxy in front of it) may echo the credential in any of
 * them. Redirects are NOT followed: the key was given for one host.
 */

import { z } from 'zod';
import type { ProviderProtocol } from './provider-declarations.js';

export type BackendProtocol = ProviderProtocol;

export type ConnectionOutcome =
  /** 2xx: the endpoint answered and accepted the key. */
  | {
    outcome: 'ok'; status: number; models: string[];
    /** Effort levels per model id, for the models whose listing carries
     *  `capabilities.effort` — an empty list when it says effort is not
     *  supported. Absent when no model carries it. */
    reasoningLevels?: Record<string, string[]>;
  }
  /** 401 / 403. */
  | { outcome: 'key-refused'; status: number }
  /** DNS, TCP, TLS or timeout: no HTTP answer at all. */
  | { outcome: 'unreachable' }
  /** An HTTP answer that says nothing about the key (404: no model listing
   *  at this address, 3xx, 5xx). Reported as it is rather than guessed. */
  | { outcome: 'unexpected-status'; status: number };

const TIMEOUT_MS = 8_000;
const MAX_MODELS = 500;

/** Where each protocol lists its models, relative to the base URL the CLI is
 *  given: Anthropic's excludes `/v1`, OpenAI's includes it. */
export function modelsUrl(protocol: BackendProtocol, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return protocol === 'anthropic' ? `${base}/v1/models` : `${base}/models`;
}

function authHeaders(protocol: BackendProtocol, key: string): Record<string, string> {
  if (!key) return {};
  // Anthropic-compatible gateways accept one or the other; the CLI itself
  // sends the bearer form when given ANTHROPIC_AUTH_TOKEN.
  if (protocol === 'anthropic') {
    return { 'x-api-key': key, authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' };
  }
  return { authorization: `Bearer ${key}` };
}

function modelIds(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((row) => (row as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200)
    .slice(0, MAX_MODELS);
}

/** The order levels are offered in. JSON keys come alphabetically
 *  (`high, low, max, medium, xhigh`), which is no order at all. */
const EFFORT_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** A level name ends up as a CLI argument: plain names only. */
const LEVEL_NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_LEVELS = 12;

const effortRowSchema = z.object({
  id: z.string().min(1).max(200),
  capabilities: z.object({
    effort: z.object({ supported: z.boolean() }).catchall(z.unknown()),
  }),
});

function ladderRank(level: string): number {
  const index = EFFORT_LADDER.indexOf(level);
  return index === -1 ? EFFORT_LADDER.length : index;
}

/** `capabilities.effort` of each row that carries one, as ordered level names. */
export function effortLevels(body: unknown): Record<string, string[]> | undefined {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return undefined;
  const out: Record<string, string[]> = {};
  for (const row of data.slice(0, MAX_MODELS)) {
    const parsed = effortRowSchema.safeParse(row);
    if (!parsed.success) continue;
    const { supported, ...levels } = parsed.data.capabilities.effort;
    out[parsed.data.id] = supported
      ? Object.entries(levels)
        .filter(([name, value]) => LEVEL_NAME_RE.test(name) && (value as { supported?: unknown } | null)?.supported === true)
        .map(([name]) => name)
        .sort((a, b) => ladderRank(a) - ladderRank(b) || (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, MAX_LEVELS)
      : [];
  }
  return Object.keys(out).length ? out : undefined;
}

export async function testBackendConnection(
  input: { protocol: BackendProtocol; baseUrl: string; key: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectionOutcome> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(modelsUrl(input.protocol, input.baseUrl), {
      method: 'GET',
      headers: { accept: 'application/json', ...authHeaders(input.protocol, input.key) },
      redirect: 'manual',
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) return { outcome: 'key-refused', status: res.status };
    if (!res.ok) return { outcome: 'unexpected-status', status: res.status };
    let models: string[] = [];
    let reasoningLevels: Record<string, string[]> | undefined;
    try {
      const body: unknown = await res.json();
      models = modelIds(body);
      if (input.protocol === 'anthropic') reasoningLevels = effortLevels(body);
    } catch {
      // A 2xx that is not JSON still proves the endpoint and the key.
    }
    return { outcome: 'ok', status: res.status, models, ...(reasoningLevels ? { reasoningLevels } : {}) };
  } catch {
    // Deliberately blind: the error of a fetch carries the request it failed.
    return { outcome: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
