/**
 * Stdio relay between a CLI and `chrome-devtools-mcp`, used on Windows only.
 *
 * Driving a remote browser (`--browserUrl`), `chrome-devtools-mcp` hands
 * `upload_file` paths to Chromium untouched: they must be valid INSIDE the
 * Linux container. On Windows the agent only knows host paths (`D:\…`), so the
 * relay rewrites them to their mounted location (`/host/d/…`) before they reach
 * the server. A path outside the mounted project gets a clear tool error here,
 * instead of the 0-byte attachment Chromium would silently produce (TIM-0120).
 *
 * Everything else crosses byte for byte. The MCP stdio transport is one
 * JSON-RPC message per line; batches are not part of the MCP versions the CLIs
 * speak, so an array is forwarded as is.
 */
import { toContainerPath, type ProjectMount } from './browser-container-paths.js';

/** What the daemon hands the relay, as JSON in `UPLOAD_RELAY_SPEC_ENV`. */
export type UploadRelaySpec = {
  command: string;
  args: string[];
  mount: ProjectMount;
  /** Platform whose path syntax the agent uses: the daemon's own. */
  platform: NodeJS.Platform;
};

export const UPLOAD_RELAY_SPEC_ENV = 'TIMON_BROWSER_RELAY_SPEC';

export function parseUploadRelaySpec(raw: string | undefined): UploadRelaySpec {
  const spec = JSON.parse(raw ?? '') as Partial<UploadRelaySpec>;
  if (typeof spec.command !== 'string' || !Array.isArray(spec.args)
    || !spec.args.every((a) => typeof a === 'string')
    || typeof spec.mount?.source !== 'string' || typeof spec.mount.target !== 'string'
    || typeof spec.platform !== 'string') {
    throw new Error(`invalid ${UPLOAD_RELAY_SPEC_ENV}`);
  }
  return spec as UploadRelaySpec;
}

/** Forward a (possibly rewritten) line to the server, or answer the client directly. */
export type RelayDecision = { forward: string } | { reply: string };

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: unknown;
  params?: { name?: unknown; arguments?: Record<string, unknown> };
};

/** Decide what to do with one line the client sent. Pure. */
export function relayClientLine(line: string, spec: Pick<UploadRelaySpec, 'mount' | 'platform'>): RelayDecision {
  let message: unknown;
  try { message = JSON.parse(line); } catch { return { forward: line }; }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return { forward: line };
  const request = message as JsonRpcRequest;
  const args = request.params?.arguments;
  if (request.method !== 'tools/call' || request.params?.name !== 'upload_file' || !args) return { forward: line };
  const paths = args.filePaths;
  if (!Array.isArray(paths) || !paths.every((p): p is string => typeof p === 'string')) return { forward: line };

  const outside: string[] = [];
  const translated = paths.map((p) => {
    const inside = toContainerPath(p, spec.mount, spec.platform);
    if (inside === null) outside.push(p);
    return inside ?? p;
  });
  if (outside.length) {
    return {
      reply: JSON.stringify({
        jsonrpc: '2.0',
        id: request.id ?? null,
        result: {
          isError: true,
          content: [{
            type: 'text',
            text: `The built-in browser can only upload files from the project folder ${spec.mount.source}. `
              + `Outside it: ${outside.join(', ')}. Copy the file into the project folder, then retry.`,
          }],
        },
      }),
    };
  }
  return { forward: JSON.stringify({ ...request, params: { ...request.params, arguments: { ...args, filePaths: translated } } }) };
}
