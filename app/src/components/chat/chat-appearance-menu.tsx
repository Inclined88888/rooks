'use client';

/**
 * The chat's skin: shared state, and the button that changes it.
 *
 * The state is a context rather than a hook per consumer: the button that sets
 * a value and the surfaces that read it (bubbles, tool calls, composer) live in
 * three different subtrees, and a `useStoredLayout` per consumer would give
 * each of them its own copy — a checkbox ticked in the menu would leave the
 * thread untouched until the next reload.
 *
 * Same two guards as `useChatColumns`, for the same reasons: no write before
 * the read has landed (saving the defaults over an appearance we failed to
 * read would erase it on the first click), and a first paint on the defaults
 * (waiting on the network would leave the thread unpainted).
 *
 * The same switches are reached two ways: the Customize interface menu of the
 * top bar (a submenu, on a chat page), and a button at the end of the
 * composer's bar that only shows under the pointer — a settings gear painted
 * permanently would sit in the one place meant to be a conversation.
 */

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { Palette } from 'lucide-react';

import { cn } from '@/lib/utils';
import { t as i18n } from '@/lib/i18n';
import { useStoredLayout } from '@/hooks/use-stored-layout';
import { workspaceRowHandover } from '@/lib/workspace-route';
import { useWorkspaceLayout } from '@/components/workspace-layout-provider';
import { useWidgetHost } from '@/components/widget-host/widget-host';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  CHAT_APPEARANCE_DEFAULTS,
  CHAT_APPEARANCE_SCOPE,
  COMPOSER_TOGGLES,
  TOOL_CALLS_MODES,
  WORKING_ENTER_MODES,
  readAppearance,
  setToolCallsMode,
  setWorkingEnterMode,
  type ChatAppearance,
  type ComposerToggle,
  type ToolCallsMode,
  type WorkingEnterMode,
} from './chat-appearance';

type ChatAppearanceValue = {
  appearance: ChatAppearance;
  toggle: (key: ComposerToggle | 'flatBubbles' | 'showInputBorder' | 'focusMode') => void;
  setMode: (mode: ToolCallsMode) => void;
  setEnterMode: (mode: WorkingEnterMode) => void;
};

const ChatAppearanceContext = createContext<ChatAppearanceValue | null>(null);

/**
 * Mounted at the root layout, above the chat rather than inside it.
 *
 * Multichat mounts several `ChatClient` side by side: a provider per chat would
 * give each cell its own copy of a preference that describes the product, not
 * the conversation — ticking "flat bubbles" in one cell would leave the one
 * next to it bordered.
 */
export function ChatAppearanceProvider({ children }: { children: ReactNode }) {
  const { key, previousKey } = useWorkspaceLayout();
  const { raw, update } = useStoredLayout(
    key ? `${key}.appearance` : null,
    workspaceRowHandover(previousKey, 'appearance', CHAT_APPEARANCE_SCOPE),
  );
  const appearance = useMemo(() => readAppearance(raw), [raw]);

  const mutate = useCallback((op: (a: ChatAppearance) => ChatAppearance) => {
    update((stored) => op(readAppearance(stored)));
  }, [update]);

  const value = useMemo<ChatAppearanceValue>(() => ({
    appearance,
    // Decided against the skin on screen: replayed over another window's
    // write (TODO #647), a toggle would undo the very click it stands for.
    toggle: (k) => { const on = !appearance[k]; mutate((a) => ({ ...a, [k]: on })); },
    setMode: (mode) => mutate((a) => setToolCallsMode(a, mode)),
    setEnterMode: (mode) => mutate((a) => setWorkingEnterMode(a, mode)),
  }), [appearance, mutate]);

  return (
    <ChatAppearanceContext.Provider value={value}>{children}</ChatAppearanceContext.Provider>
  );
}

/**
 * The skin, wherever it is read.
 *
 * Outside the provider — a plugin rendering a bubble in its own tree, a test
 * mounting a single component — it returns the defaults rather than throwing:
 * an appearance is decoration, and no decoration must ever be the reason a
 * conversation fails to paint.
 */
export function useChatAppearance(): ChatAppearance {
  return useContext(ChatAppearanceContext)?.appearance ?? CHAT_APPEARANCE_DEFAULTS;
}

/**
 * The switches, for a menu that lives outside the chat.
 *
 * Focus mode is reached from the topbar's palette: it is a gesture of every
 * session, not a setting.
 * Outside the provider, the setters are no-ops rather than a crash.
 */
