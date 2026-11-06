/**
 * `/api/backends/custom` — backends a user adds from Settings → Backends.
 *
 * The form writes the same `~/.timon/backends/<id>.json` a user could drop by
 * hand, through the same schema (`backends/local-profiles.ts`): there is one
 * door, the UI merely holds it open.
 *
 * SUPERADMIN only, posed once on the prefix so a route added later is closed by
 * default. Two reasons, either one sufficient: a profile decides where the
 * prompts of every mission dispatched on it are sent, and saving a key grants
 * it `global` — a decision the vault itself reserves to a superadmin. Unlike
 * the historical open routes, an unauthenticated request is refused even on a
 * fresh install: nothing of first-run setup needs this surface. A change —
 * create, edit, test, remove — is moreover a person's gesture, never an
 * agent's, even a superadmin one (`change-gate.ts`, TODO #571).
 *
 * This is also the door of the `timon backend` CLI: it sends the same bodies,
 * the key read from its stdin and posted in the body, so there is no second
 * validator to drift from this one.
 *
 * The key is write-only. It enters with a POST, goes to the vault, and no
 * route, error or log of this file ever carries it back.
 */
import { registerManagedBackendRoutes } from './manage-routes.js';
import { refuseBackendChange } from './change-gate.js';
import { backendKeyGrant, ownerNote, reserveBackendKey, secretNameFor } from './backend-keys.js';
import { activeProfiles, installedProfiles } from '../../backends/registry.js';
import { modelPreferences } from '../../backends/model-preferences.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Request, Response, Router, RequestHandler } from 'express';
import { z } from 'zod';
import { dbApi } from '../../db.js';
import { inactiveProfiles } from '../../backends/index.js';
import { dialectForProtocol, getDialect, protocolOfDialect } from '../../backends/registry.js';
import { PROVIDER_PROTOCOLS } from '../../backends/provider-declarations.js';
import {
  BACKEND_ICON_URL_PREFIX,
  LOCAL_BACKEND_ID_RE,
  NO_KEY_PLACEHOLDER,
  listLocalBackends,
  localBackendFile,
  parseLocalBackend,
  reasoningControlSchema,
  reloadLocalBackends,
  removeLocalBackend,
  secretNamesOf,
  writeLocalBackend,
  type LocalBackend,
} from '../../backends/local-profiles.js';
import { testBackendConnection, type BackendProtocol } from '../../backends/connection-test.js';
import { profileBaseUrl, resolveModelReasoning, type DeclaredReasoningControl } from '../../backends/reasoning.js';
import type { EnvValue } from '../../backends/types.js';
import { SecretStoreError, createSecret, deleteSecret, listSecrets, readSecretValue, updateSecret } from '../../secrets/store.js';
import { requireSuperadmin } from '../../users/identity.js';
import { auditRequest } from '../../users/audit-actor.js';
import { deleteBackendIcon, readBackendIcon, saveBackendIcon } from '../../uploads.js';
import { apiError } from '../../api-error.js';

/** The protocols the form offers: the dialects declare which of them they serve (`declares.protocols`). */
const PROTOCOLS: readonly BackendProtocol[] = PROVIDER_PROTOCOLS;

const httpUrl = z.string().trim().max(2048).refine((value) => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be an http(s) URL');

const protocolSchema = z.enum(['anthropic', 'openai-responses']);

/**
 * A model as the form sends it. The bare slug is kept because that is what a
 * successful connection test yields — a list of ids and nothing else; the
 * object form is what the model editor sends once a human has named or
 * illustrated one.
 */
const modelInputSchema = z.union([
  z.string().trim().min(1).max(200),
  z.strictObject({
    slug: z.string().trim().min(1).max(200),
    label: z.string().trim().min(1).max(200).optional(),
    icon: z.string().trim().min(1).max(200).nullable().optional(),
    brand: z.string().trim().min(1).max(40).nullable().optional(),
    hidden: z.boolean().optional(),
    addedAt: z.number().int().nonnegative().optional(),
    /** Levels the user declares for a model the provider cannot describe.
     *  `null` or an empty list clears them. */
    supportedReasoningLevels: z.array(z.string().trim().min(1).max(40)).max(12).nullable().optional(),
    /** Levels the connection test read from the endpoint's own listing, sent
     *  back by a form that tested before saving. `null` clears them. */
    reportedReasoningLevels: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/)).max(12).nullable().optional(),
    /** A budget, a switch or "does not think", picked by hand over what was
     *  detected. `null` clears it, back to the detection. */
    reasoningControl: reasoningControlSchema.nullable().optional(),
    /** Context window typed by hand, in tokens. `null` clears it. */
    contextWindow: z.number().int().min(1_000).max(100_000_000).nullable().optional(),
  }),
]);

