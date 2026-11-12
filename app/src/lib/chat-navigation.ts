'use client';

/**
 * The one way to open a chat (`docs/CHAT-NAVIGATION.md`).
 *
 * `/chat` is a `force-dynamic` page whose content is a client component that
 * reads its conversation from the URL. Reaching it from another page goes
 * through the router (one RSC request, no reload). Moving from one chat to
 * another goes through `history.pushState`: Next (≥ 14.1) keeps
 * `useSearchParams` in step with it, `ChatRoute` re-keys on the new
 * agent/mission, and the server is never asked for a page it would render
 * the same. A full page load (`location.href`, a bare `<a>`) is never used:
 * it re-renders the root layout on the server and re-parses the app's JS.
 */
import { preloadChatMission } from './chat-mission-preload';
import { preloadWorkspace } from '@/components/workspace-layout-provider';

const CHAT_PATH = '/chat';

export type ChatNavigationMode = 'none' | 'history' | 'router';

interface Pusher { push(href: string): void }

function relative(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * How `href` is reached from the page at `current`: `none` when it is already
 * on screen, `history` from a chat to another chat, `router` otherwise.
 */
export function chatNavigationMode(href: string, current: string): ChatNavigationMode {
  let from: URL;
  let to: URL;
  try {
    from = new URL(current);
    to = new URL(href, from);
  } catch {
    return 'router';
  }
  if (to.origin !== from.origin || to.pathname !== CHAT_PATH || from.pathname !== CHAT_PATH) return 'router';
  return relative(to) === relative(from) ? 'none' : 'history';
}

/** Starts reading the mission `href` opens, if it names one. */
export function preloadChatHref(href: string): void {
  preloadTarget(new URL(href, window.location.href));
}

function preloadTarget(to: URL): void {
  if (to.pathname !== CHAT_PATH) return;
  const mission = to.searchParams.get('mission');
  // Ahead of the render the URL change triggers: the log is on its way while
  // React works out the new tree.
  if (mission) preloadChatMission(mission);
  // The agent's project, and the layout the screen takes there. Without an
  // agent the route resolves its owner first, then names it.
  if (to.searchParams.get('agent')) preloadWorkspace(CHAT_PATH, to.searchParams);
}

/**
 * Moves from the chat on screen to the chat at `href`, in place. `false` when
 * `href` is not a chat-to-chat move: the router has to take it.
 */
export function switchChat(href: string): boolean {
  const mode = chatNavigationMode(href, window.location.href);
  if (mode === 'router') return false;
  if (mode === 'history') {
    const to = new URL(href, window.location.href);
    preloadTarget(to);
    window.history.pushState(null, '', relative(to));
  }
  return true;
}

/** Opens `href` (a `/chat` address, or any in-app one) without reloading the page. */
export function openChat(href: string, router: Pusher): void {
  if (switchChat(href)) return;
  const to = new URL(href, window.location.href);
  preloadTarget(to);
  router.push(relative(to));
}
