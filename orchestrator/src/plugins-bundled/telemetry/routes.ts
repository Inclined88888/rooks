/**
 * Routes of `@rooks/telemetry`. Each declares who may call it:
 *
 *  - `GET /api/telemetry/preference` — any signed-in caller; never anonymous,
 *    even during first run;
 *  - `PUT /api/telemetry/preference` — a PERSON (session or paired device)
 *    holding `settings:write`. Never anonymous, never a mission or API token:
 *    an agent does not decide what its user shares;
 *  - `POST /api/telemetry/desktop-opened` — the daemon token alone, i.e. the
 *    desktop shell of this machine. Its body is a version, nothing else;
 *  - `POST /api/telemetry/ui-event` — a PERSON (session or paired device): the
 *    web app reports what that person opened. Never anonymous, never a token:
 *    an agent does not report page views on anyone's behalf. The body is one
 *    event of a closed list; the page path is reduced to its section here.
 */
import type { Router } from 'express';
import { z } from 'zod';
import { forbidden, isPersonAuth, rejectIfDenied, rejectIfNotDaemonToken, requireAuth } from '../../users/identity.js';
import { preferenceEditable, writePreference, type TelemetryPreference } from './preference.js';
import { telemetry } from './runtime.js';
import { versionValue } from './events.js';
import { apiError } from '../../api-error.js';

const PreferenceBody = z.object({ enabled: z.boolean() }).strict();
const DesktopOpenedBody = z.object({ version: z.string().max(64).optional() }).strict();
const UiSurface = z.enum(['web', 'desktop']);
const UiEventBody = z.discriminatedUnion('name', [
  z.object({ name: z.literal('app_opened'), surface: UiSurface, setupCompleted: z.boolean(), loadMs: z.number().min(0).max(600_000).optional() }).strict(),
  z.object({ name: z.literal('ui_error'), surface: UiSurface, path: z.string().max(512) }).strict(),
  z.object({ name: z.literal('page_viewed'), surface: UiSurface, path: z.string().max(512) }).strict(),
  z.object({
    name: z.literal('upgrade_action'), surface: UiSurface,
    action: z.enum(['plans_viewed', 'buy_opened']),
    entryPoint: z.enum(['license_page', 'users', 'settings', 'banner', 'other']),
  }).strict(),
]);

function view(pref: TelemetryPreference): Record<string, unknown> {
  return {
    enabled: pref.enabled,
    source: pref.source,
    malformed: pref.malformed,
    editable: preferenceEditable(pref),
    // False on a source checkout or under tests: nothing would be sent anyway.
    active: telemetry().active,
  };
}

export function registerRoutes(app: Router, preference: () => TelemetryPreference): void {
  app.get('/api/telemetry/preference', (req, res) => {
    if (!requireAuth(req, res)) return;
    res.json(view(preference()));
  });

  app.put('/api/telemetry/preference', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    if (!isPersonAuth(auth)) {
      forbidden(req, res, { kind: 'scope', reason: 'only a person changes what this installation shares', hint: 'Change it in Settings › System › Privacy.' });
      return;
    }
    if (rejectIfDenied(req, res, 'settings:write')) return;
    const body = PreferenceBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'enabled must be a boolean' }); return; }
    const before = preference();
    if (!preferenceEditable(before)) {
      res.status(409).json({ error: 'forced', source: before.source });
      return;
    }
    writePreference(body.data.enabled);
    const after = telemetry().active ? telemetry().refreshPreference() : preference();
    res.json(view(after));
  });

  app.post('/api/telemetry/ui-event', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    if (!isPersonAuth(auth)) {
      forbidden(req, res, { kind: 'scope', reason: 'only the app a person uses reports what they open' });
      return;
    }
    const body = UiEventBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'invalid event' }); return; }
    telemetry().trackUi(body.data, { userId: auth.user?.id ?? null });
    res.json({ ok: true });
  });

  app.post('/api/telemetry/desktop-opened', (req, res) => {
    if (rejectIfNotDaemonToken(req, res)) return;
    const body = DesktopOpenedBody.safeParse(req.body ?? {});
    if (!body.success) { res.status(400).json(apiError('invalid_request', 'invalid body')); return; }
    const version = versionValue(body.data.version);
    telemetry().track('desktop_app_opened', version ? { desktop_version: version } : {}, 'desktop');
    res.json({ ok: true });
  });
}
