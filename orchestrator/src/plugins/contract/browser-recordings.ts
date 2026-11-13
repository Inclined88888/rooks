/** Public plugin types, extracted from the host implementations (TODO #512). */
import type { ProjectEventOrigin } from './origin.js';

// Spelled out from the constants of `browser-recording-rules.ts`, which proves at compilation that both agree (TODO #512, volet 3).
export type RecordedStepType =
  | 'click'
  | 'input'
  | 'secret'
  | 'enter'
  | 'navigate'
  | 'newTab'
  | 'switchTab'
  | 'closeTab'
  | 'credential';
export type RecordingStopReason = 'user' | 'idle' | 'limit' | 'profile-stopped';

// Moved from `browser-recording-rules.ts`, which re-exports it (TODO #512, volet 3).
export type SecretKind = 'password' | 'otp' | 'card';

export type SecretHint = 'api-key' | 'jwt' | 'card-number' | 'high-entropy';

export interface RecordedStep {
  /** Stable number of the step inside its recording: review operations name it. */
  n: number;
  /** Seconds since the first step. */
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
  secret?: SecretKind;
  flagged?: SecretHint;
  /** Set at review: this input varies per run; `value` stays as the example unless it was flagged. */
  param?: string;
  url?: string;
  openerTabId?: string;
  origin?: string;
  credentialId?: string;
}


// Moved from `browser-recordings.ts`, which re-exports it (TODO #512, volet 3).
export type BrowserRecordingExternalRef = { provider: string; ref: string; url: string | null };

export type BrowserRecordingMetadata = {
  id: string;
  profileId: string;
  ownerUserId: string | null;
  title: string;
  /** Masked like every recorded URL. */
  startUrl: string;
  steps: number;
  /** Steps the detector flagged and the review has not settled yet. */
  flagged: number;
  truncated: boolean;
  stoppedReason: RecordingStopReason;
  createdAt: number;
  updatedAt: number;
  status: BrowserRecordingStatus;
  learnMissionId: string | null;
  /**
   * The skill the conversion mission created, once it has: the server lets that mission create
   * one `browser-*` skill and nothing else (`users/skills-mcp-guard.ts`), and records it here.
   */
  learnedSkillId: string | null;
  /** False once the raw steps were dropped (after learning, or at the purge). */
  stepsAvailable: boolean;
  externalRef: BrowserRecordingExternalRef | null;
};

export type BrowserRecordingStatus = 'draft' | 'reviewed' | 'learned';

export type PluginBrowserRecording = Readonly<Omit<BrowserRecordingMetadata, 'ownerUserId'>>;

export type PluginBrowserRecordingStep = Readonly<RecordedStep>;

export type PluginBrowserRecordingRef = BrowserRecordingExternalRef;

/** One destructive review edit: a masked value is overwritten, never kept aside. */
export type PluginBrowserRecordingOp =
  | { op: 'mask' | 'unmask' | 'drop'; step: number }
  | { op: 'param'; step: number; name: string }
  | { op: 'rename'; step: number; name: string }
  | { op: 'rename'; title: string };

export type PluginBrowserRecordingDetail = { recording: PluginBrowserRecording; steps: PluginBrowserRecordingStep[] | null };

export type PluginBrowserRecordingEventKind =
  | 'browser_recording_started'
  | 'browser_recording_stopped'
  | 'browser_recording_reviewed'
  | 'browser_recording_learned'
  | 'browser_recording_purged';

export type PluginBrowserRecordingEvent = Readonly<{
  kind: PluginBrowserRecordingEventKind;
  profileId: string;
  /** `null` for `browser_recording_started`: the recording exists once it stops. */
  recordingId: string | null;
  /** After the write; as it was for `browser_recording_purged`. */
  recording: PluginBrowserRecording | null;
  /** `deleted` or `retention`, on `browser_recording_purged`. */
  reason?: string;
  origin: ProjectEventOrigin;
}>;

export type PluginBrowserRecordingEventMap = { [K in PluginBrowserRecordingEventKind]: PluginBrowserRecordingEvent & { kind: K } };

export type PluginBrowserRecordingEventHandler = (ev: PluginBrowserRecordingEvent) => void | Promise<void>;
