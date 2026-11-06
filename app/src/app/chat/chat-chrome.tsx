'use client';

/**
 * The chat page's chrome: the top bar and the island workspace, mounted by
 * `ChatRoute` OUTSIDE the conversation's key.
 *
 * `ChatRoute` keys the conversation on `agent:mission`, which is what throws
 * away the previous conversation's state. The chrome used to be rendered by
 * the conversation itself, so every switch threw it away too: a new top bar
 * whose Working agents strip first held the open chat's tab alone, a new
 * island workspace, every widget in them mounted again. Measured in the built
 * app on 28/10/2026 (task 3d22e2fb), and read as a page reload when the switch
 * also changed project. Hosted here, they are the same elements before and
 * after a switch; only the conversation is new (`docs/CHAT-NAVIGATION.md`).
 */

import { createContext, useContext, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { TopBar } from '@/components/topbar';
import { ChatIslandHost } from '@/components/chat/chat-island-host';
import { ChatRailProvider, type ChatInfoValue, type ChatRailValue } from '@/components/chat/chat-rails';

export type ChatRailState = { value: ChatRailValue; info: ChatInfoValue };

/** What the conversation hands up to the chrome that outlives it. */
export type ChatChromeApi = {
  /** The thread's scroll folds the top bar (`headerCollapsed` in `ChatClient`). */
  setCollapsed: (collapsed: boolean) => void;
  /** The rail state, for the islands beside the chat (a widget popped out of a column). */
  setRail: (rail: ChatRailState | null) => void;
};

const ChatChromeContext = createContext<ChatChromeApi | null>(null);

/** The chrome hosting this conversation, `null` when it paints its own. */
export const useChatChrome = (): ChatChromeApi | null => useContext(ChatChromeContext);

/**
 * Closes the chrome to what is below: a chat nested in the conversation (an
 * island chat, a card) must never take over the page's top bar or rail.
 */
export function WithoutChatChrome({ children }: { children: ReactNode }): ReactElement {
  return <ChatChromeContext.Provider value={null}>{children}</ChatChromeContext.Provider>;
}

export function ChatChrome({ children }: { children: ReactNode }): ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  const [rail, setRail] = useState<ChatRailState | null>(null);
  const api = useMemo<ChatChromeApi>(() => ({ setCollapsed, setRail }), []);
  // Same element as the conversation used to paint around itself.
  return (
    <ChatChromeContext.Provider value={api}>
      <div className="relative z-[1] flex flex-col h-[100dvh]">
        <TopBar collapsed={collapsed} />
        {/* The islands beside the chat read the rail one commit behind the
            conversation, which provides its own, current one to its body. */}
        <ChatRailProvider value={rail?.value ?? null} info={rail?.info ?? null}>
          <ChatIslandHost embedded={false}>{children}</ChatIslandHost>
        </ChatRailProvider>
      </div>
    </ChatChromeContext.Provider>
  );
}
