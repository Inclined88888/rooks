/**
 * The profile a person chose in the onboarding (developer, automation,
 * beginner): one row per account, so every agent of that account can fit its
 * explanations and proposals to them later (`onboarding_profile_get`).
 *
 * The agent records it once the person answered: a mission writes for the
 * account that launched it, never for another (`callerOf`). A signed-in browser
 * reads and writes its own.
 */
import type { Router } from 'express';
import { z } from 'zod';
import { dbApi } from '../../db.js';
import { auditRequest } from '../../users/audit-actor.js';
import { callerOf } from './widget-routes.js';

export const ONBOARDING_PROFILE_SCOPE = 'onboarding.profile';
export const ONBOARDING_PROFILES = ['developer', 'automation', 'beginner'] as const;
export type OnboardingProfile = (typeof ONBOARDING_PROFILES)[number];

const Body = z.object({ profile: z.enum(ONBOARDING_PROFILES) }).strict();
const BODY_MAX_BYTES = 256;

type Stored = { profile: OnboardingProfile; at: number };

export function readOnboardingProfile(owner: string): Stored | null {
  const raw = dbApi.uiLayoutGetOwn(owner, ONBOARDING_PROFILE_SCOPE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Stored>;
    const profile = Body.safeParse({ profile: parsed.profile });
    return profile.success ? { profile: profile.data.profile, at: typeof parsed.at === 'number' ? parsed.at : 0 } : null;
  } catch {
    return null;
  }
}

export function registerOnboardingProfileRoutes(app: Router): void {
  app.get('/api/onboarding/profile', (req, res) => {
    const caller = callerOf(req, res, 'read');
    if (!caller) return;
    const stored = readOnboardingProfile(caller.owner.id);
    res.json({ profile: stored?.profile ?? null, at: stored?.at ?? null });
  });

  app.put('/api/onboarding/profile', (req, res) => {
    const caller = callerOf(req, res, 'write');
    if (!caller) return;
    if (Buffer.byteLength(JSON.stringify(req.body ?? null)) > BODY_MAX_BYTES) {
      res.status(413).json({ error: 'too_large' });
      return;
    }
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_profile', message: `profile must be one of: ${ONBOARDING_PROFILES.join(', ')}` });
      return;
    }
    const stored: Stored = { profile: parsed.data.profile, at: Date.now() };
    dbApi.uiLayoutSet(caller.owner.id, ONBOARDING_PROFILE_SCOPE, JSON.stringify(stored));
    auditRequest(req, 'onboarding.profile', parsed.data.profile);
    res.json(stored);
  });
}
