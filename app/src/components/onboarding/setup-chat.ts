'use client';

/**
 * The main agent's welcome conversation, as a hook: where it resumes, how it
 * starts, how it ends (docs/ONBOARDING-AGENT-CHAT.md). It runs on the TIMs
 * page (`plugins-client/bots/bots-welcome.tsx`), right after the onboarding.
 * Same daemon routes, same resume key and same trouble rules as
 * `/setup/agent`, which stays the repair screen.
 *
 * The conversation needs a named agent: an install that reaches the page
 * without one (the gate, an onboarding left half-way) goes back to the agent
 * step. Ending it does not leave the page: the conversation stays where it is,
 * and the capabilities read afresh release the app — the gate stops holding the
 * reader on the page, and the guided tour starts when it was picked.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCapabilities } from '@/lib/capabilities';
import { armAutoTour } from '@/lib/guided-tour';
import { getLocale } from '@/lib/i18n';
import { machineScopedStorage } from '@/lib/machines/machine-storage';
import { readResume, RESUME_KEY, setupEntry, type MainAgentStatus } from '@/app/setup/agent/setup-entry';
import { requestSkip } from '@/app/setup/agent/setup-escape';
import {
  SILENT_AFTER_MS, setupTrouble, type SetupChatSignal, type SetupMissionState, type SetupTrouble,
} from '@/app/setup/agent/setup-trouble';
import { MAIN_AGENT_STATUS_PATH, type Fetcher } from './agent-create';

export const SETUP_CHAT_PATH = '/api/ui/setup/main-agent/chat';
/** How often the step reads the daemon while the conversation runs. */
export const POLL_MS = 2500;
/** Time the agent's last words stay on screen before the app is released (the tour, the gate). */
export const LEAVE_DELAY_MS = 2500;

export type ChatStepEntry =
  | { kind: 'done' }
  | { kind: 'chat'; agent: string; missionId: string }
  | { kind: 'startChat'; agent: string }
  | { kind: 'unnamed' };

/** Pure: `/setup/agent`'s decision, where its two forms (AIs, name) mean the agent step is not behind us. */
export function chatStepEntry(status: MainAgentStatus, resume: { agent: string; missionId: string } | null): ChatStepEntry {
  const entry = setupEntry(status, resume, true);
  return entry.kind === 'name' || entry.kind === 'providers' ? { kind: 'unnamed' } : entry;
}

export type ChatStepStage =
  | { kind: 'loading' }
  | { kind: 'starting' }
  | { kind: 'chat'; agent: string; missionId: string }
  | { kind: 'unavailable'; agent: string }
  | { kind: 'unnamed' };

/** The welcome is over: capabilities read afresh tell the gate and the tour offer, without leaving the page. */
function releaseApp(): void {
  void fetchCapabilities(true).catch(() => null);
}

export type SetupChat = {
  stage: ChatStepStage;
  /** The daemon's last word on the step: the team recruited, the tour chosen. */
  status: MainAgentStatus | null;
  /** The agent's first words are on screen. */
  spoke: boolean;
  /** `null` while the conversation runs; set once the agent ended the welcome. */
  leaving: { tour: boolean } | null;
  trouble: SetupTrouble;
  busy: boolean;
  skipError: boolean;
  /** The reader skipped the welcome: the daemon answered the step and stopped the conversation. */
  skipped: boolean;
  onAgentSpoke: () => void;
  onSetupTrouble: (signal: SetupChatSignal) => void;
  start: (agentHint: string | null) => Promise<void>;
  skip: () => Promise<void>;
};

