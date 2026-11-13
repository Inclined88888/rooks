/**
 * S4 — `ctx.provider.binary`: the programs a provider declared, resolved and run
 * the way the daemon would, and nothing else (`docs/PROVIDERS-SDK.md` § 6.1, § 11.3).
 *
 * A provider has to ask its CLI a question before it can offer it — is it
 * installed, which version, which models — and some start a server the mission
 * talks to. `ctx.host.exec` is the wrong tool: it resolves the name on its own,
 * inherits the daemon's whole environment, and refuses `claude` and `codex` to
 * every plugin. Here:
 *
 *   - only a name in the manifest's `provider.binaries` (canonical or alias) is
 *     accepted — what the operator authorized at install;
 *   - the name resolves through the host adapter (the operator's `host.binaries`
 *     pins, the PATH, the vendor's folders, what the provider declared) and the
 *     RESOLVED program goes through the operator's allowlist, like any plugin's
 *     binary. A plugin shipped inside the release (`trusted`) is not asked for an
 *     allowlist entry, and may name `claude`/`codex` — the exemption of
 *     `PROVIDERS-SDK.md` § 12 question 4, for the program its manifest declares;
 *     a launcher (`sh`, `node`, `env`…) is refused to everyone;
 *   - the process gets the system whitelist plus what the provider passes — never
 *     the daemon's environment, the vault or the mission's token;
 *   - a probe has a deadline and a ceiling on its output; a server is stopped with
 *     its process tree, and with the plugin.
 */

import type { ChildProcess } from 'node:child_process';
import { getHost } from '../host/index.js';
import { killProcessTree } from '../host/kill-tree.js';
import { assertProviderExecAllowed } from '../plugins/policy.js';
import { assertDeclaredIdentity } from './binary-identity.js';
import { systemEnv } from '../secrets/env.js';
import { redactText } from '../secrets/redact.js';
import { ROOKS_HOME } from '../paths.js';
import type {
  ProviderBinary, ProviderConversation, ProviderConverseOptions, ProviderProbeOptions, ProviderProbeResult, ProviderServeOptions,
  ProviderServer,
} from './provider-services.js';

const DEFAULT_PROBE_MS = 10_000;
const MAX_PROBE_MS = 60_000;
const DEFAULT_READY_MS = 15_000;
const MAX_READY_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const OUTPUT_TAIL_CHARS = 16 * 1024;
const MAX_SERVERS_PER_PLUGIN = 4;
const DEFAULT_CONVERSATION_MS = 20_000;
const MAX_CONVERSATION_MS = 60_000;
const STOP_GRACE_MS = 3_000;
const MAX_READY_PATTERN = 200;

export class ProviderBinaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderBinaryError';
  }
}

export type ProviderBinaryScope = {
  readonly pluginId: string;
  readonly trusted: boolean;
  /** Names the manifest's `provider.binaries` lists, aliases included. */
  readonly authorizedBinaries: readonly string[];
};

/** What a child gets: the system whitelist, then the provider's own — never a credential of the daemon's. */
function childEnv(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...systemEnv() };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (key.toUpperCase() === 'ROOKS_API_TOKEN') continue;
    env[key] = value;
  }
  return env;
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.min(value as number, max) : fallback;
}

