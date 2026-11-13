/**
 * Routes of the conversational step 3 (`onboarding-main-agent-chat.ts`).
 *
 * Two audiences, never mixed:
 *  - the wizard's browser (a superadmin SESSION): name, start the chat (or
 *    find the one already open, from the TIMs page), answer the picture card;
 *  - the main agent's mission (its own api-token): soul, picture request,
 *    teammates, finish. These refuse unless the mission IS the setup conversation and the
 *    step is still pending.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { auditRequest } from './users/audit-actor.js';
import { dbApi } from './db.js';
import { forbidden, requireSuperadmin, viewerFromRequest, isPersonAuth } from './users/identity.js';
import { scopedDb } from './users/scoped-db.js';
import {
  applyMainAgentName,
  assertAvatarUrl,
  finishMainAgent,
  MainAgentSetupError,
  setMainAgentAvatar,
  setMainAgentSoul,
} from './onboarding-main-agent.js';
import { answerAvatarRequest, requestAvatar, setupChatMission, startSetupChat } from './onboarding-main-agent-chat.js';
import { onboardingStep } from './onboarding-events.js';
import { recruitSetupTeam } from './onboarding-setup-team.js';
import { apiError } from './api-error.js';

// The picture is chosen with the name, on the same form.
const NameBody = z.object({ name: z.string().min(1).max(48), avatarUrl: z.string().max(300).optional() }).strict();
const ChatBody = z.object({ locale: z.string().max(12).optional() }).strict();
const AvatarAnswer = z.union([
  z.object({ id: z.string().min(8).max(64), avatarUrl: z.string().max(300) }).strict(),
  z.object({ id: z.string().min(8).max(64), skipped: z.literal(true) }).strict(),
]);
const SoulBody = z.object({
  soul: z.string().min(1).max(20_000),
  objective: z.string().max(2_000).optional(),
}).strict();

const TeamBody = z.object({ coder: z.string().min(1).max(48), reviewer: z.string().min(1).max(48) }).strict();
const FinishBody = z.object({ tour: z.boolean().optional() }).strict();

const status = (error: unknown): number => (error instanceof MainAgentSetupError ? 409 : 500);
const code = (error: unknown): string => (error instanceof MainAgentSetupError ? error.message : 'setup_failed');

/** The setup conversation's own mission, or an answer already sent. */
function setupMission(req: Request, res: Response): { missionId: string } | null {
  const auth = req.auth;
  if (!auth) { res.status(401).json({ error: 'unauthorized' }); return null; }
  if (auth.kind !== 'api-token' || !auth.missionId) {
    forbidden(req, res, { kind: 'scope', reason: 'only the main agent\'s setup conversation uses this tool' });
    return null;
  }
  const mission = scopedDb(viewerFromRequest(req)).getMission(auth.missionId);
  const verdict = setupChatMission(mission);
  if (!verdict.ok) {
    res.status(verdict.reason === 'step_not_pending' ? 409 : 403).json({ error: verdict.reason });
    return null;
  }
  return { missionId: auth.missionId };
}

/**
 * The wizard's browser. Superadmin session once accounts exist. While the
 * users table is empty (Skip for now), allow the name/config gestures so
 * first-run is not trapped with 401 after configure wrote the config.
 * An agent's mission token is never the person at the screen.
 */
function wizardBrowser(req: Request, res: Response): boolean {
  if (dbApi.countUsers() === 0) return true;
  if (!requireSuperadmin(req, res)) return false;
  if (!isPersonAuth(req.auth)) {
    forbidden(req, res, { kind: 'scope', reason: 'the setup conversation is driven from the wizard\'s browser' });
    return false;
  }
  return true;
}

