/**
 * `/api/plugins/agent-import/{stage,preview,apply,discard}`, the Hermes direct source
 * (`GET hermes`, `POST hermes/stage`: what the daemon detected, then a manifest
 * built from the detected profiles), and the export of this Rooks's agents
 * (`agents`, `export`).
 *
 * Authentication is stated here, route by route, not inherited: every route
 * needs an account (`ctx.user()`: a browser session, a device, or the CLI
 * acting as the operator — the daemon decides which credential is which and
 * never hands a browser the daemon token), and that account must be allowed to
 * create agents. Without an account, 401, even on a first-run machine where
 * the daemon lets anonymous requests through.
 *
 * `agents` and `export` need an account allowed to READ agents
 * (`agents:read` or `agents:manage`): an export shows what the account
 * already reads, never more, and `ctx.agents.export` checks it again.
 *
 * The token travels in a JSON body only, never in a query string, and no
 * answer, message or log line carries it. The Hermes routes take profile
 * NAMES, matched against what the daemon detected itself: no path is ever
 * read from a request.
 *
 * `export-skill` hands out the `rooks-export` skill (the text the user gives
 * another agent tool so it writes an archive this import reads) to the same
 * accounts as the import: it is no secret, but nobody else has a use for it.
 */
import { zipSync } from 'fflate';
import * as z from 'zod/mini';
import type { PluginContext } from '@rooks/sdk';
import {
  IMPORT_ELEMENTS,
  type AgentImportError, type AgentImportErrorCode, type HermesDetectResponse, type ImportOptions, type PreviewResponse,
} from './contract.js';
import { readManifestFromZip, type Engine } from './engine.js';
import { detectHermes, HERMES_DEFAULT_PROFILE, HERMES_PROFILE_RE } from './hermes/detect.js';
import { readHermesManifest } from './hermes/source.js';
import { MANIFEST_FILE, ManifestError } from './manifest.js';
import { ReaderError } from './readers/policy.js';
import { buildExport, EXPORT_MAX_AGENTS, ExportError, type ExportContext } from './export.js';
import { EXPORT_SKILL, EXPORT_SKILL_FILE } from './export-skill.js';
import { STAGE_MAX_BYTES, StageError, type Staging } from './staging.js';

/** 32 random bytes, base64url. */
const TokenSchema = z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/));
const TokenBodySchema = z.strictObject({ token: TokenSchema });

const ElementsSchema = z.strictObject(Object.fromEntries(IMPORT_ELEMENTS.map((e) => [e, z.optional(z.boolean())])) as Record<(typeof IMPORT_ELEMENTS)[number], z.ZodMiniOptional<z.ZodMiniBoolean>>);
const AgentChoiceSchema = z.strictObject({
  sourceRef: z.string().check(z.minLength(1), z.maxLength(300)),
  include: z.optional(z.boolean()),
  name: z.optional(z.string().check(z.minLength(1), z.maxLength(100))),
  role: z.optional(z.string().check(z.minLength(1), z.maxLength(32))),
  project: z.optional(z.nullable(z.string().check(z.minLength(1), z.maxLength(200)))),
  cwd: z.optional(z.nullable(z.string().check(z.minLength(1), z.maxLength(4096)))),
  elements: z.optional(ElementsSchema),
  keepRoutinesActive: z.optional(z.boolean()),
});
const OptionsSchema = z.strictObject({
  source: z.optional(z.string().check(z.minLength(1), z.maxLength(64))),
  prefix: z.optional(z.string().check(z.regex(/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/))),
  agents: z.optional(z.array(AgentChoiceSchema).check(z.maxLength(100))),
});
/** Body of `preview` and `apply`: the token, and the user's choices. */
const ImportRequestSchema = z.strictObject({ token: TokenSchema, options: z.optional(OptionsSchema) });

const HermesStageSchema = z.strictObject({
  profiles: z.optional(z.array(z.string().check(z.regex(HERMES_PROFILE_RE))).check(z.minLength(1), z.maxLength(100))),
});
/** Body of `export`: some agents by name, or all of them; one of the two. */
const ExportBodySchema = z.union([
  z.strictObject({ agents: z.array(z.string().check(z.minLength(1), z.maxLength(100))).check(z.minLength(1), z.maxLength(EXPORT_MAX_AGENTS)) }),
  z.strictObject({ all: z.literal(true) }),
]);

