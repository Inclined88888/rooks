/**
 * The broker — the daemon acts, the agent never holds the value
 * (`docs/SECRETS-VAULT.md` §6.2, §6.3, §8).
 *
 * An agent does not execute a call against a brokered identity: it asks for
 * one. It receives the status and the body, never the token, because the token
 * never enters its address space. Everything that decides *whether* the daemon
 * acts lives here, and everything it decides is journalled.
 *
 * What this buys, stated plainly so nobody over-trusts it (§6.3): the broker
 * protects the VALUE, not the USAGE. An agent entitled to the `github`
 * identity will never see the token, but nothing stops it from asking for ten
 * thousand calls with it. That is what the access journal is for; quotas are
 * out of scope for this delivery. And per §2, none of this defends against a
 * hostile agent — it defends against the accident: the token echoed into a
 * report, committed in a worktree, carried out in a transcript.
 */
import { dbApi, type SecretWithGrants } from '../db.js';
import { isSealed, open } from './box.js';
import { requireMasterKey } from './key.js';
import { isHostAllowed, parseBrokerSpec, renderInjectedHeader, type BrokerHttpSpec } from './broker-spec.js';
import { resolveBrokerSecret } from './resolve.js';
import { boundRequestedSecret, type BoundSecret } from './requests.js';
import type { BrokerHttpResult } from '../plugins/contract/secrets.js';
export type { BrokerHttpResult } from '../plugins/contract/secrets.js';

/** Why a call was refused. Maps to an HTTP status at the route boundary. */
export type BrokerDenialCode =
  | 'unknown-identity'   // no brokered secret carries this name at all
  | 'no-grant'           // one exists, this mission is not entitled to it
  | 'bad-spec'           // stored spec unusable (should be impossible since S.8: validated at the write)
  | 'wrong-type'         // a `git` identity asked to serve an HTTP call
  | 'host-denied'        // outside the allowlist
  | 'policy-denied'      // inside it, but outside the caller's own network ceiling (a plugin's `pluginPolicy.http`)
  | 'bad-request';       // malformed method or path

/**
 * A refusal. The message is written by us and never interpolates a value —
 * an error string is the easiest place in a codebase to leak a secret.
 */
export class BrokerDeniedError extends Error {
  constructor(readonly code: BrokerDenialCode, message: string) {
    super(message);
    this.name = 'BrokerDeniedError';
  }
}

/** Who is asking. Resolved server-side from the mission, never from a header. */
export interface BrokerCaller {
  missionId?: string | null;
  agent?: string | null;
  project?: string | null;
  /**
   * The caller's own network ceiling, applied to the FINAL URL the broker built,
   * before the value is opened: the refusal reason, or `null` to go on. A plugin
   * passes `pluginPolicy.http` here (TODO #531, 4-B), so a brokered identity is
   * not a way round the operator's allowlist. Absent for agents: their calls
   * are bounded by the identity's hosts alone, as before.
   */
  allowTarget?: (url: URL) => string | null;
}

