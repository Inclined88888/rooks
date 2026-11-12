/**
 * Front-end model of the secrets vault (spec `docs/SECRETS-VAULT.md` §9.2).
 *
 * Write-only by construction: `SecretSummary` has no `value` field at all, so
 * pre-filling the value input isn't a convention to remember — it doesn't
 * type-check. The list/get API never returns a value; the only way back is the
 * password-gated `reveal` call (16/10/2026 amendment), whose result lives in
 * `reveal-dialog.tsx` state and never enters these types, so it cannot reach a
 * PUT body.
 *
 * Kept free of React so `npm test` (glob `src/lib/*.test.ts`, node:test, no
 * jsdom) can cover it.
 */

export type SecretMode = 'inject' | 'broker';

/** `backend` is a reservation the daemon intersects with the others: the
 *  entry reaches only that backend's process (TODO #531, 5-B). */
export type ScopeKind = 'global' | 'project' | 'agent' | 'backend';

/** §9.2 — UI presets. The operator never has to write an injection template
 *  by hand; `advanced` is the escape hatch that still does. */
export type BrokerPreset = 'bearer' | 'header' | 'query' | 'git' | 'advanced';

/** Header is the §6.2 example. Query is the §9.2 preset; same `{name, template}`
 *  shape so the substitution site stays explicit. */
export type BrokerInject =
  | { kind: 'header'; name: string; template: string }
  | { kind: 'query'; name: string; template: string };

export type BrokerSpec =
  | { type: 'http'; hosts: string[]; inject: BrokerInject }
  | { type: 'git'; hosts: string[] };

export type SecretGrant = {
  scope_kind: ScopeKind;
  /** Project slug, agent name (`plugin:<id>` for a plugin) or backend id. Always null/absent for `global` (§5.1). */
  scope_ref?: string | null;
};

/** Row of `GET /api/secrets` (§9.1). No `value` — deliberately. */
export type SecretSummary = {
  id: string;
  name: string;
  mode: SecretMode;
  grants: SecretGrant[];
  configured: boolean;
  updated_at: number;
  note?: string | null;
  /** S.5 stores the spec as opaque JSON text and hands it back as such
   *  (`toPublicSecret`, `store.ts`), so the front parses it. `value` is the one
   *  field that never comes back; the spec is not a secret. */
  broker_spec?: string | BrokerSpec | null;
};

export type SecretEditor = {
  /** null = creation. */
  id: string | null;
  name: string;
  mode: SecretMode;
  note: string;
  grants: SecretGrant[];
  value: string;
  /** True once the operator asked to replace the value (button *Replace*). An
   *  untouched editor must never send a `value` key on PUT: `''` would erase
   *  the stored secret while the operator only meant to edit its grants. */
  replacingValue: boolean;
  brokerPreset: BrokerPreset;
  /** Free text, one host per line or comma-separated; parsed by `parseHosts`. */
  brokerHosts: string;
  brokerHeaderName: string;
  brokerQueryName: string;
  brokerTemplate: string;
  /** False when the row is a broker whose stored spec the API didn't return:
   *  the fields above are then blank and mean nothing, so `broker_spec` stays
   *  out of the PUT body. Sending a rebuilt-from-blank spec would erase the
   *  host allowlist — which §6.2 makes structural, not a setting — while the
   *  operator only meant to edit a grant. */
  brokerSpecKnown: boolean;
};

/** §3.6 — the name is an environment variable identifier, so injection needs
 *  no transformation. Same regex as the write API. */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export const SECRET_MODES: SecretMode[] = ['inject', 'broker'];

export const SCOPE_KINDS: ScopeKind[] = ['global', 'project', 'agent', 'backend'];

/** Built by template in the UI, therefore invisible to a source scan — the
 *  i18n coverage test resolves these maps entry by entry in both locales. */
export const SCOPE_KIND_LABEL_KEYS: Record<ScopeKind, string> = {
  global: 'secretsPage.scope.global',
  project: 'secretsPage.scope.project',
  agent: 'secretsPage.scope.agent',
  backend: 'secretsPage.scope.backend',
};

export const MODE_LABEL_KEYS: Record<SecretMode, string> = {
  inject: 'secretsPage.mode.inject',
  broker: 'secretsPage.mode.broker',
};

/** Plain-language explanation of each mode, shown next to the choice (§9.2). */
/** Label of the configured / not-configured state — the one real decision the
 *  list makes out of the API's `configured` flag. */
export const CONFIGURED_LABEL_KEYS = {
  yes: 'secretsPage.configured',
  no: 'secretsPage.notConfigured',
} as const;

