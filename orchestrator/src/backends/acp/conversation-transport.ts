/**
 * An ACP client over a CONVERSATION the daemon opened for a provider
 * (`ctx.provider.binary.converse`): the plugin holds no process and no Node
 * stream, only `write` / `onData` / `exited` / `stop`. The transport wants
 * streams, so a pair of pass-throughs carries the bytes across.
 *
 * What the daemon owns stays the daemon's: it resolved the program (the
 * manifest's `provider.binaries`, the operator's allowlist), set its
 * environment and its deadline, and stops its process tree. This module only
 * speaks the protocol on top, so a probe a provider writes cannot start a
 * program the operator did not authorize.
 *
 * Leaf: it reaches nothing of the daemon, as `transport.ts` does not.
 */

import { PassThrough } from 'node:stream';
import { AcpTransport } from './transport.js';

/** What of a `ProviderConversation` this module uses. */
export type AcpConversation = {
  /** The folder the process runs in: the daemon's own home. */
  readonly cwd: string;
  write(data: string | Uint8Array): void;
  onData(listener: (chunk: Uint8Array) => void): () => void;
  readonly exited: Promise<unknown>;
  stderr(): string;
  stop(): Promise<void>;
};

export type AcpConversationTransport = {
  readonly transport: AcpTransport;
  /** The folder the agent runs in; a session opened for a probe says the same. */
  readonly cwd: string;
  /** The agent's last stderr output, secrets masked (what the daemon kept). */
  stderr(): string;
  /** Lets go of the protocol, then ends the daemon's process. Safe to call twice. */
  stop(): Promise<void>;
};

export function acpTransportOver(
  conversation: AcpConversation, options: { requestTimeoutMs?: number } = {},
): AcpConversationTransport {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.on('data', (chunk: Buffer) => conversation.write(chunk));
  const unlisten = conversation.onData((chunk) => { stdout.write(chunk); });
  // The process is gone: its stdout ends, which is how the transport learns it.
  void conversation.exited.then(() => { unlisten(); stdout.end(); });
  const transport = new AcpTransport({
    io: { stdin, stdout },
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  });
  let stopped: Promise<void> | null = null;
  return {
    transport,
    cwd: conversation.cwd,
    stderr: () => conversation.stderr(),
    stop() {
      stopped ??= (async () => {
        await transport.stop();
        unlisten();
        await conversation.stop();
      })();
      return stopped;
    },
  };
}
