'use client';

/**
 * What a notification looks like before it is read: a picto for its source,
 * in a small tinted badge that carries the colour of its kind. The card around
 * it stays neutral — the badge alone says "alert" or "needs you".
 */
import type { LucideIcon } from 'lucide-react';
import {
  BarChart3, Ban, Brain, FileText, GitMerge, Mail, Moon, Rocket, Search, Siren, SquarePlus, TriangleAlert, Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type NotificationKindInput = {
  anchor: string | null;
  title: string;
  type: 'action_required' | 'alert' | 'report';
};

/** Where a notification comes from, read from its anchor, else its title, else its type. */
export type NotificationSource =
  | 'dream' | 'memory' | 'deploy' | 'merge' | 'blocked' | 'crash' | 'audit' | 'inbox' | 'report' | 'kanban'
  | 'action' | 'alert' | 'info';

/**
 * Most notifications carry no anchor, so the title decides: the daemon's
 * sources are a fixed set. Titles are English since #628; French ones stay in
 * the history, and an agent's own reports come in either language.
 */
// french-ok-file: notification titles are matched in French too: older notifications and agents' reports are written in it.
export function notificationSource(n: NotificationKindInput): NotificationSource {
  const a = n.anchor ?? '';
  if (a.startsWith('/dreams')) return 'dream';
  if (a.startsWith('/memory')) return 'memory';
  const t = n.title.toLowerCase();
  if (t.startsWith('dreaming') || t.includes('dream') || t.includes('rêve')) return 'dream';
  // "Memory pressure" and "Memory ceiling" are about RAM, not agent memory.
  if ((t.startsWith('memory') && !/pressure|ceiling/.test(t))
    || t.startsWith('mémoire') || t.startsWith('memoire')) return 'memory';
  if (t.includes('deploy') || t.includes('déploie') || t.includes('déploy')) return 'deploy';
  if (t.includes('merge') || t.includes('mergé') || t.includes('unblocked') || t.includes('débloqué')) return 'merge';
  if (t.includes('blocked') || t.includes('bloquée') || t.includes('bloqué')) return 'blocked';
  if (t.includes('ci broken') || t.includes('ci cassé') || t.includes('cassée') || t.includes('crash')) return 'crash';
  if (t.includes('audit')) return 'audit';
  if (t.includes('inbox')) return 'inbox';
  if (t.includes('report') || t.includes('rapport') || t.includes('reusab') || t.includes('réutilisab')) return 'report';
  if (t.includes('kanban')) return 'kanban';
  return n.type === 'action_required' ? 'action' : n.type === 'alert' ? 'alert' : 'info';
}

const ICONS: Record<NotificationSource, LucideIcon> = {
  dream: Moon,
  memory: Brain,
  deploy: Rocket,
  merge: GitMerge,
  blocked: Ban,
  crash: Siren,
  audit: Search,
  inbox: Mail,
  report: BarChart3,
  kanban: SquarePlus,
  action: Zap,
  alert: TriangleAlert,
  info: FileText,
};

export function notificationIcon(n: NotificationKindInput): LucideIcon {
  return ICONS[notificationSource(n)];
}

/** The colour of a kind: on the badge only, readable in both themes. */
export function notificationTone(type: NotificationKindInput['type'], urgent: boolean): string {
  if (type === 'action_required') return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
  if (type === 'alert') return urgent ? 'bg-red-500/15 text-red-600 dark:text-red-400' : 'bg-orange-500/15 text-orange-600 dark:text-orange-400';
  return 'bg-sky-500/15 text-sky-600 dark:text-sky-400';
}

const SIZES = {
  xs: { box: 'size-4 rounded-[5px]', icon: 'size-2.5' },
  sm: { box: 'size-7 rounded-lg', icon: 'size-3.5' },
  md: { box: 'size-8 rounded-lg', icon: 'size-4' },
} as const;

/** The badge: the source's picto in the kind's colour. */
export function NotificationIconBadge({ n, urgent, size = 'sm', className }: {
  n: NotificationKindInput;
  urgent: boolean;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const Icon = notificationIcon(n);
  const s = SIZES[size];
  return (
    <span
      aria-hidden="true"
      data-notification-source={notificationSource(n)}
      className={cn('grid shrink-0 place-items-center', s.box, notificationTone(n.type, urgent), className)}
    >
      <Icon className={s.icon} strokeWidth={2.2} />
    </span>
  );
}

/** "Urgent", in the kind's colour, beside the title. */
export function UrgentPill({ type, label }: { type: NotificationKindInput['type']; label: string }) {
  return (
    <span className={cn('shrink-0 rounded-full px-1.5 py-px text-[9.5px] font-semibold', notificationTone(type, true))}>
      {label}
    </span>
  );
}

/**
 * The kind as one badge: the source's picto and a word ("Urgent" when it is,
 * else the kind), in the kind's colour. Opens a notification card.
 */
export function NotificationKindBadge({ n, urgent, label }: {
  n: NotificationKindInput;
  urgent: boolean;
  label: string;
}) {
  const Icon = notificationIcon(n);
  return (
    <span
      data-notification-source={notificationSource(n)}
      className={cn('inline-flex shrink-0 items-center gap-1 rounded-full py-0.5 pl-1.5 pr-2 text-[10px] font-semibold leading-none', notificationTone(n.type, urgent))}
    >
      <Icon className="size-3" strokeWidth={2.2} aria-hidden="true" />
      {label}
    </span>
  );
}
