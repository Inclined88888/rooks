'use client';

import { Suspense, useDeferredValue, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { chatUrlWithAgent, designateMainAgent, explainMissingMainAgent, resolveChatAgent, type MissingMainAgent } from '@/lib/chat-entry';
import { chatMissionWait, chatSwitchMission, preloadChatMission } from '@/lib/chat-mission-preload';
import { hasCachedChatMission } from '@/lib/chat-mission-cache';
import { isFreshChatUrl } from '@/lib/new-mission-agents';
import { t } from '@/lib/i18n';
import { workspaceWait } from '@/components/workspace-layout-provider';
import { usePageChat } from './use-page-chat';
import { ChatClient } from './chat-client';
import { ChatChrome } from './chat-chrome';

/** Resolve implicit identities before mounting any conversation effects.
 * The URL then gives the chat, workspace and browser the same identity.
 * Re-keying on agent/mission also discards the previous conversation state. */
export function ChatRoute() {
  // Deferred, because Next 14.2 does not apply a `pushState` as a transition:
  // the patched history dispatches `ACTION_RESTORE` in one, but its action
  // queue calls `setState` from an async reducer's `.then`, at default
  // priority. A switch suspending on that update showed this `<Suspense>`'s
  // fallback instead of the previous conversation (built app, task 3d22e2fb).
  // The deferred render is a transition: there, a suspension keeps the screen.
  const params = useDeferredValue(useSearchParams());
  const router = useRouter();
  const query = params.toString();
  const agent = params.get('agent');
  const mission = params.get('mission') ?? '';
  const [failedQuery, setFailedQuery] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${agent}:${mission}`;
  /** The conversation on screen; `null` before the first one is shown. */
  const shownKey = useRef<string | null>(null);
  useEffect(() => { if (agent) shownKey.current = key; }, [agent, key]);
  useEffect(() => {
    if (agent) return;
    let cancelled = false;
    setFailedQuery(null);
    void resolveChatAgent(new URLSearchParams(query)).then((resolved) => {
      if (cancelled) return;
      if (resolved) router.replace(chatUrlWithAgent(new URLSearchParams(query), resolved));
      else setFailedQuery(query);
    });
    return () => { cancelled = true; };
  }, [agent, query, router, attempt]);
  if (!agent) return (
    <div role="status" className="p-4 text-sm text-muted-foreground">
      {failedQuery === query ? <>
        {t('chatEntry.unavailable')}{' '}
        <button type="button" className="underline" onClick={() => setAttempt((value) => value + 1)}>{t('chatEntry.retry')}</button>{' '}
        {/* Retry replays the same lookup: without a way out, an install whose
            main agent cannot be resolved is stuck on this line (TIM-0079). */}
        <Link href="/agents" className="underline">{t('chatEntry.manageAgents')}</Link>
        <MissingMainAgentReason key={attempt} onDesignated={() => setAttempt((value) => value + 1)} />
      </> : t('common.loading')}
    </div>
  );
  // A switch from a conversation already on screen to a named mission: its
  // log is read now, and the switch waits for it (`chat-mission-preload.ts`).
  // A recent one is painted from the cache (`chat-mission-cache.ts`): no
  // read to wait for, the new conversation mounts at once.
  const switching = shownKey.current !== null && shownKey.current !== key;
  const named = chatSwitchMission(shownKey.current, key, mission);
  const switchingTo = named && !hasCachedChatMission(named) ? named : null;
  if (switchingTo) preloadChatMission(switchingTo);
  return (
    // Outside the key: the top bar and the islands stay the same elements
    // across a switch, only the conversation below is new (`chat-chrome.tsx`).
    <ChatChrome>
    {/* Never shown on a switch: URL changes are transitions, and a transition
        keeps the previous conversation rather than revealing a fallback. */}
    <Suspense fallback={<div role="status" className="p-4 text-sm text-muted-foreground">{t('common.loading')}</div>}>
      {switchingTo && <AwaitMission mission={switchingTo} />}
      {/* Another agent may live in another project: its workspace (the top
          bar's cards, the islands) is resolved and read before the switch
          commits, instead of the whole screen emptying and painting again. */}
      {switching && <AwaitWorkspace params={params} />}
      {/* The New mission picker's link (TODO #344): a blank conversation, not
          the agent's latest mission. */}
      <PageChat params={params} />
    </Suspense>
    </ChatChrome>
  );
}

/**
 * The page's conversation, rendered inside the route's island: the only place
 * the view's tree can be read from, `ChatRoute` being the workspace's host
 * (`usePageChat`, TIM-0140).
 */
function PageChat({ params }: { params: URLSearchParams }) {
  const { chatParams, keepInView } = usePageChat(params);
  return (
    <ChatClient
      key={`${params.get('agent') ?? ''}:${chatParams.get('mission') ?? ''}`}
      routeParams={chatParams}
      initialFresh={isFreshChatUrl(chatParams)}
      keepInView={keepInView}
    />
  );
}

/**
 * What the failed lookup ran into, read once more: an unreadable list, a list
 * that seats nobody (with who could be seated), or no orchestrator at all.
 * The screen is what a tester reports; it has to carry the cause (TIM-0079).
 */
function MissingMainAgentReason({ onDesignated }: { onDesignated: () => void }) {
  const [reason, setReason] = useState<MissingMainAgent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void explainMissingMainAgent().then((value) => { if (!cancelled) setReason(value); });
    return () => { cancelled = true; };
  }, []);
  if (!reason) return null;
  const designate = async (name: string) => {
    setBusy(true);
    setError(null);
    const failure = await designateMainAgent(name);
    setBusy(false);
    if (failure) setError(t('chatEntry.makeMainFailed', { name, error: failure }));
    else onDesignated();
  };
  return (
    <div className="mt-3 space-y-2">
      {reason.kind === 'unreadable' && <p>{reason.status === null
        ? t('chatEntry.unreadableNoStatus')
        : t('chatEntry.unreadable', { status: `HTTP ${reason.status}` })}</p>}
      {reason.kind === 'none' && <p>{t('chatEntry.none')}</p>}
      {reason.kind === 'undesignated' && <>
        <p>{t('chatEntry.undesignated')}</p>
        <ul className="space-y-1">
          {reason.candidates.map((name) => (
            <li key={name}>
              <button type="button" className="underline" disabled={busy} onClick={() => void designate(name)}>
                {t('chatEntry.makeMain', { name })}
              </button>
            </li>
          ))}
        </ul>
      </>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  );
}

/** Suspends until the next chat's workspace is resolved and read, or its budget is spent. */
function AwaitWorkspace({ params }: { params: URLSearchParams }): null {
  const wait = workspaceWait('/chat', params);
  if (wait) throw wait;
  return null;
}

/** Suspends until the next mission's log is in, or its budget is spent. */
function AwaitMission({ mission }: { mission: string }): null {
  const wait = chatMissionWait(mission);
  if (wait) throw wait;
  return null;
}
