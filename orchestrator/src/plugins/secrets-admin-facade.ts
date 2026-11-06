/**
 * `ctx.secrets.list / set / grant / revoke / httpCall`: the vault from a
 * plugin, on top of the existing `get` (`secrets:read`, which only ever
 * returns a value the plugin was GRANTED).
 *
 * Nothing here returns a value. `list` gives names, modes and grants; `set`
 * and `httpCall` take a value in or act with one, never hand it back. The
 * rules, each one closing a way round the grant model:
 *
 *  - `set` CREATES a name that does not exist, with no grant (daemon-only).
 *    An existing secret changes only if this plugin created it
 *    (`secrets.created_by`) or the caller of the request is a superadmin; a
 *    name held at several scopes is a `conflict`, resolved in the Secrets page.
 *  - `grant` and `revoke` are a superadmin's, in a request: a job and a plain
 *    `secrets:manage` account are refused (the route says the same for grant;
 *    revoke gets the same guard here).
 *  - `grant` never targets `global`, `agent:plugin:*` nor `backend:*`, and
 *    `revoke` never lifts a `backend:*` reservation (that would widen a key). A `global` grant
 *    reaches every agent, and `agent:plugin:<id>` is a plugin's own address —
 *    the only grant `get` honours for a plugin (TODO #531, 1-B): either would
 *    let a plugin hand out, or read, a value it was never given.
 *  - `httpCall` goes through `brokerHttpCall` as the agent `plugin:<id>`, the
 *    address `get` uses. It needs `http:outbound` too (checked by the
 *    context), and the call is the INTERSECTION of three things (TODO #531,
 *    4-B): the grant `agent:plugin:<id>` (a `global` one does not reach a
 *    plugin), the identity's own hosts, and `pluginPolicy.http.allow`, checked
 *    on the final URL before the value is opened. Redirects are not followed,
 *    the value is masked in the answer, and every call is journalled.
 */
import { z } from 'zod';
import { dbApi, type SecretWithGrants } from '../db.js';
import { BrokerDeniedError, brokerHttpCall } from '../secrets/broker.js';
import { isValidSecretName, secretScopeFor, type SecretGrant } from '../secrets/resolve.js';
import {
  createSecret, formatSecretScope, parseSecretScope, revokeSecret, grantSecret, SecretStoreError, toPublicSecret, updateSecret,
  type PublicSecret,
} from '../secrets/store.js';
import { noteGlobalOnlySecret, pluginSecretTarget } from '../secrets/plugins.js';
import { assertFetchAllowed, PluginPolicyError } from './policy.js';
import {
  auditPluginAction, parseAdminInput, PluginAdminError, type AdminCallerScope,
} from './admin-support.js';

import type {
  PluginSecretInfo, PluginSecretInput, PluginHttpCallInput, PluginHttpCallResult,
} from './contract/secrets.js';
export type {
  PluginSecretInfo, PluginSecretInput, PluginHttpCallInput, PluginHttpCallResult,
} from './contract/secrets.js';

export type ScopedSecretsAdmin = {
  list(): PluginSecretInfo[];
  set(input: PluginSecretInput): PluginSecretInfo;
  grant(name: string, scope: string): PluginSecretInfo;
  revoke(name: string, scope: string): PluginSecretInfo;
  httpCall(request: PluginHttpCallInput): Promise<PluginHttpCallResult>;
};

const NameSchema = z.string().min(1).max(128);
const SetSchema = z.object({
  name: NameSchema,
  value: z.string().min(1).max(4096),
  note: z.string().max(200).optional(),
  mode: z.enum(['inject', 'broker']).optional(),
  brokerSpec: z.unknown().optional(),
}).strict();
const ScopeSchema = z.string().min(1).max(300);
const HttpCallSchema = z.object({
  identity: NameSchema,
  path: z.string().min(1).max(4096),
  method: z.string().min(1).max(16).optional(),
  host: z.string().min(1).max(253).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
}).strict();

