'use client';

/**
 * What a backend declared it cannot do, as a chip.
 *
 * Read from the catalog's `capabilities`, never from an id. A backend that does
 * not work in Rooks's folder is "Remote": the agent runs elsewhere, so no code
 * task and no files. Any other gap reads "Limited". The hover text lists every
 * gap, so the chip is never a bare label. Nothing is shown for a backend that
 * can do everything.
 */
import React from 'react';
import { Globe, CircleSlash } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { backendLimits, type BackendCatalog, type BackendCapability, type BackendName } from '@/lib/backends';

const LIMIT_KEYS: Record<BackendCapability, string> = {
  worktree: 'llm.limitWorktree',
  rooksMcp: 'llm.limitRooksMcp',
  attachments: 'llm.limitAttachments',
};

export function BackendLimitsBadge({
  catalog,
  backend,
  className,
}: {
  catalog: BackendCatalog;
  backend: BackendName;
  className?: string;
}): React.ReactElement | null {
  const limits = backendLimits(catalog, backend);
  if (limits.length === 0) return null;
  const remote = limits.includes('worktree');
  const hint = [t('llm.limitsHint'), ...limits.map((key) => `• ${t(LIMIT_KEYS[key])}`)].join('\n');
  const Icon = remote ? Globe : CircleSlash;
  return (
    <Badge
      variant="outline"
      title={hint}
      data-backend-limits={limits.join(' ')}
      className={cn(
        'gap-1 border border-sky-500/40 bg-sky-500/10 font-medium text-sky-800 shadow-none dark:text-sky-300',
        className,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      {remote ? t('llm.remote') : t('llm.limited')}
    </Badge>
  );
}
