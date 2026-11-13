'use client';

/**
 * An agent's reasoning inside its bubble, folded away by default.
 *
 * The text is plain: it is the model's own scratch space, not markdown we
 * vouched for, so it is never injected as HTML. The disclosure reuses the tool
 * block's frame — a bubble that both reasons and calls tools reads as one
 * family of collapsible steps.
 */
import React from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { t } from '@/lib/i18n';

export function ThinkingBlock({ text }: { text: string }): React.ReactElement | null {
  if (!text) return null;
  return (
    <details className="tool-block" data-thinking>
      <summary className="tool-summary">
        <ChevronRight className="tool-summary-chevron size-3 shrink-0" aria-hidden />
        <Brain className="size-3.5 shrink-0" aria-hidden />
        <span className="tool-summary-name">{t('chatPage.thinkingLabel')}</span>
      </summary>
      <div className="tool-block-body whitespace-pre-wrap break-words text-[12.5px] text-muted-foreground">
        {text}
      </div>
    </details>
  );
}
