import type { Router, RequestHandler, Request } from 'express';
import { ZodError } from 'zod';
import { dbApi } from '../../db.js';
import { listAgents } from '../../agent.js';
import { readRoles } from '../../projects.js';
import { resolveTaskLlm } from '../../dispatcher.js';
import { activeProfiles, installedProfiles, inactiveProfiles, registeredBackendOwners } from '../../backends/registry.js';
import { saveBackendOverlay } from '../../backends/overlays.js';
import { modelPreferences, mergeModelPreferences } from '../../backends/model-preferences.js';
import { discoveredModels } from '../../backends/model-discovery.js';
import { reloadLocalBackends } from '../../backends/local-profiles.js';
import { scopedDb } from '../../users/scoped-db.js';
import { requireSuperadmin, viewerFromRequest } from '../../users/identity.js';
import { refuseBackendChange } from './change-gate.js';

type FileView = {
  id: string; models: { slug: string; label: string; hidden?: boolean; addedAt?: number }[];
  [key: string]: unknown;
};
type FileListing = { backends: FileView[]; protocols: unknown[] };

function references(id: string, req: Request) {
  const agents = listAgents();
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  return {
    agents: agents.filter((agent) => agent.backend === id).map((agent) => ({ id: agent.name, label: agent.name })),
    routines: dbApi.listRoutines().filter((routine) => {
      const agent = byName.get(routine.agent_name);
      const project = routine.project ?? agent?.project;
      const role = project ? readRoles(project)[routine.task_type] : undefined;
      return (role?.backend ?? agent?.backend) === id;
    }).map((routine) => ({ id: routine.id, label: routine.name, enabled: !!routine.enabled })),
    tasks: scopedDb(viewerFromRequest(req)).listTasks('PENDING').filter((task) => resolveTaskLlm(task).backend === id || task.fallback_backend_override === id)
      .map((task) => ({ id: task.id, label: task.title })),
  };
}

export function registerManagedBackendRoutes(router: Router, files: () => FileListing, updateCustom: RequestHandler): void {
  router.use('/api/backends/manage', (req, res, next) => {
    if (!requireSuperadmin(req, res)) return;
    if (refuseBackendChange(req, res)) return;
    next();
  });

  const listing = (req: Request) => {
    reloadLocalBackends();
    const custom = files();
    const owners = registeredBackendOwners().profiles;
    const active = new Map(activeProfiles().map((entry) => [entry.profile.id, entry.profile]));
    const reasons = new Map(inactiveProfiles().map((entry) => [entry.id, entry.reason]));
    const overlays = new Map(dbApi.listBackendOverlays().map((entry) => [entry.id, entry]));
    const bundled = installedProfiles().filter((profile) => owners[profile.id] !== 'local-file').map((profile, index) => {
      const overlay = overlays.get(profile.id);
      const preferences = modelPreferences(profile.id);
      const discovered = discoveredModels(profile.id);
      // What the product knows without the user's hand-typed windows, so the
      // form can show what a correction overrides.
      const detected = new Map(mergeModelPreferences(profile.models, discovered)
        .map((model) => [model.slug, model.contextWindow]));
      const models = mergeModelPreferences(profile.models, discovered, preferences?.models, preferences?.removed)
        .map((model) => {
          const window = detected.get(model.slug);
          return window ? { ...model, detectedContextWindow: window } : model;
        });
      const selected = preferences?.defaultModel === undefined ? profile.defaultModel : preferences.defaultModel;
      return {
        id: profile.id, origin: owners[profile.id] ? 'plugin' : 'builtin',
        label: overlay?.label ?? profile.label,
        icon: overlay?.icon === '' ? null : overlay?.icon ?? profile.icon ?? null,
        brand: overlay?.brand === '' ? null : overlay?.brand ?? profile.brand ?? null,
        disabled: !!(overlay?.disabled ?? profile.disabled), rank: overlay?.rank ?? profile.rank ?? index,
        active: active.has(profile.id), reason: reasons.get(profile.id) ?? null,
        models, defaultModel: selected && models.some((model) => model.slug === selected && !model.hidden)
          ? selected : models.find((model) => !model.hidden)?.slug ?? null,
        warnings: [], protocol: null, baseUrl: null, file: null, hasVaultKey: false,
      };
    });
    const backends = [...bundled, ...custom.backends.map((entry, index) => ({
      ...entry, origin: 'file', rank: typeof entry.rank === 'number' ? entry.rank : bundled.length + index,
    }))].map((entry) => ({ ...entry, usages: references(entry.id, req) }));
    return { backends: backends.sort((a, b) => a.rank - b.rank), protocols: custom.protocols };
  };

  router.get('/api/backends/manage', (req, res) => { res.json(listing(req)); });
  router.patch('/api/backends/manage/:id', (req, res, next) => {
    const id = String(req.params['id'] ?? '');
    reloadLocalBackends();
    const origin = registeredBackendOwners().profiles[id];
    if (origin === 'local-file') { updateCustom(req, res, next); return; }
    if (!installedProfiles().some((profile) => profile.id === id)) {
      res.status(404).json({ error: 'Unknown backend' });
      return;
    }
    try {
      saveBackendOverlay(id, req.body);
      res.json({ backend: listing(req).backends.find((entry) => entry.id === id) });
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({ error: 'Unsupported or invalid backend fields', fields: error.issues.map((issue) => issue.path.join('.') || 'body') });
        return;
      }
      res.status(409).json({ error: error instanceof Error ? error.message : 'Backend update failed' });
    }
  });
}
