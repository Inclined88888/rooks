'use client';

/**
 * The line a series of provider retries leaves in the thread (TODO #459): a
 * loader while the provider or Timon tries again, then a discreet "reconnected",
 * or the exhaustion with a Retry button. One line, rewritten at every attempt.
 */
import { Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { t as i18n } from '@/lib/i18n';
import { retryLineOpen, retryLineText, type RetryLine } from '@/lib/provider-retry-line';

export function ProviderRetryNotice({ line, onRetry }: {
  line: RetryLine;
  /** Re-sends the last message in the same session; absent = no button. */
  onRetry?: () => void;
}) {
  const { title, detail } = retryLineText(line);
  const open = retryLineOpen(line);
  const exhausted = line.state === 'exhausted';
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'mx-auto flex max-w-full flex-col items-center gap-1 rounded-xl px-3 py-1.5 text-center',
        exhausted ? 'bg-destructive/10 text-destructive' : 'text-muted-foreground',
      )}
    >
      <span className={cn('flex items-center gap-2 text-[12px] tabular-nums', line.state === 'recovered' && 'text-[11px] opacity-70')}>
        {open && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />}
        {title}
      </span>
      {detail && (
        <span className="max-w-full text-[11px] opacity-75 [overflow-wrap:anywhere]">{detail}</span>
      )}
      {exhausted && onRetry && (
        <Button type="button" size="sm" variant="outline" className="mt-1 h-7 gap-1.5 px-2.5 text-[12px]" onClick={onRetry}>
          <RotateCcw className="size-3.5" aria-hidden />
          {i18n('chatPage.retryTurn')}
        </Button>
      )}
    </div>
  );
}
