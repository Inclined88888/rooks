/**
 * Whether the user is signed in to each provider, as far as the daemon knows, readable
 * synchronously by the code that picks a backend (default backend, automatic fallback).
 *
 * Two sources. The provider's own check (C4 `authStatus`, asynchronous: on macOS the
 * Claude sign-in sits in the keychain) refreshed in the background every ten minutes,
 * and at once when a person asks; and the turns themselves — a turn that produced something proves the sign-in,
 * a turn the CLI refused to authenticate disproves it. A turn outranks the check for a
 * while: the check can miss a sign-in the CLI still finds (a keychain prompt refused).
 *
 * `null` = nobody can tell (the provider declares no check, or it has not answered yet).
 * Callers treat `null` as usable: an unknown is never a reason to refuse a backend.
 *
 * Reason (rc.8 tester, 20/10/2026): codex ran dry, the fallback picked claude, whose
 * CLI shipped with the Claude desktop app but had never been signed in — the turn
 * ended on "Not logged in · Please run /login".
 */
import { providerAuthStatus } from './registry.js';
import { baseBackendId, isAccountInstanceId } from './instance-id.js';

/** A check can be a synchronous `security` call on macOS: rare, and an explicit
 *  "Try again" or a turn updates the verdict in between. */
const CHECK_TTL_MS = 10 * 60_000;
/** A turn that worked outranks a check that says no: the keychain can refuse a
 *  read the CLI itself makes. */
const TURN_SIGNED_IN_MS = 30 * 60_000;
/** A turn the CLI refused only outlasts the bounce: the user signing in right
 *  after must not wait half an hour for the provider to come back. */
const TURN_SIGNED_OUT_MS = 2 * 60_000;

type Verdict = { signedIn: boolean; at: number; from: 'check' | 'turn' };

function lifetime(v: Verdict): number {
  if (v.from === 'check') return CHECK_TTL_MS;
  return v.signedIn ? TURN_SIGNED_IN_MS : TURN_SIGNED_OUT_MS;
}

const verdicts = new Map<string, Verdict>();
const inFlight = new Map<string, Promise<boolean | null>>();
/** Null until the boot wires it: before that (unit tests, a CLI command) no provider is asked. */
let envOf: (() => Readonly<Record<string, string | undefined>>) | null = null;

/** The environment a mission would get, where the provider looks for its credentials. Set once at boot. */
export function setSignInEnv(fn: () => Readonly<Record<string, string | undefined>>): void {
  envOf = fn;
}

function definedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** Accounts carry their own status (`reauth`): only the host's sign-in is tracked here. */
function keyOf(backend: string | null | undefined): string | null {
  if (!backend || isAccountInstanceId(backend)) return null;
  return baseBackendId(backend);
}

/**
 * Asks the provider now; resolves to its verdict, `null` when it cannot tell. `explicit`:
 * a person just asked (setup's "Try again"), so the answer replaces any turn's verdict.
 */
export function refreshProviderSignIn(backend: string, explicit = false): Promise<boolean | null> {
  const key = keyOf(backend);
  const env = envOf;
  if (!key || !env) return Promise.resolve(null);
  const running = inFlight.get(key);
  if (running) return running;
  // The guard is armed BEFORE anything runs: `env()` resolves the main agent,
  // which resolves a default backend, which asks whether each provider is
  // signed in — this very function. Evaluated synchronously here, that walk
  // re-entered an unguarded refresh until the stack overflowed (TIM-0119: the
  // daemon died every half hour on a Mac, froze for minutes on a Windows PC).
  // The first `await` lets `inFlight.set` below land first; a re-entrant
  // caller then gets the running promise and the walk ends.
  const request = (async () => {
    try {
      await undefined;
      const status = await providerAuthStatus(key, definedEnv(env()));
      if (!status) return null;
      const current = verdicts.get(key);
      const turnStillRules = !explicit && current?.from === 'turn' && Date.now() - current.at < lifetime(current);
      if (!turnStillRules) verdicts.set(key, { signedIn: status.ok, at: Date.now(), from: 'check' });
      return status.ok;
    } catch {
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, request);
  return request;
}

/**
 * Last known verdict for `backend`, `null` when unknown. Never waits: a stale or missing
 * verdict starts a refresh in the background and the next caller reads its result.
 */
export function providerSignedIn(backend: string | null | undefined): boolean | null {
  const key = keyOf(backend);
  if (!key) return null;
  const known = verdicts.get(key);
  if (!known || Date.now() - known.at >= lifetime(known)) void refreshProviderSignIn(key);
  return known ? known.signedIn : null;
}

/** True only when the daemon KNOWS the user is signed out of `backend`. */
export function providerSignedOut(backend: string | null | undefined): boolean {
  return providerSignedIn(backend) === false;
}

/** A turn on `backend` produced something: its sign-in works. */
export function noteProviderSignedIn(backend: string | null | undefined): void {
  const key = keyOf(backend);
  if (key) verdicts.set(key, { signedIn: true, at: Date.now(), from: 'turn' });
}

/** The CLI of `backend` refused to authenticate a turn. */
export function noteProviderSignedOut(backend: string | null | undefined): void {
  const key = keyOf(backend);
  if (key) verdicts.set(key, { signedIn: false, at: Date.now(), from: 'turn' });
}

/**
 * Asks every provider once, so the first choice of a default or fallback backend after
 * boot is an informed one. Bounded: a provider slow to answer leaves its verdict unknown.
 */
export async function primeProviderSignIn(backends: readonly string[], timeoutMs = 3_000): Promise<void> {
  const all = Promise.all(backends.map((name) => refreshProviderSignIn(name)));
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); });
  try {
    await Promise.race([all.then(() => undefined), cap]);
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam: fixes a verdict (`null` forgets it) without asking any provider. */
export function setProviderSignInForTest(backend: string, signedIn: boolean | null): void {
  if (signedIn === null) verdicts.delete(backend);
  else verdicts.set(backend, { signedIn, at: Date.now(), from: 'turn' });
}

export function resetProviderSignInForTest(): void {
  verdicts.clear();
  inFlight.clear();
  envOf = null;
}