/** Windows browsers name a zip `application/x-zip-compressed`. */
const ZIP_TYPES = new Set(['application/zip', 'application/x-zip-compressed', 'application/octet-stream']);
const StageHeadersSchema = z.object({
  contentType: z.string().check(z.refine((v) => ZIP_TYPES.has(v.split(';')[0]!.trim().toLowerCase()))),
  contentLength: z.optional(z.string().check(z.regex(/^\d{1,15}$/))),
});

const STATUS: Record<AgentImportErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  invalid: 400,
  unsupported_media_type: 415,
  not_a_zip: 400,
  empty: 400,
  too_large: 413,
  too_many: 429,
  not_found: 404,
  archive_changed: 409,
  invalid_manifest: 422,
  not_implemented: 501,
  internal: 500,
};

class RouteError extends Error {
  constructor(readonly code: AgentImportErrorCode, message: string) {
    super(message);
    this.name = 'RouteError';
  }
}

type Reply = { status(code: number): { json(body: unknown): unknown } };

function fail(res: Reply, code: AgentImportErrorCode, message: string): void {
  const body: AgentImportError = { error: message, code };
  res.status(STATUS[code]).json(body);
}

export function mountRoutes(ctx: PluginContext, staging: Staging, engine: Engine): void {
  const router = ctx.router();

  /** The calling account, allowed to create agents; throws a RouteError otherwise. */
  const caller = (): string => {
    const user = ctx.user();
    if (!user) throw new RouteError('unauthorized', 'Sign in to import agents.');
    try {
      ctx.assertPermission('agents:manage');
    } catch {
      throw new RouteError('forbidden', 'Your account is not allowed to create agents.');
    }
    return user.id;
  };

  /** The calling account, allowed to read agents: an export never shows more than the account reads. */
  const reader = (): string => {
    const user = ctx.user();
    if (!user) throw new RouteError('unauthorized', 'Sign in to export agents.');
    const holds = (permission: string): boolean => {
      try { ctx.assertPermission(permission); return true; } catch { return false; }
    };
    if (!holds('agents:read') && !holds('agents:manage')) {
      throw new RouteError('forbidden', 'Your account is not allowed to read agents.');
    }
    return user.id;
  };

  const tokenOf = (body: unknown): string => {
    const parsed = TokenBodySchema.safeParse(body);
    if (!parsed.success) throw new RouteError('invalid', 'Expected a JSON body { "token": "…" } with a staging token.');
    return parsed.data.token;
  };

  const requestOf = (body: unknown): { token: string; options: ImportOptions } => {
    const parsed = ImportRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new RouteError('invalid', 'Expected a JSON body { "token": "…", "options": { … } } with a staging token.');
    }
    return { token: parsed.data.token, options: parsed.data.options ?? {} };
  };

  const answerError = (res: Reply, route: string, err: unknown): void => {
    if (err instanceof RouteError || err instanceof StageError) {
      fail(res, err.code, err.message);
      return;
    }
    if (err instanceof ExportError) {
      fail(res, err.code, err.message);
      return;
    }
    // A facade's refusal: the account's rights, or an agent gone meanwhile.
    const name = err instanceof Error ? err.name : '';
    if (name === 'PluginCallerError') {
      fail(res, 'forbidden', 'Your account is not allowed to do this.');
      return;
    }
    if ((err as { code?: unknown } | null)?.code === 'not_found') {
      fail(res, 'not_found', 'An agent of the export no longer exists.');
      return;
    }
    if (err instanceof ManifestError) {
      fail(res, 'invalid_manifest', err.message);
      return;
    }
    if (err instanceof ReaderError) {
      if (err.code === 'too-large' || err.code === 'too-many-files' || err.code === 'too-deep') {
        fail(res, 'too_large', `The Hermes folder is too large to import: ${err.message}.`);
        return;
      }
      if (err.code === 'changed') {
        fail(res, 'archive_changed', 'Hermes files changed while they were read: try again.');
        return;
      }
    }
    // The error of a file system call names a path, never the token: the token is not a path.
    ctx.log.error(`${route} failed:`, err instanceof Error ? err.message : 'unknown error');
    fail(res, 'internal', 'The import failed on the daemon side.');
  };

  router.post('/stage', (req, res) => {
    (async () => {
      const owner = caller();
      const headers = StageHeadersSchema.safeParse({
        contentType: req.headers['content-type'] ?? '',
        contentLength: req.headers['content-length'],
      });
      if (!headers.success) {
        throw new RouteError('unsupported_media_type', 'Send the archive itself as the body, with Content-Type: application/zip.');
      }
      if (Number(headers.data.contentLength ?? 0) > STAGE_MAX_BYTES) {
        throw new StageError('too_large', `The archive is larger than ${STAGE_MAX_BYTES / (1024 * 1024)} MiB.`);
      }
      const staged = await staging.stage(owner, req as AsyncIterable<Uint8Array>);
      res.status(201).json(staged);
    })().catch((err: unknown) => answerError(res, 'stage', err));
  });

  router.post('/preview', (req, res) => {
    (async () => {
      const owner = caller();
      const { token, options } = requestOf(req.body);
      const { sha256, size, expiresAt, path } = await staging.inspect(owner, token);
      const manifest = await readManifestFromZip(path);
      const preview = await engine.preview(manifest, options);
      const body: PreviewResponse = { archive: { sha256, size, expiresAt }, preview, ready: true };
      res.json(body);
    })().catch((err: unknown) => answerError(res, 'preview', err));
  });

  router.post('/apply', (req, res) => {
    (async () => {
      const owner = caller();
      const { token, options } = requestOf(req.body);
      // The token is spent here, and the archive checked against its SHA-256.
      const archive = await staging.claim(owner, token);
      let manifest;
      try {
        manifest = await readManifestFromZip(archive.path);
      } finally {
        await archive.release();
      }
      res.json(await engine.apply(manifest, options));
    })().catch((err: unknown) => answerError(res, 'apply', err));
  });

  // The agents an account may pick for an export: names and roles only.
  router.get('/agents', (_req, res) => {
    (async () => {
      reader();
      const agents = (await ctx.agents.list()).map((a) => ({ name: a.name, role: a.role, project: a.project }));
      res.json({ agents });
    })().catch((err: unknown) => answerError(res, 'agents', err));
  });

  // The archive itself, as `stage` takes it on another Rooks.
  router.post('/export', (req, res) => {
    (async () => {
      reader();
      const parsed = ExportBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new RouteError('invalid', 'Expected a JSON body { "agents": ["name", …] } or { "all": true }.');
      }
      const exportCtx: ExportContext = ctx;
      const { archive, fileName, manifest } = await buildExport(exportCtx, parsed.data);
      res.status(200);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('X-Rooks-Agents', String(manifest.agents.length));
      res.setHeader('Cache-Control', 'no-store');
      res.end(Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength));
    })().catch((err: unknown) => answerError(res, 'export', err));
  });

  // The skill as a file: `SKILL.md`, the name an agent tool expects.
  router.get('/export-skill', (_req, res) => {
    (async () => {
      caller();
      res.status(200);
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${EXPORT_SKILL_FILE}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.end(EXPORT_SKILL);
    })().catch((err: unknown) => answerError(res, 'export-skill', err));
  });

  router.post('/discard', (req, res) => {
    (async () => {
      const owner = caller();
      const token = tokenOf(req.body);
      await staging.discard(owner, token);
      res.json({ discarded: true });
    })().catch((err: unknown) => answerError(res, 'discard', err));
  });

  router.get('/hermes', (_req, res) => {
    (async () => {
      caller();
      const found = await detectHermes();
      const body: HermesDetectResponse = found
        ? {
          found: true,
          label: found.label,
          profiles: found.profiles.map((p) => ({ name: p.name, displayName: p.name === HERMES_DEFAULT_PROFILE ? 'Hermes' : p.name })),
        }
        : { found: false, profiles: [] };
      res.json(body);
    })().catch((err: unknown) => answerError(res, 'hermes', err));
  });

  router.post('/hermes/stage', (req, res) => {
    (async () => {
      const owner = caller();
      const parsed = HermesStageSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new RouteError('invalid', 'Expected a JSON body { "profiles"?: ["default", …] } naming Hermes profiles.');
      const installation = await detectHermes();
      if (!installation) throw new RouteError('not_found', 'No Hermes installation was found on the machine the daemon runs on.');
      const names = parsed.data.profiles;
      if (names) {
        const known = new Set(installation.profiles.map((p) => p.name));
        const unknown = names.filter((n) => !known.has(n));
        if (unknown.length > 0) throw new RouteError('not_found', `No Hermes profile named ${unknown.slice(0, 5).join(', ')} was found.`);
      }
      const manifest = await readHermesManifest(installation, names);
      // The manifest goes through the same staging as an uploaded archive: one token,
      // a SHA-256, and preview/apply read exactly what was read from the disk here.
      const zip = zipSync({ [MANIFEST_FILE]: new TextEncoder().encode(JSON.stringify(manifest)) });
      const staged = await staging.stage(owner, (async function* () { yield zip; })());
      res.status(201).json(staged);
    })().catch((err: unknown) => answerError(res, 'hermes/stage', err));
  });
}