const modelsSchema = z.array(modelInputSchema).max(500);

/** Picture fields: `null` clears, absent leaves as is. Their SHAPE is checked
 *  by the file schema (`local-profiles.ts`), the one door both paths go
 *  through — an emoji or a file of our own uploads route, never a URL. */
const pictureSchema = z.string().trim().min(1).max(200).nullable();

const createSchema = z.strictObject({
  id: z.string().regex(LOCAL_BACKEND_ID_RE).optional(),
  name: z.string().trim().min(1).max(80),
  baseUrl: httpUrl,
  key: z.string().max(4096).optional(),
  protocol: protocolSchema,
  models: modelsSchema.optional(),
  defaultModel: z.string().trim().min(1).max(200).optional(),
  icon: z.string().trim().min(1).max(200).optional(),
  brand: z.string().trim().min(1).max(40).optional(),
});

/**
 * What an EDIT may carry. Every field is optional and what is absent is left
 * untouched — including the key, which a form cannot read back and therefore
 * cannot resend. An empty `key` would mean "erase the credential", so it is
 * the absence, not the empty string, that means "keep it".
 */
const updateSchema = z.strictObject({
  disabled: z.boolean().optional(),
  rank: z.number().int().min(0).max(10000).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  baseUrl: httpUrl.optional(),
  key: z.string().min(1).max(4096).optional(),
  protocol: protocolSchema.optional(),
  models: modelsSchema.optional(),
  defaultModel: z.string().trim().min(1).max(200).nullable().optional(),
  icon: pictureSchema.optional(),
  brand: pictureSchema.optional(),
});

/**
 * Either a form being filled in, or a SAVED backend by id — never a mix. A
 * saved key is only ever sent to the address saved next to it: accepting an id
 * together with a URL would turn this route into a way of reading the vault,
 * by pointing the stored key at a server of one's choosing.
 */
const testSchema = z.union([
  z.strictObject({ id: z.string().regex(LOCAL_BACKEND_ID_RE) }),
  z.strictObject({ protocol: protocolSchema, baseUrl: httpUrl, key: z.string().max(4096).optional() }),
]);

/** Never echoes the input: a rejected body may be the one that held the key. */
function invalid(res: Response, error: z.ZodError): void {
  const fields = [...new Set(error.issues.map((issue) => issue.path.join('.') || 'body'))];
  res.status(400).json({ error: 'invalid request', fields });
}

function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** Model list as the form reads it back: what was saved, not a count — the
 *  editor reopens on it. */
type ModelView = {
  slug: string; label: string; icon?: string; brand?: string; hidden?: boolean; addedAt?: number;
  supportedReasoningLevels?: string[];
  reportedReasoningLevels?: string[];
  reasoningControl?: DeclaredReasoningControl;
  contextWindow?: number;
  /** Always true when `contextWindow` is set: in a provider's own file, the
   *  figure was typed by the user. Lets the form treat every origin alike. */
  contextWindowDeclared?: boolean;
};

