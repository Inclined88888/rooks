import { createServer } from 'node:net';
import type { Host } from './types.js';

export type ListenPortState = { available: boolean; detail: string };

/** Probe the exact bind address, without trusting an HTTP response or killing its owner. */
export async function inspectListenPort(host: Pick<Host, 'platform' | 'execAsync'>, address: string, port: number): Promise<ListenPortState> {
  const code = await new Promise<string | undefined>((resolve) => {
    const server = createServer(socket => socket.destroy());
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'UNKNOWN'));
    server.listen({ host: address, port, exclusive: true }, () => server.close(() => resolve(undefined)));
  });
  if (!code) return { available: true, detail: 'port available' };
  if (code !== 'EADDRINUSE') return { available: false, detail: `cannot bind (${code})` };

  // Only PID fields: command lines may contain credentials. Missing OS tools
  // or permissions must not turn an occupied socket into an available one.
  let pids: string[] = [];
  try {
    if (host.platform === 'win32') {
      const result = await host.execAsync('netstat', ['-ano', '-p', 'tcp'], { timeout: 2000 });
      pids = result.stdout.split(/\r?\n/).flatMap(line => {
        const fields = line.trim().split(/\s+/);
        return fields[0] === 'TCP' && fields[1]?.endsWith(`:${port}`) && fields[3] === 'LISTENING' && /^\d+$/.test(fields[4] ?? '') ? [fields[4]!] : [];
      });
    } else {
      const result = await host.execAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeout: 2000 });
      pids = result.stdout.trim().split(/\s+/).filter(pid => /^\d+$/.test(pid));
    }
  } catch { /* Ownership is best effort; bind failure is authoritative. */ }
  const unique = [...new Set(pids)];
  const names = await Promise.all(unique.map(pid => processName(host, pid)));
  const listeners = unique.map((pid, i) => names[i] ? `${pid} [${names[i]}]` : pid);
  return { available: false, detail: `port occupied; ${listeners.length ? `listener PID(s) ${listeners.join(', ')}` : 'owner unknown'} (application identity unverified)` };
}

/** Executable name only, never the command line (it may carry credentials). Best effort. */
async function processName(host: Pick<Host, 'platform' | 'execAsync'>, pid: string): Promise<string | undefined> {
  try {
    if (host.platform === 'win32') {
      const { stdout } = await host.execAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 2000 });
      return /^"([^"]+)"/.exec(stdout.trim())?.[1];
    }
    const { stdout } = await host.execAsync('ps', ['-p', pid, '-o', 'comm='], { timeout: 2000 });
    return stdout.trim() || undefined;
  } catch { return undefined; }
}
