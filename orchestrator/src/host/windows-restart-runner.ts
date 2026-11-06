/** Launched locally by Electron; no HTTP endpoint exposes this operation. */
import { loadConfig } from '../config/load.js';
import { createGenericHost } from './generic.js';
import { serviceOptsFromEnvironment } from './service-environment.js';
import { restartWindowsService } from './service-install.js';
import { actOnOwnService } from './service-ownership.js';

const cfg = loadConfig(undefined, { readonly: true });
const host = createGenericHost(cfg);
const result = actOnOwnService(serviceOptsFromEnvironment(cfg, () => host), restartWindowsService);
if (!result.ok) {
  console.error(result.reason ?? 'service restart failed');
  process.exitCode = 1;
} else {
  console.log(result.lines.join('\n'));
}
