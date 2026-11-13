/**
 * Consenting, at install, to the secrets and hosts a plugin names (TODO #599,
 * option C, step 3). The manifest declares them (`secrets`, `http.hosts`,
 * step 1); this module shows the superadmin where each one stands on THIS
 * daemon, and turns the boxes they ticked into grants.
 *
 * Same three rules as `exec-grants.ts`:
 *  - what is granted comes from the STAGED manifest, re-read at the click. The
 *    client sends back every line it was shown, with the state it was shown
 *    in; any difference (a secret created or granted meanwhile, a host opened
 *    by hand) is a 409, never a silent substitute;
 *  - a secret is granted only as `agent:plugin:<id>` — never `global`, which no
 *    longer reaches plugins anyway (`secrets/resolve.ts`) — and only on a vault
 *    entry that already exists: a missing one is "to create", never created
 *    here, because its value is not something an install sheet should carry;
 *  - a host lands in `pluginPolicy.http.byPlugin[<id>]`, never in the shared
 *    `allow`, by editing the operator's own `rooks.config.json`. The entry is
 *    REPLACED by what was ticked: hosts consented to for an earlier package of
 *    the same id were never shown for this one.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { CONFIG_FILE, config, loadConfig, setConfig } from '../config/load.js';
import { dbApi, type SecretWithGrants } from '../db.js';
import { vaultEnabled } from '../secrets/availability.js';
import { clearGlobalOnlySecret, pluginSecretTarget } from '../secrets/plugins.js';
import { PLUGIN_AGENT_PREFIX, secretScopeFor, type SecretMode } from '../secrets/resolve.js';
import { grantSecret, revokeSecret, SecretStoreError } from '../secrets/store.js';
import type { PluginManifest } from './manifest.js';
import { hostCovers, pluginHttpHosts } from './policy.js';

/**
 * - `granted`: an entry of this name and mode already reaches the plugin;
 * - `grantable`: exactly one such entry exists, not granted to it yet;
 * - `missing`: none exists — to create on the Secrets page, then grant;
 * - `ambiguous`: several exist (different scopes): which one is a choice the
 *   Secrets page makes, not a checkbox;
 * - `vault-off`: the vault module is disabled, nothing can be read anyway.
 */
export type PluginSecretState = 'granted' | 'grantable' | 'missing' | 'ambiguous' | 'vault-off';

export type PluginSecretRequest = {
  name: string;
  /** As declared: `read` (`ctx.secrets.get`) or `broker` (`ctx.secrets.httpCall`). */
  mode: 'read' | 'broker';
  why: string | null;
  /** A vault entry of this name exists in the mode the plugin needs. */
  present: boolean;
  /** An entry of this name exists only in the other mode (`inject` ↔ `broker`): it would not serve. */
  otherMode: boolean;
  state: PluginSecretState;
};

export type PluginHostRequest = {
  host: string;
  why: string | null;
  /** `global`: `pluginPolicy.http.allow` already opens it to every plugin; `plugin`: `byPlugin[id]` does. */
  allowedBy: 'global' | 'plugin' | null;
};

export type PluginVaultRequests = {
  /** The grant a ticked secret receives (`agent:plugin:<id>`), for the "to create" link. */
  scope: string;
  secrets: PluginSecretRequest[];
  hosts: PluginHostRequest[];
};

/** What the client sends back: each line as it was shown, and whether it was ticked. */
export type VaultConsent = {
  secrets: ReadonlyArray<{ name: string; mode: 'read' | 'broker'; state: PluginSecretState; grant: boolean }>;
  hosts: ReadonlyArray<{ host: string; allowedBy: 'global' | 'plugin' | null; grant: boolean }>;
};

export class VaultGrantError extends Error {
  constructor(readonly code: 'mismatch' | 'not-grantable' | 'conflict', message: string, readonly status: 409) {
    super(message);
    this.name = 'VaultGrantError';
  }
}

type Manifest = Pick<PluginManifest, 'id' | 'secrets' | 'http'>;

const vaultMode = (mode: 'read' | 'broker'): SecretMode => (mode === 'read' ? 'inject' : 'broker');

export function pluginGrantScope(pluginId: string): string {
  return `agent:${PLUGIN_AGENT_PREFIX}${pluginId}`;
}

function secretRows(pluginId: string, name: string, mode: 'read' | 'broker'): {
  rows: SecretWithGrants[]; granted: boolean; otherMode: boolean;
} {
  const all = dbApi.getSecretsByName(name);
  const rows = all.filter((row) => row.mode === vaultMode(mode));
  const target = pluginSecretTarget(pluginId);
  return {
    rows,
    granted: rows.some((row) => secretScopeFor(row, target) !== null),
    otherMode: rows.length === 0 && all.length > 0,
  };
}

