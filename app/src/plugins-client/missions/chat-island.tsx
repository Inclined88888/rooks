'use client';

/**
 * The chat of an agent as a content of the island workspace
 * (`@timon/missions:chat`, `docs/ISLAND-WORKSPACE.md` §7).
 *
 * `ChatClient` in its `inIsland` mode: columns kept, folded into panels by the
 * island's width. Only the primary chat of the view holds the widget zones
 * (Q10): this one is told by its island. An inactive tab is unmounted (Q12),
 * so a chat in the background holds no stream.
 *
 * Without a mission, the multichat's picker asks which one. Once the chat is
 * started its mission is the chat's own state: a new conversation, or another
 * one picked from its rail, updates the tab's params (a reload reopens it)
 * without remounting the thread. A mission picked there may belong to another
 * agent of the project: the params then take that agent, so the tab's title
 * names the chat it shows and a return to the view reopens it, and the thread
 * starts over on it (from the cache of recent conversations) so that its New
 * conversation and its composer are that agent's too (TIM-0140).
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import dynamic from 'next/dynamic';
import { MissionPicker } from '@/app/multichat/mission-picker';
import { useIslandContent } from '@/components/islands/island-content';
import { t } from '@/lib/i18n';
import { chatIslandShown } from '@/lib/chat-island-params';

// Loaded on demand: statically imported, it weighed on every page of the app.
const ChatClient = dynamic(() => import('@/app/chat/chat-client').then((m) => m.ChatClient), { ssr: false });

/** `agent` is the host of the thread: the agent of the conversation it shows. */
type Start = { agent: string; missionId: string | null; fresh: boolean; nonce: number };

export function ChatIsland(): ReactElement {
  const { params, primary, focused, setParams, setTitle } = useIslandContent();
  const agent = typeof params.agent === 'string' ? params.agent : '';
  const missionId = typeof params.missionId === 'string' ? params.missionId : null;
  const fresh = params.fresh === true;
  // What the thread was started with. Later changes of the tab's params come
  // from the chat itself and must not remount it.
  const [start, setStart] = useState<Start | null>(() => (missionId || fresh ? { agent, missionId, fresh, nonce: 0 } : null));
  const nonce = useRef(0);

  useEffect(() => { setTitle(agent ? t('islands.chat.titleOf', { agent }) : null); }, [agent, setTitle]);

  // The params said "no mission" again (the tab was reset elsewhere): back to the picker.
  useEffect(() => {
    if (!missionId && !fresh) setStart(null);
  }, [missionId, fresh]);

  // The params named another agent from elsewhere: the tab was given to that
  // agent, its thread starts over.
  useEffect(() => {
    if (!start || agent === start.agent) return;
    nonce.current += 1;
    setStart(missionId || fresh ? { agent, missionId, fresh, nonce: nonce.current } : null);
    // Only an agent change restarts the thread; the other params follow it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  if (!start) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <MissionPicker
          agentName={agent}
          onPick={(id) => {
            nonce.current += 1;
            setStart({ agent, missionId: id, fresh: false, nonce: nonce.current });
            setParams({ agent, missionId: id, fresh: false });
          }}
          onNewConversation={() => {
            nonce.current += 1;
            setStart({ agent, missionId: null, fresh: true, nonce: nonce.current });
            setParams({ agent, missionId: null, fresh: true });
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatClient
        key={`${start.agent}:${start.nonce}`}
        forcedAgent={start.agent}
        forcedMission={start.missionId ?? undefined}
        initialFresh={start.fresh}
        inIsland
        primary={primary}
        focused={focused}
        onConversationShown={(id, owner) => {
          const next = chatIslandShown({ agent, missionId }, id, owner);
          if (!next) return;
          setParams(next);
          if (next.agent !== start.agent) {
            nonce.current += 1;
            setStart({ agent: next.agent, missionId: next.missionId, fresh: false, nonce: nonce.current });
          }
        }}
      />
    </div>
  );
}
