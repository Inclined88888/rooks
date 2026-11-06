/**
 * Client contract of the browser recordings (TODO #461), served by the daemon
 * plugin `@timon/browser-recording` (`orchestrator/src/plugins-bundled/browser-recording/routes.ts`).
 *
 * Steps are only ever read through `GET recordings/:id`, after the daemon's
 * own masking pass: never from what a Stop returns (metadata only).
 */

import { t } from '@/lib/i18n';

/** What the engine reports in the browser status, to every viewer of the profile. */
export type BrowserRecordingLive = {
  active: boolean;
  steps: number;
  /** Set once the recording ended on its own (`idle`, `limit`) and waits to be collected. */
  stoppedReason?: string;
};

export type BrowserRecordingMeta = {
  id: string;
  profileId: string;
  title: string;
  startUrl: string;
  steps: number;
  /** Steps the detector flagged that the review has not settled. */
  flagged: number;
  truncated: boolean;
  stoppedReason: string;
  createdAt: number;
  updatedAt: number;
  status: 'draft' | 'reviewed' | 'learned';
  learnMissionId: string | null;
  /** The skill the conversion mission created; absent from a daemon older than #466. */
  learnedSkillId?: string | null;
  stepsAvailable: boolean;
};

/** `agent` absent: the daemon's main agent, refused when its backend keeps a shell. */
export type BrowserRecordingLearnOptions = { autoSubmit: boolean; agent?: string };

export type BrowserRecordingLearnAgent = { name: string; main: boolean };

export type RecordedStepType = 'click' | 'input' | 'secret' | 'enter' | 'navigate' | 'newTab' | 'switchTab' | 'closeTab' | 'credential';

export type RecordedStep = {
  n: number;
  t: number;
  type: RecordedStepType;
  tabId: string;
  selector?: string;
  tag?: string;
  inputType?: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  secret?: 'password' | 'otp' | 'card';
  flagged?: 'api-key' | 'jwt' | 'card-number' | 'high-entropy';
  param?: string;
  url?: string;
  origin?: string;
};

export type BrowserRecordingOp =
  | { op: 'mask' | 'unmask' | 'drop'; step: number }
  | { op: 'param'; step: number; name: string }
  | { op: 'rename'; step: number; name: string }
  | { op: 'rename'; title: string };

export type BrowserRecordingDetail = { recording: BrowserRecordingMeta; steps: RecordedStep[] | null };
export type StoppedBrowserRecording = { recording: BrowserRecordingMeta; alreadySaved?: boolean };
export type LearnedBrowserRecording = { recording: BrowserRecordingMeta; missionId: string };

export function stepCount(count: number): string {
  return t(count === 1 ? 'browserPanel.recording.stepsOne' : 'browserPanel.recording.stepsMany', { count });
}

/** Same rule as the daemon (`BrowserRecordingOp`, op `param`). */
export const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SECRET_PLACEHOLDER = /^\{SECRET:[^{}]*\}$/;

export function isMaskedValue(value: string | undefined): boolean {
  return typeof value === 'string' && SECRET_PLACEHOLDER.test(value);
}

/** The value a Mask would overwrite, or `null` when there is nothing left to mask. */
export function maskableValue(step: RecordedStep): string | null {
  if (step.value !== undefined && step.value !== '') return isMaskedValue(step.value) ? null : step.value;
  if (step.text && !isMaskedValue(step.text)) return step.text;
  return null;
}

