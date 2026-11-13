/**
 * Archives waiting between `stage` and `apply`.
 *
 * The bytes are streamed to a folder of their own under the plugin's data
 * directory by the zip reader's `stageUpload`, then hashed. The record (owner, SHA-256, size, expiry) lives
 * in the plugin's key-value store under the SHA-256 of the token, never the
 * token itself: a copy of the store opens nothing. A token is single-use:
 * `claim` and `discard` remove the record before anything else, and a
 * synchronous in-memory set closes the window between two concurrent calls.
 * A token of another account answers exactly like an unknown one, and is
 * left intact: a stranger cannot burn somebody else's import.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import * as z from 'zod/mini';
import type { PluginStorage } from '@rooks/sdk';
import type { StagedArchive, StageResponse } from './contract.js';
import { ZIP_UPLOAD_MAX_BYTES } from './readers/limits.js';
import { ReaderError } from './readers/policy.js';
import { stageUpload } from './readers/upload.js';

const MiB = 1024 * 1024;

/** An export of agent configuration is text: a few MiB zipped. The zip reader's upload ceiling. */
export const STAGE_MAX_BYTES = ZIP_UPLOAD_MAX_BYTES;
/** Long enough to read a preview and tick a few boxes, short enough not to keep archives around. */
export const STAGE_TTL_MS = 60 * 60 * 1000;
/** Staged archives one account may hold at once: bounds the disk a single account can fill. */
export const STAGES_PER_ACCOUNT = 5;

const KEY_PREFIX = 'stage:';
const STAGING_DIR = 'staging';
/** Names `stageUpload` gives: `agent-import-` + the six characters of `mkdtemp`, on every OS. */
const ARCHIVE_FILE = 'source.zip';
const FOLDER_RE = /^agent-import-[A-Za-z0-9]{6}$/;
const TOKEN_BYTES = 32;

const RecordSchema = z.strictObject({
  owner: z.string().check(z.minLength(1)),
  folder: z.string().check(z.regex(FOLDER_RE)),
  sha256: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
  size: z.int().check(z.nonnegative()),
  createdAt: z.number(),
  expiresAt: z.number(),
});
type StagedRecord = z.infer<typeof RecordSchema>;

export type StageErrorCode = 'too_large' | 'not_a_zip' | 'empty' | 'too_many' | 'not_found' | 'archive_changed';

export class StageError extends Error {
  constructor(readonly code: StageErrorCode, message: string) {
    super(message);
    this.name = 'StageError';
  }
}

/** A claimed archive: the token is spent, the file stays until `release`. */
export type ClaimedArchive = StagedArchive & {
  path: string;
  release(): Promise<void>;
};

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function startsLikeZip(head: Buffer): boolean {
  // Local file header, or the end record of an empty archive.
  return head[0] === 0x50 && head[1] === 0x4b
    && ((head[2] === 0x03 && head[3] === 0x04) || (head[2] === 0x05 && head[3] === 0x06));
}

/** SHA-256 and first bytes of a file; `null` when it cannot be read. */
async function readDigest(path: string): Promise<{ sha256: string; head: Buffer } | null> {
  const hash = createHash('sha256');
  let head = Buffer.alloc(0);
  try {
    for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
      if (head.length < 4) head = Buffer.concat([head, chunk.subarray(0, 4 - head.length)]);
      hash.update(chunk);
    }
  } catch {
    return null;
  }
  return { sha256: hash.digest('hex'), head };
}

async function fileSha256(path: string): Promise<string | null> {
  return (await readDigest(path))?.sha256 ?? null;
}

export type Staging = ReturnType<typeof createStaging>;

