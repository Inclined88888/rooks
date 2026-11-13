/**
 * `stop` or `start` of the installed service, launched locally by Electron
 * ("Quit and stop the background service", and the launch that follows it).
 * No HTTP endpoint exposes this operation. Like the other desktop runners it
 * loads neither the database nor the onboarding (`packaged-upgrade-runner.test.ts`).
 */
import { loadConfig } from '../config/load.js';
import { createGenericHost } from './generic.js';
import { endMissionsOfStoppedDaemon } from './mission-processes.js';
import { serviceOptsFromEnvironment } from './service-environment.js';
import { startService, stopService } from './service-install.js';
import { actOnOwnService } from './service-ownership.js';

const action = process.argv[2];
if (action !== 'stop' && action !== 'start') {
  console.error('usage: desktop-service-runner.js stop|start');
  process.exitCode = 64;
} else {
  const cfg = loadConfig(undefined, { readonly: true });
  const host = createGenericHost(cfg);
  const opts = serviceOptsFromEnvironment(cfg, () => host);
  const result = actOnOwnService(opts, action === 'stop' ? stopService : startService);
  if (result.ok && action === 'stop') {
    const ended = await endMissionsOfStoppedDaemon(opts.rooksHome, host);
    if (ended) result.lines.push(ended);
  }
  if (!result.ok) {
    console.error(result.reason ?? result.lines.join('\n') ?? `service ${action} failed`);
    process.exitCode = 1;
  } else {
    console.log(result.lines.join('\n'));
  }
}
