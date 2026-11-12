/**
 * The `http` workflow node (PRD §5.2, §13.4): one bounded outbound request.
 *
 * The URL is typed by whoever authors the workflow, so it goes through the
 * same SSRF guard as a plugin connection (`plugins/net-guard.ts`): resolved
 * addresses judged at every hop, link-local and metadata never reachable,
 * loopback / LAN / Tailscale only when the node says `allowPrivateNetwork`.
 *
 * The run acts as the workflow's OWNER, so the owner's rights decide, re-read
 * at every run (a revoked grant stops the next run, not the next publish):
 * `http:outbound` to call out at all, superadmin to reach a private address —
 * the daemon host's network position is not a right an ordinary account holds.
 */
import { z } from 'zod';
import { dbApi } from '../../db.js';
import { DestinationRefusedError, guardedFetch } from '../../plugins/net-guard.js';
import { redactDeep } from '../../secrets/redact.js';
import { userAllows } from '../../users/permissions.js';
import { interpolateTemplate } from '../template.js';

export const HTTP_NODE_PERMISSION = 'http:outbound';
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
/** Ceiling of a response body: a node output lands in the run context and its span. */
export const HTTP_MAX_RESPONSE_BYTES = 1_048_576;
export const HTTP_DEFAULT_TIMEOUT_MS = 30_000;
export const HTTP_MAX_TIMEOUT_MS = 300_000;

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Framing headers belong to the transport: letting a template set them is how
// a request gets smuggled or desynchronised.
const RESERVED_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-connection']);
const SECRET_REF = /{{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*}}/g;
const SECRET_IN = /{{\s*secrets\./;

const headerName = z.string().min(1).max(100).regex(TOKEN, 'invalid header name')
  .refine((name) => !RESERVED_HEADERS.has(name.toLowerCase()), 'header is set by the transport');

export const httpNodeConfigSchema = z.object({
  url: z.string().min(1).max(2000),
  method: z.enum(HTTP_METHODS).default('GET'),
  /** Values are templates; `{{secrets.NAME}}` reads the vault, in headers only. */
  headers: z.record(headerName, z.string().max(8000)).default({}),
  body: z.string().max(262_144).optional(),
  timeoutMs: z.number().int().positive().max(HTTP_MAX_TIMEOUT_MS).default(HTTP_DEFAULT_TIMEOUT_MS),
  allowPrivateNetwork: z.boolean().default(false),
}).strict().superRefine((config, ctx) => {
  if ((config.method === 'GET' || config.method === 'HEAD') && config.body) {
    ctx.addIssue({ code: 'custom', message: `${config.method} sends no body`, path: ['body'] });
  }
  // A literal URL is judged now; a templated one once filled, at run time.
  if (!config.url.includes('{{')) {
    try { assertHttpUrl(new URL(config.url)); }
    catch (error) { ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'invalid URL', path: ['url'] }); }
  }
  for (const field of ['url', 'body'] as const) {
    if (SECRET_IN.test(config[field] ?? '')) ctx.addIssue({ code: 'custom', message: 'secrets are read in headers only (a URL or a body ends up in logs)', path: [field] });
  }
});
export type HttpNodeConfig = z.infer<typeof httpNodeConfigSchema>;

function assertHttpUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new DestinationRefusedError(`scheme ${url.protocol} refused`);
  if (url.username || url.password) throw new DestinationRefusedError('credentials in the URL are refused; use a header and a vault secret');
}

/**
 * Why the owner may not run this node, or `null`. No account on the install
 * (open setup) and no owner (created with the daemon token, i.e. the operator)
 * both mean the operator's own workflow.
 */
