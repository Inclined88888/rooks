/** Launched locally by Electron; no HTTP endpoint exposes this operation. */
import { loadConfig } from '../config/load.js';
import { removeDesktopService } from './desktop-uninstall-service.js';
import { createGenericHost } from './generic.js';
import { serviceOptsFromEnvironment } from './service-environment.js';

try {
  const cfg = loadConfig(undefined, { readonly: true });
  const host = createGenericHost(cfg);
  removeDesktopService(serviceOptsFromEnvironment(cfg, () => host));
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
