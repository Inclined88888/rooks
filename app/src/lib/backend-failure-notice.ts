/**
 * The sentence rendered in the thread when a backend ended a turn without
 * answering (persisted `backend_failed` event, orchestrator/src/agent.ts).
 *
 * Pure, like `spawn-failure-notice.ts`: a Copilot refusal reached the user as
 * "thinking", then nothing (TIM-0049); this line is all the thread will say.
 */
import { t } from './i18n';

/** Payload of the `backend_failed` event. */
export type BackendFailedPayload = {
  backend?: unknown;
  exitCode?: unknown;
  missionId?: unknown;
  sessionId?: unknown;
  stderr?: unknown;
};

const DETAIL_CHARS = 400;

/** Ids to look the provider's own logs up with; the session id only exists once the backend announced one. */
function idsLine(payload: BackendFailedPayload): string {
  const missionId = typeof payload.missionId === 'string' ? payload.missionId.trim() : '';
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
  if (missionId && sessionId) return t('chatPage.backendFailedSession', { missionId, sessionId });
  return missionId ? t('chatPage.backendFailedMission', { missionId }) : '';
}

export function backendFailureNotice(payload: BackendFailedPayload): string {
  const backend = typeof payload.backend === 'string' && payload.backend.trim() ? payload.backend : '?';
  const code = typeof payload.exitCode === 'number' ? String(payload.exitCode) : '?';
  const head = t('chatPage.backendFailed', { backend, code });
  // One line, bounded: the notice is a sentence, not a log viewer.
  const ids = idsLine(payload);
  const raw = typeof payload.stderr === 'string' ? payload.stderr.replace(/\s+/g, ' ').trim() : '';
  const detail = raw.length > DETAIL_CHARS ? `…${raw.slice(-DETAIL_CHARS)}` : raw;
  const body = raw ? `${head} ${t('chatPage.backendFailedDetail', { detail })}` : head;
  return ids ? `${body}\n${ids}` : body;
}
