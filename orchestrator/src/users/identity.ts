/**
 * Per-request identity (Phase M.1). The plugin is loaded once; the user is
 * per request, attached by the auth middleware onto `req.auth`.
 */
import type { Request, Response } from 'express';
import { dbApi, type DbViewer, type UserRow } from '../db.js';
import { grantsAllow, MISSION_TOKEN_PERMISSIONS, userAllows } from './permissions.js';
import { SYSTEM_ACTOR_ID } from './api-tokens.js';
import { auditRequest } from './audit-actor.js';

export type { DbViewer };

export type PublicUser = {
  id: string;
  email: string;
  name: string;
  status: UserRow['status'];
  is_superadmin: boolean;
  created_at: number;
  last_login_at: number | null;
  /** Uploaded picture, `null` when the UI has to fall back to initials. */
  avatar_url: string | null;
};

export type RequestAuth = {
  /** `device`: a paired machine (`users/devices.ts`), acting with its owner's full rights. */
  kind: 'daemon-token' | 'session' | 'api-token' | 'device';
  user: UserRow | null;
  isSuperadmin: boolean;
  /**
   * Viewer id when it is not a user account (plugin job `plugin:<id>`,
   * or the unowned-mission system actor). Absent for sessions / users.
   */
  actorId?: string;
  /**
   * Grant snapshot. Set on every mission-bound `api-token` (secu-3 cap)
   * and on plugin/system tokens. Developer-owner authority is checked first. When present,
   * `requestHasPermission` / `viewerFromRequest` use it instead of the
   * launcher's `is_superadmin` or full role grants.
   */
  permissions?: readonly string[];
  /** Present only for a token issued to one running mission. */
  missionId?: string | null;
  /** Present only for `kind: 'device'`. */
  deviceId?: string;
};

declare global {
  namespace Express {
    interface Request {
      auth?: RequestAuth;
    }
  }
}

export function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    is_superadmin: user.is_superadmin,
    created_at: user.created_at,
    last_login_at: user.last_login_at,
    avatar_url: user.avatar_url,
  };
}

export function viewerFromRequest(req: Pick<Request, 'auth'>): DbViewer | null {
  const auth = req.auth;
  if (!auth) return null;
  if (auth.isSuperadmin) {
    return { id: auth.user?.id ?? 'daemon-token', isSuperadmin: true, permissions: [] };
  }
  // Mission (and plugin/system) api-tokens: identity of the launcher,
  // except developer-owner authority handled above — the snapshot
  // is already the cap ∩ those grants.
  if (auth.kind === 'api-token' && auth.permissions !== undefined) {
    return {
      id: auth.user?.id ?? auth.actorId ?? 'system',
      isSuperadmin: false,
      permissions: auth.permissions,
    };
  }
  if (auth.user) {
    return {
      id: auth.user.id,
      isSuperadmin: false,
      permissions: dbApi.listPermissionsForUser(auth.user.id),
    };
  }
  if (auth.kind === 'api-token') {
    return {
      id: auth.actorId ?? 'system',
      isSuperadmin: false,
      permissions: auth.permissions ?? [],
    };
  }
  return null;
}

/**
 * A person at a screen: a session cookie here, or a paired device relaying a
 * person from another machine (`users/devices.ts`, the maintainer's arbitration: a device
 * holds every right of its account). Mission tokens and the daemon-token are
 * not people. Credential and identity changes (`/api/auth/password`, profile,
 * email) stay on a session of their own.
 */
export function isPersonAuth(auth: RequestAuth | undefined | null): auth is RequestAuth & { kind: 'session' | 'device' } {
  return auth?.kind === 'session' || auth?.kind === 'device';
}

/** 401 unless a real user (session) or the daemon-token is on the request. */
export function requireAuth(req: Request, res: Response): RequestAuth | null {
  if (req.auth) return req.auth;
  res.status(401).json({ error: 'unauthorized' });
  return null;
}

/**
 * secu-4 / AUDIT-CLI-MCP-PERMISSIONS §3.3-3.5 — an exploitable 403 body.
 *
 * A bare `{ error: 'forbidden' }` gives an agent nothing it can act on, so the
 * CLI/MCP showed "403 forbidden" with no cause. Every right-check 403 now
 * carries a stable `code`, the missing `permission`, a short `reason` for
 * humans and a `hint` with a concrete next step. `caller` says what was
 * refused (`mission` | `session` | `operator`), never an account id or name.
 *
 * Security (audit §3.4): property 404s stay 404; `reason`/`hint` cite only
 * what the caller sent or a constant — never the account's full rights, a
 * vault value, a home path or someone else's id.
 */