function modelViews(entry: LocalBackend): ModelView[] {
  return (entry.profile?.models ?? []).map((model) => ({
    slug: model.slug,
    label: model.label,
    ...(model.hidden !== undefined ? { hidden: model.hidden } : {}),
    ...(model.addedAt !== undefined ? { addedAt: model.addedAt } : {}),
    ...(model.icon ? { icon: model.icon } : {}),
    ...(model.brand ? { brand: model.brand } : {}),
    ...(model.supportedReasoningLevels?.length ? { supportedReasoningLevels: [...model.supportedReasoningLevels] } : {}),
    ...(model.reportedReasoningLevels ? { reportedReasoningLevels: [...model.reportedReasoningLevels] } : {}),
    ...(model.reasoningControl ? { reasoningControl: { ...model.reasoningControl } } : {}),
    ...(model.contextWindow ? { contextWindow: model.contextWindow, contextWindowDeclared: true } : {}),
  }));
}

/**
 * The saved models as the form shows them, each with what is known of its
 * thinking: what the file declares, else what the endpoint's listing reported,
 * else the embedded catalogue for this address. `detectedReasoning` is the same
 * resolution without what the user declared, so the form can show what a
 * correction overrides. Read-only — the resolution never goes back into the
 * file, whose strict schema would refuse it anyway.
 */
function modelViewsWithReasoning(entry: LocalBackend, baseUrl: string | null) {
  return modelViews(entry).map((model) => {
    const detectedReasoning = resolveModelReasoning({
      slug: model.slug,
      agentLevels: model.reportedReasoningLevels,
      catalog: { baseUrl },
    });
    const reasoning = resolveModelReasoning({
      slug: model.slug,
      declaredLevels: model.supportedReasoningLevels,
      declaredControl: model.reasoningControl,
      agentLevels: model.reportedReasoningLevels,
      catalog: { baseUrl },
    });
    return {
      ...model,
      ...(reasoning ? { reasoning } : {}),
      ...(detectedReasoning ? { detectedReasoning } : {}),
    };
  });
}

function publicView(entry: LocalBackend, reasons: Map<string, string>) {
  const profile = entry.profile;
  const baseUrl = profile ? profileBaseUrl(profile) : null;
  const reason = entry.issue ?? reasons.get(entry.id) ?? null;
  const protocol = profile ? protocolOfDialect(profile.dialect) : null;
  return {
    id: entry.id,
    file: `${entry.id}.json`,
    label: profile?.label ?? entry.id,
    dialect: profile?.dialect ?? null,
    protocol,
    baseUrl,
    models: modelViewsWithReasoning(entry, baseUrl),
    defaultModel: profile?.defaultModel ?? null,
    icon: profile?.icon ?? null,
    brand: profile?.brand ?? null,
    hasVaultKey: profile ? secretNamesOf(profile).length > 0 : false,
    disabled: profile?.disabled ?? false,
    rank: profile?.rank ?? null,
    active: reason === null,
    reason,
    warnings: entry.warnings,
  };
}

/**
 * The single place that turns form values into the file the daemon reads —
 * shared by creation and edition, so the two cannot drift into writing two
 * different shapes for the same provider.
 */
function composeFile(parts: {
  id: string;
  name: string;
  protocol: BackendProtocol;
  baseUrl: string;
  credential: EnvValue;
  disabled?: boolean;
  rank?: number;
  models: ModelView[];
  defaultModel: string | null;
  icon: string | null;
  brand: string | null;
}) {
  const secretName = secretNameFor(parts.id);
  const dialect = dialectForProtocol(parts.protocol);
  if (dialect === null) return { ok: false as const, reason: `no installed provider speaks the ${parts.protocol} protocol` };
  return parseLocalBackend({
    id: parts.id,
    ...(parts.disabled !== undefined ? { disabled: parts.disabled } : {}),
    ...(parts.rank !== undefined ? { rank: parts.rank } : {}),
    dialect,
    label: parts.name,
    vendor: parts.name,
    ...(parts.icon ? { icon: parts.icon } : {}),
    ...(parts.brand ? { brand: parts.brand } : {}),
    ...(parts.protocol === 'anthropic'
      ? { env: { ANTHROPIC_BASE_URL: parts.baseUrl, ANTHROPIC_AUTH_TOKEN: parts.credential } }
      : {
          env: { [secretName]: parts.credential },
          // Prefixed: codex refuses to load when a declared provider takes
          // the id of one of its built-ins (`ollama`, `openai`…).
          providerConfig: { id: `timon-${parts.id}`, name: parts.name, baseUrl: parts.baseUrl, envKey: secretName, wireApi: 'responses' },
        }),
    defaultModel: parts.defaultModel,
    models: parts.models,
  });
}