export function configuredLabelKey(secret: Pick<SecretSummary, 'configured'>): string {
  return secret.configured ? CONFIGURED_LABEL_KEYS.yes : CONFIGURED_LABEL_KEYS.no;
}

export const MODE_HINT_KEYS: Record<SecretMode, string> = {
  inject: 'secretsPage.modeHint.inject',
  broker: 'secretsPage.modeHint.broker',
};

export const BROKER_PRESETS: BrokerPreset[] = ['bearer', 'header', 'query', 'git', 'advanced'];

export const BROKER_PRESET_LABEL_KEYS: Record<BrokerPreset, string> = {
  bearer: 'secretsPage.brokerPreset.bearer',
  header: 'secretsPage.brokerPreset.header',
  query: 'secretsPage.brokerPreset.query',
  git: 'secretsPage.brokerPreset.git',
  advanced: 'secretsPage.brokerPreset.advanced',
};

export const BROKER_PRESET_HINT_KEYS: Record<BrokerPreset, string> = {
  bearer: 'secretsPage.brokerPresetHint.bearer',
  header: 'secretsPage.brokerPresetHint.header',
  query: 'secretsPage.brokerPresetHint.query',
  git: 'secretsPage.brokerPresetHint.git',
  advanced: 'secretsPage.brokerPresetHint.advanced',
};

const DEFAULT_HEADER_NAME = 'Authorization';
const BEARER_TEMPLATE = 'Bearer {{value}}';

/** Where the operator's value lands in the template. Without it the daemon
 *  would send a header that carries no secret at all. */
export const VALUE_PLACEHOLDER = '{{value}}';

/** S.5 accepts an object and normalizes it to JSON text, but never validates
 *  its shape — so a row can hold a spec this form cannot represent. Anything
 *  unreadable resolves to null, which keeps the stored spec untouched rather
 *  than rebuilding a wrong one over it. */
export function parseBrokerSpec(raw: string | BrokerSpec | null | undefined): BrokerSpec | null {
  if (!raw) return null;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const spec = value as { type?: unknown; hosts?: unknown; inject?: unknown };
  const hosts = Array.isArray(spec.hosts)
    ? spec.hosts.filter((h): h is string => typeof h === 'string')
    : [];
  if (spec.type === 'git') return { type: 'git', hosts };
  if (spec.type !== 'http' || !Array.isArray(spec.hosts)) return null;
  const inject = (spec.inject ?? {}) as { kind?: unknown; name?: unknown; template?: unknown };
  const name = typeof inject.name === 'string' ? inject.name : '';
  const template = typeof inject.template === 'string' ? inject.template : '';
  if (inject.kind === 'query') {
    return { type: 'http', hosts, inject: { kind: 'query', name, template } };
  }
  if (inject.kind === 'header' || inject.kind === undefined) {
    return { type: 'http', hosts, inject: { kind: 'header', name, template } };
  }
  // Unknown inject kind: keep the stored spec rather than rebuild a header over it.
  return null;
}

/** Which preset would round-trip this spec. Anything we cannot name falls
 *  through to `advanced`, so reopening never silently loses a custom template. */
export function presetFromSpec(spec: BrokerSpec | null): BrokerPreset {
  if (!spec) return 'bearer';
  if (spec.type === 'git') return 'git';
  if (spec.inject.kind === 'query') return 'query';
  if (spec.inject.name === DEFAULT_HEADER_NAME && spec.inject.template === BEARER_TEMPLATE) {
    return 'bearer';
  }
  if (spec.inject.template === VALUE_PLACEHOLDER) return 'header';
  return 'advanced';
}

/** Hosts are typed free-form, one per line or comma-separated. */
export function parseHosts(raw: string): string[] {
  const seen = new Set<string>();
  for (const entry of raw.split(/[\s,]+/)) {
    const host = entry.trim().toLowerCase();
    if (host) seen.add(host);
  }
  return [...seen];
}

/** A pasted URL never matches the hostname-or-`.suffix` comparison of §6.2, and
 *  the mismatch would only show as a refused call at request time. */
function isHostname(host: string): boolean {
  return !host.includes('/') && !host.includes(':') && !host.includes('*');
}

export function blankEditor(): SecretEditor {
  return {
    id: null,
    name: '',
    mode: 'inject',
    note: '',
    grants: [],
    value: '',
    // A brand-new secret has nothing to replace: its value is always required.
    replacingValue: true,
    brokerPreset: 'bearer',
    brokerHosts: '',
    brokerHeaderName: '',
    brokerQueryName: '',
    brokerTemplate: BEARER_TEMPLATE,
    // Nothing is stored yet, so whatever the form holds is the whole truth.
    brokerSpecKnown: true,
  };
}

