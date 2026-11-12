/**
 * Secrets an agent asked its user for (`secret_request`, docs/SECRETS-VAULT.md
 * §9.5): the store half — the table, the binding of a provided value to the
 * mission that asked, and the end of that value's life.
 *
 * The value itself lives in `secrets`, sealed like any other, created with NO
 * grant: no audience of the vault reaches it. The only door to it is the
 * request row, which binds it to ONE mission — the broker and the spawn read
 * that binding, nothing else does. This is what makes "open to the requesting
 * mission alone" hold without a fifth scope kind in the resolver: a scope would
 * also be offered by the Secrets page, the CLI and the grant routes, where a
 * mission id means nothing to a human.
 *
 * Lifetimes:
 * - `once`: erased after its first use (a broker call handed to the network, a
 *   browser fill handed to the page, or an injection at a launch). Before the
 *   value is handed to any of them, the consumer CLAIMS the one use: a
 *   conditional update that only one caller can win, so two concurrent calls
 *   never both carry it out. Then the erase runs; an erase that fails is
 *   replayed by the sweep;
 * - `mission`: erased when the mission ends;
 * - `persistent`: an ordinary daemon-only secret once the mission is over — a
 *   human opens it to a scope on the Secrets page, like one `secret_create` made.
 *
 * Nothing here ever returns, logs or journals a value. The flow half (cards,
 * routes, messages to the agent) is `plugins-bundled/secrets-vault/requests.ts`.
 */
import { db, dbApi, type SecretWithGrants } from '../db.js';
import { readSecretValue } from './store.js';
import type { InjectedSecret, InjectedSecrets } from './env.js';

export const SECRET_REQUEST_LIFETIMES = ['once', 'mission', 'persistent'] as const;
export type SecretRequestLifetime = (typeof SECRET_REQUEST_LIFETIMES)[number];

export const SECRET_REQUEST_STATUSES = ['pending', 'provided', 'refused', 'expired'] as const;
export type SecretRequestStatus = (typeof SECRET_REQUEST_STATUSES)[number];

export type SecretRequestRow = {
  id: string;
  mission_id: string;
  owner_user_id: string;
  agent: string;
  name: string;
  reason: string;
  lifetime: SecretRequestLifetime;
  /** JSON of an `http` broker spec when the agent named hosts, else null (an `inject` secret). */
  broker_spec: string | null;
  /** The exact page origin a browser fill may put it in (`fill_credential`), else null. */
  browser_origin: string | null;
  project: string | null;
  mission_title: string;
  status: SecretRequestStatus;
  /** The `secrets` row holding the value, once provided. */
  secret_id: string | null;
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
  /** When a `once` value served: from then on no door opens it, even before the erase ran. */
  spent_at: number | null;
  /** When the value was destroyed (`once` used, `mission` over). Null while it lives. */
  erased_at: number | null;
};

let schemaReady = false;

/**
 * Own table, not the events: the binding must answer the broker in one indexed
 * read, and outlive a daemon restart so the boot sweep can erase what a dead
 * mission left behind. No foreign key, like `command_requests`.
 */
export function ensureSecretRequestSchema(): void {
  if (schemaReady) return;
  db.exec(`
CREATE TABLE IF NOT EXISTS secret_requests (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  name TEXT NOT NULL,
  reason TEXT NOT NULL,
  lifetime TEXT NOT NULL,
  broker_spec TEXT,
  browser_origin TEXT,
  project TEXT,
  mission_title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  secret_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER,
  spent_at INTEGER,
  erased_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_secret_requests_mission ON secret_requests(mission_id, name, status);
CREATE INDEX IF NOT EXISTS idx_secret_requests_open ON secret_requests(status, erased_at);
`);
  schemaReady = true;
}

export type NewSecretRequest = Omit<SecretRequestRow, 'status' | 'secret_id' | 'resolved_at' | 'spent_at' | 'erased_at'>;