export function createProviderBinary(scope: ProviderBinaryScope): { api: ProviderBinary; stopAll(): Promise<void> } {
  const servers = new Set<ProviderServer>();
  const conversations = new Set<ProviderConversation>();

  const declared = (name: string): void => {
    if (!scope.authorizedBinaries.includes(name)) {
      throw new ProviderBinaryError(`\`${name}\` is not one of the programs this plugin's manifest declares (\`provider.binaries\`): ${scope.authorizedBinaries.join(', ') || 'none'}`);
    }
  };

  /** The declared name's resolved program, after the allowlist — or a reason. */
  const program = (name: string): string => {
    declared(name);
    let resolved: string;
    try { resolved = getHost().bin(name); } catch { throw new ProviderBinaryError(`\`${name}\` is not installed on this machine`); }
    assertProviderExecAllowed(scope.pluginId, resolved, { trusted: scope.trusted });
    return resolved;
  };

  /** The declared identity of `name`, checked like a mission's launch: a namesake never answers for the program. */
  const identified = async (name: string, resolved: string): Promise<void> => {
    try {
      await assertDeclaredIdentity(name, resolved, `plugin \`${scope.pluginId}\``);
    } catch (error) {
      throw new ProviderBinaryError((error as Error).message);
    }
  };

  const run = async (name: string, args: readonly string[], options: ProviderProbeOptions = {}): Promise<ProviderProbeResult> => {
    const resolved = program(name);
    await identified(name, resolved);
    const timeout = clamp(options.timeoutMs, DEFAULT_PROBE_MS, MAX_PROBE_MS);
    const started = Date.now();
    const result = await getHost().execAsync(resolved, [...args], {
      timeout, maxBuffer: MAX_OUTPUT_BYTES, env: childEnv(options.env), ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    return {
      code: result.code,
      stdout: redactText(result.stdout.slice(0, MAX_OUTPUT_BYTES)),
      stderr: redactText(result.stderr.slice(0, MAX_OUTPUT_BYTES)),
      timedOut: Date.now() - started >= timeout && result.code !== 0,
    };
  };

  const converse = async (name: string, args: readonly string[], options: ProviderConverseOptions = {}): Promise<ProviderConversation> => {
    if (servers.size + conversations.size >= MAX_SERVERS_PER_PLUGIN) {
      throw new ProviderBinaryError(`this plugin already runs ${MAX_SERVERS_PER_PLUGIN} servers and conversations: stop one first`);
    }
    const resolved = program(name);
    await identified(name, resolved);
    // NODE_DEBUG would write traces onto the stdout that carries the protocol.
    const { NODE_DEBUG: _debug, ...env } = childEnv(options.env);
    const child: ChildProcess = getHost().spawn(resolved, [...args], {
      env, cwd: ROOKS_HOME, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let tail = '';
    let exited = false;
    const exitedPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); });
      child.once('error', () => { exited = true; resolve({ code: null, signal: null }); });
    });
    // A closed pipe is the exit handler's to report.
    child.stdin?.on('error', () => { /* reported by `exited` */ });
    // Drained, so a chatty CLI cannot fill the pipe and stall.
    child.stderr?.on('data', (chunk: Buffer | string) => { tail = (tail + chunk.toString()).slice(-OUTPUT_TAIL_CHARS); });
    const listeners = new Set<(chunk: Uint8Array) => void>();
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      for (const listener of [...listeners]) listener(bytes);
    });
    const deadline = setTimeout(() => { void conversation.stop(); }, clamp(options.timeoutMs, DEFAULT_CONVERSATION_MS, MAX_CONVERSATION_MS));
    deadline.unref();
    const conversation: ProviderConversation = {
      pid: child.pid ?? null,
      cwd: ROOKS_HOME,
      write(data) { try { child.stdin?.write(data); } catch { /* reported by `exited` */ } },
      onData(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      stderr: () => redactText(tail),
      exited: exitedPromise,
      async stop() {
        clearTimeout(deadline);
        conversations.delete(conversation);
        if (exited) return;
        try { child.stdin?.end(); } catch { /* already closed */ }
        // A `.cmd` shim on Windows: `kill()` alone would leave the CLI running.
        killProcessTree(child);
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, STOP_GRACE_MS);
        timer.unref();
        await exitedPromise;
        clearTimeout(timer);
      },
    };
    void exitedPromise.then(() => { clearTimeout(deadline); conversations.delete(conversation); });
    conversations.add(conversation);
    return conversation;
  };

  const api: ProviderBinary = {
    converse,
    async resolve(name) {
      declared(name);
      try { return getHost().bin(name); } catch { return null; }
    },
    async version(name) {
      let result: ProviderProbeResult;
      try { result = await run(name, ['--version']); } catch (error) {
        if (error instanceof ProviderBinaryError && /not installed/.test(error.message)) return null;
        throw error;
      }
      return /(\d+)\.(\d+)\.(\d+)/.exec(`${result.stdout}\n${result.stderr}`)?.[0] ?? null;
    },
    probe: run,
    async serve(name, args, options: ProviderServeOptions = {}) {
      if (servers.size + conversations.size >= MAX_SERVERS_PER_PLUGIN) {
        throw new ProviderBinaryError(`this plugin already runs ${MAX_SERVERS_PER_PLUGIN} servers: stop one first`);
      }
      const resolved = program(name);
    await identified(name, resolved);
      let ready: RegExp | null = null;
      if (options.ready !== undefined) {
        if (options.ready.length > MAX_READY_PATTERN) throw new ProviderBinaryError(`\`ready\` is over ${MAX_READY_PATTERN} characters`);
        try { ready = new RegExp(options.ready); } catch { throw new ProviderBinaryError('`ready` is not a regular expression'); }
      }
      const child: ChildProcess = getHost().spawn(resolved, [...args], {
        env: childEnv(options.env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...(options.cwd ? { cwd: options.cwd } : {}),
      });
      let tail = '';
      let match: string | null = null;
      let exited = false;
      const exitedPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); });
        child.once('error', () => { exited = true; resolve({ code: null, signal: null }); });
      });
      let onReady: (() => void) | null = null;
      const feed = (chunk: Buffer | string): void => {
        tail = (tail + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
        if (ready && match === null) {
          const found = ready.exec(tail);
          if (found) { match = found[1] ?? found[0]; onReady?.(); }
        }
      };
      child.stdout?.on('data', feed);
      child.stderr?.on('data', feed);

      const server: ProviderServer = {
        pid: child.pid ?? null,
        get match() { return match; },
        output: () => redactText(tail),
        exited: exitedPromise,
        async stop() {
          servers.delete(server);
          if (exited) return;
          killProcessTree(child);
          const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, STOP_GRACE_MS);
          timer.unref();
          await exitedPromise;
          clearTimeout(timer);
        },
      };
      servers.add(server);

      if (ready) {
        const wait = clamp(options.readyTimeoutMs, DEFAULT_READY_MS, MAX_READY_MS);
        const outcome = await new Promise<'ready' | 'exited' | 'timeout'>((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), wait);
          onReady = () => { clearTimeout(timer); resolve('ready'); };
          void exitedPromise.then(() => { clearTimeout(timer); resolve(match === null ? 'exited' : 'ready'); });
          if (match !== null) onReady();
        });
        if (outcome !== 'ready') {
          const output = redactText(tail).slice(-500);
          await server.stop();
          throw new ProviderBinaryError(outcome === 'exited'
            ? `\`${name}\` exited before it was ready: ${output}`
            : `\`${name}\` was not ready after ${wait} ms: ${output}`);
        }
      }
      return server;
    },
  };

  return {
    api,
    async stopAll() {
      await Promise.all([...servers, ...conversations].map((entry) => entry.stop()));
    },
  };
}
