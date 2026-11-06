/**
 * The vault itself: the layer that turns the sealed rows of `secrets` (S.3)
 * into something the HTTP routes, the CLI and the migration can use, without
 * any of them ever touching the master key or the wire format.
 *
 * One rule shapes every signature below: **nothing here returns a plaintext
 * value to a caller that could hand it to a client**. `readSecretValue` exists
 * because the daemon has to decrypt at some point — injection (S.4), broker
 * (S.8), `ctx.secrets.get` / `readPluginSecret` (S.9) — but it is deliberately
 * absent from everything the routes expose, and `toPublicSecret` is the only
 * projection the surfaces are allowed to publish.
 *
 * The other rule is §4.4: a failure to resolve the master key is an error, not
 * an invitation to make a new one. Every entry point that needs the key funnels
 * through `vaultKey()`, which asks S.1 to refuse creation as soon as one
 * encrypted row exists.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { db, dbApi, type SecretWithGrants } from '../db.js';
import { portablePath } from '../paths.js';
import { SECRETS_FILE, parseEnvFile } from '../secrets.js';
import { generateSecretValue, type GenerateAlphabet } from './generate.js';
import { replaceSealedColumnRows, sealedColumnRows } from './sealed-columns.js';
import { ENVELOPE_PREFIX, MASTER_KEY_BYTES, isSealed, open, seal, type SecretIdentity } from './box.js';
import {
  clearPendingKey,
  promotePendingKey,
  readKeyringMasterKey,
  readMasterKey,
  readPendingKey,
  resolveMasterKey,
  writePendingKey,
  type MasterKeyOptions,
} from './key.js';
import {
  isBackendReserved,
  isSecretMode,
  isSecretScopeKind,
  isValidSecretName,
  secretScopeFor,
  type SecretGrant,
  type SecretMode,
  type SecretScopeKind,
  type SecretTarget,
} from './resolve.js';

export type SecretStoreErrorCode =
  /** The name is not an environment variable identifier (§3.6). */
  | 'invalid-name'
  /** Neither `inject` nor `broker`. */
  | 'invalid-mode'
  /** Not `global`, `project:<slug>`, `agent:<name>` or `backend:<id>`. */
  | 'invalid-scope'
  /** `mode: 'broker'` without the spec that says what the daemon may call (§6.2). */
  | 'broker-spec-required'
  /** No row with this id. */
  | 'not-found'
  /** A value was expected and none was given. */
  | 'value-required'
  /** Same name at the same grant as another secret (§5.3). */
  | 'duplicate'
  /** The master key could not be resolved: degraded mode, never a new key (§4.4). */
  | 'unavailable';

export class SecretStoreError extends Error {
  constructor(readonly code: SecretStoreErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SecretStoreError';
  }
}

/**
 * What a client is allowed to see. No `value`, no `value_enc`: even the sealed
 * envelope stays inside the daemon, because publishing it would turn a stolen
 * master key into a full compromise without any database access.
 */
export interface PublicSecret {
  id: string;
  name: string;
  mode: SecretMode;
  grants: SecretGrant[];
  /** A value is stored. `false` describes a row waiting to be filled in. */
  configured: boolean;
  note: string | null;
  broker_spec: string | null;
  created_at: number;
  updated_at: number;
}

