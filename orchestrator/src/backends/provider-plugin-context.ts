/**
 * The part of `PluginContext` a provider plugin uses, written structurally so the
 * SDK can publish it on its own: `apply(ctx)` of a provider plugin is typed with
 * this, and nothing else of the host contract has to travel with the provider kit.
 *
 * A compile-time guard at the end of `plugins/context.ts` asserts that the whole
 * `PluginContext` is assignable to it, so the two cannot drift: widening one
 * member here without the host providing it fails the build.
 */

import type { NativeProviderDefinition } from './engine/definition.js';
import type { BuildSpawnOpts } from './types.js';
import type {
  ProviderCredentialStore, ProviderAccount, ProviderBinary, ProviderEnvPlan, ProviderGit, ProviderMcpOptions, ProviderMcpPlan, ProviderMedia, ProviderOsCredentials, ProviderRedact,
  ProviderScratch,
} from './provider-services.js';
import type { ProviderRuntime } from './provider-runtime.js';
import type { BackendProfile, Dialect, RegisteredProfile, RemoteDialect } from './types.js';

/** What `ctx.settings.get` returns: the value of a declared setting, or its default. */
export type ProviderSettingValue = string | number | boolean | undefined;

/**
 * `ctx.provider` (API 12, `backends:register`): what the daemon provides to a
 * provider so that it does not rebuild it. Every member refuses a plugin that
 * declared an older `apiVersion`.
 */
export type ProviderServices = {
  /**
   * The behaviour a provider is written with — codecs, the usage-limit detector,
   * the MCP serializers, the session drivers, the ACP client — as the DAEMON runs
   * it. A fix made in the daemon reaches every plugin at once; none carries a copy.
   */
  readonly runtime: ProviderRuntime;
  /** Release-owned credential storage: third parties are refused, including official-id copies. */
  credentialStore(spec: { store: string; key: string; marker: string }): ProviderCredentialStore;
  /** A custom profile's model controls, resolved by the daemon's catalogue. */
  modelReasoning(profile: import('./types.js').ProfileRuntime, model: string | undefined): Promise<import('./reasoning-control.js').ModelReasoning | undefined>;

  /**
   * S1 — Timon's MCP servers for the mission being launched, neutral, with the
   * identity as a reference the daemon swaps for the mission's token where the
   * data reaches the MCP servers: the stdin payload of the launch, the session's
   * pipe, a file written with `scratch.writeFile`. Never the command line nor the
   * environment — the launch fails if a reference is found in `args` or `env`
   * (any account reads a process list; every child of the CLI inherits its
   * environment). The token is never returned to the plugin, whoever it is.
   */
  mcp(spawn: BuildSpawnOpts, options?: ProviderMcpOptions): Promise<ProviderMcpPlan>;
  /**
   * S2 — the base environment of the mission's process: what a provider that
   * inspects the environment (to find an API key) must start from, without
   * rebuilding what the daemon decides. A third-party provider gets no vault
   * value and none of the daemon's environment.
   */
  env(spawn: BuildSpawnOpts): Promise<ProviderEnvPlan>;
  /** S3 — a private folder per mission, with the file operations that go wrong by hand. */
  readonly scratch: ProviderScratch;
  /**
   * S4 — the programs the manifest declares: where they are, which version, a short
   * question to ask them, a headless server to start. Only a name in `provider.binaries`;
   * the process gets no credential of the daemon's. A probe never opens a session.
   */
  readonly binary: ProviderBinary;
  /** S3 bis — the folders a sandboxed CLI must be able to write for git to work in a working directory. */
  readonly git: ProviderGit;
  /** S7 — the subscription account a launch runs on. */
  readonly account: ProviderAccount;
  /** S6 — adopt into a turn the pictures a CLI produced. */
  readonly media: ProviderMedia;
  /** S8 — one entry of the OS credential store, read-only, only if the manifest declared it. */
  readonly osCredentials: ProviderOsCredentials;
  /** S5 — the daemon's redaction, applied to what your provider emits. */
  readonly redact: ProviderRedact;
  /**
   * Registers a provider written against the SDK: a `ProviderDefinition` (transport ×
   * codec × strategies, plus what it declares to the core) instead of a `Dialect`.
   * It is checked before it is adapted — a capability declared without the member
   * that serves it is refused, naming both (`runtime.check.definitionProblems` runs the
   * same check in your tests) — and the binary it names must be one of the manifest's
   * `provider.binaries`. Removed when the plugin unloads.
   */
  registerProvider(definition: NativeProviderDefinition): () => void;
  /**
   * Replaces, in one step, the provider this plugin registered under the same id: the
   * old one serves until the new is in place, so the backend never disappears from the
   * registry, and a running mission keeps the one it holds. Refused if the transport or
   * the session store would change (restart the missions to apply such a version).
   */
  replaceProvider(definition: NativeProviderDefinition): () => void;
  /**
   * Registers a profile of the PRODUCT's own, with what a plugin's profile cannot carry: a reference to a
   * vault entry (`env: { KEY: { secret: 'NAME' } }`), `envFrom`, `requiredEnv`, a public models endpoint, a
   * folder of its own to mask (`credentialDirs`). Reserved to a plugin shipped in the release (a third party
   * naming a vault entry would read it without holding `secrets:read`): anyone else is refused. The profile
   * sits INACTIVE until the dialect it names is installed — `ollama-cloud` rides on `codex`, whichever plugin
   * loads first — and is removed when the plugin unloads.
   */
  registerProductProfile(profile: BackendProfile): () => void;
};

export type ProviderPluginContext = {
  /** Requires `backends:register`. Registrations are removed when the plugin unloads. */
  backends: {
    registerProfile(profile: RegisteredProfile): () => void;
    registerDialect(id: string, dialect: Dialect | RemoteDialect): () => void;
  };
  /** Requires `backends:register` and `apiVersion` 12. */
  provider: ProviderServices;
  /** Requires `settings`. Reads the plugin's own declared settings, secrets included. */
  settings: { get(key: string): ProviderSettingValue };
  log: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
};
