import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { completeWorkflowTurn, failWorkflowMission, reconcile } from '../../workflows/engine.js';
import { migrateLegacyWorkflowTriggers, tickWorkflowTriggers } from '../../workflows/triggers.js';
import { bus, type BusEvent } from '../../bus.js';
import { registerRoutes } from './routes.js';
import { whenProvidersLoaded } from '../../backends/registry.js';
import { seedWorkflowArchitect } from '../../agent-seed.js';
import { flushWorkflowReports, purgeLegacyWorkflowCoordinators } from '../../workflows/coordinator.js';
import { startPluginWorkflowTriggers } from '../../workflows/plugin-triggers.js';
import { abortPluginExecutors } from '../../workflows/plugin-executors.js';
import { workflowActionProvider } from '../../workflows/native-triggers.js';

export const manifest: ModuleManifest = { name: '@timon/workflows', tier: 'std', inject: ['http', 'db'] };
export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  ctx.effect(() => {
    let active = true;
    // The purge lists agents, whose default backend only exists once the providers are
    // mounted; run synchronously at boot it threw and took the whole daemon down.
    void whenProvidersLoaded().then(() => {
      if (!active) return;
      seedWorkflowArchitect();
      const purged = purgeLegacyWorkflowCoordinators();
      if (purged) console.log(`[workflows] removed ${purged} legacy per-workflow agent(s); assign an existing agent to each workflow`);
    }).catch((error: Error) => console.error(`[workflows] initialization failed: ${error.message}`));
    return () => { active = false; };
  });
  registerRoutes(ctx.http.router());
  // Plugged into the native triggers when they run, never required: a Free
  // licence minted before `@timon/triggers` withholds it, and a hard
  // dependency (`inject` or `dependsOn`) would switch every workflow off with
  // it. This sub-fiber waits for the service and follows it in and out.
  ctx.inject(['triggers'], (sub) => {
    sub.effect(() => sub.triggers.registerAction('workflow', workflowActionProvider));
  });
  ctx.effect(() => {
    migrateLegacyWorkflowTriggers();
    const stopPluginTriggers = startPluginWorkflowTriggers();
    // Every bus event, `mission_complete` included, goes out on the `event`
    // channel: there is no channel per kind.
    const onEvent = (event: BusEvent) => {
      if (event.kind === 'event' && event.type === 'result') completeWorkflowTurn(event.missionId, event.payload);
      if (event.kind === 'event' && event.type === 'turn_interrupted') failWorkflowMission(event.missionId, 'turn interrupted');
      if (event.kind === 'event' && event.type === 'rate_limit') failWorkflowMission(event.missionId, 'rate limited');
      // A mission that ends with its node still running will never close it: a
      // `completed` one already delivered its `result`, so only these two are
      // left for the 30 s reconcile, which would blame a restart.
      if (event.kind === 'mission_complete' && (event.status === 'failed' || event.status === 'terminated')) {
        failWorkflowMission(event.missionId, `mission ${event.status}`);
      }
    };
    bus.on('event', onEvent);
    void reconcile(); void tickWorkflowTriggers(Date.now(), true);
    void flushWorkflowReports();
    const reportTimer = setInterval(() => { void flushWorkflowReports(); }, 2000);
    const timer = setInterval(() => { void reconcile(); tickWorkflowTriggers(Date.now(), true); }, 30_000);
    return async () => {
      bus.off('event', onEvent); clearInterval(timer); clearInterval(reportTimer);
      abortPluginExecutors();
      await stopPluginTriggers();
    };
  });
}