export function toPublicSecret(row: SecretWithGrants): PublicSecret {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    grants: row.grants,
    configured: row.value_enc.length > 0,
    note: row.note,
    broker_spec: row.broker_spec,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * The master key, or a typed refusal. Creation is allowed only while nothing is
 * encrypted yet — the moment one sealed row exists, an absent key means a lost
 * key, and a fresh one would orphan every secret at once.
 */
/** The recovery is a boot-time question, but every entry point funnels through
 *  `vaultKey()`, so it is answered there — once per process. */
let rotationChecked = false;

/** Test seam: a fresh process would re-run the recovery, a test must be able to. */
export function resetRotationCheck(): void {
  rotationChecked = false;
}

/** Prefix of `plugin_kv` keys that hold manifest settings. Same marker as
 *  `SETTINGS_PREFIX` in `plugins/context.ts` — sealed envelopes live only
 *  there; a plugin's free storage is opaque JSON and is never a witness. */
export const PLUGIN_SETTING_KV_PREFIX = '@settings/';
/** Secrets a user deposited for a plugin connection (`plugins/user-connections.ts`). */
export const PLUGIN_CONNECTION_KV_PREFIX = '@connections/';

/** Every sealed `plugin_kv` row a rotation must carry to the new key. */
function sealedPluginKv(): { plugin_id: string; key: string; value: string }[] {
  return [PLUGIN_SETTING_KV_PREFIX, PLUGIN_CONNECTION_KV_PREFIX].flatMap((prefix) => dbApi.pluginKvListSealed(ENVELOPE_PREFIX, prefix));
}

export function pluginKvIdentity(pluginId: string, kvKey: string): SecretIdentity {
  return { secretId: `plugin_kv:${pluginId}`, name: kvKey };
}

/**
 * Seal/open a payload that is not a `secrets` row — today, a plugin setting of
 * type `secret` stored in `plugin_kv`. Funnelled through `vaultKey()` so a
 * rotation recovery runs first and a missing key never silently creates one.
 */
export function sealWithVault(plain: string, identity: SecretIdentity): string {
  return seal(plain, vaultKey(), identity);
}

export function openWithVault(envelope: string, identity: SecretIdentity): string {
  return isSealed(envelope) ? open(envelope, vaultKey(), identity) : envelope;
}

/**
 * The probe dual-location choice and rotation recovery share. Exported so
 * `secretsEnvFor` (which reads the key without going through `vaultKey`)
 * asks the same question instead of guessing by priority. Sealed plugin
 * settings count: a vault that holds only those must still pick by witness.
 */
export function masterKeyWitness(): {
  hasEncryptedSecrets: () => boolean;
  opensWithWitness: (key: Buffer) => boolean;
} {
  return {
    hasEncryptedSecrets: () => findSealedWitness() !== undefined,
    opensWithWitness: (key) => {
      const witness = findSealedWitness();
      return witness !== undefined && witnessOpensWith(witness, key);
    },
  };
}

function vaultKey(): Buffer {
  if (!rotationChecked) {
    // Set before the call, not after: a genuinely unrecoverable vault must
    // report that once per operation, not loop on the same probe.
    rotationChecked = true;
    recoverVaultRotation();
  }
  try {
    return resolveMasterKey(masterKeyWitness());
  } catch (e) {
    throw new SecretStoreError('unavailable', `secrets vault unavailable: ${(e as Error).message}`, e);
  }
}

/** `global`, `project:<slug>`, `agent:<name>`, `backend:<id>` — the CLI and UI wire format. */
export function parseSecretScope(spec: string): SecretGrant {
  const trimmed = spec.trim();
  if (trimmed === 'global') return { scope_kind: 'global', scope_ref: null };
  const sep = trimmed.indexOf(':');
  const kind = sep < 0 ? '' : trimmed.slice(0, sep);
  const ref = sep < 0 ? '' : trimmed.slice(sep + 1).trim();
  if (!isSecretScopeKind(kind) || kind === 'global' || !ref) {
    throw new SecretStoreError('invalid-scope', `invalid scope: ${spec} (expected global, project:<slug>, agent:<name> or backend:<id>)`);
  }
  return { scope_kind: kind, scope_ref: ref };
}

export function formatSecretScope(grant: SecretGrant): string {
  return grant.scope_kind === 'global' ? 'global' : `${grant.scope_kind}:${grant.scope_ref}`;
}

function grantEquals(a: SecretGrant, b: SecretGrant): boolean {
  return a.scope_kind === b.scope_kind && a.scope_ref === b.scope_ref;
}

/**
 * §5.3: the name is not unique globally, but name × one grant is. Two rows
 * sharing both would make resolution depend on a tie-breaker — a data-entry
 * error, never a use case. The check is applicative because it is a join
 * (`secrets` × `secret_grants`); an index cannot express it. `exceptId` is
 * the row being updated, so a secret does not collide with itself.
 */
function assertNoNameScopeConflict(
  name: string,
  grants: readonly SecretGrant[],
  exceptId?: string,
): void {
  if (grants.length === 0) return;
  for (const other of dbApi.getSecretsByName(name)) {
    if (exceptId && other.id === exceptId) continue;
    const overlap = other.grants.filter((g) => grants.some((wanted) => grantEquals(g, wanted)));
    if (overlap.length === 0) continue;
    const scopes = overlap.map(formatSecretScope).join(', ');
    throw new SecretStoreError(
      'duplicate',
      `secret ${name} already exists at ${scopes} (${other.id})`,
    );
  }
}

function assertName(name: string): void {
  if (!isValidSecretName(name)) {
    throw new SecretStoreError('invalid-name', `invalid secret name: ${name} (expected ^[A-Z][A-Z0-9_]*$)`);
  }
}

function assertMode(mode: string, brokerSpec: string | null | undefined): asserts mode is SecretMode {
  if (!isSecretMode(mode)) throw new SecretStoreError('invalid-mode', `invalid secret mode: ${mode}`);
  // A broker with no spec would be a secret nothing can use and nothing can
  // audit: the daemon would not know which call it is allowed to make on the
  // agent's behalf. Refuse at the write rather than at the first call.
  if (mode === 'broker' && !brokerSpec) {
    throw new SecretStoreError('broker-spec-required', 'mode broker requires broker_spec');
  }
}

function normalizeBrokerSpec(spec: unknown): string | null {
  if (spec === undefined || spec === null || spec === '') return null;
  return typeof spec === 'string' ? spec : JSON.stringify(spec);
}

export interface CreateSecretInput {
  name: string;
  value: string;
  mode?: SecretMode;
  broker_spec?: unknown;
  note?: string | null;
  grants?: readonly (SecretGrant | string)[];
}

function toGrant(grant: SecretGrant | string): SecretGrant {
  if (typeof grant === 'string') return parseSecretScope(grant);
  if (!isSecretScopeKind(grant.scope_kind)) {
    throw new SecretStoreError('invalid-scope', `invalid scope kind: ${String(grant.scope_kind)}`);
  }
  if (grant.scope_kind !== 'global' && !grant.scope_ref) {
    throw new SecretStoreError('invalid-scope', `scope ${grant.scope_kind} requires a reference`);
  }
  return { scope_kind: grant.scope_kind, scope_ref: grant.scope_kind === 'global' ? null : grant.scope_ref };
}

/**
 * Create a secret. The id is drawn BEFORE sealing on purpose: it is half of the
 * AAD (§4.1), so the envelope cannot be produced without knowing which row it
 * will live in — which is exactly what makes a copied blob undecipherable.
 */
export function createSecret(input: CreateSecretInput): PublicSecret {
  assertName(input.name);
  const mode: string = input.mode ?? 'inject';
  const brokerSpec = normalizeBrokerSpec(input.broker_spec);
  assertMode(mode, brokerSpec);
  if (typeof input.value !== 'string' || input.value.length === 0) {
    throw new SecretStoreError('value-required', 'a value is required');
  }
  const grants = (input.grants ?? []).map(toGrant);
  assertNoNameScopeConflict(input.name, grants);
  const key = vaultKey();
  const id = randomUUID();
  const value_enc = seal(input.value, key, { secretId: id, name: input.name });
  const row = dbApi.createSecret({ id, name: input.name, value_enc, mode, broker_spec: brokerSpec, note: input.note ?? null });
  for (const grant of grants) dbApi.addSecretGrant(id, grant.scope_kind, grant.scope_ref);
  return toPublicSecret({ ...row, grants: dbApi.listSecretGrants(id) });
}

export interface ProvisionSecretInput {
  name: string;
  /** Exactly one of `value` / `generate`. */
  value?: string;
  generate?: { length?: number; alphabet?: GenerateAlphabet };
  note?: string | null;
  /** Who deposited it — recorded in the note and the journal, never trusted for scoping. */
  by: { agent: string | null; missionId: string | null };
}

/**
 * An agent deposits a NEW secret. Deliberately narrower than `createSecret`:
 * - the name must not exist at all, under any scope — an agent can neither
 *   replace a value nor shadow a name a human relies on;
 * - no grant: the secret stays daemon-only until an operator opens it;
 * - provenance is stamped in the note, so the operator sees who made it;
 * - the journal records the deposit (never the value).
 */
export function provisionSecret(input: ProvisionSecretInput): { secret: PublicSecret; generated: boolean } {
  assertName(input.name);
  if (dbApi.getSecretsByName(input.name).length > 0) {
    throw new SecretStoreError('duplicate', `a secret named ${input.name} already exists`);
  }
  const generated = input.value === undefined;
  const value = input.value ?? generateSecretValue(input.generate?.length, input.generate?.alphabet);
  const stamp = `created by ${input.by.agent ?? 'the daemon'}${input.by.missionId ? ` (mission ${input.by.missionId})` : ''}, ${generated ? 'generated by the daemon' : 'value supplied by the agent'}`;
  const secret = createSecret({
    name: input.name,
    value,
    note: input.note ? `${input.note} — ${stamp}` : stamp,
  });
  dbApi.recordSecretAccess({
    secret_id: secret.id,
    name: secret.name,
    mission_id: input.by.missionId,
    agent: input.by.agent,
    kind: 'create',
    outcome: 'ok',
    detail: generated ? 'generated' : 'supplied',
  });
  return { secret, generated };
}

export interface UpdateSecretInput {
  value?: string;
  name?: string;
  mode?: SecretMode;
  broker_spec?: unknown;
  note?: string | null;
  /** When present, replaces the grant set wholesale. Absent leaves it alone. */
  grants?: readonly (SecretGrant | string)[];
}

/**
 * Replace the value and/or the metadata.
 *
 * Renaming reseals: the name is bound into the envelope, so keeping the old
 * ciphertext under a new name would produce a row that can never be opened
 * again. The plaintext is read back and resealed under the new identity.
 */
export function updateSecret(id: string, patch: UpdateSecretInput): PublicSecret {
  const current = dbApi.getSecret(id);
  if (!current) throw new SecretStoreError('not-found', `unknown secret: ${id}`);
  if (patch.name !== undefined) assertName(patch.name);
  const name = patch.name ?? current.name;
  const brokerSpec = patch.broker_spec === undefined ? current.broker_spec : normalizeBrokerSpec(patch.broker_spec);
  const mode: string = patch.mode ?? current.mode;
  assertMode(mode, brokerSpec);
  const wantedGrants = patch.grants !== undefined ? patch.grants.map(toGrant) : current.grants;
  assertNoNameScopeConflict(name, wantedGrants, id);

  let value_enc: string | undefined;
  if (patch.value !== undefined) {
    if (typeof patch.value !== 'string' || patch.value.length === 0) {
      throw new SecretStoreError('value-required', 'a value is required');
    }
    value_enc = seal(patch.value, vaultKey(), { secretId: id, name });
  } else if (name !== current.name) {
    const key = vaultKey();
    const plain = openRow(current, key);
    value_enc = seal(plain, key, { secretId: id, name });
  }

  dbApi.updateSecret(id, {
    name,
    mode,
    broker_spec: brokerSpec,
    note: patch.note === undefined ? current.note : patch.note,
    ...(value_enc === undefined ? {} : { value_enc }),
  });

  if (patch.grants !== undefined) {
    const wanted = patch.grants.map(toGrant);
    for (const existing of dbApi.listSecretGrants(id)) {
      dbApi.removeSecretGrant(id, existing.scope_kind, existing.scope_ref);
    }
    for (const grant of wanted) dbApi.addSecretGrant(id, grant.scope_kind, grant.scope_ref);
  }
  return toPublicSecret(dbApi.getSecret(id)!);
}

/**
 * The grants a write would ADD to secret `id` (all of `wanted` for a secret not
 * stored yet). Routes use it to tell a grant decision from an edit that only
 * resends the grants it found: the first is superadmin-only, the second is not.
 */
export function grantsAddedBy(id: string | null, wanted: readonly (SecretGrant | string)[]): SecretGrant[] {
  const current = id ? dbApi.getSecret(id)?.grants ?? [] : [];
  return wanted.map(toGrant).filter((grant) => !current.some((g) => grantEquals(g, grant)));
}

/**
 * Whether replacing the grants of `id` by `wanted` lifts its reservation to a
 * backend while leaving an audience: `backend:X` + `project:P` would then enter
 * every mission of `P`, on any backend (TODO #531, 5-B). That WIDENS the key, so
 * unlike dropping any other grant it is a decision: superadmin, as for adding one.
 * Dropping everything leaves the key to the daemon: that narrows it.
 */
export function liftsBackendReservation(id: string, wanted: readonly (SecretGrant | string)[]): boolean {
  const current = dbApi.getSecret(id);
  if (!current || !isBackendReserved(current)) return false;
  const next = wanted.map(toGrant);
  return next.length > 0 && !isBackendReserved({ grants: next });
}

/** `liftsBackendReservation` for the revocation of a single grant. */
export function revokeLiftsBackendReservation(id: string, scope: SecretGrant | string): boolean {
  const current = dbApi.getSecret(id);
  if (!current) return false;
  const revoked = toGrant(scope);
  return liftsBackendReservation(id, current.grants.filter((grant) => !grantEquals(grant, revoked)));
}

export function deleteSecret(id: string): boolean {
  return dbApi.deleteSecret(id);
}

export function grantSecret(id: string, scope: SecretGrant | string): PublicSecret {
  const current = dbApi.getSecret(id);
  if (!current) throw new SecretStoreError('not-found', `unknown secret: ${id}`);
  const grant = toGrant(scope);
  assertNoNameScopeConflict(current.name, [...current.grants, grant], id);
  dbApi.addSecretGrant(id, grant.scope_kind, grant.scope_ref);
  return toPublicSecret(dbApi.getSecret(id)!);
}

export function revokeSecret(id: string, scope: SecretGrant | string): PublicSecret {
  if (!dbApi.getSecret(id)) throw new SecretStoreError('not-found', `unknown secret: ${id}`);
  const grant = toGrant(scope);
  dbApi.removeSecretGrant(id, grant.scope_kind, grant.scope_ref);
  return toPublicSecret(dbApi.getSecret(id)!);
}

/**
 * The listing, optionally narrowed to what a mission would see. Unlike
 * `resolveSecretsFor`, `broker` secrets are kept: this is an inventory for a
 * human, not an injection — hiding them would make the page lie about what the
 * daemon holds for that project.
 */
export function listSecrets(target?: SecretTarget): PublicSecret[] {
  const rows = dbApi.listSecrets();
  const filtered = target && (target.agent || target.project)
    ? rows.filter((row) => secretScopeFor({ ...row, grants: row.grants }, target) !== null)
    : rows;
  return filtered.map(toPublicSecret);
}

export function getSecret(id: string): PublicSecret | undefined {
  const row = dbApi.getSecret(id);
  return row ? toPublicSecret(row) : undefined;
}

function openRow(row: SecretWithGrants, key: Buffer): string {
  // A row that predates the vault (or a lazy plugin_kv copy that was never
  // sealed) is stored in the clear and is returned as-is. `isSealed` is the
  // discriminator, not a guess: calling `open()` on plaintext would throw
  // `bad-envelope` and drop a valid secret.
  return isSealed(row.value_enc) ? open(row.value_enc, key, { secretId: row.id, name: row.name }) : row.value_enc;
}

/**
 * Decrypt. No tool or CLI command exposes it — the injection (S.4), the broker
 * (S.8), and `ctx.secrets.get` / `readPluginSecret` (S.9) are the legitimate
 * callers, plus ONE route: `POST /api/secrets/:id/reveal`, a session-only,
 * superadmin-only, password-gated human gesture (amended 16/10/2026).
 */
export function readSecretValue(id: string): string {
  const row = dbApi.getSecret(id);
  if (!row) throw new SecretStoreError('not-found', `unknown secret: ${id}`);
  return openRow(row, vaultKey());
}

/**
 * Any sealed envelope. Cleartext leftovers (the lazy `plugin_kv` migration of
 * §10.4) "open" under any key and must not be used as a witness. Plugin
 * settings of type `secret` are eligible: they are sealed with the same
 * master key, and a vault that holds only those (no `secrets` row yet) must
 * still recover a rotation and still pick a live location.
 */
function findSealedWitness(): { envelope: string; identity: SecretIdentity } | undefined {
  const secret = dbApi.listSecrets().find((row) => isSealed(row.value_enc));
  if (secret) return { envelope: secret.value_enc, identity: { secretId: secret.id, name: secret.name } };
  const setting = sealedPluginKv()[0];
  if (setting) return { envelope: setting.value, identity: pluginKvIdentity(setting.plugin_id, setting.key) };
  const column = sealedColumnRows()[0];
  if (column) return { envelope: column.envelope, identity: column.spec.identity(column.key) };
  return undefined;
}

/**
 * The probe dual-location choice (§4.2) and rotation recovery (§4.5) share.
 * Two implementations of "does this key open that envelope" would diverge.
 */
function witnessOpensWith(witness: { envelope: string; identity: SecretIdentity }, key: Buffer): boolean {
  try {
    open(witness.envelope, key, witness.identity);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recover a rotation the process did not finish (§4.5).
 *
 * The candidate file is the only trace a rotation leaves; there is no rotation
 * state in the database, deliberately — a flag could itself be written at the
 * wrong moment. So the answer is read off the data: take one sealed envelope
 * as a witness and see which of the live keys, or the candidate, opens it.
 *
 * The live key may sit in the file or in the OS keyring. Probe them
 * read-only — `pickLiveKey` would delete the loser while a pending
 * candidate is still on disk, and a rotation in flight is not the
 * moment to drop a location. Order, no writes on live locations:
 *   1. the file opens the witness → drop the candidate
 *   2. else the keyring opens it → same
 *   3. else the candidate opens it → promote
 *   4. else unrecoverable, nothing written, nothing deleted
 *
 * Short-circuit: a file that already opens never reaches `getHost()`
 * (the rotation tests that only exercise the file stay off the
 * secret-tool probe).
 *
 * The witness MUST be a sealed envelope. A cleartext row "opens" under any
 * key, so using one as witness would conclude "the commit never happened",
 * drop the candidate, and strand every genuinely sealed row under a key that
 * no longer exists. Plugin settings of type `secret` are eligible: they are
 * sealed with the same master key, and a vault that holds only those (no
 * `secrets` row yet) must still recover a rotation.
 */
export function recoverVaultRotation(opts: MasterKeyOptions = {}): 'none' | 'discarded' | 'promoted' {
  const pending = readPendingKey();
  if (!pending) return 'none';
  const witness = findSealedWitness();
  // No sealed envelope: nothing was at stake, whichever step we died in.
  if (!witness) {
    clearPendingKey();
    return 'discarded';
  }
  // Each live location is probed independently. Its own absence is not
  // fatal here: step 3 may have been interrupted in a way that left no
  // readable key at all, and the candidate is then the only thing that
  // can still open the vault.
  let fileKey: Buffer | null = null;
  try {
    fileKey = readMasterKey();
  } catch {
    fileKey = null;
  }
  if (fileKey && witnessOpensWith(witness, fileKey)) {
    // Step 2 never committed: the rows are still under the old key.
    clearPendingKey();
    return 'discarded';
  }
  let keyringKey: Buffer | null = null;
  try {
    keyringKey = readKeyringMasterKey(opts);
  } catch {
    keyringKey = null;
  }
  if (keyringKey && witnessOpensWith(witness, keyringKey)) {
    clearPendingKey();
    return 'discarded';
  }
  if (witnessOpensWith(witness, pending)) {
    // Step 2 committed, step 3 did not. Finish the rename.
    promotePendingKey();
    return 'promoted';
  }
  throw new SecretStoreError(
    'unavailable',
    'secrets vault unrecoverable: neither the current key nor the rotation candidate opens the stored rows. '
    + 'Nothing has been written (§4.4: a key is never regenerated). Restore a key from a backup.',
  );
}

/** Internal seam for the crash-window test, and nothing else: it is the only
 *  way to observe a death between the commit and the promotion without killing
 *  the test runner. Never set by production code. */
export interface RekeyOptions {
  afterCommit?: () => void;
}

/**
 * Key rotation (§4.5): write-ahead, then promote.
 *
 * 1. the new key is staged in `secret-key.next` — nothing is committed yet;
 * 2. every envelope is resealed under it in ONE transaction, and committed;
 * 3. the candidate is promoted onto `secret-key` by an atomic `rename`.
 *
 * The staging in step 1 is what makes the crash between 2 and 3 survivable: the
 * key the rows are now under still exists on disk, so `recoverVaultRotation`
 * can find it and finish the job. Writing the key only after the commit — the
 * first version of this function — left a window in which SQLite held rows
 * sealed under a key that existed nowhere. Two systems, no shared transaction.
 */
export function rekeyVault(opts: RekeyOptions = {}): { rotated: number } {
  const oldKey = vaultKey();
  const rows = dbApi.listSecrets();
  const pluginKv = sealedPluginKv();
  const newKey = randomBytes(MASTER_KEY_BYTES);
  const resealed = rows.map((row) => ({
    id: row.id,
    // Decryption happens here, before anything is staged: a row that cannot be
    // opened must abort the rotation, not leave the table half-rotated.
    value_enc: seal(openRow(row, oldKey), newKey, { secretId: row.id, name: row.name }),
  }));
  const resealedKv = pluginKv.map((row) => {
    const identity = pluginKvIdentity(row.plugin_id, row.key);
    return {
      plugin_id: row.plugin_id,
      key: row.key,
      value: seal(open(row.value, oldKey, identity), newKey, identity),
    };
  });
  const resealedColumns = sealedColumnRows().map((row) => {
    const identity = row.spec.identity(row.key);
    return { ...row, envelope: seal(open(row.envelope, oldKey, identity), newKey, identity) };
  });
  writePendingKey(newKey);
  try {
    // One commit for every envelope, whatever table holds it.
    db.transaction(() => {
      dbApi.replaceSecretEnvelopes(resealed, resealedKv);
      replaceSealedColumnRows(resealedColumns);
    })();
  } catch (e) {
    // The commit failed, so the rows are still under the old key: the candidate
    // is now noise, and leaving it would make the next boot probe for nothing.
    clearPendingKey();
    throw e;
  }
  opts.afterCommit?.();
  promotePendingKey();
  return { rotated: resealed.length + resealedKv.length + resealedColumns.length };
}

export interface ImportEnvResult {
  imported: string[];
  skipped: string[];
  deletedSource: boolean;
}

/**
 * Migration §10: pull `~/.timon/secrets.env` into the vault **with no grant at
 * all**, so every imported key belongs to the daemon alone. That is the whole
 * security gain of the step — until now those variables reached every agent
 * through `process.env`.
 *
 * The file is NOT deleted: `loadSecretsAtBoot` keeps feeding the daemon's own
 * environment from it, and the user widens the grants one secret at a time, watching
 * what breaks. Only `--delete-source` removes it, once he is satisfied.
 */
export function importSecretsEnv(opts: { file?: string; deleteSource?: boolean } = {}): ImportEnvResult {
  const file = opts.file ?? SECRETS_FILE;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return { imported: [], skipped: [], deletedSource: false };
  }
  const existing = new Set(dbApi.listSecrets().map((row) => row.name));
  const imported: string[] = [];
  const skipped: string[] = [];
  for (const [name, value] of Object.entries(parseEnvFile(raw))) {
    // Re-running the import must not pile a second row per key: a name already
    // in the vault is left alone, whatever its scope, because re-importing
    // would silently overwrite a value the user may have rotated by hand.
    if (existing.has(name) || !isValidSecretName(name) || value.length === 0) {
      skipped.push(name);
      continue;
    }
    createSecret({ name, value, mode: 'inject', note: `imported from ${portablePath(file)}` });
    imported.push(name);
  }
  let deletedSource = false;
  if (opts.deleteSource) {
    rmSync(file, { force: true });
    deletedSource = true;
  }
  return { imported, skipped, deletedSource };
}

/** Import + log. Names only, never values — the journal must not reopen the
 *  door the `secrets` zone closes. */
export function importSecretsEnvAtBoot(file: string = SECRETS_FILE): ImportEnvResult {
  const result = importSecretsEnv({ file });
  if (result.imported.length) {
    console.log(
      `[secrets] ${result.imported.length} key(s) imported into the vault from ${portablePath(file)}`
      + ` (daemon only, no grant): ${result.imported.join(', ')}`,
    );
  }
  return result;
}
