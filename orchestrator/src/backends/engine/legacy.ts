/**
 * The adapter from what the runner already holds — a `Backend`, which is a
 * `Dialect` bound to its profile — to a `ProviderDefinition`. Every dialect
 * written before the engine (the product's own, a plugin's of API ≤ 10, a
 * local profile's) goes through it unchanged: none of them is asked for a new
 * member, and an absent one keeps the value it had.
 *
 * Mapping, cf. `docs/PROVIDERS-SDK.md` § 7.2:
 *   - `openRemoteSession`              → `remote` transport, `driver` codec;
 *   - `openSession`                    → `stdio-persistent`, `driver` codec;
 *   - `parseLine` + `writeUserInput`   → `lines` codec, on `stdio-persistent`
 *     or `process-per-turn` according to `persistentProcess`.
 *
 * A line-oriented `writeUserInput` is written against the `ChildProcess`, which
 * a provider never holds. The adapter is therefore built per LAUNCH and keeps
 * the process the daemon just spawned; the codec it exposes only takes pipes.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Backend, ProfileRuntime, UsageProbeOptions } from '../types.js';
import type { LinesCodec, ProviderDefinition } from './definition.js';

export type LegacyLaunch = {
  /** The process the daemon spawned for this launch. Required by a
   *  line-oriented backend, absent for a remote one. */
  readonly proc?: ChildProcessWithoutNullStreams;
  /** Whether Timon's MCP servers can be handed to the backend
   *  (`backendCapabilities(name).timonMcp`). Default: yes, as before. */
  readonly timonMcp?: boolean;
};

export function fromLegacy(backend: Backend, launch: LegacyLaunch = {}): ProviderDefinition {
  const common = {
    id: backend.name,
    session: {
      store: backend.sessionStore,
      resumable: backend.sessionResumable,
      ...(backend.isSessionNotFoundError ? { notFound: backend.isSessionNotFoundError.bind(backend) } : {}),
      ...(backend.maxPromptBytes !== undefined ? { maxPromptBytes: backend.maxPromptBytes } : {}),
      ...(backend.nativeCompact ? { compact: backend.nativeCompact } : {}),
    },
    permission: { model: backend.permissionModel },
    limits: { reporting: backend.rateLimitReporting },
    mcp: { timon: launch.timonMcp ?? true },
    // A backend is already bound to its profile: only the options travel.
    ...(backend.accountUsage
      ? { usage: { probe: (_profile?: ProfileRuntime, options?: UsageProbeOptions) => backend.accountUsage!(options) } }
      : {}),
    ...(backend.dispose || backend.enrichEvent
      ? {
        lifecycle: {
          ...(backend.dispose ? { dispose: backend.dispose.bind(backend) } : {}),
          ...(backend.enrichEvent ? { enrich: backend.enrichEvent.bind(backend) } : {}),
        },
      }
      : {}),
    ...(backend.spans ? { spans: backend.spans.bind(backend) } : {}),
  };

  if (backend.openRemoteSession) {
    const openRemote = backend.openRemoteSession.bind(backend);
    return { ...common, transport: { kind: 'remote' }, codec: { kind: 'driver', openSession: openRemote } };
  }

  if (backend.openSession) {
    if (!backend.persistentProcess) {
      throw new Error(`backend ${backend.name}: a session driver needs a persistent process`);
    }
    const open = backend.openSession.bind(backend);
    return { ...common, transport: { kind: 'stdio-persistent' }, codec: { kind: 'driver', openSession: open } };
  }

  const { proc } = launch;
  if (!proc) throw new Error(`backend ${backend.name} is line-oriented: it needs the process it was launched on`);
  const codec: LinesCodec = {
    kind: 'lines',
    parseLine: (line) => backend.parseLine(line),
    extractSessionId: (ev) => backend.extractSessionId(ev),
    writeUserInput: (_io, text, images) => backend.writeUserInput(proc, text, images),
  };
  return backend.persistentProcess
    ? { ...common, transport: { kind: 'stdio-persistent' }, codec }
    : { ...common, transport: { kind: 'process-per-turn' }, codec };
}
