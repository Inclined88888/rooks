'use client';

import { cn } from '@/lib/utils';
import type { PublicUser } from '@/lib/auth';
import { initialsOf } from '@/components/user-avatar';
import type { MissionOwner } from './chat-types';

/**
 * The human side of a conversation (TIM-0118). The person typing is the
 * mission's owner, not whoever happens to be reading it: a superadmin opening
 * an employee's mission must see the employee's name and face on the human
 * bubbles, not their own.
 */
export type HumanSpeaker = { name: string; avatar_url: string | null; initials: string };

type Viewer = Pick<PublicUser, 'id' | 'name' | 'email' | 'avatar_url'>;

/** The owner when it is someone else, else the signed-in account. Missions
 *  without owner (before setup, account removed) stay on the viewer. */
export function humanSpeaker(owner: MissionOwner | null | undefined, viewer: Viewer | null | undefined): HumanSpeaker | null {
  if (owner && owner.id !== viewer?.id) {
    return { name: owner.name, avatar_url: owner.avatar_url, initials: initialsOf({ name: owner.name, email: '' }) };
  }
  if (!viewer) return null;
  return { name: viewer.name, avatar_url: viewer.avatar_url, initials: initialsOf(viewer) };
}

/** `owner` as the daemon sends it, or `null` for anything else. */
export function parseMissionOwner(value: unknown): MissionOwner | null {
  if (!value || typeof value !== 'object') return null;
  const { id, name, avatar_url: avatarUrl } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !id || typeof name !== 'string') return null;
  return { id, name, avatar_url: typeof avatarUrl === 'string' && avatarUrl ? avatarUrl : null };
}

/** Picture, else initials. The frame (size, radius, border) is the caller's. */
export function HumanFace({ speaker, className }: { speaker: HumanSpeaker | null; className?: string }) {
  return (
    <span className={cn('grid place-items-center overflow-hidden', className)} title={speaker?.name || undefined}>
      {speaker?.avatar_url ? (
        // Plain <img>: served by our uploads route behind the session cookie.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={speaker.avatar_url} alt="" className="size-full object-cover" />
      ) : speaker ? speaker.initials : null}
    </span>
  );
}
