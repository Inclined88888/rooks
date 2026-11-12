/**
 * The `models` pack of a `kind: dictation` plugin (TODO #584): the JSON file
 * its manifest names (`dictation.models`), read from the installed package
 * and served by `GET /api/plugins/:id/-/dictation-models`.
 *
 * Why the daemon serves it rather than the plugin's browser half: the desktop
 * fetches the pack ITSELF, by plugin id, before it shows its native box. The
 * entry the user confirms is then the one the installed (signed) package
 * ships, attested by the host that admitted it — never a model a page of the
 * shared realm wrote and labelled with someone else's id.
 *
 * The daemon does not know the speech catalog's schema (it lives in the
 * desktop, which parses every entry again with zod): here only the file's
 * place, its size and its outer shape are judged.
 */
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import type { PluginManifest } from './manifest.js';

/** A pack lists a few entries of a few hundred bytes each: anything larger is not one. */
export const MAX_DICTATION_PACK_BYTES = 256 * 1024;
/** Same bound as the engines of a plugin: a pack is a short list the user reads. */
export const MAX_DICTATION_PACK_MODELS = 16;

const entrySchema = z.record(z.string(), z.unknown());
const packFileSchema = z.object({
  /** An editor's hint, tolerated; nothing else beside `models`. */
  $schema: z.string().max(512).optional(),
  models: z.array(entrySchema).min(1).max(MAX_DICTATION_PACK_MODELS),
}).strict();

export type DictationPackRead =
  | { ok: true; models: Record<string, unknown>[] }
  | { ok: false; code: 'no-pack' | 'outside' | 'too-large' | 'invalid'; message: string };

/**
 * The pack of an installed plugin. `no-pack`: not a dictation plugin, or no
 * `models` declared. The path is resolved against the package directory the
 * loader discovered, never against anything a request carries.
 */
export function readDictationPack(dir: string, manifest: Pick<PluginManifest, 'kind' | 'dictation'> | null): DictationPackRead {
  const declared = manifest?.kind.includes('dictation') ? manifest.dictation?.models : undefined;
  if (!declared) return { ok: false, code: 'no-pack', message: 'This plugin declares no speech models.' };
  let real: string;
  try {
    const root = realpathSync(dir);
    real = realpathSync(resolve(dir, declared));
    // Admission checked it once; the package may have changed since.
    if (!real.startsWith(root + sep)) return { ok: false, code: 'outside', message: 'The speech models file is not a file of the package.' };
  } catch {
    return { ok: false, code: 'outside', message: 'The speech models file is not a file of the package.' };
  }
  let text: string;
  let fd: number | null = null;
  try {
    // `O_NOFOLLOW` where it exists: the path was just resolved, a link swapped in since is refused.
    fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, code: 'outside', message: 'The speech models file is not a file of the package.' };
    if (stat.size > MAX_DICTATION_PACK_BYTES) return { ok: false, code: 'too-large', message: 'The speech models file is too large.' };
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = readSync(fd, buffer, read, stat.size - read, read);
      if (n === 0) break;
      read += n;
    }
    text = buffer.subarray(0, read).toString('utf8');
  } catch {
    return { ok: false, code: 'outside', message: 'The speech models file could not be read.' };
  } finally {
    if (fd !== null) closeSync(fd);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, code: 'invalid', message: 'The speech models file is not valid JSON.' };
  }
  const parsed = packFileSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, code: 'invalid', message: `The speech models file is not a pack (expected { "models": [ … ] }, 1 to ${MAX_DICTATION_PACK_MODELS} entries).` };
  }
  return { ok: true, models: parsed.data.models };
}
