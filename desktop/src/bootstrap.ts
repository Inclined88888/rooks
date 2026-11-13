/** Keep first-run ports stable without creating the config that closes onboarding. */
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DesktopConfig } from './config.js';

export async function availablePort(preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (preferred && error.code === 'EADDRINUSE') availablePort(0).then(resolve, reject);
      else reject(error);
    });
    server.listen(preferred, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Cannot select a local port')); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}
export async function assignBootstrapPorts(cfg: DesktopConfig): Promise<void> {
  cfg.daemon.listen.port = await availablePort(cfg.daemon.listen.port);
  let appPort = await availablePort(cfg.app.listen.port);
  for (let attempt = 0; appPort === cfg.daemon.listen.port && attempt < 10; attempt++) {
    appPort = await availablePort(0);
  }
  if (appPort === cfg.daemon.listen.port) throw new Error('Cannot select distinct local ports');
  cfg.app.listen.port = appPort;
  writeFileSync(join(cfg.home, 'desktop-bootstrap.json'), JSON.stringify({
    daemonPort: cfg.daemon.listen.port, appPort: cfg.app.listen.port,
  }), { mode: 0o600 });
}