export function registerSetupChatRoutes(app: Router): void {
  // ── the wizard's browser ──────────────────────────────────────────────────
  app.post('/api/setup/main-agent/name', (req, res) => {
    if (!wizardBrowser(req, res)) return;
    const body = NameBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'invalid_name' }); return; }
    try {
      const { avatarUrl } = body.data;
      if (avatarUrl) assertAvatarUrl(avatarUrl);
      const name = applyMainAgentName(body.data.name);
      if (avatarUrl) setMainAgentAvatar(avatarUrl);
      res.json({ name });
    } catch (error) {
      res.status(status(error)).json({ error: code(error) });
    }
  });

  app.post('/api/setup/main-agent/chat', async (req, res) => {
    if (!wizardBrowser(req, res)) return;
    const body = ChatBody.safeParse(req.body ?? {});
    const userId = req.auth?.user?.id;
    if (!body.success || !userId) { res.status(400).json(apiError('invalid_request', 'invalid_request')); return; }
    try {
      const started = await startSetupChat({ ownerUserId: userId, locale: body.data.locale ?? 'en' });
      if (!started.resumed) auditRequest(req, 'setup.main-agent.chat', started.missionId);
      // 200 = the conversation already open (another tab, a page reloaded): nothing new was started.
      res.status(started.resumed ? 200 : 201).json({ mission_id: started.missionId, agent: started.agent, resumed: started.resumed });
    } catch (error) {
      if (error instanceof MainAgentSetupError) { res.status(409).json({ error: error.message }); return; }
      // The backend is not connected, not installed, or refused: the UI sends the
      // user to the AI Models page. The message of the CLI stays in the log.
      console.warn(`[setup-chat] could not start: ${(error as Error).message}`);
      res.status(503).json({ error: 'chat_unavailable' });
    }
  });

  app.post('/api/setup/main-agent/avatar', (req, res) => {
    if (!wizardBrowser(req, res)) return;
    const body = AvatarAnswer.safeParse(req.body);
    if (!body.success) { res.status(400).json(apiError('invalid_request', 'invalid_request')); return; }
    try {
      if ('avatarUrl' in body.data) {
        assertAvatarUrl(body.data.avatarUrl);
        setMainAgentAvatar(body.data.avatarUrl);
        res.json({ ok: answerAvatarRequest(body.data.id, { avatarUrl: body.data.avatarUrl }) });
      } else {
        res.json({ ok: answerAvatarRequest(body.data.id, { skipped: true }) });
      }
    } catch (error) {
      res.status(status(error)).json({ error: code(error) });
    }
  });

  // ── the main agent's mission ──────────────────────────────────────────────
  app.post('/api/setup/agent/avatar-request', (req, res) => {
    const mission = setupMission(req, res);
    if (!mission) return;
    res.status(202).json({
      id: requestAvatar(mission.missionId).id,
      status: 'pending',
      message: 'A card asks the user for a picture. Their answer comes back to you as a message: end your turn now.',
    });
  });

  app.post('/api/setup/agent/soul', (req, res) => {
    const mission = setupMission(req, res);
    if (!mission) return;
    const body = SoulBody.safeParse(req.body);
    if (!body.success) { res.status(400).json(apiError('invalid_request', 'invalid_request')); return; }
    try {
      setMainAgentSoul(body.data);
      auditRequest(req, 'setup.main-agent.soul', mission.missionId);
      res.json({ ok: true });
    } catch (error) {
      res.status(status(error)).json({ error: code(error) });
    }
  });

  app.post('/api/setup/agent/team', (req, res) => {
    const mission = setupMission(req, res);
    if (!mission) return;
    const body = TeamBody.safeParse(req.body);
    if (!body.success) { res.status(400).json(apiError('invalid_request', 'invalid_request')); return; }
    try {
      const team = recruitSetupTeam(body.data);
      auditRequest(req, 'setup.main-agent.team', mission.missionId);
      res.status(201).json({ ok: true, team });
    } catch (error) {
      res.status(status(error)).json({ error: code(error) });
    }
  });

  app.post('/api/setup/agent/finish', (req, res) => {
    const mission = setupMission(req, res);
    if (!mission) return;
    const body = FinishBody.safeParse(req.body ?? {});
    if (!body.success) { res.status(400).json(apiError('invalid_request', 'invalid_request')); return; }
    try {
      const done = finishMainAgent(body.data);
      auditRequest(req, 'setup.main-agent.finish', mission.missionId);
      onboardingStep('agent_chat', 'completed');
      res.json({ ok: true, status: done.status });
    } catch (error) {
      res.status(status(error)).json({ error: code(error) });
    }
  });
}