export function insertSecretRequest(row: NewSecretRequest): SecretRequestRow {
  ensureSecretRequestSchema();
  db.prepare(`INSERT INTO secret_requests
    (id, mission_id, owner_user_id, agent, name, reason, lifetime, broker_spec, browser_origin, project, mission_title, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id, row.mission_id, row.owner_user_id, row.agent, row.name, row.reason, row.lifetime,
    row.broker_spec, row.browser_origin, row.project, row.mission_title, row.created_at, row.expires_at,
  );
  return getSecretRequest(row.id)!;
}

export function getSecretRequest(id: string): SecretRequestRow | undefined {
  ensureSecretRequestSchema();
  return db.prepare(`SELECT * FROM secret_requests WHERE id = ?`).get(id) as SecretRequestRow | undefined;
}

/** The request of this mission for this name still waiting, if any: asking twice shows one card. */
export function findPendingSecretRequest(missionId: string, name: string): SecretRequestRow | undefined {
  ensureSecretRequestSchema();
  return db.prepare(`SELECT * FROM secret_requests WHERE mission_id = ? AND name = ? AND status = 'pending'
    ORDER BY created_at DESC LIMIT 1`).get(missionId, name) as SecretRequestRow | undefined;
}

/** Settles a pending request; false when it was no longer pending (a second click, a race). */
export function settleSecretRequest(id: string, status: Exclude<SecretRequestStatus, 'pending'>, secretId: string | null = null, at = Date.now()): boolean {
  ensureSecretRequestSchema();
  return db.prepare(`UPDATE secret_requests SET status = ?, secret_id = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`)
    .run(status, secretId, at, id).changes > 0;
}

/** The `secrets` row that now holds a provided request's value. */
export function attachRequestedSecret(id: string, secretId: string): void {
  ensureSecretRequestSchema();
  db.prepare(`UPDATE secret_requests SET secret_id = ? WHERE id = ?`).run(secretId, id);
}

/** Requests the boot sweep and the expiry timer must look at: waiting, or holding a value that must not outlive its mission (or its one use). */
export function listOpenSecretRequests(): SecretRequestRow[] {
  ensureSecretRequestSchema();
  return db.prepare(`SELECT * FROM secret_requests
    WHERE status = 'pending' OR (status = 'provided' AND lifetime != 'persistent' AND erased_at IS NULL)`).all() as SecretRequestRow[];
}

export function listMissionSecretRequests(missionId: string): SecretRequestRow[] {
  ensureSecretRequestSchema();
  return db.prepare(`SELECT * FROM secret_requests WHERE mission_id = ? ORDER BY created_at`).all(missionId) as SecretRequestRow[];
}

/** A provided value of this mission that still exists and has not served its one use, newest first. */
function liveBindings(missionId: string): SecretRequestRow[] {
  ensureSecretRequestSchema();
  return db.prepare(`SELECT * FROM secret_requests
    WHERE mission_id = ? AND status = 'provided' AND erased_at IS NULL AND spent_at IS NULL AND secret_id IS NOT NULL
    ORDER BY resolved_at DESC`).all(missionId) as SecretRequestRow[];
}

/**
 * Destroys a requested value: the `secrets` row goes (the redaction cache with
 * it, `db.deleteSecret`), the request keeps the fact that it was erased, and the
 * journal says why — the three in ONE transaction. A deletion that fails rolls
 * the claim back: the row stays open (`listOpenSecretRequests`) and the next
 * sweep tries again, instead of a sealed value nobody would ever erase.
 * Idempotent: a value already gone is not erased twice. Never throws: the
 * callers are a broker call that already went out and a mission that ended.
 */
export function eraseRequestedSecret(row: SecretRequestRow, detail: string, at = Date.now()): boolean {
  ensureSecretRequestSchema();
  const secretId = row.secret_id;
  if (!secretId) return false;
  try {
    return db.transaction(() => {
      const claimed = db.prepare(`UPDATE secret_requests SET erased_at = ? WHERE id = ? AND erased_at IS NULL`).run(at, row.id).changes > 0;
      if (!claimed) return false;
      dbApi.deleteSecret(secretId);
      dbApi.recordSecretAccess({
        secret_id: secretId,
        name: row.name,
        mission_id: row.mission_id,
        agent: row.agent,
        kind: 'erase',
        outcome: 'ok',
        detail: `${row.lifetime}: ${detail}`,
        at,
      });
      return true;
    })();
  } catch {
    // The name only: a driver message is ours, but nothing here needs more.
    console.warn(`[secrets] requested ${row.name} not erased yet: the sweep will retry`);
    return false;
  }
}

/**
 * Takes the one use of a `once` value, BEFORE it is handed to anyone: true for
 * the single caller whose update matched, false for every other — a second
 * broker call that read the same binding while the first was awaiting its
 * fetch, a second fill, a second launch. One statement, so the database is the
 * arbiter and no read-then-write window exists. From then on no door opens the
 * value, even before the erase ran. Any other lifetime always passes.
 */
export function claimRequestedSecret(row: SecretRequestRow, at = Date.now()): boolean {
  if (row.lifetime !== 'once') return true;
  ensureSecretRequestSchema();
  return db.prepare(`UPDATE secret_requests SET spent_at = ?
    WHERE id = ? AND status = 'provided' AND spent_at IS NULL AND erased_at IS NULL`).run(at, row.id).changes > 0;
}

/**
 * A `once` value has served: erased. Only after a won claim
 * (`claimRequestedSecret`); `spent_at` is set again defensively, without
 * overwriting the claim's time. Any other lifetime is untouched.
 */
export function spendRequestedSecret(row: SecretRequestRow, how: string, at = Date.now()): void {
  if (row.lifetime !== 'once') return;
  ensureSecretRequestSchema();
  db.prepare(`UPDATE secret_requests SET spent_at = COALESCE(spent_at, ?) WHERE id = ?`).run(at, row.id);
  eraseRequestedSecret(row, `used once (${how})`, at);
}

/** What the broker learns about a value this mission was given. */
export type BoundSecret = {
  secretId: string;
  /** Set when the value is meant for a browser page, not for the broker. */
  browserOrigin: string | null;
  /** Takes the one use of a `once` value before it is handed out; false: another caller already took it. */
  claim: () => boolean;
  /** Called once the value has left the daemon, after a won claim: a `once` value is erased. */
  used: (how: string) => void;
};

/**
 * The value `missionId` was given under `name`, or null. The mission id comes
 * from the caller's token (`callerFromRequest`), never from what the agent
 * claims: another mission asking for the same name finds nothing here.
 */
export function boundRequestedSecret(missionId: string | null | undefined, name: string): BoundSecret | null {
  if (!missionId) return null;
  const row = liveBindings(missionId).find((r) => r.name === name);
  if (!row?.secret_id) return null;
  return {
    secretId: row.secret_id,
    browserOrigin: row.browser_origin,
    claim: () => claimRequestedSecret(row),
    used: (how) => spendRequestedSecret(row, how),
  };
}

/** The id `list_credentials` shows for a requested value: the request's, never the secret's. */
export const REQUESTED_CREDENTIAL_PREFIX = 'sr-';

/** A value this mission was given for a page, as `list_credentials` shows it: no value, no secret id. */
export type RequestedBrowserCredential = {
  id: string;
  name: string;
  origin: string;
  lifetime: SecretRequestLifetime;
  providedAt: number;
};

export function requestedBrowserCredentials(missionId: string | null | undefined): RequestedBrowserCredential[] {
  if (!missionId) return [];
  const seen = new Set<string>();
  const out: RequestedBrowserCredential[] = [];
  for (const row of liveBindings(missionId)) {
    if (!row.browser_origin || seen.has(row.name)) continue;
    seen.add(row.name);
    out.push({ id: `${REQUESTED_CREDENTIAL_PREFIX}${row.id}`, name: row.name, origin: row.browser_origin, lifetime: row.lifetime, providedAt: row.resolved_at ?? row.created_at });
  }
  return out;
}

/** What a browser fill needs: the sealed row to open, the origin it is bound to, and the spend. */
export type BoundBrowserSecret = {
  secretId: string;
  name: string;
  origin: string;
  requestId: string;
  agent: string;
  /** Same contract as `BoundSecret.claim`. */
  claim: () => boolean;
  used: (how: string) => void;
};

/**
 * The page value behind a `sr-…` id, if `missionId` (from the caller's token)
 * is the mission it was given to. Another mission, a spent or erased value, a
 * value meant for the broker or the environment: null, like an unknown id.
 */
export function boundBrowserSecret(missionId: string | null | undefined, credentialId: unknown): BoundBrowserSecret | null {
  if (!missionId || typeof credentialId !== 'string' || !credentialId.startsWith(REQUESTED_CREDENTIAL_PREFIX)) return null;
  const requestId = credentialId.slice(REQUESTED_CREDENTIAL_PREFIX.length);
  const row = liveBindings(missionId).find((r) => r.id === requestId);
  if (!row?.secret_id || !row.browser_origin) return null;
  return {
    secretId: row.secret_id,
    name: row.name,
    origin: row.browser_origin,
    requestId: row.id,
    agent: row.agent,
    claim: () => claimRequestedSecret(row),
    used: (how) => spendRequestedSecret(row, how),
  };
}

/**
 * The exact origin a page value is bound to, from what the agent named: a full
 * URL is accepted, only its origin is kept; userinfo and other schemes are
 * refused. Same rule as a saved browser login (`canonicalCredentialOrigin`).
 */
export function canonicalRequestOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || !url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The `inject` values this mission was given, for the environment of its next launch. */
export type RequestedInjection = InjectedSecrets & {
  /** After the launch: a `once` value that entered the environment is destroyed. */
  consume: () => void;
};

/**
 * Opened at the launch, like the vault slice (`injectedSecretsFor`). A value
 * that cannot be opened is skipped with its NAME only in the log: the
 * mission starts without it rather than not at all. A `once` value is claimed
 * here, as it enters the environment being built: a launch that fails after
 * this point has spent it (the sweep erases it), never two launches carry it.
 */
export function requestedSecretsFor(missionId: string): RequestedInjection {
  const env: Record<string, string> = {};
  const injected: InjectedSecret[] = [];
  const once: SecretRequestRow[] = [];
  let rows: SecretRequestRow[] = [];
  try {
    rows = liveBindings(missionId);
  } catch (err) {
    console.warn(`[secrets] requested secrets unreadable (${(err as Error).message})`);
  }
  for (const row of rows) {
    if (row.broker_spec || row.browser_origin || !row.secret_id || row.name in env) continue;
    const secret: SecretWithGrants | undefined = dbApi.getSecret(row.secret_id);
    if (!secret || secret.mode !== 'inject') continue;
    let value: string;
    try {
      value = readSecretValue(row.secret_id);
    } catch {
      console.warn(`[secrets] requested ${row.name} not injected`);
      continue;
    }
    if (!claimRequestedSecret(row)) continue;
    env[row.name] = value;
    injected.push({ id: row.secret_id, name: row.name });
    if (row.lifetime === 'once') once.push(row);
  }
  return {
    env,
    injected,
    consume: () => { for (const row of once) spendRequestedSecret(row, 'injected at a launch'); },
  };
}

/**
 * The vault slice with this mission's own values laid over it: what the user
 * typed for THIS mission is the most specific answer to a name, as an agent
 * grant beats a project one. The overridden entry leaves the journal list too —
 * its value did not enter the environment.
 */
export function withRequestedSecrets(vault: InjectedSecrets, requested: InjectedSecrets): InjectedSecrets {
  const names = new Set(Object.keys(requested.env));
  if (names.size === 0) return vault;
  return {
    env: { ...vault.env, ...requested.env },
    injected: [...vault.injected.filter((s) => !names.has(s.name)), ...requested.injected],
  };
}
