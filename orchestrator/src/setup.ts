/**
 * First-run setup (plan §5.4) — what the wizard writes, and when it shows.
 *
 * The wizard exists because a fresh install has no `rooks.config.json`, and
 * the defaults of the schema describe the maintainers' machine (a Linux
 * desktop running the daemon from a source checkout). On anyone
 * else's machine those defaults are wrong in a way nothing reports: the daemon
 * boots, the UI opens, and agents fail to spawn much later with an ENOENT.
 *
 * `firstRun` is `true` when — and only when — the file is absent. Not "when
 * the file is incomplete": every key is optional by design, and an install
 * that deliberately keeps the defaults must not be asked the same questions on
 * every boot.
 *
 * Writing is deliberately NARROW. The wizard sets the five things a human can
 * answer on a first screen; everything else stays absent, which means "the
 * default", which stays true if the default later changes.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { usableProviders } from './backends/usable.js';
import { config, configSource, CONFIG_FILE } from './config/load.js';
import { EditionSchema, ProfileSchema, RooksConfigSchema } from './config/schema.js';

/**
 * Values the environment decided for THIS run, which the file must inherit
 * (step 5.7.6).
 *
 * A packaged first launch has no config file: the desktop shell picks the
 * ports itself (3010/3110, free of the v1 and of the dev home) and passes them
 * to the daemon through `ENV_OVERRIDES`. The moment this wizard writes a file,
 * those overrides stop being injected — the shell sees a config and hands the
 * decision back to it. A file that does not carry them therefore silently
 * reverts the install to the schema defaults (3000/3100, UI off): the daemon
 * moves, the client keeps looking where it was, and the window opens on
 * nothing. Same failure as step 5.6.3, one screen later.
 *
 * `daemon.installDir` is deliberately NOT inherited: inside an AppImage it is
 * a `/tmp/.mount_XXXX` path that changes at every launch, so writing it down
 * would be wrong by tomorrow. It stays an environment decision, every time.
 */
export type EnvDecisions = {
  daemonPort?: number;
  appPort?: number;
  appEnabled?: boolean;
};

/** What the env layer decided in the RUNNING daemon. */
export function readEnvDecisions(cfg = config()): EnvDecisions {
  const out: EnvDecisions = {};
  if (configSource('daemon.listen.port') === 'env') out.daemonPort = cfg.daemon.listen.port;
  if (configSource('app.listen.port') === 'env') out.appPort = cfg.app.listen.port;
  if (configSource('app.enabled') === 'env') out.appEnabled = cfg.app.enabled;
  return out;
}

type Json = Record<string, unknown>;

/** Writes the inherited values, without ever overriding an explicit answer. */
function mergeEnvDecisions(cfg: Json, env: EnvDecisions): void {
  if (env.daemonPort !== undefined) {
    const daemon = (cfg['daemon'] ?? {}) as Json;
    daemon['listen'] = { ...(daemon['listen'] as Json ?? {}), port: env.daemonPort };
    cfg['daemon'] = daemon;
  }
  if (env.appPort !== undefined || env.appEnabled !== undefined) {
    const app = (cfg['app'] ?? {}) as Json;
    if (env.appPort !== undefined) app['listen'] = { ...(app['listen'] as Json ?? {}), port: env.appPort };
    // The checkbox wins when the user touched it; otherwise a package keeps
    // serving its own UI, which is the only thing serving one at all.
    if (env.appEnabled !== undefined && app['enabled'] === undefined) app['enabled'] = env.appEnabled;
    cfg['app'] = app;
  }
}

export type SetupInput = {
  edition?: string;
  profile?: string;
  /** Absolute paths pinned by the user; an empty value means "search the PATH". */
  binaries?: Record<string, string | null>;
  /** `none` = portable mode: the desktop client runs the daemon itself. */
  supervisor?: string;
  /** Whether the daemon serves the Next app as a child. */
  appEnabled?: boolean;
  /**
   * Obsidian vault. Written as the SETTING the code actually reads
   * (`ROOKS_BRAIN_VAULT`), not as `modules['@rooks/vault'].path`: that key is
   * expanded by the loader but nothing consumes it, so writing there would
   * configure nothing and look configured.
   */
  vaultPath?: string;
  /** Injected by the tests; production reads the running configuration. */
  envDecisions?: EnvDecisions;
};

export class SetupError extends Error {}

