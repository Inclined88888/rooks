/**
 * Log, storage, settings and host execution shapes of `PluginContext`.
 *
 * Extracted verbatim from `plugins/context.ts`, which re-exports it: the public
 * contract lives in leaf modules so `@timon-ai/sdk` can name it without the
 * implementation (TODO #512, option B).
 */

export type PluginLog = {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

export type PluginStorage = {
  kv: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    del(key: string): Promise<void>;
    list(prefix?: string): Promise<{ key: string; value: unknown }[]>;
  };
  /** `~/.timon/plugins-data/<id>/`, created on first access. */
  readonly dir: string;
};

/** A prepared statement of the plugin's own database. Parameters bind positionally or by name. */
export type PluginSqlStatement = {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number };
};

/**
 * The plugin's own SQLite database (API 15, permission `storage:sql`): a file of
 * its own under its data folder, migrated by the core from the manifest's
 * `migrations` folder before `apply`. Synchronous, like the queries it runs.
 * `ATTACH`, `DETACH` and `load_extension` are refused.
 */
export type PluginSqlDatabase = {
  prepare(sql: string): PluginSqlStatement;
  /** Runs `fn` in one transaction: everything or nothing. */
  transaction<T>(fn: () => T): T;
};

export type PluginSettingValue = string | number | boolean | undefined;

export type PluginExecResult = { code: number; stdout: string; stderr: string };

/**
 * What `ctx.host.exec`, `ctx.fetch`, `ctx.missions.spawn` and the provider
 * services reject with when the operator's plugin policy (`pluginPolicy`)
 * refuses the call — distinct from an undeclared permission. The class lives in
 * the daemon, so a plugin cannot `instanceof` it: it tells it by `name`, and
 * `rule` names what refused.
 */
export interface PluginPolicyError extends Error {
  readonly name: 'PluginPolicyError';
  readonly pluginId: string;
  readonly rule: string;
}

export type PluginUser = {
  id: string;
  email: string;
  name: string;
  is_superadmin: boolean;
};
