'use client';

/**
 * The account, at the foot of Settings: who is signed in, then Profile,
 * Licence and Sign out. It used to be an avatar menu in the nav; the nav keeps
 * navigation, and everything about "me" lives with the other preferences.
 *
 * Profile and Licence open in the dialog's own pane, like a category.
 */
import { useState, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, LogOut, UserRound } from 'lucide-react';
import { UserAvatar } from '@/components/user-avatar';
import { useMe } from '@/hooks/use-me';
import { actingUser } from '@/lib/auth';
import { isPageSurfaceAllowed, useCapabilities } from '@/lib/capabilities';
import { forgetAllChatMissions } from '@/lib/chat-mission-cache';
import type { SettingsAccountView } from '@/lib/settings-layout';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const ACTIVE = 'bg-foreground/[0.08] font-medium text-foreground';
const ROW = 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] leading-snug text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.05] hover:text-foreground motion-reduce:transition-none';

export function SettingsAccount({
  className,
  view,
  onSelect,
}: {
  className?: string;
  /** The account view on screen, if any. */
  view: SettingsAccountView | null;
  onSelect: (view: SettingsAccountView) => void;
}): ReactElement | null {
  const me = useMe();
  const caps = useCapabilities();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const user = me?.user;
  if (!user) return null;

  async function logout(): Promise<void> {
    setBusy(true);
    try {
      await fetch('/api/ui/auth/logout', { method: 'POST' });
      // A soft navigation keeps this module alive for whoever signs in next.
      forgetAllChatMissions();
      router.replace('/login');
    } finally {
      setBusy(false);
    }
  }

  const label = user.name.trim() || user.email;

  return (
    <div role="group" aria-label={t('session.account')} className={cn('space-y-0.5 pt-3', className)}>
      <div className="flex items-center gap-2.5 px-2.5 pb-2">
        <UserAvatar user={user} />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[13px] text-foreground">{label}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{user.email}</span>
        </span>
      </div>
      <button type="button" aria-current={view === 'profile' ? 'page' : undefined} onClick={() => onSelect('profile')} className={cn(ROW, view === 'profile' && ACTIVE)}>
        <UserRound className="size-4 shrink-0" aria-hidden />
        {t('session.profile')}
      </button>
      {/* The licence page is the active machine's: its admin decides. */}
      {actingUser(me)?.is_superadmin && isPageSurfaceAllowed(caps, '/license') && (
        <button type="button" aria-current={view === 'license' ? 'page' : undefined} onClick={() => onSelect('license')} className={cn(ROW, view === 'license' && ACTIVE)}>
          <KeyRound className="size-4 shrink-0" aria-hidden />
          {t('session.license')}
        </button>
      )}
      <button type="button" disabled={busy} onClick={() => { void logout(); }} className={cn(ROW, 'disabled:opacity-50')}>
        <LogOut className="size-4 shrink-0" aria-hidden />
        {t('session.logout')}
      </button>
    </div>
  );
}
