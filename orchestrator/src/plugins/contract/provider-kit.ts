/**
 * The provider kit types the plugin contract names: `ctx.backends.registerProfile`
 * and `registerDialect`, `ctx.provider`, the usage a collector reports and the
 * backend catalogue; and the provider authoring types the SDK entry publishes
 * beside them, so that the entry names nothing outside `plugins/contract/`
 * (volet 4).
 *
 * One of the two doors out of `plugins/contract/`, by decision (arbitrated
 * 2026-10-29, TODO #512, volet 3). These types are already published as
 * `@rooks/sdk/provider`, from modules whose closure
 * `backends/sdk-closure.test.ts` pins to vetted leaves (no database, host,
 * settings or licence). Copying them here would make a second source of truth
 * for the frozen provider contract, and moving them would change the published
 * kit's layout; re-exporting them keeps one source. Every module named below
 * must stay in that pinned closure (`contract-imports.test.ts`).
 */
export type {
  AccountUsage, ApprovalScope, BackendCapabilities, BackendCapability, BackendLaunchContext, BackendProfile, BuildSpawnOpts,
  Dialect, DiscoveredModel, EnvResolver, ImageAttachment, LocalEnvPolicy, NormalizedEvent, PermissionDecision,
  PermissionModel, PermissionRequest, PermissionWait, ProfileRuntime, ProviderConfig, RateLimitReporting, RegisteredProfile,
  RemoteDialect, RemoteResumeState, RemoteSessionHost, RemoteSessionOpenArgs, RemoteSessionResume, SecretRef,
  SessionAnswer, SessionAskOutcome, SessionAskRequest, SessionCapabilities, SessionDriver, SessionEnd, SessionHost, SessionInfo,
  SessionQuestion, SessionQuestionOption, SessionStore, SpawnResult, TurnOutcome,
  UsageProbeOptions, UsageWindow,
} from '../../backends/types.js';
export type { CatalogModel } from '../../backends/catalog-model.js';
export type { ProviderServices } from '../../backends/provider-plugin-context.js';
export type { DeclaredReasoningControl, ModelReasoning, ReasoningControl } from '../../backends/reasoning-control.js';
