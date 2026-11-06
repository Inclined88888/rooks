'use client';

/**
 * The profile chosen in the onboarding (developer, automation, beginner), as
 * the steps read it: the profile step writes it, the agent step reads it to
 * open the matching creation view, without either importing the other.
 *
 * The daemon holds it (`PUT /api/onboarding/profile`, row `onboarding.profile`
 * of the account) — the same row the guided tour reads through
 * `onboarding_profile_get`, so a profile chosen here is never asked again
 * there. This module only keeps the last answer for the document, so the step
 * after a choice gets it at once instead of a second round trip.
 */
import { useEffect, useSyncExternalStore } from 'react';

/** The daemon's list (`onboarding-profile-routes.ts`), mirrored: the app and the daemon are separate packages. */
export const ONBOARDING_PROFILES = ['developer', 'automation', 'beginner'] as const;
export type OnboardingProfile = typeof ONBOARDING_PROFILES[number];

export const ONBOARDING_PROFILE_PATH = '/api/ui/onboarding/profile';

export function isOnboardingProfile(value: unknown): value is OnboardingProfile {
  return typeof value === 'string' && (ONBOARDING_PROFILES as readonly string[]).includes(value);
}

/**
 * The agent creation view each profile opens on (mockup: a sheet for a
 * developer, an interview for automation, ready-made templates otherwise).
 * No profile yet → the templates, the simplest.
 */
export type AgentCreationView = 'sheet' | 'interview' | 'templates';

export function agentViewFor(profile: OnboardingProfile | null): AgentCreationView {
  if (profile === 'developer') return 'sheet';
  if (profile === 'automation') return 'interview';
  return 'templates';
}

export type OnboardingProfileStatus = 'idle' | 'loading' | 'ready' | 'error';
export type OnboardingProfileSnapshot = { status: OnboardingProfileStatus; profile: OnboardingProfile | null };

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const IDLE: OnboardingProfileSnapshot = Object.freeze({ status: 'idle', profile: null });

let snapshot: OnboardingProfileSnapshot = IDLE;
let inFlight: Promise<OnboardingProfile | null> | null = null;
// Bumped by every write: a read that started before a choice must not overwrite it when it lands.
let generation = 0;
const listeners = new Set<() => void>();

function publish(next: OnboardingProfileSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const read = (): OnboardingProfileSnapshot => snapshot;
const readOnServer = (): OnboardingProfileSnapshot => IDLE;

export class OnboardingProfileError extends Error {
  constructor(readonly status: number) {
    super(`onboarding profile request failed (${status})`);
  }
}

/** Reads the account's profile from the daemon; one request at a time, whoever asks. */
export function loadOnboardingProfile(fetcher: Fetcher = fetch): Promise<OnboardingProfile | null> {
  if (inFlight) return inFlight;
  const started = generation;
  publish({ status: 'loading', profile: snapshot.profile });
  const request: Promise<OnboardingProfile | null> = fetchProfile(fetcher, started)
    .finally(() => { if (inFlight === request) inFlight = null; });
  inFlight = request;
  return request;
}

async function fetchProfile(fetcher: Fetcher, started: number): Promise<OnboardingProfile | null> {
  try {
    const res = await fetcher(ONBOARDING_PROFILE_PATH, { cache: 'no-store' });
    if (!res.ok) throw new OnboardingProfileError(res.status);
    const body = (await res.json()) as { profile?: unknown };
    const profile = isOnboardingProfile(body.profile) ? body.profile : null;
    if (started !== generation) return snapshot.profile;
    publish({ status: 'ready', profile });
    return profile;
  } catch (error) {
    if (started === generation) publish({ status: 'error', profile: snapshot.profile });
    throw error;
  }
}

/** Records `profile` for the signed-in account; rejects (and keeps the previous answer) when the daemon refuses. */
export async function saveOnboardingProfile(profile: OnboardingProfile, fetcher: Fetcher = fetch): Promise<void> {
  const res = await fetcher(ONBOARDING_PROFILE_PATH, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile }),
  });
  if (!res.ok) throw new OnboardingProfileError(res.status);
  generation += 1;
  publish({ status: 'ready', profile });
}

/** Forgets the document's answer; the next reader asks the daemon again. */
export function resetOnboardingProfile(): void {
  generation += 1;
  inFlight = null;
  publish(IDLE);
}

export type UseOnboardingProfile = OnboardingProfileSnapshot & {
  save: (profile: OnboardingProfile) => Promise<void>;
  /** Asks the daemon again — after `status: 'error'`, the reader's "Retry". */
  reload: () => void;
};

const reload = (): void => { loadOnboardingProfile().catch(() => undefined); };

/**
 * The profile for a step: the one just chosen, or the daemon's, fetched on
 * first use. `profile` stays `null` while loading, when none was chosen, and
 * when the daemon could not answer (`status: 'error'`). A step that mounts
 * after a failed read asks again: an unreachable daemon at the profile step
 * must not settle the agent step on the default view for good.
 */
export function useOnboardingProfile(): UseOnboardingProfile {
  const current = useSyncExternalStore(subscribe, read, readOnServer);
  useEffect(() => {
    if (snapshot.status === 'idle' || snapshot.status === 'error') reload();
  }, []);
  return { ...current, save: saveOnboardingProfile, reload };
}