export function editorFromSecret(secret: SecretSummary): SecretEditor {
  const spec = parseBrokerSpec(secret.broker_spec);
  return {
    id: secret.id,
    name: secret.name,
    mode: secret.mode,
    note: secret.note ?? '',
    grants: [...secret.grants],
    value: '',
    // A row that holds no value yet has nothing to keep: it opens straight on
    // the input rather than on a *Replace* button that would protect nothing.
    replacingValue: !secret.configured,
    brokerPreset: presetFromSpec(spec),
    brokerHosts: spec ? spec.hosts.join('\n') : '',
    brokerHeaderName: spec && spec.type === 'http' && spec.inject.kind === 'header' ? spec.inject.name : '',
    brokerQueryName: spec && spec.type === 'http' && spec.inject.kind === 'query' ? spec.inject.name : '',
    brokerTemplate:
      spec && spec.type === 'http' && spec.inject.kind === 'header' ? spec.inject.template : BEARER_TEMPLATE,
    brokerSpecKnown: secret.mode !== 'broker' || spec !== null,
  };
}

/** Switching to `broker` on a secret the daemon holds no spec for leaves
 *  nothing to keep — the form becomes the source of truth again. */
export function setEditorMode(editor: SecretEditor, mode: SecretMode): SecretEditor {
  return { ...editor, mode, brokerSpecKnown: editor.brokerSpecKnown || editor.id === null };
}

export function setEditorPreset(editor: SecretEditor, brokerPreset: BrokerPreset): SecretEditor {
  return { ...editor, brokerPreset };
}

/** The spec the editor would send, or null when it keeps the stored one. */
export function buildBrokerSpec(editor: SecretEditor): BrokerSpec | null {
  if (editor.mode !== 'broker' || !editor.brokerSpecKnown) return null;
  const hosts = parseHosts(editor.brokerHosts);
  if (editor.brokerPreset === 'git') return { type: 'git', hosts };
  if (editor.brokerPreset === 'bearer') {
    return {
      type: 'http',
      hosts,
      inject: { kind: 'header', name: DEFAULT_HEADER_NAME, template: BEARER_TEMPLATE },
    };
  }
  if (editor.brokerPreset === 'header') {
    return {
      type: 'http',
      hosts,
      inject: { kind: 'header', name: editor.brokerHeaderName.trim(), template: VALUE_PLACEHOLDER },
    };
  }
  if (editor.brokerPreset === 'query') {
    return {
      type: 'http',
      hosts,
      inject: { kind: 'query', name: editor.brokerQueryName.trim(), template: VALUE_PLACEHOLDER },
    };
  }
  return {
    type: 'http',
    hosts,
    inject: {
      kind: 'header',
      name: editor.brokerHeaderName.trim(),
      template: editor.brokerTemplate,
    },
  };
}

/** Stable identity of a grant, used for dedup, keys and removal. */
export function grantKey(grant: SecretGrant): string {
  return grant.scope_kind === 'global'
    ? 'global'
    : `${grant.scope_kind}:${grant.scope_ref ?? ''}`;
}

/** Badge text of a scope: the localized kind, plus its reference when there is
 *  one (`global`, `project: rooks`, `agent: rooks.coder`, `plugin: acme`). */
export function scopeBadge(
  grant: SecretGrant,
  translate: (key: string) => string,
): string {
  const plugin = pluginOfGrant(grant);
  if (plugin) return `${translate(SCOPE_CHOICE_LABEL_KEYS.plugin)}: ${plugin}`;
  const label = translate(SCOPE_KIND_LABEL_KEYS[grant.scope_kind]);
  if (grant.scope_kind === 'global' || !grant.scope_ref) return label;
  return `${label}: ${grant.scope_ref}`;
}

/* ── Plugins as grantees (TODO #597) ─────────────────────────────────────── */

/**
 * A plugin is addressed by the vault as the agent `plugin:<id>` (daemon
 * `secrets/plugins.ts`): no fourth scope kind exists on the wire. The page
 * still offers "Plugin" as its own choice, because asking the operator to type
 * `plugin:` in front of an agent name is how a grant lands on nobody.
 */
export const PLUGIN_AGENT_PREFIX = 'plugin:';

export type ScopeChoice = ScopeKind | 'plugin';

