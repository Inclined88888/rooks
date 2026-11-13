'use client';

/**
 * "This agent manages its own permissions", as a chip.
 *
 * Shown only on the catalog's explicit declaration (`selfManagedPermissions`):
 * an agent that decides alone never raises an Allow/Deny card, and a user who
 * expects one would wait for nothing. The hover text says what to expect
 * instead, so the chip is never a bare label.
 */
import React from 'react';
import { ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

export function SelfPermissionsBadge({
  label,
  hint,
  className,
}: {
  label: string;
  hint: string;
  className?: string;
}): React.ReactElement {
  return (
    <Badge
      variant="outline"
      title={hint}
      data-self-permissions
      className={cn(
        'gap-1 border border-emerald-500/40 bg-emerald-500/10 font-medium text-emerald-800 shadow-none dark:text-emerald-300',
        className,
      )}
    >
      <ShieldCheck className="size-3 shrink-0" aria-hidden />
      {label}
    </Badge>
  );
}

/** The chip as the LLM pickers word it. */
export function SelfPermissionsChip({ className }: { className?: string }): React.ReactElement {
  return <SelfPermissionsBadge label={t('llm.selfPermissions')} hint={t('llm.selfPermissionsHint')} className={className} />;
}
