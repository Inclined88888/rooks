/**
 * `broker_spec` — how the daemon uses a secret in place of the agent
 * (`docs/SECRETS-VAULT.md` §6.2).
 *
 * Pure by construction, like `resolve.ts`: no I/O, no database, no network.
 * What lives here is the part that decides *where a token is allowed to go*,
 * and that part must be exercisable without a daemon, a mission or a socket.
 *
 * Two types at this delivery: `http` (the daemon performs the request) and
 * `git` (a credential helper answers git's protocol). Both are parsed from the
 * JSON stored in `secrets.broker_spec`, and both are validated at the WRITE —
 * an invalid spec accepted at rest would only surface at call time, as a
 * refusal nobody can explain.
 *
 * Honesty, per §6.3: the broker protects the VALUE, not the USAGE. An agent
 * entitled to a broker identity will never see the token, but nothing here
 * stops it from asking for ten thousand calls. That is what the access journal
 * (§8) is for; quotas are explicitly out of scope for this delivery.
 */

/** Where an `http` broker injects the secret into the outgoing request. */
export interface BrokerHttpInjection {
  /** Only headers at this delivery — a query parameter would end up in logs. */
  kind: 'header';
  name: string;
  /** `{{value}}` is substituted with the plaintext, e.g. `Bearer {{value}}`. */
  template: string;
}

export interface BrokerHttpSpec {
  type: 'http';
  /** Allowlist of hostnames. MANDATORY and non-empty — see `isHostAllowed`. */
  hosts: string[];
  inject: BrokerHttpInjection;
}

export interface BrokerGitSpec {
  type: 'git';
  /** Same allowlist semantics: the helper answers for these hosts only. */
  hosts: string[];
  /** Username handed to git; the password is always the secret. */
  username?: string;
}

export type BrokerSpec = BrokerHttpSpec | BrokerGitSpec;

export const BROKER_TYPES: readonly BrokerSpec['type'][] = Object.freeze(['http', 'git']);

/** The placeholder substituted with the plaintext, at the last possible moment. */
export const VALUE_PLACEHOLDER = '{{value}}';

/** A rejected spec or a rejected call. Typed so callers can answer 400 vs 500. */
export class BrokerSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokerSpecError';
  }
}

/**
 * A hostname, as strict as the allowlist has to be: letters, digits, hyphen and
 * dots, no scheme, no port, no userinfo, no path. Anything richer than this is
 * a way of smuggling a second host into the field.
 */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Header names are tokens (RFC 7230); a space or a colon would forge a header. */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * Does `hostname` fall under the allowlist?
 *
 * Exact match, or a subdomain — never a substring. `api.github.com.evil.example`
 * ends WITH `github.com` as a string but is a different registrable domain, and
 * the `'.' + allowed` form is precisely what tells the two apart. The same
 * comparison also rejects `evilgithub.com` against `github.com`.
 *
 * The list is required to be non-empty by `parseBrokerSpec`, so an empty list
 * reaching here means the caller bypassed validation: it denies, it does not
 * "allow everything".
 */
export function isHostAllowed(hostname: string, hosts: readonly string[]): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return false;
  return hosts.some((raw) => {
    const allowed = raw.trim().toLowerCase();
    if (!allowed) return false;
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

function parseHosts(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    // Structural, not a setting (§6.2): without an allowlist the broker is an
    // exfiltration machine — an agent would only have to ask for a GET on
    // `https://evil.example` with the `github` identity for the daemon to ship
    // the token there itself.
    throw new BrokerSpecError('broker: `hosts` is required and must not be empty');
  }
  const hosts: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') throw new BrokerSpecError('broker: `hosts` must contain strings');
    const host = entry.trim().toLowerCase();
    if (!HOSTNAME_RE.test(host)) throw new BrokerSpecError(`broker: invalid host \`${entry}\``);
    hosts.push(host);
  }
  return hosts;
}

function parseHttpInjection(raw: unknown): BrokerHttpInjection {
  const obj = raw as Record<string, unknown> | null | undefined;
  if (!obj || typeof obj !== 'object') throw new BrokerSpecError('broker http: `inject` is required');
  if (obj['kind'] !== 'header') throw new BrokerSpecError('broker http: only `inject.kind = "header"` is supported');
  const name = obj['name'];
  if (typeof name !== 'string' || !HEADER_NAME_RE.test(name)) {
    throw new BrokerSpecError('broker http: `inject.name` must be a header name');
  }
  const template = obj['template'];
  if (typeof template !== 'string' || !template.includes(VALUE_PLACEHOLDER)) {
    throw new BrokerSpecError(`broker http: \`inject.template\` must contain ${VALUE_PLACEHOLDER}`);
  }
  return { kind: 'header', name, template };
}

/**
 * Parse and validate a spec. Accepts the object or its JSON text, because the
 * database stores text and the API receives an object.
 *
 * Throws `BrokerSpecError` on anything invalid: this is called at the write, so
 * a rejection here is a 400 with a readable reason, never a silent store.
 */
export function parseBrokerSpec(input: unknown): BrokerSpec {
  let raw: unknown = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new BrokerSpecError('broker: `broker_spec` is not valid JSON');
    }
  }
  const obj = raw as Record<string, unknown> | null | undefined;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new BrokerSpecError('broker: `broker_spec` must be an object');
  }
  const type = obj['type'];
  if (type === 'http') {
    return { type: 'http', hosts: parseHosts(obj['hosts']), inject: parseHttpInjection(obj['inject']) };
  }
  if (type === 'git') {
    const username = obj['username'];
    if (username !== undefined && typeof username !== 'string') {
      throw new BrokerSpecError('broker git: `username` must be a string');
    }
    const spec: BrokerGitSpec = { type: 'git', hosts: parseHosts(obj['hosts']) };
    if (username !== undefined) spec.username = username;
    return spec;
  }
  throw new BrokerSpecError(`broker: unknown type \`${String(type)}\` (expected ${BROKER_TYPES.join(' or ')})`);
}

/**
 * The header value for an `http` broker, with the plaintext substituted.
 *
 * The only place in the codebase where the value is composed into something
 * outbound. Kept to one line so it stays obvious that nothing else — no log, no
 * response, no error message — is built from `value`.
 */
export function renderInjectedHeader(spec: BrokerHttpSpec, value: string): { name: string; value: string } {
  return { name: spec.inject.name, value: spec.inject.template.split(VALUE_PLACEHOLDER).join(value) };
}