export function httpNodeDenied(ownerUserId: string | null, config: Pick<HttpNodeConfig, 'allowPrivateNetwork'>): string | null {
  if (dbApi.countUsers() === 0 || ownerUserId === null) return null;
  if (ownerUserId.startsWith('plugin:')) return 'not permitted: a plugin calls out through its own ctx.fetch, not an http node';
  const owner = dbApi.getUserById(ownerUserId);
  if (!owner || owner.status !== 'active') return 'not permitted: the workflow owner is not an active account';
  if (!userAllows(owner, dbApi.listPermissionsForUser(owner.id), HTTP_NODE_PERMISSION)) {
    return `not permitted: an http node needs ${HTTP_NODE_PERMISSION} on the workflow owner's account`;
  }
  if (config.allowPrivateNetwork && !owner.is_superadmin) {
    return 'not permitted: only an administrator\'s workflow may reach a private network address';
  }
  return null;
}

/**
 * Publish refuses what the run would refuse, naming the node (a `ZodError`
 * so `describeWorkflowError` hands the builder its per-node issues). The run
 * checks again: a grant can be revoked after publishing.
 */
export function assertHttpNodesAllowed(nodes: ReadonlyArray<{ id: string; type: string; config: Record<string, unknown> }>, ownerUserId: string | null): void {
  const issues = nodes.flatMap((node): z.core.$ZodIssue[] => {
    if (node.type !== 'http') return [];
    const reason = httpNodeDenied(ownerUserId, { allowPrivateNetwork: node.config.allowPrivateNetwork === true });
    return reason ? [{ code: 'custom', message: `${reason} (${node.id})`, path: ['nodes', node.id], input: node.config }] : [];
  });
  if (issues.length) throw new z.ZodError(issues);
}

async function readCapped(response: Response, max: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`response larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export type HttpNodeOutput = { status: number; headers: { 'content-type': string | null }; body: unknown };

export type HttpNodeRun = {
  config: Record<string, unknown>;
  context: unknown;
  ownerUserId: string | null;
  /** The vault values this node may read (`secretsEnvFor` of its scope). */
  secrets: () => Record<string, string>;
};

/** Runs the request. Throws on refusal, transport failure, timeout or a non-2xx status. */
export async function runHttpNode(run: HttpNodeRun): Promise<HttpNodeOutput> {
  const config = httpNodeConfigSchema.parse(run.config);
  const denied = httpNodeDenied(run.ownerUserId, config);
  if (denied) throw new Error(denied);
  const url = new URL(interpolateTemplate(config.url, run.context));
  assertHttpUrl(url);

  const wanted = new Set<string>();
  for (const value of Object.values(config.headers)) for (const match of value.matchAll(SECRET_REF)) wanted.add(match[1]!);
  const available = wanted.size ? run.secrets() : {};
  const secrets: Record<string, string> = {};
  for (const name of wanted) {
    if (!Object.hasOwn(available, name)) throw new Error(`secret ${name} is not available to this node`);
    secrets[name] = available[name]!;
  }
  // One pass over a context that holds only the named secrets: a secret value
  // containing `{{…}}` is never interpolated a second time.
  const headerContext = { ...(run.context as Record<string, unknown>), secrets };
  const headers = new Headers();
  for (const [name, value] of Object.entries(config.headers)) headers.set(name, interpolateTemplate(value, headerContext));
  const body = config.body === undefined ? undefined : interpolateTemplate(config.body, run.context);
  if (body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const response = await guardedFetch(url, { method: config.method, headers, body, signal: AbortSignal.timeout(config.timeoutMs) }, {
    // Plain HTTP stays limited to loopback and Tailscale (net-guard's default).
    destination: () => ({ allowPrivateNetwork: config.allowPrivateNetwork }),
  });
  const text = await readCapped(response, HTTP_MAX_RESPONSE_BYTES);
  const contentType = response.headers.get('content-type');
  let parsed: unknown = text;
  if (contentType?.toLowerCase().includes('json') && text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!response.ok) throw new Error(String(redactDeep(`HTTP ${response.status}: ${text.slice(0, 500)}`)));
  return redactDeep({ status: response.status, headers: { 'content-type': contentType }, body: parsed });
}