/**
 * Model list to save, from what the form sent and what was already there.
 *
 * A bare slug keeps the label and the picture the entry already had: the
 * "Test" button sends ids and nothing else, and a user who named their models
 * must not lose that naming by pressing it.
 */
function mergeModels(input: z.infer<typeof modelsSchema>, previous: readonly ModelView[]): ModelView[] {
  const known = new Map(previous.map((model) => [model.slug, model]));
  const out: ModelView[] = [];
  for (const raw of input) {
    const given = typeof raw === 'string' ? { slug: raw } : raw;
    const old = known.get(given.slug);
    const label = given.label ?? old?.label ?? given.slug;
    const icon = 'icon' in given ? given.icon ?? undefined : old?.icon;
    const brand = 'brand' in given ? given.brand ?? undefined : old?.brand;
    const levels = 'supportedReasoningLevels' in given ? given.supportedReasoningLevels ?? undefined : old?.supportedReasoningLevels;
    const reported = 'reportedReasoningLevels' in given ? given.reportedReasoningLevels ?? undefined : old?.reportedReasoningLevels;
    const control = 'reasoningControl' in given ? given.reasoningControl ?? undefined : old?.reasoningControl;
    const contextWindow = 'contextWindow' in given ? given.contextWindow ?? undefined : old?.contextWindow;
    // One declaration at a time: what this request declares replaces the
    // other kind, so levels and a budget never end up side by side. Levels
    // win a tie, as they do in the resolution.
    const declaresControl = 'reasoningControl' in given && !!given.reasoningControl;
    const declaresLevels = 'supportedReasoningLevels' in given && !!given.supportedReasoningLevels?.length;
    const keepLevels = !!levels?.length && (declaresLevels || !declaresControl);
    out.push({ ...old, slug: given.slug, label, icon, brand,
      supportedReasoningLevels: keepLevels ? levels : undefined,
      reasoningControl: control && !keepLevels ? control : undefined,
      reportedReasoningLevels: reported,
      contextWindow,
      addedAt: old?.addedAt ?? (old ? undefined : Date.now()),
      hidden: given.hidden ?? old?.hidden,
    });
  }
  return out;
}

/** The credential a saved file already carries, so an edit that does not touch
 *  the key leaves it exactly as it was — including an endpoint that asks for
 *  none (`NO_KEY_PLACEHOLDER`) and a file written by hand. */
function currentCredential(entry: LocalBackend): EnvValue {
  const env = entry.profile?.env ?? {};
  const named = env['ANTHROPIC_AUTH_TOKEN'] ?? env[secretNameFor(entry.id)];
  if (named !== undefined) return named;
  const envKey = entry.profile?.providerConfig?.envKey;
  return (envKey ? env[envKey] : undefined) ?? NO_KEY_PLACEHOLDER;
}

function listing() {
  const reasons = new Map(inactiveProfiles().map((row) => [row.id, row.reason]));
  return {
    backends: listLocalBackends().map((entry) => publicView(entry, reasons)),
    protocols: PROTOCOLS.map((protocol) => {
      const dialect = dialectForProtocol(protocol);
      return {
        protocol, dialect, installed: dialect !== null,
        // What the form may let the user declare for a model of this protocol.
        thinkingControls: [...((dialect ? getDialect(dialect)?.thinkingControls : undefined) ?? ['levels'])],
      };
    }),
  };
}

