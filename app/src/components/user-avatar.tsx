'use client';

import { cn } from '@/lib/utils';
import type { PublicUser } from '@/lib/auth';

/**
 * The face of the signed-in account: their picture, or their initials until
 * they upload one.
 *
 * Initials rather than a generic silhouette: on an instance with several
 * accounts the avatar is the only thing telling you *who* you are signed in
 * as, and a silhouette says nothing.
 */

/** First letter of the first two words of the name, else the email's. */
export function initialsOf(user: Pick<PublicUser, 'name' | 'email'>): string {
  const words = user.name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0] ?? '').join('');
  return (letters || user.email[0] || '?').toUpperCase();
}

/** `name` split for a two-field form. The last name is everything after the
 *  first space, so a compound first name survives a round-trip better than a
 *  split on the last space would. */
export function splitName(name: string): { first: string; last: string } {
  const trimmed = name.trim();
  const space = trimmed.indexOf(' ');
  if (space < 0) return { first: trimmed, last: '' };
  return { first: trimmed.slice(0, space), last: trimmed.slice(space + 1).trim() };
}

/** The inverse of `splitName`. `users.name` stays the single source of truth
 *  for a display name — there is no first/last column to drift from it. */
export function joinName(first: string, last: string): string {
  return `${first.trim()} ${last.trim()}`.trim();
}

export function UserAvatar({
  user,
  className,
}: {
  user: Pick<PublicUser, 'name' | 'email' | 'avatar_url'>;
  className?: string;
}): React.ReactElement {
  const shared = cn(
    'flex shrink-0 items-center justify-center overflow-hidden rounded-full',
    className ?? 'size-8',
  );
  if (user.avatar_url) {
    return (
      // Plain <img>: the URL is served by our own uploads route behind the
      // session cookie, which `next/image`'s optimiser would fetch without.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={user.avatar_url} alt="" className={cn(shared, 'object-cover')} />
    );
  }
  return (
    <span aria-hidden className={cn(shared, 'bg-primary/15 text-[11px] font-semibold text-primary')}>
      {initialsOf(user)}
    </span>
  );
}
