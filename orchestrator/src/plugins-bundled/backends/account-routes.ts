/**
 * `/api/backends/accounts` — the subscription accounts of a backend (TODO #52).
 *
 * Authentication is explicit on every verb: an anonymous caller is refused
 * before anything is read. What leaves here is a name, a backend, a state and
 * an owner — never the account's directory, never what the CLI keeps in it.
 *
 * Who does what:
 * - read: the superadmin sees every account; anyone else sees their own and
 *   the ones granted to them. Anything else answers 404, not 403: an account
 *   one may not see does not exist for them.
 * - create, rename, delete: a signed-in user for their own accounts, the
 *   superadmin for anyone's and for the instance accounts (no owner). A
 *   mission token never manages accounts: an agent does not pick who pays.
 * - grant: the superadmin only.
 * - sign in (`/login`): like manage, from a browser session only. The flow is
 *   bound to that session: another session, even the same user's, gets 404.
 *   The pasted code travels in the body, never in the URL, and is never
 *   echoed back nor logged.
 */
import { providerSignedIn } from '../../backends/sign-in-state.js';
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { dbApi } from '../../db.js';
import { auditRequest } from '../../users/audit-actor.js';
import { requireAuth, viewerFromRequest, forbidden, type DbViewer } from '../../users/identity.js';
import {
  BackendAccountConflictError, accountInstance, createBackendAccount, deleteBackendAccount, getBackendAccountFor,
  grantBackendAccount, listBackendAccountGrants, listBackendAccountsFor, renameBackendAccount,
  revokeBackendAccountGrant, setBackendAccountStatus, type BackendAccountRow,
} from '../../backends/accounts.js';
import { backendTakesAccounts, profileServes } from '../../backends/registry.js';
import type { SecretTarget } from '../../secrets/resolve.js';
import { clearBackendCooldown, isBackendCoolingDown } from '../../backend-fallback.js';
import { backendCatalog, tryDefaultBackendName } from '../../backends/index.js';
import { productModelBrands } from '../../backends/builtin-declarations.js';
import {
  LoginFlowError, cancelAccountLogin, cancelAccountLoginInternal, getAccountLogin, startAccountLogin,
  submitAccountLoginCode, type LoginInitiator,
} from '../../backends/account-login.js';
import { SESSION_COOKIE, hashSessionToken, readCookie } from '../../users/session.js';
import type { AccountState } from '../../plugins/contract/accounts.js';
import type { PluginBackendCatalog } from '../../plugins/contract/backends.js';
import type { Assert, Equals } from '../../type-equality.js';
import { apiError } from '../../api-error.js';
export type { AccountState } from '../../plugins/contract/accounts.js';

const Name = z.string().trim().min(1).max(60);
const CreateBody = z.object({
  backend: z.string().trim().min(1).max(64),
  name: Name,
  /** Absent = the caller. `null` = an instance account (superadmin only). */
  ownerUserId: z.string().min(1).max(128).nullable().optional(),
}).strict();
const PatchBody = z.object({
  name: Name.optional(),
  /** Back in rotation after a sign-in done outside Rooks. */
  status: z.literal('active').optional(),
}).strict().refine((body) => body.name !== undefined || body.status !== undefined, { message: 'nothing to change' });
const GrantsBody = z.object({ userIds: z.array(z.string().min(1).max(128)).max(500) }).strict();
const LoginBody = z.object({}).strict();
/** One line: a line break would feed the CLI's next prompt. */
const CodeBody = z.object({
  code: z.string().min(1).max(4096).refine((value) => !/[\r\n]/.test(value), { message: 'one line only' }),
}).strict();

export function accountState(row: BackendAccountRow): AccountState {
  if (row.status === 'reauth') return 'reauth';
  return isBackendCoolingDown(accountInstance(row)) ? 'cooldown' : 'active';
}

function publicAccount(row: BackendAccountRow, viewer: DbViewer) {
  return {
    id: row.id,
    instance: accountInstance(row),
    backend: row.backend,
    name: row.name,
    ownerUserId: row.owner_user_id,
    mine: row.owner_user_id === viewer.id,
    state: accountState(row),
    /** Signed in through Rooks. An account signed in by hand still runs. */
    connected: row.identity_key !== null,
    // Who it is signed in as: for whoever manages it, not for a grantee.
    ...(viewer.isSuperadmin || row.owner_user_id === viewer.id ? { identity: row.identity_label } : {}),
    createdAt: row.created_at,
    ...(viewer.isSuperadmin ? { grantedTo: listBackendAccountGrants(row.id) } : {}),
  };
}

/** The viewer of a request that may manage accounts, or null once answered. */
function manager(req: Request, res: Response): DbViewer | null {
  if (!requireAuth(req, res)) return null;
  if (req.auth!.kind === 'api-token') {
    forbidden(req, res, { kind: 'operator', reason: 'a mission token cannot manage subscription accounts' });
    return null;
  }
  const viewer = viewerFromRequest(req);
  if (!viewer) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  return viewer;
}

