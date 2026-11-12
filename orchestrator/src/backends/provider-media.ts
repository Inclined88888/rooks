/**
 * S6 — `ctx.provider.media`: a provider adopts, into a turn, the files its CLI
 * produced (`docs/PROVIDERS-SDK.md` § 6.1). The product's codex does it by hand
 * (`collectGeneratedImages` from `enrichEvent`, a folder of its own known to the
 * missions route); here the daemon does it for any provider, with its own limits.
 *
 * What the daemon decides, and the plugin does not: where a file may come from (the
 * mission's scratch folder for this plugin, or its working directory — never an
 * arbitrary path), how many and how large (`chat-media.ts`), that it IS a picture
 * (magic bytes, not the extension), and that one file is shown once.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { collectGeneratedImages } from '../chat-media.js';
import type { ProviderGeneratedMedia } from './provider-services.js';

export class MediaDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaDirectoryError';
  }
}

function real(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** `directory`, resolved, if it lies inside one of `roots`; a path that leads elsewhere through a link is judged by where it ends. */
export function directoryWithin(directory: string, roots: ReadonlyArray<string | undefined>): string {
  if (typeof directory !== 'string' || directory === '') throw new MediaDirectoryError('a media directory is required');
  const target = real(resolve(directory));
  if (!target) throw new MediaDirectoryError(`\`${directory}\` does not exist`);
  const allowed = roots.flatMap((root) => (root ? [real(root)] : [])).filter((root): root is string => root !== null);
  if (!allowed.some((root) => inside(root, target))) {
    throw new MediaDirectoryError(`\`${directory}\` is neither in this mission's scratch folder nor in its working directory`);
  }
  return target;
}

export function adoptGeneratedMedia(input: {
  missionId: string;
  directory: string;
  sinceMs: number;
  roots: ReadonlyArray<string | undefined>;
}): ProviderGeneratedMedia[] {
  const source = directoryWithin(input.directory, input.roots);
  if (!Number.isFinite(input.sinceMs)) throw new MediaDirectoryError('`sinceMs` must be a timestamp in milliseconds');
  // Videos are not collected from a CLI's output, only pictures (`collectGeneratedImages`).
  return collectGeneratedImages(input.missionId, source, input.sinceMs).map((media) => ({ ...media, kind: 'image' as const }));
}

/* ── Folders the agent may SHOW from, beyond its working directory ───────── */

const showable = new Map<string, Set<string>>();

export function allowShowFrom(missionId: string, directory: string, roots: ReadonlyArray<string | undefined>): void {
  const target = directoryWithin(directory, roots);
  const known = showable.get(missionId) ?? new Set<string>();
  known.add(target);
  showable.set(missionId, known);
}

/** The folders a provider opened to `chat_show_media` for this mission. */
export function providerMediaRoots(missionId: string): string[] {
  return [...(showable.get(missionId) ?? [])];
}

export function forgetProviderMediaRoots(missionId: string): void {
  showable.delete(missionId);
}
