/**
 * The single entry the runner opens a mission's session through, whatever the
 * provider speaks: it looks at the definition's transport and codec, never at
 * a name. Three shapes today, one driver each:
 *   - lines over a process's pipes → `LineSessionDriver`;
 *   - a session protocol over a process's pipes → the provider's own driver;
 *   - a connection with no process → the provider's own driver.
 */

import type {
  RemoteSessionOpenArgs, SessionDriver, SessionOpenArgs,
} from '../types.js';
import { isRemoteDefinition, type ProviderDefinition } from './definition.js';
import { LineSessionDriver } from './lines-driver.js';

/** What the daemon hands the engine for a process it spawned. */
export type ProcessSessionArgs = Omit<SessionOpenArgs, 'profileId' | 'launch'> & {
  /** What the launch wrote ahead of any prompt (`SpawnResult.initialStdin`). Only
   *  a lines codec reads it; a protocol driver writes its own handshake. */
  readonly initialStdin?: string | null;
  /** Raw activity on stdout, parsed or not (lines codec). */
  onActivity?(): void;
  /** A stdout line past the ceiling was dropped (lines codec). */
  onOverflow?(): void;
  /** The lines codec threw on a line; it was dropped (lines codec). */
  onCodecError?(error: unknown, line: string): void;
};

export function openProcessSession(def: ProviderDefinition, args: ProcessSessionArgs): SessionDriver {
  if (isRemoteDefinition(def)) {
    throw new Error(`provider ${def.id} is remote: it has no process to open a session over`);
  }
  const { codec } = def;
  if (codec.kind === 'lines') {
    return new LineSessionDriver({
      io: args.io,
      host: args.host,
      codec,
      transport: def.transport.kind === 'process-per-turn' ? 'process-per-turn' : 'stdio-persistent',
      initialStdin: args.initialStdin ?? null,
      ...(args.onActivity ? { onActivity: args.onActivity } : {}),
      ...(args.onOverflow ? { onOverflow: args.onOverflow } : {}),
      ...(args.onCodecError ? { onCodecError: args.onCodecError } : {}),
    });
  }
  // The exact arguments a dialect's `openSession` has always received.
  const { io, spawn, host, mcpEnv } = args;
  return codec.openSession({ io, spawn, host, ...(mcpEnv ? { mcpEnv } : {}) });
}

export function openRemoteSession(
  def: ProviderDefinition,
  args: Omit<RemoteSessionOpenArgs, 'profileId' | 'env' | 'launch'>,
): SessionDriver {
  if (!isRemoteDefinition(def)) {
    throw new Error(`provider ${def.id} runs a local process: it has no remote session to open`);
  }
  return def.codec.openSession(args);
}