/** The account if the viewer may manage it (its owner, or the superadmin). */
function managed(req: Request, viewer: DbViewer, id: string, res: Response): BackendAccountRow | null {
  const row = getBackendAccountFor(viewer, id);
  if (!row) {
    res.status(404).json(apiError('account_unknown', 'unknown account'));
    return null;
  }
  if (!viewer.isSuperadmin && row.owner_user_id !== viewer.id) {
    forbidden(req, res, { kind: 'scope', reason: 'only its owner or the superadmin manages this account' });
    return null;
  }
  return row;
}

/**
 * The session a sign-in flow is bound to. Only a browser session starts one:
 * the daemon token and mission tokens are no one's browser.
 */
function loginInitiator(req: Request, res: Response): { viewer: DbViewer; initiator: LoginInitiator } | null {
  const viewer = manager(req, res);
  if (!viewer) return null;
  const raw = req.auth!.kind === 'session' ? readCookie(req.headers.cookie, SESSION_COOKIE) : undefined;
  if (!raw) {
    forbidden(req, res, { kind: 'scope', reason: 'an account is signed in from a browser session', hint: 'Sign in to the account from the UI (Settings → Accounts).' });
    return null;
  }
  return { viewer, initiator: { userId: viewer.id, binding: hashSessionToken(raw) } };
}

function invalid(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: 'invalid body', fields: error.issues.map((issue) => issue.path.join('.') || 'body') });
}

export function registerAccountRoutes(router: Router): void {
  router.get('/api/backends/accounts', (req, res) => {
    if (!requireAuth(req, res)) return;
    const viewer = viewerFromRequest(req);
    if (!viewer) return void res.status(401).json({ error: 'unauthorized' });
    res.json({
      accounts: listBackendAccountsFor(viewer).map((row) => publicAccount(row, viewer)),
      // Where an account can be added: the UI offers these, never a guess.
      backends: backendCatalog().filter((entry) => !entry.account && backendTakesAccounts(entry.id)).map((entry) => entry.id),
    });
  });

  router.post('/api/backends/accounts', (req, res) => {
    const viewer = manager(req, res);
    if (!viewer) return;
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error);
    const owner = parsed.data.ownerUserId === undefined ? viewer.id : parsed.data.ownerUserId;
    if (!viewer.isSuperadmin && owner !== viewer.id) {
      return void forbidden(req, res, { kind: 'operator', reason: 'only the superadmin adds an account for someone else or for the instance' });
    }
    if (owner !== null) {
      const user = dbApi.getUserById(owner);
      if (!user || user.status === 'disabled') return void res.status(400).json({ error: 'unknown or disabled owner' });
    }
    if (!backendTakesAccounts(parsed.data.backend)) {
      return void res.status(400).json({ error: `backend ${parsed.data.backend} does not take subscription accounts` });
    }
    try {
      const row = createBackendAccount({ backend: parsed.data.backend, name: parsed.data.name, ownerUserId: owner, createdBy: viewer.id });
      auditRequest(req, 'backend_account.create', accountInstance(row));
      res.status(201).json({ account: publicAccount(row, viewer) });
    } catch (error) {
      if (error instanceof BackendAccountConflictError) return void res.status(409).json({ error: error.message });
      throw error;
    }
  });

  router.patch('/api/backends/accounts/:id', (req, res) => {
    const viewer = manager(req, res);
    if (!viewer) return;
    const row = managed(req, viewer, String(req.params['id'] ?? ''), res);
    if (!row) return;
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error);
    try {
      if (parsed.data.name !== undefined) renameBackendAccount(row.id, parsed.data.name);
    } catch (error) {
      if (error instanceof BackendAccountConflictError) return void res.status(409).json({ error: error.message });
      throw error;
    }
    if (parsed.data.status === 'active') {
      setBackendAccountStatus(row.id, 'active');
      clearBackendCooldown(accountInstance(row));
      auditRequest(req, 'backend_account.reactivate', accountInstance(row));
    }
    res.json({ account: publicAccount(getBackendAccountFor(viewer, row.id)!, viewer) });
  });

  router.delete('/api/backends/accounts/:id', (req, res) => {
    const viewer = manager(req, res);
    if (!viewer) return;
    const row = managed(req, viewer, String(req.params['id'] ?? ''), res);
    if (!row) return;
    cancelAccountLoginInternal(row.id);
    deleteBackendAccount(row.id);
    clearBackendCooldown(accountInstance(row));
    auditRequest(req, 'backend_account.delete', accountInstance(row));
    res.json({ ok: true });
  });

  router.post('/api/backends/accounts/:id/login', (req, res) => {
    const who = loginInitiator(req, res);
    if (!who) return;
    const row = managed(req, who.viewer, String(req.params['id'] ?? ''), res);
    if (!row) return;
    const parsed = LoginBody.safeParse(req.body ?? {});
    if (!parsed.success) return invalid(res, parsed.error);
    try {
      res.status(202).json({ login: startAccountLogin(row, who.initiator) });
    } catch (error) {
      if (error instanceof LoginFlowError) return void res.status(400).json({ error: error.message });
      throw error;
    }
  });

  router.get('/api/backends/accounts/:id/login', (req, res) => {
    const who = loginInitiator(req, res);
    if (!who) return;
    const login = getAccountLogin(String(req.params['id'] ?? ''), who.initiator);
    if (!login) return void res.status(404).json(apiError('signin_not_in_progress', 'no sign-in in progress'));
    res.json({ login });
  });

  router.post('/api/backends/accounts/:id/login/code', (req, res) => {
    const who = loginInitiator(req, res);
    if (!who) return;
    const parsed = CodeBody.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error);
    try {
      const login = submitAccountLoginCode(String(req.params['id'] ?? ''), who.initiator, parsed.data.code);
      if (!login) return void res.status(404).json(apiError('signin_not_in_progress', 'no sign-in in progress'));
      res.json({ login });
    } catch (error) {
      if (error instanceof LoginFlowError) return void res.status(error.code === 'bad_code' ? 400 : 409).json({ error: error.message });
      throw error;
    }
  });

  router.delete('/api/backends/accounts/:id/login', (req, res) => {
    const who = loginInitiator(req, res);
    if (!who) return;
    const login = cancelAccountLogin(String(req.params['id'] ?? ''), who.initiator);
    if (!login) return void res.status(404).json(apiError('signin_not_in_progress', 'no sign-in in progress'));
    res.json({ login });
  });

  router.put('/api/backends/accounts/:id/grants', (req, res) => {
    const viewer = manager(req, res);
    if (!viewer) return;
    if (!viewer.isSuperadmin) return void forbidden(req, res, { kind: 'operator' });
    const row = getBackendAccountFor(viewer, String(req.params['id'] ?? ''));
    if (!row) return void res.status(404).json(apiError('account_unknown', 'unknown account'));
    const parsed = GrantsBody.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed.error);
    const wanted = new Set(parsed.data.userIds);
    for (const userId of wanted) {
      if (!dbApi.getUserById(userId)) return void res.status(400).json({ error: `unknown user ${userId}` });
    }
    const current = new Set(listBackendAccountGrants(row.id));
    for (const userId of current) if (!wanted.has(userId)) revokeBackendAccountGrant(row.id, userId);
    for (const userId of wanted) if (!current.has(userId)) grantBackendAccount(row.id, userId, viewer.id);
    auditRequest(req, 'backend_account.grant', `${accountInstance(row)} users:${[...wanted].join(',')}`);
    res.json({ account: publicAccount(row, viewer) });
  });
}

