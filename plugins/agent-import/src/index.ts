/**
 * Agent import — host half.
 *
 * Brings agents from another tool (Hermes, Grok Bot, OpenBot, another Rooks)
 * into Rooks: an archive is staged under a single-use token, previewed, then
 * applied. Written only with the public plugin SDK; it acts through the same
 * facades a third-party plugin would, and owns what it creates.
 *
 * The engine reads a `rooks-agent-import` v1 manifest from the staged archive,
 * previews it and applies it agent by agent; source adapters (OpenBot,
 * Hermes) produce that manifest.
 *
 * Named exception: the Hermes direct source (`hermes/`) reads the daemon's
 * own disk, which no third-party plugin may do. It cannot be rewritten as an
 * unprivileged plugin until the SDK has a hook for declared readable roots.
 */
import type { PluginContext } from '@rooks/sdk';
import { createEngine } from './engine.js';
import { registerAppliedEvent } from './event.js';
import { mountRoutes } from './routes.js';
import { createStaging } from './staging.js';

export const name = 'agent-import';

export * from './contract.js';
export { appliedEventId, publishApplied } from './event.js';
export { STAGE_MAX_BYTES, STAGE_TTL_MS, STAGES_PER_ACCOUNT } from './staging.js';
export * from './manifest.js';
export { createEngine, readManifestFromZip, MANIFEST_MAX_BYTES, type Engine } from './engine.js';
export { MEMORY_RULES_PER_AGENT, ROUTINE_PROMPT_MAX, planImport, suggestCwd, type EngineContext, type ImportPlan, type AgentPlan } from './plan.js';
export { applyPlan } from './apply.js';
export { buildExport, keyOf, ExportError, EXPORT_SOURCE_APP, EXPORT_MAX_AGENTS, type ExportRequest, type ExportResult } from './export.js';
export { createRecords, type Records, type ImportRecord } from './records.js';
export { stripAllowedTools } from './skill-text.js';
export { detectHermes, hermesRootCandidate, HERMES_PROFILE_RE, type HermesInstallation, type HermesProfile, type HermesPlatform } from './hermes/detect.js';
export { parseEnvNames, readEnvNames, ENV_FILE_MAX_BYTES, ENV_NAMES_MAX, type EnvNames } from './hermes/env-names.js';
export {
  HERMES_SOURCE_APP, HERMES_WANTS, hermesSchedule, hermesToManifest, memoryEntries, soulText,
  type HermesProfileInput,
} from './hermes/manifest.js';
export { readHermesManifest, readHermesProfile } from './hermes/source.js';
export { readDirSource } from './readers/dir.js';
export { redactArgs, sanitizeUrl } from './redact.js';

export function apply(ctx: PluginContext): void {
  registerAppliedEvent(ctx);
  const staging = createStaging(ctx.storage);
  mountRoutes(ctx, staging, createEngine(ctx));
  // Leftovers of a daemon stopped mid-upload or of tokens never used.
  staging.sweep().catch((err: unknown) => {
    ctx.log.warn('staging sweep failed:', err instanceof Error ? err.message : 'unknown error');
  });
}
export {
  BUILTIN_SOURCES, manifestFromSource, skippedWarnings, openbotSource, openbotToManifest, decodeSchedule,
  OPENBOT_FORMAT, OPENBOT_MANIFEST_FILE, OPENBOT_SOURCE_ID, OPENBOT_VERSION, OPENBOT_WANTS,
  type AdapterTree, type AdapterManifest, type SourceAdapter, type SourceAdapterResult,
} from './sources/index.js';
