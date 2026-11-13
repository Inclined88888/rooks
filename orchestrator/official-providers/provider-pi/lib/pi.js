// @ts-check
/**
 * Pi (pi.dev) driven directly over its RPC mode, `pi --mode rpc`. It used to run through the `pi-acp`
 * adapter, which drops the MCP servers ACP hands it, forwards no permission request, cannot confine
 * a one-shot and loses the reasoning; Pi's own protocol carries all of it (research of 29/10/2026,
 * vault `wiki/projects/rooks/dev/pi-rpc-direct-sans-pi-acp-research.md`).
 *
 * The session, its events, the model list, Rooks's tools and the gate of every tool call through
 * the bridge extension (`rooks-bridge.js`, policy in `permissions.js`, the Allow/Deny card through
 * the driver), and the daemon's one-shots confined at launch (`PI_ONE_SHOT_ARGS`).
 *
 * What the launch carries, and why:
 *  - `--session-id`: Rooks chooses the id (a fresh UUID, or the one to resume). Pi creates the
 *    session or reopens it; nothing has to be read back from the stream to resume it.
 *  - the system prompt by FILE (`--append-system-prompt <path>`, written in the mission's scratch
 *    folder): Rooks's preamble runs to tens of kilobytes, past what Windows accepts on a command
 *    line (32 767 characters), and Pi takes a path as well as text.
 *  - `--model provider/id` and `--thinking <level>`, the forms Pi documents.
 *  - `-e <scratch>/rooks-bridge.js`: the bridge, copied from this package at every launch so Pi reads
 *    a plain file of its own (never one inside the release). Its servers and the mission's
 *    permission policy are NOT on the command line: the driver sends them on stdin
 *    (`/rooks-bridge`), where the daemon swaps the token in. A mission always loads it, Rooks's
 *    servers or not: it is what gates Pi's tools.
 *
 * @typedef {import('@rooks/sdk/provider').BuildSpawnOpts} BuildSpawnOpts
 * @typedef {import('@rooks/sdk/provider').NativeProviderDefinition} NativeProviderDefinition
 * @typedef {import('@rooks/sdk/provider').ProfileRuntime} ProfileRuntime
 * @typedef {import('@rooks/sdk/provider').ProviderServices} ProviderServices
 * @typedef {import('@rooks/sdk/provider').SessionStdio} SessionStdio
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RpcSessionDriver } from './rpc-driver.js';
import { discoverPiModels } from './models.js';
import { piPermissionPolicy } from './permissions.js';
import { manifestBackend } from './manifest.js';

/** The product's id for Pi: the provider, its dialect and its profile (cf. `profile.js`). */
export const PI_PROVIDER_ID = 'pi';

/** What the core reads about this provider (C1, C2): the manifest's entry, the one place it is
 *  written (`manifest.js`; why its values are what they are: `profile.js`). */
const PI = manifestBackend(PI_PROVIDER_ID);

/**
 * Where Pi keeps its configuration, and its sessions under it, when the user moved it: a path, not a
 * credential. (`PI_CODING_AGENT_SESSION_DIR` is refused by the product's rule: a name holding
 * `SESSION` reads like a credential.)
 */
export const PI_PASSTHROUGH_ENV = Object.freeze(['PI_CODING_AGENT_DIR']);

/** Where the bridge extension is written in the mission's scratch folder. */
export const BRIDGE_FILE = 'rooks-bridge.js';

/** The bridge's source, read once from this package. @type {string | undefined} */
let bridgeSource;
function readBridgeSource() {
  bridgeSource ??= readFileSync(new URL('./rooks-bridge.js', import.meta.url), 'utf8');
  return bridgeSource;
}

/** The levels `--thinking` accepts; anything else leaves the model's own default. */
const PI_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** What Pi accepts as a session id: letters, digits, `.`, `_`, `-`, starting and ending alphanumeric. */
const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