/** An error that keeps the HTTP status: a 404 on the list means "not the owner". */
export class BrowserRecordingRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> {
  const response = await fetch(`/api/ui/native-browser/${path}`, {
    method, credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) throw new BrowserRecordingRequestError(typeof value.error === 'string' ? value.error : `Browser recording request failed (${response.status})`, response.status);
  return value as T;
}

const profilePath = (profileId: string) => encodeURIComponent(profileId);
const recordingPath = (id: string) => `recordings/${encodeURIComponent(id)}`;

export const browserRecordingApi = {
  start: (profileId: string) => request<{ recording: BrowserRecordingLive }>(`${profilePath(profileId)}/recording/start`, 'POST', {}),
  stop: (profileId: string) => request<StoppedBrowserRecording>(`${profilePath(profileId)}/recording/stop`, 'POST', {}),
  list: (profileId: string) => request<{ recordings: BrowserRecordingMeta[] }>(`${profilePath(profileId)}/recordings`, 'GET'),
  get: (id: string) => request<BrowserRecordingDetail>(recordingPath(id), 'GET'),
  patch: (id: string, ops: BrowserRecordingOp[]) => request<{ recording: BrowserRecordingMeta; steps: RecordedStep[] }>(recordingPath(id), 'PATCH', { ops }),
  remove: (id: string) => request<{ deleted: boolean }>(recordingPath(id), 'DELETE'),
  learn: (id: string, options: BrowserRecordingLearnOptions) => request<LearnedBrowserRecording>(`${recordingPath(id)}/learn`, 'POST', {
    autoSubmit: options.autoSubmit, ...(options.agent ? { agent: options.agent } : {}),
  }),
  /** The agents the daemon lets this conversion run on: a backend with no shell and no file writes (#469). */
  learnAgents: (id: string) => request<{ agents: BrowserRecordingLearnAgent[] }>(`${recordingPath(id)}/learn-agents`, 'GET'),
};

// ---------------------------------------------------------------------------------------------
// One state per profile, shared by every occupant painted for it (the record button and the
// review drawer are two slot entries, and a profile can be open in several islands).

export type BrowserRecordingState = {
  /** The signed-in user owns the profile; `null` until the list answered. */
  owner: boolean | null;
  recordings: BrowserRecordingMeta[];
  /** The recording the review drawer shows; `null`: the list. */
  selectedId: string | null;
  /** The last Stop found the recording already saved by the daemon (it had ended on its own). */
  alreadySaved: boolean;
  busy: boolean;
  error: string | null;
};

const EMPTY: BrowserRecordingState = { owner: null, recordings: [], selectedId: null, alreadySaved: false, busy: false, error: null };
const states = new Map<string, BrowserRecordingState>();
const loads = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

export function subscribeBrowserRecordings(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function browserRecordingState(profileId: string | null): BrowserRecordingState {
  return (profileId && states.get(profileId)) || EMPTY;
}

export function updateBrowserRecordingState(profileId: string, change: Partial<BrowserRecordingState> | ((state: BrowserRecordingState) => Partial<BrowserRecordingState>)): void {
  const current = browserRecordingState(profileId);
  states.set(profileId, { ...current, ...(typeof change === 'function' ? change(current) : change) });
  for (const listener of listeners) listener();
}

/** Re-reads the list; one request at a time per profile. */
export function loadBrowserRecordings(profileId: string): Promise<void> {
  const running = loads.get(profileId);
  if (running) return running;
  const load = browserRecordingApi.list(profileId)
    .then(({ recordings }) => updateBrowserRecordingState(profileId, { owner: true, recordings }))
    .catch((error: unknown) => {
      // The list answers its owner only: anyone else sees the profile, not its recordings.
      if (error instanceof BrowserRecordingRequestError && (error.status === 403 || error.status === 404)) updateBrowserRecordingState(profileId, { owner: false, recordings: [] });
      else updateBrowserRecordingState(profileId, { error: (error as Error).message });
    })
    .finally(() => { loads.delete(profileId); });
  loads.set(profileId, load);
  return load;
}

/** A recording changed by a review or a learn: the list shows it at once. */
export function replaceBrowserRecording(profileId: string, recording: BrowserRecordingMeta): void {
  updateBrowserRecordingState(profileId, (state) => ({
    recordings: state.recordings.some((row) => row.id === recording.id)
      ? state.recordings.map((row) => (row.id === recording.id ? recording : row))
      : [recording, ...state.recordings],
  }));
}

export function resetBrowserRecordingsForTests(): void {
  states.clear();
  loads.clear();
  for (const listener of listeners) listener();
}
