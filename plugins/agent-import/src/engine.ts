/**
 * The import engine: reads a `timon-agent-import` v1 manifest, previews it,
 * applies it. One import at a time per daemon: two applies planning names in
 * parallel would both pick the same free one.
 */
import type { PluginContext } from '@timon-ai/sdk';
import { applyPlan } from './apply.js';
import type { ApplyResponse, ImportOptions, ImportPreview } from './contract.js';
import { MANIFEST_FILE, ManifestError, parseManifestText, type AgentImportManifest } from './manifest.js';
import { planImport, type EngineContext } from './plan.js';
import { ReaderError, compileGlob, globMatches, type SourceTree } from './readers/policy.js';
import { readZipFile } from './readers/zip.js';
import { createRecords, trackAgents } from './records.js';
import { BUILTIN_SOURCES, manifestFromSource, type SourceAdapter } from './sources/index.js';

/** A manifest is text: past this it is not one. */
export const MANIFEST_MAX_BYTES = 10 * 1024 * 1024;

/** Detection reads only the files a source is recognised by: a few kilobytes, whatever the archive holds. */
async function readZip(path: string, wants: readonly string[]): Promise<SourceTree> {
  try {
    return await readZipFile(path, wants);
  } catch (err) {
    if (err instanceof ReaderError) throw new ManifestError(`The archive cannot be read: ${err.message}.`);
    throw err;
  }
}

/**
 * The manifest of a staged archive: `timon-agent-import.json` at its root, or
 * what the source adapter that recognises the archive makes of it. Throws a
 * `ManifestError` the user can act on.
 */
export async function readManifestFromZip(
  path: string,
  sources: readonly SourceAdapter[] = BUILTIN_SOURCES,
): Promise<AgentImportManifest> {
  const zipSources = sources.filter((s) => s.accepts.includes('zip'));
  const detect = [MANIFEST_FILE, ...zipSources.flatMap((s) => s.detect)];
  const found = await readZip(path, detect);
  const bytes = found.files.get(MANIFEST_FILE);
  if (bytes) {
    if (bytes.length > MANIFEST_MAX_BYTES) throw new ManifestError(`${MANIFEST_FILE} is too large to be read.`);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ManifestError(`${MANIFEST_FILE} is not UTF-8 text.`);
    }
    return parseManifestText(text);
  }
  if (found.skipped.some((s) => s.path === MANIFEST_FILE)) throw new ManifestError(`${MANIFEST_FILE} is too large to be read.`);

  const present = [...found.files.keys()].map((p) => p.split('/'));
  const source = zipSources.find((s) => s.detect.some((glob) => {
    const compiled = compileGlob(glob);
    return present.some((segments) => globMatches(compiled, segments));
  }));
  if (!source) {
    // Only the format of Timon is named: what other sources detect is theirs to recognise.
    throw new ManifestError(`The archive holds no ${MANIFEST_FILE} at its root, nor an agent export Timon recognises.`);
  }
  return manifestFromSource(source, await readZip(path, source.wants));
}

export type Engine = {
  preview(manifest: AgentImportManifest, options?: ImportOptions): Promise<ImportPreview>;
  apply(manifest: AgentImportManifest, options?: ImportOptions): Promise<ApplyResponse>;
};

export function createEngine(ctx: PluginContext): Engine {
  const records = createRecords(ctx.storage.kv);
  trackAgents(ctx, records);
  const engineCtx: EngineContext = ctx;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };
  return {
    preview: (manifest, options) => serial(async () => (await planImport(engineCtx, records, manifest, options)).preview),
    apply: (manifest, options) => serial(async () => applyPlan(engineCtx, records, await planImport(engineCtx, records, manifest, options))),
  };
}