/**
 * What confines a daemon one-shot (`BuildSpawnOpts.oneShot`: compaction, switch summary, memory
 * jobs, Dreaming). Its prompt is a transcript tainted by whatever the mission read, and Pi decides
 * its tool uses alone, so nothing is left for an injection to use (verified on Pi 1.4.0, bench of
 * 29/10/2026: the model is declared no tool, and a call it makes up fails with "Tool bash not found"):
 *  - `--no-tools`: no built-in tool and no extension tool;
 *  - `--no-extensions`, `--no-skills`, `--no-prompt-templates`: none of the user's extensions,
 *    skills or templates, so a transcript starting with `/name` reaches the model as text;
 *  - `--no-context-files`, `--no-approve`: no `AGENTS.md` / `CLAUDE.md`, no project `.pi/` file;
 *  - `--no-session`: nothing added to the user's session history.
 * It still speaks RPC: the prompt goes in a `prompt` command on stdin (never on the command line,
 * which Windows caps at 32 767 characters), and the daemon's session one-shot reads the answer
 * through this provider's driver, Pi's errors included.
 */
export const PI_ONE_SHOT_ARGS = Object.freeze([
  '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve',
]);

/** @param {string | null | undefined} level @returns {string | null} */
export function piThinkingLevel(level) {
  const value = level?.trim().toLowerCase();
  return value && PI_THINKING_LEVELS.has(value) ? value : null;
}

/** The session this launch opens: the one to resume when Pi can name it, a new one otherwise. @param {string | null} resume */
export function piSessionId(resume) {
  return resume && SESSION_ID.test(resume) ? resume : randomUUID();
}

