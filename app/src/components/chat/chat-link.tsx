'use client';

/**
 * A link to a chat (`docs/CHAT-NAVIGATION.md`). Still a real `<a>`: Ctrl/Cmd
 * and middle click open a browser tab, a drag carries the address. A plain
 * click from a chat goes through `switchChat` (no server round trip, the
 * previous conversation stays painted until the next one is ready); from any
 * other page it is a regular `next/link` navigation.
 */
import { forwardRef, useTransition, type ComponentPropsWithoutRef, type MouseEvent } from 'react';
import Link from 'next/link';
import { preloadChatHref, switchChat } from '@/lib/chat-navigation';
import { cn } from '@/lib/utils';

type ChatLinkProps = Omit<ComponentPropsWithoutRef<typeof Link>, 'href'> & { href: string };

function isPlainClick(e: MouseEvent<HTMLAnchorElement>): boolean {
  const target = e.currentTarget.getAttribute('target');
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && (!target || target === '_self');
}

export const ChatLink = forwardRef<HTMLAnchorElement, ChatLinkProps>(function ChatLink(
  { href, onClick, prefetch = false, className, ...rest },
  ref,
) {
  // `pending` while the previous conversation stays on screen, waiting for this one.
  const [pending, startTransition] = useTransition();
  return (
    <Link
      ref={ref}
      href={href}
      prefetch={prefetch}
      aria-busy={pending || undefined}
      className={cn(className, pending && 'cursor-progress')}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || !isPlainClick(e)) return;
        let switched = false;
        startTransition(() => { switched = switchChat(href); });
        if (switched) e.preventDefault();
        // From another page `next/link` navigates as usual; the log is read
        // during its server round trip.
        else preloadChatHref(href);
      }}
      {...rest}
    />
  );
});