export function useSetupChat(opts: { fetcher?: Fetcher; leave?: () => void } = {}): SetupChat {
  const fetcher = opts.fetcher ?? fetch;
  const leaveRef = useRef(opts.leave ?? releaseApp);
  const [stage, setStage] = useState<ChatStepStage>({ kind: 'loading' });
  const [status, setStatus] = useState<MainAgentStatus | null>(null);
  const [spoke, setSpoke] = useState(false);
  const [leaving, setLeaving] = useState<{ tour: boolean } | null>(null);
  const [chatSignal, setChatSignal] = useState<SetupChatSignal | null>(null);
  const [mission, setMission] = useState<SetupMissionState | null>(null);
  const [pollFailures, setPollFailures] = useState(0);
  const [waitedLong, setWaitedLong] = useState(false);
  const [busy, setBusy] = useState(false);
  const [skipError, setSkipError] = useState(false);
  const [skipped, setSkipped] = useState(false);
  // Set once the welcome is over: a start still in flight must not repaint it.
  const leavingRef = useRef(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const onAgentSpoke = useCallback(() => setSpoke(true), []);
  const onSetupTrouble = useCallback((signal: SetupChatSignal) => {
    // A dead mission outranks a refused tool: only it offers to start over.
    setChatSignal((prev) => (prev === 'ended' || prev === 'spawn_failed' ? prev : signal));
  }, []);

  const start = useCallback(async (agentHint: string | null): Promise<void> => {
    setStage({ kind: 'starting' });
    // A restart is a new conversation: nothing of the previous one's trouble carries over.
    setSpoke(false);
    setChatSignal(null);
    setMission(null);
    setPollFailures(0);
    setWaitedLong(false);
    try {
      const res = await fetcherRef.current(SETUP_CHAT_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: getLocale() }),
      });
      const body = await res.json().catch(() => ({})) as { mission_id?: unknown; agent?: unknown };
      if (leavingRef.current) return;
      if (!res.ok || typeof body.mission_id !== 'string' || typeof body.agent !== 'string') {
        setStage({ kind: 'unavailable', agent: agentHint ?? '' });
        return;
      }
      try { machineScopedStorage(sessionStorage).setItem(RESUME_KEY, JSON.stringify({ agent: body.agent, missionId: body.mission_id })); } catch { /* private mode */ }
      setStage({ kind: 'chat', agent: body.agent, missionId: body.mission_id });
    } catch {
      if (!leavingRef.current) setStage({ kind: 'unavailable', agent: agentHint ?? '' });
    }
  }, []);

  const finish = useCallback((next: MainAgentStatus) => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    const tour = next.tour !== false;
    if (tour) armAutoTour();
    setLeaving({ tour });
    setTimeout(() => leaveRef.current(), LEAVE_DELAY_MS);
  }, []);

  // Where are we: a conversation already open (a reload), a named agent whose chat never started, or no agent yet.
  const entered = useRef(false);
  useEffect(() => {
    if (entered.current) return;
    entered.current = true;
    void (async () => {
      try {
        const res = await fetcherRef.current(MAIN_AGENT_STATUS_PATH, { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const current = await res.json() as MainAgentStatus;
        setStatus(current);
        const entry = chatStepEntry(current, readResume());
        if (entry.kind === 'done') { leavingRef.current = true; leaveRef.current(); return; }
        if (entry.kind === 'startChat') { void start(entry.agent); return; }
        setStage(entry);
      } catch {
        // The daemon did not answer: the start says it the way a refused start does.
        setStage({ kind: 'unavailable', agent: '' });
      }
    })();
  }, [start]);

  // The conversation's mission: one that ended (a reload included) will never call `setup_finish`.
  const missionId = stage.kind === 'chat' ? stage.missionId : null;
  useEffect(() => {
    if (!missionId) return;
    const readMission = (): void => {
      void fetcherRef.current(`/api/ui/missions/${encodeURIComponent(missionId)}?view=status`, { cache: 'no-store' })
        .then(async (r) => {
          if (r.status === 404) { setMission({ status: 'missing' }); setPollFailures(0); return; }
          if (!r.ok) throw new Error(String(r.status));
          const m = await r.json() as { status?: unknown; liveness?: unknown };
          setMission({
            status: typeof m.status === 'string' ? m.status : null,
            liveness: typeof m.liveness === 'string' ? m.liveness : null,
          });
          setPollFailures(0);
        })
        .catch(() => setPollFailures((n) => n + 1));
    };
    readMission();
    const missionTimer = setInterval(readMission, POLL_MS);
    const silentTimer = setTimeout(() => setWaitedLong(true), SILENT_AFTER_MS);
    return () => { clearInterval(missionTimer); clearTimeout(silentTimer); };
  }, [missionId]);

  // The agent ends the step by itself; meanwhile the daemon's status brings the team it recruits.
  const chatOpen = stage.kind === 'chat';
  useEffect(() => {
    if (!chatOpen) return;
    const timer = setInterval(() => {
      void fetcherRef.current(MAIN_AGENT_STATUS_PATH, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() as Promise<MainAgentStatus> : null))
        .then((next) => {
          if (!next) return;
          setStatus(next);
          if (next.status === 'complete') { clearInterval(timer); finish(next); }
        })
        .catch(() => { /* next tick */ });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [chatOpen, finish]);

  const skip = useCallback(async (): Promise<void> => {
    if (leavingRef.current) return;
    setBusy(true);
    setSkipError(false);
    if (await requestSkip()) {
      leavingRef.current = true;
      setSkipped(true);
      leaveRef.current();
      return;
    }
    setSkipError(true);
    setBusy(false);
  }, []);

  const trouble = stage.kind === 'chat'
    ? setupTrouble({ signal: chatSignal, mission, pollFailures, spoke, elapsedMs: waitedLong ? SILENT_AFTER_MS : 0 })
    : { level: 'quiet' as const };

  return { stage, status, spoke, leaving, trouble, busy, skipError, skipped, onAgentSpoke, onSetupTrouble, start, skip };
}
