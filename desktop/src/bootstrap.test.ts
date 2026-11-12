import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assignBootstrapPorts } from './bootstrap.js';
import { loadDesktopConfig, daemonEnvOverrides } from './config.js';

test('fresh homes avoid occupied ports, retain them on relaunch, and keep onboarding open', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-bootstrap-'));
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const cfg = loadDesktopConfig(home, { packaged: true });
    cfg.daemon.listen.port = address.port;
    await assignBootstrapPorts(cfg);
    assert.notEqual(cfg.daemon.listen.port, address.port);
    assert.notEqual(cfg.daemon.listen.port, cfg.app.listen.port);
    const reloaded = loadDesktopConfig(home, { packaged: true });
    assert.equal(reloaded.daemon.listen.port, cfg.daemon.listen.port);
    assert.equal(reloaded.app.listen.port, cfg.app.listen.port);
    assert.equal(daemonEnvOverrides(reloaded).PORT, String(cfg.daemon.listen.port));
    assert.equal(existsSync(join(home, 'rooks.config.json')), false);
  } finally { server.close(); rmSync(home, { recursive: true, force: true }); }
});