export interface BrokerHttpRequest {
  /** Secret name, e.g. `GITHUB_TOKEN` — the identity, not the value. */
  identity: string;
  method?: string;
  /** Absolute path on the target host, always starting with `/`. */
  path: string;
  /** One of `spec.hosts`; defaults to the first. Never a free-form URL (see below). */
  host?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Seams for tests: no network, no master key, no database. */
export interface BrokerDeps {
  listSecrets?: () => SecretWithGrants[];
  openValue?: (secret: SecretWithGrants) => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** The value the calling mission was given under this name (`secret_request`), if any. */
  boundSecret?: (missionId: string | null | undefined, name: string) => BoundSecret | null;
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

/** A response big enough to be useful, small enough not to fill a context window.
 *  Exported so the straddling-leak test pins the real cutoff, not a copy. */
export const MAX_BODY = 256 * 1024;

/** What a redacted value becomes in anything handed back to the agent. */
const MASK = '***';

function defaultOpenValue(secret: SecretWithGrants): string {
  // A row predating the vault (§10, lazy migration) is stored in clear; it is
  // usable as-is. Anything sealed goes through the box, with the AAD that binds
  // it to this row — a blob copied from another secret will not open (§4.1).
  if (!isSealed(secret.value_enc)) return secret.value_enc;
  return open(secret.value_enc, requireMasterKey(), { secretId: secret.id, name: secret.name });
}

/**
 * Replace every occurrence of the value, whatever its length.
 *
 * Deliberately WITHOUT §7's 12-character floor: that threshold exists to keep
 * transcripts readable when a short secret would collide with ordinary prose.
 * Here the text is a response the daemon fetched under the credential, and a
 * token echoed back is the exact accident §6.3 warns about — a shredded body is
 * a far smaller problem than a leaked value.
 */
function scrub(text: string, value: string): string {
  if (!value) return text;
  return text.split(value).join(MASK);
}

/**
 * Execute an HTTP call on behalf of an agent, under a brokered identity.
 *
 * Order matters: identity → grant → spec → host → caller's ceiling → decrypt →
 * call. Each refusal before the call is journalled with its reason, so `denied`
 * lines say *why* without ever saying *what*.
 */
export async function brokerHttpCall(
  request: BrokerHttpRequest,
  caller: BrokerCaller,
  deps: BrokerDeps = {},
): Promise<BrokerHttpResult> {
  const listSecrets = deps.listSecrets ?? (() => dbApi.listSecrets());
  const openValue = deps.openValue ?? defaultOpenValue;
  const doFetch = deps.fetchImpl ?? fetch;
  const at = deps.now?.() ?? Date.now();

  const all = listSecrets();
  // A value the user typed for THIS mission (`secret_request`) is the most
  // specific answer to its name: it carries no grant, the request row is its
  // only door, and the mission id behind it comes from the caller's token.
  const bound = (deps.boundSecret ?? boundRequestedSecret)(caller.missionId, request.identity);
  const boundRow = bound ? all.find((s) => s.id === bound.secretId) : undefined;
  if (boundRow && boundRow.mode !== 'broker') {
    dbApi.recordSecretAccess({
      secret_id: boundRow.id, name: request.identity, mission_id: caller.missionId ?? null,
      agent: caller.agent ?? null, kind: 'broker', outcome: 'denied', detail: 'requested without hosts', at,
    });
    const where = bound?.browserOrigin ? `the browser at ${bound.browserOrigin}` : 'your environment';
    throw new BrokerDeniedError('wrong-type', `\`${request.identity}\` was provided for ${where}, not for API calls: ask for it again with \`hosts\` to use it here`);
  }
  const named = all.filter((s) => s.name === request.identity && s.mode === 'broker');
  if (named.length === 0) {
    // Nothing to journal against: there is no secret here, so there is no
    // secret_id. Writing a row would mean inventing one.
    throw new BrokerDeniedError('unknown-identity', `no brokered identity named \`${request.identity}\``);
  }

  const journal = (secretId: string, outcome: 'ok' | 'denied', detail?: string) => {
    dbApi.recordSecretAccess({
      secret_id: secretId,
      name: request.identity,
      mission_id: caller.missionId ?? null,
      agent: caller.agent ?? null,
      kind: 'broker',
      outcome,
      detail: detail ?? null,
      at,
    });
  };

  const resolved = boundRow ? { id: boundRow.id } : resolveBrokerSecret({
    name: request.identity,
    agent: caller.agent,
    project: caller.project,
    secrets: all,
  });
  if (!resolved) {
    // The identity exists but this mission is not entitled to it: that IS an
    // access attempt on a known secret, and it belongs in its journal.
    journal(mostRecent(named).id, 'denied', 'no grant for this mission');
    throw new BrokerDeniedError('no-grant', `no grant on \`${request.identity}\` for this mission`);
  }

  const secret = named.find((s) => s.id === resolved.id)!;

  let spec;
  try {
    spec = parseBrokerSpec(secret.broker_spec ?? '');
  } catch (e) {
    journal(secret.id, 'denied', 'unusable broker_spec');
    throw new BrokerDeniedError('bad-spec', `unusable broker_spec on \`${request.identity}\`: ${(e as Error).message}`);
  }
  if (spec.type !== 'http') {
    journal(secret.id, 'denied', `wrong broker type: ${spec.type}`);
    throw new BrokerDeniedError('wrong-type', `\`${request.identity}\` is a ${spec.type} identity, not http`);
  }

  const method = (request.method ?? 'GET').toUpperCase();
  if (!METHODS.has(method)) {
    journal(secret.id, 'denied', `unsupported method ${method.slice(0, 16)}`);
    throw new BrokerDeniedError('bad-request', `unsupported method \`${method}\``);
  }

  const url = buildUrl(request, spec, (detail, code) => {
    journal(secret.id, 'denied', detail);
    throw new BrokerDeniedError(code, detail);
  });

  // Last check before the value exists in memory: the grant, the identity's
  // hosts and the caller's ceiling must ALL agree — an intersection, not a union.
  const refused = caller.allowTarget?.(url) ?? null;
  if (refused !== null) {
    journal(secret.id, 'denied', `policy: ${url.hostname.slice(0, 64)}`);
    throw new BrokerDeniedError('policy-denied', refused);
  }

  let value: string;
  try {
    value = openValue(secret);
  } catch {
    // Constant detail: the opener's message may have been built out of the
    // ciphertext or, worse, the plaintext — neither belongs in the journal.
    journal(secret.id, 'denied', 'decrypt-failed');
    throw new BrokerDeniedError('bad-spec', `identity \`${request.identity}\` could not be opened`);
  }
  const header = renderInjectedHeader(spec, value);
  const headers = new Headers();
  for (const [key, raw] of Object.entries(request.headers ?? {})) {
    // The agent may shape its request, but not the injection: an agent-supplied
    // Authorization would either fight the broker or advertise what it expects.
    if (key.toLowerCase() === header.name.toLowerCase()) continue;
    headers.set(key, raw);
  }
  headers.set(header.name, header.value);
  const payload = request.body === undefined || method === 'GET' || method === 'HEAD'
    ? undefined
    : typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
  if (payload !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');

  // A `once` value's one use is CLAIMED here, before it is handed to the
  // network stack: the fetch below is awaited, and a second call that read the
  // same binding meanwhile would otherwise carry the value out too. The claim
  // is one conditional update — the loser is refused, nothing sent. Refusals
  // above (host, policy, decrypt) claim nothing. The erase follows the call,
  // whatever its outcome: a body that cannot be read, a reset after the
  // request was written, still mean the value went out.
  const isBound = Boolean(boundRow && secret.id === boundRow.id);
  if (isBound && bound && !bound.claim()) {
    journal(secret.id, 'denied', 'once: already used');
    throw new BrokerDeniedError('unknown-identity', `\`${request.identity}\` was given for one use, already spent: ask for it again with \`secret_request\``);
  }
  const spend = (): void => { if (isBound) bound?.used(`broker ${url.hostname}`); };
  let response: Response;
  try {
    response = await doFetch(url.toString(), {
      method,
      headers,
      body: payload,
      // NOT `follow`. `fetch` only strips Authorization/Cookie on a cross-origin
      // redirect, and `inject.name` is arbitrary — an allowlisted host answering
      // `302 Location: https://evil.example` would otherwise have the daemon
      // carry the token there itself, with the allowlist check already passed.
      // The 3xx goes back to the agent, which may ask again for the new target
      // if (and only if) that target is allowlisted too.
      redirect: 'manual',
    });
  } catch (e) {
    spend();
    journal(secret.id, 'denied', 'transport error');
    // The message can only contain what we built plus the host — never `value`.
    throw new BrokerDeniedError('bad-request', `call to ${url.hostname} failed: ${scrub((e as Error).message, value)}`);
  }
  spend();

  let raw: string;
  try {
    raw = await response.text();
  } catch {
    // Same rule as decrypt: a stream error string can echo bytes we sent,
    // value included. The journal records THAT the read failed, never WHY
    // in the callee's words.
    journal(secret.id, 'denied', 'response-unreadable');
    throw new BrokerDeniedError('bad-spec', `call to ${url.hostname} returned an unreadable body`);
  }
  // Scrub FIRST, then cap. Slicing the raw body at MAX_BODY and scrubbing
  // after would leak the prefix of a value that straddles the cutoff —
  // `split(value)` cannot match a fragment, so the first N characters of
  // the token would ride back to the agent in the truncated body.
  const safeBody = scrub(raw, value);
  journal(secret.id, 'ok', `${method} ${url.hostname} → ${response.status}`);
  // Only the status and the body go back: response headers could echo the
  // credential (a `Set-Cookie` derived from it, a debug reflection).
  return { status: response.status, body: safeBody.slice(0, MAX_BODY), host: url.hostname };
}

/** What a git credential helper answers with. The password IS the value — see
 *  the honesty note on `brokerGitCredential`. */
export interface BrokerGitCredential {
  username: string;
  password: string;
}

/**
 * Answer git's credential protocol for `host` (§6.2, `git` broker type).
 *
 * Unlike the HTTP broker, this one HANDS OVER the value — to git, through a
 * helper process git itself spawned. What it buys is real but narrower: the
 * token appears in no command line, in no remote URL, in no environment
 * variable, and in nothing the agent writes. What it does NOT buy: an agent can
 * run `timon git-credential` itself and read the answer. That is deliberate and
 * consistent with §2 — the vault defends against the accident (a token pasted
 * in a report, committed in a worktree, carried in a transcript), never against
 * a hostile agent, which has Bash and the network anyway.
 *
 * Journal rule: git probes every helper for every remote. A probe that matches
 * no secret is not an access attempt on any secret — there is no `secret_id` to
 * record, so no row is written. Only a host that DOES match a git identity the
 * caller is not entitled to produces a `denied` line. Invariant §12.8 is about
 * calls on a secret, not about probes into the void.
 */
export function brokerGitCredential(
  host: string,
  caller: BrokerCaller,
  deps: BrokerDeps = {},
): BrokerGitCredential {
  const listSecrets = deps.listSecrets ?? (() => dbApi.listSecrets());
  const openValue = deps.openValue ?? defaultOpenValue;
  const at = deps.now?.() ?? Date.now();

  const all = listSecrets();
  const matching = all.filter((secret) => {
    if (secret.mode !== 'broker') return false;
    try {
      const spec = parseBrokerSpec(secret.broker_spec ?? '');
      return spec.type === 'git' && isHostAllowed(host, spec.hosts);
    } catch {
      return false; // an unusable spec grants nothing, and says nothing about this host
    }
  });
  if (matching.length === 0) {
    throw new BrokerDeniedError('unknown-identity', `no git identity for ${host}`);
  }

  // Same grants and same precedence as everywhere else; the name is the one
  // carried by the matching rows, resolved one by one so several git identities
  // on distinct hosts do not shadow each other.
  for (const name of new Set(matching.map((s) => s.name))) {
    const resolved = resolveBrokerSecret({ name, agent: caller.agent, project: caller.project, secrets: all });
    const secret = resolved ? matching.find((s) => s.id === resolved.id) : undefined;
    if (!secret) continue;
    const spec = parseBrokerSpec(secret.broker_spec ?? '');
    let password: string;
    try {
      password = openValue(secret);
    } catch {
      dbApi.recordSecretAccess({
        secret_id: secret.id,
        name: secret.name,
        mission_id: caller.missionId ?? null,
        agent: caller.agent ?? null,
        kind: 'broker',
        outcome: 'denied',
        detail: 'decrypt-failed',
        at,
      });
      throw new BrokerDeniedError('bad-spec', `git identity for ${host} could not be opened`);
    }
    dbApi.recordSecretAccess({
      secret_id: secret.id,
      name: secret.name,
      mission_id: caller.missionId ?? null,
      agent: caller.agent ?? null,
      kind: 'broker',
      outcome: 'ok',
      detail: `git credential for ${host}`,
      at,
    });
    return {
      username: (spec.type === 'git' && spec.username) || secret.name.toLowerCase(),
      password,
    };
  }

  dbApi.recordSecretAccess({
    secret_id: mostRecent(matching).id,
    name: mostRecent(matching).name,
    mission_id: caller.missionId ?? null,
    agent: caller.agent ?? null,
    kind: 'broker',
    outcome: 'denied',
    detail: `no grant for git credential on ${host}`,
    at,
  });
  throw new BrokerDeniedError('no-grant', `no grant on a git identity for ${host}`);
}

/** The most recently written of several rows — only used to pick which journal
 *  a refusal belongs in, never to decide access. */
function mostRecent(rows: SecretWithGrants[]): SecretWithGrants {
  return rows.reduce((best, row) => (row.updated_at > best.updated_at ? row : best), rows[0]!);
}

/**
 * Build the target URL from a host taken out of the allowlist and a path.
 *
 * Deliberately NOT `new URL(path, base)`: `new URL('//evil.example/x',
 * 'https://api.github.com')` resolves to `evil.example`, and the allowlist
 * would already have been checked. Concatenating gives
 * `https://api.github.com//evil.example/x`, which stays on the allowed host.
 * The URL is then re-parsed and the hostname re-checked, so a path that
 * smuggles anything past the concatenation still has to survive the allowlist.
 */
function buildUrl(
  request: BrokerHttpRequest,
  spec: BrokerHttpSpec,
  deny: (detail: string, code: BrokerDenialCode) => never,
): URL {
  const path = request.path ?? '';
  if (!path.startsWith('/')) deny('path must start with /', 'bad-request');
  const host = (request.host ?? spec.hosts[0] ?? '').trim().toLowerCase();
  if (!isHostAllowed(host, spec.hosts)) deny(`host not allowed: ${host.slice(0, 64)}`, 'host-denied');

  let url: URL;
  try {
    url = new URL(`https://${host}${path}`);
  } catch {
    return deny('malformed path', 'bad-request');
  }
  // Belt and braces: only https, and the parsed hostname must still be allowed.
  if (url.protocol !== 'https:') deny('only https is brokered', 'host-denied');
  if (url.username || url.password) deny('credentials in URL', 'bad-request');
  if (!isHostAllowed(url.hostname, spec.hosts)) deny(`host not allowed: ${url.hostname.slice(0, 64)}`, 'host-denied');
  return url;
}