/**
 * The catalogue as one caller may see it: every backend, but only the account
 * instances on their access list, each with its state. Without an identity (a
 * fresh install before its first account), no account at all.
 */
export function catalogFor(req: Request) {
  return catalogForViewer(viewerFromRequest(req), catalogTarget(req));
}

/** `?project=<slug>&agent=<name>`: the mission the picker is for. Absent, or
 *  malformed, the whole inventory as before — a filter, never a grant. */
const CatalogTargetSchema = z.object({
  project: z.string().trim().min(1).max(200).optional(),
  agent: z.string().trim().min(1).max(200).optional(),
});

function catalogTarget(req: Request): SecretTarget | undefined {
  const parsed = CatalogTargetSchema.safeParse({ project: req.query['project'], agent: req.query['agent'] });
  if (!parsed.success || (!parsed.data.project && !parsed.data.agent)) return undefined;
  return { project: parsed.data.project ?? null, agent: parsed.data.agent ?? null };
}

/** `catalogFor` for a caller that is not a request (a plugin's facade). With a
 *  `target`, only the backends a mission of that target could be launched on
 *  (TODO #531, 5-B): a key reserved to a backend and granted to one project
 *  does not show its backend in another project's picker. */
export function catalogForViewer(viewer: DbViewer | null, target?: SecretTarget) {
  const visible = new Map(viewer ? listBackendAccountsFor(viewer).map((row) => [row.id, row]) : []);
  const backends = backendCatalog().filter((entry) => !target || profileServes(entry.id, target)).flatMap((entry) => {
    // The host's own sign-in: `false` only when the daemon KNOWS it is signed out.
    if (!entry.account) return [{ ...entry, signedIn: providerSignedIn(entry.id) }];
    const row = visible.get(entry.account.id);
    // An account's sign-in is its `state` (`reauth`).
    return row ? [{ ...entry, signedIn: null, account: { ...entry.account, state: accountState(row) } }] : [];
  });
  // The model-name fragments are the product's, served whether or not a provider is active.
  return { backends, defaultBackend: tryDefaultBackendName(), modelBrands: productModelBrands() };
}
/** The plugin contract spells this catalogue out (`ctx.backends.catalog`); compilation fails if they part. */
type _CatalogMatchesContract = Assert<Equals<ReturnType<typeof catalogForViewer>, PluginBackendCatalog>>;