export const SCOPE_CHOICES: ScopeChoice[] = ['global', 'project', 'agent', 'plugin', 'backend'];

/** What the grant picker offers for a mode. A brokered entry stays with the
 *  daemon, and a reserved entry answers only a backend's own process: together
 *  no request could ever use the key (`resolveBrokerSecret`). */
export function scopeChoicesFor(mode: SecretMode): ScopeChoice[] {
  return mode === 'broker' ? SCOPE_CHOICES.filter((choice) => choice !== 'backend') : SCOPE_CHOICES;
}

/** A row of the two lists a reservation can name. */
export type BackendRow = { id: string; label?: string | null; instanceOf?: string | null };

/**
 * The backends a key can be reserved to: every installed one first (Settings'
 * list, which alone holds a provider still waiting for this very key), then
 * what the catalogue adds for a caller who cannot read that list. Never an
 * account instance: its process runs under its backend's id, so a reservation
 * to `claude@<id>` would answer nothing.
 */
export function grantableBackends(
  installed: readonly BackendRow[],
  catalogue: readonly BackendRow[],
): { value: string; label: string }[] {
  const seen = new Map<string, { value: string; label: string }>();
  for (const row of [...installed, ...catalogue]) {
    if (row.instanceOf || row.id.includes('@') || seen.has(row.id)) continue;
    seen.set(row.id, { value: row.id, label: row.label && row.label !== row.id ? `${row.label} (${row.id})` : row.id });
  }
  return [...seen.values()];
}

/** A grant that reserves the entry to a backend (TODO #531, 5-B). */
export function hasReservation(grants: readonly SecretGrant[]): boolean {
  return grants.some((grant) => grant.scope_kind === 'backend');
}

export const SCOPE_CHOICE_LABEL_KEYS: Record<ScopeChoice, string> = {
  ...SCOPE_KIND_LABEL_KEYS,
  plugin: 'secretsPage.scope.plugin',
};

/** The wire grant for what the operator picked: a plugin is an `agent` grant. */
export function grantFromChoice(choice: ScopeChoice, ref: string): SecretGrant {
  if (choice === 'plugin') {
    // No plugin picked → no reference, which `addGrant` drops; never a bare `plugin:`.
    const id = ref.trim();
    return { scope_kind: 'agent', scope_ref: id ? `${PLUGIN_AGENT_PREFIX}${id}` : '' };
  }
  return { scope_kind: choice, scope_ref: choice === 'global' ? null : ref };
}

/** The plugin id a grant names, or null for any other grant. */
export function pluginOfGrant(grant: SecretGrant): string | null {
  if (grant.scope_kind !== 'agent' || !grant.scope_ref?.startsWith(PLUGIN_AGENT_PREFIX)) return null;
  return grant.scope_ref.slice(PLUGIN_AGENT_PREFIX.length) || null;
}

/** What a plugin consent card asks (`/secrets?grant=<NAME>&plugin=<id>`). */
export type PluginGrantRequest = { name: string; plugin: string };

/** The request carried by the URL, or null when it is absent or malformed. */
export function pluginGrantRequest(params: Pick<URLSearchParams, 'get'>): PluginGrantRequest | null {
  const name = (params.get('grant') ?? '').trim();
  const plugin = (params.get('plugin') ?? '').trim();
  if (!SECRET_NAME_RE.test(name) || !plugin) return null;
  return { name, plugin };
}

/**
 * The secret a consent card is about. Names are unique per scope, not per
 * vault, so several rows may share one; the card is raised for the one shared
 * `global` (the grant the plugin lost), and the vault holds at most one such
 * row per name. Without it, a single row is unambiguous; several leave the
 * choice to the operator (`candidates`).
 */
export function consentTarget(
  secrets: readonly SecretSummary[],
  name: string,
): { secret: SecretSummary | null; candidates: SecretSummary[] } {
  const candidates = secrets.filter((s) => s.name === name);
  const shared = candidates.find((s) => s.grants.some((g) => g.scope_kind === 'global'));
  if (shared) return { secret: shared, candidates };
  return { secret: candidates.length === 1 ? candidates[0]! : null, candidates };
}

/** True when `secret` already answers this plugin by name. */
export function grantedToPlugin(secret: Pick<SecretSummary, 'grants'>, plugin: string): boolean {
  return secret.grants.some((g) => pluginOfGrant(g) === plugin);
}

/** No grant at all = the secret stays with the daemon (§5.2) — a state worth
 *  naming in the list, since it silently means "no agent ever receives it". */