const BROKER_CODE: Record<string, ConstructorParameters<typeof PluginAdminError>[0]> = {
  'unknown-identity': 'not_found',
  'no-grant': 'forbidden',
  'host-denied': 'forbidden',
  'policy-denied': 'forbidden',
  'wrong-type': 'invalid',
  'bad-request': 'invalid',
  'bad-spec': 'unavailable',
};

function storeError(err: unknown): PluginAdminError {
  if (err instanceof SecretStoreError) {
    const code = err.code === 'not-found' ? 'not_found'
      : err.code === 'duplicate' ? 'conflict'
      : err.code === 'unavailable' ? 'unavailable'
      : 'invalid';
    return new PluginAdminError(code, err.message, err.code);
  }
  // Anything else may have been built out of what was handed in, value included.
  return new PluginAdminError('unavailable', 'the vault could not complete this');
}

export function secretsAdminFor(scope: AdminCallerScope): ScopedSecretsAdmin {
  const origin = `plugin:${scope.pluginId}`;

  const view = (s: PublicSecret): PluginSecretInfo => ({
    id: s.id,
    name: s.name,
    mode: s.mode,
    grants: s.grants.map(formatSecretScope),
    configured: s.configured,
    note: s.note,
    mine: dbApi.secretCreatedBy(s.id) === origin,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  });

  /** A job reaches what it deposited and what was granted to it by name, nothing else. */
  const visible = (row: SecretWithGrants): boolean =>
    !scope.job || dbApi.secretCreatedBy(row.id) === origin || secretScopeFor(row, pluginSecretTarget(scope.pluginId)) !== null;

  /** The ONE row named `name`, or a typed refusal. Another's row answers like a missing one. */
  const rowNamed = (raw: unknown): SecretWithGrants => {
    const name = parseAdminInput(NameSchema, raw);
    const rows = dbApi.getSecretsByName(name).filter(visible);
    if (rows.length === 0) throw new PluginAdminError('not_found', `no secret named ${name}`);
    if (rows.length > 1) throw new PluginAdminError('conflict', `${name} exists at several scopes: use the Secrets page`);
    return rows[0]!;
  };

  /** The operator's network ceiling for this plugin, the one `ctx.fetch` obeys. */
  const ceiling = (url: URL): string | null => {
    try {
      assertFetchAllowed(scope.pluginId, url);
      return null;
    } catch (err) {
      if (err instanceof PluginPolicyError) return err.message;
      throw err;
    }
  };

  const needSuperadmin = (what: string): void => {
    if (scope.job || !scope.superadmin) throw new PluginAdminError('forbidden', `${what} is a superadmin's, from a request`);
  };

  return {
    list() {
      return dbApi.listSecrets().filter(visible).map((row) => view(toPublicSecret(row)));
    },

    set(input) {
      const fields = parseAdminInput(SetSchema, input);
      if (!isValidSecretName(fields.name)) {
        throw new PluginAdminError('invalid', `invalid secret name: ${fields.name} (expected ^[A-Z][A-Z0-9_]*$)`);
      }
      const existing = dbApi.getSecretsByName(fields.name);
      try {
        if (existing.length === 0) {
          const secret = createSecret({
            name: fields.name,
            value: fields.value,
            mode: fields.mode,
            broker_spec: fields.brokerSpec,
            note: fields.note ? `${fields.note} — created by plugin ${scope.pluginId}` : `created by plugin ${scope.pluginId}`,
          });
          dbApi.setSecretCreatedBy(secret.id, origin);
          dbApi.recordSecretAccess({ secret_id: secret.id, name: secret.name, agent: origin, kind: 'create', outcome: 'ok', detail: 'supplied by a plugin' });
          auditPluginAction(scope, 'secret.create', `secret:${secret.id}`);
          return view({ ...secret });
        }
        if (existing.length > 1) {
          throw new PluginAdminError('conflict', `${fields.name} exists at several scopes: use the Secrets page`);
        }
        const row = existing[0]!;
        // A name a job cannot reach is taken all the same: creating it must say so.
        if (!visible(row)) throw new PluginAdminError('conflict', `a secret named ${fields.name} already exists`);
        // A request that is neither a superadmin's nor about this plugin's own
        // secret is refused.
        if (!scope.superadmin && dbApi.secretCreatedBy(row.id) !== origin) {
          throw new PluginAdminError('forbidden', `secret ${fields.name} was not created by this plugin`);
        }
        const secret = updateSecret(row.id, { value: fields.value, ...(fields.note === undefined ? {} : { note: fields.note }) });
        dbApi.recordSecretAccess({ secret_id: secret.id, name: secret.name, agent: origin, kind: 'create', outcome: 'ok', detail: 'replaced by a plugin' });
        auditPluginAction(scope, 'secret.update', `secret:${secret.id}`);
        return view(secret);
      } catch (err) {
        if (err instanceof PluginAdminError) throw err;
        throw storeError(err);
      }
    },

    grant(name, wanted) {
      needSuperadmin('granting a secret');
      const spec = parseAdminInput(ScopeSchema, wanted);
      let grant: SecretGrant;
      try { grant = parseSecretScope(spec); } catch (err) { throw storeError(err); }
      if (grant.scope_kind === 'global') {
        throw new PluginAdminError('forbidden', 'a plugin does not grant a secret to everyone: that is done in the Secrets page');
      }
      if (grant.scope_kind === 'agent' && (grant.scope_ref ?? '').trim().toLowerCase().startsWith('plugin:')) {
        throw new PluginAdminError('forbidden', 'a plugin does not grant a secret to a plugin');
      }
      // A reservation decides which backend's process a key enters (TODO #531,
      // 5-B): the operator's call, in the Secrets page or the CLI.
      if (grant.scope_kind === 'backend') {
        throw new PluginAdminError('forbidden', 'a plugin does not reserve a secret to a backend: that is done in the Secrets page');
      }
      const row = rowNamed(name);
      try {
        const secret = grantSecret(row.id, grant);
        auditPluginAction(scope, 'secret.grant', `secret:${row.id}`);
        return view(secret);
      } catch (err) { throw storeError(err); }
    },

    revoke(name, wanted) {
      needSuperadmin('revoking a secret grant');
      const spec = parseAdminInput(ScopeSchema, wanted);
      let grant: SecretGrant;
      try { grant = parseSecretScope(spec); } catch (err) { throw storeError(err); }
      // Lifting a reservation WIDENS the key: its other grants would then reach
      // every backend their missions run (TODO #531, 5-B).
      if (grant.scope_kind === 'backend') {
        throw new PluginAdminError('forbidden', 'a plugin does not lift a backend reservation: that is done in the Secrets page');
      }
      const row = rowNamed(name);
      try {
        const secret = revokeSecret(row.id, grant);
        auditPluginAction(scope, 'secret.revoke', `secret:${row.id}`);
        return view(secret);
      } catch (err) { throw storeError(err); }
    },

    async httpCall(request) {
      const fields = parseAdminInput(HttpCallSchema, request);
      try {
        // Who is asking is this plugin, from the scope: never a header, never the viewer.
        return await brokerHttpCall(fields, { missionId: null, agent: origin, project: null, allowTarget: ceiling });
      } catch (err) {
        if (err instanceof BrokerDeniedError) {
          if (err.code === 'no-grant') noteGlobalOnlySecret(scope.pluginId, fields.identity, 'broker', dbApi.listSecrets());
          throw new PluginAdminError(BROKER_CODE[err.code] ?? 'invalid', err.message, err.code);
        }
        console.error(`[secrets] plugin ${scope.pluginId} broker call failed: ${(err as Error).name}`);
        throw new PluginAdminError('unavailable', 'the broker call failed');
      }
    },
  };
}
