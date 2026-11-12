/**
 * The daemon's way to start an ACP agent: through the host adapter, which
 * resolves the binary, confines the process and knows each OS's launch quirks.
 * `transport.ts` takes the spawn function from its caller so that it has no
 * dependency on the daemon; this is where the daemon supplies its own.
 */
import { getHost } from '../../host/index.js';
import { AcpTransport, type AcpSpawnOptions } from './transport.js';

export function spawnAcpTransport(opts: Omit<AcpSpawnOptions, 'spawn'> & Partial<Pick<AcpSpawnOptions, 'spawn'>>): AcpTransport {
  return AcpTransport.spawn({ ...opts, spawn: opts.spawn ?? ((name, args, o) => getHost().spawn(name, args, o)) });
}