/** What a saved backend is tested with: its own address and its own vault
 *  entry. The value serves the daemon's call only, never a response. */
function savedTarget(id: string): { protocol: BackendProtocol; baseUrl: string; key: string } | null {
  const entry = listLocalBackends().find((row) => row.id === id);
  if (!entry?.profile) return null;
  const view = publicView(entry, new Map());
  if (!view.protocol || !view.baseUrl) return null;
  let key = '';
  search: for (const name of secretNamesOf(entry.profile)) {
    for (const row of dbApi.listSecrets().filter((secret) => secret.name === name)) {
      try {
        key = readSecretValue(row.id);
        break search;
      } catch {
        // Unreadable duplicate: the next one may open.
      }
    }
  }
  return { protocol: view.protocol, baseUrl: view.baseUrl, key };
}

/**
 * Keeps on a saved backend's models the effort levels its endpoint just
 * reported, so the catalogue can name them as the agent's source without
 * calling the network again. Only models the file already lists, only the ones
 * the listing described (an empty list says "not supported" and is kept as
 * such). Best effort: a test answers the same whether or not this lands.
 */
function recordReportedLevels(id: string, reported: Record<string, string[]>): void {
  try {
    reloadLocalBackends();
    const entry = listLocalBackends().find((row) => row.id === id);
    if (!entry?.profile) return;
    let changed = false;
    const models = entry.profile.models.map((model) => {
      const levels = reported[model.slug];
      if (!levels || JSON.stringify(levels) === JSON.stringify(model.reportedReasoningLevels ?? null)) return model;
      changed = true;
      return { ...model, reportedReasoningLevels: [...levels] };
    });
    if (!changed) return;
    const { custom: _custom, ...fileShape } = entry.profile;
    const candidate = parseLocalBackend({ ...fileShape, models });
    if (!candidate.ok) return;
    writeLocalBackend(candidate.value);
    reloadLocalBackends();
  } catch (err) {
    console.warn(`[backends] reported effort levels of ${id} not kept: ${(err as Error).message}`);
  }
}

/** File names, among the pictures WE serve, that a backend refers to. An emoji
 *  or a brand key yields nothing: there is no file behind it. */
function iconFilesOf(entry: LocalBackend): string[] {
  const urls = [entry.profile?.icon, ...(entry.profile?.models ?? []).map((model) => model.icon)];
  return urls
    .filter((url): url is string => typeof url === 'string' && url.startsWith(BACKEND_ICON_URL_PREFIX))
    .map((url) => url.slice(BACKEND_ICON_URL_PREFIX.length));
}

/**
 * Drops the pictures nothing points at any more — a logo replaced twice would
 * otherwise leave two orphans in the home forever. Checked against ALL
 * backends, not just the one edited: the same file may have been picked twice.
 */
function pruneIcons(candidates: readonly string[]): void {
  if (candidates.length === 0) return;
  const references = installedProfiles().flatMap((profile) => [profile.icon, ...profile.models.map((model) => model.icon)]);
  for (const overlay of dbApi.listBackendOverlays()) {
    references.push(overlay.icon ?? undefined, ...(modelPreferences(overlay.id)?.models ?? []).map((model) => model.icon ?? undefined));
  }
  const used = new Set([...listLocalBackends().flatMap(iconFilesOf), ...references
    .filter((url): url is string => !!url?.startsWith(BACKEND_ICON_URL_PREFIX))
    .map((url) => url.slice(BACKEND_ICON_URL_PREFIX.length))]);
  for (const name of candidates) {
    if (!used.has(name)) deleteBackendIcon(name);
  }
}