/**
 * `takenOver`: this package takes the id from another one (`package-binding.ts`),
 * so what is granted to the id today goes before it runs and is not its own: the
 * lines read as if withdrawn, and a box ticked on them is its own consent.
 */
type VaultViewOptions = { takenOver?: boolean };

/** What the install preview shows; `null` when the manifest names neither. */
export function pluginVaultRequests(manifest: Manifest, view: VaultViewOptions = {}): PluginVaultRequests | null {
  const declared = manifest.secrets ?? [];
  const hosts = manifest.http?.hosts ?? [];
  if (!declared.length && !hosts.length) return null;
  const on = vaultEnabled();
  const allow = config().pluginPolicy.http.allow;
  const own = view.takenOver ? [] : pluginHttpHosts(manifest.id);
  return {
    scope: pluginGrantScope(manifest.id),
    secrets: declared.map((decl) => {
      const found = secretRows(manifest.id, decl.name, decl.mode);
      const state: PluginSecretState = !on ? 'vault-off'
        : found.granted && !view.takenOver ? 'granted'
          : found.rows.length === 0 ? 'missing'
            : found.rows.length > 1 ? 'ambiguous'
              : 'grantable';
      return { name: decl.name, mode: decl.mode, why: decl.why ?? null, present: found.rows.length > 0, otherMode: found.otherMode, state };
    }),
    hosts: hosts.map((decl) => ({
      host: decl.host,
      why: decl.why ?? null,
      allowedBy: allow.some((entry) => hostCovers(entry, decl.host)) ? 'global'
        : own.some((entry) => hostCovers(entry, decl.host)) ? 'plugin'
          : null,
    })),
  };
}

/** The checked consent, ready to write. Computed before anything is written anywhere. */
export type VaultGrantPlan = {
  pluginId: string;
  /** Vault rows to grant to `agent:plugin:<id>`. */
  secrets: Array<{ id: string; name: string }>;
  /** The new `byPlugin[id]`, or `undefined` when the manifest declares no host (left untouched). */
  hosts: string[] | undefined;
};

/**
 * Compares what the client saw with what the daemon computes now, and returns
 * what to write. Any line added, missing or in another state is a mismatch; a
 * ticked secret that cannot be granted is refused, never skipped.
 */
export function planVaultGrants(manifest: Manifest, consent: VaultConsent, view: VaultViewOptions = {}): VaultGrantPlan {
  const now = pluginVaultRequests(manifest, view) ?? { scope: pluginGrantScope(manifest.id), secrets: [], hosts: [] };
  const mismatch = (): VaultGrantError =>
    new VaultGrantError('mismatch', 'the secrets or hosts this plugin asks for changed since they were shown — review them again', 409);

  if (consent.secrets.length !== now.secrets.length || consent.hosts.length !== now.hosts.length) throw mismatch();
  const secrets: VaultGrantPlan['secrets'] = [];
  for (const line of now.secrets) {
    const seen = consent.secrets.filter((s) => s.name === line.name);
    if (seen.length !== 1 || seen[0]!.mode !== line.mode || seen[0]!.state !== line.state) throw mismatch();
    if (!seen[0]!.grant || line.state === 'granted') continue;
    if (line.state !== 'grantable') {
      throw new VaultGrantError('not-grantable', line.state === 'missing'
        ? `the secret ${line.name} is not in the vault — create it on the Secrets page, then grant it to ${now.scope}`
        : `the secret ${line.name} cannot be granted from here — use the Secrets page`, 409);
    }
    const { rows } = secretRows(manifest.id, line.name, line.mode);
    if (rows.length !== 1) throw mismatch();
    secrets.push({ id: rows[0]!.id, name: line.name });
  }
  const hosts: string[] = [];
  for (const line of now.hosts) {
    const seen = consent.hosts.filter((h) => h.host === line.host);
    if (seen.length !== 1 || seen[0]!.allowedBy !== line.allowedBy) throw mismatch();
    if (seen[0]!.grant) hosts.push(line.host);
  }
  return { pluginId: manifest.id, secrets, hosts: now.hosts.length ? hosts : undefined };
}

/** A bundle's child as the consent names it: the same lines, for the package that was shown. */
export type ChildVaultConsent = VaultConsent & { id: string; pkg: string; version: string };

/**
 * One plan per child that names something (TODO #660). Same rule as the
 * plugin's own lines: a child added, missing, or under another package or
 * version is a mismatch, never a silent substitute. `takenOver` per child, as
 * for a package installed alone (TODO #684).
 */
