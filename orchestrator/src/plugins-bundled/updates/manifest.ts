/**
 * Verification of the signed update manifest, `releases.json`
 * (docs/AUTO-UPDATE.md §3, the frozen format of P1a).
 *
 * The format is owned by `scripts/release-manifest.mjs`, which composes and
 * signs it on the build machine. That file cannot be imported here: the
 * daemon compiles `src/` alone and the package ships no `scripts/` of the
 * repository. This is its verifying half carried over to TypeScript, with the
 * payload schema mirrored in zod; `manifest.test.ts` runs both on the
 * same envelopes so they cannot drift apart.
 *
 * Depends on `node:crypto` and zod only: no file, no network.
 */
import { verify } from 'node:crypto';
import { z } from 'zod';

export const RELEASES_SCHEMA = 1;
export const RELEASES_SIGNATURE_DOMAIN = 'timon-releases-v1\0';
export const RELEASES_URL = 'https://github.com/Inclined88888/rooks/releases/latest/download/rooks-releases.json';
export const NOTES_MAX = 64 * 1024;
export const ENVELOPE_MAX = 1024 * 1024;
export const CLOCK_SKEW_MS = 5 * 60_000;

export type ReleaseChannel = 'beta' | 'stable';
export type ReleasePublicKey = { keyId: string; publicKey: string; expiresAt?: string };

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ARTIFACT_KEY = /^(linux|mac|win)-(x64|arm64|universal)-(appimage|deb|pkg|dmg|nsis)$/;
const OS_FORMATS: Record<string, readonly string[]> = { linux: ['appimage', 'deb'], mac: ['pkg', 'dmg'], win: ['nsis'] };

type VersionParts = [bigint, bigint, bigint, bigint | null];

function versionParts(value: unknown): VersionParts | null {
  const match = typeof value === 'string' ? VERSION.exec(value) : null;
  if (!match) return null;
  return [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!), match[4] === undefined ? null : BigInt(match[4])];
}

export const isVersion = (value: unknown): boolean => versionParts(value) !== null;
export const isPrerelease = (version: string): boolean => (versionParts(version)?.[3] ?? null) !== null;

/** SemVer precedence restricted to `x.y.z[-rc.N]`: a final version sorts after its rcs. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) throw new Error(`invalid version: ${left ? b : a}`);
  for (let i = 0; i < 4; i++) {
    const l = left[i];
    const r = right[i];
    if (l === r) continue;
    if (l === null) return 1;
    if (r === null) return -1;
    return (l as bigint) > (r as bigint) ? 1 : -1;
  }
  return 0;
}

const fail = (message: string): never => { throw new Error(`releases.json: ${message}`); };

const IsoDate = z.string().refine((value) => ISO.test(value) && !Number.isNaN(Date.parse(value)), 'must be an ISO 8601 UTC date');

const HttpsUrl = z.string().refine((value) => {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
}, 'must be a plain https: URL, without credentials or query');

const Artifact = z.object({
  name: z.string().regex(ASSET, 'is not a plain file name'),
  url: HttpsUrl,
  size: z.number().int().min(1).refine(Number.isSafeInteger, 'must be a positive integer'),
  sha256: z.string().regex(SHA256, 'must be 64 lowercase hex digits'),
}).strict();

const Channel = z.object({
  version: z.string().refine(isVersion, 'is not x.y.z[-rc.N]'),
  publishedAt: IsoDate,
  notesUrl: HttpsUrl,
  notes: z.string().max(NOTES_MAX),
  artifacts: z.record(z.string(), Artifact).superRefine((artifacts, ctx) => {
    const keys = Object.keys(artifacts);
    if (!keys.length) ctx.addIssue({ code: 'custom', message: 'is empty' });
    for (const key of keys) {
      const match = ARTIFACT_KEY.exec(key);
      if (!match || !OS_FORMATS[match[1]!]!.includes(match[3]!)) ctx.addIssue({ code: 'custom', message: `unknown artifact key ${key}` });
    }
  }),
}).strict();

export const ReleasesPayloadSchema = z.object({
  schema: z.literal(RELEASES_SCHEMA),
  issuedAt: IsoDate,
  expiresAt: IsoDate,
  channels: z.object({ beta: Channel.optional(), stable: Channel.optional() }).strict(),
}).strict().superRefine((payload, ctx) => {
  if (Date.parse(payload.issuedAt) >= Date.parse(payload.expiresAt)) ctx.addIssue({ code: 'custom', message: 'expiresAt must follow issuedAt' });
  const { beta, stable } = payload.channels;
  if (!beta && !stable) ctx.addIssue({ code: 'custom', message: 'channels must list at least one channel' });
  if (stable && isPrerelease(stable.version)) ctx.addIssue({ code: 'custom', message: `an rc (${stable.version}) never goes to the stable channel` });
  if (beta && stable && compareVersions(beta.version, stable.version) < 0) {
    ctx.addIssue({ code: 'custom', message: 'the beta channel carries the highest version of rc and final, never less than stable' });
  }
});

export type ReleasesPayload = z.infer<typeof ReleasesPayloadSchema>;
export type ReleaseChannelEntry = z.infer<typeof Channel>;
export type ReleaseArtifact = z.infer<typeof Artifact>;

/** The strict payload shape (schema 1): any unknown field is refused. */
export function validateReleasesPayload(payload: unknown): ReleasesPayload {
  const parsed = ReleasesPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(`${issue?.path.join('.') || 'payload'} ${issue?.message ?? 'is invalid'}`);
  }
  return parsed.data;
}

