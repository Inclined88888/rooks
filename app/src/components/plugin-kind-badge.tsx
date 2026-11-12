'use client';

/**
 * One kind of a plugin, as a coloured chip.
 *
 * The stored kind is the contract (`behavior`, `widget`, …). The label is
 * what a human reads: `behavior` becomes "Backend", because "plugs into
 * nothing" was the gallery telling everyone the same non-information.
 */
import { Badge } from '@/components/ui/badge';
import { kindLabel } from '@/lib/plugin-gallery';
import { cn } from '@/lib/utils';

/** Same tones on the card badge and on the type filter chips. */
export const KIND_TONE: Record<string, string> = {
  widget: 'border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-300',
  page: 'border-violet-500/40 bg-violet-500/10 text-violet-800 dark:text-violet-300',
  island: 'border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-300',
  overlay: 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300',
  theme: 'border-pink-500/40 bg-pink-500/10 text-pink-800 dark:text-pink-300',
  composer: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
  layout: 'border-slate-500/40 bg-slate-500/10 text-slate-800 dark:text-slate-300',
  behavior: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
  provider: 'border-teal-500/40 bg-teal-500/10 text-teal-800 dark:text-teal-300',
  dictation: 'border-rose-500/40 bg-rose-500/10 text-rose-800 dark:text-rose-300',
  bundle: 'border-orange-500/40 bg-orange-500/10 text-orange-800 dark:text-orange-300',
};

export function PluginKindBadge({ kind }: { kind: string }): React.ReactElement {
  return (
    <Badge
      variant="outline"
      className={cn('border font-medium shadow-none', KIND_TONE[kind] ?? 'text-muted-foreground')}
    >
      {kindLabel(kind)}
    </Badge>
  );
}