/** No config file = nobody has ever answered these questions on this machine. */
export function isFirstRun(file: string = CONFIG_FILE): boolean {
  return !existsSync(file);
}

/** The profile that matches this machine, used as the wizard's default. */
export function defaultProfile(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return 'linux-desktop';
}

/**
 * Builds the config object the wizard would write. Kept separate from the
 * write so the route can validate, and the tests assert, without touching a
 * filesystem.
 */
export function buildSetupConfig(input: SetupInput): Record<string, unknown> {
  const edition = input.edition ?? 'expert';
  if (!EditionSchema.safeParse(edition).success) {
    throw new SetupError(`unknown edition: ${edition}`);
  }
  const profile = input.profile ?? defaultProfile();
  if (!ProfileSchema.safeParse(profile).success) {
    throw new SetupError(`unknown profile: ${profile}`);
  }

  const cfg: Record<string, unknown> = { version: 1, edition, profile };

  // An empty string is the user clearing a field, not pinning "". It means
  // "search the PATH", which is exactly what an absent key already says.
  const binaries: Record<string, string> = {};
  for (const [name, path] of Object.entries(input.binaries ?? {})) {
    if (typeof path === 'string' && path.trim() !== '') binaries[name] = path.trim();
  }
  if (Object.keys(binaries).length > 0) cfg['host'] = { binaries };

  if (input.supervisor !== undefined) {
    cfg['daemon'] = { supervisor: input.supervisor };
  }
  if (input.appEnabled !== undefined) {
    cfg['app'] = { enabled: input.appEnabled };
  }

  const vaultPath = (input.vaultPath ?? '').trim();
  if (vaultPath) cfg['settings'] = { ROOKS_BRAIN_VAULT: vaultPath };

  mergeEnvDecisions(cfg, input.envDecisions ?? readEnvDecisions());

  // The wizard must never write a file the daemon would then refuse to boot on.
  const parsed = RooksConfigSchema.safeParse(cfg);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join('.') : '<root>'}: ${i.message}`)
      .join('; ');
    throw new SetupError(`invalid setup — ${details}`);
  }
  return cfg;
}

/**
 * Writes `rooks.config.json`. Refuses to overwrite an existing file unless
 * `force`: the wizard is a FIRST-run screen, and a config someone has since
 * hand-edited must not be flattened by a stale browser tab.
 */
export function applySetup(
  input: SetupInput,
  file: string = CONFIG_FILE,
  force = false,
): { path: string; config: Record<string, unknown>; firstSetup: boolean } {
  const packaged = process.env.ROOKS_DESKTOP_EMBEDDED === '1' || process.env.ROOKS_DESKTOP_SERVICE === '1';
  const cfg = buildSetupConfig(packaged ? { ...input, appEnabled: true } : input);
  const existed = existsSync(file);
  if (existed && !force) {
    throw new SetupError(`${file} already exists — setup refuses to overwrite it`);
  }
  // Personal integrations are opt-in on a fresh installation.
  cfg.modules = { ...(cfg.modules as Record<string, unknown> ?? {}), '@rooks/video-factory': false };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  // Writing does NOT arm step 5 any more (12/09/2026): only the end of a first
  // setup does, and only this function knows whether there was a configuration
  // here before. It reports the fact; `armRestartForFirstSetup` decides
  // (`onboarding-restart.ts`). A re-save over an existing file — the wizard
  // replayed, a settings write — is not a first setup, and must never offer to
  // restart a daemon whose agents are its children.
  return { path: file, config: cfg, firstSetup: file === CONFIG_FILE && !existed };
}

/**
 * Setup ends with something to think with. The core starts with no provider
 * guaranteed, and an instance written without one only fails at the first
 * message. The pins submitted with the form count: they are about to be written.
 * Returns the refusal to show, or `null`.
 */
export function noProviderForSetup(input: SetupInput, usable: (pins: Record<string, string>) => string[] = usableProviders): string | null {
  const pins: Record<string, string> = {};
  for (const [name, path] of Object.entries(input.binaries ?? {})) {
    if (typeof path === 'string' && path.trim() !== '') pins[name] = path.trim();
  }
  return usable(pins).length > 0
    ? null
    : 'No LLM provider can run on this machine yet — install or connect one (Claude, Codex, Grok, Copilot, or a provider plugin), then finish the setup.';
}