const Envelope = z.object({ keyId: z.string(), payload: z.unknown(), sig: z.unknown() }).strict();

function strictBase64(value: unknown, where: string): Buffer {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0 || !BASE64.test(value)) return fail(`${where} is not base64`);
  return Buffer.from(value, 'base64');
}

const signedBytes = (payloadBytes: Buffer): Buffer => Buffer.concat([Buffer.from(RELEASES_SIGNATURE_DOMAIN, 'utf8'), payloadBytes]);

export type VerifyOptions = {
  now?: Date;
  /** The highest `issuedAt` already accepted: an older manifest is refused, an equal one accepted. */
  minIssuedAt?: string | null;
};

/**
 * The payload of a verified envelope (its text or the parsed object). The
 * signature is checked BEFORE the payload is parsed; every failure throws and
 * the caller treats it as "no update known", never as an offer. Unlike the
 * build machine's copy there is no `allowExpired`: the daemon never reads an
 * expired manifest.
 */
export function verifyReleaseManifest(input: string | Buffer | unknown, keyring: readonly ReleasePublicKey[], options: VerifyOptions = {}): ReleasesPayload {
  const now = options.now ?? new Date();
  let envelope: unknown = input;
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    if (input.length > ENVELOPE_MAX) fail('envelope too large');
    try { envelope = JSON.parse(input.toString()) as unknown; } catch { fail('envelope is not JSON'); }
  }
  const parsed = Envelope.safeParse(envelope);
  if (!parsed.success) return fail('envelope must be exactly { keyId, payload, sig }');
  const { keyId } = parsed.data;
  const key = keyring.find((entry) => entry.keyId === keyId);
  if (!key) return fail(`unknown keyId ${JSON.stringify(keyId).slice(0, 80)}`);
  if (key.expiresAt && Date.parse(key.expiresAt) <= now.getTime()) fail(`key ${key.keyId} has expired`);
  const bytes = strictBase64(parsed.data.payload, 'payload');
  const signature = strictBase64(parsed.data.sig, 'sig');
  if (signature.length !== 64 || !verify(null, signedBytes(bytes), key.publicKey, signature)) fail('invalid signature');
  let payload: unknown;
  try { payload = JSON.parse(bytes.toString('utf8')) as unknown; } catch { fail('payload is not JSON'); }
  const valid = validateReleasesPayload(payload);
  const issued = Date.parse(valid.issuedAt);
  if (Date.parse(valid.expiresAt) <= now.getTime()) fail(`expired on ${valid.expiresAt}`);
  if (issued > now.getTime() + CLOCK_SKEW_MS) fail(`issued in the future (${valid.issuedAt})`);
  if (options.minIssuedAt && issued < Date.parse(options.minIssuedAt)) {
    fail(`older than the last accepted manifest (${valid.issuedAt} < ${options.minIssuedAt})`);
  }
  return valid;
}
