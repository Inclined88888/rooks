'use client';

/**
 * The one place that turns a navigation request into a navigation: a card
 * in a conversation (`ui_navigate`) cannot reach the router itself, and the
 * chat that raised it may be unmounted by the very navigation it asked for.
 * Only a same-origin relative address is followed.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { navigateHref, NAVIGATE_EVENT, NAVIGATE_SSE_EVENT, parseNavigateProposal } from '@/lib/navigate-proposals';
import { sseOn } from '@/lib/sse-stream';
import { openChat } from '@/lib/chat-navigation';

export function NavigateListener(): null {
  const router = useRouter();
  useEffect(() => {
    const onNavigate = (e: Event) => {
      const href = (e as CustomEvent<unknown>).detail;
      if (typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//')) return;
      openChat(href, router);
    };
    window.addEventListener(NAVIGATE_EVENT, onNavigate);
    // A direct navigation under a guided tour: the daemon sends it on the global stream,
    // which outlives the chat. The address is rebuilt here like a card's.
    const offSse = sseOn(NAVIGATE_SSE_EVENT, (e) => {
      let raw: unknown = null;
      try { raw = JSON.parse(e.data as string); } catch { return; }
      const proposal = parseNavigateProposal(raw);
      if (proposal) openChat(navigateHref(proposal, window.location.href), router);
    });
    return () => {
      window.removeEventListener(NAVIGATE_EVENT, onNavigate);
      offSse();
    };
  }, [router]);
  return null;
}