export function useChatAppearanceControls(): Omit<ChatAppearanceValue, 'appearance'> & { appearance: ChatAppearance } {
  const ctx = useContext(ChatAppearanceContext);
  return ctx ?? {
    appearance: CHAT_APPEARANCE_DEFAULTS,
    toggle: () => {},
    setMode: () => {},
    setEnterMode: () => {},
  };
}

const TOGGLE_LABEL: Record<ComposerToggle, string> = {
  showModel: 'chatPage.appearance.model',
  showEffort: 'chatPage.appearance.effort',
  showPermission: 'chatPage.appearance.permission',
  showBranch: 'chatPage.appearance.branch',
  showContext: 'chatPage.appearance.context',
  showUsage: 'chatPage.appearance.usage',
};

/**
 * The customisation button, at the end of the composer's bar. It shows under
 * the pointer (`group/composer-bar`), on keyboard focus, and while a layout
 * gesture is under way.
 *
 * It sits in the composer's top bar and not only in the topbar's palette menu:
 * what it changes belongs to the thread.
 */
export function ChatAppearanceButton({ compact = false }: { compact?: boolean }) {
  const ctx = useContext(ChatAppearanceContext);
  const { editing } = useWidgetHost();
  if (!ctx) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={i18n('chatPage.appearance.title')}
          aria-label={i18n('chatPage.appearance.title')}
          className={cn(
            'shrink-0 rounded px-1 py-0.5 text-primary transition-[opacity,background-color] hover:bg-muted/60 focus-visible:opacity-100 data-[state=open]:opacity-100',
            !editing && 'opacity-0 group-hover/composer-bar:opacity-100',
          )}
        >
          <Palette className={compact ? 'size-3' : 'size-3.5'} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="min-w-[15rem]">
        <ChatAppearanceItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The switches themselves, for any dropdown (the composer's button, the
 *  top bar's Customize interface submenu). */
export function ChatAppearanceItems() {
  const ctx = useContext(ChatAppearanceContext);
  if (!ctx) return null;
  const { appearance, toggle, setMode, setEnterMode } = ctx;
  return (
      <>
        <DropdownMenuLabel className="text-[11px]">
          {i18n('chatPage.appearance.title')}
        </DropdownMenuLabel>

        <DropdownMenuCheckboxItem
          checked={appearance.flatBubbles}
          onCheckedChange={() => toggle('flatBubbles')}
          onSelect={(e) => e.preventDefault()}
          className="text-xs"
        >
          {i18n('chatPage.appearance.flatBubbles')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={!appearance.showInputBorder}
          onCheckedChange={() => toggle('showInputBorder')}
          onSelect={(e) => e.preventDefault()}
          className="text-xs"
        >
          {i18n('chatPage.appearance.flatInput')}
        </DropdownMenuCheckboxItem>

        <DropdownMenuLabel className="mt-2 text-[11px] font-normal text-muted-foreground">
          {i18n('chatPage.appearance.toolCalls')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={appearance.toolCalls}
          onValueChange={(v) => setMode(v as ToolCallsMode)}
        >
          {TOOL_CALLS_MODES.map((mode) => (
            <DropdownMenuRadioItem
              key={mode}
              value={mode}
              onSelect={(e) => e.preventDefault()}
              className={cn('text-xs', appearance.toolCalls === mode && 'text-primary')}
            >
              {i18n(`chatPage.appearance.toolCallsMode.${mode}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuLabel className="mt-2 text-[11px] font-normal text-muted-foreground">
          {i18n('chatPage.appearance.controls')}
        </DropdownMenuLabel>
        {COMPOSER_TOGGLES.map((key) => (
          <DropdownMenuCheckboxItem
            key={key}
            checked={appearance[key]}
            onCheckedChange={() => toggle(key)}
            onSelect={(e) => e.preventDefault()}
            className="text-xs"
          >
            {i18n(TOGGLE_LABEL[key])}
          </DropdownMenuCheckboxItem>
        ))}

        <DropdownMenuLabel className="pt-3 text-[11px] font-normal text-muted-foreground">
          {i18n('chatPage.appearance.enterWhileWorking')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={appearance.enterWhileWorking}
          onValueChange={(v) => setEnterMode(v as WorkingEnterMode)}
        >
          {WORKING_ENTER_MODES.map((mode) => (
            <DropdownMenuRadioItem
              key={mode}
              value={mode}
              onSelect={(e) => e.preventDefault()}
              className={cn('text-xs', appearance.enterWhileWorking === mode && 'text-primary')}
            >
              {i18n(`chatPage.appearance.enterWhileWorkingMode.${mode}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </>
  );
}