/** Who was refused. Derived from the auth kind, never an identity. */
export type ForbiddenCaller = 'mission' | 'session' | 'operator';

/** Refusal kind — picks the stable `code` and the default `reason`/`hint`. */
export type ForbiddenKind = 'permission' | 'operator' | 'override' | 'account_required' | 'scope' | 'denied';

export type ForbiddenOptions = {
  /** Required permission(s), for `kind: 'permission'` (`rejectUnlessAny` passes the list). */
  permission?: string | readonly string[];
  kind: ForbiddenKind;
  /** Human sentence. Overrides the default; cite only the caller's input or a constant. */
  reason?: string;
  /** Concrete next step. Overrides the default. */
  hint?: string;
};

export type ForbiddenBody = {
  error: 'forbidden';
  code: string;
  permission: string | readonly string[] | null;
  reason: string;
  hint: string | null;
  caller: ForbiddenCaller;
};

function forbiddenCaller(req: Request): ForbiddenCaller {
  switch (req.auth?.kind) {
    case 'daemon-token': return 'operator';
    case 'api-token': return 'mission';
    default: return 'session';
  }
}

/** A single permission or the `rejectUnlessAny` list, formatted for prose. */
function permissionText(permission: ForbiddenOptions['permission']): string {
  if (permission === undefined) return 'this permission';
  return typeof permission === 'string' ? permission : permission.join(' or ');
}

function forbiddenCode(req: Request, opts: ForbiddenOptions): string {
  switch (opts.kind) {
    case 'operator': return 'operator_only';
    case 'override': return 'override_denied';
    case 'account_required': return 'account_required';
    // Not a missing right: the caller named something its token or session does
    // not cover (a sibling mission, another person's account).
    case 'scope': return 'out_of_scope';
    // A role that DENIES the permission (`-agents:communicate`): not a grant
    // that is missing, nor the mission cap, which would send the caller to
    // ask for the wrong thing.
    case 'denied': return 'explicitly_denied';
    case 'permission': {
      const auth = req.auth;
      // A mission token is refused either because the permission is outside
      // the cap (`not_in_mission_cap` — nothing the account owner can grant)
      // or because it is in the cap but not in the account's grants
      // (`account_lacks_permission`). The distinction is static: no read.
      if (auth?.kind === 'api-token' && auth.permissions !== undefined) {
        const wanted = opts.permission === undefined
          ? []
          : Array.isArray(opts.permission) ? opts.permission : [opts.permission];
        const anyInCap = wanted.some((p) => (MISSION_TOKEN_PERMISSIONS as readonly string[]).includes(p));
        if (!anyInCap) return 'not_in_mission_cap';
        // A mission whose lineage has no owning account authenticates as the
        // `system` actor with empty grants: a relaunch from an account is what
        // lifts the refusal, so the cause is named only where the cap could pass.
        if (auth.user === null && auth.missionId != null && auth.actorId === SYSTEM_ACTOR_ID) {
          return 'mission_without_owner';
        }
      }
      return 'account_lacks_permission';
    }
  }
}

function forbiddenReason(code: string, opts: ForbiddenOptions): string {
  if (opts.reason) return opts.reason;
  const text = permissionText(opts.permission);
  switch (code) {
    case 'operator_only': return 'this route is reserved to the operator';
    case 'override_denied': return 'operation refused';
    case 'account_required': return 'no account to attach this to';
    case 'out_of_scope': return 'this request is outside what the caller may act on';
    case 'explicitly_denied': return `this account is explicitly denied ${text}`;
    case 'not_in_mission_cap': return `mission tokens never carry ${text}`;
    case 'mission_without_owner': return 'this mission has no owning account';
    case 'account_lacks_permission': return `this account does not hold ${text}`;
    default: return 'forbidden';
  }
}

function forbiddenHint(code: string, opts: ForbiddenOptions): string | null {
  if (opts.hint !== undefined) return opts.hint;
  const text = permissionText(opts.permission);
  switch (code) {
    case 'operator_only':
      return 'Reserved to the operator (daemon-token or superadmin session), not reachable from a mission.';
    case 'override_denied':
      return 'Omit the field or change it from the UI.';
    case 'account_required':
      return 'Create an account (first-run setup) before saving preferences.';
    case 'out_of_scope':
      return 'Act on your own mission or account only, or ask the operator.';
    case 'explicitly_denied':
      return `Ask an administrator to remove the denial of ${text} from your role.`;
    case 'mission_without_owner':
      return 'relaunch it from your account';
    case 'not_in_mission_cap':
      return 'Do it from the UI, or ask the account owner to run it with the CLI outside a mission.';
    case 'account_lacks_permission':
      return `Ask an administrator to add ${text} to your role.`;
    default:
      return null;
  }
}