export function planChildVaultGrants(
  children: ReadonlyArray<{ id: string; pkg: string; version: string; manifest: Manifest; takenOver?: boolean }>,
  consent: readonly ChildVaultConsent[],
): VaultGrantPlan[] {
  const mismatch = (): VaultGrantError =>
    new VaultGrantError('mismatch', 'the plugins this bundle brings changed since they were shown — review them again', 409);
  if (consent.length !== children.length) throw mismatch();
  return children.map((child) => {
    const seen = consent.filter((line) => line.id === child.id);
    if (seen.length !== 1 || seen[0]!.pkg !== child.pkg || seen[0]!.version !== child.version) throw mismatch();
    return planVaultGrants(child.manifest, seen[0]!, { takenOver: child.takenOver });
  });
}

/** What a manifest asks for, comparable between the previewed child and the one npm laid down. */
export function vaultRequestsKey(manifest: Pick<PluginManifest, 'secrets' | 'http'>): string {
  return JSON.stringify({
    secrets: (manifest.secrets ?? []).map((s) => `${s.mode}:${s.name}`).sort(),
    hosts: (manifest.http?.hosts ?? []).map((h) => h.host).sort(),
  });
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

function readUserConfig(file: string): Json {
  if (!existsSync(file)) return {};
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the configuration file root must be a JSON object');
  }
  return parsed as Json;
}

/**
 * Sets (or, with `undefined`, removes) `pluginPolicy.http.byPlugin[id]` in the
 * operator's file, refreshes the live config, and returns what it held before.
 */
function writePluginHosts(id: string, hosts: readonly string[] | undefined, file: string): string[] | undefined {
  const cfg = readUserConfig(file);
  const policy = obj(cfg.pluginPolicy);
  const http = obj(policy.http);
  const byPlugin = obj(http.byPlugin);
  const held: unknown = Object.prototype.hasOwnProperty.call(byPlugin, id) ? byPlugin[id] : undefined;
  const before = Array.isArray(held) ? held.filter((h): h is string => typeof h === 'string') : undefined;
  if (hosts && hosts.length) byPlugin[id] = [...hosts];
  else delete byPlugin[id];
  cfg.pluginPolicy = { ...policy, http: { ...http, byPlugin } };
  // Same directory, then rename: the file watchers never read a half-written file.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  renameSync(tmp, file);
  // Replaces too what this process may still hold from a `rooks plugin remove`
  // run in another one (the live config is not re-read on its own).
  if (file === CONFIG_FILE) setConfig(loadConfig(file));
  return before;
}

/** What `rollbackVaultGrants` needs to put things back as they were. */
export type VaultGrantUndo = {
  pluginId: string;
  granted: Array<{ id: string; name: string }>;
  /** `false` when `byPlugin` was not touched. */
  hostsTouched: boolean;
  hostsBefore: string[] | undefined;
};

export type VaultGranted = { secrets: string[]; hosts: string[] };

export function applyVaultGrants(plan: VaultGrantPlan, file: string = CONFIG_FILE): { undo: VaultGrantUndo; granted: VaultGranted } {
  const scope = pluginGrantScope(plan.pluginId);
  const undo: VaultGrantUndo = { pluginId: plan.pluginId, granted: [], hostsTouched: false, hostsBefore: undefined };
  try {
    for (const secret of plan.secrets) {
      grantSecret(secret.id, scope);
      undo.granted.push(secret);
      clearGlobalOnlySecret(plan.pluginId, secret.name);
    }
    if (plan.hosts !== undefined) {
      undo.hostsBefore = writePluginHosts(plan.pluginId, plan.hosts, file);
      undo.hostsTouched = true;
    }
  } catch (err) {
    rollbackVaultGrants(undo, file);
    if (err instanceof SecretStoreError && err.code === 'duplicate') {
      throw new VaultGrantError('conflict', `${err.message} — resolve it on the Secrets page`, 409);
    }
    throw err;
  }
  return { undo, granted: { secrets: plan.secrets.map((s) => s.name), hosts: plan.hosts ?? [] } };
}

/** The plugin did not land: the consent was for it, not for the machine. */
export function rollbackVaultGrants(undo: VaultGrantUndo, file: string = CONFIG_FILE): void {
  const scope = pluginGrantScope(undo.pluginId);
  for (const secret of undo.granted) {
    try { revokeSecret(secret.id, scope); } catch { /* deleted meanwhile: nothing left to revoke */ }
  }
  if (undo.hostsTouched) writePluginHosts(undo.pluginId, undo.hostsBefore, file);
}