export function createStaging(storage: PluginStorage, now: () => number = Date.now) {
  const root = (): string => join(storage.dir, STAGING_DIR);
  const archivePath = (folder: string): string => join(root(), folder, ARCHIVE_FILE);
  /** Digests whose claim or discard is under way. */
  const busy = new Set<string>();
  /** Uploads in flight per owner, counted against the per-account ceiling. */
  const uploading = new Map<string, number>();

  const removeFolder = (folder: string): Promise<void> => rm(join(root(), folder), { recursive: true, force: true });

  async function records(): Promise<Array<{ digest: string; record: StagedRecord }>> {
    const out: Array<{ digest: string; record: StagedRecord }> = [];
    for (const { key, value } of await storage.kv.list(KEY_PREFIX)) {
      const parsed = RecordSchema.safeParse(value);
      const digest = key.slice(KEY_PREFIX.length);
      if (parsed.success) out.push({ digest, record: parsed.data });
      else await storage.kv.del(key);
    }
    return out;
  }

  async function drop(digest: string, record: StagedRecord): Promise<void> {
    await storage.kv.del(KEY_PREFIX + digest);
    await removeFolder(record.folder);
  }

  /** Removes expired stagings. */
  async function sweepExpired(): Promise<void> {
    const at = now();
    for (const { digest, record } of await records()) {
      if (record.expiresAt <= at && !busy.has(digest)) await drop(digest, record);
    }
  }

  /** At start-up: expired records, then folders no record points to (a daemon stopped mid-upload). */
  async function sweep(): Promise<void> {
    await sweepExpired();
    const kept = new Set((await records()).map(({ record }) => record.folder));
    let entries: string[];
    try { entries = await readdir(root()); } catch { return; }
    for (const name of entries) {
      // An upload under way has a folder and no record yet: not a leftover.
      if (uploading.size > 0) return;
      if (!kept.has(name)) await rm(join(root(), name), { recursive: true, force: true });
    }
  }

  async function stage(owner: string, body: AsyncIterable<Uint8Array>): Promise<StageResponse> {
    await sweepExpired();
    const held = (await records()).filter(({ record }) => record.owner === owner).length;
    const inFlight = uploading.get(owner) ?? 0;
    if (held + inFlight >= STAGES_PER_ACCOUNT) {
      throw new StageError('too_many', `At most ${STAGES_PER_ACCOUNT} imports may wait at once: finish or discard one first.`);
    }
    uploading.set(owner, inFlight + 1);
    try {
      await mkdir(root(), { recursive: true, mode: 0o700 });
      let upload: Awaited<ReturnType<typeof stageUpload>>;
      try {
        upload = await stageUpload(body, { dir: root(), maxBytes: STAGE_MAX_BYTES });
      } catch (err) {
        if (err instanceof ReaderError && err.code === 'too-large') {
          throw new StageError('too_large', `The archive is larger than ${STAGE_MAX_BYTES / MiB} MiB.`);
        }
        throw err;
      }
      try {
        const folder = basename(dirname(upload.path));
        const read = await readDigest(upload.path);
        if (upload.size === 0) throw new StageError('empty', 'The archive is empty.');
        if (!read || !startsLikeZip(read.head) || !FOLDER_RE.test(folder) || basename(upload.path) !== ARCHIVE_FILE) {
          throw new StageError('not_a_zip', 'The file is not a zip archive.');
        }
        const token = randomBytes(TOKEN_BYTES).toString('base64url');
        const createdAt = now();
        const record: StagedRecord = { owner, folder, sha256: read.sha256, size: upload.size, createdAt, expiresAt: createdAt + STAGE_TTL_MS };
        await storage.kv.set(KEY_PREFIX + tokenDigest(token), record);
        return { token, sha256: record.sha256, size: record.size, expiresAt: record.expiresAt };
      } catch (err) {
        await upload.dispose();
        throw err;
      }
    } finally {
      const left = (uploading.get(owner) ?? 1) - 1;
      if (left > 0) uploading.set(owner, left);
      else uploading.delete(owner);
    }
  }

  const notFound = (): StageError => new StageError('not_found', 'No pending import matches this token: it was used, discarded or has expired.');

  async function lookup(owner: string, token: string): Promise<{ digest: string; record: StagedRecord }> {
    const digest = tokenDigest(token);
    const parsed = RecordSchema.safeParse(await storage.kv.get(KEY_PREFIX + digest));
    // Someone else's token reads as an unknown one, and stays untouched.
    if (!parsed.success || parsed.data.owner !== owner || busy.has(digest)) throw notFound();
    if (parsed.data.expiresAt <= now()) {
      await drop(digest, parsed.data);
      throw notFound();
    }
    return { digest, record: parsed.data };
  }

  const describe = (record: StagedRecord): StagedArchive => ({ sha256: record.sha256, size: record.size, expiresAt: record.expiresAt });
  const changed = (): StageError => new StageError('archive_changed', 'The staged archive changed on disk since it was received: stage it again.');

  /** Reads a staging without spending its token; an altered archive is dropped. */
  async function inspect(owner: string, token: string): Promise<StagedArchive & { path: string }> {
    const { digest, record } = await lookup(owner, token);
    const path = archivePath(record.folder);
    if (await fileSha256(path) !== record.sha256) {
      if (!busy.has(digest)) await drop(digest, record);
      throw changed();
    }
    return { ...describe(record), path };
  }

  /** Spends the token, then checks the archive is still the one received. */
  async function claim(owner: string, token: string): Promise<ClaimedArchive> {
    const { digest, record } = await lookup(owner, token);
    if (busy.has(digest)) throw notFound();
    busy.add(digest);
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      try { await removeFolder(record.folder); } finally { busy.delete(digest); }
    };
    try {
      await storage.kv.del(KEY_PREFIX + digest);
      const path = archivePath(record.folder);
      if (await fileSha256(path) !== record.sha256) throw changed();
      return { ...describe(record), path, release };
    } catch (err) {
      await release();
      throw err;
    }
  }

  async function discard(owner: string, token: string): Promise<void> {
    const { digest, record } = await lookup(owner, token);
    if (busy.has(digest)) throw notFound();
    busy.add(digest);
    try {
      await drop(digest, record);
    } finally {
      busy.delete(digest);
    }
  }

  return { stage, inspect, claim, discard, sweep };
}