/** Pure body builder — unit-tested without a database. */
export function forbiddenBody(req: Request, opts: ForbiddenOptions): ForbiddenBody {
  const code = forbiddenCode(req, opts);
  return {
    error: 'forbidden',
    code,
    permission: opts.permission ?? null,
    reason: forbiddenReason(code, opts),
    hint: forbiddenHint(code, opts),
    caller: forbiddenCaller(req),
  };
}

/**
 * Audit + send a 403 with an exploitable body. Returns `true` so a guard can
 * `return forbidden(...)`. `override` already logs its own `action.denied`
 * row (privileged-overrides.ts); every other refusal logs `authz.denied`.
 */
export function forbidden(req: Request, res: Response, opts: ForbiddenOptions): true {
  const body = forbiddenBody(req, opts);
  if (opts.kind !== 'override') {
    auditRequest(req, 'authz.denied', typeof body.permission === 'string' ? body.permission : body.code);
  }
  res.status(403).json(body);
  return true;
}

/**
 * Superadmin only. The legacy daemon-token counts, even before the first
 * user exists — that is how CLI and in-flight missions keep working.
 */
export function requireSuperadmin(req: Request, res: Response): RequestAuth | null {
  if (!req.auth) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  if (!req.auth.isSuperadmin) {
    forbidden(req, res, { kind: 'operator' });
    return null;
  }
  return req.auth;
}

/**
 * Hide a surface from a signed-in non-superadmin. Unauthenticated
 * requests only reach here while the users table is empty (first-run
 * setup); once a user exists the auth middleware 401s them first.
 * Returns true when the response has already been sent.
 */
export function rejectIfNotSuperadmin(req: Request, res: Response): boolean {
  if (!req.auth || req.auth.isSuperadmin) return false;
  return forbidden(req, res, { kind: 'operator' });
}

/**
 * M.4: hide a surface (or its backing API) when the caller lacks the
 * permission. Same first-run hole as `rejectIfNotSuperadmin`: no auth
 * means the users table is still empty, and the historical open API
 * stays. Superadmin / daemon-token pass via `requestHasPermission`.
 */
export function rejectIfDenied(req: Request, res: Response, permission: string): boolean {
  if (!req.auth) return false;
  if (requestHasPermission(req, permission)) return false;
  return forbidden(req, res, { kind: 'permission', permission });
}

/**
 * Same as `rejectIfDenied` for a surface that several permissions open —
 * `agents:read` OR `agents:manage` for reading an agent, since `manage`
 * does not cover `read` in the evaluator (siblings, not a scope).
 */
export function rejectUnlessAny(req: Request, res: Response, permissions: readonly string[]): boolean {
  if (!req.auth) return false;
  if (permissions.some((permission) => requestHasPermission(req, permission))) return false;
  return forbidden(req, res, { kind: 'permission', permission: permissions });
}

/**
 * Operator-only: the daemon-token itself, not a session and not a
 * spoofable `X-ROOKS-Agent` header. A session superadmin is still 403.
 * Returns true when the response has already been sent.
 */
export function rejectIfNotDaemonToken(req: Request, res: Response): boolean {
  if (!req.auth) {
    res.status(401).json({ error: 'unauthorized' });
    return true;
  }
  if (req.auth.kind !== 'daemon-token') {
    return forbidden(req, res, { kind: 'operator' });
  }
  return false;
}

/**
 * M.2 evaluator entry point. Superadmin (session or daemon-token) is `*`
 * and never reads `role_permissions`. M.3 uses it for the `:read:all`
 * scope via `viewerFromRequest` → `viewerSeesAll`.
 *
 * An ordinary mission api-token is evaluated against its capped snapshot, never
 * against the launcher's `is_superadmin` (`userAllows` would grant `*`).
 */
export function requestHasPermission(req: Request, permission: string): boolean {
  const auth = req.auth;
  if (!auth) return false;
  if (auth.isSuperadmin) return true;
  if (auth.kind === 'api-token' && auth.permissions !== undefined) {
    return grantsAllow(auth.permissions, permission);
  }
  if (auth.user) {
    return userAllows(auth.user, dbApi.listPermissionsForUser(auth.user.id), permission);
  }
  if (auth.kind === 'api-token') {
    return grantsAllow(auth.permissions ?? [], permission);
  }
  return false;
}