export function isDaemonOnly(secret: Pick<SecretSummary, 'grants'>): boolean {
  return secret.grants.length === 0;
}

export function addGrant(grants: SecretGrant[], grant: SecretGrant): SecretGrant[] {
  const normalized: SecretGrant =
    grant.scope_kind === 'global'
      ? { scope_kind: 'global', scope_ref: null }
      : { scope_kind: grant.scope_kind, scope_ref: (grant.scope_ref ?? '').trim() };
  if (normalized.scope_kind !== 'global' && !normalized.scope_ref) return grants;
  const key = grantKey(normalized);
  if (grants.some((g) => grantKey(g) === key)) return grants;
  return [...grants, normalized];
}

export function removeGrant(grants: SecretGrant[], key: string): SecretGrant[] {
  return grants.filter((g) => grantKey(g) !== key);
}

/** i18n key of the reason the editor can't be submitted, or null when it can. */
export function editorErrorKey(editor: SecretEditor): string | null {
  if (!SECRET_NAME_RE.test(editor.name)) return 'secretsPage.error.name';
  if (editor.replacingValue && editor.value.length === 0) return 'secretsPage.error.value';
  if (editor.mode === 'broker' && hasReservation(editor.grants)) return 'secretsPage.error.brokerReserved';
  const spec = buildBrokerSpec(editor);
  if (spec) {
    // §6.2 / §9.2 — without a host allowlist the broker is an exfiltration
    // machine, for HTTP and git alike, so the refusal is structural.
    if (spec.hosts.length === 0) return 'secretsPage.error.brokerHosts';
    if (!spec.hosts.every(isHostname)) return 'secretsPage.error.brokerHostFormat';
    if (spec.type === 'http') {
      if (!spec.inject.name) {
        return spec.inject.kind === 'query'
          ? 'secretsPage.error.brokerQuery'
          : 'secretsPage.error.brokerHeader';
      }
      if (!spec.inject.template.includes(VALUE_PLACEHOLDER)) return 'secretsPage.error.brokerTemplate';
    }
  }
  return null;
}

export const BROKER_ERROR_KEYS = [
  'secretsPage.error.brokerHosts',
  'secretsPage.error.brokerHostFormat',
  'secretsPage.error.brokerHeader',
  'secretsPage.error.brokerQuery',
  'secretsPage.error.brokerTemplate',
  'secretsPage.error.brokerReserved',
] as const;

/** True when the editor is blocked on the broker form, not on name/value. */
export function isBrokerErrorKey(key: string | null): key is string {
  return key !== null && (BROKER_ERROR_KEYS as readonly string[]).includes(key);
}

export type SecretWritePayload = {
  name: string;
  mode: SecretMode;
  note: string | null;
  grants: SecretGrant[];
  value?: string;
  broker_spec?: BrokerSpec;
};

export function buildCreatePayload(editor: SecretEditor): SecretWritePayload {
  const payload: SecretWritePayload = {
    name: editor.name,
    mode: editor.mode,
    note: editor.note.trim() ? editor.note.trim() : null,
    grants: editor.grants,
    value: editor.value,
  };
  const spec = buildBrokerSpec(editor);
  if (spec) payload.broker_spec = spec;
  return payload;
}

/** PUT replaces the value **and/or** the metadata (§9.1): an untouched value
 *  must be absent from the body, never sent empty. */
export function buildUpdatePayload(editor: SecretEditor): SecretWritePayload {
  const payload: SecretWritePayload = {
    name: editor.name,
    mode: editor.mode,
    note: editor.note.trim() ? editor.note.trim() : null,
    grants: editor.grants,
  };
  if (editor.replacingValue) payload.value = editor.value;
  // Absent means untouched upstream, which is exactly what a broker whose spec
  // the list didn't return needs.
  const spec = buildBrokerSpec(editor);
  if (spec) payload.broker_spec = spec;
  return payload;
}

export function sortSecrets(secrets: SecretSummary[]): SecretSummary[] {
  return [...secrets].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** Search box of the list: case-insensitive, over the name, the note, the mode
 *  and the scopes (`project: rooks`), every word must match. */
export function filterSecrets(secrets: SecretSummary[], query: string): SecretSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return secrets;
  return secrets.filter((s) => {
    const haystack = [
      s.name,
      s.note ?? '',
      s.mode,
      s.grants.length === 0 ? 'daemon only' : '',
      ...s.grants.map((g) => (g.scope_kind === 'global' ? 'global' : `${g.scope_kind} ${g.scope_ref ?? ''}`)),
    ].join(' ').toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}
