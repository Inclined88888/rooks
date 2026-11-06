/**
 * Hands a provider PLUGIN's session driver a reference to the mission's token
 * instead of the token (`docs/PROVIDERS-SDK.md` § 12.6, § 12.8).
 *
 * A session-driven dialect declares Timon's MCP servers to its agent itself, so
 * it has to put an identity into their environment. The driver gets
 * `mcpEnv.TIMON_API_TOKEN = <reference>`; the pipe it writes to is wrapped, and
 * the DAEMON swaps the reference for the real value on its way to the process.
 * The value therefore never crosses the plugin's code — not in its arguments,
 * not in what it logs or stores — while a driver that copies `mcpEnv` into its
 * `session/new` keeps working as it always did.
 *
 * The reference is random per launch and worthless on its own: used anywhere
 * but through this pipe it authenticates nothing.
 */

import { StringDecoder } from 'node:string_decoder';
import { Writable } from 'node:stream';
import { LaunchSeal } from './launch-seal.js';
import type { SessionStdio } from './types.js';

/** Every field is `#private`: the wrapper is handed to the plugin, and an
 *  ordinary property would be one `JSON.stringify` away from the token. */
class SealedStdin extends Writable {
  readonly #decoder = new StringDecoder('utf8');
  #pending = '';
  readonly #target: Writable;
  readonly #seal: LaunchSeal;

  constructor(target: Writable, seal: LaunchSeal) {
    super();
    this.#target = target;
    this.#seal = seal;
    // The write callbacks and the close carry the failure, as on the real pipe.
    target.on('error', (err) => this.destroy(err));
    this.on('error', () => { /* surfaced by the write callback */ });
  }

  /** The pipe carries JSON-RPC: a value is swapped as the inside of a JSON string,
   *  so it cannot break the line whatever it holds. */
  #swap(text: string): string {
    return this.#seal.swap(text, 'json');
  }

  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    const text = this.#pending + (typeof chunk === 'string' ? chunk : this.#decoder.write(chunk));
    const keep = this.#seal.heldTail(text);
    this.#pending = text.slice(text.length - keep);
    const out = this.#swap(text.slice(0, text.length - keep));
    if (!out) return cb();
    this.#target.write(out, (err) => cb(err ?? null));
  }

  override _final(cb: (err?: Error | null) => void): void {
    const rest = this.#swap(this.#pending + this.#decoder.end());
    this.#pending = '';
    if (rest) this.#target.write(rest);
    this.#target.end();
    cb();
  }
}

/** What a plugin driver is handed in place of the mission's token and pipes. */
export type SealedMissionToken = {
  readonly io: SessionStdio;
  readonly mcpEnv: Readonly<Record<string, string>>;
};

/**
 * `mcpEnv` carries more than the token only if the runner adds variables: the
 * rest passes as is, the token is the one that is sealed. `seal` is the launch's
 * own (`launch-seal.ts`), so the reference the driver writes is the one a
 * `ctx.provider.mcp()` call handed out for the same launch; without it the
 * reference is minted here and good for this pipe only.
 */
export function sealMissionToken(
  io: SessionStdio,
  mcpEnv: Readonly<Record<string, string>>,
  seal?: LaunchSeal,
): SealedMissionToken {
  const token = mcpEnv.TIMON_API_TOKEN;
  if (!token) return { io, mcpEnv };
  const own = seal ?? new LaunchSeal('', '', null);
  const ref = own.protect(token);
  return {
    io: { stdin: new SealedStdin(io.stdin, own), stdout: io.stdout },
    mcpEnv: { ...mcpEnv, TIMON_API_TOKEN: ref },
  };
}