export function registerCustomBackendRoutes(router: Router): void {
  router.use('/api/backends/custom', (req: Request, res: Response, next) => {
    if (!requireSuperadmin(req, res)) return;
    if (refuseBackendChange(req, res)) return;
    next();
  });

  /**
   * A picture for a backend or one of its models. Same store and same
   * refusals as a project icon (raster only — an SVG can carry script), and
   * the same client-side downscale before it gets here.
   *
   * Posting one is a superadmin gesture, like the backend it illustrates;
   * READING one is not: every selector in the product draws it.
   */
  router.post('/api/uploads/backends', (req: Request, res: Response) => {
    if (!requireSuperadmin(req, res)) return;
    try {
      res.json(saveBackendIcon((req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {}));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get('/api/uploads/backends/:file', (req: Request, res: Response) => {
    try {
      const { bytes, contentType } = readBackendIcon(String(req.params['file'] ?? ''));
      res.setHeader('content-type', contentType);
      res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      res.send(bytes);
    } catch (err) {
      const msg = (err as Error).message;
      res.status(msg === 'not found' ? 404 : 400).json({ error: msg });
    }
  });

  router.get('/api/backends/custom', (_req, res) => {
    reloadLocalBackends();
    res.json(listing());
  });

  // Before `/:id`, or Express reads the verb as an id.
  router.post('/api/backends/custom/test', (req, res) => {
    void (async () => {
      const parsed = testSchema.safeParse(req.body ?? {});
      if (!parsed.success) return invalid(res, parsed.error);
      const target = 'id' in parsed.data
        ? savedTarget(parsed.data.id)
        : { protocol: parsed.data.protocol, baseUrl: parsed.data.baseUrl, key: parsed.data.key ?? '' };
      if (!target) {
        res.status(404).json({ error: 'unknown backend, or one this form cannot test' });
        return;
      }
      const outcome = await testBackendConnection(target);
      if ('id' in parsed.data && outcome.outcome === 'ok' && outcome.reasoningLevels) {
        recordReportedLevels(parsed.data.id, outcome.reasoningLevels);
      }
      res.json(outcome);
    })();
  });

  router.post('/api/backends/custom', (req, res) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return invalid(res, parsed.error);
    const input = parsed.data;
    const id = input.id ?? slugify(input.name);
    if (!LOCAL_BACKEND_ID_RE.test(id)) {
      res.status(400).json({ error: 'invalid request', fields: ['name'] });
      return;
    }
    if (existsSync(localBackendFile(id))) {
      res.status(409).json({ error: `a backend named ${id} already exists`, code: 'duplicate' });
      return;
    }

    const secretName = secretNameFor(id);
    const models = mergeModels(input.models ?? [], []);
    const candidate = composeFile({
      id,
      name: input.name,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      credential: input.key ? { secret: secretName } : NO_KEY_PLACEHOLDER,
      models,
      defaultModel: input.defaultModel ?? models[0]?.slug ?? null,
      icon: input.icon ?? null,
      brand: input.brand ?? null,
    });
    if (!candidate.ok) {
      res.status(400).json({ error: candidate.reason });
      return;
    }

    let secretId: string | null = null;
    if (input.key) {
      try {
        // Reserved to this backend (TODO #531, 5-B): its process gets the key,
        // every mission on it may run, and no other process — the vault slice
        // of other missions, a plugin, the broker — ever receives it. An entry
        // with no grant would never reach a mission (SECRETS-VAULT.md §5.2), a
        // `global` one would reach them all.
        secretId = createSecret({ name: secretName, value: input.key, note: ownerNote(id), grants: [backendKeyGrant(id)] }).id;
      } catch (err) {
        const code = err instanceof SecretStoreError ? err.code : 'unknown';
        const status = code === 'unavailable' ? 503 : code === 'duplicate' ? 409 : 400;
        // The store's message is built from the name, never from the value —
        // but only the code leaves, so that stays true whatever it becomes.
        res.status(status).json({ error: `the key could not be stored in the vault (${code})`, code: `vault-${code}` });
        return;
      }
    }

    try {
      writeLocalBackend(candidate.value);
    } catch {
      if (secretId) deleteSecret(secretId);
      res.status(500).json(apiError('backend_file_write_failed', 'the backend file could not be written'));
      return;
    }
    const entry = reloadLocalBackends().find((row) => row.id === id);
    if (!entry || entry.issue) {
      removeLocalBackend(id);
      if (secretId) deleteSecret(secretId);
      reloadLocalBackends();
      res.status(409).json({ error: entry?.issue ?? 'the backend could not be loaded', code: 'not-loaded' });
      return;
    }
    auditRequest(req, 'backend.custom.create', id);
    const reasons = new Map(inactiveProfiles().map((row) => [row.id, row.reason]));
    res.status(201).json({ backend: publicView(entry, reasons) });
  });

  /**
   * Edit a saved backend. Absent field = untouched: the form cannot read the
   * key back, so only a key it was GIVEN replaces the stored one.
   *
   * The file is rewritten whole, through the same `composeFile` as creation —
   * a partial edit never produces a shape creation would not have written.
   */
  const updateCustom: RequestHandler = (req, res) => {
    const id = String(req.params['id'] ?? '');
    if (!LOCAL_BACKEND_ID_RE.test(id)) {
      res.status(400).json({ error: 'invalid backend id' });
      return;
    }
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return invalid(res, parsed.error);
    const input = parsed.data;

    reloadLocalBackends();
    const entry = listLocalBackends().find((row) => row.id === id);
    if (!entry) {
      res.status(404).json(apiError('backend_unknown', 'unknown backend'));
      return;
    }
    if (!entry.profile) {
      // Merging into a file we could not read would silently drop whatever it
      // holds. Its owner fixes it, or deletes it.
      res.status(409).json({ error: entry.issue ?? 'the backend could not be loaded', code: 'not-loaded' });
      return;
    }
    const active = activeProfiles();
    if (input.disabled && active.some((row) => row.profile.id === id) && active.length === 1) {
      res.status(409).json({ error: 'The last active backend cannot be disabled' });
      return;
    }
    const before = publicView(entry, new Map());
    const protocol = input.protocol ?? before.protocol;
    const baseUrl = input.baseUrl ?? before.baseUrl;
    const connectionChanged = input.key !== undefined
      || (input.protocol !== undefined && input.protocol !== before.protocol)
      || (input.baseUrl !== undefined && input.baseUrl !== before.baseUrl);
    if (connectionChanged && (!protocol || !baseUrl)) {
      res.status(409).json({ error: 'connection settings cannot be edited for this file format', code: 'foreign-shape' });
      return;
    }
    const models = input.models ? mergeModels(input.models, entry.profile.models) : entry.profile.models;
    // A default that the new list no longer serves would leave the backend
    // pointing at a model nobody can pick.
    const keptDefault = before.defaultModel && models.some((model) => model.slug === before.defaultModel && !model.hidden)
      ? before.defaultModel
      : models.find((model) => !model.hidden)?.slug ?? null;
    if (input.defaultModel && !models.some((model) => model.slug === input.defaultModel && !model.hidden)) {
      res.status(400).json({ error: 'The default model must be visible' });
      return;
    }
    if (new Set(models.map((model) => model.slug)).size !== models.length) {
      res.status(400).json({ error: 'Duplicate model slug' });
      return;
    }
    const { custom: _custom, ...fileShape } = entry.profile;
    const candidate = connectionChanged ? composeFile({
      id,
      disabled: input.disabled ?? entry.profile.disabled,
      rank: input.rank ?? entry.profile.rank,
      name: input.name ?? before.label,
      protocol: protocol!,
      baseUrl: baseUrl!,
      credential: input.key ? { secret: secretNameFor(id) } : currentCredential(entry),
      models,
      defaultModel: input.defaultModel === undefined ? keptDefault : input.defaultModel,
      icon: input.icon === undefined ? before.icon : input.icon,
      brand: input.brand === undefined ? before.brand : input.brand,
    }) : parseLocalBackend({
      ...fileShape,
      label: input.name ?? entry.profile.label,
      vendor: input.name ?? entry.profile.vendor,
      disabled: input.disabled ?? entry.profile.disabled,
      rank: input.rank ?? entry.profile.rank,
      models,
      defaultModel: input.defaultModel === undefined ? keptDefault : input.defaultModel,
      icon: input.icon === undefined ? entry.profile.icon : input.icon ?? undefined,
      brand: input.brand === undefined ? entry.profile.brand : input.brand ?? undefined,
    });
    if (!candidate.ok) {
      res.status(400).json({ error: candidate.reason });
      return;
    }

    // Rotation in place rather than delete + create: the vault refuses a
    // duplicate name, and a delete that is not followed by a create would
    // leave the backend keyless.
    if (input.key) {
      try {
        const existing = listSecrets().find((secret) => secret.name === secretNameFor(id) && secret.note === ownerNote(id));
        if (existing) {
          updateSecret(existing.id, { value: input.key });
          // A key stored before 5-B in the form's own shape moves with its
          // rotation; one shared by hand keeps its grants (`backend-keys.ts`).
          const owned = dbApi.getSecret(existing.id);
          if (owned) reserveBackendKey(id, owned);
        } else {
          createSecret({ name: secretNameFor(id), value: input.key, note: ownerNote(id), grants: [backendKeyGrant(id)] });
        }
      } catch (err) {
        const code = err instanceof SecretStoreError ? err.code : 'unknown';
        const status = code === 'unavailable' ? 503 : code === 'duplicate' ? 409 : 400;
        res.status(status).json({ error: `the key could not be stored in the vault (${code})`, code: `vault-${code}` });
        return;
      }
    }

    // Kept for the rollback below: a file that loaded is a file we can put
    // back, and an edit that ends inactive must not take the working one down
    // with it. The key, if it was rotated, stays rotated — it is the value the
    // user just typed, not something we could restore anyway.
    let previous: string | null = null;
    try {
      previous = readFileSync(localBackendFile(id), 'utf8');
    } catch {
      // Removed under us: there is nothing to put back, and the write below
      // recreates it.
    }
    try {
      writeLocalBackend(candidate.value);
    } catch {
      res.status(500).json(apiError('backend_file_write_failed', 'the backend file could not be written'));
      return;
    }
    const saved = reloadLocalBackends().find((row) => row.id === id);
    if (!saved || saved.issue) {
      const issue = saved?.issue ?? 'the backend could not be loaded';
      if (previous !== null) writeFileSync(localBackendFile(id), previous, 'utf8');
      else removeLocalBackend(id);
      reloadLocalBackends();
      res.status(409).json({ error: issue, code: 'not-loaded' });
      return;
    }
    pruneIcons(iconFilesOf(entry));
    auditRequest(req, 'backend.custom.update', id);
    const reasons = new Map(inactiveProfiles().map((row) => [row.id, row.reason]));
    res.json({ backend: publicView(saved, reasons) });
  };
  router.patch('/api/backends/custom/:id', updateCustom);
  registerManagedBackendRoutes(router, listing, updateCustom);

  router.delete('/api/backends/custom/:id', (req, res) => {
    const id = String(req.params['id'] ?? '');
    if (!LOCAL_BACKEND_ID_RE.test(id)) {
      res.status(400).json({ error: 'invalid backend id' });
      return;
    }
    const pictures = listLocalBackends().filter((row) => row.id === id).flatMap(iconFilesOf);
    const removed = removeLocalBackend(id);
    reloadLocalBackends();
    pruneIcons(pictures);
    if (!removed) {
      res.status(404).json(apiError('backend_unknown', 'unknown backend'));
      return;
    }
    // Only the secret this door created: one a hand-written profile shares with others stays.
    const removedSecrets: string[] = [];
    try {
      for (const secret of listSecrets()) {
        if (secret.name === secretNameFor(id) && secret.note === ownerNote(id)) {
          deleteSecret(secret.id);
          removedSecrets.push(secret.name);
        }
      }
    } catch {
      // Vault switched off since: the file is gone, which is what was asked.
    }
    auditRequest(req, 'backend.custom.delete', id);
    res.json({ ok: true, removedSecrets });
  });
}
