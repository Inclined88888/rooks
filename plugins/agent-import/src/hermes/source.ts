/**
 * Hermes direct: reads the profiles the daemon detected and turns them into a
 * `timon-agent-import` v1 manifest. The disk is read here and only here — see
 * the exception stated in `detect.ts`.
 */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentImportManifest } from '../manifest.js';
import { readDirSource } from '../readers/dir.js';
import type { HermesInstallation, HermesProfile } from './detect.js';
import { readEnvNames } from './env-names.js';
import { HERMES_WANTS, hermesToManifest, type HermesProfileInput } from './manifest.js';

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** One profile through the folder reader (deny list, `wants`, no link followed) and the narrow `.env` reading. */
export async function readHermesProfile(profile: HermesProfile): Promise<HermesProfileInput> {
  const tree = await readDirSource(profile.root, HERMES_WANTS);
  const env = await readEnvNames(profile.root);
  const hasHistory = await present(join(profile.root, 'state.db')) || await present(join(profile.root, 'sessions'));
  return {
    name: profile.name,
    tree,
    envNames: env.names,
    envSkipped: env.skipped,
    envTruncated: env.truncated,
    hasHistory,
  };
}

/**
 * The manifest of `names` (every detected profile when absent). A name is
 * only ever matched against what `detectHermes` found: it never becomes a path.
 */
export async function readHermesManifest(
  installation: HermesInstallation,
  names?: readonly string[],
  now: () => Date = () => new Date(),
): Promise<AgentImportManifest> {
  const wanted = names ? new Set(names) : null;
  const profiles = installation.profiles.filter((p) => !wanted || wanted.has(p.name));
  const inputs: HermesProfileInput[] = [];
  for (const profile of profiles) inputs.push(await readHermesProfile(profile));
  return hermesToManifest(inputs, { exportedAt: now().toISOString() });
}