/** @param {string} version @returns {number[] | null} */
function parseVersion(version) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** @param {number[]} a @param {number[]} b */
function olderThan(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/**
 * @param {ProviderServices} services `ctx.provider`
 * @param {{ warn(...args: unknown[]): void }} log `ctx.log`
 * @param {{ requestTimeoutMs?: number, turnIdleTimeoutMs?: number, cancelGraceMs?: number, permissionWaitMs?: number }} [timings] for tests
 * @returns {NativeProviderDefinition}
 */
export function createPiProvider(services, log, timings = {}) {
  const { runtime } = services;
  const binaryName = PI.binary.names[0];
  /** Open sessions by mission, so that killing a mission lets go of its pipes. @type {Map<string, RpcSessionDriver>} */
  const sessions = new Map();
  /** The bridge each launch prepared, taken by the session that opens on it. @type {Map<string, import('./rpc-driver.js').BridgeLaunch>} */
  const bridges = new Map();
  /** The session holding a process's pipes: a live model switch reaches Pi through it. @type {WeakMap<object, RpcSessionDriver>} */
  const byStdin = new WeakMap();
  /**
   * The first `pi --version` that passed: kept for the daemon's lifetime, so a mission does not pay a
   * process for it. A version too old, or unreadable, is read again at the next launch: the user who
   * updates Pi after the refusal must not have to restart Rooks for the update to count.
   * @type {number[] | undefined}
   */
  let acceptedVersion;

  /**
   * Refuses to start a Pi older than the profile's `minCliVersion`, with the command that updates it.
   * An unreadable version is not a verdict: the launch goes ahead and fails on its own terms.
   * @param {ProfileRuntime} profile
   */
  async function assertCliVersion(profile) {
    const min = profile.minCliVersion ? parseVersion(profile.minCliVersion) : null;
    if (!min || acceptedVersion) return;
    /** @type {number[] | null} */
    let version = null;
    try {
      version = parseVersion((await services.binary.version(binaryName)) ?? '');
    } catch {
      version = null;
    }
    if (!version) return;
    if (olderThan(version, min)) {
      throw new Error(`Pi ${version.join('.')} is older than ${profile.minCliVersion}, the oldest version Rooks drives over RPC. `
        + 'Update it (npm install -g @earendil-works/pi-coding-agent@latest, or `pi update`) and send the message again.');
    }
    acceptedVersion = version;
  }

  return {
    id: PI_PROVIDER_ID,
    // One process for the whole conversation; its exit ends the chat.
    transport: { kind: 'stdio-persistent' },
    codec: {
      kind: 'driver',
      extractSessionId: runtime.events.extractInitSessionId,
      /** @param {Parameters<import('@rooks/sdk/provider').ProcessDriverCodec['openSession']>[0]} args */
      openSession: ({ io, spawn, host, profileId }) => {
        /** @type {RpcSessionDriver} */
        const driver = new RpcSessionDriver({
          io,
          host,
          runtime,
          profileId: profileId ?? PI_PROVIDER_ID,
          resumeSession: spawn.resumeSession,
          bridge: bridges.get(spawn.missionId) ?? null,
          ...timings,
          onClose: () => {
            if (sessions.get(spawn.missionId) === driver) sessions.delete(spawn.missionId);
          },
        });
        bridges.delete(spawn.missionId);
        sessions.get(spawn.missionId)?.close();
        sessions.set(spawn.missionId, driver);
        byStdin.set(io.stdin, driver);
        return driver;
      },
    },
    async launch(spawn, profile) {
      await assertCliVersion(profile);
      const oneShot = spawn.oneShot === true;
      if (oneShot && spawn.cfg.allowed_tools?.length) {
        // The Dreaming asks for WebSearch / WebFetch. Pi has no web tool of its own, and the only
        // one that could reach the web is `bash`, which a tainted transcript must never get.
        log.warn(`pi: a one-shot asked for ${spawn.cfg.allowed_tools.join(', ')}; Pi runs one-shots with no tool, it answers from the prompt alone`);
      }
      const args = oneShot
        ? ['--mode', 'rpc', ...PI_ONE_SHOT_ARGS]
        : ['--mode', 'rpc', '--session-id', piSessionId(spawn.resumeSession)];
      if (spawn.cfg.model) args.push('--model', spawn.cfg.model);
      const thinking = piThinkingLevel(spawn.cfg.reasoningEffort);
      if (thinking) args.push('--thinking', thinking);
      if (spawn.systemPrompt.trim()) {
        const scratch = await services.scratch.mission(spawn);
        // A one-shot's prompt REPLACES Pi's own ("an expert coding assistant… reading files,
        // executing commands"), which describes tools it does not have; a mission's is appended to it.
        args.push(oneShot ? '--system-prompt' : '--append-system-prompt', scratch.writeFile('system-prompt.md', spawn.systemPrompt));
      }
      bridges.delete(spawn.missionId);
      if (!oneShot) {
        // The plan holds references, never the token: the driver writes them on the sealed pipe.
        // Read even without Rooks's servers: the product's pre-approved tools and command rules
        // are part of the permission policy.
        const plan = await services.mcp(spawn);
        const scratch = await services.scratch.mission(spawn);
        const file = scratch.writeFile(BRIDGE_FILE, readBridgeSource());
        args.push('-e', file);
        bridges.set(spawn.missionId, {
          file,
          servers: spawn.rooksMcp !== false ? plan.servers : [],
          policy: piPermissionPolicy(spawn.cfg, plan),
        });
      }
      return {
        cmd: profile.cmd,
        args,
        cwd: spawn.cfg.cwd,
        env: { ...profile.env },
        // The driver speaks first (`get_state`); the system prompt is a file, the message a `prompt`.
        initialStdin: null,
      };
    },
    session: {
      // `~/.pi/agent/sessions/<project>/`, found again from any process started in the same folder.
      store: 'global',
      resumable: true,
      async setModel(io, model) {
        const driver = byStdin.get(io.stdin);
        return driver ? driver.setModel(model) : false;
      },
    },
    // Every tool call passes the bridge's gate; what it asks about becomes the Allow/Deny card.
    permission: { model: 'protocol', byAgent: false, appliesMode: true },
    // A provider error reaches the stream as text (`500: …`), never as a reopening time.
    limits: { reporting: 'textual' },
    mcp: { rooks: true },
    models: {
      discover: (profile) => discoverPiModels(services.binary, binaryName, profile).catch((err) => {
        log.warn(`pi: the model list could not be read (${err instanceof Error ? err.message : String(err)})`);
        throw err;
      }),
    },
    lifecycle: {
      dispose(missionId) {
        sessions.get(missionId)?.close();
        sessions.delete(missionId);
        bridges.delete(missionId);
      },
    },
    declares: {
      binary: PI.binary,
      // Pi's sign-ins, keys, settings and sessions (`~/.pi/agent`): spared for its missions, masked
      // from the others'.
      credentialDirs: PI.credentialDirs,
      passthroughEnv: PI_PASSTHROUGH_ENV,
      spans: 'stream-json',
      hostedConnectors: false,
      // The generic `protocol` line speaks of an agent with rules of its own; Pi's are Rooks's.
      permissionsHint: '- **Pi**: Rooks\'s gate inside Pi applies your `permission_mode`: reads always pass, `plan` refuses '
        + 'every edit and command, and what your mode and grants do not cover becomes an Allow/Deny card. A refusal reads '
        + '"Rooks did not allow `<tool>`" or "Rooks never lets an agent run …": do not retry the call as is.',
    },
  };
}
